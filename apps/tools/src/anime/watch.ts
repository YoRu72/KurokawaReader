// An episode watched now (Hayase's way, Seanime's «auto select»): the release that best fits the show's choices —
// the wanted quality, then the lookup preference (quality, size or seeders) — found among every source, added to
// play while it comes (in order, only the episode's file when it is in a batch), and opened in the player as soon
// as its details are in. A small card says where it is and can stop it.
import { h, icon, toast } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getEngine, isVideo } from '../engine';
import type { Task } from '../engine/types';
import type { Anime } from '../anilist';
import { getSettings } from '../settings';
import { buildQuery, searchAll, magnetOf, type TorrentResult } from './providers';
import { pickFor, ruleOf, downloadedEpisodes } from './auto';
import { parseFilename, matchesEpisode } from './anitomy';

/** The release to use for an episode: the show's saved choices first, then the app's quality alone, then any. */
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

let running: { stop(): void } | null = null;
export async function watchEpisode(a: Anime, ep: number, title: string): Promise<void> {
  return watchWith({
    title,
    have: async () => (await downloadedEpisodes(a.id)).get(ep),
    find: async () => bestRelease(a, ep, await searchAll(await buildQuery(a, ep), () => undefined)),
    meta: (best) => ({ anilistId: a.id, title, episode: ep || undefined, cover: a.cover, provider: best.provider, hash: best.hash, fileIdx: best.fileIdx }),
    pick: (x) => episodeFile(x, ep),
  });
}
/** The watcher itself, for anime and for films and series: a download already there, or the release `find`
 *  gives added to play in order (only its one file when it names one), then played as soon as its files are known. */
export async function watchWith(o: { title: string; have?: () => Promise<Task | undefined>; find: () => Promise<TorrentResult | null>; meta: (r: TorrentResult) => Task['meta']; pick: (x: Task, r?: TorrentResult) => number }): Promise<void> {
  running?.stop();
  const eng = getEngine(); const title = o.title;
  if (!eng.streamUrl) { toast(t('watchNeedsApp'), 'error', 5000); return; }
  let stopped = false; let taskId = ''; let off: (() => void) | null = null; let chosen: TorrentResult | undefined;
  const line = h('small', null, t('watchFinding')); const bar = h('div', { class: 'task-bar thin' }, h('i', { style: { width: '8%' } }));
  const stop = () => { stopped = true; off?.(); el.classList.add('leaving'); setTimeout(() => el.remove(), 180); if (running === me) running = null; };
  const me = { stop }; running = me;
  const el = h('div', { class: 'get-card watch-card', role: 'status' },
    h('div', { class: 'get-head' }, h('span', { class: 'get-ic' }, icon('play')), h('div', { class: 'grow' }, h('b', { dir: 'auto' }, title), line),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('cancel'), onclick: () => { stop(); if (taskId) void eng.pause(taskId).catch(() => undefined); } }, icon('close'))),
    bar);
  document.body.append(el);
  const setBar = (p: number) => { (bar.firstChild as HTMLElement).style.width = `${Math.max(4, Math.min(100, p))}%`; };
  try {
    let task: Task | undefined = await o.have?.();
    if (!task) {
      const best = await o.find(); if (stopped) return;
      if (!best) { line.textContent = t('watchNone'); setTimeout(stop, 4000); return; }
      chosen = best; line.textContent = best.title; setBar(25);
      task = await eng.add({ source: best.url ? { url: best.url } : { magnet: magnetOf(best) }, name: best.url ? best.title : undefined, sequential: true, files: !best.url && best.fileIdx !== undefined ? [best.fileIdx] : undefined, meta: o.meta(best) });
    }
    taskId = task.id;
    const ready = (x: Task) => x.files.length > 0 && (x.kind !== 'torrent' || x.state !== 'metadata');
    const go = async (x: Task) => {
      off?.(); off = null; if (stopped) return;
      const fi = chosen?.fileIdx !== undefined && x.files.some((f) => f.index === chosen!.fileIdx) ? chosen.fileIdx : o.pick(x, chosen);
      if (x.kind === 'torrent' && x.files.length > 1 && eng.setFiles) await eng.setFiles(x.id, x.files.map((f) => (f.index === fi ? 2 : 0) as 0 | 1 | 2)).catch(() => undefined);
      setBar(100); line.textContent = t('watchOpening');
      const { playTaskFile } = await import('../views/player'); await playTaskFile(x, fi); stop();
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
