// Turning the pieces of text a PDF exposes into readable lines — shared by copying from the
// PDF viewer and by PDF → DOCX/EPUB conversion.
//
// A piece is a run of text with its horizontal extent; pieces on one line are put in reading
// order by where they start (their origin), not where the browser's fallback font says they end.
// Word breaks come from the PDF's own drawn spaces when it marks them (U+2009, see
// scripts/patch-pdfjs.mjs), otherwise from the gaps between pieces.

export type LinePiece = { text: string; l: number; r: number; h: number; keep?: boolean };

const RTL_CHAR_G = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
// Arabic harakat, shadda, sukun, superscript alef, Quranic marks; Hebrew points.
export const COMBINING = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0591-\u05C7]/;

/** A virama (the mark that joins Indic consonants into a conjunct): a piece ending in one has not ended its
 *  word, whatever the gap after it — the conjunct's own glyph is wider than the advance the PDF gave it. */
export const VIRAMA_END = /[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D4D\u0DCA\u0E3A\u1039\u1B44\uA9C0]$/;

/** Control characters (glyphs with no Unicode) are not text. */
export function cleanPdfText(s: string): string {
  // (A kasratan never stands before an alef: a font's map that says so meant the fathatan of «ـًا».)
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\u200B]/g, '').replace(/\u00A0/g, ' ').replace(/\u064D(?=\u0627)/g, '\u064B');
}

export function isRtlText(s: string): boolean {
  return (s.match(RTL_CHAR_G) ?? []).length > (s.match(/[A-Za-z\u00C0-\u024F]/g) ?? []).length;
}

/** Punctuation alone (no letters, no digits) — a closing quote and the comma after it, "،»" — comes from
 *  pdf.js in drawing order; on a right-to-left line it reads the other way round ("»،"). */
export function logicalNeutral(s: string, rtlLine: boolean): string {
  if (!rtlLine || [...s.trim()].length < 2 || /[\p{L}\p{N}]/u.test(s)) return s;
  return [...s].reverse().join('');
}

/** A drawn space lying inside a word's own box (a writer that draws the space and then sets the word back
 *  over it) separates nothing: such markers go. `isSpace` tells the markers. */
export function dropBuriedSpaces<T extends { l: number; r: number; text: string }>(line: T[], isSpace: (p: T) => boolean): T[] {
  const words = line.filter((p) => !isSpace(p) && p.text.trim());
  return line.filter((p) => !isSpace(p) || !words.some((q) => Math.min(q.r, p.r) - Math.max(q.l, p.l) > (p.r - p.l) * 0.5));
}

/** Inside one piece, a bracket type written one way only ("[النور: ٤٥[" — a PDF that names both by one
 *  glyph) is made to pair up: opening, closing, opening… */
export function balanceBrackets(text: string): string {
  if (!BRACKET_CHAR.test(text)) return text;
  let out = text;
  // A bracket named by its shape in a font set for right-to-left text comes out mirrored: a word that begins
  // with a closing bracket (")فقه") or ends with an opening one ("اللغة(") is turned the right way round.
  const OPEN = '([{«﴿', CLOSE = ')]}»﴾';
  const ci = CLOSE.indexOf(out[0]); if (ci >= 0 && !out.includes(OPEN[ci])) out = OPEN[ci] + out.slice(1);
  const oi = OPEN.indexOf(out[out.length - 1]); if (oi >= 0 && !out.includes(CLOSE[oi])) out = out.slice(0, -1) + CLOSE[oi];
  for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}'], ['«', '»']]) {
    const no = [...out].filter((x) => x === o).length, nc = [...out].filter((x) => x === c).length;
    if (no + nc < 2 || (no && nc)) continue;
    let k = 0; out = [...out].map((x) => (x === o || x === c ? (k++ % 2 ? c : o) : x)).join('');
  }
  return out;
}

/**
 * Brackets inside the words of a right-to-left line, turned the right way as the line is read: a font set for
 * Arabic names a bracket by its mirrored shape, so what counts is where it stands — a bracket that begins a
 * word, or comes while none is open, opens; one that ends a word, or comes while one is open, closes. A piece
 * that is nothing but a bracket was settled by its neighbours already and only moves the count.
 */
const BRACKET_CHAR = /[()[\]{}«»﴾﴿]/;
export function orientBrackets(text: string, depth: { n: number }): string {
  if (!BRACKET_CHAR.test(text)) return text;
  const OPEN = '([{«﴿', CLOSE = ')]}»﴾';
  const chars = [...text];
  const lone = chars.every((c) => OPEN.includes(c) || CLOSE.includes(c) || /\s/.test(c));
  const body = chars.map((c, i) => ({ c, i })).filter(({ c }) => !/[\s.,،؛:!?؟]/.test(c));
  return chars.map((c, i) => {
    const k = OPEN.indexOf(c) >= 0 ? OPEN.indexOf(c) : CLOSE.indexOf(c);
    if (k < 0) return c;
    if (lone) { depth.n = Math.max(0, depth.n + (OPEN.includes(c) ? 1 : -1)); return c; }
    const first = body.length > 0 && body[0].i === i, last = body.length > 0 && body[body.length - 1].i === i;
    const opens = depth.n > 0 ? false : first || !last;
    depth.n = Math.max(0, depth.n + (opens ? 1 : -1));
    return opens ? OPEN[k] : CLOSE[k];
  }).join('');
}

/** Each bracket's [opening, closing] form. */
export const BRACKETS: Record<string, [string, string]> = { '(': ['(', ')'], ')': ['(', ')'], '[': ['[', ']'], ']': ['[', ']'], '{': ['{', '}'], '}': ['{', '}'], '«': ['«', '»'], '»': ['«', '»'], '﴾': ['﴿', '﴾'], '﴿': ['﴿', '﴾'] };

/**
 * Brackets drawn on their own, in reading order: whether each opens or closes. A PDF may name a bracket by its
 * shape (which is mirrored on a right-to-left line) or use one name for both; what counts is where its words
 * are — an opening bracket clings to the word after it — and, where it clings to both sides ("و(سبحان"), that
 * brackets pair up. Returns the corrected text of each piece.
 */
export function fixLoneBrackets<T extends { text: string; l: number; r: number; h: number }>(seq: T[], rtl: boolean): string[] {
  const out = seq.map((p) => p.text);
  const depth = new Map<string, number>();
  // (Only letters and digits tell: a bracket clings to punctuation either way — «».»، .)
  const word = (p: T | undefined) => !!p && /[\p{L}\p{N}]/u.test(p.text);
  for (let i = 0; i < seq.length; i++) {
    // (Most pieces hold no bracket at all: nothing to settle, nothing to count.)
    if (!BRACKET_CHAR.test(seq[i].text)) continue;
    const t0 = seq[i].text.trim();
    // A bracket alone, or with punctuation only ("،(" — a closing bracket and the comma after it).
    const bs = [...t0].filter((ch) => BRACKETS[ch]);
    const t = bs.length === 1 && !/[\p{L}\p{N}]/u.test(t0) ? bs[0] : t0;
    const pair = BRACKETS[t];
    if (!pair) {
      // (Brackets inside longer pieces count too: "[النور:" opens what a lone "]" later closes.)
      for (const ch of t) { const pr = BRACKETS[ch]; if (pr) depth.set(pr[0], Math.max(0, (depth.get(pr[0]) ?? 0) + (ch === pr[0] ? 1 : -1))); }
      continue;
    }
    const p = seq[i];
    let a = i - 1; while (a >= 0 && !word(seq[a])) a--;
    let b = i + 1; while (b < seq.length && !word(seq[b])) b++;
    const prev = a >= 0 ? seq[a] : undefined, next = b < seq.length ? seq[b] : undefined;
    if (!prev && !next) continue;
    const gap = (x: T | undefined, after: boolean) => (!x ? Infinity : rtl ? (after ? p.l - x.r : x.l - p.r) : (after ? x.l - p.r : p.l - x.r));
    const gPrev = gap(prev, false), gNext = gap(next, true);
    const d = depth.get(pair[0]) ?? 0;
    const open = Math.abs(gPrev - gNext) > p.h * 0.15 ? gNext < gPrev : d === 0;
    depth.set(pair[0], Math.max(0, d + (open ? 1 : -1)));
    out[i] = seq[i].text.replace(t, pair[open ? 0 : 1]);
  }
  return out;
}

/** A right-to-left piece stored in drawing order (a mark before its letter, "ُه") is turned round to "هُ". */
/** `keep`: the piece is known to read in logical order already (its first mark is the previous letter's: the
 *  worker's `krLead`). */
export function logicalRtlPiece(s: string, keep = false): string {
  const core = s.trim();
  if (keep || !core || !COMBINING.test(core[0]) || !/[\u0600-\u06FF]/.test(core)) return s;
  // Only a single cluster (marks + one letter) is in drawing order; longer text with a stray mark in front is not.
  if ([...core].filter((c) => !COMBINING.test(c)).length !== 1) return s;
  const lead = s.match(/^\s*/)![0], trail = s.match(/\s*$/)![0];
  return trail + [...core].reverse().join('') + lead;
}

/**
 * On a right-to-left line read right to left, a run of left-to-right text (Latin words, with the numbers and
 * punctuation between them) is still read left to right: "Acme Corp", not "Corp Acme". Returns the sequence
 * with each such run turned round, and which items are in one.
 */
export function ltrRunsForward<T>(seq: T[], text: (x: T) => string): { seq: T[]; inRun: Set<T> } {
  const kind = (s: string) => (/[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/.test(s) ? 'L' : /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(s) ? 'R' : /[0-9]/.test(s) ? 'N' : 'S');
  const k = seq.map((x) => kind(text(x)));
  const out = [...seq]; const inRun = new Set<T>();
  const weak = (i: number) => k[i] === 'L' || k[i] === 'N';
  for (let i = 0; i < k.length;) {
    if (k[i] !== 'L') { i++; continue; }
    let a = i; while (a > 0 && (weak(a - 1) || (k[a - 1] === 'S' && a - 2 >= 0 && weak(a - 2)))) a--;
    let b = i; while (b + 1 < k.length && (weak(b + 1) || (k[b + 1] === 'S' && b + 2 < k.length && weak(b + 2)))) b++;
    if (b > a) { const run = out.slice(a, b + 1).reverse(); out.splice(a, run.length, ...run); for (const x of run) inRun.add(x); }
    i = b + 1;
  }
  return { seq: out, inRun };
}

const LTR_LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
const DIGITS_RUN = /^[\p{Nd}\u066B\u066C.,:/'\u2044-]+$/u;
/** Digits drawn one by one with the separators between them (a Chromium page sets "١/٢" as three glyphs) are
 *  one number, read left to right whatever the line's direction: such neighbours are joined into one piece. */
export function joinNumberRuns<T extends LinePiece>(line: T[]): T[] {
  const byX = [...line].sort((a, b) => a.l - b.l);
  const out: T[] = [];
  for (const p of byX) {
    const last = out[out.length - 1];
    const num = (x: T) => DIGITS_RUN.test(x.text) && /\p{Nd}/u.test(x.text);
    const sep = (x: T) => /^[.,:/'\u2044-]$/.test(x.text);
    if (last && (num(p) || (sep(p) && num(last))) && (num(last) || sep(last)) && p.l - last.r < Math.min(p.h, last.h) * 0.25) {
      out[out.length - 1] = { ...last, text: last.text + p.text, r: Math.max(last.r, p.r), l: Math.min(last.l, p.l) }; continue;
    }
    out.push(p);
  }
  // (A separator left dangling at the end of a number — "١٢." — was the sentence's, not the number's.)
  return out.length === line.length ? line : out;
}
/** One line of pieces (any order) → its text in reading order. `base` is the direction of the page or block
 *  the line belongs to: a line of both scripts (a Latin phrase in an Arabic paragraph, with an Arabic word
 *  after it) follows it, the way the page laid the line out, rather than whichever script has more letters. */
export function lineDirection(text: string, base?: boolean): boolean {
  return RTL_CHAR.test(text) && LTR_LETTER.test(text) && base !== undefined ? base : isRtlText(text);
}
export function joinLine<T extends LinePiece>(line: T[], base?: boolean): { text: string; rtl: boolean } {
  // One piece (the converter asks for each piece's own reading): nothing to sort, join or space — the same
  // result as the whole way below, without it.
  if (line.length === 1) {
    const p = line[0]; const rtl = lineDirection(p.text, base);
    if (p.text === '\u2009' || !p.text.trim()) return { text: '', rtl };
    let text = rtl ? orientBrackets(logicalNeutral(logicalRtlPiece(p.text, p.keep), true), { n: 0 }) : p.text;
    if (rtl && LTR_LETTER.test(text) && !RTL_CHAR.test(text)) { const m = /^([.,;:!?]+)(\S.*)$/.exec(text); if (m) text = m[2] + m[1]; }
    return { text: text.replace(/\s+/g, ' ').trim().replace(/^[\u064B-\u065F\u0670]+\s*/, ''), rtl };
  }
  const rtl = lineDirection(line.map((p) => p.text).join(''), base);
  line = joinNumberRuns(line);
  const sorted = dropBuriedSpaces(line, (p) => p.text === '\u2009').sort((a, b) => (rtl ? b.l - a.l || b.r - a.r : a.l - b.l || a.r - b.r));
  const fixed = fixLoneBrackets(sorted, rtl);
  sorted.forEach((p, i) => { if (fixed[i] !== p.text) sorted[i] = { ...p, text: fixed[i] }; });
  const marked = sorted.some((p) => p.text === '\u2009');
  const { seq: ordered, inRun } = rtl ? ltrRunsForward(sorted, (p) => p.text) : { seq: sorted, inRun: new Set<T>() };
  let s = '';
  let prev: LinePiece | null = null; let prevIn = false; const depth = { n: 0 }; let stop = '';
  for (const p of ordered) {
    // (A drawn space, however narrow — a justified line squeezes it — is a word break.)
    if (p.text === '\u2009' || !p.text.trim()) { if (s && !/\s$/.test(s)) s += ' '; continue; }
    const inR = inRun.has(p);
    // (The run of Latin ended: the stop kept from its first piece comes now, before anything else.)
    if (stop && !inR) { s = s.replace(/\s+$/, '') + stop + ' '; stop = ''; }
    let text = rtl ? orientBrackets(logicalNeutral(logicalRtlPiece(p.text, p.keep), true), depth) : p.text;
    // A Latin phrase on a right-to-left line that ends a sentence: the page set its full stop on its left, the
    // line's side (".Hello world" as drawn, the stop before the first word); read in order it comes last.
    if (rtl && (!inR || !prevIn) && LTR_LETTER.test(text) && !RTL_CHAR.test(text)) { const m = /^([.,;:!?]+)(\S.*)$/.exec(text); if (m) { text = m[2]; if (inR) stop = m[1]; else text += m[1]; } }
    if (prev) {
      // (Where the page draws its spaces, a gap is still a word break when it is wide: a stretched line may
      // set some words apart by position alone.)
      // (Within a left-to-right run the gap is measured left to right; across its ends, on the line's side.)
      const fwd = !rtl || (prevIn && inRun.has(p));
      const gap = fwd ? p.l - prev.r : prev.l - p.r;
      if (gap > Math.min(prev.h, p.h) * (marked ? 0.3 : 0.18) && !/\s$/.test(s) && !/^\s/.test(text) && !COMBINING.test(text[0]) && !VIRAMA_END.test(prev.text)) s += ' ';
    }
    s += text;
    // A piece inside the previous one (a mark over its letter) must not move the edge back.
    const fwdNow = !rtl || inRun.has(p);
    prev = prev && (fwdNow ? p.r < prev.r : p.l > prev.l) && prevIn === inR ? { ...p, l: Math.min(prev.l, p.l), r: Math.max(prev.r, p.r) } : p;
    prevIn = inR;
  }
  if (stop) s = s.replace(/\s+$/, '') + stop;
  // A haraka with no letter before it (at the start of the line) has lost its place: drop it.
  return { text: s.replace(/\s+/g, ' ').trim().replace(/^[\u064B-\u065F\u0670]+\s*/, ''), rtl };
}

const MARK_ONLY = /^[\u064B-\u065F\u0670\u06D6-\u06ED\s]+$/;
/** Harakat reported on their own (drawn apart from their run, or high above the line) go back into the word
 *  they sit on, after the letter beneath them. Returns the pieces without the attached marks. */
export function attachMarks<T extends { text: string; l: number; r: number; y: number; h: number }>(pieces: T[]): T[] {
  const marks = pieces.filter((p) => MARK_ONLY.test(p.text) && p.text.trim());
  if (!marks.length) return pieces;
  const hosts = pieces.filter((p) => !MARK_ONLY.test(p.text) && /[\u0600-\u06FF]/.test(p.text));
  const placed = new Set<T>();
  for (const m of marks) {
    const cx = (m.l + m.r) / 2;
    let host: T | null = null, best = Infinity;
    for (const q of hosts) {
      const dy = Math.abs(q.y - m.y);
      if (dy > q.h * 1.3 || cx < q.l - 1 || cx > q.r + 1) continue;
      if (dy < best) { best = dy; host = q; }
    }
    if (!host) continue;
    const chars = [...host.text];
    const bases = chars.map((c, k) => (COMBINING.test(c) || c === '\u0640' ? -1 : k)).filter((k) => k >= 0);
    if (!bases.length) continue;
    // Right-to-left: the share of the width from the right edge picks the letter.
    const f = Math.min(0.999, Math.max(0, (host.r - cx) / Math.max(1, host.r - host.l)));
    let at = bases[Math.min(bases.length - 1, Math.floor(f * bases.length))];
    while (at + 1 < chars.length && COMBINING.test(chars[at + 1])) at++;
    chars.splice(at + 1, 0, m.text.trim());
    host.text = chars.join('');
    placed.add(m);
  }
  return pieces.filter((p) => !placed.has(p));
}

/** Column bounds [from, to) across the page when the words fall into columns, else null: a gutter that no word
 *  crosses, with a good share of the words on each side of it, the two sides standing over the same height. */
export function findColumns(rows: { l: number; r: number; y: number; text: string; h?: number }[][]): [number, number][] | null {
  const ws = rows.flat().filter((w) => w.text.trim());
  // (Fewer than four lines, or than eight words, are never columns: a heading's words set apart are not.)
  if (ws.length < 8 || rows.filter((r) => r.some((w) => w.text.trim())).length < 4) return null;
  const hs = ws.map((w) => w.h ?? 0).filter((h) => h > 0).sort((a, b) => a - b); const em = hs.length ? hs[hs.length >> 1] : 10;
  const L = Math.min(...ws.map((w) => w.l)), R = Math.max(...ws.map((w) => w.r)); if (R - L < 100) return null;
  const step = (R - L) / 200;
  const lines = rows.map((r) => r.filter((w) => w.text.trim())).filter((r) => r.length);
  // (Lines with words on both sides of the gutter — a heading across the columns, a table — are few in a
  // page set in columns; many of them mean one column of lines of different lengths.)
  const bothMax = Math.max(1, Math.round(lines.length * 0.12));
  const gutters: [number, number][] = []; let open: number | null = null;
  for (let x = L + step; x < R - step; x += step) {
    let crossed = 0, left = 0, right = 0, lt = Infinity, lb = -Infinity, rt = Infinity, rb = -Infinity;
    for (const w of ws) {
      if (w.l < x - 0.5 && w.r > x + 0.5) { crossed++; if (crossed > ws.length * 0.04) break; continue; }
      if (w.r <= x) { left++; lt = Math.min(lt, w.y); lb = Math.max(lb, w.y); } else { right++; rt = Math.min(rt, w.y); rb = Math.max(rb, w.y); }
    }
    const span = Math.max(lb - lt, rb - rt), shared = Math.min(lb, rb) - Math.max(lt, rt);
    let both = 0;
    if (crossed <= ws.length * 0.04) for (const ln of lines) { if (ln.some((w) => w.r <= x) && ln.some((w) => w.l >= x)) { both++; if (both > bothMax) break; } }
    // (A heading or a table across both columns is let be: a few words may cross the gutter.)
    const isGutter = crossed <= ws.length * 0.04 && both <= bothMax && left >= ws.length * 0.2 && right >= ws.length * 0.2 && span > 0 && (shared >= span * 0.35 || (Math.min(lb - lt, rb - rt) === 0 && shared >= -40));
    if (isGutter && open === null) open = x; else if (!isGutter && open !== null) { gutters.push([open, x]); open = null; }
  }
  if (open !== null) gutters.push([open, R]);
  const wide = gutters.filter(([a, b]) => b - a >= Math.max(8, em * 0.8));
  if (!wide.length || wide.length > 3) return null;
  const bounds: [number, number][] = []; let from = -Infinity;
  for (const [a, b] of wide) { bounds.push([from, (a + b) / 2]); from = (a + b) / 2; }
  bounds.push([from, Infinity]);
  return bounds;
}

