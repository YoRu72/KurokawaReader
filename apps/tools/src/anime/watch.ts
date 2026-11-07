// An episode watched now (Hayase's way, Seanime's «auto select»): the release that best fits the show's choices —
// the wanted quality, then the lookup preference (quality, size or seeders) — found among every source, added to
// play while it comes (in order, only the episode's file when it is in a batch), and opened in the player as soon
// as its details are in. A small card says where it is and can stop it.
import { h, icon, toast } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getEngine, isVideo, platformEngineProblem, retryPlatformEngine } from '../engine';
import type { Task } from '../engine/types';
import type { Anime } from '../anilist';
import { getSettings } from '../settings';
import { buildQuery, searchAll, magnetOf, type TorrentResult } from './providers';
import { pickFor, ruleOf, downloadedEpisodes } from './auto';
import { parseFilename, matchesEpisode } from './anitomy';

/** The release to use for an episode: the show's saved choices first, then the app's quality alone, then any. */
/** The best release for an episode, found the quick way: once a well-seeded, sure match is in, the slow sources
 *  are not waited for (Hayase starts as soon as it has one). */
export async function findBest(a: Anime, ep: number): Promise<TorrentResult | null> {
  const good = (all: TorrentResult[]) => { const b = bestRelease(a, ep, all); return !!b && b.seeders >= 5 && (b.accuracy === 'high' || b.type === 'best'); };
  return bestRelease(a, ep, await searchAll(await buildQuery(a, ep), () => undefined, { enough: good, grace: 2500 }));
}
export function bestRelease(a: Anime, ep: number, rs: TorrentResult[]): TorrentResult | null {
  const r = ruleOf(a.id); const q = getSettings().animeQuality;
  const base = r ? { resolution: r.resolution, group: r.group, dub: r.dub, require: r.require, avoid: r.avoid } : { resolution: q, group: '', dub: 'any' as const, require: '', avoid: '' };
  const pick = pickFor(rs, ep, base) ?? pickFor(rs, ep, { ...base, group: '' }) ?? pickFor(rs, ep, { ...base, group: '', resolution: '' }) ?? pickFor(rs, ep, { ...base, group: '', resolution: '' }, true);
  if (!pick) return null;
  // (Among the releases as good as the pick, the lookup preference decides: Hayase's quality | size | seeders.)
  const pref = getSettings().animeLookup ?? 'quality';
  if (pref === 'quality') return pick;
  const same = rs.filter((x) => (x.resolution ?? parseFilename(x.title).resolution) === (pick.resolution ?? parseFilename(pick.title).resolution) && (ep ? matchesEpisode(parseFilename(x.title), ep) || x.accuracy === 'high' : true));
  if (!same.length) return pick;
  return [...same].sort((x, y) => (pref === 'size' ? x.size - y.size : y.seeders - x.seeders))[0];
}

/** The episode's file among a task's files (a batch: matched by its number; else the largest video). */
export function episodeFile(x: Task, ep: number): number {
  const vids = x.files.filter((f) => isVideo(f.path));
  if (!vids.length) return x.files[0]?.index ?? 0;
  if (vids.length > 1 && ep) { const m = vids.find((f) => parseFilename(f.path.split('/').pop() ?? f.path).episode === ep); if (m) return m.index; }
  return [...vids].sort((p, q) => q.size - p.size)[0].index;
}

/** The next episode, fetched while this one plays (its best release, only its file from a batch): ready by
 *  the time it is wanted. Nothing done when it has not aired, is already here, or is coming. */
const preloaded = new Set<string>();
export async function preloadNext(anilistId: number, ep: number): Promise<void> {
  const key = `${anilistId}:${ep + 1}`; if (preloaded.has(key)) return; preloaded.add(key);
  const al = await import('../anilist'); const a = await al.media(anilistId);
  const aired = a.nextAiring ? a.nextAiring.episode - 1 : a.episodes ?? 0; if (aired && ep + 1 > aired) return;
  if ((await downloadedEpisodes(anilistId)).has(ep + 1)) return;
  const best = await findBest(a, ep + 1); if (!best) return;
  const { addFor } = await import('./auto'); await addFor(a, best, ep + 1);
  const { toast } = await import('../ui/dom'); const { t } = await import('../i18n'); toast(t('preloadedNext', { n: ep + 1 }));
}
let running: { stop(): void } | null = null;
/* ---------- the release picked before, for each show (Hayase's «continue»): a batch is used again for the next
   episodes, its file for each episode found in it ---------- */
export interface Picked { title: string; hash: string; link: string; provider: string; batch: boolean; at: number }
const PICK_KEY = 'kt.watchPick';
const picks = (): Record<string, Picked> => { try { return JSON.parse(localStorage.getItem(PICK_KEY) ?? '{}') as Record<string, Picked>; } catch { return {}; } };
export function rememberPick(anilistId: number, r: TorrentResult): void {
  if (r.url || !r.hash) return; const p = parseFilename(r.title);
  const all = picks(); all[anilistId] = { title: r.title, hash: r.hash, link: magnetOf(r), provider: r.provider, batch: r.type === 'batch' || p.batch || p.episode === undefined, at: Date.now() };
  try { localStorage.setItem(PICK_KEY, JSON.stringify(all)); } catch { /* full */ }
}
export const pickedFor = (anilistId: number): Picked | undefined => picks()[anilistId];
/** A download of the show that holds this episode: the episode's own, else a batch with its file. */
export async function taskFor(anilistId: number, ep: number): Promise<Task | undefined> {
  const own = (await downloadedEpisodes(anilistId)).get(ep); if (own) return own;
  let tasks: Task[] = []; try { tasks = await getEngine().list(); } catch { /* none */ }
  return tasks.find((x) => (x.meta as { anilistId?: number } | undefined)?.anilistId === anilistId && x.kind === 'torrent' && x.files.some((f) => isVideo(f.path) && parseFilename(f.path.split('/').pop() ?? f.path).episode === ep));
}
/** What «Watch now» will play: a download holding the episode, else the batch picked before (to go on in), else
 *  nothing known yet (the best release is looked for). */
export async function watchPlan(a: Anime, ep: number): Promise<{ task?: Task; picked?: Picked }> {
  const task = await taskFor(a.id, ep); if (task) return { task };
  const picked = pickedFor(a.id); const r = picked ? parseFilename(picked.title) : undefined; const covers = !!r && (r.episode === undefined || r.episodeEnd === undefined || (ep >= r.episode && ep <= r.episodeEnd));
  return picked?.batch && covers ? { picked } : {};
}
export async function watchEpisode(a: Anime, ep: number, title: string, release?: TorrentResult): Promise<void> {
  // (As in Hayase: the releases to choose from, the best one first — unless one is already here (or a batch
  // picked before goes on), or picking by itself was chosen.)
  if (!release && !getSettings().animeWatchAuto) { const plan = await watchPlan(a, ep); if (!plan.task && !plan.picked) { const m = await import('../views/animeEntry'); await m.torrentSheet(a, ep, 'stream'); return; } }
  return watchWith({
    title,
    have: release ? undefined : async () => taskFor(a.id, ep),
    find: async () => {
      if (release) return release;
      const p = pickedFor(a.id);
      const range = p ? parseFilename(p.title) : undefined; const covers = !!range && (range.episode === undefined || range.episodeEnd === undefined || (ep >= range.episode && ep <= range.episodeEnd));
      if (p?.batch && covers) return { title: p.title, link: p.link, hash: p.hash, size: 0, seeders: 0, leechers: 0, downloads: 0, accuracy: 'high', provider: p.provider, type: 'batch' };
      return findBest(a, ep);
    },
    meta: (best) => ({ anilistId: a.id, title, episode: ep || undefined, cover: a.cover, provider: best.provider, hash: best.hash, fileIdx: best.fileIdx }),
    pick: (x) => episodeFile(x, ep),
    picked: (r) => rememberPick(a.id, r),
    choose: () => void import('../views/animeEntry').then((m) => m.torrentSheet(a, ep, 'stream')),
  });
}
/** The watcher itself, for anime and for films and series: a download already there, or the release `find`
 *  gives added to play in order (only its one file when it names one), then played as soon as its files are known. */
export async function watchWith(o: { title: string; have?: () => Promise<Task | undefined>; find: () => Promise<TorrentResult | null>; meta: (r: TorrentResult) => Task['meta']; pick: (x: Task, r?: TorrentResult) => number; picked?: (r: TorrentResult) => void; choose?: () => void }): Promise<void> {
  running?.stop();
  // (On the computer aria2c may be late or stopped: started again first; still not there — why, not «get the app».)
  if (!getEngine().streamUrl && platformEngineProblem()) await retryPlatformEngine();
  const eng = getEngine(); const title = o.title;
  if (!eng.streamUrl) { const why = platformEngineProblem(); toast(why ? t('engineUnavailable', { why }) : t('watchNeedsApp'), 'error', 7000); return; }
  let stopped = false; let taskId = ''; let off: (() => void) | null = null; let chosen: TorrentResult | undefined;
  const line = h('small', null, t('watchFinding')); const bar = h('div', { class: 'task-bar thin' }, h('i', { style: { width: '8%' } }));
  const stop = () => { stopped = true; off?.(); el.classList.add('leaving'); setTimeout(() => el.remove(), 180); if (running === me) running = null; };
  const me = { stop }; running = me;
  const el = h('div', { class: 'get-card watch-card', role: 'status' },
    h('div', { class: 'get-head' }, h('span', { class: 'get-ic' }, icon('play')), h('div', { class: 'grow' }, h('b', { dir: 'auto' }, title), line),
      // (×: the watching stops; the download goes on, as in Hayase — it is there to play later.)
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('watchStopHere'), title: t('watchStopHere'), onclick: () => { stop(); if (taskId) toast(t('watchKeptDownloading')); } }, icon('close'))),
    bar);
  document.body.append(el);
  const setBar = (p: number) => { (bar.firstChild as HTMLElement).style.width = `${Math.max(4, Math.min(100, p))}%`; };
  try {
    let task: Task | undefined = await o.have?.(); const existing = !!task;
    if (!task) {
      const best = await o.find(); if (stopped) return;
      // (Nothing found: said, with the way to choose a release by hand — searched by any name.)
      if (!best) { line.textContent = t('watchNone'); if (o.choose) { el.append(h('button', { type: 'button', class: 'btn tonal small', onclick: () => { stop(); o.choose!(); } }, icon('magnet'), t('watchChoose'))); setTimeout(stop, 15000); } else setTimeout(stop, 4000); return; }
      chosen = best; line.textContent = best.title; setBar(25); o.picked?.(best);
      // (The same release already among the downloads — a batch picked before: used, not added again.)
      const same = best.hash ? (await eng.list().catch(() => [] as Task[])).find((x) => x.kind === 'torrent' && (x.source.magnet ?? '').toLowerCase().includes(best.hash.toLowerCase())) : undefined;
      if (same) task = same; else task = await eng.add({ source: best.url ? { url: best.url } : { magnet: magnetOf(best) }, name: best.url ? best.title : undefined, sequential: true, files: !best.url && best.fileIdx !== undefined ? [best.fileIdx] : undefined, meta: o.meta(best) });
    }
    taskId = task.id;
    const ready = (x: Task) => x.files.length > 0 && (x.kind !== 'torrent' || x.state !== 'metadata');
    const go = async (x: Task) => {
      off?.(); off = null; if (stopped) return;
      const fi = chosen?.fileIdx !== undefined && x.files.some((f) => f.index === chosen!.fileIdx) ? chosen.fileIdx : o.pick(x, chosen);
      // (A new release: only the episode's file. One already here, a batch gone on in: this file first, the rest as they were.)
      const reuse = existing || (x.addedAt && Date.now() - x.addedAt > 30000);
      if (x.kind === 'torrent' && x.files.length > 1 && eng.setFiles) await eng.setFiles(x.id, x.files.map((f) => (f.index === fi ? 2 : reuse ? (f.priority === 2 ? 1 : f.priority) : 0) as 0 | 1 | 2)).catch(() => undefined);
      if (x.state === 'paused' && reuse) await eng.resume(x.id).catch(() => undefined);
      setBar(100); line.textContent = t('watchOpening');
      // (The card goes before the player's own question — «watch with» — so the two are never on top of each other.)
      stop(); const { playTaskFile } = await import('../views/player'); await playTaskFile(x, fi);
    };
    if (ready(task)) { await go(task); return; }
    line.textContent = t('watchMeta');
    off = eng.onChange((ts) => {
      const x = ts.find((y) => y.id === taskId); if (!x || stopped) return;
      if (x.state === 'failed') { line.textContent = x.error ?? t('watchNone'); off?.(); return; }
      if (ready(x)) { void go(x); return; }
      setBar(40); line.textContent = `${t('watchMeta')} · ${t('peersN', { n: localDigits(x.peers ?? 0) })}`;
    });
  } catch (e) { line.textContent = String((e as Error).message ?? e); setTimeout(stop, 6000); }
}
