/**
 * Rebuilding a PDF's subset TrueType font so a word processor can use it.
 *
 * Many PDF makers (LibreOffice among them) embed a subset of each font whose glyphs are reached by the
 * PDF's own one-byte codes: no Unicode cmap, no shaping tables. Arabic is stored there already shaped —
 * each glyph is one form of a letter (initial, medial, final, isolated) or a ligature. Such a font cannot
 * draw Unicode text, so it cannot be embedded in a .docx as it is.
 *
 * From how the PDF uses each glyph (its code, its Unicode text, and its neighbours in the line) this
 * rebuilds what the font lacks:
 *  - a Unicode cmap (each character → its isolated glyph, or another form when only that one was used);
 *  - a GSUB table with the Arabic positional features (isol/fina/medi/init) and the ligatures (rlig), so
 *    the shaper picks the very glyphs the PDF used;
 *  - empty glyphs for characters that only occur inside ligatures (a ligature needs its parts);
 *  - an OS/2 table when there is none (Word needs it to embed the font).
 */


/** `a.push(...b)` without the call-stack limit a spread of a big array hits. */
function pushAll<T>(a: T[], b: ArrayLike<T>): void { for (let i = 0; i < b.length; i++) a.push(b[i]); }
import { readSfnt, glyphReader, verticalMetrics, writeTrueType, type Outline } from './fontbuild';

type Tables = Map<string, Uint8Array>;

function readTables(b: Uint8Array): Tables | null {
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tag = dv.getUint32(0);
    if (tag !== 0x00010000 && tag !== 0x74727565) return null; // TrueType outlines only
    const n = dv.getUint16(4); const out: Tables = new Map();
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      const t = String.fromCharCode(...b.subarray(r, r + 4));
      const off = dv.getUint32(r + 8), len = dv.getUint32(r + 12);
      if (off + len > b.length) return null;
      out.set(t, b.slice(off, off + len));
    }
    return out.has('glyf') && out.has('loca') && out.has('head') && out.has('hhea') && out.has('hmtx') && out.has('maxp') ? out : null;
  } catch { return null; }
}

const dvOf = (a: Uint8Array) => new DataView(a.buffer, a.byteOffset, a.byteLength);

/** Byte code → glyph id, the way a PDF viewer reads a symbolic TrueType font: (3,0) then (1,0). */
function codeToGid(cmap: Uint8Array): Map<number, number> {
  const dv = dvOf(cmap); const out = new Map<number, number>();
  const subs: { p: number; e: number; off: number }[] = [];
  for (let i = 0, n = dv.getUint16(2); i < n; i++) subs.push({ p: dv.getUint16(4 + i * 8), e: dv.getUint16(6 + i * 8), off: dv.getUint32(8 + i * 8) });
  const read = (off: number, map: (c: number) => number | null) => {
    const fmt = dv.getUint16(off);
    if (fmt === 0) { for (let c = 0; c < 256; c++) { const g = cmap[off + 6 + c]; if (g) out.set(c, g); } }
    else if (fmt === 6) { const first = dv.getUint16(off + 6), count = dv.getUint16(off + 8); for (let k = 0; k < count; k++) { const g = dv.getUint16(off + 10 + k * 2); if (g) out.set(first + k, g); } }
    else if (fmt === 4) {
      const seg = dv.getUint16(off + 6) / 2, ends = off + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
      for (let k = 0; k < seg; k++) {
        const a = dv.getUint16(starts + k * 2), z = dv.getUint16(ends + k * 2), d = dv.getInt16(deltas + k * 2), ro = dv.getUint16(ranges + k * 2);
        if (a === 0xffff) continue;
        for (let c = a; c <= z; c++) {
          let g: number;
          if (!ro) g = (c + d) & 0xffff;
          else { const at = ranges + k * 2 + ro + (c - a) * 2; g = dv.getUint16(at); if (g) g = (g + d) & 0xffff; }
          const code = map(c); if (g && code !== null) out.set(code, g);
        }
      }
    }
  };
  const ms = subs.find((s) => s.p === 3 && s.e === 0); const mac = subs.find((s) => s.p === 1 && s.e === 0);
  if (mac) read(mac.off, (c) => c);
  if (ms) read(ms.off, (c) => (c >= 0xf000 && c <= 0xf0ff ? c - 0xf000 : c <= 0xff ? c : null));
  return out;
}

/** Arabic joining type of a character: D dual, R right, U none, T transparent (marks). */
function joining(c: number): 'D' | 'R' | 'U' | 'T' {
  if ((c >= 0x064b && c <= 0x065f) || c === 0x0670 || (c >= 0x0610 && c <= 0x061a) || (c >= 0x06d6 && c <= 0x06dc) || (c >= 0x06df && c <= 0x06e4) || c === 0x06e7 || c === 0x06e8 || (c >= 0x06ea && c <= 0x06ed) || c === 0x200c) return 'T';
  if (c === 0x0640 || c === 0x200d) return 'D';
  if ((c >= 0x0622 && c <= 0x0625) || c === 0x0627 || c === 0x0629 || (c >= 0x062f && c <= 0x0632) || c === 0x0648 || (c >= 0x0671 && c <= 0x0673) || (c >= 0x0675 && c <= 0x0677) || (c >= 0x0688 && c <= 0x0699) || c === 0x06c0 || (c >= 0x06c3 && c <= 0x06cb) || c === 0x06cd || c === 0x06cf || c === 0x06d2 || c === 0x06d3 || c === 0x06d5 || c === 0x06ee || c === 0x06ef) return 'R';
  if (c === 0x0626 || c === 0x0628 || (c >= 0x062a && c <= 0x062e) || (c >= 0x0633 && c <= 0x063f) || (c >= 0x0641 && c <= 0x0647) || c === 0x0649 || c === 0x064a || c === 0x066e || c === 0x066f || (c >= 0x0678 && c <= 0x0687) || (c >= 0x069a && c <= 0x06bf) || c === 0x06c1 || c === 0x06c2 || c === 0x06cc || c === 0x06ce || c === 0x06d0 || c === 0x06d1 || (c >= 0x06fa && c <= 0x06fc) || c === 0x06ff || c === 0x0620) return 'D';
  return 'U';
}

type Form = 'isol' | 'init' | 'medi' | 'fina';
const FORMS: Form[] = ['isol', 'fina', 'medi', 'init'];
const formOf = (prev: boolean, next: boolean): Form => (prev && next ? 'medi' : prev ? 'fina' : next ? 'init' : 'isol');

/** One use of a glyph in the PDF: its code, its Unicode text (empty for a mark drawn with its letter's
 *  text), and where it is drawn (page x, y and the size of an em there), in drawing order along a line. */
export type GlyphUse = [code: number, text: string, x: number, y: number, em: number, width: number, span?: number];

const MIRROR: Record<number, number> = { 0x28: 0x29, 0x29: 0x28, 0x5b: 0x5d, 0x5d: 0x5b, 0x7b: 0x7d, 0x7d: 0x7b, 0xab: 0xbb, 0xbb: 0xab, 0x3c: 0x3e, 0x3e: 0x3c };
/** Canonical combining class of the Arabic marks (the order a shaper sorts them into). */
const ccc = (c: number) => ({ 0x64b: 27, 0x64c: 28, 0x64d: 29, 0x64e: 30, 0x64f: 31, 0x650: 32, 0x651: 33, 0x652: 34, 0x653: 230, 0x654: 230, 0x655: 220, 0x670: 35 } as Record<number, number>)[c] ?? 0;
// (Word signs — ﷺ, ﷻ, ﷽, ﷲ — stay themselves: the text carries them as one character, and their glyph is that sign.)
const norm = (s: string) => (/^[\ufdf0-\ufdfd]$/.test(s) ? s : /[\ufb50-\ufdff\ufe70-\ufeff]/.test(s) ? s.normalize('NFKC') : s);
const isMark = (c: number) => joining(c) === 'T';

/** One use of a glyph (by its number across all sources: source × 65536 + glyph) along a line. */
/** A run of uses; `rtl` is the direction of the line it was found on. */
type RtlLine = Use[] & { rtl?: boolean };
export type Use = [gid: number, text: string, x: number, y: number, em: number, width: number, span?: number];
/** Where glyph outlines come from (a font of the PDF, read through pdf.js's copy of it). */
export type GlyphSource = { outline(gid: number): Outline; upem: number; asc?: number; desc?: number };

/** The old entry point: a TrueType subset with codes looked up in its own (symbol) cmap. */
export function rebuildFont(raw: Uint8Array, lines: GlyphUse[][], spaceCode?: number, family = 'Font', bold = false, italic = false): Uint8Array | null {
  const t = readTables(raw); if (!t || !t.has('cmap')) return null;
  const c2g = codeToGid(t.get('cmap')!);
  if (!c2g.size) return null;
  const sf = readSfnt(raw); if (!sf) return null;
  const r = glyphReader(sf); const vm = verticalMetrics(sf);
  const uses = lines.map((l) => l.map(([code, text, x, y, em, w, sp]) => [c2g.get(code) ?? 0, text, x, y, em, w, sp] as Use));
  return buildFont([{ outline: r.outline, upem: r.upem, asc: vm?.asc, desc: vm?.desc }], uses, { family, bold, italic }, spaceCode !== undefined ? c2g.get(spaceCode) : undefined);
}

const ADDED = 0x7fff0000;
const CLONE = 0x7ff00000; // copies of a glyph that stands for two marks // ids of the empty glyphs made for characters with no glyph of their own

/**
 * A TrueType font for Word, built from the glyphs a document uses: cmap, Arabic shaping (forms, ligatures in
 * the PDF's priority, contextual variants), marks where the PDF put them — learnt from the uses — and the
 * glyphs' own outlines from their sources (several fonts can be merged into one: a legacy book's letter forms
 * live in several PDF fonts, and Word joins Arabic letters only within one font).
 */
export function buildFont(sources: GlyphSource[], lines: Use[][], meta: { family: string; bold?: boolean; italic?: boolean; space?: number; tatweel?: boolean; raw?: boolean }, spaceGid?: number): Uint8Array | null {
  if (!sources.length) return null;
  const upem = sources.length === 1 ? sources[0].upem : 1000;
  // A glyph read as a space is a word break, not the font's space (a legacy font may file a letter under the
  // space code); the space comes from spaceGid or meta.space.
  lines = lines.flatMap((l) => { const out: Use[][] = [[]]; for (const u of l) { if (u[1] && /^[\s\u200b-\u200f\u2060\ufeff]+$/.test(u[1])) out.push([]); else out[out.length - 1].push(u); } return out.filter((x) => x.length).map((x) => Object.assign(x, { rtl: (l as RtlLine).rtl })); });
  // The same glyph met in several sources (the subsets of one font, a page each) is one glyph: told by its
  // outline. Otherwise a long book's font would hold a copy of each letter form per page, and its shaping
  // rules — one set per copy — would outgrow what a GSUB table can hold.
  // Glyphs with no outline (a space, an invisible glyph) are never read as marks on the letter beside them —
  // a space drawn with no text of its own would otherwise turn the font's space into a mark, and every word
  // would run into the next.
  const blank = new Set<number>();
  const isBlank = (gid: number): boolean => { try { const src = sources[Math.floor(gid / 65536)]; return !!src && !src.outline(gid % 65536).contours.length; } catch { return false; } };
  for (const l of lines) for (const u of l) if (u[0] && !blank.has(u[0]) && !u[1] && isBlank(u[0])) blank.add(u[0]);
  if (blank.size) lines = lines.map((l) => Object.assign(l.filter((u) => !blank.has(u[0]) || u[1]), { rtl: (l as RtlLine).rtl })).filter((l) => l.length);
  if (sources.length > 1) {
    const canon = new Map<number, number>(); const byShape = new Map<string, number>();
    const keyOf = (gid: number): string | null => {
      try {
        const src = sources[Math.floor(gid / 65536)]; if (!src) return null;
        const o = src.outline(gid % 65536); const k = 1000 / src.upem;
        // (A glyph with no outline — a space, a blank mark — is never shared: told apart only by its use.)
        if (!o.contours.length) return null;
        let key = `${Math.round(o.adv * k)}`;
        for (const c of o.contours) { key += '|'; for (const pt of c) key += `${Math.round(pt.x * k)},${Math.round(pt.y * k)}${pt.on ? '' : '~'};`; }
        return key;
      } catch { return null; }
    };
    for (const l of lines) for (const u of l) {
      const g = u[0]; if (!g) continue;
      let c = canon.get(g);
      if (c === undefined) { const key = keyOf(g); c = key === null ? g : (byShape.get(key) ?? g); if (key !== null && !byShape.has(key)) byShape.set(key, g); canon.set(g, c); }
      u[0] = c;
    }
    if (spaceGid !== undefined) spaceGid = canon.get(spaceGid) ?? spaceGid;
  }
  // The width the PDF gives each glyph (its /Widths, em): what the page's lines were measured with. A font
  // whose own advances differ (a producer that re-measured it) would set the lines longer or shorter than the
  // page, wrapping a word the page kept; the PDF's widths win.
  const pdfAdv = new Map<number, number[]>();
  for (const l of lines) for (const u of l) if (u[0] && u[5] > 0 && u[5] < 4) { const a = pdfAdv.get(u[0]); if (a) { if (a.length < 24) a.push(u[5]); } else pdfAdv.set(u[0], [u[5]]); }
  const medianOf = (a: number[]) => { const v = [...a].sort((x, y) => x - y); return v[v.length >> 1]; };
  const tally = <K>(m: Map<K, Map<number, number>>, k: K, g: number) => { let x = m.get(k); if (!x) m.set(k, x = new Map()); x.set(g, (x.get(g) ?? 0) + 1); };
  const top = (x: Map<number, number>) => [...x.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const letterForm = new Map<string, Map<number, number>>(); // `${char}|${form}` → glyph uses
  const markGlyph = new Map<number, Map<number, number>>(); // mark char → glyph uses
  const markGuess = new Map<number, Map<number, number>>();
  const streams: { stream: { c: number; form: Form }[]; occ: { key: string; at: number; len: number }[]; inLig: Set<number> }[] = [];
  const ctxNext = new Map<string, Map<number, number>>(), ctxPrev = new Map<string, Map<number, number>>();
  const ctxNextF = new Map<string, Map<number, number>>(), ctxPrevF = new Map<string, Map<number, number>>();
  const plain = new Map<number, Map<number, number>>(); // non-joining char → glyph uses
  const ligs = new Map<string, { comps: { c: number; form: Form }[]; gid: number; across?: boolean }>(); // letters only
  const ligCount = new Map<string, number>();
  const absorbed = new Map<string, { c: number; form: Form; marks: number[]; gid: number }>(); // a letter drawn with its marks
  const markLigs = new Map<string, { marks: number[]; gid: number }>(); // several marks drawn as one glyph
  const offsets = new Map<string, [number, number][]>(); // `${base}|${mark}` → mark origin − base origin (font units)
  const markGids = new Set<number>(), ligGids = new Set<number>();
  const seen = new Set<number>();
  const allGids = new Set<number>();
  const checks: { text: string; bases: number[]; rtl: boolean }[] | null = (globalThis as { krDebugP2D?: boolean }).krDebugP2D ? [] : null;

  for (const line of lines) {
    // Clusters: each spacing glyph with the zero-width glyphs (its marks) drawn over it.
    type Cl = { gid: number; cps: number[]; marks: number[]; x: number; y: number; em: number; adv: number; mpos: [number, number][]; bad?: boolean; span?: number };
    const cls: Cl[] = []; const loose: { gid: number; x: number; y: number; cps: number[]; span?: number }[] = [];
    for (const [gid, text, x, y, em, w, span] of line) {
      if (!gid) continue;
      allGids.add(gid);
      // (A code with no real text comes as a control or private-use character.)
      const cps = [...(meta.raw ? text : norm(text))].map((c) => c.codePointAt(0)!).filter((c) => c >= 0x20 && !(c >= 0xe000 && c <= 0xf8ff) && c !== 0xfffd && !(c >= 0x200b && c <= 0x200f) && c !== 0x2060 && c !== 0xfeff);
      if (text === '\uffff') { cls.push({ gid, cps: [], marks: [], x, y, em, adv: w * em, mpos: [], bad: true }); continue; }
      if (w > 0 && !(cps.length && cps.every(isMark))) cls.push({ gid, cps, marks: [], x, y, em, adv: w * em, mpos: [], span: span || undefined });
      else loose.push({ gid, x, y, cps, span: span || undefined });
    }
    for (const m of loose) {
      // A mark with text of its own (a real combining mark) stays a cluster of its own; others go on their letter.
      if (m.cps.length && m.cps.every(isMark)) { cls.push({ gid: m.gid, cps: m.cps, marks: [], x: m.x, y: m.y, em: 0, adv: 0, mpos: [] }); continue; }
      const own = m.span ? cls.find((c) => c.span === m.span && !c.bad) : undefined;
      if (own) { own.marks.push(m.gid); own.mpos.push([m.x, m.y]); continue; }
      if (m.span) continue; // a span with several letters: whose mark it is is not known
      let best: Cl | null = null, bd = Infinity;
      for (const c of cls) { if (c.bad) continue; const d = m.x < c.x ? c.x - m.x : m.x > c.x + c.adv ? m.x - c.x - c.adv : 0; if (d < bd) { bd = d; best = c; } }
      if (best && bd < best.em * 0.3) { best.marks.push(m.gid); best.mpos.push([m.x, m.y]); }
    }
    cls.sort((a, b) => a.x - b.x || b.adv - a.adv);
    const rtl = cls.filter((e) => e.cps.some((c) => c >= 0x600 && c <= 0x6ff)).length > cls.length / 2;
    if (rtl) cls.reverse();
    // (For checking the font against the PDF: each word's text and the letter glyphs the PDF drew for it.)
    if (checks && checks.length < 3000 && cls.length && !cls.some((e) => e.bad || !e.cps.length)) checks.push({ text: String.fromCodePoint(...cls.flatMap((e) => e.cps)), bases: cls.filter((e) => e.em > 0).map((e) => e.gid), rtl: (line as RtlLine).rtl ?? rtl });
    // Brackets and quotes on their own take the direction of the line they stand in.
    const mirror = cls.some((e) => e.cps.some((c) => joining(c) !== 'U' || /\p{L}/u.test(String.fromCodePoint(c)))) ? rtl : (line as RtlLine).rtl ?? rtl;
    const stream: { c: number; form: Form }[] = []; const occ: { key: string; at: number; len: number }[] = [];
    const inLig = new Set<number>();
    streams.push({ stream, occ, inLig });
    // (Each cluster's letters and how its first and last join, worked out once: they are asked again and again.)
    const lettersOf = new Map<Cl, number[]>(); const fj = new Map<Cl, string>(); const lj = new Map<Cl, string>();
    const letters = (e: Cl) => { let n = lettersOf.get(e); if (!n) { n = e.bad || !e.cps.length ? [0x20] : e.cps.filter((c) => !isMark(c)); lettersOf.set(e, n); } return n; };
    const firstJ = (e: Cl) => { let j = fj.get(e); if (j === undefined) { const n = letters(e); j = n.length ? joining(n[0]) : 'T'; fj.set(e, j); } return j; };
    const lastJ = (e: Cl) => { let j = lj.get(e); if (j === undefined) { const n = letters(e); j = n.length ? joining(n[n.length - 1]) : 'T'; lj.set(e, j); } return j; };
    // The joining form of cluster i's (first or last) letter.
    const formAt = (i: number): Form => {
      const e = cls[i];
      let p = i - 1; while (p >= 0 && firstJ(cls[p]) === 'T') p--;
      let q = i + 1; while (q < cls.length && firstJ(cls[q]) === 'T') q++;
      return formOf(p >= 0 && lastJ(cls[p]) === 'D' && (firstJ(e) === 'D' || firstJ(e) === 'R'), q < cls.length && lastJ(e) === 'D' && (firstJ(cls[q]) === 'D' || firstJ(cls[q]) === 'R'));
    };
    for (let i = 0; i < cls.length; i++) {
      const e = cls[i];
      if (e.bad || !e.cps.length) { stream.push({ c: 0, form: 'isol' }); continue; }
      for (const c of e.cps) seen.add(c);
      const marks = e.cps.filter(isMark), lets = letters(e);
      // Marks drawn as their own glyphs: one glyph per mark, in order; or several marks in one glyph.
      const markPart = (base: number, letterKey?: string) => {
        e.marks.forEach((g, k) => {
          markGids.add(g); if (!(e.em > 0)) return;
          const off: [number, number] = [(e.mpos[k][0] - e.x) / e.em * upem, (e.mpos[k][1] - e.y) / e.em * upem];
          // (which mark it is: a legacy font draws fatha and kasra with one stroke, above or below)
          const ch = e.marks.length === marks.length ? marks[k] : 0;
          for (const key of [`${base}|${g}|${ch}`, ...(letterKey ? [`L${letterKey}|${g}|${ch}`] : [])]) { const list = offsets.get(key) ?? []; list.push(off); offsets.set(key, list); }
        });
        // One mark, one glyph: that is its glyph; with several, the order is only a guess (used when nothing better).
        if (e.marks.length === 1 && marks.length === 1) tally(markGlyph, marks[0], e.marks[0]);
        else if (e.marks.length === marks.length) marks.forEach((c, k) => tally(markGuess, c, e.marks[k]));
        else if (e.marks.length === 1 && marks.length > 1) markLigs.set(marks.join(','), { marks, gid: e.marks[0] });
      };
      if (!lets.length) { // a mark glyph with its own text
        markGids.add(e.gid);
        if (marks.length === 1) tally(markGlyph, marks[0], e.gid); else markLigs.set(marks.join(','), { marks, gid: e.gid });
        continue;
      }
      let p = i - 1; while (p >= 0 && firstJ(cls[p]) === 'T') p--;
      let q = i + 1; while (q < cls.length && firstJ(cls[q]) === 'T') q++;
      const joinsPrev = p >= 0 && lastJ(cls[p]) === 'D' && (firstJ(e) === 'D' || firstJ(e) === 'R');
      const joinsNext = q < cls.length && lastJ(e) === 'D' && (firstJ(cls[q]) === 'D' || firstJ(cls[q]) === 'R');
      const form = formOf(joinsPrev, joinsNext);
      if (lets.length === 1) {
        const c = lets[0];
        // A bracket in right-to-left text is drawn mirrored: its glyph has the other bracket's shape (the
        // shaper mirrors it back).
        if (joining(c) === 'U') { if (!marks.length) tally(plain, mirror ? MIRROR[c] ?? c : c, e.gid); markPart(e.gid); stream.push({ c: 0, form: 'isol' }); continue; }
        stream.push({ c, form });
        if (marks.length && !e.marks.length) absorbed.set(`${c}|${form}|${marks.join(',')}`, { c, form, marks, gid: e.gid }); // the glyph draws the marks
        else {
          tally(letterForm, `${c}|${form}`, e.gid); markPart(e.gid, `${c}|${form}`);
          // The letter it joins on each side: naskh draws many letters differently before (or after) certain others.
          // (A letter that does not join its neighbour, an alef before a lam, can still depend on it.)
          const nb = (k: number, last: boolean) => { if (k < 0 || k >= cls.length) return 0; const l = letters(cls[k]); const x = last ? l[l.length - 1] : l[0]; return x && joining(x) !== 'U' ? x : 0; };
          const nl = nb(q, false), pl = nb(p, true);
          tally(ctxNext, `${c}|${form}|${nl}`, e.gid); tally(ctxPrev, `${c}|${form}|${pl}`, e.gid);
          // (and the form that neighbour takes: a letter before a medial yeh is often drawn unlike one before a final yeh)
          if (nl && letters(cls[q]).length === 1) tally(ctxNextF, `${c}|${form}|${nl}|${formAt(q)}`, e.gid);
          if (pl && letters(cls[p]).length === 1) tally(ctxPrevF, `${c}|${form}|${pl}|${formAt(p)}`, e.gid);
        }
        continue;
      }
      // A ligature of letters: the forms they would take in its place in the word.
      ligGids.add(e.gid);
      const comps = lets.map((c, k) => {
        const j = joining(c);
        const prevIn = k > 0 ? joining(lets[k - 1]) === 'D' && j !== 'U' : joinsPrev;
        const nextIn = k < lets.length - 1 ? j === 'D' && joining(lets[k + 1]) !== 'U' : joinsNext;
        return { c, form: formOf(prevIn, nextIn) };
      });
      const lkey = `${lets.join(',')}|${comps.map((x) => x.form).join(',')}`;
      // Marks between its letters: the ligature forms across them. (The page draws a ligature's harakat as
      // glyphs of their own, set over it, so its text has them between its letters — نِي drawn as one "ني"
      // glyph and a kasra; a ligature that stopped at the mark would leave a letter with no glyph of its own.
      // Lam-alef is the shaper's own required ligature: لَا, الْإِ.)
      const across = true;
      ligs.set(lkey, { comps, gid: e.gid, across: across || ligs.get(lkey)?.across });
      ligCount.set(lkey, (ligCount.get(lkey) ?? 0) + 1);
      for (let k = 0; k < comps.length; k++) inLig.add(stream.length + k);
      if (occ.length < 4000) occ.push({ key: lkey, at: stream.length, len: comps.length });
      pushAll(stream, comps);
      markPart(e.gid);
    }
  }

  // A ligature the PDF uses only now and then (a stretched one setting a justified line, while the same letters
  // are drawn apart everywhere else) is not how the font writes those letters.
  {
    const byFirst = new Map<string, string[]>();
    for (const [k, l] of ligs) { const f = `${l.comps[0].c}|${l.comps[0].form}`; (byFirst.get(f) ?? byFirst.set(f, []).get(f)!).push(k); }
    const apart = new Map<string, number>();
    for (const { stream, inLig } of streams) for (let i = 0; i < stream.length; i++) {
      if (inLig.has(i)) continue;
      for (const key of byFirst.get(`${stream[i].c}|${stream[i].form}`) ?? []) {
        const comps = ligs.get(key)!.comps; let ok = true;
        for (let k = 0; k < comps.length && ok; k++) { const x = stream[i + k]; ok = !!x && !inLig.has(i + k) && x.c === comps[k].c && x.form === comps[k].form; }
        if (ok) apart.set(key, (apart.get(key) ?? 0) + 1);
      }
    }
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D ligs', meta.family, JSON.stringify([...ligs].map(([k, l]) => [k.split('|')[0].split(',').map((c) => String.fromCodePoint(+c)).join(''), k.split('|')[1], l.gid % 65536, ligCount.get(k), apart.get(k) ?? 0])));
    for (const k of [...ligs.keys()]) if ((apart.get(k) ?? 0) > (ligCount.get(k) ?? 0)) ligs.delete(k);
  }

  // Each (letter, form) → its most used glyph; each character's nominal glyph (what the cmap gives).
  const formGlyph = new Map<number, Partial<Record<Form, number>>>();
  const cands = new Map<string, [number, number][]>();
  // The usual glyph of a letter in a form is the one drawn beside the most different neighbours (a variant
  // used only before, say, a noon is the exception, even when that pair is frequent).
  const groups = (ctx: Map<string, Map<number, number>>, c: number, f: Form) => [...ctx.entries()].filter(([k]) => k.startsWith(`${c}|${f}|`)).map(([k, uses]) => ({ other: +k.split('|')[2], uses }));
  for (const [k, uses] of letterForm) {
    const [c, f] = k.split('|'); const side = f === 'fina' ? ctxPrev : ctxNext;
    const score = new Map<number, number>();
    for (const g of groups(side, +c, f as Form)) { const t = top(g.uses); score.set(t, (score.get(t) ?? 0) + 1); }
    const all = [...uses.entries()].sort((a, b) => (score.get(b[0]) ?? 0) - (score.get(a[0]) ?? 0) || b[1] - a[1]);
    const m = formGlyph.get(+c) ?? {}; m[f as Form] = all[0][0]; formGlyph.set(+c, m);
    cands.set(k, all);
  }
  // One glyph cannot be a letter's form both joined on the left and not (medial and final, initial and
  // isolated): a word cut short in the PDF makes a medial letter look final. The form that uses it less
  // takes its next glyph (or none: the shaper then shows the letter's plain glyph).
  for (const [c, m] of formGlyph) {
    for (const [x, y] of [['fina', 'medi'], ['fina', 'init'], ['isol', 'medi'], ['isol', 'init']] as [Form, Form][]) {
      if (m[x] === undefined || m[x] !== m[y]) continue;
      const g = m[x]!; const n = (f: Form) => letterForm.get(`${c}|${f}`)?.get(g) ?? 0;
      const lose: Form = n(x) >= n(y) ? y : x;
      const next = (cands.get(`${c}|${lose}`) ?? []).find(([h]) => h !== g && h !== m[lose === x ? y : x]);
      if (next) m[lose] = next[0]; else delete m[lose];
    }
  }
  const nominal = new Map<number, number>();
  for (const [c, uses] of plain) nominal.set(c, top(uses));
  if (spaceGid) nominal.set(0x20, spaceGid);
  else if (meta.space) nominal.set(0x20, ADDED - 1); // a space as wide as the PDF's (its glyph is not in the font pdf.js kept)
  for (const [c, uses] of markGlyph) nominal.set(c, top(uses));
  for (const [c, uses] of markGuess) if (!nominal.has(c)) nominal.set(c, top(uses));
  // One glyph standing for two marks (fatha and kasra from one stroke) gets a copy for the second, so each
  // can sit in its own place.
  const cloneSrc = new Map<number, number>();
  { const owner = new Map<number, number>();
    for (const [c, g] of [...nominal]) { if (!isMark(c)) continue; if (!owner.has(g)) { owner.set(g, c); continue; } const id = CLONE + cloneSrc.size; cloneSrc.set(id, g); nominal.set(c, id); markGids.add(id); } }
  for (const [c, m] of formGlyph) nominal.set(c, m.isol ?? m.fina ?? m.init ?? m.medi!);
  const added: number[] = [];
  // (Arabic only: there the shaping that hides them always runs; a Latin letter seen only inside a ligature is
  // left to fall back, not drawn as nothing.)
  for (const c of seen) if (!nominal.has(c) && c > 0x20 && ((c >= 0x600 && c <= 0x6ff) || (c >= 0x750 && c <= 0x77f) || (c >= 0x8a0 && c <= 0x8ff))) { nominal.set(c, ADDED + added.length); added.push(c); if (isMark(c)) markGids.add(ADDED + added.length - 1); }
  if (meta.tatweel === false) nominal.delete(0x640);
  if (!nominal.size) return null;

  // GSUB: positional forms, letters drawn with their marks, marks drawn together, letter ligatures.
  const singles: Record<Form, Map<number, number>> = { isol: new Map(), fina: new Map(), medi: new Map(), init: new Map() };
  for (const [c, m] of formGlyph) {
    const nom = nominal.get(c)!;
    for (const f of FORMS) { const g = m[f]; if (g !== undefined && g !== nom) singles[f].set(nom, g); }
  }
  const after = (c: number, f: Form | null) => { const nom = nominal.get(c)!; return f ? singles[f].get(nom) ?? nom : nom; };
  const rules = (list: { seq: number[]; gid: number }[]) => {
    const m = new Map<number, { rest: number[]; gid: number }[]>();
    for (const { seq, gid } of list) {
      if (seq.length < 2) continue;
      const l = m.get(seq[0]) ?? []; if (l.some((r) => r.rest.join() === seq.slice(1).join())) continue;
      l.push({ rest: seq.slice(1), gid }); m.set(seq[0], l);
    }
    for (const l of m.values()) l.sort((a, b) => b.rest.length - a.rest.length);
    return m;
  };
  // Marks in every order: shapers sort them, each its own way (HarfBuzz puts shadda first, as Uniscribe does;
  // canonical order puts it after fatha).
  const orders = (ms: number[]): number[][] => {
    if (ms.length > 3) return [ms, [...ms].sort((a, b) => ccc(a) - ccc(b))];
    const out = new Map<string, number[]>();
    const perm = (rest: number[], acc: number[]) => { if (!rest.length) { out.set(acc.join(), acc); return; } rest.forEach((m, i) => perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, m])); };
    perm(ms, []);
    return [...out.values()];
  };
  const absorbRules = rules([...absorbed.values()].flatMap((a) => orders(a.marks).map((ms) => ({ seq: [after(a.c, a.form), ...ms.map((c) => nominal.get(c)!)], gid: a.gid }))));
  const markRules = rules([...markLigs.values()].flatMap((a) => orders(a.marks).map((ms) => ({ seq: ms.map((c) => nominal.get(c)!), gid: a.gid }))));
  // Ligatures that overlap (مي and ين in "مين") are tried in the order the PDF shows: one that won where
  // the other could have started first goes in an earlier lookup.
  const level = new Map<string, number>([...ligs.keys()].map((k) => [k, 0]));
  const beats: [string, string][] = [];
  const ligList = [...ligs.entries()];
  for (const { stream, occ } of streams) for (const o of occ) {
    for (const [yk, y] of ligList) {
      if (yk === o.key) continue;
      const n = y.comps.length;
      for (let j = Math.max(0, o.at - n + 1); j <= o.at; j++) {
        if (j + n > stream.length || (j === o.at && n <= o.len)) continue;
        // (Compared as the glyphs the shaper will have: two forms can share a glyph.)
        if (y.comps.every((cp, k) => stream[j + k].c === cp.c && after(cp.c, cp.form) === after(cp.c, stream[j + k].form))) { beats.push([o.key, yk]); break; }
      }
    }
  }
  for (let it = 0; it < 8; it++) { let changed = false; for (const [a, b] of beats) if (level.get(b)! <= level.get(a)!) { level.set(b, level.get(a)! + 1); changed = true; } if (!changed) break; }
  const ligLevels = [...new Set(level.values())].sort((a, b) => a - b).flatMap((lv) => [true, false].map((across) => ({
    flag: across ? 8 : 0,
    rules: rules([...ligs.entries()].filter(([k, a]) => level.get(k) === lv && !!a.across === across).map(([, a]) => ({ seq: a.comps.map((x) => after(x.c, x.form)), gid: a.gid }))),
  })));
  for (const a of absorbed.values()) ligGids.add(a.gid);

  // GPOS: each mark where the PDF put it on its letter (mark-to-base, one mark class per mark glyph).
  const anchors = new Map<number, Map<number, [number, number]>>(); // base → mark → offset
  // A letter's marks also attach to the glyph the shaper will pick for that letter and form.
  for (const [k, list] of [...offsets]) {
    if (!k.startsWith('L')) continue;
    const [c, f, m, ch] = k.slice(1).split('|'); const shaped = after(+c, f as Form);
    if (!offsets.has(`${shaped}|${m}|${ch}`)) offsets.set(`${shaped}|${m}|${ch}`, list);
  }
  for (const [k, list] of offsets) {
    if (k.startsWith('L')) continue;
    const [b, g, ch] = k.split('|').map(Number);
    // The mark's glyph in the new font: its copy when the glyph also stands for another mark.
    const n = ch ? nominal.get(ch) : undefined; const m = n !== undefined && (n === g || cloneSrc.get(n) === g) ? n : g;
    const xs = list.map((v) => v[0]).sort((a, c) => a - c), ys = list.map((v) => v[1]).sort((a, c) => a - c);
    const mid = (a: number[]) => a[Math.floor(a.length / 2)];
    let row = anchors.get(b); if (!row) anchors.set(b, row = new Map());
    row.set(m, [Math.round(mid(xs)), Math.round(mid(ys))]);
  }

  // Contextual variants: the usual form glyph becomes the variant the PDF drew next to that neighbour.
  const glyphsOf = new Map<number, Set<number>>();
  for (const [k, uses] of letterForm) { const c = +k.split('|')[0]; const set = glyphsOf.get(c) ?? new Set<number>(); for (const g of uses.keys()) set.add(g); glyphsOf.set(c, set); }
  for (const [c, g] of nominal) glyphsOf.get(c)?.add(g);
  // A neighbour may be part of a ligature by then (ligatures come before contextual forms): the ligatures
  // that begin (for what follows) or end (for what precedes) with that letter count as it.
  const ligStarts = new Map<number, Set<number>>(), ligEnds = new Map<number, Set<number>>();
  for (const l of ligs.values()) {
    const a = l.comps[0].c, z = l.comps[l.comps.length - 1].c;
    (ligStarts.get(a) ?? ligStarts.set(a, new Set()).get(a)!).add(l.gid);
    (ligEnds.get(z) ?? ligEnds.set(z, new Set()).get(z)!).add(l.gid);
  }
  const variants: Ctx[] = [];
  if ((globalThis as { krDebugCtx?: number }).krDebugCtx) { const c0 = (globalThis as { krDebugCtx?: number }).krDebugCtx!; console.warn('P2D ctx', JSON.stringify([...ctxNext].filter(([k]) => k.startsWith(`${c0}|`)).map(([k, u]) => [k, [...u]])), JSON.stringify([...letterForm].filter(([k]) => k.startsWith(`${c0}|`)).map(([k, u]) => [k, [...u]]))); }
  // The glyphs a letter has in one form by the time contextual forms are chosen (its form glyph, or a
  // ligature beginning — or ending — with it in that form).
  const formGlyphs = (c: number, f: Form, end: boolean) => {
    const set = new Set<number>([after(c, f)]);
    for (const l of ligs.values()) { const x = end ? l.comps[l.comps.length - 1] : l.comps[0]; if (x.c === c && x.form === f) set.add(l.gid); }
    return set;
  };
  const specific: Ctx[] = [];
  for (const [k] of letterForm) {
    const [c, f] = k.split('|'); const form = f as Form; const usual = after(+c, form);
    const before = form === 'fina';
    const chosen = new Map<number, number>(); // neighbour letter → glyph the letter-wide rule gives
    for (const g of groups(before ? ctxPrev : ctxNext, +c, form)) {
      const v = top(g.uses); chosen.set(g.other, v); if (v === usual || !g.other) continue;
      const other = new Set([...(glyphsOf.get(g.other) ?? []), ...((before ? ligEnds : ligStarts).get(g.other) ?? [])]);
      if (!other.size) continue;
      variants.push({ from: usual, to: v, ctx: [...other].sort((a, b) => a - b), before });
    }
    // Where the neighbour's form makes the difference, a rule for that form goes first.
    for (const [kf, uses] of before ? ctxPrevF : ctxNextF) {
      const [c2, f2, o, of] = kf.split('|'); if (+c2 !== +c || f2 !== f || !+o) continue;
      const v = top(uses); const n = [...uses.values()].reduce((a, b) => a + b, 0);
      if (v === (chosen.get(+o) ?? usual) || (uses.get(v) ?? 0) < Math.max(3, n * 0.6)) continue;
      // (only glyphs that are that form's own: one shared with another form would apply the rule there too)
      const ctx = formGlyphs(+o, of as Form, before);
      for (const f3 of FORMS) if (f3 !== of) for (const g3 of formGlyphs(+o, f3, before)) ctx.delete(g3);
      if (!ctx.size) continue;
      specific.push({ from: usual, to: v, ctx: [...ctx].sort((a, b) => a - b), before });
    }
  }
  variants.unshift(...specific);

  // The new font's glyphs: every glyph the document used, then the empty ones made for lone characters.
  const ids = new Set<number>(allGids);
  for (const g of nominal.values()) ids.add(g);
  const order = [...ids].filter((g) => g).sort((a, b) => a - b);
  const newId = new Map<number, number>(order.map((g, i) => [g, i + 1]));
  const m = (g: number) => newId.get(g) ?? 0;
  const mapRules = (r: Map<number, { rest: number[]; gid: number }[]>) => new Map([...r].map(([k, v]) => [m(k), v.map((x) => ({ rest: x.rest.map(m), gid: m(x.gid) }))] as [number, { rest: number[]; gid: number }[]]));
  const singlesN = Object.fromEntries(FORMS.map((f) => [f, new Map([...singles[f]].map(([a, b2]) => [m(a), m(b2)]))])) as Record<Form, Map<number, number>>;
  const variantsN = variants.map((v) => ({ from: m(v.from), to: m(v.to), ctx: v.ctx.map(m).sort((a, b) => a - b), before: v.before }));
  const anchorsN = new Map([...anchors].map(([b2, row]) => [m(b2), new Map([...row].map(([mk, o]) => [m(mk), o]))] as [number, Map<number, [number, number]>]));
  const marksN = new Set([...markGids].map(m)), ligsN = new Set([...ligGids].map(m));
  const nominalN = new Map([...nominal].map(([c, g]) => [c, m(g)]));
  const outlines: Outline[] = [{ contours: [], adv: Math.round(upem / 2) }];
  for (const g0 of order) {
    const g = cloneSrc.get(g0) ?? g0;
    if (g === ADDED - 1) { outlines.push({ contours: [], adv: Math.round(meta.space! * upem) }); continue; }
    if (g >= ADDED) { outlines.push({ contours: [], adv: 0 }); continue; }
    const src = sources[Math.floor(g / 65536)]; if (!src) { outlines.push({ contours: [], adv: 0 }); continue; }
    const o = src.outline(g % 65536); const k = upem / src.upem;
    const out = k === 1 ? { adv: o.adv, contours: o.contours } : { adv: o.adv * k, contours: o.contours.map((c) => c.map((q) => ({ x: Math.round(q.x * k), y: Math.round(q.y * k), on: q.on }))) };
    const pw = pdfAdv.get(g0); if (pw && out.contours.length) { const w = Math.round(medianOf(pw) * upem); if (w > 0 && Math.abs(w - out.adv) > upem * 0.004) out.adv = w; }
    outlines.push(out);
  }
  // Marks take no room (a legacy font may give them an advance; the PDF placed them itself) — unless the glyph
  // is also some letter's own.
  const sp = nominalN.get(0x20); if (sp && outlines[sp] && outlines[sp].adv <= 0) outlines[sp] = { contours: [], adv: Math.round((meta.space ?? 0.25) * upem) };
  const letterGlyph = new Set([...nominalN].filter(([c]) => !isMark(c)).map(([, g]) => g));
  outlines.forEach((o, i) => { if (marksN.has(i) && !letterGlyph.has(i)) o.adv = 0; });
  if (checks) console.warn('P2D check', meta.family, outlines.length, JSON.stringify(checks.map((c) => [c.text, c.bases.map(m), c.rtl ? 1 : 0])));
  const extra = new Map<string, Uint8Array>();
  extra.set('cmap', buildCmap(nominalN));
  extra.set('GSUB', buildGsub(singlesN, [{ rules: mapRules(absorbRules), flag: 0 }, { rules: mapRules(markRules), flag: 0 }, ...ligLevels.map((l) => ({ rules: mapRules(l.rules), flag: l.flag }))], variantsN));
  // Where the PDF never showed a mark on a letter, it sits centred over (or under) the letter's ink.
  const box = outlines.map((o) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const c of o.contours) for (const q of c) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } return x0 <= x1 ? [x0, y0, x1, y1] : null; });
  const markChar = new Map<number, number>(); for (const [c, g] of nominalN) if (isMark(c)) markChar.set(g, c);
  const BELOW = new Set([0x650, 0x64d, 0x655, 0x656, 0x61a, 0x6e3, 0x6ea, 0x6ed, 0x65c, 0x65f]);
  const fbMarks = [...marksN].filter((g) => box[g] && !letterGlyph.has(g)).map((g) => { const [x0, y0, x1, y1] = box[g]!; const ch = markChar.get(g); const below = ch ? BELOW.has(ch) : (y0 + y1) / 2 < upem * 0.05; return { g, below, x: Math.round((x0 + x1) / 2), y: Math.round(below ? y1 : y0) }; });
  const fbBases = outlines.map((_, g) => g).filter((g) => g > 0 && box[g] && !marksN.has(g)).map((g) => { const [x0, y0, x1, y1] = box[g]!; const pad = upem * 0.06; return { g, x: Math.round((x0 + x1) / 2), top: Math.round(Math.max(y1, upem * 0.3) + pad), bottom: Math.round(Math.min(y0, 0) - pad) }; });
  // A learnt offset that puts the mark off its letter's ink came from a mark given to the wrong letter.
  for (const [b2, row] of anchorsN) for (const [mk, [ox, oy]] of row) {
    const bb = box[b2], mb = box[mk]; if (!bb || !mb) { row.delete(mk); continue; }
    const cx = ox + (mb[0] + mb[2]) / 2, slack = upem * 0.08;
    const cy = oy + (mb[1] + mb[3]) / 2;
    if (cx < bb[0] - slack || cx > bb[2] + slack || cy < bb[1] - upem * 0.6 || cy > bb[3] + upem * 0.6) row.delete(mk);
  }
  if (anchorsN.size || (fbMarks.length && fbBases.length)) extra.set('GPOS', buildGpos(anchorsN, fbMarks, fbBases));
  extra.set('GDEF', buildGdef(marksN, ligsN));
  const k0 = upem / sources[0].upem;
  const asc = sources[0].asc !== undefined ? sources[0].asc * k0 : undefined, desc = sources[0].desc !== undefined ? sources[0].desc * k0 : undefined;
  return writeTrueType({ family: meta.family, bold: meta.bold, italic: meta.italic, upem, asc, desc }, outlines, extra,
    (box, avg) => buildOs2(upem, box, avg, nominalN, { asc: asc ?? box[3], desc: desc ?? box[1], bold: !!meta.bold, italic: !!meta.italic }));
}

function buildCmap(map: Map<number, number>): Uint8Array {
  const cs = [...map.keys()].filter((c) => c <= 0xffff).sort((a, b) => a - b);
  // Format 4 with one segment per run of consecutive characters with consecutive glyphs (delta), else per char.
  const segs: { a: number; z: number; d: number }[] = [];
  for (const c of cs) {
    const g = map.get(c)!; const s = segs[segs.length - 1];
    if (s && c === s.z + 1 && ((g - c) & 0xffff) === s.d) s.z = c; else segs.push({ a: c, z: c, d: (g - c) & 0xffff });
  }
  segs.push({ a: 0xffff, z: 0xffff, d: 1 });
  const n = segs.length; const len = 16 + n * 8;
  const sub = new Uint8Array(len); const d = dvOf(sub);
  d.setUint16(0, 4); d.setUint16(2, len); d.setUint16(4, 0); d.setUint16(6, n * 2);
  const sr = 2 * 2 ** Math.floor(Math.log2(n)); d.setUint16(8, sr); d.setUint16(10, Math.floor(Math.log2(n))); d.setUint16(12, n * 2 - sr);
  segs.forEach((s, i) => { d.setUint16(14 + i * 2, s.z); d.setUint16(16 + n * 2 + i * 2, s.a); d.setUint16(16 + n * 4 + i * 2, s.d); d.setUint16(16 + n * 6 + i * 2, 0); });
  const out = new Uint8Array(4 + 8 * 2 + len); const o = dvOf(out);
  o.setUint16(0, 0); o.setUint16(2, 2);
  o.setUint16(4, 0); o.setUint16(6, 3); o.setUint32(8, 20);
  o.setUint16(12, 3); o.setUint16(14, 1); o.setUint32(16, 20);
  out.set(sub, 20);
  return out;
}

/** A byte writer for OpenType structures with offsets filled in later. */
class W {
  b: number[] = [];
  u16(v: number) { this.b.push((v >> 8) & 255, v & 255); return this; }
  u32(v: number) { this.u16((v >>> 16) & 0xffff); this.u16(v & 0xffff); return this; }
  tag(s: string) { for (let i = 0; i < 4; i++) this.b.push(s.charCodeAt(i)); return this; }
  at(pos: number, v: number) { this.b[pos] = (v >> 8) & 255; this.b[pos + 1] = v & 255; }
  get len() { return this.b.length; }
  bytes() { return new Uint8Array(this.b); }
}

function coverage(gids: number[]): number[] {
  const w = new W(); w.u16(1).u16(gids.length); for (const g of gids) w.u16(g); return w.b;
}

type LigLookup = { rules: Map<number, { rest: number[]; gid: number }[]>; flag: number };

function ligatureSubtable(ligs: Map<number, { rest: number[]; gid: number }[]>): number[] {
  const firsts = [...ligs.keys()].sort((a, b) => a - b);
  const st = new W(); st.u16(1); const covAt = st.len; st.u16(0); st.u16(firsts.length);
  const setAt = firsts.map(() => { const p = st.len; st.u16(0); return p; });
  firsts.forEach((g, i) => {
    const setStart = st.len; st.at(setAt[i], setStart);
    const rules = ligs.get(g)!; st.u16(rules.length);
    const ruleAt = rules.map(() => { const p = st.len; st.u16(0); return p; });
    rules.forEach((r, k) => { st.at(ruleAt[k], st.len - setStart); st.u16(r.gid).u16(r.rest.length + 1); for (const x of r.rest) st.u16(x); });
  });
  st.at(covAt, st.len); pushAll(st.b, coverage(firsts));
  return st.b;
}

type Ctx = { from: number; to: number; ctx: number[]; before: boolean };

function buildGsub(singles: Record<Form, Map<number, number>>, ligLookups: LigLookup[], variants: Ctx[] = []): Uint8Array {
  const lookups: number[][] = [];
  const features: { tag: string; idx: number[] }[] = [];
  for (const f of FORMS) {
    const m = singles[f]; if (!m.size) continue;
    const from = [...m.keys()].sort((a, b) => a - b);
    const st = new W(); st.u16(2); const covAt = st.len; st.u16(0); st.u16(from.length); for (const g of from) st.u16(m.get(g)!);
    st.at(covAt, st.len); pushAll(st.b, coverage(from));
    lookups.push(lookupOf(1, st.b)); features.push({ tag: f, idx: [lookups.length - 1] });
  }
  const rlig: number[] = [];
  for (const { rules, flag } of ligLookups) { if (!rules.size) continue; lookups.push(lookupOf(4, ligatureSubtable(rules), flag)); rlig.push(lookups.length - 1); }
  if (rlig.length) features.push({ tag: 'rlig', idx: rlig });
  if (variants.length) {
    // One single substitution per (usual → variant), and one chaining lookup choosing among them by neighbour.
    const swap = new Map<string, number>();
    for (const v of variants) {
      const key = `${v.from}>${v.to}`; if (swap.has(key)) continue;
      const st = new W(); st.u16(2); const covAt = st.len; st.u16(0); st.u16(1); st.u16(v.to); st.at(covAt, st.len); pushAll(st.b, coverage([v.from]));
      lookups.push(lookupOf(1, st.b)); swap.set(key, lookups.length - 1);
    }
    const subs = variants.map((v) => {
      const st = new W(); st.u16(3);
      const covs: [number, number[]][] = [];
      const cov = (gs: number[]) => { const p = st.len; st.u16(0); covs.push([p, gs]); };
      st.u16(v.before ? 1 : 0); if (v.before) cov(v.ctx);
      st.u16(1); cov([v.from]);
      st.u16(v.before ? 0 : 1); if (!v.before) cov(v.ctx);
      st.u16(1); st.u16(0).u16(swap.get(`${v.from}>${v.to}`)!);
      for (const [p, gs] of covs) { st.at(p, st.len); pushAll(st.b, coverage(gs)); }
      return st.b;
    });
    lookups.push(lookupMany(6, subs, 8)); features.push({ tag: 'calt', idx: [lookups.length - 1] });
  }
  return layoutTable(features, lookups);
}

/** GSUB/GPOS common part: scripts DFLT and arab (default language: every feature), features, lookups. */
function layoutTable(features: { tag: string; idx: number[] }[], lookups: number[][], extType = 7): Uint8Array {
  features.sort((x, y) => (x.tag < y.tag ? -1 : x.tag > y.tag ? 1 : 0));
  const feats = features.map((_, i) => i);
  const sl = new W(); sl.u16(2);
  const sAt = ['DFLT', 'arab'].map((s) => { sl.tag(s); const p = sl.len; sl.u16(0); return p; });
  for (const p of sAt) { sl.at(p, sl.len); sl.u16(4).u16(0); sl.u16(0).u16(0xffff).u16(feats.length); for (const i of feats) sl.u16(i); }
  const fl = new W(); fl.u16(features.length);
  const fAt = features.map((f) => { fl.tag(f.tag); const p = fl.len; fl.u16(0); return p; });
  features.forEach((f, i) => { fl.at(fAt[i], fl.len); fl.u16(0).u16(f.idx.length); for (const x of f.idx) fl.u16(x); });
  // The lookup list's offsets are 16-bit: a list that would outgrow them (a long book's many contextual
  // variants) is written with extension lookups, each pointing 32 bits away to its subtable, kept after
  // the list.
  const plainLen = 2 + lookups.length * 2 + lookups.reduce((n, lk) => n + lk.length, 0);
  const ll = new W(); ll.u16(lookups.length);
  const lAt = lookups.map(() => { const p = ll.len; ll.u16(0); return p; });
  if (plainLen <= 0xfff0) lookups.forEach((lk, i) => { ll.at(lAt[i], ll.len); pushAll(ll.b, lk); });
  else {
    const parts: { lk: number[]; type: number; flag: number; subs: [number, number][] }[] = lookups.map((lk) => {
      const type = (lk[0] << 8) | lk[1], flag = (lk[2] << 8) | lk[3], count = (lk[4] << 8) | lk[5];
      const offs: number[] = []; for (let i = 0; i < count; i++) offs.push((lk[6 + i * 2] << 8) | lk[7 + i * 2]);
      const sorted = [...offs].sort((a, b) => a - b);
      return { lk, type, flag, subs: offs.map((o) => [o, sorted[sorted.indexOf(o) + 1] ?? lk.length]) };
    });
    // (Each lookup: its header and extension records; the subtables themselves follow the whole list.)
    let tail = 0;
    for (const prt of parts) tail += 6 + prt.subs.length * 2 + prt.subs.length * 8;
    const blob = new W(); const base = ll.len + tail; // where the blob starts, from the list's start
    parts.forEach((prt, i) => {
      ll.at(lAt[i], ll.len); const start = ll.len;
      ll.u16(extType).u16(prt.flag).u16(prt.subs.length);
      const eAt = prt.subs.map(() => { const p = ll.len; ll.u16(0); return p; });
      prt.subs.forEach(([a, z], k) => {
        ll.at(eAt[k], ll.len - start);
        const here = ll.len; // the extension record's own position
        ll.u16(1).u16(prt.type); ll.u32(base + blob.len - here);
        for (let j = a; j < z; j++) blob.b.push(prt.lk[j]);
      });
    });
    pushAll(ll.b, blob.b);
  }
  const g = new W(); g.u32(0x00010000); g.u16(10); g.u16(10 + sl.len); g.u16(10 + sl.len + fl.len);
  pushAll(g.b, sl.b); pushAll(g.b, fl.b); pushAll(g.b, ll.b);
  return g.bytes();
}

function lookupMany(type: number, subs: number[][], flag = 0): number[] {
  const w = new W(); w.u16(type).u16(flag).u16(subs.length);
  const at = subs.map(() => { const p = w.len; w.u16(0); return p; });
  subs.forEach((sb, i) => { w.at(at[i], w.len); pushAll(w.b, sb); });
  return w.b;
}

function lookupOf(type: number, sub: number[], flag = 0): number[] {
  const w = new W(); w.u16(type).u16(flag).u16(1).u16(8); pushAll(w.b, sub); return w.b;
}

/** Mark-to-base positioning: every mark glyph its own class, anchored at (0,0); each base has, for each mark
 *  seen on it, the offset at which the PDF drew that mark. */
/** Mark-to-base positioning in two lookups. First, every mark over (or under) every letter's ink — two
 *  classes, above and below; then, overriding it, each mark at the offset where the PDF drew it on that
 *  letter (each mark its own class, anchored at its origin). */
function buildGpos(anchors: Map<number, Map<number, [number, number]>>, fbMarks: { g: number; below: boolean; x: number; y: number }[] = [], fbBases: { g: number; x: number; top: number; bottom: number }[] = []): Uint8Array {
  const markBase = (marks: number[], markAnchor: (m: number) => [number, number, number], bases: number[], baseAnchor: (b: number, cls: number) => [number, number] | null, nCls: number): number[] => {
    const st = new W();
    st.u16(1); const mcAt = st.len; st.u16(0); const bcAt = st.len; st.u16(0); st.u16(nCls); const maAt = st.len; st.u16(0); const baAt = st.len; st.u16(0);
    st.at(maAt, st.len); const ma = st.len; st.u16(marks.length);
    const mrAt = marks.map((m) => { st.u16(markAnchor(m)[0]); const p = st.len; st.u16(0); return p; });
    marks.forEach((m, i) => { const [, x, y] = markAnchor(m); st.at(mrAt[i], st.len - ma); st.u16(1).u16(x & 0xffff).u16(y & 0xffff); });
    st.at(baAt, st.len); const ba = st.len; st.u16(bases.length);
    const slots = bases.map((b) => Array.from({ length: nCls }, (_, k) => { const p = st.len; st.u16(0); return baseAnchor(b, k) ? p : -1; }));
    // Identical anchors are written once.
    const seen = new Map<string, number>();
    bases.forEach((b, i) => { for (let k = 0; k < nCls; k++) {
      const p = slots[i][k]; if (p < 0) continue;
      const [x, y] = baseAnchor(b, k)!; const key = `${x},${y}`;
      let at = seen.get(key); if (at === undefined) { at = st.len; seen.set(key, at); st.u16(1).u16(x & 0xffff).u16(y & 0xffff); }
      st.at(p, at - ba);
    } });
    st.at(mcAt, st.len); pushAll(st.b, coverage(marks));
    st.at(bcAt, st.len); pushAll(st.b, coverage(bases));
    return lookupOf(4, st.b);
  };
  const lookups: number[][] = [];
  if (fbMarks.length && fbBases.length) {
    const fm = new Map(fbMarks.map((m) => [m.g, m])); const fb = new Map(fbBases.map((b) => [b.g, b]));
    lookups.push(markBase([...fm.keys()].sort((a, b) => a - b), (m) => { const x = fm.get(m)!; return [x.below ? 1 : 0, x.x, x.y]; }, [...fb.keys()].sort((a, b) => a - b), (b, k) => { const x = fb.get(b)!; return [x.x, k ? x.bottom : x.top]; }, 2));
  }
  const marks = [...new Set([...anchors.values()].flatMap((r) => [...r.keys()]))].sort((a, b) => a - b);
  const bases = [...anchors.keys()].filter((b) => !marks.includes(b)).sort((a, b) => a - b);
  if (marks.length && bases.length) {
    const cls = new Map(marks.map((m, i) => [m, i]));
    lookups.push(markBase(marks, (m) => [cls.get(m)!, 0, 0], bases, (b, k) => anchors.get(b)!.get(marks[k]) ?? null, marks.length));
  }
  return layoutTable([{ tag: 'mark', idx: lookups.map((_, i) => i) }], lookups, 9);
}

/** Glyph classes: marks (so ligatures skip them and they attach to letters), ligatures; the rest bases. */
function buildGdef(marks: Set<number>, ligs: Set<number>): Uint8Array {
  const entries = [...[...marks].map((g) => [g, 3] as const), ...[...ligs].filter((g) => !marks.has(g)).map((g) => [g, 1] as const)].sort((a, b) => a[0] - b[0]);
  const w = new W(); w.u32(0x00010000).u16(12).u16(0).u16(0).u16(0);
  w.u16(2).u16(entries.length); for (const [g, c] of entries) w.u16(g).u16(g).u16(c);
  return w.bytes();
}

function buildOs2(em: number, box: [number, number, number, number], avg: number, nominal: Map<number, number>, v: { asc: number; desc: number; bold: boolean; italic: boolean }): Uint8Array {
  const cs = [...nominal.keys()].filter((c) => c <= 0xffff);
  const arabic = cs.some((c) => c >= 0x600 && c <= 0x6ff);
  const w = new W();
  w.u16(4).u16(avg).u16(v.bold ? 700 : 400).u16(5).u16(0); // version, xAvgCharWidth, weight, width, fsType: installable
  for (const x of [Math.round(em * 0.65), Math.round(em * 0.6), 0, Math.round(em * 0.075), Math.round(em * 0.65), Math.round(em * 0.6), 0, Math.round(em * 0.48), Math.round(em * 0.05), Math.round(em * 0.25)]) w.u16(x & 0xffff);
  w.u16(0); // sFamilyClass
  for (let i = 0; i < 10; i++) w.b.push(0); // panose
  w.u32(1 | (arabic ? 1 << 13 : 0)).u32(0).u32(0).u32(0); // Unicode ranges: Basic Latin, Arabic
  w.tag('KRDR');
  w.u16((v.bold ? 0x20 : 0) | (v.italic ? 1 : 0) | (!v.bold && !v.italic ? 0x40 : 0));
  w.u16(cs.length ? Math.min(...cs) : 0x20).u16(cs.length ? Math.max(...cs) : 0x20);
  const asc = Math.round(v.asc), desc = Math.round(v.desc);
  w.u16(asc & 0xffff).u16(desc & 0xffff).u16(0);
  w.u16(Math.max(0, asc, box[3])).u16(Math.max(0, -desc, -box[1]));
  w.u32(1 | (arabic ? 1 << 6 : 0)).u32(0); // code pages: Latin 1, Arabic
  w.u16(Math.round(em * 0.5)).u16(Math.round(em * 0.7)).u16(0).u16(0x20).u16(0);
  return w.bytes();
}

