// Torrentio (the Stremio add-on's open API): a film's or an episode's torrents from the sites it reads — the
// providers, order, qualities left out and language put first as the user sets them (its own configuration
// string); with a debrid key (the Debrid add-on's), links come back resolved to direct downloads. Each result
// names the one file it means in a season pack, so only that file is downloaded.
import { request } from '../http';
import { getSettings } from '../settings';
import { parseFilename } from '../anime/anitomy';
import type { TorrentResult } from '../anime/providers';
import type { TvKind } from './cinemeta';

export const PROVIDERS: [string, string][] = [['yts', 'YTS'], ['eztv', 'EZTV'], ['rarbg', 'RARBG'], ['1337x', '1337x'], ['thepiratebay', 'The Pirate Bay'], ['kickasstorrents', 'KickassTorrents'], ['torrentgalaxy', 'TorrentGalaxy'], ['magnetdl', 'MagnetDL'], ['horriblesubs', 'HorribleSubs'], ['nyaasi', 'Nyaa'], ['tokyotosho', 'TokyoTosho'], ['anidex', 'AniDex'], ['nekobt', 'nekoBT'], ['rutor', 'Rutor'], ['rutracker', 'Rutracker'], ['comando', 'Comando'], ['bludv', 'BluDV'], ['torrent9', 'Torrent9'], ['ilcorsaronero', 'ilCorSaRoNeRo'], ['mejortorrent', 'MejorTorrent'], ['wolfmax4k', 'Wolfmax4k'], ['cinecalidad', 'Cinecalidad'], ['besttorrents', 'BestTorrents']];
export const DEFAULT_PROVIDERS = ['yts', 'eztv', 'rarbg', '1337x', 'thepiratebay', 'kickasstorrents', 'torrentgalaxy', 'magnetdl'];
export const QUALITY_OUT: [string, string][] = [['4k', '4K'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p'], ['scr', 'Screener'], ['cam', 'CAM'], ['unknown', '?'], ['brremux', 'BluRay REMUX'], ['hdrall', 'HDR'], ['dolbyvision', 'Dolby Vision'], ['threed', '3D']];
export interface TvPrefs { providers: string[]; sort: 'quality' | 'qualitysize' | 'seeders' | 'size'; qualityOut: string[]; language: string; quality: '' | '2160' | '1080' | '720' | '480'; lookup: 'quality' | 'size' | 'seeders'; custom: string; debrid: boolean }
export const TV_DEFAULT: TvPrefs = { providers: DEFAULT_PROVIDERS, sort: 'qualitysize', qualityOut: ['scr', 'cam', 'unknown', 'threed'], language: '', quality: '1080', lookup: 'quality', custom: '', debrid: true };
export const tvPrefs = (): TvPrefs => ({ ...TV_DEFAULT, ...(getSettings().tv ?? {}) });

/** Torrentio's configuration string, as its configure page writes it. */
export async function configString(p = tvPrefs()): Promise<string> {
  if (p.custom.trim()) return p.custom.trim().replace(/^https?:\/\/[^/]+\//, '').replace(/\/manifest\.json$/, '');
  const parts = [`providers=${p.providers.join(',')}`, `sort=${p.sort}`];
  if (p.qualityOut.length) parts.push(`qualityfilter=${p.qualityOut.join(',')}`);
  if (p.language) parts.push(`language=${p.language}`);
  if (p.debrid && getSettings().addons.includes('debrid')) {
    try { const { loadIndex, addonSettings } = await import('../addons'); const e = (await loadIndex()).addons.find((a) => a.id === 'debrid'); if (e) { const s = addonSettings(e); const order = [String(s.preferred ?? ''), 'realdebrid', 'alldebrid', 'premiumize', 'torbox']; for (const id of order) { const k = String(s[`${id}Key`] ?? '').trim(); if (id && k) { parts.push(`${id}=${k}`); break; } } } } catch { /* none */ }
  }
  return parts.join('|');
}

const HEX = /^[0-9a-f]{40}$/;
type Stream = { name?: string; title?: string; description?: string; infoHash?: string; fileIdx?: number; url?: string; sources?: string[]; behaviorHints?: { filename?: string; videoSize?: number; bingeGroup?: string } };
export interface TvRelease extends TorrentResult { file?: string; packSize?: number; languages?: string; cached?: boolean }
export function parseStream(st: Stream): TvRelease | null {
  const text = st.title || st.description || ''; const lines = text.split('\n');
  const head = (lines[0] ?? '').trim(); const file = st.behaviorHints?.filename || (lines.length > 2 ? lines[1].split('/').pop()?.trim() : undefined);
  const info = lines.find((l) => /👤|💾|⚙️/.test(l)) ?? '';
  const seeds = Number(/👤\s*(\d+)/.exec(info)?.[1]) || 0; const sz = /💾\s*([\d.]+)\s*(TB|GB|MB|KB)/.exec(info);
  const packSize = sz ? Math.round(Number(sz[1]) * ({ TB: 1099511627776, GB: 1073741824, MB: 1048576, KB: 1024 } as Record<string, number>)[sz[2]]) : 0;
  const provider = /⚙️\s*(.+)$/.exec(info)?.[1]?.trim() ?? 'Torrentio';
  const hash = (st.infoHash ?? '').toLowerCase(); if (!HEX.test(hash) && !st.url) return null;
  const title = head || file || ''; if (!title) return null;
  const res = /\b(2160p|4k|1440p|1080p|720p|576p|480p)\b/i.exec(`${st.name ?? ''} ${title} ${file ?? ''}`)?.[1]?.toLowerCase().replace('4k', '2160p');
  const trackers = (st.sources ?? []).filter((x) => x.startsWith('tracker:')).map((x) => `&tr=${encodeURIComponent(x.slice(8))}`).join('');
  const langs = lines.slice(1).find((l) => /[\u{1F1E6}-\u{1F1FF}]/u.test(l) && !/👤|💾/.test(l));
  const p = parseFilename(file ?? title);
  return { title, file, link: hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}` : st.url!, hash, size: st.behaviorHints?.videoSize || packSize, packSize, seeders: seeds, leechers: 0, downloads: 0,
    accuracy: 'high', provider, resolution: res, group: p.group, fileIdx: st.fileIdx, url: st.url, languages: langs, cached: !!st.url || /\[(RD|AD|PM|TB|DL|OC|PIO|ED|HL)\+\]/.test(st.name ?? '') };
}
/** A film's (`tt…`) or an episode's (`tt…:season:episode`) releases. */
export async function streams(type: TvKind, id: string): Promise<TvRelease[]> {
  const cfg = await configString();
  const r = await request(`https://torrentio.strem.fun/${cfg}/stream/${type}/${id}.json`);
  if (r.status !== 200) throw new Error(`Torrentio: HTTP ${r.status}`);
  return ((JSON.parse(r.body) as { streams?: Stream[] }).streams ?? []).map(parseStream).filter((x): x is TvRelease => !!x);
}
/** The release to use: the wanted quality first (else the nearest below, else any), then the lookup preference. */
export function bestOf(rs: TvRelease[], p = tvPrefs()): TvRelease | null {
  if (!rs.length) return null;
  const order = ['2160p', '1440p', '1080p', '720p', '576p', '480p'];
  const want = p.quality ? `${p.quality}p` : ''; const wi = want ? order.indexOf(want) : 0;
  const ok = (r: TvRelease) => r.seeders > 0 || r.cached || !!r.url;
  // (torrentplayer's rules: a camera copy, telesync or screener is never the pick while an honest release is there;
  // one or two seeders count as fragile — one leaving stalls playback — so a better-seeded one goes first.)
  const cam = (r: TvRelease) => /(^|[\s._\-[(])(cam|camrip|hdcam|ts|telesync|hdts|tc|telecine|scr|screener|dvdscr)(?=[\s._\-\])]|$)/i.test(r.title) && /\b(19|20)\d{2}\b|\b\d{3,4}p\b|x26[45]|hevc/i.test(r.title);
  const honest = rs.filter((r) => !cam(r)); const rs2 = honest.length ? honest : rs;
  const steady = rs2.filter((r) => ok(r) && (r.seeders >= 3 || r.cached || !!r.url));
  const live = steady.length ? steady : rs2.filter(ok); const pool = live.length ? live : rs2;
  let cands = want ? pool.filter((r) => r.resolution === want) : pool;
  for (let i = wi + 1; !cands.length && i < order.length; i++) cands = pool.filter((r) => r.resolution === order[i]);
  if (!cands.length) cands = pool;
  const by = p.lookup === 'size' ? (a: TvRelease, b: TvRelease) => a.size - b.size : p.lookup === 'seeders' ? (a: TvRelease, b: TvRelease) => b.seeders - a.seeders : (a: TvRelease, b: TvRelease) => Number(!!b.cached) - Number(!!a.cached) || b.seeders - a.seeders;
  return [...cands].sort(by)[0];
}
