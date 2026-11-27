// Which file of a subtitle pack (a folder or an archive of a show's subtitles) belongs to the episode being watched:
// each name read for its season and episode — SxxEyy, 2x05, «Season 2 - 05», «Episode 5», «EP05», «#05», «الحلقة 05»,
// «第5話», «- 05 -», «[05]», a lone number — after what is not an episode is taken away (resolutions, codecs, bit
// depths, CRC32s, years, audio channels), Arabic-Indic digits read as digits; ranges are batches, never one episode.
// Specials (OVA, OAD, NCOP, NCED, SP, «Specials/», S00) are read as such and never given to a normal episode.
// rankFiles() then ranks a pack's files for one episode — the number read (within the season, absolute, or with the
// shift a correction taught), the user's languages, the video's own release group and the one chosen last, .ass
// before .srt, and the cue times against the video's length — each with a score and the reason.
// Pure (no page, no storage), so tests/submatch.cjs can run it in node.

export const SUB_RE = /\.(srt|ass|ssa|vtt|sub)$/i;
export const FONT_RE = /\.(ttf|otf|ttc|woff2?)$/i;
/** How the number was read: SxxEyy-like, said as an episode («EP», «#», «第…話»), after « - », alone in brackets, or a
 *  lone number (the weakest: a guess). */
export type How = 'sxe' | 'marker' | 'dash' | 'bracket' | 'lone';
export interface SubEp { season?: number; episode?: number; end?: number; batch: boolean; /** An OVA, NCOP, NCED, SP, a «Specials» folder, S00. */ special?: boolean; how?: How }
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
  s = s.replace(/[[(]\s*[1-7]\.[01]\s*(?:ch)?\s*[\])]/gi, ' ').replace(/\b[1-7]\.[01]\s*ch\b/gi, ' ');                     // ([5.1], 2.0ch)
  s = s.replace(/\b[hx]\.?26[45]\b/gi, ' ').replace(/\b(?:hevc|avc|av1|vp9|hi10p?|xvid|divx)\b/gi, ' ');
  s = s.replace(/\b\d{3,4}\s*x\s*\d{3,4}\b/gi, ' ').replace(/\b\d{3,4}[pi]\b/gi, ' ').replace(/\b[48]k\b/gi, ' ').replace(/\b(?:8|10|12)\s*-?\s*bits?\b/gi, ' ');
  // (A dot between words is a space; one inside «5.5» stays — a single digit after it, so «05.1080» splits.)
  s = s.replace(/(?<=\d)\.(?=\d(?!\d))/g, '\u0001').replace(/\./g, ' ').replace(/\u0001/g, '.');
  return s;
}
const num = (x: string) => Number(x);

/** A subtitle file's season and episode as its name (and its folders, for the season) tell them. */
export function subEpisode(path: string): SubEp {
  const r = readEpisode(path); const parts = path.split(/[\\/]/); const base = parts.pop() ?? path;
  if (r.season === 0 || specialName(base) || parts.some((d) => /^(?:specials?|extras?|sps?|ova|oad|bonus|nc|creditless|nced|ncop|menu)$/i.test(d.trim()))) return { ...r, special: true, batch: r.batch };
  return r;
}
const SPECIAL = new RegExp(`${NB}(?:NCOP|NCED|OVA|OAD|SP|Specials?|Creditless|Preview|Trailer|Teaser|Menu|Recap|Omake)(?:\\s*\\d{1,3})?${NA}`, 'iu');
/** OP/ED said in capitals («OP1», « ED »), the other specials in any case. */
const specialName = (base: string): boolean => { const s = asciiDigits(base).replace(SUB_RE, '').replace(/[_.]/g, ' ').replace(/[[(][^\])]*[\])]/g, (x) => (/^[[(]\s*(?:NCOP|NCED|OVA|OAD|SP|OP|ED)\s*\d*\s*[\])]$/i.test(x) ? x : ' ')); return SPECIAL.test(s) || /(?<![\p{L}\p{N}])(?:OP|ED)\s*\d{0,2}(?![\p{L}])/u.test(s); };
function readEpisode(path: string): SubEp {
  const parts = path.split(/[\\/]/); const base = parts.pop() ?? path; let s = clean(base);
  let season: number | undefined;
  let how: How = 'sxe';
  const range = (a: number, b?: number): SubEp => (b !== undefined && b > a ? { season, episode: a, end: b, batch: true, how } : { season, episode: a, batch: false, how });
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
  if (m) { how = 'marker'; return range(num(m[1]), m[2] ? num(m[2]) : undefined); }
  // A range of bare numbers is a batch: «01-12», «01~12», «1~12»; «Show 2 - 05» is not one (widths differ, spaced dash).
  const rr = new RegExp(`${NB}(\\d{1,4})(\\s*)([-~～–])(\\s*)(\\d{1,4})${NA}`, 'gu');
  for (const r of s.matchAll(rr)) { const a = num(r[1]), b = num(r[5]); const tight = r[3] !== '-' && r[3] !== '–' || (!r[2] && !r[4]); if (b > a && (tight || (r[1].length === r[5].length && r[1].length >= 2))) return { season, episode: a, end: b, batch: true, how: 'dash' }; }
  // Bare numbers: years left out; the one after « - » first, then one alone in brackets, else the last.
  const cands: { n: number; i: number; dash: boolean; br: boolean }[] = [];
  for (const r of s.matchAll(new RegExp(`${NB}(?<!\\.)(\\d{1,4}(?:\\.\\d)?)(?:v\\d+)?${NA}(?!\\.\\d)`, 'gu'))) {
    const n = num(r[1]); if (/^\d{4}$/.test(r[1]) && n >= 1950 && n <= 2039) continue;
    const before = s.slice(0, r.index); const after = s.slice(r.index + r[0].length);
    cands.push({ n, i: r.index, dash: /\s[-–]\s*$/.test(before) || /^\s*[-–]\s*$/.test(before), br: /[[(]\s*$/.test(before) && /^\s*[\])]/.test(after) });
  }
  const pick = cands.find((c) => c.dash) ?? cands.find((c) => c.br) ?? cands[cands.length - 1];
  return pick ? { season, episode: pick.n, batch: false, how: pick.dash ? 'dash' : pick.br ? 'bracket' : 'lone' } : { season, batch: false };
}
export const packItems = (paths: string[]): PackItem[] => paths.filter((p) => SUB_RE.test(p)).map((path) => ({ path, ...subEpisode(path) }));

/** The pack's files for the wanted episode (every variant of it: languages, groups); empty when it has none.
 *  Exact season+episode first; names without a season count only when the pack names no other season; numbers
 *  running past the season's length are absolute, read with the offset when it is known or plain (a pack that
 *  starts after the season's length starts where the season does); the user's own shift wins over all that. */
export function matchEpisode(items: PackItem[], w: Want): PackItem[] {
  const eps = items.filter((i) => !i.batch && !i.special && i.episode !== undefined); const E = w.episode;
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
  for (const i of items) if (!i.batch && !i.special && i.episode !== undefined) seen.set(`${i.season ?? ''}:${i.episode}`, { season: i.season, episode: i.episode });
  return [...seen.values()].sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || a.episode - b.episode);
}
/** One file's «kind» in a pack — the same for every episode of one group/language (numbers and CRCs taken out). */
export const variantOf = (path: string): string => asciiDigits(path).toLowerCase().replace(/[[(]\s*[0-9a-f]{8}\s*[\])]/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const LANG_WORDS: Record<string, string[]> = { ar: ['ar', 'ara', 'arabic', 'عربي', 'العربية'], en: ['en', 'eng', 'english'], ja: ['ja', 'jpn', 'japanese'], fr: ['fr', 'fre', 'fra', 'french'], es: ['es', 'spa', 'spanish'], de: ['de', 'ger', 'deu', 'german'], pt: ['pt', 'por', 'portuguese'], it: ['it', 'ita', 'italian'], ru: ['ru', 'rus', 'russian'], zh: ['zh', 'chi', 'zho', 'chinese', 'chs', 'cht'], ko: ['ko', 'kor', 'korean'], tr: ['tr', 'tur', 'turkish'], id: ['id', 'ind', 'indonesian'] };
/** The language a name says, when it says one: a tag before the extension («.ar.ass», «.eng.forced.srt»), one in
 *  brackets («[Arabic]», «(ara)», «[AR]»), a language's name or three-letter code anywhere; a two-letter code only
 *  where a tag stands, so «It» or «De» in a title says nothing. */
export function langOfName(path: string): string | undefined {
  const base = asciiDigits(path.split(/[\\/]/).pop() ?? path).toLowerCase(); const dirs = asciiDigits(path).toLowerCase().split(/[\\/]/).slice(0, -1);
  const codeOf = (w: string, two: boolean) => { for (const [code, ws] of Object.entries(LANG_WORDS)) if (ws.some((x) => x === w && (two || x.length > 2 || /[^a-z]/.test(x)))) return code; const pre = /^([a-z]{2})-[a-z]{2,4}$/.exec(w); return pre && two && LANG_WORDS[pre[1]] ? pre[1] : undefined; };
  const tag = /\.([a-z]{2,3}(?:-[a-z]{2,4})?)(?:\.(?:forced|sdh|hi|cc|default|full|signs?))*\.(?:srt|ass|ssa|vtt|sub)$/.exec(base); if (tag) { const c = codeOf(tag[1], true); if (c) return c; }
  for (const b of base.matchAll(/[[(]([^\])]{2,24})[\])]/g)) for (const w of b[1].split(/[\s,+&_-]+/)) { const c = codeOf(w, true); if (c) return c; }
  const sc = /[_ ]([a-z]{2})(?:\.(?:srt|ass|ssa|vtt|sub))$/.exec(base); if (sc) { const c = codeOf(sc[1], true); if (c) return c; }
  for (const w of base.split(/[^\p{L}\p{N}]+/u)) { const c = codeOf(w, false); if (c) return c; }
  for (const d of dirs.reverse()) { const ws = d.split(/[^\p{L}\p{N}]+/u).filter(Boolean); for (const w of ws) { const c = codeOf(w, ws.length === 1); if (c) return c; } }
  return undefined;
}
/** The release group a name carries: «[Group] …» in front, else a scene name's «…-GROUP» at the end. */
export function groupOf(path: string): string | undefined {
  const base = (path.split(/[\\/]/).pop() ?? path).trim();
  const m = /^\s*[[(]([^\])]{1,40})[\])]/.exec(base); if (m && !/^\s*\d+\s*$/.test(m[1])) return m[1].trim().toLowerCase();
  const s = /-([A-Za-z0-9][A-Za-z0-9_]{1,24})(?:\.[a-z]{2,3}(?:-[a-z]{2,4})?)?(?:\.(?:forced|sdh|hi|cc))*\.(?:srt|ass|ssa|vtt|sub|mkv|mp4|m4v|webm|avi|ts)$/i.exec(base);
  if (s && !/^\d+$/.test(s[1]) && !/^(?:v\d|end|final|[a-z]{2,3})$/i.test(s[1])) return s[1].toLowerCase();
  return undefined;
}
/** A subtitle file's kind: its extension. */
export const kindOf = (path: string): string => (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase();
const KIND_SCORE: Record<string, number> = { ass: 3, ssa: 3, srt: 2, vtt: 1 };
/** The first and the last cue time (seconds) of a subtitle's text, SRT/VTT or ASS; undefined when it has none. */
export function cueSpan(text: string): { first: number; last: number } | undefined {
  const t: number[] = [];
  for (const m of text.matchAll(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g)) t.push(+m[1] * 3600 + +m[2] * 60 + +m[3] + +`0.${m[4]}`, +m[5] * 3600 + +m[6] * 60 + +m[7] + +`0.${m[8]}`);
  if (!t.length) for (const m of text.matchAll(/^Dialogue:\s*[^,]*,(\d+):(\d{2}):(\d{2})\.(\d{1,2}),(\d+):(\d{2}):(\d{2})\.(\d{1,2}),/gm)) t.push(+m[1] * 3600 + +m[2] * 60 + +m[3] + +`0.${m[4]}`, +m[5] * 3600 + +m[6] * 60 + +m[7] + +`0.${m[8]}`);
  return t.length ? { first: Math.min(...t), last: Math.max(...t) } : undefined;
}

/* ---------- ranking a pack's files for one episode ---------- */
/** What a correction taught, per show and source (and season): the shift of the pack's numbers, and the kind, group
 *  and language chosen. */
export interface Learned { shift?: number; variant?: string; group?: string; lang?: string; /** The episode («season:episode») whose correction taught it. */ from?: string }
export interface RankIn { path: string; /** The source (folder / archive) it is in; files are numbered per source. */ source?: string; /** First and last cue time, seconds, when read. */ first?: number; last?: number }
export interface RankCtx {
  episode: number; season?: number; /** The episode's number counted from the show's first (absolute), when known. */ absolute?: number; /** The season's length, when known. */ seasonLength?: number;
  titles?: string[]; /** The video file's own name, when there is one (its release group). */ videoName?: string; /** The video's length, seconds. */ duration?: number;
  langs?: string[]; /** The group chosen last time for this show. */ lastGroup?: string;
  /** Corrections, by `learnKey(source, season)`. */ learned?: Record<string, Learned>; /** The older per-show shift and kind. */ shift?: number; filter?: string;
}
export type Basis = 'exact' | 'learned' | 'absolute' | 'number';
export type Plus = 'variant' | 'lang' | 'group' | 'lastGroup' | 'kind' | 'span' | 'title';
export interface Ranked<T extends RankIn = RankIn> { file: T; score: number; basis: Basis; plus: Plus[]; minus: ('lang' | 'span')[]; ep: SubEp; guess: boolean }
export const learnKey = (source: string | undefined, season: number | undefined) => `${source ?? ''}|${season ?? ''}`;
const normT = (x: string) => asciiDigits(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The pack's files that can be the episode, best first, each with its score and why. Batches and specials never;
 *  files are numbered per source (two groups' folders each count from their own first). Low confidence (`guess`): the
 *  number was a lone one, or the absolute numbering was inferred, or the top two tie. */
export function rankFiles<T extends RankIn>(files: T[], c: RankCtx): Ranked<T>[] {
  const langs = c.langs ?? []; const vg = c.videoName ? groupOf(c.videoName) : undefined;
  const bySrc = new Map<string, { f: T; ep: SubEp }[]>();
  for (const f of files) { if (!SUB_RE.test(f.path)) continue; const ep = subEpisode(f.path); const k = f.source ?? ''; if (!bySrc.has(k)) bySrc.set(k, []); bySrc.get(k)!.push({ f, ep }); }
  const out: Ranked<T>[] = [];
  for (const [srcKey, items] of bySrc) {
    const L = c.learned?.[learnKey(srcKey, c.season)] ?? c.learned?.[learnKey(srcKey, undefined)];
    const shift = L?.shift ?? c.shift;
    const eps = items.filter((i) => !i.ep.batch && !i.ep.special && i.ep.episode !== undefined);
    const seasons = new Set(eps.filter((i) => i.ep.season !== undefined).map((i) => i.ep.season!));
    const S = c.season ?? (seasons.size > 1 ? 1 : undefined); const E = c.episode;
    const inSeason = S === undefined ? eps : eps.filter((i) => i.ep.season === S || (i.ep.season === undefined && ![...seasons].some((x) => x !== S)));
    const bare = inSeason.filter((i) => i.ep.season === undefined || S === undefined);
    let hits: typeof eps = []; let basis: Basis = 'number'; let inferred = false;
    if (shift) { hits = inSeason.filter((i) => i.ep.episode === E + shift); basis = 'learned'; }
    if (!hits.length && S !== undefined) { hits = eps.filter((i) => i.ep.season === S && i.ep.episode === E); basis = 'exact'; }
    if (!hits.length && bare.length) {
      const ns = bare.map((i) => i.ep.episode!); const max = Math.max(...ns), min = Math.min(...ns);
      const A = c.absolute !== undefined && c.absolute !== E ? c.absolute : undefined;
      const len = c.seasonLength;
      // (Numbers running past the season are absolute: with the episode's absolute number when told, else from where
      // the pack starts when it starts past the season.)
      const past = len !== undefined ? max > len : A !== undefined && max >= A;
      if (A !== undefined && (past || !bare.some((i) => i.ep.episode === E))) { hits = bare.filter((i) => i.ep.episode === A); basis = 'absolute'; }
      if (!hits.length && len !== undefined && max > len && A === undefined && min > len) { hits = bare.filter((i) => i.ep.episode === E + min - 1); basis = 'absolute'; inferred = true; }
      if (!hits.length) { hits = bare.filter((i) => i.ep.episode === E); basis = 'number'; }
    }
    for (const { f, ep } of hits) {
      const plus: Plus[] = []; const minus: ('lang' | 'span')[] = [];
      let sc = basis === 'exact' ? 100 : basis === 'learned' ? 98 : basis === 'absolute' ? 92 : 90;
      if (ep.how === 'lone') sc -= 8;
      const v = variantOf(f.path); const wantV = L?.variant ?? c.filter;
      if (wantV && v === wantV) { sc += 40; plus.push('variant'); }
      const l = langOfName(f.path); const li = l ? langs.indexOf(l) : -1;
      if (L?.lang && l === L.lang) { sc += 12; plus.push('lang'); } else if (li >= 0) { sc += Math.max(5, 20 - 5 * li); plus.push('lang'); } else if (l && langs.length) { sc -= 10; minus.push('lang'); }
      const g = groupOf(f.path);
      if (g && vg && g === vg) { sc += 10; plus.push('group'); }
      if (g && (L?.group ?? c.lastGroup) && g === (L?.group ?? c.lastGroup)) { sc += 6; plus.push('lastGroup'); }
      const k = KIND_SCORE[kindOf(f.path)] ?? 0; if (k) { sc += k; if (k === 3) plus.push('kind'); }
      if (c.titles?.length) { const n = normT(f.path.split(/[\\/]/).pop() ?? f.path); if (c.titles.some((x) => { const tt = normT(x); return tt.length > 1 && n.includes(tt); })) { sc += 2; plus.push('title'); } }
      if (c.duration && c.duration > 60 && f.last !== undefined) {
        const d = f.last - c.duration;
        if (d > Math.max(120, c.duration * 0.1) || f.last < c.duration * 0.6) { sc -= 25; minus.push('span'); }
        else if (Math.abs(d) <= Math.max(90, c.duration * 0.08)) { sc += 4; plus.push('span'); }
      }
      if (/(?<![a-z])v([2-9])(?![a-z0-9])/i.test(f.path)) sc += 1;
      out.push({ file: f, score: sc, basis, plus, minus, ep, guess: ep.how === 'lone' || inferred });
    }
  }
  out.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path, undefined, { numeric: true }));
  if (out.length > 1 && out[0].score === out[1].score && variantOf(out[0].file.path) !== variantOf(out[1].file.path)) out[0] = { ...out[0], guess: true };
  return out;
}
/** What choosing `chosen` by hand for the episode teaches: the shift of its source's numbers (none when it is the
 *  number already, or a batch, a special, another season), and its kind, group and language. */
export function learnCorrection(chosen: RankIn, c: RankCtx): Learned {
  const ep = subEpisode(chosen.path); const out: Learned = { variant: variantOf(chosen.path) };
  const g = groupOf(chosen.path); if (g) out.group = g; const l = langOfName(chosen.path); if (l) out.lang = l;
  if (!ep.batch && !ep.special && ep.episode !== undefined && Number.isInteger(ep.episode) && (ep.season === undefined || c.season === undefined || ep.season === c.season)) {
    const d = ep.episode - c.episode; if (d !== 0 && !(c.absolute !== undefined && ep.episode === c.absolute)) out.shift = d;
  }
  return out;
}
/** The candidate to load: the kind chosen before for this show, else the preferred languages, ASS before SRT. */
export function pickCandidate<T extends { path: string }>(cands: T[], filter: string | undefined, langs: string[]): T | undefined {
  if (!cands.length) return undefined;
  if (filter) { const same = cands.find((c) => variantOf(c.path) === filter); if (same) return same; }
  const li = (c: T) => { const l = langOfName(c.path); const i = l ? langs.indexOf(l) : -1; return i < 0 ? 99 : i; };
  return [...cands].sort((a, b) => li(a) - li(b) || Number(!/\.ass$/i.test(a.path)) - Number(!/\.ass$/i.test(b.path)) || a.path.localeCompare(b.path, undefined, { numeric: true }))[0];
}
