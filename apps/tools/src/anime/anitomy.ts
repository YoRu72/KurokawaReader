// Release names taken apart the anitomy way, enough for matching torrents to episodes: the group in the leading
// brackets, the resolution, the episode number (or a range for a batch), the season, the title that is left.
export interface Parsed { title: string; episode?: number; episodeEnd?: number; season?: number; resolution?: string; group?: string; batch: boolean; year?: number; terms: string[] }

const RES = /\b(2160p|1080p|720p|540p|480p|4k|\d{3,4}x(\d{3,4}))\b/i;
const KEYWORDS = /\b(x264|x265|h\.?264|h\.?265|hevc|avc|aac|flac|opus|ac3|eac3|dts|10.?bit|8.?bit|hi10p?|bd|bdrip|bluray|blu-ray|web(?:-?dl|rip)?|hdtv|dvd(?:rip)?|dual.?audio|multi.?sub(?:s)?|uncensored|batch|complete|remux|hdr|dv|raw|english|japanese|subbed|dubbed|dub|sub|v\d)\b/gi;

export function parseFilename(name: string): Parsed {
  let s = name.replace(/\.(mkv|mp4|avi|webm|ts|torrent)$/i, '').replace(/_/g, ' ');
  const terms: string[] = [];
  let group: string | undefined;
  const g = /^\s*\[([^\]]+)\]/.exec(s); if (g) { group = g[1].trim(); s = s.slice(g[0].length); }
  const brackets: string[] = []; for (let i = 0; i < 4; i++) { const before = s; s = s.replace(/[\[(]([^\[\]()]*)[\])]/g, (_m, inner: string) => { brackets.push(inner); return ' '; }); if (s === before) break; } s = s.replace(/[\[\]()]/g, ' ');
  const whole = `${s} ${brackets.join(' ')}`;
  let resolution: string | undefined;
  for (const b of [s, ...brackets]) { const m = RES.exec(b); if (m) { resolution = m[2] ? `${m[2]}p` : m[1].toLowerCase() === '4k' ? '2160p' : m[1].toLowerCase(); break; } }
  s = s.replace(RES, ' ');
  for (const b of brackets) for (const k of b.match(KEYWORDS) ?? []) terms.push(k.toLowerCase());
  const batch = /\b(batch|complete|season \d|s\d{1,2}\s*$|\d{1,3}\s*[-~]\s*\d{1,3})\b/i.test(whole) && !/\bs\d{1,2}\s*e\d{1,3}\b/i.test(whole);
  let episode: number | undefined, episodeEnd: number | undefined, season: number | undefined, year: number | undefined;
  const yr = /\b(19[89]\d|20[0-4]\d)\b/.exec(s); if (yr) year = Number(yr[1]);
  const se = /\bS(\d{1,2})\s*E(\d{1,3}(?:\.\d)?)(?:\s*[-~]\s*E?(\d{1,3}))?\b/i.exec(s);
  if (se) { season = Number(se[1]); episode = Number(se[2]); if (se[3]) episodeEnd = Number(se[3]); s = s.slice(0, se.index); }
  else {
    const sn = /\b(?:S(\d{1,2})|Season\s*(\d{1,2})|(\d{1,2})(?:nd|rd|th)\s+Season)\b/i.exec(whole); if (sn) season = Number(sn[1] ?? sn[2] ?? sn[3]);
    for (const b of brackets) { const r = /^\s*(\d{1,4})\s*[-~]\s*(\d{1,4})\s*$/.exec(b); if (r) { episode = Number(r[1]); episodeEnd = Number(r[2]); } }
    const range = /\s[-–]\s*(\d{1,4})\s*[-~]\s*(\d{1,4})\b/.exec(s) ?? /\b(\d{1,3})\s*[-~]\s*(\d{1,3})\b(?!p)/.exec(s);
    const ep = /\s[-–]\s*(?:E|EP|Episode)?\s*(\d{1,4}(?:\.5)?)(?:v\d)?\b(?!p|x|\s*[-~]\s*\d)/i.exec(s) ?? /\b(?:E|EP|Episode)\s*(\d{1,4}(?:\.5)?)\b/i.exec(s) ?? /\s(\d{2,4}(?:\.5)?)(?:v\d)?\s*$/.exec(s.trim() + ' ') ?? /\s(\d{2,4})(?:v\d)?\s+(?=[\[(]|$)/.exec(s);
    if (episodeEnd !== undefined) { /* a range in brackets */ }
    else if (range && (!ep || range.index <= ep.index)) { episode = Number(range[1]); episodeEnd = Number(range[2]); s = s.slice(0, range.index); }
    else if (ep) { episode = Number(ep[1]); s = s.slice(0, ep.index); }
  }
  s = s.replace(KEYWORDS, ' ').replace(/\s[-–]\s*$/, '').replace(/\s+/g, ' ').trim();
  if (season === undefined) { const t = /\s(\d)(?:nd|rd|th)?\s*(?:season)?$/i.exec(s); if (t && Number(t[1]) <= 9 && /season/i.test(t[0])) { season = Number(t[1]); s = s.slice(0, t.index).trim(); } }
  return { title: s, episode, episodeEnd, season, resolution, group, batch: batch || episodeEnd !== undefined, year, terms };
}
/** Does a torrent's name belong to this episode of this show (or a batch holding it)? */
export function matchesEpisode(p: Parsed, episode: number): boolean {
  if (p.episodeEnd !== undefined && p.episode !== undefined) return episode >= p.episode && episode <= p.episodeEnd;
  if (p.episode !== undefined) return p.episode === episode;
  return p.batch;
}
export function similar(a: string, b: string): number {
  const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const x = n(a), y = n(b); if (!x || !y) return 0; if (x === y) return 1;
  const bi = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = bi(x), B = bi(y); let hit = 0; for (const [k, v] of A) hit += Math.min(v, B.get(k) ?? 0);
  return (2 * hit) / (x.length - 1 + y.length - 1);
}
