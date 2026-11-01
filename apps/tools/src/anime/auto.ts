// Anime downloading the Senpwai and Seanime way: a range of episodes fetched in one go with the choices of the
// show (resolution, group, dubbed or not, words to require or avoid) — fillers left out when asked, episodes
// already downloaded skipped — and the same choices kept as a rule so new episodes come by themselves as they
// air (Seanime's Auto Downloader, Senpwai's tracking), checked when the app opens and every half hour.
import { getEngine } from '../engine';
import type { Task } from '../engine/types';
import { getSettings, updateSettings } from '../settings';
import { toast } from '../ui/dom';
import { t } from '../i18n';
import * as al from '../anilist';
import { request } from '../http';
import { buildQuery, searchAll, rank, magnetOf, type TorrentResult } from './providers';
import { parseFilename, matchesEpisode, similar } from './anitomy';

export interface AutoRule { anilistId: number; title: string; cover?: string; resolution: string; group: string; dub: 'any' | 'sub' | 'dub'; require: string; avoid: string; next: number; enabled: boolean; at?: number }
export const rules = (): AutoRule[] => (getSettings().animeAuto ?? []) as AutoRule[];
export const ruleOf = (id: number): AutoRule | undefined => rules().find((r) => r.anilistId === id);
export function saveRule(r: AutoRule): void { updateSettings({ animeAuto: [...rules().filter((x) => x.anilistId !== r.anilistId), r] }); }
export function dropRule(id: number): void { updateSettings({ animeAuto: rules().filter((x) => x.anilistId !== id) }); }

/** The release that best fits an episode and the show's choices (null when none does). */
export function pickFor(rs: TorrentResult[], ep: number, c: Pick<AutoRule, 'resolution' | 'group' | 'dub' | 'require' | 'avoid'>, allowBatch = false): TorrentResult | null {
  const words = (s: string) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const req = words(c.require), avoid = words(c.avoid);
  const ok = rs.filter((r) => {
    const p = parseFilename(r.title); const title = r.title.toLowerCase();
    if (ep && !(r.accuracy === 'high' && !p.batch) && !(p.episode === ep && p.episodeEnd === undefined) && !(allowBatch && matchesEpisode(p, ep))) return false;
    if (c.resolution && !(r.resolution ?? p.resolution ?? '').startsWith(c.resolution)) return false;
    if (c.group && !(p.group ?? r.group ?? '').toLowerCase().includes(c.group.toLowerCase())) return false;
    const dubbed = /\b(dub|dubbed|dual[ .-]?audio|multi[ .-]?audio|eng[ .-]?dub)\b/i.test(r.title);
    if (c.dub === 'dub' && !dubbed) return false; if (c.dub === 'sub' && /\b(dub|dubbed)\b/i.test(r.title) && !/dual/i.test(r.title)) return false;
    if (req.some((w) => !title.includes(w))) return false; if (avoid.some((w) => title.includes(w))) return false;
    return true;
  });
  return rank(ok, c.resolution)[0] ?? null;
}
/** Episodes of a show already among the downloads (by the show and episode they were added with). */
export async function downloadedEpisodes(anilistId: number): Promise<Map<number, Task>> {
  const out = new Map<number, Task>(); let tasks: Task[] = []; try { tasks = await getEngine().list(); } catch { /* none */ }
  for (const x of tasks) { const m = x.meta as { anilistId?: number; episode?: number } | undefined; if (m?.anilistId === anilistId && m.episode) out.set(m.episode, x); }
  return out;
}
async function addFor(a: al.Anime, r: TorrentResult, ep: number): Promise<void> {
  const source = r.url ? { url: r.url } : { magnet: magnetOf(r) };
  const meta = { anilistId: a.id, title: a.title, episode: ep || undefined, cover: a.cover, provider: r.provider, hash: r.hash, fileIdx: r.fileIdx } as Task['meta'];
  if (!r.url && getSettings().debridDefault && getSettings().addons.includes('debrid')) { const { sendToDebrid } = await import('../debrid/transfers'); await sendToDebrid(source, { meta }); return; }
  await getEngine().add({ source, name: r.url ? r.title : undefined, sequential: true, meta });
}

export interface RangeOptions { from: number; to: number; choices: Pick<AutoRule, 'resolution' | 'group' | 'dub' | 'require' | 'avoid'>; skipFillers: boolean; skipHave: boolean; preferBatch: boolean }
/** Episodes `from`–`to` fetched: a batch holding all of them when one fits and is preferred, else one release
 *  per episode; reports each episode as it is settled. */
export async function downloadRange(a: al.Anime, o: RangeOptions, onEach: (ep: number, state: 'added' | 'have' | 'filler' | 'none' | 'batch', title?: string) => void, stop: () => boolean): Promise<number> {
  const have = o.skipHave ? await downloadedEpisodes(a.id) : new Map<number, Task>();
  // (Episodes found on the disk by the library count as had — Senpwai's scan of what is already there.)
  const disk = o.skipHave ? await import('./library').then((l) => l.filesFor(a.id)).catch(() => new Map()) : new Map();
  for (const ep of disk.keys()) if (!have.has(ep)) have.set(ep, { id: '', state: 'done' } as Task);
  const fillers = o.skipFillers ? await fillersOf(a).catch(() => new Set<number>()) : new Set<number>();
  let added = 0;
  if (o.preferBatch && o.to - o.from >= 3) {
    const q = await buildQuery(a, 0); const all = await searchAll(q, () => undefined);
    const batch = rank(all.filter((r) => { const p = parseFilename(r.title); return (p.batch || r.type === 'batch') && (p.episode === undefined || (p.episode <= o.from && (p.episodeEnd ?? 9999) >= o.to)); }).filter((r) => pickFor([r], 0, o.choices)), o.choices.resolution)[0];
    if (batch) { await addFor(a, batch, 0); for (let ep = o.from; ep <= o.to; ep++) onEach(ep, 'batch', batch.title); return 1; }
  }
  for (let ep = o.from; ep <= o.to; ep++) {
    if (stop()) break;
    if (have.has(ep)) { onEach(ep, 'have'); continue; }
    if (fillers.has(ep)) { onEach(ep, 'filler'); continue; }
    try {
      const q = await buildQuery(a, ep); const rs = await searchAll(q, () => undefined);
      const best = pickFor(rs, ep, o.choices) ?? pickFor(rs, ep, { ...o.choices, group: '' });
      if (best) { await addFor(a, best, ep); added++; onEach(ep, 'added', best.title); } else onEach(ep, 'none');
    } catch { onEach(ep, 'none'); }
  }
  return added;
}

/** The rules checked: every aired episode past the last one fetched is looked for and added. */
let checking = false;
export async function checkRules(quiet = true): Promise<number> {
  if (checking) return 0; checking = true; let n = 0;
  try {
    for (const r of rules().filter((x) => x.enabled)) {
      let a: al.Anime; try { a = await al.media(r.anilistId); } catch { continue; }
      const aired = a.nextAiring ? a.nextAiring.episode - 1 : a.status === 'FINISHED' ? a.episodes ?? 0 : Math.max(0, ...(a.schedule ?? []).filter((x) => x.airingAt <= Date.now() / 1000).map((x) => x.episode));
      if (aired < r.next) { saveRule({ ...r, at: Date.now() }); continue; }
      const have = await downloadedEpisodes(r.anilistId); let next = r.next;
      for (let ep = r.next; ep <= aired; ep++) {
        if (have.has(ep)) { next = ep + 1; continue; }
        const q = await buildQuery(a, ep); const rs = await searchAll(q, () => undefined).catch(() => [] as TorrentResult[]);
        const best = pickFor(rs, ep, r); if (!best) break;   // (not out yet in the wanted form: tried again next time)
        await addFor(a, best, ep); n++; next = ep + 1; toast(t('autoAdded', { title: r.title, n: ep }));
      }
      saveRule({ ...rules().find((x) => x.anilistId === r.anilistId) ?? r, next, at: Date.now() });
    }
  } finally { checking = false; }
  if (!quiet && !n) toast(t('autoNothingNew'));
  return n;
}
let timer = 0;
export function startAuto(): void { window.clearInterval(timer); if (!rules().some((r) => r.enabled)) return; setTimeout(() => void checkRules(), 25000); timer = window.setInterval(() => void checkRules(), 30 * 60000); }

/* ---------- fillers (animefillerlist.com, as Senpwai matches them) ---------- */
const FKEY = 'kt.anime.fillers';
type FCache = Record<number, { at: number; eps: number[] }>;
const strict = (s: string) => s.replace(/×/g, 'x').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const loose = (s: string) => strict(s.replace(/\[[^\]]*\]|\([^)]*\)/g, ''));
let index: Promise<{ title: string; path: string }[]> | null = null;
/** The filler episodes of a show (none for a sequel season: the list counts from the show's first episode). */
export async function fillersOf(a: al.Anime): Promise<Set<number>> {
  let cache: FCache = {}; try { cache = JSON.parse(localStorage.getItem(FKEY) ?? '{}') as FCache; } catch { /* none */ }
  const had = cache[a.id]; if (had && Date.now() - had.at < 7 * 86400000) return new Set(had.eps);
  // Hayase's list first (by AniList id, one small file for every show), then animefillerlist.com by title.
  try { const r = await request('https://raw.githubusercontent.com/ThaUnknown/filler-scrape/master/filler.json'); if (r.status === 200) { const j = JSON.parse(r.body) as Record<string, number[]>; const eps = j[String(a.id)]; if (eps?.length) { cache[a.id] = { at: Date.now(), eps }; try { localStorage.setItem(FKEY, JSON.stringify(cache)); } catch { /* full */ } return new Set(eps); } } } catch { /* the other list */ }
  const titles = al.titlesOf(a); if (titles.some((x) => (parseFilename(x).season ?? 1) > 1)) return new Set();
  index ??= (async () => { const r = await request('https://www.animefillerlist.com/shows'); if (r.status !== 200) throw new Error(`HTTP ${r.status}`); const doc = new DOMParser().parseFromString(r.body, 'text/html'); return Array.from(doc.querySelectorAll('#ShowList li a[href]')).map((x) => ({ title: (x.textContent ?? '').trim(), path: x.getAttribute('href') ?? '' })).filter((x) => x.title && x.path); })();
  const shows = await index.catch((e) => { index = null; throw e; });
  const keys = new Set(titles.map(loose)); const strictKeys = new Set(titles.map(strict));
  const cands = shows.filter((s) => keys.has(loose(s.title))).sort((x, y) => (strictKeys.has(strict(y.title)) ? 1 : 0) - (strictKeys.has(strict(x.title)) ? 1 : 0));
  const best = cands[0] ?? shows.map((s) => ({ s, sc: Math.max(...titles.map((x) => similar(x, s.title))) })).filter((x) => x.sc >= 0.9).sort((p, q) => q.sc - p.sc)[0]?.s;
  let eps: number[] = [];
  if (best) {
    const r = await request(new URL(best.path, 'https://www.animefillerlist.com/').href);
    if (r.status === 200) { const doc = new DOMParser().parseFromString(r.body, 'text/html'); eps = Array.from(doc.querySelectorAll('table.EpisodeList tr.filler td.Number')).map((x) => Number((x.textContent ?? '').trim())).filter((n) => n > 0); }
    if (a.episodes && eps.length && Math.max(...eps) > a.episodes) eps = [];
  }
  cache[a.id] = { at: Date.now(), eps }; try { localStorage.setItem(FKEY, JSON.stringify(cache)); } catch { /* full */ }
  return new Set(eps);
}
