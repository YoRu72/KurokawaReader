// The flight recorder: the last few hundred events of the app — downloads starting, failing, finishing, engine
// errors, page errors, settings changes — kept in a ring, with links and names redacted (hosts kept, paths and
// query strings dropped, tokens blanked), so a bug report carries what happened without carrying what was fetched.
import { getEngine, onEngineChange } from '../engine';
import type { Task } from '../engine/types';
import { onSettingsChange } from '../settings';
import { nativePlatform } from '../native';
import { APP_VERSION as VERSION } from '../repo';

export interface Event { t: number; kind: string; text: string }
const KEY = 'kt.recorder'; const MAX = 400;
let ring: Event[] = []; let dirty = false;
const load = () => { try { const a = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Event[]; ring = Array.isArray(a) ? a.slice(-MAX) : []; } catch { ring = []; } };
const flush = () => { if (!dirty) return; dirty = false; try { localStorage.setItem(KEY, JSON.stringify(ring.slice(-MAX))); } catch { /* none */ } };
/** A link with only its host and the file's extension left; a path with only its last part; secrets blanked. */
export function redact(s: string): string {
  return s
    .replace(/https?:\/\/([^/\s?#]+)[^\s]*?(\.[a-z0-9]{1,5})?(?=[\s)"']|$)/gi, (_m, host: string, ext?: string) => `https://${host}/…${ext ?? ''}`)
    .replace(/magnet:\?[^\s]*/gi, 'magnet:?…')
    .replace(/(\/[^\s/:]+){2,}\/([^\s/]+)/g, '…/$2')
    .replace(/(token|key|secret|password|pass|auth|cookie|bearer)([=:]\s*)[^\s&;,"']+/gi, '$1$2•••')
    .slice(0, 300);
}
export function record(kind: string, text: string): void { ring.push({ t: Date.now(), kind, text: redact(text) }); if (ring.length > MAX) ring = ring.slice(-MAX); dirty = true; }
export const events = (): Event[] => ring.slice();
export const clear = (): void => { ring = []; dirty = true; flush(); };
/** The report text: the app and platform, then the events, newest last. */
export function report(): string {
  const head = `Kurokawa Tools ${VERSION} · ${nativePlatform()} · ${navigator.userAgent.slice(0, 120)} · ${new Date().toISOString()}`;
  return [head, '', ...ring.map((e) => `${new Date(e.t).toISOString().slice(11, 19)} ${e.kind.padEnd(9)} ${e.text}`)].join('\n');
}
let on = false; const last = new Map<string, string>();
export function startRecorder(): void {
  if (on) return; on = true; load(); record('app', `started ${VERSION} on ${nativePlatform()}`);
  window.addEventListener('error', (e) => record('error', `${e.message} @ ${redact(String(e.filename ?? ''))}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => record('error', `unhandled: ${String((e.reason as Error)?.message ?? e.reason).slice(0, 200)}`));
  onSettingsChange(() => record('settings', 'changed'));
  let off: (() => void) | null = null;
  const watch = () => {
    off?.(); const eng = getEngine(); record('engine', `engine ${eng.id}`);
    off = eng.onChange((tasks: Task[]) => { for (const x of tasks) { const prev = last.get(x.id); if (prev === x.state) continue; last.set(x.id, x.state); if (!prev && x.state === 'queued') record('task', `added ${x.kind} ${x.source.url ?? x.source.magnet ?? 'torrent'}`); else if (x.state === 'failed') record('task', `failed ${x.kind} ${x.name}: ${x.error ?? ''}`); else if (x.state === 'done') record('task', `done ${x.kind} ${x.name} ${x.total}`); else if (x.state === 'downloading' && prev !== 'downloading') record('task', `running ${x.kind} ${x.name}`); } });
  };
  watch(); onEngineChange(watch);
  setInterval(flush, 5000); window.addEventListener('pagehide', flush);
}
