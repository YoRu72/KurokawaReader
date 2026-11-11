// Which file of a subtitle pack (a folder or an archive of a show's subtitles) belongs to the episode being watched:
// each name read for its season and episode — SxxEyy, 2x05, «Season 2 - 05», «Episode 5», «EP05», «#05», «الحلقة 05»,
// «第5話», «- 05 -», «[05]», a lone number — after what is not an episode is taken away (resolutions, codecs, bit
// depths, CRC32s, years, audio channels), Arabic-Indic digits read as digits; ranges are batches, never one episode.
// Pure (no page, no storage), so tests/submatch.cjs can run it in node.

export const SUB_RE = /\.(srt|ass|ssa|vtt|sub)$/i;
export const FONT_RE = /\.(ttf|otf|ttc|woff2?)$/i;
export interface SubEp { season?: number; episode?: number; end?: number; batch: boolean }
export interface PackItem extends SubEp { path: string }
export interface Want { episode: number; season?: number; /** The season's (or the show's) episode count, when known. */ seasonLength?: number; /** Episodes of the seasons before this one (absolute numbering), when known. */ offset?: number; /** A shift the user set for this pack: file number = episode + shift. */ shift?: number }

const NB = '(?<![\\p{L}\\p{N}])'; const NA = '(?![\\p{L}\\p{N}])';
/** ٠١٢ and ۰۱۲ as 012. */
export const asciiDigits = (s: string): string => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
const SEASON_ONLY = new RegExp(`${NB}(?:S|Season\\s*|الموسم\\s*)0*(\\d{1,2})${NA}|${NB}(\\d{1,2})(?:st|nd|rd|th)\\s+Season${NA}`, 'iu');

/** Takes away from a name what is never an episode number. */
function clean(name: string): string {
  let s = asciiDigits(name).replace(SUB_RE, '').replace(/_/g, ' ');
  s = s.replace(/[[(]\s*[0-9a-f]{8}\s*[\])]/gi, ' ');                                                    // (CRC32)
  s = s.replace(/\b(?:ddp?|e?ac-?3|aac|dts(?:-hd)?|truehd|flac|opus|mp3|atmos)\s*\d?(?:\.\d)?\b/gi, ' ');  // (audio, with its channels)
  s = s.replace(/\b[hx]\.?26[45]\b/gi, ' ').replace(/\b(?:hevc|avc|av1|vp9|hi10p?|xvid|divx)\b/gi, ' ');
  s = s.replace(/\b\d{3,4}\s*x\s*\d{3,4}\b/gi, ' ').replace(/\b\d{3,4}[pi]\b/gi, ' ').replace(/\b[48]k\b/gi, ' ').replace(/\b(?:8|10|12)\s*-?\s*bits?\b/gi, ' ');
  // (A dot between words is a space; one inside «5.5» stays — a single digit after it, so «05.1080» splits.)
  s = s.replace(/(?<=\d)\.(?=\d(?!\d))/g, '\u0001').replace(/\./g, ' ').replace(/\u0001/g, '.');
  return s;
}
const num = (x: string) => Number(x);

/** A subtitle file's season and episode as its name (and its folders, for the season) tell them. */
export function subEpisode(path: string): SubEp {
  const parts = path.split(/[\\/]/); const base = parts.pop() ?? path; let s = clean(base);
  let season: number | undefined;
  const range = (a: number, b?: number): SubEp => (b !== undefined && b > a ? { season, episode: a, end: b, batch: true } : { season, episode: a, batch: false });
  // S02E05 (S02E05-E06 a range), 2x05, «Season 2 - 05» / «الموسم 2 الحلقة 5».
  let m = new RegExp(`${NB}S(\\d{1,2})\\s*[ -]?\\s*E(\\d{1,4}(?:\\.\\d)?)(?:v\\d+)?(?:\\s*[-~]\\s*E?(\\d{1,4}))?(?!\\d)`, 'iu').exec(s);
  if (m) { season = num(m[1]); return range(num(m[2]), m[3] ? num(m[3]) : undefined); }
  m = new RegExp(`${NB}(\\d{1,2})x(\\d{2,3})(?:v\\d+)?${NA}`, 'iu').exec(s); if (m) { season = num(m[1]); return range(num(m[2])); }
  m = new RegExp(`${NB}(?:Season|الموسم)\\s*0*(\\d{1,2})[\\s\\-–:,]*(?:(?:Episode|Ep\\.?|E|الحلقة|حلقة)\\s*)?(\\d{1,4}(?:\\.\\d)?)(?:v\\d+)?(?:\\s*[-~]\\s*(\\d{1,4}))?(?!\\d)`, 'iu').exec(s);
  if (m) { season = num(m[1]); return range(num(m[2]), m[3] ? num(m[3]) : undefined); }
  // A season said alone («S2», «2nd Season», a «Season 2» folder): a season, never an episode.
  m = SEASON_ONLY.exec(s); if (m) { season = num(m[1] ?? m[2]); s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); }
  else for (const d of parts.reverse()) { const dm = SEASON_ONLY.exec(asciiDigits(d)); if (dm) { season = num(dm[1] ?? dm[2]); break; } }
  // Said as an episode: «Episode 5», «EP05», «E05», «#05», «الحلقة 05», «ح5», «第5話».
  m = new RegExp(`${NB}(?:Episode|Ep\\.?|E|الحلقة|حلقة|ح|#)\\s*(\\d{1,4}(?:\\.\\d)?)(?:v\\d+)?(?:\\s*[-~]\\s*(?:E|EP)?\\s*(\\d{1,4}))?(?![\\p{L}\\p{N}]|\\.\\d)`, 'iu').exec(s) ?? /第\s*(\d{1,4})\s*[話话集回]/u.exec(s);
  if (m) return range(num(m[1]), m[2] ? num(m[2]) : undefined);
  // A range of bare numbers is a batch: «01-12», «01~12», «1~12»; «Show 2 - 05» is not one (widths differ, spaced dash).
  const rr = new RegExp(`${NB}(\\d{1,4})(\\s*)([-~～–])(\\s*)(\\d{1,4})${NA}`, 'gu');
  for (const r of s.matchAll(rr)) { const a = num(r[1]), b = num(r[5]); const tight = r[3] !== '-' && r[3] !== '–' || (!r[2] && !r[4]); if (b > a && (tight || (r[1].length === r[5].length && r[1].length >= 2))) return { season, episode: a, end: b, batch: true }; }
  // Bare numbers: years left out; the one after « - » first, then one alone in brackets, else the last.
  const cands: { n: number; i: number; dash: boolean; br: boolean }[] = [];
  for (const r of s.matchAll(new RegExp(`${NB}(?<!\\.)(\\d{1,4}(?:\\.\\d)?)(?:v\\d+)?${NA}(?!\\.\\d)`, 'gu'))) {
    const n = num(r[1]); if (/^\d{4}$/.test(r[1]) && n >= 1950 && n <= 2039) continue;
    const before = s.slice(0, r.index); const after = s.slice(r.index + r[0].length);
    cands.push({ n, i: r.index, dash: /\s[-–]\s*$/.test(before) || /^\s*[-–]\s*$/.test(before), br: /[[(]\s*$/.test(before) && /^\s*[\])]/.test(after) });
  }
  const pick = cands.find((c) => c.dash) ?? cands.find((c) => c.br) ?? cands[cands.length - 1];
  return pick ? { season, episode: pick.n, batch: false } : { season, batch: false };
}
export const packItems = (paths: string[]): PackItem[] => paths.filter((p) => SUB_RE.test(p)).map((path) => ({ path, ...subEpisode(path) }));

/** The pack's files for the wanted episode (every variant of it: languages, groups); empty when it has none.
 *  Exact season+episode first; names without a season count only when the pack names no other season; numbers
 *  running past the season's length are absolute, read with the offset when it is known or plain (a pack that
 *  starts after the season's length starts where the season does); the user's own shift wins over all that. */
export function matchEpisode(items: PackItem[], w: Want): PackItem[] {
  const eps = items.filter((i) => !i.batch && i.episode !== undefined); const E = w.episode;
  const seasons = new Set(eps.filter((i) => i.season !== undefined).map((i) => i.season!));
  const S = w.season ?? (seasons.size > 1 ? 1 : undefined);
  const inSeason = S === undefined ? eps : eps.filter((i) => i.season === S || (i.season === undefined && ![...seasons].some((x) => x !== S)));
  if (w.shift) return inSeason.filter((i) => i.episode === E + w.shift!);
  if (S !== undefined) { const exact = eps.filter((i) => i.season === S && i.episode === E); if (exact.length) return exact; }
  const bare = inSeason.filter((i) => i.season === undefined || S === undefined);
  if (!bare.length) return [];
  const ns = bare.map((i) => i.episode!); const max = Math.max(...ns), min = Math.min(...ns);
  if (w.seasonLength && max > w.seasonLength) {
    const off = w.offset ?? (min > w.seasonLength ? min - 1 : undefined);
    if (off !== undefined) return bare.filter((i) => i.episode === E + off);
  }
  return bare.filter((i) => i.episode === E);
}
/** A file the user chose by hand for an episode: the shift it implies for the rest (null when none, or not one number). */
export function impliedShift(item: SubEp, w: Want): number | null {
  if (item.batch || item.episode === undefined || !Number.isInteger(item.episode)) return null;
  if (item.season !== undefined && w.season !== undefined && item.season !== w.season) return null;
  const d = item.episode - w.episode; return d === 0 ? null : d;
}
/** The episodes a pack covers, as «season:episode» (season blank when not named), sorted. */
export function covered(items: PackItem[]): { season?: number; episode: number }[] {
  const seen = new Map<string, { season?: number; episode: number }>();
  for (const i of items) if (!i.batch && i.episode !== undefined) seen.set(`${i.season ?? ''}:${i.episode}`, { season: i.season, episode: i.episode });
  return [...seen.values()].sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || a.episode - b.episode);
}
/** One file's «kind» in a pack — the same for every episode of one group/language (numbers and CRCs taken out). */
export const variantOf = (path: string): string => asciiDigits(path).toLowerCase().replace(/[[(]\s*[0-9a-f]{8}\s*[\])]/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const LANG_WORDS: Record<string, string[]> = { ar: ['ar', 'ara', 'arabic', 'عربي', 'العربية'], en: ['en', 'eng', 'english'], ja: ['ja', 'jpn', 'japanese'], fr: ['fr', 'fre', 'fra', 'french'], es: ['es', 'spa', 'spanish'], de: ['de', 'ger', 'deu', 'german'], pt: ['pt', 'por', 'portuguese'], it: ['it', 'ita', 'italian'], ru: ['ru', 'rus', 'russian'], zh: ['zh', 'chi', 'zho', 'chinese', 'chs', 'cht'], ko: ['ko', 'kor', 'korean'], tr: ['tr', 'tur', 'turkish'], id: ['id', 'ind', 'indonesian'] };
/** The language a name says, when it says one. */
export function langOfName(path: string): string | undefined {
  const words = asciiDigits(path).toLowerCase().split(/[^\p{L}\p{N}]+/u);
  for (const [code, ws] of Object.entries(LANG_WORDS)) if (ws.some((w) => words.includes(w))) return code;
  return undefined;
}
/** The candidate to load: the kind chosen before for this show, else the preferred languages, ASS before SRT. */
export function pickCandidate<T extends { path: string }>(cands: T[], filter: string | undefined, langs: string[]): T | undefined {
  if (!cands.length) return undefined;
  if (filter) { const same = cands.find((c) => variantOf(c.path) === filter); if (same) return same; }
  const li = (c: T) => { const l = langOfName(c.path); const i = l ? langs.indexOf(l) : -1; return i < 0 ? 99 : i; };
  return [...cands].sort((a, b) => li(a) - li(b) || Number(!/\.ass$/i.test(a.path)) - Number(!/\.ass$/i.test(b.path)) || a.path.localeCompare(b.path, undefined, { numeric: true }))[0];
}
