// The engine in use: the platform's own (the phone's plugin, aria2c beside the desktop app), or a remote aria2 when
// the settings say so, or the browser's downloader on the web. One place the views ask.
import type { Engine, Task, TaskSource } from './types';
import { NativeEngine } from './native';
import { DesktopEngine } from './desktop';
import { Aria2Engine, Aria2Rpc } from './aria2';
import { BrowserEngine } from './browser';
import { getSettings, onSettingsChange } from '../settings';
import { expandPattern } from '../downloads/categories';

let engine: Engine | null = null; let key = '';
const listeners = new Set<(e: Engine) => void>();

function pick(): Engine {
  const s = getSettings();
  const k = s.aria2.use ? `aria2|${s.aria2.url}|${s.aria2.secret}` : 'platform';
  if (engine && k === key) return engine;
  key = k;
  if (s.aria2.use) engine = new Aria2Engine(new Aria2Rpc(s.aria2.url, s.aria2.secret));
  // (On the computer always its own engine — never the browser's, which only hands a link over and calls it done —:
  // were aria2c down, adding starts it again, and videos go through yt-dlp without it.)
  else if (window.kurokawaTools?.platform === 'desktop') engine = new DesktopEngine(window.kurokawaTools);
  else engine = NativeEngine.here() ?? new BrowserEngine();
  for (const fn of listeners) fn(engine);
  return engine;
}
export const getEngine = (): Engine => pick();
/** Why the platform has no engine of its own (the desktop app without aria2c), if so. */
export const platformEngineProblem = (): string | undefined => (window.kurokawaTools && !window.kurokawaTools.available ? window.kurokawaTools.reason ?? 'aria2c missing' : undefined);
export function onEngineChange(fn: (e: Engine) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
onSettingsChange(() => pick());
// (The desktop's aria2c came up late or stopped: the platform's engine picked again.)
window.addEventListener('kt:engine-state', () => { if (key === 'platform') { key = ''; pick(); } });
/** Starts the desktop's aria2c again (if it is not running); whether there is an engine of the platform's own now. */
export async function retryPlatformEngine(): Promise<boolean> { await window.kurokawaTools?.retryEngine?.(); if (key === 'platform') { key = ''; pick(); } return !platformEngineProblem(); }

/* ---------- what the user typed ---------- */
/** Links, magnets and torrents out of free text (several, one per line or space-separated). */
/** Whether bytes are a .torrent: a bencoded dictionary with an «info» in it (not just any file called one). */
export function isTorrentBytes(b: Uint8Array): boolean {
  if (b.length < 20 || b[0] !== 0x64 /* d */) return false;
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 1 << 20)));
  return /\d+:info/.test(head) && /^d\d+:/.test(head);
}
export const torrentB64Ok = (b64: string): boolean => { try { const bin = atob(b64); const u = new Uint8Array(Math.min(bin.length, 1 << 20)); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return isTorrentBytes(u); } catch { return false; } };
export function parseSources(text: string): TaskSource[] {
  const out: TaskSource[] = [];
  for (const raw0 of text.split(/[\s\n]+/)) for (const raw of (/\[[\da-zA-Z]+-[\da-zA-Z]+(?::\d+)?\]/.test(raw0) ? expandPattern(raw0) : [raw0])) {
    const s = raw.trim(); if (!s) continue;
    if (/^magnet:\?/i.test(s)) out.push({ magnet: s });
    else if (/^data:application\/x-bittorrent;base64,/i.test(s)) { if (torrentB64Ok(s.split(',')[1] ?? '')) out.push({ torrent: s.split(',')[1] }); }
    else if (/^(https?|ftp|sftp):\/\/\S+/i.test(s)) out.push({ url: s });
    else if (/^[a-f0-9]{40}$/i.test(s) || /^[a-z2-7]{32}$/i.test(s)) out.push({ magnet: `magnet:?xt=urn:btih:${s}` });
    else if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) out.push({ url: `https://${s}` });
  }
  return out;
}
export const isVideo = (name: string): boolean => /\.(mkv|mp4|m4v|webm|avi|mov|ts|m2ts|wmv|flv|ogv|3gp)$/i.test(name);
export const isArchive = (name: string): boolean => /\.(zip|7z|rar|r\d\d|tar|gz|tgz|bz2|xz|zst|001)$/i.test(name);
/** A finished task's main file on the disk — a torrent of several files: its first chosen one —; '' when it is
 *  not a path the app can hand over (a content:// folder). */
export function mainFilePath(x: Task): string {
  if (!x.dir || x.dir.startsWith('content:')) return '';
  const rel = x.kind === 'torrent' && x.files.length > 1 ? `${x.name}/${(x.files.find((f) => f.priority > 0) ?? x.files[0]).path}` : (x.files[0]?.path ?? displayName(x));
  return `${x.dir.replace(/[\\/]$/, '')}/${rel}`.replace(/\/+/g, '/');
}
export const displayName = (t: Task): string => t.name || (t.source.url ?? t.source.magnet ?? '').split('/').pop() || t.id;
/** The display name of a magnet before its metadata comes (its dn= part). */
export function magnetName(m: string): string | undefined { try { const dn = new URL(m).searchParams.get('dn'); return dn ? decodeURIComponent(dn.replace(/\+/g, ' ')) : undefined; } catch { return undefined; } }
