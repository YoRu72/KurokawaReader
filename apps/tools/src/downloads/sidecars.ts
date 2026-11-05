// Sidecars for media servers: a Kodi/Jellyfin/Emby «.nfo» beside a finished video (from yt-dlp's info.json, or from
// the anime add-on's own knowledge), written when a download finishes; the cover is yt-dlp's thumbnail kept beside it.
import { getEngine, onEngineChange } from '../engine';
import type { Task } from '../engine/types';
import { getSettings } from '../settings';
import { ktPlugin } from '../native';

type FilesPlugin = { filesHead(o: { path: string; max?: number }): Promise<{ text: string; size: number }>; filesWrite(o: { path: string; text: string }): Promise<{ size: number }>; filesStat(o: { path: string }): Promise<{ exists: boolean }>; filesJob(o: { op: 'delete'; paths: string[] }): Promise<{ id: string }> };
type Desktop = { readFile?(p: string): Promise<ArrayBuffer>; writeText?(o: { path: string; text: string }): Promise<{ ok: boolean }>; removeFile?(p: string): Promise<{ ok: boolean }> };
const pl = () => ktPlugin() as unknown as FilesPlugin | null;
const dt = () => window.kurokawaTools as unknown as Desktop | undefined;

async function readText(path: string): Promise<string | null> {
  try { const p = pl(); if (p) { const s = await p.filesStat({ path }); if (!s.exists) return null; return (await p.filesHead({ path, max: 4 << 20 })).text; } const d = dt(); if (d?.readFile) return new TextDecoder().decode(await d.readFile(path)); } catch { /* none */ }
  return null;
}
async function writeText(path: string, text: string): Promise<boolean> {
  try { const p = pl(); if (p) { await p.filesWrite({ path, text }); return true; } const d = dt(); if (d?.writeText) return (await d.writeText({ path, text })).ok; } catch { /* none */ }
  return false;
}
async function remove(path: string): Promise<void> { try { const p = pl(); if (p) { await p.filesJob({ op: 'delete', paths: [path] }); return; } await dt()?.removeFile?.(path); } catch { /* left */ } }

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (name: string, v: unknown): string => (v === undefined || v === null || v === '' ? '' : `  <${name}>${esc(v)}</${name}>\n`);
const date = (d?: string): string | undefined => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d);

interface Info { title?: string; fulltitle?: string; description?: string; upload_date?: string; uploader?: string; channel?: string; duration?: number; tags?: string[]; categories?: string[]; id?: string; extractor_key?: string; webpage_url?: string; thumbnail?: string; season_number?: number; episode_number?: number; series?: string; playlist_title?: string; playlist_index?: number; language?: string }
/** The NFO text: an episode when it belongs to a series (season/episode known), a movie otherwise. */
export function nfoOf(info: Info, x: Task): string {
  const m = x.meta ?? {}; const series = info.series ?? (m.anilistId ? m.title : undefined) ?? info.playlist_title;
  const season = info.season_number ?? m.season; const episode = info.episode_number ?? m.episode ?? (series ? info.playlist_index : undefined);
  const isEp = !!series && episode !== undefined;
  const root = isEp ? 'episodedetails' : 'movie';
  const genres = [...(info.categories ?? []), ...(info.tags ?? []).slice(0, 10)].map((g) => tag('genre', g)).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${root}>\n${tag('title', info.title ?? info.fulltitle ?? x.name)}${isEp ? tag('showtitle', series) + tag('season', season ?? 1) + tag('episode', episode) : ''}${tag('plot', info.description)}${tag('premiered', date(info.upload_date))}${tag('aired', isEp ? date(info.upload_date) : undefined)}${tag('studio', info.uploader ?? info.channel)}${tag('runtime', info.duration ? Math.round(info.duration / 60) : undefined)}${genres}${info.id ? `  <uniqueid type="${esc((info.extractor_key ?? 'web').toLowerCase())}" default="true">${esc(info.id)}</uniqueid>\n` : ''}${m.anilistId ? `  <uniqueid type="anilist">${esc(m.anilistId)}</uniqueid>\n` : ''}${m.imdbId ? `  <uniqueid type="imdb">${esc(m.imdbId)}</uniqueid>\n` : ''}${tag('thumb', info.thumbnail ?? m.cover)}${tag('source', info.webpage_url ?? x.source.url)}</${root}>\n`;
}
const stemOf = (x: Task): { dir: string; stem: string } | null => { const f = x.files?.[0]?.path || x.name; if (!f || !x.dir) return null; const base = f.split('/').pop() ?? f; return { dir: x.dir.replace(/\/$/, ''), stem: base.replace(/\.[^.]+$/, '') }; };
const seen = new Set<string>();
/** A finished video given its sidecars, once. */
async function afterDone(x: Task): Promise<void> {
  if (seen.has(x.id)) return; seen.add(x.id);
  const s = getSettings(); if (!s.sidecarNfo) return;
  const isVideoTask = x.kind === 'video' || x.meta?.kind === 'video' || !!x.meta?.anilistId || !!x.meta?.imdbId; if (!isVideoTask) return;
  const at = stemOf(x); if (!at) return;
  const infoPath = `${at.dir}/${at.stem}.info.json`; let info: Info = {};
  const raw = await readText(infoPath); if (raw) { try { info = JSON.parse(raw) as Info; } catch { /* none */ } }
  if (!raw && !x.meta?.anilistId && !x.meta?.imdbId && !x.meta?.title) return;
  if (await writeText(`${at.dir}/${at.stem}.nfo`, nfoOf(info, x)) && raw && !s.sidecarKeepJson) await remove(infoPath);
}
let on = false; const was = new Map<string, string>();
/** Watches the engine; a task that turns «done» gets its sidecars. */
export function startSidecars(): void {
  if (on) return; on = true;
  let off: (() => void) | null = null;
  const watch = () => { off?.(); const eng = getEngine(); void eng.list().then((ts) => { for (const x of ts) was.set(x.id, x.state); }).catch(() => undefined); off = eng.onChange((tasks) => { for (const x of tasks) { const prev = was.get(x.id); was.set(x.id, x.state); if (x.state === 'done' && prev && prev !== 'done') void afterDone(x); } }); };
  watch(); onEngineChange(watch);
}
