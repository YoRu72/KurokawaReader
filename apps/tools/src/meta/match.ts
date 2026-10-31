// Releases matched to the works they are — as OTL in the reader finds each series on AniList: a torrent's name
// taken apart (a fansub's "[Group] Title - 05 [1080p]" the anitomy way, a scene name "Title.2023.1080p.WEB-DL"
// or "Show.S02E05" by its year or episode mark), then the title looked up on AniList (anime) or Cinemeta (films
// and series, with their IMDb ids) and the best match kept — remembered for a week, a miss for a day.
import { parseFilename, similar } from '../anime/anitomy';
import type { TitleCard } from '../subs/lookup';

export interface Release { title: string; year?: number; season?: number; episode?: number; episodeEnd?: number; resolution?: string; group?: string; anime: boolean; batch: boolean }

/** What a release's name says: the work's title, the year, the season and episode, the resolution, the group. */
export function parseRelease(name: string): Release {
  const raw = name.trim();
  // A fansub's name: a group in brackets at the front, or " - 05 " numbering.
  if (/^\s*[[(【]/.test(raw) || /\s[-–]\s\d{1,4}(?:v\d)?\s*[[(]/.test(raw)) { const p = parseFilename(raw); return { title: p.title, year: p.year, season: p.season, episode: p.episode, episodeEnd: p.episodeEnd, resolution: p.resolution, group: p.group, anime: true, batch: p.batch }; }
  let s = raw.replace(/\.(mkv|mp4|avi|torrent)$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ');
  const res = /\b(2160p|1080p|720p|576p|480p|4k|uhd)\b/i.exec(s)?.[1]?.toLowerCase();
  const se = /\bS(\d{1,2})\s?E(\d{1,3})(?:\s?-?\s?E?(\d{1,3}))?\b/i.exec(s) ?? /\b(\d{1,2})x(\d{2,3})\b/.exec(s);
  const season = /\b(?:S(\d{1,2})(?!\s?E\d)|Season\s?(\d{1,2}))\b/i.exec(s);
  const yr = /[\s(\[](19[3-9]\d|20[0-4]\d)(?=[\s)\]]|$)/.exec(s);
  const cuts = [se?.index, season?.index, yr?.index, res ? s.toLowerCase().indexOf(res) : undefined, /\b(?:complete|web-?dl|webrip|bluray|blu-ray|bdrip|brrip|hdtv|dvdrip|remux|x264|x265|hevc|h 264|h 265|proper|repack|multi|dual|internal)\b/i.exec(s)?.index].filter((x): x is number => typeof x === 'number' && x > 0);
  const title = (cuts.length ? s.slice(0, Math.min(...cuts)) : s).replace(/[\[(]+$/, '').replace(/\s[-–]\s*$/, '').trim();
  return { title, year: yr ? Number(yr[1]) : undefined, season: se ? Number(se[1]) : season ? Number(season[1] ?? season[2]) : undefined, episode: se ? Number(se[2]) : undefined, episodeEnd: se?.[3] ? Number(se[3]) : undefined, resolution: res === '4k' || res === 'uhd' ? '2160p' : res, anime: false, batch: !se && !!season || /\bcomplete\b/i.test(s) };
}
/** A key that puts releases of one work together. */
export const groupKey = (r: Release): string => `${r.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}|${r.anime ? '' : r.year ?? ''}`;

type Kept = Record<string, { at: number; card: TitleCard | null }>;
const KEY = 'kt.meta.match';
const mem: Kept = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Kept; } catch { return {}; } })();
const save = () => { try { const ks = Object.keys(mem); if (ks.length > 600) for (const k of ks.sort((a, b) => mem[a].at - mem[b].at).slice(0, ks.length - 600)) delete mem[k]; localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* full */ } };
const inflight = new Map<string, Promise<TitleCard | null>>();

/** The work a release belongs to, from the cards already found when they fit, else asked of the catalogues. */
export async function matchRelease(r: Release, known: TitleCard[] = [], adult = false): Promise<TitleCard | null> {
  if (!r.title || r.title.length < 2) return null;
  const best = (cards: TitleCard[]) => {
    let top: TitleCard | null = null; let score = 0;
    for (const c of cards) {
      if (r.anime && c.kind !== 'anime' && cards.some((x) => x.kind === 'anime')) continue;
      let sc = Math.max(...[c.title, ...c.titles].map((t) => similar(t, r.title)));
      if (r.year && c.year) sc += c.year === r.year ? 0.15 : Math.abs(c.year - r.year) <= 1 ? 0 : -0.3;
      if (!r.anime && r.season !== undefined && c.kind === 'movie') sc -= 0.2;
      if (sc > score) { score = sc; top = c; }
    }
    return score >= 0.62 ? top : null;
  };
  const hit = best(known); if (hit) return hit;
  const k = groupKey(r); const had = mem[k];
  if (had && Date.now() - had.at < (had.card ? 7 : 1) * 86400000) return had.card;
  let p = inflight.get(k);
  if (!p) {
    p = (async () => {
      const { lookup } = await import('../subs/lookup');
      const cards = await lookup(r.title, adult, r.anime ? 'anime' : 'video').catch(() => [] as TitleCard[]);
      const card = best(cards); mem[k] = { at: Date.now(), card }; save(); return card;
    })().finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}
