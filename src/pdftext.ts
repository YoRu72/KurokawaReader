// Turning the pieces of text a PDF exposes into readable lines — shared by copying from the
// PDF viewer and by PDF → DOCX/EPUB conversion.
//
// A piece is a run of text with its horizontal extent; pieces on one line are put in reading
// order by where they start (their origin), not where the browser's fallback font says they end.
// Word breaks come from the PDF's own drawn spaces when it marks them (U+2009, see
// scripts/patch-pdfjs.mjs), otherwise from the gaps between pieces.

export type LinePiece = { text: string; l: number; r: number; h: number; keep?: boolean };

const RTL_CHAR_G = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
// Arabic harakat, shadda, sukun, superscript alef, Quranic marks; Hebrew points.
export const COMBINING = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0591-\u05C7]/;

/** Control characters (glyphs with no Unicode) are not text. */
export function cleanPdfText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\u200B]/g, '').replace(/\u00A0/g, ' ');
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
  let out = text;
  for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}'], ['«', '»']]) {
    const no = [...out].filter((x) => x === o).length, nc = [...out].filter((x) => x === c).length;
    if (no + nc < 2 || (no && nc)) continue;
    let k = 0; out = [...out].map((x) => (x === o || x === c ? (k++ % 2 ? c : o) : x)).join('');
  }
  return out;
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

/** One line of pieces (any order) → its text in reading order. */
export function joinLine<T extends LinePiece>(line: T[]): { text: string; rtl: boolean } {
  const rtl = isRtlText(line.map((p) => p.text).join(''));
  const sorted = dropBuriedSpaces(line, (p) => p.text === '\u2009').sort((a, b) => (rtl ? b.l - a.l || b.r - a.r : a.l - b.l || a.r - b.r));
  const fixed = fixLoneBrackets(sorted, rtl);
  sorted.forEach((p, i) => { if (fixed[i] !== p.text) sorted[i] = { ...p, text: fixed[i] }; });
  const marked = sorted.some((p) => p.text === '\u2009');
  const { seq: ordered, inRun } = rtl ? ltrRunsForward(sorted, (p) => p.text) : { seq: sorted, inRun: new Set<T>() };
  let s = '';
  let prev: LinePiece | null = null; let prevIn = false;
  for (const p of ordered) {
    // (A drawn space, however narrow — a justified line squeezes it — is a word break.)
    if (p.text === '\u2009' || !p.text.trim()) { if (s && !/\s$/.test(s)) s += ' '; continue; }
    const text = rtl ? balanceBrackets(logicalNeutral(logicalRtlPiece(p.text, p.keep), true)) : p.text;
    if (prev) {
      // (Where the page draws its spaces, a gap is still a word break when it is wide: a stretched line may
      // set some words apart by position alone.)
      // (Within a left-to-right run the gap is measured left to right; across its ends, on the line's side.)
      const fwd = !rtl || (prevIn && inRun.has(p));
      const gap = fwd ? p.l - prev.r : prev.l - p.r;
      if (gap > Math.min(prev.h, p.h) * (marked ? 0.3 : 0.18) && !/\s$/.test(s) && !/^\s/.test(text) && !COMBINING.test(text[0])) s += ' ';
    }
    s += text;
    // A piece inside the previous one (a mark over its letter) must not move the edge back.
    const fwdNow = !rtl || inRun.has(p);
    prev = prev && (fwdNow ? p.r < prev.r : p.l > prev.l) && prevIn === inRun.has(p) ? { ...p, l: Math.min(prev.l, p.l), r: Math.max(prev.r, p.r) } : p;
    prevIn = inRun.has(p);
  }
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
export function findColumns(rows: { l: number; r: number; y: number; text: string }[][]): [number, number][] | null {
  const ws = rows.flat().filter((w) => w.text.trim());
  if (ws.length < 4) return null;
  const L = Math.min(...ws.map((w) => w.l)), R = Math.max(...ws.map((w) => w.r)); if (R - L < 100) return null;
  const step = (R - L) / 200;
  const gutters: [number, number][] = []; let open: number | null = null;
  for (let x = L + step; x < R - step; x += step) {
    let crossed = 0, left = 0, right = 0, lt = Infinity, lb = -Infinity, rt = Infinity, rb = -Infinity;
    for (const w of ws) {
      if (w.l < x - 0.5 && w.r > x + 0.5) { crossed++; if (crossed > ws.length * 0.04) break; continue; }
      if (w.r <= x) { left++; lt = Math.min(lt, w.y); lb = Math.max(lb, w.y); } else { right++; rt = Math.min(rt, w.y); rb = Math.max(rb, w.y); }
    }
    const span = Math.max(lb - lt, rb - rt), shared = Math.min(lb, rb) - Math.max(lt, rt);
    // (A heading or a table across both columns is let be: a few words may cross the gutter.)
    const isGutter = crossed <= ws.length * 0.04 && left >= ws.length * 0.2 && right >= ws.length * 0.2 && span > 0 && (shared >= span * 0.35 || (Math.min(lb - lt, rb - rt) === 0 && shared >= -40));
    if (isGutter && open === null) open = x; else if (!isGutter && open !== null) { gutters.push([open, x]); open = null; }
  }
  if (open !== null) gutters.push([open, R]);
  const wide = gutters.filter(([a, b]) => b - a >= 8);
  if (!wide.length || wide.length > 3) return null;
  const bounds: [number, number][] = []; let from = -Infinity;
  for (const [a, b] of wide) { bounds.push([from, (a + b) / 2]); from = (a + b) / 2; }
  bounds.push([from, Infinity]);
  return bounds;
}

