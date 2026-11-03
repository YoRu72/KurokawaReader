// A new link for a download whose signed link ran out (HTTP 401/403/410 — itch.io, cloud storage). The app's
// browser keeps the way to each download it caught: the pages and the buttons tapped on them. That way is replayed —
// the same pages opened, the same buttons tapped — and the download it leads to gives this one its new link; the
// download goes on from where it stopped. By hand from the download's page, or by itself when the download asks
// for it («Get a new link by itself», off by default).
import { getEngine } from '../engine';
import type { Task } from '../engine/types';
import { ktPlugin, nativePlatform } from '../native';

export type Step = { url: string; text: string; tag: string; href: string; id: string; n: number };
const TRAILS = 'kt.trails', AUTO = 'kt.autoRelink', TRIES = 'kt.relinkTries';
const read = <T>(k: string, d: T): T => { try { return (JSON.parse(localStorage.getItem(k) ?? 'null') as T) ?? d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
const key = (u: string) => u.replace(/[?#].*$/, '');

/** The way to a download, kept by its link (without its signature: a new link of the same file finds it). */
export function saveTrail(url: string, trail: Step[]): void { if (!trail?.length) return; const all = read<Record<string, Step[]>>(TRAILS, {}); all[key(url)] = trail.slice(-12); const ks = Object.keys(all); if (ks.length > 60) for (const k of ks.slice(0, ks.length - 60)) delete all[k]; write(TRAILS, all); }
export function trailOf(x: Pick<Task, 'source'>): Step[] | null { const u = x.source.url; if (!u) return null; return read<Record<string, Step[]>>(TRAILS, {})[key(u)] ?? null; }
export const autoRelinkOn = (id: string): boolean => !!read<Record<string, boolean>>(AUTO, {})[id];
export function setAutoRelink(id: string, on: boolean): void { const a = read<Record<string, boolean>>(AUTO, {}); if (on) a[id] = true; else delete a[id]; write(AUTO, a); }
export const expired = (x: Task): boolean => x.kind === 'http' && x.state === 'failed' && /^HTTP (401|403|410)$/.test(x.error ?? '');

/** The way replayed in the app's browser (Android): true when there was one to replay. */
export function replayTrail(x: Task): boolean {
  const trail = trailOf(x); const p = ktPlugin() as unknown as { browse?(o: { url: string; replay?: { id: string; trail: Step[] } }): Promise<void> } | null;
  if (!trail?.length || !p?.browse || nativePlatform() !== 'android') return false;
  void p.browse({ url: trail[0].url, replay: { id: x.id, trail } }); return true;
}
/** A replay's end (the browser's «relink»): the new link given to the download, its way kept under it. */
export async function relinked(o: { id: string; ok: boolean; url?: string; referer?: string; ua?: string }): Promise<boolean> {
  if (!o.ok || !o.url) return false;
  const eng = getEngine(); const x = (await eng.list().catch(() => [] as Task[])).find((t) => t.id === o.id);
  const headers: Record<string, string> = {}; if (o.referer) headers.Referer = o.referer; if (o.ua) headers['User-Agent'] = o.ua;
  if (x) { const tr = trailOf(x); if (tr) saveTrail(o.url, tr); }
  await eng.setUrl!(o.id, o.url, Object.keys(headers).length ? headers : undefined); return true;
}

/** Watching for downloads that asked to get a new link by themselves: at most three tries an hour each, only while
 *  the app is in front (Android opens the browser only then). */
let started = false;
export function startAutoRelink(): void {
  if (started || nativePlatform() !== 'android') return; started = true;
  const look = (tasks: Task[]) => {
    if (document.hidden) return;
    for (const x of tasks) {
      if (!expired(x) || !autoRelinkOn(x.id) || !trailOf(x)) continue;
      const tries = read<Record<string, number[]>>(TRIES, {}); const mine = (tries[x.id] ?? []).filter((t) => Date.now() - t < 3600000);
      if (mine.length >= 3) continue;
      tries[x.id] = [...mine, Date.now()]; write(TRIES, tries);
      if (replayTrail(x)) return;   // (one at a time)
    }
  };
  getEngine().onChange(look);
}
