// The local anime library (Seanime's library, Senpwai's scan of what is already on the disk): the download folders
// (and any the user adds) read for video files, each file's name taken apart (show, season, episode), and the
// files grouped by show and matched to AniList — first by the downloads that know their show, then by the title
// (Sørensen–Dice against every title of the best search hits), a match kept and changeable by hand. What it gives:
// each show's episodes on the disk, the next one to watch, and what to continue.
import { getSettings, updateSettings } from '../settings';
import { getEngine } from '../engine';
import type { Task } from '../engine/types';
import * as al from '../anilist';
import { parseFilename, similar } from './anitomy';
import { allCategories, categoryDir } from '../downloads/categories';
import { ktPlugin } from '../native';

export interface LibFile { path: string; name: string; size: number; mtime: number; episode?: number; season?: number; title: string }
export interface LibShow { key: string; title: string; files: LibFile[]; anilistId?: number; media?: al.Anime }
const VIDEO = /\.(mkv|mp4|m4v|webm|avi|mov|ts|wmv|flv)$/i;
const MKEY = 'kt.anime.libmatch';
type Entry = { name: string; path: string; dir: boolean; size: number; mtime: number };

async function list(dir: string): Promise<Entry[]> {
  const d = window.kurokawaTools as unknown as { listDir?(p: string): Promise<{ entries: Entry[] }> } | undefined; if (d?.listDir) return (await d.listDir(dir)).entries ?? [];
  const p = ktPlugin() as unknown as { listDir?(o: { path: string }): Promise<{ entries: Entry[] }> } | null; return p?.listDir ? (await p.listDir({ path: dir })).entries ?? [] : [];
}
/** The folders read: the downloads folder, each category's, the downloads' own folders, and the user's. */
export async function libraryDirs(tasks: Task[]): Promise<string[]> {
  const s = getSettings(); const out = new Set<string>();
  let base = s.downloadDir;
  if (!base || base.startsWith('content:')) { try { const d = window.kurokawaTools as unknown as { defaultDir?(): Promise<string> } | undefined; base = d?.defaultDir ? await d.defaultDir() : (await ktPlugin()?.defaultDir())?.dir ?? ''; } catch { base = ''; } }
  if (base) out.add(base);
  for (const c of allCategories()) { const d = categoryDir(c); if (d && !d.startsWith('content:')) out.add(d); }
  for (const x of tasks) if ((x.meta as { anilistId?: number } | undefined)?.anilistId && x.dir && !x.dir.startsWith('content:')) out.add(x.dir);
  for (const d of s.animeLibraryDirs ?? []) out.add(d);
  // (A folder inside another is read once, with the outer one.)
  const all = [...out].map((d) => d.replace(/[\\/]+$/, ''));
  return all.filter((d) => !all.some((o) => o !== d && (d.startsWith(`${o}/`) || d.startsWith(`${o}\\`))));
}
/** Every video file under the folders (four levels at most, five thousand files at most). */
export async function scanFiles(dirs: string[], onDir?: (n: number) => void): Promise<LibFile[]> {
  const out: LibFile[] = []; let seenDirs = 0;
  const walk = async (d: string, depth: number) => {
    if (out.length >= 5000) return; let es: Entry[] = []; try { es = await list(d); } catch { return; } onDir?.(++seenDirs);
    for (const e of es) {
      if (e.name.startsWith('.')) continue;
      if (e.dir) { if (depth < 4) await walk(e.path, depth + 1); continue; }
      if (!VIDEO.test(e.name) || e.size < 5 << 20) continue;
      const p = parseFilename(e.name); const folder = d.split(/[\\/]/).pop() ?? '';
      // (A file named by its episode only — «05.mkv» — takes its show from its folder.)
      const title = (p.title && p.title.replace(/\s+/g, ' ').trim().length > 1 ? p.title : parseFilename(folder).title || folder).trim();
      out.push({ path: e.path, name: e.name, size: e.size, mtime: e.mtime, episode: p.episode, season: p.season, title });
    }
  };
  for (const d of dirs) await walk(d, 0);
  return out;
}
const norm = (s: string) => s.toLowerCase().replace(/\b(season|s)\s*\d+\b|\b(\d+)(st|nd|rd|th)\s+season\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const matches = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(MKEY) ?? '{}') as Record<string, number>; } catch { return {}; } };
export function setMatch(key: string, id: number | null): void { const m = matches(); if (id) m[key] = id; else delete m[key]; try { localStorage.setItem(MKEY, JSON.stringify(m)); } catch { /* full */ } }

/** The files grouped by show and matched: by hand first, then by the downloads, then by AniList's search. */
export async function buildLibrary(onStep?: (what: string) => void): Promise<{ shows: LibShow[]; unmatched: LibShow[] }> {
  let tasks: Task[] = []; try { tasks = await getEngine().list(); } catch { /* none */ }
  const dirs = await libraryDirs(tasks); onStep?.('scan');
  const files = await scanFiles(dirs);
  const byPath = new Map<string, number>();
  for (const x of tasks) { const id = (x.meta as { anilistId?: number } | undefined)?.anilistId; if (!id || !x.dir) continue; const root = `${x.dir.replace(/[\\/]+$/, '')}/${x.name}`; byPath.set(root, id); }
  const groups = new Map<string, LibShow>();
  for (const f of files) {
    const key = `${norm(f.title)}|${f.season ?? 1}`;
    const g = groups.get(key) ?? { key, title: f.title, files: [] }; g.files.push(f); groups.set(key, g);
    if (!g.anilistId) for (const [root, id] of byPath) if (f.path === root || f.path.startsWith(`${root}/`) || f.path.startsWith(`${root}\\`)) g.anilistId = id;
  }
  const hand = matches(); const shows = [...groups.values()];
  for (const g of shows) if (hand[g.key]) g.anilistId = hand[g.key];
  // AniList asked for the rest (a few at a time — it allows about thirty requests a minute), the answer kept.
  onStep?.('match');
  for (const g of shows.filter((x) => !x.anilistId).slice(0, 25)) {
    try {
      const hits = await al.search(g.title, { adult: getSettings().animeAdult });
      const season = g.files[0]?.season ?? 1;
      const scored = hits.map((a) => ({ a, s: Math.max(...al.titlesOf(a).map((x) => similar(norm(x), norm(g.title)))) + (season > 1 && al.titlesOf(a).some((x) => new RegExp(`\\b(season|s)\\s*${season}\\b|\\b${season}(st|nd|rd|th) season`, 'i').test(x)) ? 0.2 : 0) })).sort((x, y) => y.s - x.s);
      if (scored[0] && scored[0].s >= 0.72) { g.anilistId = scored[0].a.id; g.media = scored[0].a; setMatch(g.key, g.anilistId); }
    } catch { break; }
  }
  for (const g of shows) g.files.sort((x, y) => (x.episode ?? 0) - (y.episode ?? 0) || x.name.localeCompare(y.name));
  return { shows: shows.filter((g) => g.anilistId), unmatched: shows.filter((g) => !g.anilistId) };
}
/** One show's files by episode (the largest file when there are several for one). */
export function episodesOf(g: LibShow): Map<number, LibFile> {
  const m = new Map<number, LibFile>(); for (const f of g.files) if (f.episode) { const had = m.get(f.episode); if (!had || f.size > had.size) m.set(f.episode, f); }
  return m;
}
/** Files on the disk for one AniList show (for its page: episodes playable from the disk). */
export async function filesFor(anilistId: number): Promise<Map<number, LibFile>> {
  const cache = lastLib; if (!cache) return new Map();
  const out = new Map<number, LibFile>(); for (const g of cache.shows.filter((x) => x.anilistId === anilistId)) for (const [ep, f] of episodesOf(g)) if (!out.has(ep)) out.set(ep, f);
  return out;
}
let lastLib: { shows: LibShow[]; unmatched: LibShow[] } | null = null;
export async function library(refresh = false, onStep?: (what: string) => void): Promise<{ shows: LibShow[]; unmatched: LibShow[] }> { if (!lastLib || refresh) lastLib = await buildLibrary(onStep); return lastLib; }
export function addLibraryDir(d: string): void { const s = getSettings(); updateSettings({ animeLibraryDirs: [...new Set([...(s.animeLibraryDirs ?? []), d])] }); }
