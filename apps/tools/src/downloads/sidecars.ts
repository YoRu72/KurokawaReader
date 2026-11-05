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

/** A small text file beside a download (the player reads yt-dlp's info.json for the heatmap). */
export const readSidecar = (path: string): Promise<string | null> => readText(path);
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
  const s = getSettings(); if (!s.sidecarNfo && !s.sidecarComments && !s.sidecarChapters && !s.sidecarLyrics) return;
  const isVideoTask = x.kind === 'video' || x.meta?.kind === 'video' || !!x.meta?.anilistId || !!x.meta?.imdbId; if (!isVideoTask) return;
  const at = stemOf(x); if (!at) return;
  const infoPath = `${at.dir}/${at.stem}.info.json`; let info: Info = {};
  const raw = await readText(infoPath); if (raw) { try { info = JSON.parse(raw) as Info; } catch { /* none */ } }
  if (!raw && !x.meta?.anilistId && !x.meta?.imdbId && !x.meta?.title) return;
  const fx = info as Info & { chapters?: { start_time: number; end_time: number; title?: string }[]; comments?: { author?: string; text?: string; like_count?: number; timestamp?: number }[]; track?: string; artist?: string; album?: string };
  const hms = (sec: number) => { sec = Math.round(sec); const hh = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60; return (hh ? `${hh}:` : '') + `${String(m).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`; };
  if (s.sidecarChapters && fx.chapters?.length) await writeText(`${at.dir}/${at.stem}.chapters.txt`, fx.chapters.map((c) => `${hms(c.start_time)} ${c.title ?? ''}`).join('\n') + '\n');
  if (s.sidecarComments && fx.comments?.length) await writeText(`${at.dir}/${at.stem}.comments.txt`, fx.comments.map((c) => `${c.author ?? '?'}${c.like_count ? ` (+${c.like_count})` : ''}${c.timestamp ? ` · ${new Date(c.timestamp * 1000).toISOString().slice(0, 10)}` : ''}\n${(c.text ?? '').trim()}\n`).join('\n'));
  if (s.sidecarLyrics && (x.meta?.kind === 'video' || x.kind === 'video') && (fx.track || fx.artist || info.title)) { try { const lrc = await lyrics(fx.track ?? info.title ?? '', fx.artist ?? info.uploader ?? '', fx.album, info.duration); if (lrc) await writeText(`${at.dir}/${at.stem}.lrc`, lrc); } catch { /* none */ } }
  if (s.sidecarNfo && await writeText(`${at.dir}/${at.stem}.nfo`, nfoOf(info, x)) && raw && !s.sidecarKeepJson) await remove(infoPath); else if (!s.sidecarNfo && raw && !s.sidecarKeepJson) await remove(infoPath);
}
let on = false; const was = new Map<string, string>();
/** Watches the engine; a task that turns «done» gets its sidecars. */
export function startSidecars(): void {
  if (on) return; on = true;
  let off: (() => void) | null = null;
  const watch = () => { off?.(); const eng = getEngine(); void eng.list().then((ts) => { for (const x of ts) was.set(x.id, x.state); }).catch(() => undefined); off = eng.onChange((tasks) => { for (const x of tasks) { const prev = was.get(x.id); was.set(x.id, x.state); if (x.state === 'done' && prev && prev !== 'done') void afterDone(x); } }); };
  watch(); onEngineChange(watch);
}

/** Synced lyrics from LRCLIB (open, no key): by track, artist and album; the title split on « - » when the site gave no track. */
async function lyrics(title: string, artist: string, album?: string, duration?: number): Promise<string | null> {
  const { request } = await import('../http');
  let track = title, who = artist; const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title); if (m && !artist) { who = m[1]; track = m[2]; }
  track = track.replace(/\s*[([](official|lyrics?|audio|video|hd|4k|mv)[^)\]]*[)\]]/gi, '').trim(); if (!track) return null;
  const q = `track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(who)}${album ? `&album_name=${encodeURIComponent(album)}` : ''}${duration ? `&duration=${Math.round(duration)}` : ''}`;
  let r = await request(`https://lrclib.net/api/get?${q}`, { headers: { 'User-Agent': 'KurokawaTools (https://github.com/YoRu72/KurokawaReader)' } });
  if (r.status === 404) { const s = await request(`https://lrclib.net/api/search?q=${encodeURIComponent(`${who} ${track}`.trim())}`, { headers: { 'User-Agent': 'KurokawaTools' } }); if (s.status !== 200) return null; const list = JSON.parse(s.body) as { syncedLyrics?: string; plainLyrics?: string }[]; const hit = list.find((x) => x.syncedLyrics) ?? list[0]; return hit?.syncedLyrics ?? hit?.plainLyrics ?? null; }
  if (r.status !== 200) return null; const j = JSON.parse(r.body) as { syncedLyrics?: string; plainLyrics?: string }; return j.syncedLyrics ?? j.plainLyrics ?? null;
}
