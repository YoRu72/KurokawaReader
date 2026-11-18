// Playing a video: in another app (VLC, MX Player, mpv… on a phone; the system's player on a computer) or in the
// app's own player — the Player add-on, installed on the spot the first time it is chosen. Which one is asked each
// time until a choice is remembered (Settings → Player). The web has only the in-app way.
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { pushLayer } from '../ui/backstack';
import { openExternal, ktPlugin, nativePlatform, openFolder } from '../native';
import { getSettings, updateSettings } from '../settings';
import { getEngine, isVideo } from '../engine';
import type { Task } from '../engine/types';

type PlayOpts = { task?: Task; fileIndex?: number; localPath?: string; playlist?: { url: string; name: string; localPath?: string; task?: Task; fileIndex?: number }[]; meta?: Task['meta']; subtitles?: { url: string; name: string; lang?: string; isDefault?: boolean }[]; headers?: Record<string, string>; startAt?: number; forCaller?: boolean;
  /** An online source as the site gives it (its headers, HLS or not): another app gets it through the relay; the app's own player gets `inAppUrl()` (the proxy the web view needs). */ origin?: { url: string; headers: Record<string, string>; hls?: boolean }; inAppUrl?: () => Promise<string> };
export type PlayWith = 'ask' | 'app' | 'external';
export const canPlayExternally = (): boolean => { const p = nativePlatform(); return p === 'android' || p === 'desktop'; };

export async function openPlayer(url: string, name: string, opts: PlayOpts = {}): Promise<void> {
  // (One question at most: the hand-over's own chooser — the app's own player or the outside way — asks it, with the
  // default for this kind of video; «Watch videos with» in Settings feeds that default. No second sheet before it.)
  const how: 'app' | 'external' = canPlayExternally() && getSettings().playerWith !== 'app' ? 'external' : 'app';
  // (A video opened from a folder: its folder's other videos become the queue, in name order, when the player's setting says.)
  if (!opts.playlist && opts.localPath && !opts.task) { try { const { getPrefs } = await import('../player/prefs'); if (getPrefs().autoQueueFolder !== false) { const { siblingFiles, localFileUrl } = await import('../player/files'); const sibs = (await siblingFiles(opts.localPath)).filter((p) => /\.(mkv|mp4|m4v|webm|avi|mov|wmv|flv|ts|m2ts|mts|mpg|mpeg|ogv|3gp)$/i.test(p)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); if (sibs.length > 1 && sibs.includes(opts.localPath)) { const pl = []; for (const p of sibs) { const u = p === opts.localPath ? url : await localFileUrl(p); if (u) pl.push({ url: u, name: p.split('/').pop() ?? p, localPath: p }); } if (pl.length > 1) opts = { ...opts, playlist: pl }; } } } catch { /* alone */ } }
  if (how === 'external') {
    // (Another app: the player for this kind of source, the relay when the source needs headers, subtitles and the
    // start handed over, and what the app tells back fed to the same «watched» hook — src/player/external.)
    const ext = await import('../player/external/run'); const { serviceOf } = await import('../player/external/logic');
    const srcUrl = opts.origin?.url ?? url; const headers = opts.origin?.headers ?? opts.headers;
    const key = opts.localPath ?? srcUrl.replace(/^http:\/\/127\.0\.0\.1:\d+/, 'stream:');
    const service = serviceOf({ taskKind: opts.task?.kind, localPath: opts.localPath, headers, online: !!opts.origin });
    const handled = await ext.playExternally({ src: ext.sourceFor({ url: srcUrl, name, localPath: opts.localPath, headers, hls: opts.origin?.hls, subtitles: opts.subtitles, startAt: opts.startAt, key }), service, key, task: opts.task, fileIndex: opts.fileIndex, meta: opts.meta, fallback: () => void inApp(url, name, opts) });
    if (handled) return;
    if (await external(url, name, opts.localPath)) return;
  }
  await inApp(url, name, opts);
}
/** The app's own player (the Player add-on), with mpv on a phone when it is here. */
async function inApp(url: string, name: string, opts: PlayOpts): Promise<void> {
  if (!url && opts.inAppUrl) { try { url = await opts.inAppUrl(); } catch (e) { toast(String((e as Error).message ?? e), 'error'); return; } }
  // (Where it goes back to — the app's own player only, not another app's, nor a video handed in by another app.)
  if (!opts.forCaller) await import('../player/returnTo').then((r) => r.notePlayerOpen(opts.task?.meta ?? opts.meta)).catch(() => undefined);
  if (!getSettings().addons.includes('player')) {
    // (Offered in the download card, with its ffmpeg; declined or offline: the system's own controls this time.)
    const { needAddon } = await import('../addons/need');
    if (!(await needAddon('player', t('addonWhyPlayer')))) { bare(url, name, opts.task?.meta ?? opts.meta); return; }
  }
  // (The engine: mpv when it is here and not turned off — Settings → Player —, else the web view's own.)
  let engine: 'mpv' | 'web' = 'web';
  if (nativePlatform() === 'android' && getSettings().playerEngine !== 'web') { const { mpvAvailable } = await import('../player/mpv'); if (await mpvAvailable()) engine = 'mpv'; }
  // (An MKV, AVI or other container the web view cannot decode — a black picture with sound at best — with no mpv here: the mpv pack offered once, the web view only if declined.)
  if (nativePlatform() === 'android' && engine === 'web' && /\.(mkv|avi|wmv|flv|ts|m2ts|mts|mpg|mpeg|ogv|rmvb)(\?|$)/i.test(opts.localPath ?? name ?? url)) { try { const { ensurePacks } = await import('../packs'); if (await ensurePacks(['mpv'], t('packWhyMpv'))) { const { mpvAvailable } = await import('../player/mpv'); if (await mpvAvailable()) engine = 'mpv'; } } catch { /* the web view then */ } }
  const { openPlayer: full } = await import('../player/player'); full({ url, name, ...opts, engine });
}
/** Handed to another app: the phone's chooser (the file itself, or the local stream while it comes), or the
 *  computer's default player for a file. False when there is no way, so the in-app player takes it. */
async function external(url: string, name: string, localPath?: string): Promise<boolean> {
  const p = ktPlugin() as unknown as { openWith?(o: { url?: string; path?: string; mime: string; title: string }): Promise<void> } | null;
  try {
    if (p?.openWith) { await p.openWith({ url: localPath ? undefined : url, path: localPath, mime: 'video/*', title: name }); return true; }
    if (localPath && (await openFolder(localPath))) return true;
    if (window.kurokawaTools) { await openExternal(url); return true; }
  } catch (e) { toast(String((e as Error).message ?? e), 'error'); }
  return false;
}
/** The browser's own <video> (when the Player add-on cannot be fetched). */
function bare(url: string, name: string, meta?: { anilistId?: number; episode?: number }): void {
  const video = h('video', { src: url, controls: true, autoplay: true, playsinline: true, class: 'kt-video' }) as HTMLVideoElement;
  const root = h('div', { class: 'player-view', role: 'dialog', 'aria-label': name },
    h('div', { class: 'player-bar' }, iconButton('back', t('back'), close), h('span', { class: 'grow', dir: 'auto' }, name)), video);
  const unBack = pushLayer({ kind: 'player', name: 'plain player', on: () => root.isConnected, back: () => { close(); return true; } });
  let watched = false; video.addEventListener('ended', () => { watched = true; });
  function close() { unBack(); video.pause(); video.removeAttribute('src'); video.load(); root.remove(); const at = location.hash; void import('../player/returnTo').then((r) => r.playerClosed({ watched, meta, at })); }
  video.addEventListener('error', () => { toast(t('stateFailed'), 'error'); close(); void openExternal(url); });
  document.body.append(root);
}
/** A task's file in the player: streamed while it comes, or the finished file from disk; the task's other videos as the playlist. */
import { localPathOf } from '../engine/localPath';
export async function playTaskFile(x: Task, fileIndex: number): Promise<void> {
  const eng = getEngine(); const f = x.files.find((g) => g.index === fileIndex) ?? x.files[0]; const name = f?.path.split('/').pop() ?? x.name;
  const localOf = (g: { index: number }) => localPathOf(x, g.index);
  const { localFileUrl } = await import('../player/files');
  const urlOf = async (g: { index: number; path: string; done: number; size: number }) => { const lp = localOf(g); if (x.state === 'done' && lp) { const u = await localFileUrl(lp); if (u) return u; } if (eng.streamUrl) return eng.streamUrl(x.id, g.index); return null; };
  const url = f ? await urlOf(f) : null; if (!url) { if (eng.open) await eng.open(x.id, fileIndex); else toast(t('playerCantPlay'), 'error'); return; }
  const vids = x.files.filter((g) => isVideo(g.path) && g.priority > 0);
  const playlist = vids.length > 1 ? await Promise.all(vids.map(async (g) => ({ url: (await urlOf(g)) ?? '', name: g.path.split('/').pop() ?? g.path, localPath: localOf(g), task: x, fileIndex: g.index }))) : undefined;
  await openPlayer(url, name, { task: x, fileIndex, localPath: x.state === 'done' ? localOf(f) : undefined, playlist: playlist?.filter((p) => p.url) });
}
