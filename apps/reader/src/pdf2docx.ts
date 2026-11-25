// PDF → DOCX that keeps the page: every PDF page becomes a Word section of the same size and
// margins; its decorations (frames, ornaments, rules, pictures) are drawn once without text and laid
// behind it; the text is real, editable Word text — paragraphs with their alignment, indents,
// spacing and line pitch, runs with their font, size, weight and colour, two-column verse as a
// borderless table, the running head in the page header, and footnotes as Word footnotes.
// Arabic is right-to-left throughout (bidi paragraphs and tables, complex-script fonts and sizes).
import { findVertical, plainVerticalForms } from './pdfvertical';
import { cmapsUrl } from './slim';
import { buildFont, plainFont, type GlyphUse, type Use, type GlyphSource } from './fontfix';
import { GlyphRuns } from './glyphruns';
import { readSfnt, cmapGlyphs, glyphReader, verticalMetrics, renamedFont, type Outline } from './fontbuild';
import { loadPdfjs, offscreen } from './pdfjsload';
import { type ZipLike } from './ziputil';
import { LinePack, unpackLines } from './fontpack';
import { onPhone } from './platform';
import { cleanPdfText, isRtlText, joinLine, COMBINING, attachMarks, logicalNeutral, fixLoneBrackets, dropBuriedSpaces, balanceBrackets, numberRunsForward, ltrRunsForward } from './pdftext';
import type { Book } from './db';
import type { Progress } from './convert';

type PdfJs = Awaited<ReturnType<typeof loadPdfjs>>;
/** The result asked for: «Easy to edit» (the default) — real paragraphs, headings, lists, links, footnotes and
 *  pictures in the text, still looking like the page — or «Exact look» (edit false): every line where the page
 *  sets it, the page's furniture pinned in the header parts. Set by the conversion, for its pages (and its lanes). */
export const p2d = { edit: true };
export type FontInfo = { family: string; bold: boolean; italic: boolean; raw?: Uint8Array; noUnicode?: boolean; symbolic?: boolean; cov?: Set<number>; winCov?: Set<number>; weight?: number; serif?: boolean; mono?: boolean; rebuilt?: boolean; spaceCode?: number; src?: { data: Uint8Array; toFontChar: Record<string, number> }; legacy?: boolean; uses?: number; spaceW?: number; gaps?: number[]; wordFont?: boolean };
/** How the document uses its embedded fonts' glyphs: runs of glyphs along a line, cut where a word ends (each
 *  glyph tagged with its PDF font — a legacy Arabic font spreads one word over several). */
export type UseStore = { seqs: GlyphRuns; seen: Map<string, Set<number>>;
  /** The same font under two names (a second copy of the document names its fonts afresh): the other name → the first. */
  same?: Map<string, string>; byFile?: Map<string, string>;
  /** For a reader of only some of the pages (a lane, see pdf2docx.lane.ts): the page's fonts in the order its text
   *  meets them, the fonts whose glyph words a word font found on an earlier page would have read otherwise, and
   *  a word on each font as it is first met. */
  pageFonts?: string[]; stickyMiss?: Set<string>; onFont?: (name: string, info: FontInfo, fo: unknown) => void;
  /** Every glyph run kept (a lane: the cap on uses is applied where the lanes' pages come together). */
  keepAll?: boolean };
const USE_CAP = 150000; // glyph uses kept per font (later only for glyphs not seen yet)

type Piece = { /** For a document to edit: the link the piece stands in (a URL, or #ref of a page in the file). */ link?: string; /** For a document to edit: underlined (its colour), struck, shaded (its colour) — see decorate. */ u?: string; /** a piece kept as drawn: its text */ was?: string; strike?: boolean; shd?: string; text: string; l: number; r: number; y: number; h: number; font: string; drawnAs?: string; color: string; bold: boolean; hidden?: boolean; sup?: boolean; art?: boolean; codes?: GlyphUse[]; conn?: boolean; ordered?: boolean; keep?: boolean; raw?: boolean; inked?: boolean; pic?: { png: Uint8Array; kind?: 'png' | 'jpg'; w: number; h: number; drop: number };
  /** Marks put into this piece's text that the page draws in a colour of their own (a red haraka on a black letter). */
  tints?: { base: string; mark: string; color: string }[] };
/** OS/2 of a TrueType font: weight, italic, and the Unicode/code-page ranges Word reads as its signature. */
type Os2 = { weight: number; italic: boolean; bold: boolean; usb: number[]; csb: number[]; panose?: string };
type Line = { pieces: Piece[]; base: number; size: number; l: number; r: number; rtl: boolean; spacer?: number; grid?: GridSpec };
/** A page area in PDF coordinates (y up). */
type Box = { l: number; r: number; top: number; bottom: number };
/** (`fk`: the PDF font the run was set in — its key in the converter's font map — so that two different fonts
 *  that give themselves one name can be told apart once all pages are read; see buildDocFonts.) */
export type Run = { link?: string; u?: string; strike?: boolean; shd?: string; text: string; font: string; size: number; bold: boolean; italic: boolean; color: string; rtl: boolean; sup: boolean; note?: number; br?: boolean; /** Where a line of the page joins the one before in a paragraph to edit (no line break: a space, or a hyphen's word made whole — see joinLines). */ lj?: boolean; tab?: number; tabEnd?: number; raise?: number; kText?: string; cs?: number; spacing?: number; art?: Piece; fk?: string };
/** heading: for a document to edit, the paragraph's heading level (0 the title, 1–3); list: its list item (its
 *  list, level, and where its mark and text start, points from the text's edge). */
type Para = { kind: 'p'; heading?: number; list?: { id: number; lvl: number }; runs: Run[]; align: 'start' | 'end' | 'center' | 'both'; kashida?: boolean; rtl: boolean; indStart: number; indEnd: number; firstLine: number; before: number; pitch: number; size: number; tabs?: { pos: number; type: 'left' | 'right' | 'center' }[]; /** its first line's baseline (PDF units, from the page's foot) */ base0?: number; /** its last line's */ base1?: number; /** For a list item: where the text after its mark starts (points from the text's start edge). */ lead?: number; /** its indent is its list level's */ listInd?: boolean; /** For a document to edit: rules drawn over / under it (sz eighths of a point, space points). */ bdr?: { top?: { sz: number; color: string; space: number }; bottom?: { sz: number; color: string; space: number } } };
type Verse = { kind: 'verse'; rows: Run[][][]; rtl: boolean; before: number; pitch: number; size: number; width: number; indStart: number; midW: number; gap: number; exts?: [number, number][]; lead?: boolean };
/** A ruled table: its columns (page x, left to right) and rows (page y, top down), and per row its cells
 *  left to right — each spanning `span` columns, `cont` when it carries on the cell above (no rule between). */
type GridCell = { c0: number; span: number; cont?: boolean; lines: Piece[][]; fill?: string };
/** rules: an open table's (booktabs': rules across, none down) — whether a rule is drawn at each of ys. */
type GridSpec = { xs: number[]; ys: number[]; rows: GridCell[][]; rule: number; rules?: boolean[] };
type Grid = { kind: 'grid'; /** For a document to edit: its first row is its header (Word repeats it on each page). */ header?: boolean; pad: number; rows: Run[][][]; cells: { span: number; vmerge?: 'restart' | 'continue'; align: Para['align']; vcenter: boolean; pitch: number }[][]; spec: GridSpec; colW: number[]; rowH: number[]; rtl: boolean; before: number; indStart: number; size: number; pitch: number };
type Block = Para | Verse | Grid;
type Note = { num: number; paras: Block[] };
/** A running head or page number: its runs, centre and baseline (points from the page's top). `num`: the page
 *  number it holds (between those characters of its text, as the page writes it), for a PAGE field. */
type Furniture = { runs: Run[]; cx: number; base: number; size: number; top: boolean; num?: { from: number; to: number; value: number; fmt: 'decimal' | 'hindiNumbers' | 'lowerRoman' | 'upperRoman' } };
/** Part of a page: full width (one column) or set in columns (blocks per column in reading order, column edges in page x). */
type Region = { cols: Block[][]; edges: [number, number][] };
/** A box of text at its own place on a designed page (points from the page's top-left corner). */
type PlacedBox = { x: number; y: number; w: number; h: number; blocks: Block[] };
/** A page set in vertical writing: its paragraphs (columns run together) and where its columns stand. */
type VPage = { paras: { runs: Run[]; firstLine: number }[]; pitch: number; size: number; top: number; bottom: number; left: number; right: number };
/** Text set at an angle (a design's stamp, a label up the side): one text box, turned, in page points from the top-left. */
type TextBox = { runs: Run[]; x: number; y: number; w: number; h: number; rot: number; line: number };
export type PageModel = { /** For a document to edit: the page goes on from the one before (a paragraph ran over), no page break before it. */ cont?: boolean; /** The lowest baseline of its text (body and notes, page units from the foot) and its text's usual pitch: whether the page was simply full. */ low?: number; lowPitch?: number; /** The page's own object in the file (num_gen): what a link to it names. */ ref?: string; /** For a document to edit: a link to this page lands here (its bookmark's name). */ mark?: string; vert?: VPage; w: number; h: number; pics: Pic[]; boxes?: TextBox[]; furniture: Furniture[]; regions?: Region[]; placed?: PlacedBox[]; header: Block[]; footer: Block[]; body: Block[]; notes: Note[]; notesRaw: Block[]; notesBox: { top: number; bottom: number; l: number; r: number } | null; /** Where the notes' first line box starts (points from the page's top). */ notesAt?: number; bodyBottom: number;
  /** The lines taken for the running head as text blocks, and where they start and end (points from the top). */ uncut?: { blocks: Block[]; top: number; bottom: number }; m: { top: number; bottom: number; left: number; right: number; header: number; footer: number; /** Room left beyond the text's edges on each side (points), which the paragraphs' indents take back on their aligned side. */ slack?: [number, number] } };

const PT = 20; // twips per point
// In a line with exact spacing Word puts the baseline about 4/5 of the line height below the line's top.
const BASE = 0.8;
// Word footnotes reflow nicely when the text is edited, but Word lays out the footnote area its own way;
// keeping the notes in the page's flow reproduces the page exactly. Fidelity first.
const EMU = 12700; // EMU per point
const DIGITS = /^[\s(（[]*([0-9٠-٩۰-۹]+)[\s)）\]]*$/;
const toInt = (s: string) => parseInt(s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)), 10);
/** A list item's mark at the start of a line: a bullet or dash, a number or letter with its stop or brackets. */
const LIST_MARK = /^\s*(?:[\u2022\u25e6\u25aa\u25ab\u25a0\u25cf\u25cb\u2023\u2219\u00b7\u2043\u2013\u2014\-*\uf0b7\uf0a7\uf0d8]\s|\(?(?:[0-9]{1,3}|[a-zA-Z]|[ivxIVX]{1,4}|[\u0621-\u064a])[.)]\s|[0-9\u0660-\u0669\u06f0-\u06f9]{1,3}\s?[\-\u2013]\s|\([0-9a-zA-Z\u0621-\u064a]{1,3}\)\s)/;
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** "ABCDEE+KFGQPC Uthman Taha Naskh,Bold" → family "KFGQPC Uthman Taha Naskh", bold. */
function parseFontName(name: string | undefined, fo: { bold?: boolean; black?: boolean; italic?: boolean } | null): Omit<FontInfo, 'raw'> {
  let n = (name || 'Times New Roman').replace(/^[A-Z]{6}\+/, '');
  let bold = !!(fo?.bold || fo?.black), italic = !!fo?.italic;
  const comma = n.split(',');
  if (comma.length > 1) { const st = comma.slice(1).join(','); if (/bold|black|heavy/i.test(st)) bold = true; if (/italic|oblique/i.test(st)) italic = true; n = comma[0]; }
  const m = /^(.*?)[-_](Bold|BoldMT|BoldItalic|BoldItalicMT|Italic|ItalicMT|Regular|MT|PSMT|Roman|Book|Medium|Black|Heavy)$/i.exec(n);
  if (m) { if (/bold|black|heavy/i.test(m[2])) bold = true; if (/italic/i.test(m[2])) italic = true; n = m[1]; }
  // TeX and other compact names: CMBX10 (bold extended), CMTI10 (text italic), LMRoman10-Bold, …
  const low = n.toLowerCase();
  if (/^(cm|lm|ec|tc)?bx|^cmb\d|^cmssbx|bold|black|heavy|semibold|demi/.test(low)) bold = true;
  if (/^(cm|ec)(ti|sl|mi|itt|ssi)\d|^cmbxti|^cmbxsl|italic|oblique/.test(low)) italic = true;
  n = n.replace(/([a-z])([A-Z])/g, (s, a: string, b: string) => (/^(Times|Courier|Arial|Traditional|Simplified)/.test(n) ? `${a} ${b}` : s)).replace(/PSMT$|MT$/, '').trim();
  if (/^TimesNewRoman/i.test(n.replace(/\s/g, ''))) n = 'Times New Roman';
  if (/^Arial$/i.test(n.replace(/\s/g, ''))) n = 'Arial';
  return { family: n || 'Times New Roman', bold, italic };
}

/** Fonts any word processor can be expected to have (or map well by itself). */
const COMMON_FONTS = /^(Arial|Arial Black|Arial Narrow|Times New Roman|Courier New|Calibri|Cambria|Cambria Math|Candara|Consolas|Constantia|Corbel|Georgia|Verdana|Tahoma|Trebuchet MS|Segoe UI|Garamond|Book Antiqua|Palatino Linotype|Century Gothic|Gill Sans MT|Lucida Console|Lucida Sans Unicode|Symbol|Wingdings|Webdings|Traditional Arabic|Simplified Arabic|Arabic Typesetting|Sakkal Majalla|Andalus|Microsoft Sans Serif|Microsoft Uighur|Aldhabi|Urdu Typesetting|MS Mincho|MS Gothic|SimSun|SimHei|Microsoft YaHei|Malgun Gothic|Batang|Liberation (Serif|Sans|Mono)|DejaVu (Serif|Sans|Sans Mono)|Noto .*)$/i;

/** What to write instead of a font the reader will not have and the file cannot carry (TeX's Computer
 *  Modern, a Type 3 font, a PostScript-only face): the common font of the same kind, so the text keeps
 *  roughly its width and look. Times New Roman is narrower than most book faces, so justified lines
 *  stay on one line. Returns null to keep the name. */
function fontSubstitute(family: string, f: { serif?: boolean; mono?: boolean } | undefined): { latin: string; cs: string; ea: string } | null {
  if (COMMON_FONTS.test(family)) return null;
  const n = family.toLowerCase().replace(/\s+/g, '');
  if (/^helvetica|^arialmt/.test(n)) return { latin: 'Arial', cs: 'Arial', ea: 'Arial' };
  if (/^times/.test(n)) return { latin: 'Times New Roman', cs: 'Times New Roman', ea: 'Times New Roman' };
  if (/^courier/.test(n)) return { latin: 'Courier New', cs: 'Courier New', ea: 'Courier New' };
  const mono = f?.mono || /mono|courier|^cmtt|^sftt|typewriter|consol|code|inconsolata|menlo|monaco|^lmmono/.test(n);
  if (mono) return { latin: 'Courier New', cs: 'Courier New', ea: 'MS Gothic' };
  const sans = /sans|^cmss|^sfss|grotesk|gothic|helvet|arial|verdana|tahoma|calibri|segoe|frutiger|futura|roboto|opensans|lato|myriad|source ?sans|univers|avenir|kufi/.test(n) && !/serif/.test(n);
  if (sans) return { latin: 'Arial', cs: 'Arial', ea: 'Microsoft YaHei' };
  return { latin: 'Times New Roman', cs: 'Traditional Arabic', ea: 'SimSun' };
}

/** The family name a TrueType font gives itself (name table: typographic family, else family). */
function fontFamilyName(bytes: Uint8Array): string | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint16(4); let nt = -1;
    for (let i = 0; i < n; i++) { const r = 12 + i * 16; if (String.fromCharCode(...bytes.subarray(r, r + 4)) === 'name') nt = dv.getUint32(r + 8); }
    if (nt < 0) return null;
    const count = dv.getUint16(nt + 2), strings = nt + dv.getUint16(nt + 4);
    const found: Record<number, string> = {};
    // (A symbol font names itself in its symbol records only (Windows, encoding 0): those are what Word and
    // LibreOffice register it under — taken when it has no other.)
    const sym: Record<number, string> = {};
    for (let i = 0; i < count; i++) {
      const r = nt + 6 + i * 12;
      const pid = dv.getUint16(r), eid = dv.getUint16(r + 2), lang = dv.getUint16(r + 4), id = dv.getUint16(r + 6), len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
      if (id !== 1 && id !== 16) continue;
      let str = '';
      if (pid === 3 || pid === 0) { for (let k = 0; k < len; k += 2) str += String.fromCharCode(dv.getUint16(strings + off + k)); if (pid === 3 && eid === 0) { if (str.trim() && (sym[id] === undefined || lang === 0x409)) sym[id] = str.trim(); continue; } }
      else if (pid === 1) { for (let k = 0; k < len; k++) str += String.fromCharCode(bytes[strings + off + k]); }
      // Prefer the English (US) name.
      if (str && (found[id] === undefined || (pid === 3 && lang === 0x409))) found[id] = str.trim();
    }
    const name = found[1] || found[16] || sym[1] || sym[16]; // Word selects by the legacy family name
    return name && !/^[A-Z]{6}\+/.test(name) ? name.replace(/^[A-Z]{6}\+/, '') : name?.replace(/^[A-Z]{6}\+/, '') || null;
  } catch { return null; }
}

function readOs2(bytes: Uint8Array): Os2 | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint16(4); let o = -1;
    for (let i = 0; i < n; i++) { const r = 12 + i * 16; if (String.fromCharCode(...bytes.subarray(r, r + 4)) === 'OS/2') o = dv.getUint32(r + 8); }
    if (o < 0) return null;
    const version = dv.getUint16(o), sel = dv.getUint16(o + 62);
    return { weight: dv.getUint16(o + 4), italic: !!(sel & 1), bold: !!(sel & 32), usb: [42, 46, 50, 54].map((k) => dv.getUint32(o + k)), csb: version >= 1 ? [dv.getUint32(o + 78), dv.getUint32(o + 82)] : [1, 0], panose: Array.from(bytes.subarray(o + 32, o + 42), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase() };
  } catch { return null; }
}

/** A font's "single" line as Word and LibreOffice set it, in ems: Word takes the Windows ascent and descent (and the
 *  hhea line gap beyond them), LibreOffice the same unless the font asks for its typographic metrics
 *  (USE_TYPO_METRICS); where the two differ, the mean. */
export function lineFactor(bytes: Uint8Array): number | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint16(4); const T: Record<string, number> = {};
    for (let i = 0; i < n; i++) { const r = 12 + i * 16; T[String.fromCharCode(...bytes.subarray(r, r + 4))] = dv.getUint32(r + 8); }
    if (T.head === undefined || T.hhea === undefined) return null;
    const upm = dv.getUint16(T.head + 18) || 1000;
    const hAsc = dv.getInt16(T.hhea + 4), hDesc = dv.getInt16(T.hhea + 6), hGap = dv.getInt16(T.hhea + 8);
    const hhea = (hAsc - hDesc + Math.max(0, hGap)) / upm;
    if (T['OS/2'] === undefined) return hhea > 0.8 && hhea < 3 ? hhea : null;
    const o = T['OS/2']; const sel = dv.getUint16(o + 62);
    const tA = dv.getInt16(o + 68), tD = dv.getInt16(o + 70), tG = dv.getInt16(o + 72), wA = dv.getUint16(o + 74), wD = dv.getUint16(o + 76);
    const word = wA + wD > 0 ? (wA + wD + Math.max(0, hGap - (wA + wD - (hAsc - hDesc)))) / upm : hhea;
    const lo = sel & 128 && tA - tD > 0 ? (tA - tD + Math.max(0, tG)) / upm : wA + wD > 0 ? (wA + wD) / upm : hhea;
    const f = (word + lo) / 2;
    return f > 0.8 && f < 3 ? f : null;
  } catch { return null; }
}
/** The "single" line of common fonts a document names without carrying them (as their metric twins set it). */
const NAMED_LINE: Record<string, number> = { 'Times New Roman': 1.15, Arial: 1.15, Helvetica: 1.15, 'Liberation Serif': 1.15, 'Liberation Sans': 1.15, 'Liberation Mono': 1.13, 'Courier New': 1.13, Courier: 1.13, Calibri: 1.22, Carlito: 1.22, Cambria: 1.17, Caladea: 1.17, Georgia: 1.14, Verdana: 1.22, Tahoma: 1.21, 'Segoe UI': 1.33, 'DejaVu Sans': 1.16, 'DejaVu Serif': 1.16, 'DejaVu Sans Mono': 1.16, 'Noto Sans': 1.36, 'Noto Serif': 1.36, Symbol: 1.23, 'Noto Sans CJK JP': 1.45, 'Noto Sans CJK SC': 1.45, 'Noto Sans CJK TC': 1.45, 'Noto Sans CJK KR': 1.45, 'Noto Serif CJK JP': 1.45, 'Noto Serif CJK SC': 1.45, 'MS Mincho': 1.0, SimSun: 1.0 };

/** Code points a TrueType font's cmap covers (to decide whether embedding it can render the text). */
/** Text without the tatweels that stretch its words; a tatweel standing alone between spaces is a dash
 *  ("أي شجاع ـ تحمّل") and stays. */
// (The hijri year's «هـ» — a lone ه, the tatweel after it, the word's end — is spelt with its tatweel: kept.)
const dropStretch = (s: string) => s.replace(/\u0640+/g, (m, at: number) => (s[at - 1] === '\u0647' && !/[\u0621-\u064A\u0640]/.test(s[at - 2] ?? ' ') && !/[\u0621-\u0652]/.test(s[at + m.length] ?? ' ') ? '\u0640'
  : /[^\s(\[«"'-]/.test(s[at - 1] ?? ' ') || /[^\s)\]»"'.,،؛:-]/.test(s[at + m.length] ?? ' ') ? '' : m));

const HONORIFICS: Record<string, string> = { 'صلى الله عليه وسلم': '\uFDFA', 'صلى الله عليه و سلم': '\uFDFA', 'جل جلاله': '\uFDFB', 'بسم الله الرحمن الرحيم': '\uFDFD' };

/** Whether a font's embedding permissions (OS/2 fsType) allow it in a document that can be edited. */
function editableFont(bytes: Uint8Array): boolean {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0, n = dv.getUint16(4); i < n; i++) {
      const r = 12 + i * 16;
      if (String.fromCharCode(...bytes.subarray(r, r + 4)) === 'OS/2') { const t = dv.getUint16(dv.getUint32(r + 8) + 8); return (t & 0x6) === 0; }
    }
    return true;
  } catch { return false; }
}

/** Whether a font's OS/2 fsType lets it travel in a document that can be edited: installable (0) or editable
 *  (8) — the least restrictive bit set wins — not preview & print (4) or restricted (2) alone. */
function embeddable(bytes: Uint8Array): boolean {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0, n = dv.getUint16(4); i < n; i++) {
      const r = 12 + i * 16;
      if (String.fromCharCode(...bytes.subarray(r, r + 4)) === 'OS/2') { const t = dv.getUint16(dv.getUint32(r + 8) + 8); return !(t & 0x6) || !!(t & 0x8); }
    }
    return true;
  } catch { return true; }
}

function cmapCoverage(bytes: Uint8Array, windowsOnly = false): Set<number> {
  const out = new Set<number>();
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint16(4); let cm = -1;
    for (let i = 0; i < n; i++) { const r = 12 + i * 16; if (String.fromCharCode(...bytes.subarray(r, r + 4)) === 'cmap') cm = dv.getUint32(r + 8); }
    if (cm < 0) return out;
    for (let i = 0, nn = dv.getUint16(cm + 2); i < nn; i++) {
      const p = dv.getUint16(cm + 4 + i * 8), e = dv.getUint16(cm + 6 + i * 8), s = cm + dv.getUint32(cm + 8 + i * 8);
      if (!(p === 3 && (e === 1 || e === 10 || (windowsOnly && e === 0)) || (p === 0 && !windowsOnly))) continue;
      const fmt = dv.getUint16(s);
      if (fmt === 4) {
        const seg = dv.getUint16(s + 6) / 2, ends = s + 14, starts = ends + seg * 2 + 2;
        for (let k = 0; k < seg; k++) { const a = dv.getUint16(starts + k * 2), b = dv.getUint16(ends + k * 2); if (a !== 0xffff) for (let c = a; c <= b; c++) out.add(c); }
      } else if (fmt === 12) {
        for (let k = 0, g = dv.getUint32(s + 12); k < g; k++) { const a = dv.getUint32(s + 16 + k * 12), b = dv.getUint32(s + 20 + k * 12); for (let c = a; c <= b && c - a < 0x10000; c++) out.add(c); }
      }
    }
  } catch { /* unreadable: no coverage */ }
  return out;
}

async function canvasPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => { let done = false; const t = setTimeout(() => { if (!done) { done = true; res(null); } }, 4000); c.toBlob((b) => { if (!done) { done = true; clearTimeout(t); res(b); } }, 'image/png'); });
  if (blob) return new Uint8Array(await blob.arrayBuffer());
  const u = c.toDataURL('image/png'); const bin = atob(u.split(',')[1]); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a;
}

type Pic = { png: Uint8Array; kind?: 'png' | 'jpg'; x: number; y: number; w: number; h: number };

/** Pictures still being encoded (the browser encodes them off this thread): the pages go on meanwhile, and the
 *  document is built once they are all in. */
let pendingPngs: Promise<void>[] = [];
/** Pictures met so far, by their size and a hash of their ends: the same ornament or frame drawn on every page of
 *  a book is held once, not once per page until the end (28 MB of one book's 5). Cleared after each document. */
const pngSeen = new Map<string, Uint8Array[]>();
function samePng(b: Uint8Array): Uint8Array {
  if (!b.length) return b;
  let h = 0x811c9dc5; const step = (i: number) => { h ^= b[i]; h = Math.imul(h, 0x01000193); };
  for (let i = 0; i < Math.min(2048, b.length); i++) step(i);
  for (let i = Math.max(2048, b.length - 2048); i < b.length; i++) step(i);
  const key = `${b.length}:${h >>> 0}`; const list = pngSeen.get(key);
  if (!list) { pngSeen.set(key, [b]); return b; }
  for (const o of list) { let i = 0; while (i < b.length && o[i] === b[i]) i++; if (i === b.length) return o; }
  list.push(b); return b;
}
/** (Debug: with `globalThis.krMem = []` set, the converter notes the JS heap at each stage — after a full
 *  collection when the page has `gc` (Chromium run with --js-flags=--expose-gc) — as [stage, ms, bytes].) */
export function memMark(stage: string): void {
  const M = (globalThis as { krMem?: [string, number, number][] }).krMem; if (!M) return;
  (globalThis as { gc?: () => void }).gc?.();
  M.push([stage, Math.round(performance.now()), (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0]);
}
function encodeLater(c: HTMLCanvasElement, into: { png: Uint8Array; kind?: 'png' | 'jpg' }): void {
  // A picture with nothing see-through in it — a photograph, a page's coloured background, a scan — is a JPEG
  // (a tenth of the PNG's bytes: a worksheet book of forty pages came out at seventy megabytes as PNGs); one
  // with transparent parts, or small, stays a PNG, exact. A very big picture is also drawn a little smaller.
  const px = c.width * c.height;
  const opaque = px >= 40000 && isOpaque(c);
  let src: HTMLCanvasElement = c;
  if (opaque) {
    const k = px > 2600000 ? Math.sqrt(2600000 / px) : 1;
    const flat = document.createElement('canvas'); flat.width = Math.max(1, Math.round(c.width * k)); flat.height = Math.max(1, Math.round(c.height * k));
    const g = flat.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, flat.width, flat.height); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, flat.width, flat.height);
    src = flat;
  }
  pendingPngs.push(canvasBytes(src, opaque ? 'image/jpeg' : 'image/png', 0.86).then((b) => { into.png = samePng(b); into.kind = opaque ? 'jpg' : 'png'; }));
}
/** Whether a canvas is painted everywhere (no pixel see-through), judged on a sample of its pixels. */
function isOpaque(c: HTMLCanvasElement): boolean {
  const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) return false;
  const step = Math.max(1, Math.floor(Math.sqrt((c.width * c.height) / 4000)));
  let clear = 0, n = 0;
  for (let y = 0; y < c.height; y += step) {
    const row = ctx.getImageData(0, y, c.width, 1).data;
    for (let x = 0; x < c.width; x += step) { n++; if (row[x * 4 + 3] < 250) { clear++; if (clear > n * 0.002 + 2) return false; } }
  }
  return true;
}
async function canvasBytes(c: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => { let done = false; const t = setTimeout(() => { if (!done) { done = true; res(null); } }, 6000); c.toBlob((b) => { if (!done) { done = true; clearTimeout(t); res(b); } }, type, quality); });
  if (blob) return new Uint8Array(await blob.arrayBuffer());
  const u = c.toDataURL(type, quality); const bin = atob(u.split(',')[1]); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a;
}
/** The page drawn without its text, cut into the pieces that carry ink (header ornament, frame, rules,
 *  pictures) — each cropped tight, so pieces that repeat from page to page are stored once. */
/** Whether a page draws anything besides text: pictures, shadings, filled or stroked paths. A page of text alone
 *  has no graphics to render (and rendering it was a good part of the time a long book took). */
function drawsGraphics(pdfjs: PdfJs, ol: { fnArray: number[]; argsArray: unknown[][] }): boolean {
  const O = pdfjs.OPS as unknown as Record<string, number>;
  const pictures = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageMaskXObjectGroup', 'paintImageXObjectRepeat', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask', 'paintInlineImageXObjectGroup', 'shadingFill', 'paintJpegXObject'].map((k) => O[k]).filter((x) => x !== undefined));
  const paints = new Set(['stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke'].map((k) => O[k]).filter((x) => x !== undefined));
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    if (pictures.has(fn) || paints.has(fn)) return true;
    // (A path's own paint operator travels with it; one that only clips draws nothing.)
    if (fn === O.constructPath) { const op = (ol.argsArray[i] as unknown[] | null)?.[0]; if (typeof op !== 'number' || paints.has(op)) return true; }
  }
  return false;
}

// One canvas for every page's graphics (a new one each page left megabytes for the collector), and one for
// the small copy its ink is looked for on.
let graphicsCanvas: (HTMLCanvasElement & { krNoText?: boolean; krKeepFonts?: Set<string> }) | null = null;
let scanCanvas: HTMLCanvasElement | null = null;

/** A channel of a pixel as it shows on white paper (the page's graphics are drawn on nothing). */
const onWhite = (v: Uint8ClampedArray, i: number, ch: number): number => { const a = v[i + 3]; return a === 255 ? v[i + ch] : Math.round((v[i + ch] * a) / 255 + 255 - a); };
/** Whether a pixel shows as white (or nothing) on white paper. */
const whiteAt = (v: Uint8ClampedArray, i: number): boolean => v[i + 3] === 0 || (onWhite(v, i, 0) > 250 && onWhite(v, i, 1) > 250 && onWhite(v, i, 2) > 250);

async function renderGraphics(page: import('pdfjs-dist').PDFPageProxy, scale: number, keepFonts: Set<string>, grids: GridSpec[] = [], arts: Piece[] = [], textOnly = false): Promise<Pic[]> {
  if (textOnly && !keepFonts.size && !arts.length && !grids.length && !figNow.length && !eraseNow.length) return [];
  const vp = page.getViewport({ scale });
  const c = (graphicsCanvas ??= offscreen(document.createElement('canvas'), true) as HTMLCanvasElement & { krNoText?: boolean; krKeepFonts?: Set<string> });
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); c.krNoText = true; c.krKeepFonts = keepFonts;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  // (Drawn on nothing, not on white: what the page paints is all the picture holds, its edges soft as drawn —
  // nothing to read back to take the white out of it after.)
  ctx.clearRect(0, 0, c.width, c.height);
  const TG = (globalThis as { krTiming?: Record<string, number> }).krTiming; let tg = performance.now();
  const lapG = (k: string) => { if (TG) { const n = performance.now(); TG[k] = (TG[k] ?? 0) + n - tg; tg = n; } };
  await page.render({ canvas: c, canvasContext: ctx, viewport: vp, background: 'rgba(0,0,0,0)' } as Parameters<typeof page.render>[0]).promise;
  lapG('g.render');
  const W = c.width, H = c.height;
  // Ruled tables become Word tables: their shading is read off the page here, and their rules and shading
  // leave the picture.
  const ph = page.view[3] - page.view[1];
  for (const g of grids) {
    const px = (x: number) => Math.round(x * scale), py = (y: number) => Math.round((ph - y) * scale);
    g.rows.forEach((row, j) => row.forEach((cell) => {
      if (cell.cont) return;
      const l = g.xs[cell.c0], r = g.xs[cell.c0 + cell.span], t = g.ys[j], b = g.ys[j + 1];
      const pts = [[l + 2.5, t - 2.5], [r - 2.5, t - 2.5], [l + 2.5, b + 2.5], [r - 2.5, b + 2.5]];
      const cols = pts.map(([x, y]) => { const v = ctx.getImageData(Math.max(0, Math.min(W - 1, px(x))), Math.max(0, Math.min(H - 1, py(y))), 1, 1).data; return [onWhite(v, 0, 0), onWhite(v, 0, 1), onWhite(v, 0, 2)]; });
      const hex = (v: number[]) => v.map((n) => n.toString(16).padStart(2, '0')).join('');
      const same = cols.filter((v) => Math.abs(v[0] - cols[0][0]) + Math.abs(v[1] - cols[0][1]) + Math.abs(v[2] - cols[0][2]) < 24).length;
      if (same >= 3 && cols[0].some((n) => n < 245)) cell.fill = hex(cols[0]);
    }));
    const x0 = px(g.xs[0]) - Math.ceil(2 * scale), x1 = px(g.xs[g.xs.length - 1]) + Math.ceil(2 * scale);
    const y0 = py(g.ys[0]) - Math.ceil(2 * scale), y1 = py(g.ys[g.ys.length - 1]) + Math.ceil(2 * scale);
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
  }
  for (const b of eraseNow) { const px = (x: number) => Math.round(x * scale), py = (y: number) => Math.round((ph - y) * scale); ctx.clearRect(px(b.l) - 1, py(b.top) - 1, px(b.r) - px(b.l) + 2, py(b.bottom) - py(b.top) + 2); }
  // (A figure: cut out as drawn, into the picture the text's flow carries, and out of the page's drawing.)
  for (const f of figNow) {
    const x0 = Math.max(0, Math.floor(f.box.l * scale)), y0 = Math.max(0, Math.floor((ph - f.box.top) * scale)), x1 = Math.min(W, Math.ceil(f.box.r * scale)), y1 = Math.min(H, Math.ceil((ph - f.box.bottom) * scale));
    if (x1 <= x0 || y1 <= y0) continue;
    const cc = document.createElement('canvas'); cc.width = x1 - x0; cc.height = y1 - y0;
    cc.getContext('2d')!.drawImage(c, x0, y0, cc.width, cc.height, 0, 0, cc.width, cc.height);
    encodeLater(cc, f.into); ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
  }
  lapG('g.grids');
  // Text kept as drawn goes into its line as a picture of its own: cut out here, tight to its ink.
  for (const p of arts) {
    const x0 = Math.max(0, Math.floor((p.l - p.h * 0.15) * scale)), x1 = Math.min(W, Math.ceil((p.r + p.h * 0.15) * scale));
    const y0 = Math.max(0, Math.floor((ph - (p.y + p.h * 1.15)) * scale)), y1 = Math.min(H, Math.ceil((ph - (p.y - p.h * 0.5)) * scale));
    if (x1 <= x0 || y1 <= y0) continue;
    const px = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data; const w = x1 - x0;
    let a = Infinity, b = -1, t = Infinity, u = -1;
    for (let i = 0, k = 0; i < px.length; i += 4, k++) if (!whiteAt(px, i)) { const x = k % w, y = (k / w) | 0; if (x < a) a = x; if (x > b) b = x; if (y < t) t = y; if (y > u) u = y; }
    if (b < 0) { if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D art-noink', p.font, p.l.toFixed(1), p.y.toFixed(1), p.h.toFixed(1)); continue; }
    const cw = b - a + 1, chh = u - t + 1;
    const cc = document.createElement('canvas'); cc.width = cw; cc.height = chh;
    const cx = cc.getContext('2d')!; cx.drawImage(c, x0 + a, y0 + t, cw, chh, 0, 0, cw, chh);
    const im = cx.getImageData(0, 0, cw, chh); for (let i = 0; i < im.data.length; i += 4) if (whiteAt(im.data, i)) im.data[i + 3] = 0; cx.putImageData(im, 0, 0);
    // (Encoded off this thread while the pages go on, like the page's pictures.)
    p.pic = { png: new Uint8Array(0), w: cw / scale, h: chh / scale, drop: ph - (y0 + u + 1) / scale - p.y };
    encodeLater(cc, p.pic);
    ctx.clearRect(x0 + a, y0 + t, cw, chh);
  }
  lapG('g.arts');
  // Where the ink is, found on a copy a quarter the size (a sixteenth of the pixels to read and look at); each
  // place then cut from the page itself.
  const R = 4;
  const w = Math.max(1, Math.ceil(W / R)), h = Math.max(1, Math.ceil(H / R));
  const sc = (scanCanvas ??= document.createElement('canvas')); sc.width = w; sc.height = h;
  const sx = sc.getContext('2d', { willReadFrequently: true })!;
  sx.imageSmoothingEnabled = true; sx.imageSmoothingQuality = 'high';
  sx.drawImage(c, 0, 0, W, H, 0, 0, w, h);
  const d = sx.getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h); const rowHas = new Uint8Array(h);
  // (Read as whole pixels: most of a page is nothing at all, or white, settled by one comparison. A thin rule a
  // quarter the size is faint: anything that shows on white paper as not quite white is ink here.)
  const px32 = new Uint32Array(d.buffer, d.byteOffset, w * h);
  for (let y = 0, k = 0; y < h; y++) {
    let any = 0;
    for (let x = 0; x < w; x++, k++) {
      const v = px32[k];
      if (v === 0 || v === 0xffffffff) continue;
      const i = k * 4;
      if (!(onWhite(d, i, 0) > 252 && onWhite(d, i, 1) > 252 && onWhite(d, i, 2) > 252)) { ink[k] = 1; any = 1; }
    }
    rowHas[y] = any;
  }
  lapG('g.scan');
  if (!rowHas.some((v) => v)) return [];
  const rowInk = (y: number, x0: number, x1: number) => { if (x0 === 0 && x1 === w) return rowHas[y] === 1; for (let x = x0; x < x1; x++) if (ink[y * w + x]) return true; return false; };
  const colInk = (x: number, y0: number, y1: number) => { for (let y = y0; y < y1; y++) if (ink[y * w + x]) return true; return false; };
  // Bands of rows with ink (small gaps bridged), then clusters of columns within each band.
  const boxes: [number, number, number, number][] = [];
  const gapY = Math.max(1, Math.round((6 * scale) / R)), gapX = Math.max(1, Math.round((24 * scale) / R));
  for (let y = 0; y < h;) {
    if (!rowInk(y, 0, w)) { y++; continue; }
    let y1 = y, blank = 0;
    for (let yy = y; yy < h; yy++) { if (rowInk(yy, 0, w)) { y1 = yy; blank = 0; } else if (++blank > gapY) break; }
    for (let x = 0; x < w;) {
      if (!colInk(x, y, y1 + 1)) { x++; continue; }
      let x1 = x, b2 = 0;
      for (let xx = x; xx < w; xx++) { if (colInk(xx, y, y1 + 1)) { x1 = xx; b2 = 0; } else if (++b2 > gapX) break; }
      // (In the page's own pixels, with a small pixel of room around it: what lies there is nothing at all.)
      boxes.push([Math.max(0, (x - 1) * R), Math.max(0, (y - 1) * R), Math.min(W, (x1 + 2) * R), Math.min(H, (y1 + 2) * R)]);
      x = x1 + 1;
    }
    y = y1 + 1;
  }
  if (!boxes.length) return [];
  // A page that is mostly picture (a cover) stays one image.
  const area = boxes.reduce((a, [x0, y0, x1, y1]) => a + (x1 - x0) * (y1 - y0), 0);
  const parts = area > W * H * 0.5 || boxes.length > 60 ? [[0, 0, W, H] as [number, number, number, number]] : boxes;
  const out: Pic[] = [];
  for (const [bx0, by0, bx1, by1] of parts) {
    const cc = document.createElement('canvas'); cc.width = bx1 - bx0; cc.height = by1 - by0;
    cc.getContext('2d')!.drawImage(c, bx0, by0, cc.width, cc.height, 0, 0, cc.width, cc.height);
    const pic: Pic = { png: new Uint8Array(0), x: bx0 / scale, y: by0 / scale, w: cc.width / scale, h: cc.height / scale };
    encodeLater(cc, pic); out.push(pic);
  }
  lapG('g.png');
  return out;
}

/** Stacked lines closer together than any text line (a formula: fraction, sum limits, sub- and superscripts
 *  on their own levels) cannot be set as paragraphs without growing taller than the page has them. Each such
 *  stack becomes a picture of that part of the page, with an empty line of its exact height in the text. */
function pullFormulas(lines: Line[], boxes: Box[]): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i;
    while (j + 1 < lines.length && !lines[j].spacer && !lines[j + 1].spacer && !lines[j].grid && !lines[j + 1].grid && lines[j].base - lines[j + 1].base < Math.max(lines[j].size, lines[j + 1].size) * 0.6) j++;
    if (j === i) { out.push(lines[i]); i++; continue; }
    const ls = lines.slice(i, j + 1);
    // A formula is made of short pieces; a line of prose with a note set close beside it is not one.
    const words = (l: Line) => l.pieces.map((p) => p.text).join(' ').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w)).length;
    // (Nor are lines of words set at a hair's different heights — a drawn table's cells, each written on its own
    // baseline: two words of four letters or more, not a function's name, are text, and a picture would lose them.)
    const longWords = ls.flatMap((l) => l.pieces.map((p) => p.text).join(' ').split(/[^\p{L}]+/u)).filter((w) => w.length >= 4 && !/^(arc)?(sinh?|cosh?|tanh?|cot|sec|csc)$|^(log|exp|max|min|lim|sup|inf|det|arg|deg|gcd|lcm|mod|Pr)$/i.test(w));
    if (ls.some((l) => words(l) > 5) || ls.every((l) => l.rtl) || longWords.length >= 2) { out.push(...ls); i = j + 1; continue; }
    const box: Box = { l: Math.min(...ls.map((l) => l.l)) - 1, r: Math.max(...ls.map((l) => l.r)) + 1, top: Math.max(...ls.map((l) => l.base + l.size * 0.85)), bottom: Math.min(...ls.map((l) => l.base - l.size * 0.3)) };
    boxes.push(box);
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D formula', ls.length, JSON.stringify(ls.map((l) => l.pieces.map((p) => p.text).join('').slice(0, 30))));
    const h = box.top - box.bottom;
    out.push({ pieces: [], base: box.top - BASE * h, size: Math.max(...ls.map((l) => l.size)), l: box.l, r: box.r, rtl: false, spacer: h });
    i = j + 1;
  }
  return out;
}

/** Parts of the page drawn as they are, text and all. */
async function renderRegions(page: import('pdfjs-dist').PDFPageProxy, scale: number, boxes: Box[]): Promise<Pic[]> {
  if (!boxes.length) return [];
  const vp = page.getViewport({ scale });
  const c = offscreen(document.createElement('canvas'), true);
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  await page.render({ canvas: c, canvasContext: ctx, viewport: vp, background: 'rgba(0,0,0,0)' } as Parameters<typeof page.render>[0]).promise;
  const H = page.view[3] - page.view[1];
  const out: Pic[] = [];
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.l * scale)), y0 = Math.max(0, Math.floor((H - b.top) * scale));
    const x1 = Math.min(c.width, Math.ceil(b.r * scale)), y1 = Math.min(c.height, Math.ceil((H - b.bottom) * scale));
    if (x1 <= x0 || y1 <= y0) continue;
    const cc = document.createElement('canvas'); cc.width = x1 - x0; cc.height = y1 - y0;
    const cx = cc.getContext('2d')!; cx.drawImage(c, x0, y0, cc.width, cc.height, 0, 0, cc.width, cc.height);
    // White becomes transparent, like the other pictures.
    const img = cx.getImageData(0, 0, cc.width, cc.height); const d = img.data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) d[i + 3] = 0;
    cx.putImageData(img, 0, 0);
    out.push({ png: await canvasPng(cc), x: x0 / scale, y: y0 / scale, w: cc.width / scale, h: cc.height / scale });
  }
  return out;
}

/** Thin horizontal rules on the page (page coordinates, y up): footnote separators and the like. */
function findRules(pdfjs: PdfJs, ol: { fnArray: number[]; argsArray: unknown[][] }): { x0: number; x1: number; y: number }[] {
  const { OPS } = pdfjs;
  const mul = (m: number[], n: number[]) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0]; const st: number[][] = []; const out: { x0: number; x1: number; y: number }[] = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i] as unknown[];
    if (fn === OPS.save) st.push(ctm); else if (fn === OPS.restore) ctm = st.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a as number[]);
    else if (fn === OPS.paintFormXObjectBegin) { st.push(ctm); if (Array.isArray(a[0])) ctm = mul(ctm, a[0] as number[]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = st.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const mm = a[2] as number[] | null; if (!mm) continue;
      const pts = [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
      if (y1 - y0 <= 2.5 && x1 - x0 >= 25) out.push({ x0, x1, y: (y0 + y1) / 2 });
    }
  }
  return out;
}

/** A thin horizontal stroke (a line drawn, or a filled strip under 3 pt high) or a filled rectangle the page draws,
 *  with its colour (page coordinates, y up). */
type Stroke = { x0: number; x1: number; y0: number; y1: number; color: string; rect?: boolean; used?: boolean };
function findStrokes(pdfjs: PdfJs, ol: { fnArray: number[]; argsArray: unknown[][] }): Stroke[] {
  const { OPS } = pdfjs;
  const mul = (m: number[], n: number[]) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const strokes = new Set([OPS.stroke, OPS.closeStroke]), fills = new Set([OPS.fill, OPS.eoFill]), both = new Set([OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let ctm = [1, 0, 0, 1, 0, 0], fill = '#000000', stroke = '#000000', lw = 1; const st: [number[], string, string, number][] = []; const out: Stroke[] = [];
  const hex = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.slice(1).toUpperCase() : '000000');
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i] as unknown[];
    if (fn === OPS.save) st.push([ctm, fill, stroke, lw]); else if (fn === OPS.restore) { const s = st.pop(); if (s) [ctm, fill, stroke, lw] = s; }
    else if (fn === OPS.transform) ctm = mul(ctm, a as number[]);
    else if (fn === OPS.setFillRGBColor) fill = hex(a[0]); else if (fn === OPS.setStrokeRGBColor) stroke = hex(a[0]); else if (fn === OPS.setLineWidth) lw = +(a[0] as number) || 0;
    else if (fn === OPS.paintFormXObjectBegin) { st.push([ctm, fill, stroke, lw]); if (Array.isArray(a[0])) ctm = mul(ctm, a[0] as number[]); }
    else if (fn === OPS.paintFormXObjectEnd) { const s = st.pop(); if (s) [ctm, fill, stroke, lw] = s; }
    else if (fn === OPS.constructPath) {
      const op = a[0] as number; const mm = a[2] as number[] | null; if (!mm) continue;
      const pts = [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])); let y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
      if (x1 - x0 < 3) continue;
      const stroked = strokes.has(op) || both.has(op);
      if (stroked) { const th = Math.max(0.1, lw * Math.hypot(ctm[2], ctm[3])); y0 -= th / 2; y1 += th / 2; }
      const h = y1 - y0;
      if (h <= 3 && (stroked || fills.has(op))) out.push({ x0, x1, y0, y1, color: strokes.has(op) ? stroke : fill });
      else if (fills.has(op) && h > 3 && h < 40 && fill !== 'FFFFFF') out.push({ x0, x1, y0, y1, color: fill, rect: true });
    }
  }
  return out;
}
/** For a document to edit: the page's drawing that belongs to its words. A thin stroke just under words is their
 *  underline (a link's too), one through their middle strikes them, a filled box hugging them is their shading — each
 *  put on the pieces (cut at word boundaries where it covers only some) and taken out of the page's drawing. What is
 *  left of the thin strokes (rules across the text, the notes' separator) is returned for the paragraphs. */
function decorate(pieces: Piece[], strokes: Stroke[]): Stroke[] {
  const rest: Stroke[] = []; const done = new Set<string>();
  const words = () => pieces.filter((p) => p.text.trim() && p.text !== ' ' && !p.art && !p.pic);
  const erase = (s: Stroke) => eraseNow.push({ l: s.x0 - 0.5, r: s.x1 + 0.5, top: s.y1 + 0.6, bottom: s.y0 - 0.6 });
  const cut = (p: Piece, x0: number, x1: number): Piece | null => {
    if (p.l >= x0 - p.h * 0.3 && p.r <= x1 + p.h * 0.3) return p;
    const n = p.text.length; const at = (x: number) => { const raw = Math.round(((x - p.l) / Math.max(1e-6, p.r - p.l)) * n); let best = raw, d = Infinity; for (let j = 0; j <= n; j++) if ((j === 0 || j === n || /\s/.test(p.text[j - 1]) || /\s/.test(p.text[j])) && Math.abs(j - raw) < d) { d = Math.abs(j - raw); best = j; } return Math.max(0, Math.min(n, best)); };
    const a = p.l < x0 - p.h * 0.3 ? at(x0) : 0, b = p.r > x1 + p.h * 0.3 ? at(x1) : n;
    if (b <= a || !p.text.slice(a, b).trim()) return null;
    const xAt = (j: number) => p.l + ((p.r - p.l) * j) / n;
    const part = (i: number, j: number): Piece => { const t = p.text.slice(i, j); const lead = t.length - t.trimStart().length, trail = t.length - t.trimEnd().length; return { ...p, text: t.trim(), l: xAt(i + lead), r: xAt(j - trail), codes: undefined }; };
    const mid = part(a, b); const parts = [a > 0 ? part(0, a) : null, mid, b < n ? part(b, n) : null].filter((x): x is Piece => !!x && !!x.text);
    parts[0].codes = p.codes;
    pieces.splice(pieces.indexOf(p), 1, ...parts);
    return mid;
  };
  for (const s of strokes) {
    const key = `${s.x0.toFixed(1)}|${s.x1.toFixed(1)}|${s.y0.toFixed(1)}|${s.y1.toFixed(1)}|${s.rect ? 1 : 0}`;
    if (done.has(key)) { erase(s); continue; }
    const cy = (s.y0 + s.y1) / 2; const sw = s.x1 - s.x0;
    const over = (p: Piece) => Math.min(p.r, s.x1) - Math.max(p.l, s.x0);
    let kind: 'u' | 'strike' | 'shd' | null = null; let hit: Piece[] = [];
    if (s.rect) {
      hit = words().filter((p) => over(p) > 0.5 && s.y0 <= p.y - p.h * 0.1 && s.y1 >= p.y + p.h * 0.6 && s.y1 - s.y0 <= p.h * 2.2);
      if (hit.length && hit.every((p) => Math.abs(p.y - hit[0].y) < hit[0].h * 0.3)) kind = 'shd'; else hit = [];
    } else {
      for (const [k, lo, hi] of [['u', -0.32, 0.06], ['strike', 0.12, 0.5]] as const) {
        const h0 = words().filter((p) => over(p) > 0.5 && (cy - p.y) / p.h >= lo && (cy - p.y) / p.h <= hi);
        if (h0.length && h0.every((p) => Math.abs(p.y - h0[0].y) < h0[0].h * 0.3)) { kind = k; hit = h0; break; }
      }
    }
    if (!kind) { if (!s.rect) rest.push(s); continue; }
    const h = Math.max(...hit.map((p) => p.h));
    const covered = hit.reduce((t, p) => t + Math.max(0, over(p)), 0);
    const lo = Math.min(...hit.map((p) => Math.max(p.l, s.x0))), hi = Math.max(...hit.map((p) => Math.min(p.r, s.x1)));
    // (A stroke much wider than the words over it — a rule under a title — is the paragraph's, not the words'.)
    if (covered < sw * 0.5 || sw > hi - lo + h * (s.rect ? 1.5 : 1)) { if (!s.rect) rest.push(s); continue; }
    done.add(key);
    for (const p of hit) { const m = cut(p, s.x0, s.x1); if (!m) continue; if (kind === 'u') m.u = s.color; else if (kind === 'strike') m.strike = true; else m.shd = s.color; }
    erase(s);
  }
  return rest;
}
/** For a document to edit: a rule across the text just under (or over) a paragraph is that paragraph's border
 *  (bottom or top), out of the page's drawing. Returns whether any was taken. */
function ruleBorders(blocks: Block[], rules: Stroke[], L: number, R: number): void {
  for (const s of rules) {
    if (s.used || s.x1 - s.x0 < Math.max(40, (R - L) * 0.45) || s.x0 > R || s.x1 < L) continue;
    const cy = (s.y0 + s.y1) / 2;
    // (A table's own rules are its borders.)
    if (blocks.some((b) => b.kind === 'grid' && cy <= b.spec.ys[0] + 2 && cy >= b.spec.ys[b.spec.ys.length - 1] - 2 && s.x1 > b.spec.xs[0] - 4 && s.x0 < b.spec.xs[b.spec.xs.length - 1] + 4)) continue; let best: { b: Para; side: 'top' | 'bottom'; d: number } | null = null;
    for (const b of blocks) {
      if (b.kind !== 'p' || b.base0 === undefined || !b.runs.some((r) => r.text.trim())) continue;
      const b1 = b.base1 ?? b.base0;
      const dB = b1 - cy, dT = cy - (b.base0 + b.size * 0.8);
      if (dB > 0 && dB < b.size * 1.5 && (!best || dB < best.d)) best = { b, side: 'bottom', d: dB };
      if (dT > -b.size * 0.1 && dT < b.size * 1.5 && (!best || dT < best.d)) best = { b, side: 'top', d: dT };
    }
    if (!best) continue;
    const edge = { sz: Math.max(2, Math.min(96, Math.round((s.y1 - s.y0) * 8))), color: s.color, space: Math.max(0, Math.min(31, Math.round(best.side === 'bottom' ? best.d - best.b.size * 0.25 : best.d))) };
    (best.b.bdr ??= {})[best.side] = edge; s.used = true;
    eraseNow.push({ l: s.x0 - 0.5, r: s.x1 + 0.5, top: s.y1 + 0.6, bottom: s.y0 - 0.6 });
  }
}

/** The page's bullets drawn as shapes: small, about as wide as tall (extents, y up). */
let eraseNow: Box[] = [];
/** Whether Word numbers the footnotes from 1 on each page (the page's own numbers) or on through the document. */
let notesRestart = true;
/** For a document to edit: the page's figures — pictures in its text — each cut out of the page's drawing into a
 *  picture of its own (`into`, filled when the drawing is made), set in the text's flow. */
type FigPic = { png: Uint8Array; kind?: 'png' | 'jpg'; w: number; h: number; drop: number };
let figNow: { box: Box; into: FigPic }[] = [];
/** The page's figures (see figNow): each a paragraph of its own holding the picture, to be set in the flow. */
function findFigs(pdfjs: PdfJs, ol: { fnArray: number[]; argsArray: unknown[][] }, body: Line[], W: number, H: number, L: number, R: number): { fb: Box; fig: Para }[] {
  const out: { fb: Box; fig: Para }[] = [];
  for (const fb of imageBoxes(pdfjs, ol)) {
    const fw = fb.r - fb.l, fh = fb.top - fb.bottom;
    if (fw < 50 || fh < 30 || (fw > W * 0.8 && fh > H * 0.6) || fb.bottom < H * 0.05 || fb.top > H * 0.95 || (fb.l + fb.r) / 2 < L - 20 || (fb.l + fb.r) / 2 > R + 20) continue;
    if (body.some((l) => l.base > fb.bottom + 2 && l.base < fb.top - 2 && l.r > fb.l + 2 && l.l < fb.r - 2)) continue;
    if (figNow.some((f) => f.box.l < fb.r && fb.l < f.box.r && f.box.bottom < fb.top && fb.bottom < f.box.top)) continue;
    const into: FigPic = { png: new Uint8Array(0), w: fw, h: fh, drop: 0 };
    figNow.push({ box: fb, into });
    const art: Piece = { text: '', l: fb.l, r: fb.r, y: fb.bottom, h: fh, font: '', color: '000000', bold: false, art: true, pic: into };
    const mid = Math.abs((fb.l + fb.r) / 2 - (L + R) / 2) < (R - L) * 0.08;
    out.push({ fb, fig: { kind: 'p', runs: [{ text: '', font: 'Times New Roman', size: 10, bold: false, italic: false, color: '000000', rtl: false, sup: false, art }], align: mid ? 'center' : 'start', rtl: false, indStart: mid ? 0 : Math.max(0, fb.l - L), indEnd: 0, firstLine: 0, before: 0, pitch: 11.7, size: 10, base0: fb.bottom } });
  }
  return out;
}
const topOfBlock = (b: Block) => (b.kind === 'p' && b.base0 !== undefined ? b.base0 + b.size * 0.8 : b.kind === 'grid' ? b.spec.ys[0] : null);
/** A figure into blocks of the flow, before the first that starts below its top; the space between taken apart. */
function insertFig(blocks: Block[], { fb, fig }: { fb: Box; fig: Para }): void {
  const fh = fb.top - fb.bottom;
  const at = blocks.findIndex((b) => { const t = topOfBlock(b); return t !== null && t < fb.top - 1; });
  const next = at >= 0 ? blocks[at] : null; const nt = next ? topOfBlock(next)! : null;
  const below = nt !== null ? Math.max(0, fb.bottom - nt) : 0;
  if (next) { fig.before = Math.max(0, next.before - fh - below); next.before = below; blocks.splice(at, 0, fig); }
  else { const last = blocks[blocks.length - 1]; const lb = last?.kind === 'p' && last.base0 !== undefined ? last.base0 - last.size * 0.3 : fb.top; fig.before = Math.max(0, lb - fb.top); blocks.push(fig); }
}
function imageBoxes(pdfjs: PdfJs, ol: { fnArray: number[]; argsArray: unknown[][] }): Box[] {
  const { OPS } = pdfjs;
  const mul = (m: number[], n: number[]) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0]; const st: number[][] = []; const out: Box[] = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i] as unknown[];
    if (fn === OPS.save) st.push(ctm); else if (fn === OPS.restore) ctm = st.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a as number[]);
    else if (fn === OPS.paintFormXObjectBegin) { st.push(ctm); if (Array.isArray(a[0])) ctm = mul(ctm, a[0] as number[]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = st.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      out.push({ l: Math.min(...pts.map((q) => q[0])), r: Math.max(...pts.map((q) => q[0])), bottom: Math.min(...pts.map((q) => q[1])), top: Math.max(...pts.map((q) => q[1])) });
    }
  }
  return out;
}
const refOf = (page: import('pdfjs-dist').PDFPageProxy): string | undefined => { const r = (page as unknown as { ref?: { num: number; gen: number } }).ref; return r ? `${r.num}_${r.gen}` : undefined; };
function findDots(pdfjs: PdfJs, ol: { fnArray: number[]; argsArray: unknown[][] }): (Box & { kind?: 'ring' | 'square' | 'dot' })[] {
  const { OPS } = pdfjs;
  const mul = (m: number[], n: number[]) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0]; const st: number[][] = []; const out: (Box & { kind?: 'ring' | 'square' | 'dot' })[] = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i] as unknown[];
    if (fn === OPS.save) st.push(ctm); else if (fn === OPS.restore) ctm = st.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a as number[]);
    else if (fn === OPS.paintFormXObjectBegin) { st.push(ctm); if (Array.isArray(a[0])) ctm = mul(ctm, a[0] as number[]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = st.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const mm = a[2] as number[] | null; if (!mm) continue;
      const pts = [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const l = Math.min(...pts.map((q) => q[0])), r = Math.max(...pts.map((q) => q[0])), bottom = Math.min(...pts.map((q) => q[1])), top = Math.max(...pts.map((q) => q[1]));
      const w = r - l, h = top - bottom;
      if (w >= 1.5 && h >= 1.5 && w <= 7 && h <= 7 && Math.abs(w - h) < Math.max(w, h) * 0.35) {
        // (Its kind, for the list's mark: a ring drawn only as a stroke, a square of straight sides, else a dot.)
        const op = a[0] as number; const buf = (a[1] as (Float32Array | null)[] | undefined)?.[0]; let curves = 0;
        if (buf) for (let k = 0; k < buf.length;) { const o = buf[k++]; if (o === 2) { curves++; k += 6; } else if (o === 3) { curves++; k += 4; } else if (o === 0 || o === 1) k += 2; }
        out.push({ l, r, top, bottom, kind: op === OPS.stroke || op === OPS.closeStroke ? 'ring' : buf && !curves ? 'square' : 'dot' });
      }
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      // (A small picture as a bullet: the image's unit square where the page puts it.)
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const l = Math.min(...pts.map((q) => q[0])), r = Math.max(...pts.map((q) => q[0])), bottom = Math.min(...pts.map((q) => q[1])), top = Math.max(...pts.map((q) => q[1]));
      const w = r - l, h = top - bottom;
      if (w >= 1.5 && h >= 1.5 && w <= 8 && h <= 8 && Math.abs(w - h) < Math.max(w, h) * 0.35) out.push({ l, r, top, bottom });
    }
  }
  return out;
}

/** Closed shapes drawn on the page — the boxes of a chart, frames, cells — as their extents (y up). */
function findShapes(pdfjs: PdfJs, ol: { fnArray: number[]; argsArray: unknown[][] }, thin = false): Box[] {
  const { OPS } = pdfjs;
  const mul = (m: number[], n: number[]) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0]; const st: number[][] = []; const out: Box[] = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i] as unknown[];
    if (fn === OPS.save) st.push(ctm); else if (fn === OPS.restore) ctm = st.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a as number[]);
    else if (fn === OPS.paintFormXObjectBegin) { st.push(ctm); if (Array.isArray(a[0])) ctm = mul(ctm, a[0] as number[]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = st.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const mm = a[2] as number[] | null; if (!mm) continue;
      const pts = [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const l = Math.min(...pts.map((q) => q[0])), r = Math.max(...pts.map((q) => q[0])), bottom = Math.min(...pts.map((q) => q[1])), top = Math.max(...pts.map((q) => q[1]));
      // (Thin: a rule, even a short piece of one — Word draws a cell's border in pieces, the bits at the corners a few
      // points long; without them the rule of a row does not reach the next row's and the table is not seen.)
      if ((r - l >= 8 && top - bottom >= 8) || (thin && (Math.max(r - l, top - bottom) >= 6 || (Math.max(r - l, top - bottom) >= 2 && Math.min(r - l, top - bottom) <= 1.2)))) out.push({ l, r, top, bottom });
    }
  }
  return out;
}

/** A chart — words set in drawn boxes joined by lines — cannot flow as paragraphs: its lines are scattered
 *  over the boxes. Where several separate small boxes each hold a line or two of text, that part of the page
 *  is kept as drawn (a picture of it, with an empty line of its height in the text), like a formula. */
/** (labels: for a document to edit, the chart's lines go there — each a text box over the page's drawing at its
 *  place — instead of into a picture of the chart, where its words were no text at all.) */
function pullDiagrams(lines: Line[], shapes: Box[], boxes: Box[], W: number, H: number, labels?: Line[]): Line[] {
  const small = shapes.filter((s) => (s.r - s.l) < W * 0.6 && (s.top - s.bottom) < H * 0.25);
  if (small.length < 4) return lines;
  const words = (l: Line) => l.pieces.filter((p) => p.text.trim() && p.text !== '\u2009');
  const holder = (p: Piece) => { const cx = (p.l + p.r) / 2, cy = p.y + p.h * 0.3; return small.find((s) => cx > s.l && cx < s.r && cy > s.bottom && cy < s.top && p.l > s.l - 2 && p.r < s.r + 2); };
  const held = new Map<Box, Set<Line>>();
  const boxed = lines.map((l) => {
    if (l.spacer || l.grid) return false;
    const ws = words(l); if (!ws.length) return false;
    const hs = ws.map(holder);
    hs.forEach((h) => { if (h) (held.get(h) ?? held.set(h, new Set()).get(h)!).add(l); });
    return hs.filter(Boolean).length >= ws.length * 0.6;
  });
  // Boxes of a chart hold a word or two each and stand apart; a table's cells share their edges.
  const text = [...held.entries()].filter(([, ls]) => ls.size <= 2).map(([b]) => b);
  if (text.length < 4) return lines;
  const touches = (a: Box, b: Box) => a !== b && Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom) > 2 && (Math.abs(a.r - b.l) < 1.5 || Math.abs(b.r - a.l) < 1.5)
    || a !== b && Math.min(a.r, b.r) - Math.max(a.l, b.l) > 2 && (Math.abs(a.top - b.bottom) < 1.5 || Math.abs(b.top - a.bottom) < 1.5);
  if (text.filter((a) => text.some((b) => touches(a, b))).length > text.length * 0.4) return lines;
  // The chart: its text boxes, and every other shape drawn among them (empty boxes, connectors).
  const reg: Box = { l: Math.min(...text.map((b) => b.l)), r: Math.max(...text.map((b) => b.r)), top: Math.max(...text.map((b) => b.top)), bottom: Math.min(...text.map((b) => b.bottom)) };
  for (let grew = true; grew;) {
    grew = false;
    for (const s of shapes) {
      if (s.r - s.l > W * 0.8 || s.top - s.bottom > H * 0.6) continue;
      if (s.r < reg.l - 4 || s.l > reg.r + 4 || s.top < reg.bottom - 4 || s.bottom > reg.top + 4) continue;
      if (s.l < reg.l || s.r > reg.r || s.top > reg.top || s.bottom < reg.bottom) { reg.l = Math.min(reg.l, s.l); reg.r = Math.max(reg.r, s.r); reg.top = Math.max(reg.top, s.top); reg.bottom = Math.min(reg.bottom, s.bottom); grew = true; }
    }
  }
  // Lines of the chart: those in its band (whether in a box or beside one).
  const inReg = (l: Line) => !l.spacer && !l.grid && l.base < reg.top && l.base > reg.bottom - l.size * 0.3 && l.r > reg.l - 2 && l.l < reg.r + 2;
  const taken = lines.filter(inReg);
  if (taken.filter((l) => boxed[lines.indexOf(l)]).length < taken.length * 0.6) return lines;
  reg.l -= 2; reg.r += 2; reg.top += 2; reg.bottom -= 2;
  for (const l of taken) { reg.top = Math.max(reg.top, l.base + l.size * 0.9); reg.bottom = Math.min(reg.bottom, l.base - l.size * 0.35); reg.l = Math.min(reg.l, l.l - 1); reg.r = Math.max(reg.r, l.r + 1); }
  if (labels) labels.push(...taken); else boxes.push(reg);
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D diagram', text.length, taken.length, JSON.stringify(reg));
  const h = reg.top - reg.bottom;
  const at = lines.indexOf(taken[0]);
  const out = lines.filter((l) => !taken.includes(l));
  out.splice(at, 0, { pieces: [], base: reg.top - BASE * h, size: Math.max(...taken.map((l) => l.size)), l: reg.l, r: reg.r, rtl: taken.some((l) => l.rtl), spacer: h });
  return out;
}

/** Ruled tables: rules drawn as thin lines or thin filled boxes (Word draws its borders so) that cross one
 *  another into a grid. The lines of text inside become the table's cells; a line outside keeps its place. */
function pullGrids(lines: Line[], shapes: Box[], W: number, H: number): Line[] {
  const inPage = shapes.filter((s) => s.l > -2 && s.r < W + 2 && s.bottom > -2 && s.top < H + 2);
  const hs = inPage.filter((s) => s.top - s.bottom <= 2 && s.r - s.l >= 2).map((s) => ({ x0: s.l, x1: s.r, y: (s.top + s.bottom) / 2, w: s.top - s.bottom }));
  const vs = inPage.filter((s) => s.r - s.l <= 2 && s.top - s.bottom >= 2).map((s) => ({ y0: s.bottom, y1: s.top, x: (s.l + s.r) / 2, w: s.r - s.l }));
  if (hs.length < 2 || vs.length < 2) return pullOpenTables(lines, hs, vs);
  // Rules that meet belong to one table.
  const n = hs.length + vs.length; const up = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i])));
  hs.forEach((h, i) => vs.forEach((v, j) => { if (v.x > h.x0 - 2 && v.x < h.x1 + 2 && h.y > v.y0 - 2 && h.y < v.y1 + 2) up[find(i)] = find(hs.length + j); }));
  // (A rule drawn in pieces — one per row, as TeX does — is one rule.)
  vs.forEach((v, j) => vs.forEach((w, k) => { if (k > j && Math.abs(v.x - w.x) < 1.5 && v.y0 < w.y1 + 4 && w.y0 < v.y1 + 4) up[find(hs.length + j)] = find(hs.length + k); }));
  hs.forEach((g, j) => hs.forEach((w, k) => { if (k > j && Math.abs(g.y - w.y) < 1.5 && g.x0 < w.x1 + 4 && w.x0 < g.x1 + 4) up[find(j)] = find(k); }));
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i);
  const cluster = (vals: number[]) => { const out: number[] = []; for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > 1.5) out.push(v); return out; };
  let out = lines;
  for (const idx of groups.values()) {
    const gh = idx.filter((i) => i < hs.length).map((i) => hs[i]), gv = idx.filter((i) => i >= hs.length).map((i) => vs[i - hs.length]);
    if (gh.length < 2 || gv.length < 2) continue;
    const xs = cluster(gv.map((v) => v.x)), ys = cluster(gh.map((h) => h.y)).reverse();
    if (xs.length < 2 || ys.length < 2 || xs[xs.length - 1] - xs[0] < 30) continue;
    const vAt = (x: number, y: number) => gv.some((v) => Math.abs(v.x - x) < 1.6 && v.y0 <= y + 1 && v.y1 >= y - 1);
    const hAt = (y: number, x: number) => gh.some((h) => Math.abs(h.y - y) < 1.6 && h.x0 <= x + 1 && h.x1 >= x - 1);
    const rows: GridCell[][] = [];
    for (let j = 0; j + 1 < ys.length; j++) {
      const mid = (ys[j] + ys[j + 1]) / 2; const row: GridCell[] = [];
      let c0 = 0;
      for (let k = 1; k < xs.length; k++) {
        if (k < xs.length - 1 && !vAt(xs[k], mid)) continue;
        const cx = (xs[c0] + xs[k]) / 2;
        row.push({ c0, span: k - c0, cont: j > 0 && !hAt(ys[j], cx), lines: [] });
        c0 = k;
      }
      rows.push(row);
    }
    // A merge only carries on a cell of the same columns.
    rows.forEach((row, j) => row.forEach((c) => { if (c.cont && !rows[j - 1].some((a) => a.c0 === c.c0 && a.span === c.span)) c.cont = false; }));
    // The text: each piece to the cell it stands in, line by line.
    const x0 = xs[0], x1 = xs[xs.length - 1], yTop = ys[0], yBot = ys[ys.length - 1];
    let used = 0;
    const kept: Line[] = [];
    for (const l of out) {
      if (l.spacer || l.grid) { kept.push(l); continue; }
      const inside = l.pieces.filter((p) => { const cx = (p.l + p.r) / 2, cy = p.y + p.h * 0.3; return cx > x0 && cx < x1 && cy < yTop && cy > yBot; });
      if (!inside.length) { kept.push(l); continue; }
      used++;
      const byCell = new Map<GridCell, Piece[]>();
      for (const p of inside) {
        const cx = (p.l + p.r) / 2, cy = p.y + p.h * 0.3;
        const j = ys.findIndex((y, k) => k + 1 < ys.length && cy <= y && cy >= ys[k + 1]); if (j < 0) continue;
        let cell = rows[j].find((c) => cx >= xs[c.c0] && cx <= xs[c.c0 + c.span]); if (!cell) continue;
        for (let jj = j; cell.cont && jj > 0; jj--) cell = rows[jj - 1].find((a) => a.c0 === cell!.c0 && a.span === cell!.span) ?? cell;
        (byCell.get(cell) ?? byCell.set(cell, []).get(cell)!).push(p);
      }
      for (const [c, ps] of byCell) c.lines.push(ps);
      const rest = l.pieces.filter((p) => !inside.includes(p));
      if (rest.some((p) => p.text.trim() && p.text !== '\u2009')) { const ws = rest.filter((p) => p.text !== '\u2009'); kept.push({ ...l, pieces: rest, l: Math.min(...ws.map((p) => p.l)), r: Math.max(...ws.map((p) => p.r)) }); }
    }
    if (!used || !rows.some((r) => r.some((c) => c.lines.length))) continue;
    const rule = Math.max(0.25, median([...gh.map((h) => h.w), ...gv.map((v) => v.w)]));
    const spec: GridSpec = { xs, ys, rows, rule };
    // In the flow where the table stands: before the first line below its top.
    const at = kept.findIndex((l) => l.base < yTop - 1);
    const gsize = median(rows.flatMap((r) => r.flatMap((c) => c.lines.flat().map((p) => p.h)))) || 10;
    // (Its "baseline" where a line's would be for its top to be the table's top.)
    const gridLine: Line = { pieces: [], base: yTop - BASE * gsize * 1.2, size: median(rows.flatMap((r) => r.flatMap((c) => c.lines.flat().map((p) => p.h)))) || 10, l: x0, r: x1, rtl: isRtlText(rows.flatMap((r) => r.flatMap((c) => c.lines.flat().map((p) => p.text))).join('')), grid: spec };
    kept.splice(at < 0 ? kept.length : at, 0, gridLine);
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D grid', xs.length - 1, ys.length - 1, used, JSON.stringify(xs.map((x) => +x.toFixed(1))), JSON.stringify(ys.map((y) => +y.toFixed(1))));
    out = kept;
  }
  return pullOpenTables(out, hs, vs);
}

/** Open tables (booktabs, as LaTeX sets them): rules across — a top, a middle, a bottom one — and none down, the
 *  columns told only by the text, which lines up in them. The lines between the rules become the table's rows,
 *  the gaps that stay white down all of them its columns. (Taken for anything else, its words were lost: a
 *  diagram's picture, a designed page's boxes.) */
function pullOpenTables(lines: Line[], hs: { x0: number; x1: number; y: number; w: number }[], vs: { y0: number; y1: number; x: number; w: number }[]): Line[] {
  if (hs.length < 2) return lines;
  // Rules drawn in pieces on one line are one rule; rules of one table share their ends.
  const rules: { x0: number; x1: number; y: number; w: number }[] = [];
  for (const h of [...hs].sort((a, b) => b.y - a.y || a.x0 - b.x0)) { const r = rules.find((q) => Math.abs(q.y - h.y) < 1.2 && h.x0 < q.x1 + 3 && q.x0 < h.x1 + 3); if (r) { r.x0 = Math.min(r.x0, h.x0); r.x1 = Math.max(r.x1, h.x1); r.w = Math.max(r.w, h.w); } else rules.push({ ...h }); }
  let out = lines;
  const used = new Set<number>();
  for (let i = 0; i < rules.length; i++) {
    if (used.has(i)) continue; const a = rules[i]; if (a.x1 - a.x0 < 60) continue;
    const grp = [i]; for (let j = i + 1; j < rules.length; j++) { const b = rules[j]; if (!used.has(j) && Math.abs(b.x0 - a.x0) < 3 && Math.abs(b.x1 - a.x1) < 3) grp.push(j); }
    if (grp.length < 2) continue;
    const rs = grp.map((k) => rules[k]).sort((x, y) => y.y - x.y);
    // (Consecutive rules close enough that only a few lines stand between: the table's span ends where a gap of
    // many lines starts.)
    const x0 = Math.min(...rs.map((r) => r.x0)), x1 = Math.max(...rs.map((r) => r.x1));
    const top = rs[0].y, bottom = rs[rs.length - 1].y;
    if (vs.some((v) => v.x > x0 - 2 && v.x < x1 + 2 && v.y1 > bottom + 2 && v.y0 < top - 2)) continue;
    const inside = out.filter((l) => !l.grid && !l.spacer && l.base < top && l.base > bottom && l.l > x0 - l.size && l.r < x1 + l.size && l.pieces.some((p) => p.text.trim()));
    if (inside.length < 2 || inside.some((l) => l.rtl !== inside[0].rtl && false)) continue;
    // Every line of text in the band belongs to the table: one standing out beyond the rules is not a table's.
    if (out.some((l) => !inside.includes(l) && !l.grid && !l.spacer && l.base < top && l.base > bottom && l.pieces.some((p) => p.text.trim()))) continue;
    // Columns: the stretches of x that no word of any line covers.
    const ws = inside.flatMap((l) => l.pieces.filter((p) => p.text.trim() && p.text !== '\u2009'));
    const iv = ws.map((p) => [p.l, p.r]).sort((p, q) => p[0] - q[0]);
    const gaps: [number, number][] = []; let hi = iv[0][1];
    for (const [l0, r0] of iv.slice(1)) { if (l0 > hi + 6) gaps.push([hi, l0]); hi = Math.max(hi, r0); }
    // (A gap is a column's edge only where it is wider than a word space in every line that spans it.)
    const size = median(inside.map((l) => l.size));
    const edges = gaps.filter(([g0, g1]) => g1 - g0 >= size * 0.9).map(([g0, g1]) => (g0 + g1) / 2);
    if (!edges.length || edges.length > 12) continue;
    const xs = [Math.min(x0, Math.min(...ws.map((p) => p.l)) - 2), ...edges, Math.max(x1, Math.max(...ws.map((p) => p.r)) + 2)];
    // Rows: one per line (lines a hair apart are one), parted where a rule runs between them, else half-way.
    const rowsL: Line[][] = [];
    for (const l of [...inside].sort((p, q) => q.base - p.base)) { const last = rowsL[rowsL.length - 1]; if (last && last[0].base - l.base < l.size * 0.5) last.push(l); else rowsL.push([l]); }
    if (rowsL.length < 2) continue;
    // (Most rows fill more than one column: a table, not a paragraph between two rules.)
    const colOf = (p: Piece) => { const cx = (p.l + p.r) / 2; let k = 0; while (k + 1 < xs.length - 1 && cx > xs[k + 1]) k++; return k; };
    const filled = rowsL.map((r) => new Set(r.flatMap((l) => l.pieces.filter((p) => p.text.trim()).map(colOf))).size);
    if (filled.filter((n) => n >= 2).length < Math.max(2, rowsL.length * 0.6)) continue;
    const ys = [top];
    const drawn = [true];
    for (let k = 0; k + 1 < rowsL.length; k++) {
      const a0 = Math.min(...rowsL[k].map((l) => l.base)), b0 = Math.max(...rowsL[k + 1].map((l) => l.base));
      const between = rs.find((r) => r.y < a0 && r.y > b0 + rowsL[k + 1][0].size * 0.6);
      ys.push(between ? between.y : (a0 - rowsL[k][0].size * 0.3 + b0 + rowsL[k + 1][0].size * 0.85) / 2); drawn.push(!!between);
    }
    ys.push(bottom); drawn.push(true);
    const rows: GridCell[][] = rowsL.map((r) => {
      const cells: GridCell[] = xs.slice(1).map((_, k) => ({ c0: k, span: 1, lines: [] }));
      for (const l of r) { const by = new Map<number, Piece[]>(); for (const p of l.pieces) { if (!p.text.trim() && p.text !== '\u2009') continue; const k = colOf(p); (by.get(k) ?? by.set(k, []).get(k)!).push(p); } for (const [k, ps] of by) cells[k].lines.push(ps); }
      return cells;
    });
    const spec: GridSpec = { xs, ys, rows, rule: Math.max(0.25, median(rs.map((r) => r.w))), rules: drawn };
    const kept = out.filter((l) => !inside.includes(l));
    const at = kept.findIndex((l) => !l.grid && l.base < top - 1 || l.grid && l.grid.ys[0] < top);
    kept.splice(at < 0 ? kept.length : at, 0, { pieces: [], base: top - BASE * size * 1.2, size, l: xs[0], r: xs[xs.length - 1], rtl: inside.filter((l) => l.rtl).length > inside.length / 2, grid: spec });
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D open-table', xs.length - 1, rowsL.length, JSON.stringify(xs.map((x) => +x.toFixed(1))));
    grp.forEach((k) => used.add(k));
    out = kept;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Layout analysis                                                     */
/* ------------------------------------------------------------------ */

function buildLines(all: Piece[]): Line[] {
  // Drawn spaces join the line they separate words of once the lines are made: they decide nothing.
  const spaces = all.filter((p) => p.text === '\u2009');
  const pieces = all.filter((p) => p.text !== '\u2009').sort((a, b) => b.y - a.y);
  // Each line is measured from its biggest piece so far: a raised note number met first is no baseline.
  const groups: Piece[][] = []; const ref = new Map<Piece[], Piece>();
  for (const p of pieces) {
    const g = groups.find((gr) => { const o = ref.get(gr)!; return Math.abs(o.y - p.y) < Math.max(o.h, p.h) * 0.4; });
    if (g) { g.push(p); if (p.h > ref.get(g)!.h * 1.05) ref.set(g, p); } else { const n = [p]; groups.push(n); ref.set(n, p); }
  }
  // (Harakat reported on their own were already put back into their words: see attachMarks.)
  // Raised, smaller pieces (note markers) belong to the line they sit on.
  // (Each line's size and extent measured once, and again only when pieces join it: measured afresh for every
  // pair of lines, a page of many lines took seconds.)
  const stats = new Map<Piece[], { size: number; lo: number; hi: number }>();
  const st = (g: Piece[]) => {
    let v = stats.get(g);
    if (!v) { let lo = Infinity, hi = -Infinity; for (const p of g) { if (p.l < lo) lo = p.l; if (p.r > hi) hi = p.r; } v = { size: median(g.map((p) => p.h)), lo, hi }; stats.set(g, v); }
    return v;
  };
  const sizeOf = (g: Piece[]) => st(g).size;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]; const sz = sizeOf(g);
    const host = groups.find((o) => { if (o === g) return false; const so = st(o); return so.size > sz * 1.15 && g[0].y > o[0].y && g[0].y - o[0].y < so.size * 0.75 && g.every((p) => p.r > so.lo - so.size * 3 && p.l < so.hi + so.size * 3); });
    if (host) { g.forEach((p) => { p.sup = true; }); host.push(...g); stats.delete(host); groups.splice(i, 1); continue; }
    // Smaller print set a little low in a gap of a bigger line (a verse citation after the verse, beside a
    // Quran font whose words sit on their own baseline) is part of that line.
    const inGap = (o: Piece[]) => { const so = st(o); return g.every((p) => p.l >= so.lo - 1 && p.r <= so.hi + 1 && !o.some((q) => q.text.trim() && q.text !== '\u2009' && q.l < p.r - 0.5 && q.r > p.l + 0.5)); };
    const low = groups.find((o) => o !== g && sizeOf(o) > sz * 1.15 && g[0].y < o[0].y && o[0].y - g[0].y < sizeOf(o) * 0.6 && inGap(o));
    if (low && !(globalThis as { krNoLow?: boolean }).krNoLow) { low.push(...g); stats.delete(low); groups.splice(i, 1); }
  }
  // A smaller piece raised above the others of its line is a superscript (a note number on a line of
  // running text), even when it sits close enough to be grouped with them.
  for (const g of groups) {
    if (g.length < 2) continue;
    const big = Math.max(...g.map((p) => p.h));
    const host = g.filter((p) => p.h > big * 0.9); const hb = median(host.map((p) => p.y));
    for (const p of g) if (p.h < big * 0.85 && p.y - hb > big * 0.18 && /^[\s(\[]*[0-9\u0660-\u0669\u06F0-\u06F9*\u2020\u2021a-z]{1,3}[)\]]?\s*$/.test(p.text)) p.sup = true;
    // (Its brackets drawn as pieces of their own go up with it.)
    for (const q of g) if (!q.sup && /^\s*[()[\]]\s*$/.test(q.text)) for (const p of g) if (p.sup && Math.abs(q.y - p.y) < p.h * 0.2 && Math.abs(q.h - p.h) < p.h * 0.15 && Math.min(Math.abs(q.l - p.r), Math.abs(p.l - q.r)) < p.h * 0.6) { q.sup = true; break; }
  }
  // (Each line measured once, and again only when a space joins it.)
  const measure = (g: Piece[]) => {
    const words = g.filter((p) => !p.sup); if (!words.length) return null;
    let h = 0, lo = Infinity, hi = -Infinity; for (const p of words) { if (p.h > h) h = p.h; if (p.l < lo) lo = p.l; if (p.r > hi) hi = p.r; }
    return { y: median(words.map((p) => p.y)), h, lo, hi };
  };
  const wordStats = groups.map(measure);
  for (const sp of spaces) {
    let best: Piece[] | null = null, bd = Infinity, bi = -1;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]; const ws = wordStats[gi]; if (!ws) continue;
      const { y, h, lo, hi } = ws;
      const d = Math.abs(y - sp.y);
      if (d < h * 0.5 && sp.l >= lo - 0.5 && sp.r <= hi + 0.5 && d < bd) { bd = d; best = g; bi = gi; }
    }
    if (best) { best.push(sp); wordStats[bi] = measure(best); }
  }
  // Drawn spaces only separate words: a line of nothing else is no line, and one at either end of a line is
  // not part of it.
  const isMark = (p: Piece) => p.text === '\u2009';
  const kept = groups.map((g) => {
    const words = g.filter((p) => !isMark(p));
    if (!words.length) return [];
    const lo = Math.min(...words.map((p) => p.l)), hi = Math.max(...words.map((p) => p.r));
    return g.filter((p) => !isMark(p) || (p.l >= lo - 0.5 && p.r <= hi + 0.5));
  }).filter((g) => g.length);
  return kept.map((g) => {
    const normal0 = g.filter((p) => !p.sup && !isMark(p) && !p.art); const normal = normal0.length ? normal0 : g.filter((p) => !p.sup && !isMark(p));
    // (A stand-in for text left in the picture keeps its place among the words but sets no edge.)
    const ext0 = g.filter((p) => !isMark(p) && !p.art); const ext = ext0.length ? ext0 : g.filter((p) => !isMark(p));
    const base = median(normal.map((p) => p.y));
    const size = median(normal.flatMap((p) => Array(Math.max(1, Math.round(p.text.length))).fill(p.h)));
    const text = g.map((p) => p.text).join('');
    const rtl = isRtlText(text);
    let l = Math.min(...ext.map((p) => p.l)), r = Math.max(...ext.map((p) => p.r));
    // (Save a list's bullet kept as drawn — a symbol font's glyph — before the line's first word: the line starts
    // there, where the page has its mark.)
    if (ext0.length) for (const p of g) if (p.art && !p.pic?.w && p.r - p.l < size * 0.9 && (rtl ? p.l >= r - 0.5 && p.l - r < size * 3 : p.r <= l + 0.5 && l - p.r < size * 3)) { if (rtl) r = Math.max(r, p.r); else l = Math.min(l, p.l); }
    return { pieces: g, base, size, l, r, rtl };
  }).sort((a, b) => b.base - a.base);
}

/** Two half-lines with a wide gap in the middle of the text block (or a verse number there): a line of verse.
 *  Returns [right half, left half, middle] in page terms. */
function splitVerse(line: Line, L: number, R: number): [Piece[], Piece[], Piece[]] | null {
  const ps = line.pieces.filter((p) => p.text.trim() && p.text !== '\u2009').sort((a, b) => a.l - b.l);
  if (ps.length < 2) return null;
  const width = R - L, mid = (L + R) / 2;
  // A number in the middle — "(12)" or "١٢" — with a half-line on each side.
  const isNum = (p: Piece) => /^[\s()（）[\]\-–.0-9\u0660-\u0669\u06F0-\u06F9]+$/.test(p.text);
  const midNums = ps.filter((p) => isNum(p) && Math.abs((p.l + p.r) / 2 - mid) < width * 0.1);
  if (midNums.length && /[0-9\u0660-\u0669\u06F0-\u06F9]/.test(midNums.map((p) => p.text).join(''))) {
    const nl = Math.min(...midNums.map((p) => p.l)), nr = Math.max(...midNums.map((p) => p.r));
    const left = ps.filter((p) => !midNums.includes(p) && p.r <= nl + 1), right = ps.filter((p) => !midNums.includes(p) && p.l >= nr - 1);
    const span = (a: Piece[]) => (a.length ? Math.max(...a.map((p) => p.r)) - Math.min(...a.map((p) => p.l)) : 0);
    // A verse number stands apart: clear space on both sides (in prose, "ج ٣، ص" sits among words).
    const gapL = left.length ? nl - Math.max(...left.map((p) => p.r)) : 0, gapR = right.length ? Math.min(...right.map((p) => p.l)) - nr : 0;
    // (Set tight, a number right at the centre between two stretched or centred halves still is one.)
    const centred = Math.abs((nl + nr) / 2 - mid) < width * 0.03;
    const stretched = [left, right].every((h) => h.some((p) => /\u0640/.test(p.text)));
    const gap = centred || stretched ? 0.3 : 0.6;
    if (left.length + right.length + midNums.length === ps.length && span(left) > width * 0.25 && span(right) > width * 0.25 && gapL > line.size * gap && gapR > line.size * gap) {
      const all = line.pieces;
      return [all.filter((p) => p.l >= nr - 1 && !midNums.includes(p)), all.filter((p) => p.r <= nl + 1 && !midNums.includes(p)), midNums];
    }
  }
  // A verse number set before the verse, at the line's start ("٥٢ ــــ", "-٦٥"), stands outside its halves: the
  // gap is looked for, and its middle measured, on the verse's own text. (Measured on the whole line, the number
  // moved the middle off the gap, and a book's numbered verses ran on as lines of one paragraph.)
  // (Short: a half-line drawn as a long stretch, «١٩٦- ـــــــ», is the verse's first half, not its number.)
  const isLabel = (p: Piece) => /^[\s\-\u2013\u0640()0-9\u0660-\u0669\u06F0-\u06F9]+$/.test(p.text) && p.r - p.l < line.size * 2.5;
  const fromStart = line.rtl ? [...ps].sort((a, b) => b.r - a.r) : ps;
  let k = 0; while (k < fromStart.length && isLabel(fromStart[k])) k++;
  const lead = fromStart.slice(0, k), text = [...fromStart.slice(k)].sort((a, b) => a.l - b.l);
  const leadText = lead.map((p) => p.text).join('');
  let numbered = false;
  if (lead.length && text.length >= 2 && /[0-9\u0660-\u0669\u06F0-\u06F9]/.test(leadText)) {
    const tlo = text[0].l, thi = Math.max(...text.map((p) => p.r));
    // (At the edge of the text block, not indented as a numbered paragraph's first line is; and set apart by a
    // dash, a stretch or a space of its own.)
    const atEdge = (line.rtl ? R - Math.max(...lead.map((p) => p.r)) : Math.min(...lead.map((p) => p.l)) - L) < line.size * 1.5;
    const apart = line.rtl ? Math.min(...lead.map((p) => p.l)) - thi : tlo - Math.max(...lead.map((p) => p.r));
    numbered = atEdge && (/[\-\u2013\u0640]/.test(leadText) || apart > line.size * 0.5);
  }
  const gs = numbered ? text : ps;
  const tw = numbered ? Math.max(...gs.map((p) => p.r)) - gs[0].l : width, tmid = numbered ? (Math.max(...gs.map((p) => p.r)) + gs[0].l) / 2 : mid;
  let best = -1, bestGap = 0;
  let edge = gs[0].r;
  for (let i = 1; i < gs.length; i++) { const gap = gs[i].l - edge; if (gap > bestGap) { bestGap = gap; best = i; } edge = Math.max(edge, gs[i].r); }
  if (best < 0 || bestGap < line.size * 0.5) return null;
  const left = gs.slice(0, best), right = gs.slice(best);
  const gapMid = (Math.max(...left.map((p) => p.r)) + Math.min(...right.map((p) => p.l))) / 2;
  const lw = Math.max(...left.map((p) => p.r)) - Math.min(...left.map((p) => p.l)), rw = Math.max(...right.map((p) => p.r)) - Math.min(...right.map((p) => p.l));
  // A wide gap near the middle, or a narrower one right at the centre with two long halves.
  // (A numbered verse is measured both ways: some books centre the gap on the verse's text, others on the whole
  // line, the number counted in its first half.)
  const spanOf = (a: Piece[]) => (a.length ? Math.max(...a.map((p) => p.r)) - Math.min(...a.map((p) => p.l)) : 0);
  const ways = numbered ? [[tw, tmid, lw, rw], [width, mid, spanOf(ps.filter((p) => p.r <= gapMid)), spanOf(ps.filter((p) => p.r > gapMid))]] : [[width, mid, lw, rw]];
  const wideGap = ways.some(([w, m, a, b]) => bestGap >= Math.max(line.size * 1.5, w * 0.045) && Math.abs(gapMid - m) <= w * 0.18 && a >= w * 0.3 && b >= w * 0.3);
  const centred = ways.some(([w, m, a, b]) => Math.abs(gapMid - m) <= w * 0.03 && a >= w * 0.35 && b >= w * 0.35 && bestGap >= line.size * (0.75 - (/\u0640/.test(left.map((p) => p.text).join('')) && /\u0640/.test(right.map((p) => p.text).join('')) ? 0.25 : 0)));
  if (!wideGap && !centred) return null;
  const all = line.pieces;
  const inLeft = (p: Piece) => p.r <= gapMid + 0.01;
  const res: [Piece[], Piece[], Piece[]] & { weak?: number; numbered?: boolean } = [all.filter((p) => !inLeft(p)), all.filter(inLeft), []];
  // Only a narrow gap: verse if a neighbouring line splits there too (a wide space after a full stop is not).
  if (!wideGap) res.weak = gapMid;
  // (A lone verse may show itself by its number: see buildBlocks.)
  if (numbered) res.numbered = true;
  return res;
}

/** A piece's text cut where its marks change colour: each mark the page colours apart (its letter and the mark
 *  are known, see keepMark) becomes a part of its own colour; the rest keeps the piece's. */
function tintParts(text: string, tints: NonNullable<Piece['tints']>, color: string): { text: string; color: string }[] {
  const left = [...tints]; const out: { text: string; color: string }[] = [];
  let base = '';
  for (const ch of text) {
    let c = color;
    if (COMBINING.test(ch)) { const k = left.findIndex((t) => t.mark === ch && (t.base === base || !t.base)); if (k >= 0) { c = left[k].color; left.splice(k, 1); } }
    else base = ch;
    const last = out[out.length - 1];
    if (last && last.color === c) last.text += ch; else out.push({ text: ch, color: c });
  }
  return out.length ? out : [{ text, color }];
}

function runsOf(pieces: Piece[], fonts: Map<string, FontInfo>, rtlLine: boolean): Run[] {
  // Order and space the pieces like the copy text does, then merge neighbours with the same look.
  const ordered: { p: Piece; space: boolean; tab?: number; blank?: number; trim?: number }[] = [];
  const marked = pieces.some((p) => p.text === '\u2009');
  const sorted = dropBuriedSpaces(pieces, (p) => p.text === '\u2009').sort((a, b) => (rtlLine ? b.l - a.l || b.r - a.r : a.l - b.l || a.r - b.r));
  // Punctuation pieces read in the order their glyphs stand on the line (pdf.js gives them in drawing order,
  // which on a right-to-left line may run either way).
  sorted.forEach((p, i) => {
    if (!p.codes || p.codes.length < 2 || p.raw || /[\p{L}\p{N}]/u.test(p.text)) return;
    const t = [...p.codes].sort((a, b) => (rtlLine ? b[2] - a[2] : a[2] - b[2])).map((u) => u[1]).join('');
    if (t.replace(/\s/g, '') === [...p.text.replace(/\s/g, '')].sort().join('') || [...t].sort().join('') === [...p.text].sort().join('')) sorted[i] = { ...p, text: t, ordered: true };
  });
  if ((globalThis as { krDebugLine?: string }).krDebugLine === 'mk') sorted.forEach((p) => { if (p.codes) console.warn('P2D mk', JSON.stringify([p.text, p.l, p.r, p.codes])); });
  // (Brackets drawn on their own: opening or closing by where their words are — see fixLoneBrackets.)
  fixLoneBrackets(sorted, rtlLine).forEach((t, i) => { if (t !== sorted[i].text) sorted[i] = { ...sorted[i], text: t }; });
  // (A number drawn in pieces on a right-to-left line — "١٩٧/٦" — keeps the order it shows: see numberRunsForward.)
  if (rtlLine) { const fwd = numberRunsForward(sorted); if (fwd.length !== sorted.length) sorted.splice(0, sorted.length, ...fwd); }
  // (Latin words on a right-to-left line read left to right among themselves: "John Smith", not "Smith John".
  // The gaps below are measured between the boxes whichever way the pieces go.)
  // (A run's first piece is set apart from the word before by the run's own right edge, not its own.)
  const runRight = new Map<Piece, number>();
  if (rtlLine && sorted.some((p) => /[A-Za-z]/.test(p.text))) {
    const { seq, inRun } = ltrRunsForward(sorted, (p) => p.text); sorted.splice(0, sorted.length, ...seq);
    for (let i = 0; i < sorted.length; i++) {
      if (!inRun.has(sorted[i]) || (i > 0 && inRun.has(sorted[i - 1]))) continue;
      let j = i; let r = sorted[i].r; while (j + 1 < sorted.length && inRun.has(sorted[j + 1])) { j++; r = Math.max(r, sorted[j].r); }
      runRight.set(sorted[i], r);
    }
  }
  const gapOf = (a: Piece, b: Piece) => (runRight.has(b) && a.l >= runRight.get(b)! - 0.5 ? a.l - runRight.get(b)! : Math.max(a.l - b.r, b.l - a.r));
  let prev: Piece | null = null; let pendingSpace = false; let pendingW = 0;
  // Word gaps of a stretched line are all wide: a tab is much wider than the line's usual gap.
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) { const a = sorted[i - 1], b = sorted[i]; if (!b.text.trim() || !a.text.trim() || a.conn || b.conn || a.art || b.art) continue; const g = gapOf(a, b); if (g > 0.5) gaps.push(g); }
  const wideGap = gaps.length >= 3 ? median(gaps) * 2.5 : 0;
  // Letter spacing the page applies (Word's "condensed" or "expanded", drawn as Tc): each glyph set nearer to
  // (or further from) the next than its advance. Measured on the line's glyphs; Word gets the same spacing.
  const extras: number[] = [];
  for (const p of pieces) {
    const gl = (p.codes ?? []).filter((u) => u[5] > 0 && u[1] && !/^\s+$/.test(u[1]) && !/\u0640/.test(u[1])).sort((a, b) => a[2] - b[2]);
    for (let i = 1; i < gl.length; i++) { const a = gl[i - 1], b = gl[i]; const d = b[2] - (a[2] + a[5] * a[4]); if (Math.abs(d) < a[4] * 0.3) extras.push(d); }
  }
  const midCs = extras.length >= 8 ? median(extras) : 0;
  // (Word's letter spacing would part joined Arabic letters: the same narrowing is given as a horizontal scale.)
  const glyphs = pieces.flatMap((p) => (p.codes ?? []).filter((u) => u[5] > 0 && u[1] && !/^\s+$/.test(u[1])));
  const avgAdv = glyphs.length ? glyphs.reduce((t, u) => t + u[5] * u[4], 0) / glyphs.length : 0;
  if ((globalThis as { krDebugLine?: string }).krDebugLine === 'cs') { const all = pieces.flatMap((p) => p.codes ?? []); const adv = all.reduce((t, u) => t + u[5] * u[4], 0); const lo = Math.min(...pieces.map((p) => p.l)), hi = Math.max(...pieces.map((p) => p.r)); console.warn('P2D cs', JSON.stringify(pieces.map((p) => p.text).join('|').slice(0, 40)), (hi - lo).toFixed(1), adv.toFixed(1), all.length, extras.length, midCs.toFixed(2)); }
  // Tracking as a design tool sets it — every glyph a wide, even step from the next (a poster's title) — is
  // Word's expanded spacing, not a stretch: the glyphs are set apart by that much, and only a gap wider still
  // (a space's width on top of the step) parts words. pdf.js had put a space in each step; those go.
  const lineH = median(pieces.filter((p) => p.text.trim()).map((p) => p.h)) || 10;
  const tracked = extras.length >= 4 && midCs > lineH * 0.06 && extras.filter((d) => Math.abs(d - midCs) < Math.max(0.6, midCs * 0.3)).length >= extras.length * 0.7 ? midCs : 0;
  if (tracked) for (const p of pieces) {
    const gl = (p.codes ?? []).filter((u) => u[5] > 0 && u[1] && !/^\s+$/.test(u[1])).sort((a, b) => a[2] - b[2]);
    if (gl.length < 2 || gl.map((u) => u[1]).join('').replace(/\s+/g, '') !== p.text.replace(/\s+/g, '')) continue;
    let text = gl[0][1];
    for (let i = 1; i < gl.length; i++) { const a = gl[i - 1], b = gl[i]; const d = b[2] - (a[2] + a[5] * a[4]); text += (d > tracked + a[4] * 0.2 ? ' ' : '') + b[1]; }
    p.text = text;
  }
  const lineCs = !tracked && Math.abs(midCs) >= 0.05 && avgAdv > 0 ? Math.max(80, Math.min(110, Math.round(100 * (1 + midCs / avgAdv)))) : undefined;
  const normalY = pieces.filter((p) => !p.sup && p.text.trim()).map((p) => p.y);
  const lineBase = normalY.length ? median(normalY) : null;
  for (const p of sorted) {
    if (p.text === '\u2009') { pendingSpace = true; pendingW += p.r - p.l; continue; }
    if (p.conn) { const pv = prev as Piece | null; if (pv) prev = { ...pv, l: Math.min(pv.l, p.l), r: Math.max(pv.r, p.r) }; continue; }
    if (!p.text.trim()) { pendingSpace = true; pendingW += p.r - p.l; continue; }
    let space = pendingSpace;
    const gap = prev ? gapOf(prev, p) : 0;
    if (prev && gap > Math.min(prev.h, p.h) * (marked ? 0.3 : 0.18)) space = true;
    // (A drawn space next to nothing — a sliver of a space set where a word and its comma or closing quote still
    // touch — parts nothing the page shows: the words stand where they would without it.)
    // (Not beside a word font's glyph: its box is the whole word with the room around it, which shows no gap.)
    else if (space && prev && pendingW < Math.min(prev.h, p.h) * 0.03 && gap < Math.min(prev.h, p.h) * 0.03 && !fonts.get(prev.font)?.wordFont && !fonts.get(p.font)?.wordFont) space = false;
    // A stretch drawn as overlapping tatweel pieces: as many tatweels as the overlap hides are not drawn width.
    let trim = 0;
    if (prev && rtlLine && gap < -0.5 && /^\u0640/.test(p.text)) {
      const tu = p.codes?.find((u) => u[1] === '\u0640'); const tw = tu ? tu[5] * tu[4] : p.h * 0.28;
      if (tw > 0) trim = Math.round(-gap / tw);
    }
    // (A mark first in a piece stored in drawing order — "َأ" — is not a mark starting the piece.)
    if (COMBINING.test(joinLine([{ text: p.text, l: p.l, r: p.r, h: p.h, keep: p.keep }]).text[0] ?? '')) space = false;
    // A wide gap inside a line (a section number and its title, a list label, columns of figures) is a
    // tab to where the next piece starts.
    // A drawn space before it means a stretched (justified) word gap instead.
    // (With few gaps to compare, a gap of about an em — a section number before its title — already is one.)
    // (Unless the gap is mostly empty: something drawn there that is not text — a label kept in the picture.)
    const wide = prev && gap > Math.max(prev.h, p.h) * (gaps.length >= 3 ? 1.5 : 0.9) && gap > wideGap;
    // A wide gap the page leaves mostly empty — something drawn there that is not text (a label kept in the
    // picture) — stays as wide: one space widened to it (a tab would end the line's justification).
    const blank = wide && pendingSpace && pendingW < gap * 0.4 ? gap : undefined;
    const tab = blank === undefined && prev && !pendingSpace && gap > Math.max(prev.h, p.h) * (gaps.length >= 3 ? 1.5 : 0.9) && gap > wideGap ? (rtlLine ? p.r : p.l) : undefined;
    ordered.push({ p, space: space && ordered.length > 0 && tab === undefined && blank === undefined, tab, blank, trim });
    pendingSpace = false; pendingW = 0;
    prev = prev && (rtlLine ? p.l > prev.l : p.r < prev.r) ? { ...p, l: Math.min(prev.l, p.l), r: Math.max(prev.r, p.r) } : p;
  }
  const runs: Run[] = [];
  // (Where each tabbed stretch of the line ends: a column's text may line up on its end, not its start.)
  let seg: Run | null = null;
  const reach = (p: Piece) => { if (seg) seg.tabEnd = rtlLine ? Math.min(seg.tabEnd ?? p.l, p.l) : Math.max(seg.tabEnd ?? p.r, p.r); };
  for (const { p, space, tab, blank, trim } of ordered) {
    const f = fonts.get(p.font) ?? { family: 'Times New Roman', bold: false, italic: false };
    // A piece stored in drawing order (mark before its letter) reads in logical order through joinLine.
    if (p.art) {
      // Text left as drawn (a sign in a font that cannot travel): its picture, in its place among the words.
      const lastA = runs[runs.length - 1];
      if (space && lastA && !lastA.art) lastA.text += ' ';
      if (tab !== undefined && lastA) lastA.text = lastA.text.replace(/\s+$/, '');
      runs.push({ text: '', font: lastA?.font ?? 'Times New Roman', size: Math.round(p.h * 2) / 2, bold: false, italic: false, color: '000000', rtl: rtlLine, sup: false, art: p });
      continue;
    }
    let text = p.ordered || p.raw ? p.text : logicalNeutral(joinLine([{ text: p.text, l: p.l, r: p.r, h: p.h, keep: p.keep }]).text, rtlLine);
    if (rtlLine && !p.raw) text = balanceBrackets(text);
    if (trim) {
      const lastText = runs.length ? runs[runs.length - 1].text : '';
      const lead = text.match(/^\u0640+/)?.[0].length ?? 0;
      const cut = Math.min(trim, /\u0640$/.test(lastText) ? lead : lead - 1);
      if (cut > 0) text = text.slice(cut);
    }
    const look: Omit<Run, 'text'> = { ...(p.link ? { link: p.link } : {}), ...(p.u ? { u: p.u } : {}), ...(p.strike ? { strike: true } : {}), ...(p.shd ? { shd: p.shd } : {}), font: f.family, fk: p.font, size: Math.round(p.h * 2) / 2, bold: f.bold || p.bold, italic: f.italic, color: p.color, rtl: !p.raw && (isRtlText(text) || (rtlLine && !/[A-Za-z0-9]/.test(text))), sup: !!p.sup, raise: p.sup && lineBase !== null ? Math.round((p.y - lineBase) * 2) / 2 : undefined, ...(tracked ? { spacing: Math.round(tracked * 4) / 4 } : {}), cs: lineCs };
    // (Marks the page colours apart from their letters: the text cut there, each part a run in its colour.)
    const parts = p.tints ? tintParts(text, p.tints, look.color) : null;
    if (parts) text = parts[0].text;
    const rest = () => { for (const q of parts?.slice(1) ?? []) { const lr = runs[runs.length - 1]; if (lr && !lr.art && !lr.tab && lr.color === q.color && lr.font === look.font && lr.size === look.size && lr.sup === look.sup && lr.rtl === look.rtl) lr.text += q.text; else runs.push({ ...look, color: q.color, text: q.text }); } };
    if (parts) look.color = parts[0].color;
    const last = runs[runs.length - 1];
    if (tab !== undefined) { if (last) last.text = last.text.replace(/\s+$/, ''); runs.push(seg = { ...look, text, tab, tabEnd: rtlLine ? p.l : p.r }); rest(); continue; }
    reach(p);
    if (blank !== undefined && last) { last.text = last.text.replace(/\s+$/, ''); runs.push({ ...look, sup: false, raise: undefined, text: ' ', spacing: Math.max(0, blank * 0.92 - p.h * 0.3) }); }
    if (space && last?.art) text = ` ${text}`;
    else if (space && last) last.text += ' ';
    if (last && (!last.spacing || (tracked && last.spacing === look.spacing && last.text !== ' ')) && !last.art && blank === undefined && last.font === look.font && last.size === look.size && last.bold === look.bold && last.italic === look.italic && last.color === look.color && last.sup === look.sup && last.rtl === look.rtl && last.cs === look.cs && last.link === look.link && last.u === look.u && last.strike === look.strike && last.shd === look.shd) last.text += text;
    else if (space && last && last.text.endsWith(' ')) runs.push({ ...look, text });
    else runs.push({ ...look, text });
    rest();
  }
  for (const r of runs) r.text = r.text.replace(/\s+(?=[\u064B-\u065F\u0670])/g, '').replace(/([\u060C\u061B\u061F.,:;!)(»«\]\[]+)([\u064B-\u065F\u0670]+)/g, '$2$1').replace(/\s{2,}/g, ' ');
  return fitSpaces(runs.filter((r) => r.text.length || r.art), pieces, fonts);
}

/** For a document to edit: a paragraph's runs as a word processor writes them — a space is a plain space at its
 *  neighbours' size (not the narrowed space that holds an exact line's width: see fitSpaces), the letter scale the
 *  lines were measured at one for the paragraph, and neighbouring runs of one look one run: a run ends only where the
 *  look, a link, a note mark, a picture, a tab or a line break comes. */
export function plainRuns(runs: Run[]): Run[] {
  const text = runs.filter((r) => r.text.trim() && !r.art);
  // (One letter scale for the paragraph: the one most of its letters were set at, for runs within a few per cent of it.)
  const csW = new Map<number, number>(); for (const r of text) csW.set(r.cs ?? 100, (csW.get(r.cs ?? 100) ?? 0) + r.text.length);
  const cs = [...csW].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 100;
  const out: Run[] = [];
  const same = (a: Run, b: Run) => a.font === b.font && a.size === b.size && a.bold === b.bold && a.italic === b.italic && a.color === b.color && a.rtl === b.rtl && a.sup === b.sup && a.raise === b.raise && a.link === b.link && a.u === b.u && a.strike === b.strike && a.shd === b.shd && (a.spacing ?? 0) === (b.spacing ?? 0) && (a.cs ?? 100) === (b.cs ?? 100);
  runs.forEach((r0, i) => {
    let r = r0;
    if (!r.art && r.cs !== cs && Math.abs((r.cs ?? 100) - cs) <= 6) r = { ...r, cs: cs === 100 ? undefined : cs };
    // (A space between words takes its neighbours' look: the one before, else the one after.)
    if (!r.art && r.text && !r.text.trim() && r.note === undefined && !r.spacing) {
      const nb = [out[out.length - 1], runs[i + 1]].find((n) => n && !n.art && n.text.trim() && n.note === undefined);
      if (nb) r = { ...r, font: nb.font, size: nb.size, bold: nb.bold, italic: nb.italic, color: nb.color, rtl: nb.rtl, sup: nb.sup, raise: nb.raise, cs: nb.cs, link: r.link ?? nb.link, u: r.u === undefined ? undefined : nb.u, strike: r.strike && nb.strike, shd: r.shd === undefined ? undefined : nb.shd };
    }
    const last = out[out.length - 1];
    if (last && !last.art && !r.art && last.note === undefined && r.note === undefined && !r.br && r.tab === undefined && !r.lj && same(last, r)) {
      out[out.length - 1] = { ...last, text: last.text + r.text, ...(last.kText !== undefined || r.kText !== undefined ? { kText: (last.kText ?? last.text) + (r.kText ?? r.text) } : {}) };
    } else out.push(r);
  });
  return out;
}

/** A line whose words, set with the font's own space between them, are wider than the page sets the line (Word
 *  squeezes the spaces of a justified line a little; a word processor that does not wraps its last word, and
 *  every line after it moves down — a page runs onto the next): its spaces are narrowed by as much, as character
 *  spacing on the spaces, so the line fits as the page has it. Only lines whose glyph widths are known (the
 *  PDF's own fonts, which the document carries) are measured. */
function fitSpaces(runs: Run[], pieces: Piece[], fonts: Map<string, FontInfo>): Run[] {
  if (runs.some((r) => r.tab !== undefined || r.spacing || r.art || r.sup || r.cs)) return runs;
  const words = pieces.filter((p) => p.text.trim() && p.text !== '\u2009' && !p.conn);
  if (words.length < 2 || words.some((p) => !p.codes?.length)) { if ((globalThis as { krDebugLine?: string }).krDebugLine === 'fit') console.warn('P2D fit-skip', words.length, words.filter((p) => !p.codes?.length).map((p) => p.text).join('|')); return runs; }
  let adv = 0, lo = Infinity, hi = -Infinity;
  for (const p of words) { for (const c of p.codes!) if (c[5] > 0) adv += c[5] * c[4]; lo = Math.min(lo, p.l); hi = Math.max(hi, p.r); }
  const spaces = runs.reduce((n, r) => n + (r.text.match(/ /g)?.length ?? 0), 0);
  if (!spaces) return runs;
  const sw = median(words.map((p) => (fonts.get(p.font)?.spaceW ?? 0.25) * p.h));
  const over = adv + spaces * sw - (hi - lo);
  if ((globalThis as { krDebugLine?: string }).krDebugLine === 'fit') console.warn('P2D fit', (hi - lo).toFixed(1), adv.toFixed(1), spaces, sw.toFixed(2), over.toFixed(1));
  if (over <= 0.3) return runs;
  // (Never below half a space: a line that far over is not one whose spaces were squeezed.)
  const cut = Math.min(over / spaces + 0.1, sw * 0.5);
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text.includes(' ')) { out.push(r); continue; }
    // (A smaller size for the space, not negative character spacing: LibreOffice gives no letter spacing to
    // Arabic text, the space between two Arabic words included.)
    r.text.split(/( )/).forEach((t, i) => { if (!t) return; out.push({ ...r, text: t, ...(t === ' ' ? { size: Math.max(1, Math.floor(r.size * (1 - cut / sw) * 2) / 2) } : {}), br: i === 0 ? r.br : undefined }); });
  }
  return out;
}

/** (edit: lay out a paragraph to edit — see editBreak; off for a designed page's boxes, which keep their lines.) */
function buildBlocks(lines: Line[], fonts: Map<string, FontInfo>, L: number, R: number, pitchOf: (size: number) => number, prevBaseStart: number | null, edit = p2d.edit): Block[] {
  const blocks: Block[] = [];
  let cur: { lines: Line[] } | null = null;
  let prevBase = prevBaseStart;
  let prevPitch = 0;
  const tolOf = (l: Line) => Math.max(l.size * 0.9, 3);
  const full = (l: Line) => l.l - L < tolOf(l) && R - l.r < tolOf(l);
  const centered = (l: Line) => { const a = l.l - L, b = R - l.r; return a > l.size * 1.2 && b > l.size * 1.2 && Math.abs(a - b) < Math.max(l.size * 1.5, (R - L) * 0.04); };
  const startGap = (l: Line) => (l.rtl ? R - l.r : l.l - L);
  const endGap = (l: Line) => (l.rtl ? l.l - L : R - l.r);
  const closePara = () => {
    if (!cur || !cur.lines.length) { cur = null; return; }
    const ls = cur.lines; const first = ls[0];
    const rtl = ls.filter((l) => l.rtl).length >= ls.length / 2;
    const size = median(ls.map((l) => l.size));
    let pitch = ls.length > 1 ? median(ls.slice(1).map((l, i) => ls[i].base - l.base)) : pitchOf(size);
    // A lone Latin line in a tall slot: Word puts the baseline 4/5 down an exact line, LibreOffice at the font's
    // ascent; a slot just over the type size makes both agree. The space above it carries the rest.
    if (ls.length === 1 && !first.rtl && pitch > size * 1.2) pitch = size * 1.15;
    let align: Para['align'];
    if (ls.every(centered)) align = 'center';
    // (Two lines are not justified: the first already fills the measure, and a stretch — Word's letters being a
    // hair wider or narrower — would only shift words over a title's drawn shadow.)
    else if (ls.length > 2 && ls.slice(0, -1).every((l, i) => (i === 0 ? endGap(l) < tolOf(l) : full(l)))) align = 'both';
    // (An indented block — a list item whose lines all start inside the margin — fills its own width.)
    else if (ls.length > 2 && (() => { const rest = ls.slice(1, -1); const lo = Math.min(...ls.map((l) => l.l)), hi = Math.max(...rest.map((l) => l.r)); return endGap(first) < tolOf(first) && rest.every((l) => l.l - lo < tolOf(l) && hi - l.r < tolOf(l)); })()) align = 'both';
    else if (ls.length === 1 && full(first)) align = 'both';
    else if (ls.every((l) => startGap(l) < tolOf(l) * 1.5) || ls.some((l) => startGap(l) < tolOf(l))) align = 'start';
    // (For a document to edit: lines set in from the start and well short of the end — a list's item, a note —
    // start where they start, set in; they are not set flush to the far side.)
    else if (p2d.edit && ls.every((l) => startGap(l) < endGap(l))) align = 'start';
    else align = 'end';
    let indStart = 0, indEnd = 0, firstLine = 0;
    if (align !== 'center') {
      const rest = ls.length > 1 ? ls.slice(1) : ls;
      indStart = align === 'end' ? 0 : Math.max(0, Math.min(...rest.map(startGap)));
      if (indStart < tolOf(first) * 0.5) indStart = 0;
      firstLine = align === 'end' ? 0 : startGap(first) - indStart;
      if (Math.abs(firstLine) < tolOf(first) * 0.5) firstLine = 0;
      if (align === 'end') indEnd = Math.max(0, Math.min(...ls.map(endGap)));
      else if (align === 'both') indEnd = Math.max(0, Math.min(...ls.slice(0, -1).map(endGap).concat(ls.length === 1 ? [endGap(first)] : [])));
      if (indEnd < tolOf(first) * 0.5) indEnd = 0;
    }
    const runs: Run[] = [];
    const lineRuns = ls.map((l) => runsOf(l.pieces, fonts, l.rtl));
    // (For a document to edit, the lines of a paragraph run on — Word breaks them — save where the page sets text
    // at tab stops, which only holds as lines.)
    const flow = edit && !lineRuns.some((rs) => rs.some((r) => r.tab !== undefined));
    lineRuns.forEach((rs, i) => {
      // Every line ends where the page ends it (a line break inside the paragraph; justified lines
      // still stretch), so small differences in font widths cannot reflow the page.
      if (i > 0 && runs.length && rs.length) rs[0] = flow ? { ...rs[0], lj: true } : { ...rs[0], br: true };
      runs.push(...rs);
    });
    const before = prevBase === null ? 0 : Math.max(0, prevBase - first.base - (1 - BASE) * (prevPitch || pitch) - BASE * pitch);
    // Justified Arabic is stretched with tatweel glyphs that overlap in the PDF; the text keeps none of
    // them and Word stretches the lines itself (kashida justification), to the same width.
    // Only where the page stretched its lines with tatweel (Word-style); a page justified by widening spaces keeps that.
    // (A few tatweels in a page justified by its spaces — a legacy book's occasional stretch — are not that:
    // Word's kashida justification would stretch every line with them.)
    const allText = runs.map((r) => r.text).join('');
    const stretches = (allText.match(/\u0640+/g) ?? []).length, words = allText.split(/\s+/).filter(Boolean).length;
    const kashida = align === 'both' && rtl && stretches > 0 && stretches >= Math.max(1, words * 0.12);
    if (!kashida && align === 'both' && rtl) for (const r of runs) r.text = dropStretch(r.text);
    // Elsewhere a stretch drawn as overlapping tatweels would come out wider than the page drew it: it goes
    // (a single tatweel — "بـ(" — is writing, not stretching, and stays).
    else if (!kashida && rtl) for (const r of runs) r.text = r.text.replace(/(?<=[\u0620-\u064a][\u064b-\u0652]*)\u0640{2,}/g, '');
    if (kashida) for (const r of runs) { if (r.text.includes('\u0640')) r.kText = r.text; r.text = dropStretch(r.text); }
    // A wide gap before a run that fills the rest of the line is a stretched word space, not a tab: a tab there
    // would leave the run no room and push it onto a line of its own.
    for (const r of runs) if (r.tab !== undefined) {
      const pos = rtl ? R + 3 - r.tab : r.tab - (L - 3);
      if (pos + r.text.length * r.size * 0.45 > R - L + 6) { r.tab = undefined; r.text = ` ${r.text}`; }
    }
    const tabX = runs.filter((r) => r.tab !== undefined).map((r) => r.tab!);
    let tabs: Para['tabs'];
    if (tabX.length) {
      // Tab stops are measured from the text's edge (the margin, 3pt outside L/R).
      // A piece set at the very end of the line stops a little short of it, so a slightly wider font cannot push it over.
      const room = R - L + 6;
      const at = (x: number) => (rtl ? R + 3 - x : x - (L - 3));
      const half = (v: number) => Math.round(v * 2) / 2;
      // The lines' tabbed stretches gathered into columns (stretches that overlap across the lines), one stop each:
      // where a column's stretches line up — their starts, their ends (numbers set flush right), their middles.
      // (A stop per stretch, the lines of a paragraph sharing them, sent a short stretch of one line to a stop meant
      // for another's.)
      const segs = runs.filter((r) => r.tab !== undefined).map((r) => { const a = at(r.tab!), b = at(r.tabEnd ?? r.tab!); return { a: Math.min(a, b), b: Math.max(a, b), r }; }).sort((x, y) => x.a - y.a);
      const cols: (typeof segs)[] = [];
      for (const g of segs) { const c = cols[cols.length - 1]; if (c && g.a < Math.max(...c.map((x) => x.b)) + 1) c.push(g); else cols.push([g]); }
      tabs = cols.map((c) => {
        const w = Math.max(...c.map((g) => g.r.text.length * g.r.size * 0.5));
        const spread = (f: (g: (typeof segs)[number]) => number) => Math.max(...c.map(f)) - Math.min(...c.map(f));
        const left = spread((g) => g.a), right = spread((g) => g.b), mid = spread((g) => (g.a + g.b) / 2);
        if (!rtl && c.length > 1 && right + 1 < left && right <= mid) return { pos: half(Math.min(room - 3, Math.max(...c.map((g) => g.b)))), type: 'right' as const };
        if (!rtl && c.length > 1 && mid + 1 < left && mid < right) return { pos: half((Math.min(...c.map((g) => g.a)) + Math.max(...c.map((g) => g.b))) / 2), type: 'center' as const };
        return { pos: half(Math.max(0, Math.min(Math.min(...c.map((g) => g.a)), room - w * 1.25 - 3))), type: 'left' as const };
      }).filter((tb, i, all) => !all.slice(0, i).some((o) => o.pos === tb.pos)).sort((x, y) => x.pos - y.pos);
      // Positioned text: set flush from the start, no stretching (a justified line would spread the text after the last tab).
      if (align === 'center' || ls.length === 1) { indStart = 0; indEnd = 0; firstLine = Math.max(0, startGap(first)); }
      align = 'start';
    }
    // (Where the text after a list's mark starts on the page — its indent in the list — read off the first line's pieces.)
    let lead: number | undefined;
    if (edit) {
      const ps = first.pieces.filter((p) => (p.text.trim() && p.text !== '\u2009') || p.art).sort((a, b) => (first.rtl ? b.r - a.r : a.l - b.l));
      const p0 = ps[0]; const edgeOf = (x: number) => (first.rtl ? R - x : x - L);
      const solo = /^\s*(?:[\u2022\u25e6\u25aa\u25ab\u25a0\u25cf\u25cb\u2023\u2219\u00b7\u2043\u2013\u2014*\-\uf0b7\uf0a7\uf0d8o]|\(?(?:[0-9]{1,3}|[a-zA-Z]|[ivxIVX]{1,4}|[\u0621-\u064a]|[\u0660-\u0669]{1,3})[.)]|\([0-9a-zA-Z\u0621-\u064a]{1,3}\)|[0-9]{1,3})\s*$/;
      if (p0 && ps[1] && ((p0.art && p0.r - p0.l < first.size * 0.9) || solo.test(p0.text))) lead = edgeOf(first.rtl ? ps[1].r : ps[1].l);
      else if (p0 && !p0.art) {
        const m = /^\s*([\u2022\u25e6\u25aa\u25ab\u25a0\u25cf\u25cb\u2023\u2219\u00b7\u2043\u2013\u2014*\-\uf0b7\uf0a7\uf0d8]|\(?(?:[0-9]{1,3}|[a-zA-Z]|[ivxIVX]{1,4}|[\u0621-\u064a]|[\u0660-\u0669]{1,3})[.)]|\([0-9a-zA-Z\u0621-\u064a]{1,3}\)|[0-9]{1,3})\s+\S/u.exec(p0.text);
        if (m) {
          const ns = m[1].replace(/\s/g, '').length; const gl = (p0.codes ?? []).filter((u) => u[1] && u[1].trim()).sort((a, b) => (first.rtl ? b[2] - a[2] : a[2] - b[2]));
          if (gl.length > ns) lead = edgeOf(first.rtl ? gl[ns][2] + gl[ns][5] * gl[ns][4] : gl[ns][2]);
          else { const k = m[0].length - 1; const f = k / Math.max(1, p0.text.length); lead = edgeOf(first.rtl ? p0.r - (p0.r - p0.l) * f : p0.l + (p0.r - p0.l) * f); }
        }
      }
    }
    blocks.push({ kind: 'p', runs, align, kashida, rtl, indStart, indEnd, firstLine, before, pitch, size, tabs, base0: first.base, base1: ls[ls.length - 1].base, lead });
    prevBase = ls[ls.length - 1].base; prevPitch = pitch;
    cur = null;
  };
  let verse: Verse | null = null;
  const closeVerse = () => { if (verse) blocks.push(verse); verse = null; };
  const splits = lines.map((l) => splitVerse(l, L, R) as ReturnType<typeof splitVerse> & { weak?: number; numbered?: boolean } | null);
  const gapAt = (h: (typeof splits)[number]) => (h ? h.weak ?? (Math.max(...h[1].map((p) => p.r)) + Math.min(...h[0].map((p) => p.l))) / 2 : NaN);
  lines.forEach((l, i) => {
    const h = splits[i]; if (!h || h.weak === undefined) return;
    const near = [splits[i - 1], splits[i + 1]].some((o) => o && Math.abs(gapAt(o) - h.weak!) < l.size * 1.5);
    // (A lone verse shows itself by its halves: each stretched with tatweel to fill its half of the line.)
    const stretched = (ps: Piece[]) => ps.some((p) => /\u0640/.test(p.text));
    // (Or by its number set before it, with one half stretched: a lone verse quoted in a commentary, «-٦٥ سَلِي…».)
    if (!near && !(stretched(h[0]) && stretched(h[1])) && !(h.numbered && (stretched(h[0]) || stretched(h[1])))) splits[i] = null;
  });
  // The pitch a paragraph's lines are set at, for each size: the tighter of the steps between lines here (a
  // quarter of them are at most this). The page's median step, on a page of many short paragraphs, is the wider
  // step between paragraphs.
  const tight = new Map<number, number>();
  {
    const steps = new Map<number, number[]>();
    const plain = lines.filter((l) => !l.grid && !l.spacer);
    plain.forEach((l, i) => { const n = plain[i + 1]; if (n && Math.abs(n.size - l.size) < l.size * 0.1) { const d = l.base - n.base; if (d > l.size * 0.9 && d < l.size * 2.6) { const k = Math.round(l.size); steps.set(k, [...(steps.get(k) ?? []), d]); } } });
    for (const [k, d] of steps) if (d.length >= 3) tight.set(k, [...d].sort((a, b) => a - b)[Math.floor(d.length / 4)]);
  }
  // Where the lines after a paragraph's first start, for each size (for a page's notes, set in from the text's
  // edge, that is not the edge).
  const conts = new Map<number, number[]>();
  const contsDir = new Map<string, number[]>(); // (the same, apart for each direction: see editBreak)
  const texts = new Map<Line, string>();
  const textOf = (l: Line) => { let t = texts.get(l); if (t === undefined) { t = joinLine(l.pieces.map((p) => ({ text: p.text, l: p.l, r: p.r, h: p.h, keep: p.keep }))).text; texts.set(l, t); } return t; };
  const numberedAt = (l: Line) => /^\s*[(（[]?[0-9\u0660-\u0669\u06F0-\u06F9]+\s?[)）\].\-–]/.test(textOf(l));
  // For a document to edit: where one paragraph ends and the next starts, read off the page as a reader would —
  // whatever the text's alignment (ragged right, ragged left, centred, justified).
  const markerAt = (l: Line) => LIST_MARK.test(textOf(l)) || (() => { const ps = [...l.pieces].filter((p) => p.text.trim() || p.art).sort((a, b) => (l.rtl ? b.r - a.r : a.l - b.l)); return !!ps[0]?.art && ps[0].r - ps[0].l < l.size * 0.9; })();
  const firstWordW = (l: Line) => {
    const ps = l.pieces.filter((p) => p.text !== ' ' && p.text.trim()).sort((a, b) => (l.rtl ? b.r - a.r : a.l - b.l));
    if (!ps.length) return 0;
    // (Glyphs set without spaces between words: CJK breaks anywhere, a character is the word.)
    if (/^[　-鿿豈-﫿＀-￯]/.test(ps[0].text.trim())) return ps[0].h;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]; const t = p.text.replace(/^\s+/, ''); const cut = t.search(/\s/);
      if (cut >= 0) { w += (p.r - p.l) * (cut / Math.max(1, t.length)); break; }
      w += p.r - p.l;
      const n = ps[i + 1]; if (!n || (l.rtl ? p.l - n.r : n.l - p.r) > p.h * 0.12) break;
    }
    return w;
  };
  const boldLine = (l: Line) => { const ps = l.pieces.filter((p) => p.text.trim()); return ps.length > 0 && ps.every((p) => p.bold || /bold|black|heavy|semibold|demi/i.test(fonts.get(p.font)?.family ?? '') || !!fonts.get(p.font)?.bold); };
  const editBreak = (ls: Line[], line: Line): boolean => {
    const why = (k: number) => { if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D break', k, textOf(line).slice(0, 30)); return true; };
    const last = ls[ls.length - 1];
    const gap = last.base - line.base;
    // (The lines' own step, or the page's tightest for that size.)
    const inner = ls.length > 1 ? median(ls.slice(1).map((l, i) => ls[i].base - l.base)) : tight.get(Math.round(last.size)) ?? pitchOf(last.size);
    if (Math.abs(line.size - last.size) > last.size * 0.12) return why(1);
    if (gap > inner * 1.3 || gap < last.size * 0.5) return why(2);
    if (line.rtl !== last.rtl) return why(3);
    if (markerAt(line)) return why(4);
    // (Code — a monospaced line — keeps its lines.)
    if ([line, last].some((l) => l.pieces.some((p) => p.text.trim() && /mono|courier|consol|typewriter|menlo|code/i.test(fonts.get(p.font)?.family ?? '')))) return why(5);
    if (boldLine(line) !== boldLine(last) && ls.length === 1) return why(6);
    // (After a sentence's end, a line that starts with a number or a note's mark and then a capital — the next note,
    // the next numbered entry — starts anew.)
    if (END_PUNCT.test(textOf(last).trimEnd()) && /^\s*(?:[0-9]{1,3}|[*\u2020\u2021\u00a7])\s*\p{Lu}/u.test(textOf(line))) return why(7);
    // A word broken at the line's end goes on in the next line.
    const lastText = textOf(last).trimEnd();
    if (/\p{L}[-\u00ad\u2010]$/u.test(lastText) && /^\s*\p{L}/u.test(textOf(line))) return false;
    // A line that had room for the next line's first word ended there on purpose. (The measure: the text's, or the
    // paragraph's own where its lines stop short of it all alike — an indented block, a narrower column.)
    const all = [...ls, line];
    const own = last.rtl ? Math.min(...all.map((l) => l.l)) : Math.max(...all.map((l) => l.r));
    // (Only a measure of some length: short lines one under another — an address, a list of names — are short on
    // purpose, whatever the longest of them.)
    const ownOk = (last.rtl ? R - own : own - L) >= (R - L) * 0.6;
    const room = centered(last) ? Math.max(...all.map((l) => l.r - l.l)) - (last.r - last.l) : ownOk ? Math.min(endGap(last), last.rtl ? last.l - own : own - last.r) : endGap(last);
    if (room > firstWordW(line) + last.size * 0.6 + tolOf(last) * 0.5) return why(8);
    // Centred lines go on together; a centred line after one that is not (or the reverse) starts anew.
    if (centered(line) !== centered(last)) return why(9);
    if (centered(line) && centered(last)) return false;
    // A line set in further than the paragraph's lines start is a new paragraph's first line — save the lines
    // after a list item's mark, which start where its text does.
    const hang = ls.length === 1 && markerAt(last);
    if (!hang && startGap(line) > (ls.length > 1 ? Math.min(...ls.slice(1).map(startGap)) : startGap(last)) + tolOf(line)) return why(10);
    if (hang && startGap(line) < startGap(last) - tolOf(line)) return why(11);
    // (After a paragraph of one line set in — its first line's indent, where this page's paragraphs go on at their
    // edge — a line set in as far is the next paragraph's first.)
    if (ls.length === 1 && !hang) { const cs = contsDir.get(`${line.rtl}|${Math.round(line.size)}`); if (cs && startGap(last) > median(cs) + tolOf(last) * 0.5 && startGap(line) > startGap(last) - tolOf(line) * 0.5) return why(12); }
    if (ls.length > 1 && startGap(line) < Math.min(...ls.slice(1).map(startGap)) - tolOf(line) && startGap(last) - startGap(line) > tolOf(line)) return why(13);
    return false;
  };
  for (const [li, line] of lines.entries()) {
    if (line.grid) {
      closePara(); closeVerse();
      const g = line.grid; const rtl = line.rtl;
      const rowsRuns: Run[][][] = []; const cells: Grid['cells'] = [];
      g.rows.forEach((row) => {
        const rr: Run[][] = []; const cc: Grid['cells'][number] = [];
        for (const c of row) {
          const runs: Run[] = [];
          const lineY = new Map(c.lines.map((l) => [l, median(l.map((p) => p.y))]));
          const ls = [...c.lines].sort((a, b) => lineY.get(b)! - lineY.get(a)!);
          ls.forEach((ps, i) => { const rs = runsOf(ps, fonts, rtl); if (i > 0 && runs.length && rs.length) rs[0] = { ...rs[0], br: true }; runs.push(...rs); });
          const cl = g.xs[c.c0], cr = g.xs[c.c0 + c.span];
          const all = c.lines.flat().filter((p) => p.text.trim() && p.text !== '\u2009');
          let align: Para['align'] = 'start'; let pitch = all.length ? median(all.map((p) => p.h)) * 1.25 : 12;
          if (all.length) {
            const lo = Math.min(...all.map((p) => p.l)), hi = Math.max(...all.map((p) => p.r));
            const a = lo - cl, b = cr - hi;
            if (Math.abs(a - b) < Math.max(3, (cr - cl) * 0.08) && a > 3) align = 'center';
            else if (rtl ? b > a + 3 && a < 6 : a > b + 3 && b < 6) align = 'end';
            if (ls.length > 1) pitch = median(ls.slice(1).map((l, i) => lineY.get(ls[i])! - lineY.get(l)!));
            // (One line fills its row exactly, or the row grows.)
            else pitch = Math.min(pitch, g.ys[g.rows.indexOf(row)] - g.ys[g.rows.indexOf(row) + 1] - 0.3);
          }
          rr.push(c.cont ? [] : runs);
          cc.push({ span: c.span, vmerge: c.cont ? 'continue' : g.rows[g.rows.indexOf(row) + 1]?.some((x) => x.cont && x.c0 === c.c0 && x.span === c.span) ? 'restart' : undefined, align, vcenter: false, pitch });
        }
        rowsRuns.push(rr); cells.push(cc);
      });
      // (An open table's columns have no edges drawn: each column's cells align as their text lines up — on its
      // right, numbers set flush; on its middle; else at its start.)
      if (g.rules) for (let k = 0; k + 1 < g.xs.length; k++) {
        const ext = g.rows.map((row) => row.find((c) => c.c0 === k)).filter((c): c is GridCell => !!c).map((c) => c.lines.flat().filter((p) => p.text.trim())).filter((ps) => ps.length).map((ps) => [Math.min(...ps.map((p) => p.l)), Math.max(...ps.map((p) => p.r))]);
        if (ext.length < 2) continue;
        const spread = (f: (e: number[]) => number) => Math.max(...ext.map(f)) - Math.min(...ext.map(f));
        const al: Para['align'] = spread((e) => e[0]) < 1.5 ? 'start' : spread((e) => e[1]) < 1.5 ? 'end' : spread((e) => (e[0] + e[1]) / 2) < 1.5 ? 'center' : 'start';
        g.rows.forEach((row, j) => row.forEach((c, kk) => { if (c.c0 === k) cells[j][kk].align = rtl ? (al === 'start' ? 'end' : al === 'end' ? 'start' : al) : al; }));
      }
      // A cell's text sits in the middle of its row when it has room above and below alike.
      g.rows.forEach((row, j) => row.forEach((c, k) => {
        const ps = c.lines.flat().filter((p) => p.text.trim()); if (!ps.length || c.cont) return;
        let bottomY = g.ys[j + 1]; for (let jj = j + 1; jj < g.rows.length && g.rows[jj].some((x) => x.cont && x.c0 === c.c0); jj++) bottomY = g.ys[jj + 1];
        const top = Math.max(...ps.map((p) => p.y + p.h * 0.8)), bot = Math.min(...ps.map((p) => p.y - p.h * 0.25));
        const above = g.ys[j] - top, below = bot - bottomY;
        if (Math.abs(above - below) < Math.max(2, (g.ys[j] - bottomY) * 0.15)) cells[j][k].vcenter = true;
      }));
      const size = line.size; const pitch = pitchOf(size);
      const before = prevBase === null ? 0 : Math.max(0, prevBase - (1 - BASE) * (prevPitch || pitch) - g.ys[0]);
      const colW = g.xs.slice(1).map((x, i) => x - g.xs[i]);
      // Room inside the cells: as much as the page leaves before the text starts.
      const insets = g.rows.flatMap((row) => row.flatMap((c) => { const ps = c.lines.flat().filter((p) => p.text.trim()); if (!ps.length) return []; const cl = g.xs[c.c0], cr = g.xs[c.c0 + c.span]; return [Math.min(Math.min(...ps.map((p) => p.l)) - cl, cr - Math.max(...ps.map((p) => p.r)))]; }));
      const room = g.rows.flatMap((row) => row.flatMap((c) => { const ps = c.lines.flat().filter((p) => p.text.trim()); if (!ps.length) return []; return [(g.xs[c.c0 + c.span] - g.xs[c.c0] - (Math.max(...ps.map((p) => p.r)) - Math.min(...ps.map((p) => p.l)))) / 2]; }));
      const pad = insets.length ? Math.max(0.5, Math.min(6, median(insets), Math.min(...room) * 0.6)) : 2;
      const rowH = g.ys.slice(1).map((y, i) => g.ys[i] - y);
      blocks.push({ kind: 'grid', pad, rows: rowsRuns, cells, spec: g, colW, rowH, rtl, before, indStart: rtl ? R - g.xs[g.xs.length - 1] : g.xs[0] - L, size, pitch });
      prevPitch = pitch; prevBase = g.ys[g.ys.length - 1] + (1 - BASE) * pitch;
      continue;
    }
    if (line.spacer) {
      closePara(); closeVerse();
      const pitch = line.spacer;
      const before = prevBase === null ? 0 : Math.max(0, prevBase - line.base - (1 - BASE) * (prevPitch || pitch) - BASE * pitch);
      blocks.push({ kind: 'p', runs: [], align: 'start', rtl: line.rtl, indStart: 0, indEnd: 0, firstLine: 0, before, pitch, size: line.size });
      prevBase = line.base; prevPitch = pitch;
      continue;
    }
    const halves = splits[li];
    if (halves) {
      closePara();
      const rtl = line.rtl;
      const midRuns = halves[2].length ? runsOf(halves[2], fonts, rtl) : null;
      const first = rtl ? halves[0] : halves[1], second = rtl ? halves[1] : halves[0];
      // A half-line has exactly its cell's width: when its letters and word spaces (at a common space's width)
      // would not fit there — the page set its spaces narrower — it is set that much narrower, or it would
      // break onto two lines.
      const fit = (ps: Piece[], runs: Run[]) => {
        const iv = ps.filter((p) => p.text.trim() && p.text !== '\u2009').map((p) => [p.l, p.r]).sort((a, b) => a[0] - b[0]);
        if (!iv.length) return runs;
        let ink = 0, a = iv[0][0], b = iv[0][1];
        for (const [l, r] of iv.slice(1)) { if (l > b) { ink += b - a; a = l; b = r; } else b = Math.max(b, r); }
        ink += b - a;
        const span = Math.max(...iv.map((x) => x[1])) - iv[0][0];
        const spaces = runs.reduce((n, r) => n + (r.text.trim().match(/\s+/g)?.length ?? 0), 0);
        // (What Word will lay out is the glyphs' own advances, not the ink: a kashida drawn as tatweels set over
        // one another takes all their advances in Word, and the half-line broke in two.)
        const adv = ps.reduce((t, p) => t + (p.codes ?? []).reduce((a, u) => a + (u[5] > 0 && !/^\s+$/.test(u[1]) ? u[5] * u[4] : 0), 0), 0);
        const need = Math.max(ink, adv) + spaces * line.size * 0.3;
        if (need <= span * 0.99) return runs;
        const k = Math.max(0.8, (span * 0.99) / need);
        return runs.map((r) => ({ ...r, cs: Math.round((r.cs ?? 100) * k) }));
      };
      const row: Run[][] = midRuns ? [fit(first, runsOf(first, fonts, rtl)), midRuns, fit(second, runsOf(second, fonts, rtl))] : [fit(first, runsOf(first, fonts, rtl)), fit(second, runsOf(second, fonts, rtl))];
      const midW = halves[2].length ? Math.max(...halves[2].map((p) => p.r)) - Math.min(...halves[2].map((p) => p.l)) + line.size : 0;
      const ext = (a0: Piece[]) => { const a = a0.filter((p) => p.text.trim() && p.text !== '\u2009'); return a.length ? [Math.min(...a.map((p) => p.l)), Math.max(...a.map((p) => p.r))] : [0, 0]; };
      const gap = halves[2].length ? 0 : Math.max(0, ext(halves[0])[0] - ext(halves[1])[1]);
      if (verse && prevBase !== null && prevBase - line.base < pitchOf(line.size) * 2.2 && verse.rows[0].length === row.length) { verse.rows.push(row); verse.midW = Math.max(verse.midW, midW); verse.gap = Math.min(verse.gap || gap, gap || verse.gap); }
      else {
        closeVerse();
        const pitch = pitchOf(line.size);
        verse = { kind: 'verse', rows: [row], rtl, before: prevBase === null ? 0 : Math.max(0, prevBase - line.base - (1 - BASE) * (prevPitch || pitch) - BASE * pitch), pitch, size: line.size, width: line.r - line.l, indStart: Math.max(0, rtl ? R - line.r : line.l - L), midW, gap };
      }
      if (verse.rows.length > 1) verse.pitch = (verse.pitch + (prevBase! - line.base)) / 2;
      // (Each half's width, for a verse whose first half carries its number: see verseFor.)
      const span = (a: Piece[]) => { const [x0, x1] = ext(a); return x1 - x0; };
      (verse.exts ??= []).push([span(first), span(second)]);
      if (halves.numbered) verse.lead = true;
      prevBase = line.base; prevPitch = verse.pitch;
      continue;
    }
    closeVerse();
    if (cur && edit) {
      if (editBreak(cur.lines, line)) closePara();
    } else if (cur) {
      const last = cur.lines[cur.lines.length - 1];
      const p = cur.lines.length > 1 ? cur.lines[1].base - cur.lines[0].base : 0;
      const pitch = cur.lines.length > 1 ? Math.abs(p) : pitchOf(last.size);
      const gap = last.base - line.base;
      const brk = Math.abs(line.size - last.size) > last.size * 0.12
        || gap > pitch * 1.45
        || (endGap(last) > tolOf(last) * 1.2 && !centered(last))
        || (startGap(line) > startGap(last) + tolOf(line) && full(last) && !(cur.lines.length === 1 && /^\s*[(（[]?[0-9\u0660-\u0669\u06F0-\u06F9]+[)）\].\-–]/.test(joinLine(last.pieces.map((p) => ({ text: p.text, l: p.l, r: p.r, h: p.h, keep: p.keep }))).text)))
        || (cur.lines.length > 1 && Math.abs(startGap(line) - startGap(cur.lines[cur.lines.length - 1])) > tolOf(line) && startGap(cur.lines[1]) - startGap(cur.lines[0]) > tolOf(line) && full(last))
        || centered(line) !== centered(last)
        || (centered(line) && centered(last))
        || (() => {
          // A step a fifth wider than the paragraph's own, before a line that starts as a paragraph does: numbered,
          // or set in past where the paragraph's lines start — or, after a paragraph of one full line set in, set
          // in as far again. (The step alone is not enough: a line with taller glyphs, a Quran font, is set lower
          // in its paragraph by as much.)
          const inner = cur.lines.length > 1 ? Math.min(...cur.lines.slice(1).map((l, i) => cur!.lines[i].base - l.base)) : tight.get(Math.round(last.size)) ?? pitchOf(last.size);
          if (!(gap > inner * 1.2) || Math.abs(line.size - last.size) > last.size * 0.05) return false;
          if (numberedAt(line)) return true;
          if (cur.lines.length > 1) return startGap(line) - Math.min(...cur.lines.slice(1).map(startGap)) > tolOf(line) * 0.5;
          const cs = conts.get(Math.round(line.size));
          return !!cs && endGap(last) < tolOf(last) * 0.5 && startGap(last) > median(cs) + tolOf(last) * 0.5 && startGap(line) > startGap(last) - tolOf(line) * 0.5 && !numberedAt(last);
        })();
      if (brk) closePara();
    }
    if (!cur) cur = { lines: [] };
    cur.lines.push(line);
    if (cur.lines.length > 1) { const k = Math.round(line.size); (conts.get(k) ?? conts.set(k, []).get(k)!).push(startGap(line)); const kd = `${line.rtl}|${k}`; (contsDir.get(kd) ?? contsDir.set(kd, []).get(kd)!).push(startGap(line)); }
  }
  closePara(); closeVerse();
  return blocks;
}

/** Running heads and page numbers: each item centred on where its glyphs are, so a font's slightly different
 *  width cannot move it out of its ornament. */
/** The turned glyphs gathered into lines — the same angle, the same baseline, in order along it, a space where a
 *  gap is one — each a text box turned as the page turns it (Word turns a box about its centre, clockwise). */
function turnedBoxes(items: { text: string; angle: number; e: number; f: number; w: number; h: number; font: string; color: string; bold: boolean }[], fonts: Map<string, FontInfo>, H: number): TextBox[] {
  const out: TextBox[] = []; const used = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue; const a = items[i]; const cs = Math.cos(a.angle), sn = Math.sin(a.angle);
    const along = (t: typeof a) => t.e * cs + t.f * sn, across = (t: typeof a) => -t.e * sn + t.f * cs;
    const line = [i]; for (let j = i + 1; j < items.length; j++) { const b = items[j]; if (used.has(j) || Math.abs(b.angle - a.angle) > 0.02 || Math.abs(across(b) - across(a)) > a.h * 0.4 || Math.abs(b.h - a.h) > a.h * 0.5) continue; line.push(j); }
    line.forEach((k) => used.add(k)); line.sort((x, y) => along(items[x]) - along(items[y]));
    const runs: Run[] = []; let end = -Infinity; const first = items[line[0]]; let last = first;
    for (const k of line) {
      const t = items[k]; const start = along(t); let text = t.text;
      if (end > -Infinity && start - end > t.h * 0.22 && !/^\s/.test(text) && !/\s$/.test(runs[runs.length - 1]?.text ?? '')) text = ' ' + text;
      end = Math.max(end, start + t.w); last = along(t) + t.w > along(last) + last.w ? t : last;
      const fi = fonts.get(t.font); const look = { font: fi?.family ?? 'Arial', size: Math.round(t.h * 2) / 2, bold: !!(fi?.bold || t.bold), italic: !!fi?.italic, color: t.color, rtl: isRtlText(text), sup: false };
      const prev = runs[runs.length - 1];
      if (prev && prev.font === look.font && prev.size === look.size && prev.bold === look.bold && prev.italic === look.italic && prev.color === look.color) prev.text += text; else runs.push({ text, ...look });
    }
    if (!runs.some((r) => r.text.trim())) continue;
    const h = first.h; const L = h * 1.3; const w = Math.max(1, along(last) + last.w - along(first)) + h * 0.3;
    // The baseline's start on the page (points, y down), and from it the centre of the unturned box: the box's
    // baseline sits BASE·L below its top, and its left edge at the first glyph.
    const p0x = first.e, p0y = H - first.f; const vx = -w / 2, vy = BASE * L - L / 2;
    const rx = vx * cs + vy * sn, ry = -vx * sn + vy * cs;   // (v turned as the text is, in y-down coordinates)
    const cx = p0x - rx, cy = p0y - ry;
    // (Word places a turned shape by the top-left of its turned bounding box; the extent stays the unturned size.)
    const bw = Math.abs(w * cs) + Math.abs(L * sn), bh = Math.abs(w * sn) + Math.abs(L * cs);
    out.push({ runs, x: cx - bw / 2, y: cy - bh / 2, w, h: L, rot: -a.angle * 180 / Math.PI, line: L });
  }
  return out;
}
function pinnedFurniture(header: Line[], footer: Line[], fonts: Map<string, FontInfo>, H: number): Furniture[] {
  const furniture: Furniture[] = [];
  for (const l of [...header, ...footer]) {
    const ps = l.pieces.filter((p) => p.text.trim() || p.text === '\u2009').sort((a, b) => a.l - b.l);
    const groups: Piece[][] = [];
    for (const p of ps) { const g = groups[groups.length - 1]; if (g && p.l - Math.max(...g.map((q) => q.r)) < l.size * 2.5) g.push(p); else groups.push([p]); }
    // (A page number at either end an item of its own even nearer its head than that, for its PAGE field.)
    const num = (g: Piece[]) => /^[\s\-\u2013\u2014()[\]]*[0-9\u0660-\u0669\u06F0-\u06F9]{1,4}[\s\-\u2013\u2014()[\]]*$/.test(g.map((p) => p.text).join(''));
    for (const end of [0, 1]) {
      const gi = end ? groups.length - 1 : 0, g = groups[gi];
      if (!g || g.length < 2) continue;
      for (let k = 1; k < g.length; k++) {
        const inner = end ? g.slice(0, g.length - k) : g.slice(k), outer = end ? g.slice(g.length - k) : g.slice(0, k);
        const gap = end ? Math.min(...outer.map((p) => p.l)) - Math.max(...inner.map((p) => p.r)) : Math.min(...inner.map((p) => p.l)) - Math.max(...outer.map((p) => p.r));
        if (gap > l.size && num(outer) && !num(inner)) { groups.splice(gi, 1, ...(end ? [inner, outer] : [outer, inner])); break; }
      }
    }
    for (const g of groups) {
      const runs = runsOf(g, fonts, l.rtl); if (!runs.length) continue;
      furniture.push({ runs, cx: (Math.min(...g.map((p) => p.l)) + Math.max(...g.map((p) => p.r))) / 2, base: H - l.base, size: l.size, top: header.includes(l) });
    }
  }
  return furniture;
}

const FOLIO_MARK = /^[\s\-\u2013\u2014()[\]{}\u00ab\u00bb\ufd3e\ufd3f*\u2022|\u0640]*$/;
/** A page number in a running head's or footer's text: where it stands in the text, its value and its digits —
 *  alone or between marks ("- ١٢ -", "(xii)"), or at either end of a head, a space away from its words. */
function folioIn(text: string): Furniture['num'] | null {
  for (const m of text.matchAll(/[0-9\u0660-\u0669\u06F0-\u06F9]+|[ivxlcdm]+|[IVXLCDM]+/g)) {
    const a = m.index!, b = a + m[0].length, before = text.slice(0, a), after = text.slice(b);
    const alone = FOLIO_MARK.test(before) && FOLIO_MARK.test(after);
    const roman = /[ivxlcdm]/i.test(m[0]);
    // (At an end of a head: only digits, and a space between it and the head's words.)
    const atEnd = !roman && ((FOLIO_MARK.test(before) && /^[^\s\p{L}\p{N}]*\s/u.test(after) && /\p{L}/u.test(after)) || (FOLIO_MARK.test(after) && /\s[^\s\p{L}\p{N}]*$/u.test(before) && /\p{L}/u.test(before)));
    if (!alone && !atEnd) continue;
    if (!roman) {
      if (m[0].length > 4) continue;
      const value = [...m[0]].reduce((v, c) => v * 10 + ((c.codePointAt(0)! - (c >= '\u06F0' ? 0x6f0 : c >= '\u0660' ? 0x660 : 0x30))), 0);
      return { from: a, to: b, value, fmt: /[0-9]/.test(m[0]) ? 'decimal' : 'hindiNumbers' };
    }
    const vals: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    const ds = [...m[0].toLowerCase()].map((c) => vals[c]);
    const value = ds.reduce((v, d, i) => v + (d < (ds[i + 1] ?? 0) ? -d : d), 0);
    // (Only a numeral written the usual way: not a word that happens to be made of those letters.)
    const roman2 = (n: number) => { let out = ''; for (const [k, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as [number, string][]) while (n >= k) { out += r; n -= k; } return out; };
    if (value > 0 && value < 400 && roman2(value) === m[0].toLowerCase()) return { from: a, to: b, value, fmt: m[0] === m[0].toLowerCase() ? 'lowerRoman' : 'upperRoman' };
  }
  return null;
}

/** Across the pages: which head or foot numbers are the pages' numbers (each in step with a number a few pages
 *  away: the same distance from its page's place in the file), made PAGE fields; and the lines taken for a
 *  running head that are none — no page number among them, their words on no other page near — go back into the
 *  text where the page has them (a heading or the text's first line at the top of a page). */
/** A paragraph that a page break cuts (its page's last, without a sentence's end; the next page's first going on
 *  in the same type, from a small letter or mid-sentence, not set in as a new paragraph is): one paragraph, on the
 *  first page, the next page going on from it without a break (see `cont`). For a document to edit. */
const END_PUNCT = /[.!?:;…"”’'»)\]؟۔。！？」』]\s*$/;
/** A page's notes become Word footnotes (a document to edit) when each is numbered and its number stands raised
 *  in the page's text. */
function realNotes(pg: PageModel): boolean {
  if (!p2d.edit || !pg.notes.length || pg.notes.some((n) => n.num < 0)) return false;
  const refs = new Set<number>(); for (const b of [...pg.body, ...(pg.regions ?? []).flatMap((r) => r.cols.flat())]) { const rs = b.kind === 'p' ? [b.runs] : b.kind === 'grid' ? b.rows.flat() : []; for (const runs of rs) for (const r of runs) if (r.note !== undefined) refs.add(r.note); }
  return pg.notes.every((n) => refs.has(n.num));
}
function mergeAcrossPages(pages: PageModel[]): void {
  for (let k = 0; k + 1 < pages.length; k++) {
    const a = pages[k], b = pages[k + 1];
    if (a.placed?.length || b.placed?.length || a.regions?.length || b.regions?.length || a.vert || b.vert || (a.notesRaw.length && !realNotes(a))) continue;
    const last = a.body[a.body.length - 1], first = b.body[0];
    if (!last || !first || last.kind !== 'p' || first.kind !== 'p' || !last.runs.length || !first.runs.length) continue;
    const lt = last.runs.map((r) => r.text).join('').trimEnd(), ft = first.runs.map((r) => r.text).join('').trimStart();
    if (!lt || !ft || END_PUNCT.test(lt) || LIST_MARK.test(ft) || LIST_MARK.test(lt)) continue;
    if (last.rtl !== first.rtl || Math.abs(last.size - first.size) > last.size * 0.1 || last.align === 'center' || first.align === 'center') continue;
    if (first.firstLine > first.size * 0.6 || lt.length < 40) continue;
    // (Latin, Greek, Cyrillic go on with a small letter; scripts without case — Arabic, CJK — go on when the page
    // before ends mid-sentence, a word or a comma.)
    const caseless = !/[\p{Lu}\p{Ll}]/u.test(ft.slice(0, 1));
    if (!/^\p{Ll}/u.test(ft) && !(caseless && /\p{L}/u.test(ft.slice(0, 1)))) continue;
    first.runs[0] = { ...first.runs[0], lj: true, br: false };
    last.runs.push(...first.runs);
    b.body.shift(); b.cont = true;
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D cross-page', k + 1, lt.slice(-30), '|', ft.slice(0, 30));
  }
}

/** For a document to edit: where the pages simply ran full — the page's lowest line within a line and a half of the
 *  lowest the document's pages reach — the text goes on with no page break (Word finds its own pages); a page that ends
 *  visibly early (a chapter's end) keeps its break. Pages whose margins differ by a little (under 12 pt) take the
 *  first's, the indents keeping their text where it was: one geometry, no needless section changes. */
function flowPages(pages: PageModel[]): void {
  const lows = pages.filter((p) => p.low !== undefined && !p.placed?.length && !p.vert).map((p) => p.low!);
  if (lows.length < 2) return;
  const floor = Math.min(...lows);
  for (let k = 0; k + 1 < pages.length; k++) {
    const a = pages[k], b = pages[k + 1];
    if (a.low === undefined || a.placed?.length || b.placed?.length || a.vert || b.vert || a.w !== b.w || a.h !== b.h) continue;
    if (a.low - floor <= 1.5 * (a.lowPitch ?? 14)) b.cont = true;
  }
  for (let k = 1; k < pages.length; k++) {
    const a = pages[k - 1], b = pages[k];
    if (!b.cont || a.w !== b.w || a.h !== b.h) continue;
    const dl = b.m.left - a.m.left, dr = b.m.right - a.m.right;
    if (Math.abs(dl) >= 12 || Math.abs(dr) >= 12) continue;
    const sl = (b.m.slack?.[0] ?? 0) + dl, sr = (b.m.slack?.[1] ?? 0) + dr;
    if (sl < -0.5 || sr < -0.5) continue;
    b.m = { ...b.m, left: a.m.left, right: a.m.right, top: a.m.top, bottom: Math.min(a.m.bottom, b.m.bottom), slack: [sl, sr] };
  }
}

/** The lines of a paragraph to edit made one text: where a line joins the one before, a space — none between CJK
 *  characters — and a word broken by a hyphen at the line's end whole again, when it reads as one word: a small
 *  letter on both sides, no digit or capital at the joint, and the document never writing it with its hyphen
 *  inside a line (a soft hyphen always goes). */
function joinLines(pages: PageModel[]): void {
  const plain = new Map<string, number>(), hyph = new Map<string, number>();
  const count = (t: string) => { for (const m of t.matchAll(/\p{L}+(?:-\p{L}+)*/gu)) { const w = m[0].toLowerCase(); if (w.includes('-')) { hyph.set(w, (hyph.get(w) ?? 0) + 1); for (const part of [w.replace(/-/g, '')]) plain.set(part, (plain.get(part) ?? 0)); } else plain.set(w, (plain.get(w) ?? 0) + 1); } };
  const lists: Run[][] = [];
  for (const pg of pages) eachRunList(pg, (runs) => { if (runs.some((r) => r.lj)) lists.push(runs); for (const r of runs) count(r.text); });
  const CJK = /[　-鿿豈-﫿＀-￯]/;
  for (const runs of lists) for (let i = 1; i < runs.length; i++) {
    const r = runs[i]; if (!r.lj) continue; r.lj = undefined;
    let j = i - 1; while (j > 0 && !runs[j].text) j--;
    const prev = runs[j]; const a = prev.text, b = r.text;
    if (!a || !b) continue;
    const m = /(\p{L}+)([-­‐])\s*$/u.exec(a);
    if (m) {
      const left = m[1], right = (/^\s*(\p{L}+)/u.exec(b) ?? [])[1];
      if (m[2] === '­' && right) { prev.text = a.slice(0, m.index + left.length); r.text = b.replace(/^\s+/, ''); continue; }
      if (right && /^\p{Ll}/u.test(right) && /\p{Ll}$/u.test(left) && !/\d/.test(left + right)) {
        const joined = (left + right).toLowerCase(), withH = `${left}-${right}`.toLowerCase();
        if ((hyph.get(withH) ?? 0) === 0 || (plain.get(joined) ?? 0) > 0) { prev.text = a.slice(0, m.index + left.length); r.text = b.replace(/^\s+/, ''); continue; }
      }
      // (A compound broken at its own hyphen: the hyphen stays, no space after it.)
      if (m[2] !== '­') { prev.text = a.replace(/\s+$/, ''); r.text = b.replace(/^\s+/, ''); continue; }
    }
    if (/\s$/.test(a) || /^\s/.test(b)) continue;
    if (CJK.test(a.slice(-1)) || CJK.test(b[0])) continue;
    r.text = ' ' + b;
  }
}

/** The document's outline (its bookmarks): each entry's title, depth (1 for the top) and page (0-based, or -1). */
async function readOutline(doc: import('pdfjs-dist').PDFDocumentProxy): Promise<{ title: string; depth: number; page: number }[]> {
  const out: { title: string; depth: number; page: number }[] = [];
  const items = await doc.getOutline(); if (!items) return out;
  const walk = async (list: typeof items, depth: number) => {
    for (const it of list) {
      if (out.length > 2000) return;
      let page = -1;
      try { const d = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest; if (Array.isArray(d) && d[0] && typeof d[0] === 'object') page = await doc.getPageIndex(d[0] as Parameters<typeof doc.getPageIndex>[0]); else if (Array.isArray(d) && typeof d[0] === 'number') page = d[0]; } catch { /* no page */ }
      out.push({ title: it.title, depth, page });
      if (it.items?.length) await walk(it.items, depth + 1);
    }
  };
  await walk(items, 1);
  return out;
}

/** Lists of a document to edit, as numbering.xml has them: each list's levels (filled in when the document is
 *  written — see structure). */
type ListDef = { fmt: string; text: string; start: number; left: number; hanging: number; font?: string }[];
const writerLists: ListDef[] = [];

/** A document to edit gets the structure its pages show: headings — named by the document's outline when it has
 *  one, else told by their size and weight beside the text's — as Title and Heading 1–3, and lists — a bullet
 *  (a glyph, a symbol font's, or a small picture) or a number, letter or numeral with its stop or brackets at a
 *  paragraph's start — as Word lists: each list's kind, start and levels (by the marks' indents), the typed mark
 *  taken out of the text. Tables whose first row stands apart (bold) get a header row. */
function structure(pages: PageModel[], outline: { title: string; depth: number; page: number }[], lists: ListDef[]): void {
  lists.length = 0;
  const textOf = (b: Para) => b.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
  const fold = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const flowOf = (pg: PageModel): Block[][] => [pg.body, ...(pg.regions ?? []).flatMap((r) => r.cols)];
  // ---- headings
  const sizes = new Map<number, number>();
  for (const pg of pages) for (const bs of flowOf(pg)) for (const b of bs) if (b.kind === 'p') for (const r of b.runs) { const k = Math.round(r.size * 2) / 2; sizes.set(k, (sizes.get(k) ?? 0) + r.text.length); }
  const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;
  const lines = (b: Para) => 1 + b.runs.filter((r) => r.lj || r.br).length;
  const bold = (b: Para) => b.runs.filter((r) => r.text.trim()).every((r) => r.bold);
  const cands: { b: Para; page: number; key: number }[] = [];
  pages.forEach((pg, k) => { for (const bs of flowOf(pg)) for (const b of bs) {
    if (b.kind !== 'p' || !b.runs.length) continue; const t = textOf(b);
    if (!t || t.length > 150 || lines(b) > 2 || /[.,;:]$/.test(t) || LIST_MARK.test(t) || /^\d+$/.test(t)) continue;
    if (!/\p{L}/u.test(t)) continue;
    const big = b.size >= bodySize * 1.12, strong = bold(b) && b.size >= bodySize * 0.95 && t.length < 80;
    if (big || strong) cands.push({ b, page: k, key: Math.round(b.size * 2) / 2 + (bold(b) ? 0.25 : 0) });
  } });
  const keys = [...new Set(cands.map((c) => c.key))].sort((a, b) => b - a);
  // (The title: the first page's one paragraph in the biggest type, well over the text's.)
  const top = keys[0]; const tops = cands.filter((c) => c.key === top);
  const title = tops.length === 1 && tops[0].page === 0 && tops[0].b.size >= bodySize * 1.6 ? tops[0].b : null;
  const ranked = keys.filter((k) => !(title && k === top));
  for (const c of cands) c.b.heading = c.b === title ? 0 : Math.min(3, ranked.indexOf(c.key) + 1);
  // The outline, where it names a heading, says its level.
  if (outline.length) {
    const want = new Map<string, number>(); for (const o of outline) { const f = fold(o.title); if (f && !want.has(f)) want.set(f, o.depth); }
    const minDepth = Math.min(...outline.map((o) => o.depth));
    // (An outline whose one top entry is on the first page and holds all the others is the document's title over its
    // headings: that entry is the Title, the levels under it Heading 1, 2, 3.)
    const tops = outline.filter((o) => o.depth === minDepth);
    const titleKey = tops.length === 1 && outline.length > 1 && tops[0].page === 0 ? fold(tops[0].title) : null;
    if (titleKey) for (const pg of pages) for (const bs of flowOf(pg)) for (const b of bs) if (b.kind === 'p' && b.heading === 0 && fold(textOf(b)) !== titleKey) b.heading = 1;
    for (const pg of pages) for (const bs of flowOf(pg)) for (const b of bs) if (b.kind === 'p') {
      const k = fold(textOf(b)); const d = want.get(k); if (d === undefined || textOf(b).length > 200) continue;
      if (titleKey && k === titleKey) b.heading = 0; else if (b.heading !== 0 || titleKey) b.heading = Math.max(1, Math.min(3, d - minDepth + (titleKey ? 0 : 1)));
    }
  }
  // ---- lists
  type Item = { b: Para; kind: 'bullet' | 'number'; fmt: string; text: string; start: number; at: number; mark: string; font?: string };
  const markOf = (b: Para): Item | null => {
    const i = b.runs.findIndex((r) => r.text.trim() || r.art); if (i < 0) return null;
    const r = b.runs[i];
    // (A bullet kept as drawn — a symbol font's glyph — is the list's mark: the glyph it stands for, Word's own.)
    const glyph = (c: string) => ({ '\uf0b7': '•', '\uf0a7': '▪', '\uf0d8': '➢', '\uf06f': '◦', o: '◦', '\uf0fc': '✓', '\u25cf': '•', '\u25cb': '◦', '\u25a0': '▪', '\u25aa': '▪', '\u2043': '–' } as Record<string, string>)[c.trim()] ?? (/^[•◦▪▫‣∙·–—]$/.test(c.trim()) ? c.trim() : '•');
    let it: Item | null = null; let m: RegExpExecArray | null = null;
    if (r.art) { if (r.art.r - r.art.l > b.size * 0.9) return null; b.runs.splice(i, 1); it = { b, kind: 'bullet', fmt: 'bullet', text: glyph(r.art.was ?? ''), start: 1, at: 0, mark: '' }; }
    // (A tab between the mark and the text counts as the space after the mark.)
    const t = it ? '' : b.runs.slice(i).map((x, k) => (k > 0 && x.tab !== undefined ? '\t' : '') + x.text).join('');
    if (it) { /* a drawn bullet */ }
    else if ((m = /^\s*([•◦▪▫■●○‣∙·⁃–—*\-\uf0b7\uf0a7\uf0d8o])(?:\s+)/.exec(t)) && (m[1] !== 'o' || /\t/.test(m[0]))) it = { b, kind: 'bullet', fmt: 'bullet', text: m[1] === '-' || m[1] === '–' || m[1] === '—' || m[1] === '⁃' ? '–' : m[1] === '*' ? '•' : glyph(m[1]), start: 1, at: 0, mark: m[0] };
    else if ((m = /^\s*(\()?([0-9]{1,3}|[٠-٩]{1,3}|[a-z]|[A-Z]|[ivx]{1,4}|[IVX]{1,4}|[ء-ي])([.)])?(?:\s*[\-–]\s|\s+)/u.exec(t)) && (m[3] || m[1] || /[\-–]\s$/.test(m[0]))) {
      const v = m[2]; let fmt = 'decimal', start = 1;
      if (/^[0-9]+$/.test(v)) start = +v; else if (/^[٠-٩]+$/.test(v)) { fmt = 'hindiNumbers'; start = +v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)); }
      else if (/^[ivx]+$/.test(v) && v !== 'i' || v === 'i' && false) { fmt = 'lowerRoman'; start = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'].indexOf(v) + 1 || 1; }
      else if (/^[IVX]+$/.test(v) && v.length > 1) { fmt = 'upperRoman'; start = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'].indexOf(v) + 1 || 1; }
      else if (/^[a-z]$/.test(v)) { fmt = 'lowerLetter'; start = v.charCodeAt(0) - 96; }
      else if (/^[A-Z]$/.test(v)) { fmt = 'upperLetter'; start = v.charCodeAt(0) - 64; }
      else if (/^[ء-ي]$/.test(v)) { fmt = 'arabicAlpha'; start = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي'.indexOf(v.replace(/[أإآ]/, 'ا')) + 1 || 1; }
      const lvlText = `${m[1] ? '(' : ''}%1${m[3] ?? (m[1] ? ')' : ' -')}`;
      it = { b, kind: 'number', fmt, text: lvlText, start, at: 0, mark: m[0] };
    }
    if (!it) return null;
    // The mark leaves the text (and the tab or spaces after it).
    if (it.mark) { let left = it.mark.replace(/\t/g, '').length; for (let k = i; k < b.runs.length && left > 0; k++) { const x = b.runs[k]; const n = Math.min(left, x.text.length); x.text = x.text.slice(n); left -= n; } }
    const j = b.runs.findIndex((x) => x.text.trim() || x.art); if (j >= 0) { b.runs[j] = { ...b.runs[j], tab: undefined, tabEnd: undefined, text: b.runs[j].text.replace(/^\s+/, '') }; }
    b.runs = b.runs.filter((x, k) => k >= j || x.br || x.art);
    return it;
  };
  for (const pg of pages) for (const bs of flowOf(pg)) {
    let group: Item[] = []; let slackStart = 0;
    const close = () => {
      if (!group.length) return;
      // Levels by where the marks stand; a mark of another kind at the first level starts another list.
      const starts = [...new Set(group.map((g) => Math.round(g.at / 6)))].sort((a, b) => a - b);
      const lvlOf = (g: Item) => Math.min(8, starts.indexOf(Math.round(g.at / 6)));
      const parts: Item[][] = []; for (const g of group) { const p = parts[parts.length - 1]; if (p && !(g.kind !== p[0].kind && lvlOf(g) <= lvlOf(p[0]))) p.push(g); else parts.push([g]); }
      for (const items of parts) {
        const base = Math.min(...items.map(lvlOf));
        const levels: ListDef = [];
        for (const g of items) {
          // (Where the page has the text after the mark, and the mark: the level's indent and hanging, measured from the
          // margin — the text's edge and the room the page's margins leave before it.)
          const l = lvlOf(g) - base; const text = g.b.lead !== undefined && g.b.lead > g.at + 1 ? g.b.lead : Math.max(g.b.indStart, g.at + g.b.size * 1.1); const hang = text - g.at;
          const tw = Math.round((text + slackStart) * 20), hw = Math.round(hang * 20);
          if (!levels[l]) levels[l] = { fmt: g.fmt, text: g.kind === 'bullet' ? g.text : g.text.replace('%1', `%${l + 1}`), start: g.start, left: tw, hanging: hw };
          g.b.list = { id: lists.length + 1, lvl: l };
          g.b.indStart = text; g.b.firstLine = -hang; g.b.tabs = undefined;
          g.b.listInd = Math.abs(levels[l].left - tw) <= 20 && Math.abs(levels[l].hanging - hw) <= 20 && g.b.indEnd === 0;
        }
        for (let l = 0; l < levels.length; l++) levels[l] ??= { fmt: 'bullet', text: '•', start: 1, left: 720 * (l + 1), hanging: 360 };
        lists.push(levels);
      }
      group = [];
    };
    // (Numbers without a stop — "1 Calibrate", "2 Run" — make a list only as a run of them counting up.)
    const bare = (b: Block) => (b.kind === 'p' ? /^\s*([0-9]{1,3})\s+\p{L}/u.exec(textOf(b))?.[1] : undefined);
    const counted = new Set<Block>();
    for (let k = 0; k + 1 < bs.length; k++) { const a = bare(bs[k]), n = bare(bs[k + 1]); if (a && n && +n === +a + 1) { counted.add(bs[k]); counted.add(bs[k + 1]); } }
    for (const b of bs) {
      if (b.kind !== 'p' || b.heading !== undefined) { close(); continue; }
      const at = b.indStart + b.firstLine;
      if (counted.has(b)) { const r0 = b.runs.findIndex((x) => x.text.trim()); const m = /^\s*([0-9]{1,3})\s+/.exec(b.runs[r0].text); if (m && !LIST_MARK.test(textOf(b))) b.runs[r0] = { ...b.runs[r0], text: `${m[1]}. ${b.runs[r0].text.slice(m[0].length)}` }; }
      const g = markOf(b);
      if (!g) { close(); continue; }
      // (The room the page's margins leave beyond the text's start edge: see indentOf.)
      if (!group.length) slackStart = (b.rtl ? pg.m.slack?.[1] : pg.m.slack?.[0]) ?? 0;
      g.at = at; group.push(g);
    }
    close();
  }
  // ---- tables: a first row all bold over rows that are not
  for (const pg of pages) for (const bs of flowOf(pg)) for (const b of bs) if (b.kind === 'grid' && b.rows.length >= 2) {
    const boldRow = (row: Run[][]) => { const rs = row.flat().filter((r) => r.text.trim()); return rs.length > 0 && rs.every((r) => r.bold); };
    if (boldRow(b.rows[0]) && !b.rows.slice(1).every(boldRow)) b.header = true;
  }
}

/** Links inside the document: each to its page's bookmark (the page marked to carry one); one to a page this
 *  conversion cannot name is no link. */
function placeLinks(pages: PageModel[]): void {
  const byRef = new Map(pages.map((p, i) => [p.ref, i] as const));
  for (const pg of pages) eachRunList(pg, (runs) => { for (const r of runs) if (r.link?.startsWith('#ref')) { const i = byRef.get(r.link.slice(4)); if (i === undefined) { r.link = undefined; continue; } pages[i].mark = `_Page${i + 1}`; r.link = `#${pages[i].mark}`; } });
}

function sortFurniture(pages: PageModel[]): void {
  const textOf = (f: Furniture) => f.runs.map((r) => r.text).join('');
  const found = pages.map((pg) => pg.furniture.map((f) => ({ f, n: folioIn(textOf(f)) })).filter((c): c is { f: Furniture; n: NonNullable<Furniture['num']> } => !!c.n));
  found.forEach((cs, k) => {
    for (const c of cs) {
      const off = c.n.value - k, roman = c.n.fmt.endsWith('Roman');
      let near = false;
      for (let j = Math.max(0, k - 3); j <= Math.min(pages.length - 1, k + 3) && !near; j++) if (j !== k) near = found[j].some((d) => d.n.value - j === off && d.n.fmt.endsWith('Roman') === roman);
      if (near) { c.f.num = c.n; break; }
    }
  });
  // (A head's words without marks, vowels, tatweels or digits: the same head on the next pages reads alike.)
  const key = (f: Furniture) => textOf(f).replace(/[\s\u0640\u064B-\u065F\u0670\u06D6-\u06ED.,:;!?\u060C\u061B\u061F()[\]{}\u00ab\u00bb\-\u2013\u2014*0-9\u0660-\u0669\u06F0-\u06F9]/g, '');
  const heads = pages.map((pg) => new Set(pg.furniture.filter((f) => f.top).map(key).filter(Boolean)));
  pages.forEach((pg, k) => {
    const u = pg.uncut; delete pg.uncut;
    const top = pg.furniture.filter((f) => f.top);
    if (!u || !pg.body.length || !top.length || top.some((f) => f.num)) return;
    const keys = top.map(key).filter(Boolean);
    if (!keys.length) return; // (a number or a mark alone stays where it was put)
    for (let j = Math.max(0, k - 4); j <= Math.min(pages.length - 1, k + 4); j++) if (j !== k && keys.some((x) => heads[j].has(x))) return;
    // (The text's first line keeps its place: the room between the lines put back and it goes before it.)
    pg.body[0].before += Math.max(0, pg.m.top - u.bottom);
    pg.body.unshift(...u.blocks);
    pg.m.top = Math.max(6, u.top);
    pg.furniture = pg.furniture.filter((f) => !f.top);
  });
}

/** Typical baseline-to-baseline pitch for a given size, measured on runs of consecutive lines. */
function pitchTable(runs: Line[][]): (size: number) => number {
  const pitches = new Map<number, number[]>();
  for (const ls of runs) ls.forEach((l, i) => { const n = ls[i + 1]; if (n && Math.abs(n.size - l.size) < l.size * 0.1) { const d = l.base - n.base; if (d > l.size * 0.9 && d < l.size * 2.6) { const k = Math.round(l.size); pitches.set(k, [...(pitches.get(k) ?? []), d]); } } });
  return (size: number) => { const p = pitches.get(Math.round(size)); return p?.length ? median(p) : size * 1.65; };
}

/** A vertical gutter through the middle of the text: page x range [g0, g1], or null. */
// (A document to edit: failing a gutter down the page, a narrow one — TeX's, some 10 pt — down a part of it only: the same
// empty band on six lines or more one after another, the right column's lines starting at one x and the left one's
// ending at one x, as set columns do.)
function findGutter(lines: Line[], W: number): [number, number] | null {
  return findGutterWide(lines, W) ?? (p2d.edit ? narrowGutter(lines.filter((l) => l.pieces.some((p) => p.text.trim())), W) : null);
}
function findGutterWide(lines: Line[], W: number): [number, number] | null {
  const ls = lines.filter((l) => l.pieces.some((p) => p.text.trim()));
  if (ls.length < 8) return null;
  const x0 = Math.floor(W * 0.25), x1 = Math.ceil(W * 0.75);
  const cover = new Array(x1 - x0).fill(0);
  for (const l of ls) {
    const hit = new Uint8Array(x1 - x0);
    for (const p of l.pieces) { if (!p.text.trim() || p.text === '\u2009') continue; for (let x = Math.max(x0, Math.floor(p.l)); x < Math.min(x1, Math.ceil(p.r)); x++) hit[x - x0] = 1; }
    for (let i = 0; i < hit.length; i++) cover[i] += hit[i];
  }
  // Titles, a wide table or an equation may run across; most lines must stop short of the gutter.
  const allowed = Math.max(2, Math.floor(ls.length * 0.25));
  let best: [number, number] | null = null;
  for (let i = 0; i < cover.length;) {
    if (cover[i] > allowed) { i++; continue; }
    let j = i; while (j < cover.length && cover[j] <= allowed) j++;
    if (j - i >= 6 && (!best || j - i > best[1] - best[0])) best = [x0 + i, x0 + j];
    i = j;
  }
  const dbg = (globalThis as { krDebugP2D?: boolean }).krDebugP2D;
  if (dbg) console.warn('P2D gutter-scan', JSON.stringify(best), allowed, JSON.stringify(cover.map((c, i) => [x0 + i, c]).filter(([, c]) => c <= allowed + 3)));
  if (!best) return null;
  const [g0, g1] = best;
  // Both sides must carry text on many lines (a centred title over empty space is not a gutter).
  // (A line that runs on across the gutter is a line of neither column: a page in one column whose stretched lines
  // happen to leave a gap there counted the ends of its long lines as a column's, and its short lines' last words
  // were set apart in a column of their own — a list item cut in two, the items above run together.)
  const across = (l: Line) => l.pieces.some((p) => p.text.trim() && p.text !== '\u2009' && p.l < g1 - 1 && p.r > g0 + 1);
  const side = (inSide: (p: Piece) => boolean) => ls.filter((l) => !across(l)).map((l) => l.pieces.filter((p) => p.text.trim() && p.text !== '\u2009' && inSide(p))).filter((ps) => ps.length);
  const left = side((p) => p.r <= g0 + 1), right = side((p) => p.l >= g1 - 1);
  if (left.length < 4 || right.length < 4) return null;
  // Columns of running text, not a table: the lines on each side carry several words.
  const words = (ps: Piece[]) => ps.map((p) => p.text).join(' ').trim().split(/\s+/).length;
  const prose = (rows: Piece[][]) => {
    const lo = Math.min(...rows.flat().map((p) => p.l)), hi = Math.max(...rows.flat().map((p) => p.r));
    const n = rows.filter((ps) => words(ps) >= 4 && Math.max(...ps.map((p) => p.r)) - Math.min(...ps.map((p) => p.l)) >= (hi - lo) * 0.6).length;
    return n >= Math.max(4, rows.length * 0.3);
  };
  if (dbg) console.warn('P2D gutter-sides', left.length, right.length, prose(left), prose(right));
  if (!prose(left) || !prose(right)) return null;
  // Right-to-left verse sets its two halves on the same baselines, line after line; columns of prose drift
  // apart (paragraph ends, headings). Without that drift an Arabic page is verse, not columns.
  const rtl = ls.filter((l) => l.rtl).length > ls.length / 2;
  if (rtl) {
    const baseOf = (ps: Piece[]) => median(ps.map((p) => p.y)), sz = median(ls.map((l) => l.size));
    const rb = right.map(baseOf);
    const paired = left.filter((ps) => rb.some((b) => Math.abs(b - baseOf(ps)) < sz * 0.3)).length / Math.max(left.length, right.length);
    if (paired >= 0.85) return null;
  }
  return best;
}

function narrowGutter(ls: Line[], W: number): [number, number] | null {
  // (Not on a right-to-left page: verse sets its halves that way, and a long line's last words would be cut off.)
  if (ls.filter((l) => l.rtl).length > ls.length / 3) return null;
  // (The two columns' lines need not share baselines: a line may hold one column's text, or both.)
  const ink = ls.map((l) => l.pieces.filter((p) => p.text.trim() && p.text !== '\u2009'));
  // Candidate starts of a right column: x where three lines or more start a piece in the middle half of the page.
  const starts: number[] = []; for (const ps of ink) for (const p of ps) if (p.l > W * 0.3 && p.l < W * 0.7 && !ps.some((q) => q !== p && q.r > p.l - 6 && q.l < p.l - 0.5)) starts.push(p.l);
  starts.sort((x, y) => x - y);
  let best: [number, number] | null = null; let bestN = 0;
  for (let k = 0; k < starts.length; k++) {
    const x = starts[k]; if (k > 0 && x - starts[k - 1] < 1.5) continue;
    if (starts.filter((v) => Math.abs(v - x) <= 1.5).length < 3) continue;
    // Runs of lines one after another that leave [x - 6, x] empty.
    let i = 0;
    while (i < ink.length) {
      if (ink[i].some((p) => p.l < x - 0.5 && p.r > x - 6)) { i++; continue; }
      let j = i; while (j < ink.length && !ink[j].some((p) => p.l < x - 0.5 && p.r > x - 6)) j++;
      const run = ink.slice(i, j);
      const rights = run.filter((ps) => ps.some((p) => Math.abs(p.l - x) <= 1.5)).length;
      const ends = run.map((ps) => Math.max(-Infinity, ...ps.filter((p) => p.r <= x - 6).map((p) => p.r))).filter((e) => e > x - 40);
      const top = ends.length ? Math.max(...ends) : -Infinity; const flush = ends.filter((e) => top - e <= 1.5).length;
      if (j - i >= 6 && rights >= 3 && flush >= 3 && flush >= ends.length * 0.5 && j - i > bestN) { best = [top, x]; bestN = j - i; }
      i = j;
    }
  }
  return best;
}

/** A page's notes, split at their numbers (a table or verse belongs to the note it follows). */
function splitNotes(blocks: Block[]): Note[] {
  const notes: Note[] = [];
  for (const b of blocks) {
    if (b.kind !== 'p') { if (notes.length) notes[notes.length - 1].paras.push(b); else notes.push({ num: -1, paras: [b] }); continue; }
    const first = b.runs[0];
    const m = first && (/^\s*[(（]?([0-9٠-٩۰-۹]+)[)）]?\s*/.exec(first.text));
    if (m) {
      first.text = first.text.slice(m[0].length);
      if (!first.text) b.runs.shift();
      notes.push({ num: toInt(m[1]), paras: [b] });
    } else if (notes.length) notes[notes.length - 1].paras.push(b);
    else notes.push({ num: -1, paras: [b] });
  }
  return notes;
}
/** Note references in blocks (small raised numbers that name a note of the page); whether every note is referenced. */
function markNoteRefs(blocks: Block[], notes: Note[]): boolean {
  const nums = new Set(notes.map((n) => n.num)); const refs = new Set<number>();
  for (const b of blocks) for (const runs of b.kind === 'p' ? [b.runs] : b.kind === 'grid' ? b.rows.flat() : []) for (const r of runs) { const m = r.sup && DIGITS.exec(r.text); if (m && nums.has(toInt(m[1]))) { r.note = toInt(m[1]); refs.add(r.note); } }
  return notes.length > 0 && notes.every((n) => n.num >= 0 && refs.has(n.num));
}

/** Text boxes scattered over a designed page (a worksheet, a slide): lines cut where a wide gap separates
 *  side-by-side texts, then gathered into boxes by nearness and overlap. Null for a page of running text —
 *  one column of lines down the page, verse in two halves, a title over a text — which flows as a document. */
function findPlacedBoxes(body: Line[], W: number, H: number, edit = false): { lines: Line[]; l: number; r: number }[] | null {
  if (body.length < 4) return null;
  // Segments: the stretches of each line between gaps wider than three letters' heights.
  const segs: Line[] = [];
  for (const l of body) {
    const ps = l.pieces.filter((p) => p.text.trim() && p.text !== ' ').sort((a, b) => a.l - b.l);
    if (!ps.length) continue;
    let cur: Piece[] = [ps[0]]; let hi = ps[0].r; const cut: Piece[][] = [];
    for (let i = 1; i < ps.length; i++) { const p = ps[i]; if (p.l - hi > Math.max(l.size * 3, 14)) { cut.push(cur); cur = []; } cur.push(p); hi = Math.max(hi, p.r); }
    cut.push(cur);
    // (The drawn spaces go with the stretch they stand in: without them a box's words were spaced by their gaps
    // alone, and a page that sets its words close — a narrow drawn space — lost every space in its boxes.)
    // (Its extent stays its words'.)
    const parts = cut.map((ws) => subLine(l, ws));
    for (const sp of l.pieces) if (sp.text === '\u2009') { const s = parts.find((x) => sp.l >= x.l - 0.5 && sp.r <= x.r + 0.5); if (s) s.pieces.push(sp); }
    segs.push(...parts);
  }
  if (segs.length === body.length) {
    // (No line is cut: scattered only if the lines themselves stand at many different places.)
    const lefts = new Set(body.map((l) => Math.round(l.l / 12))), rights = new Set(body.map((l) => Math.round(l.r / 12)));
    if (lefts.size < 4 || rights.size < 4) return null;
  }
  // Boxes: a segment joins the box whose last line is just above it and overlaps it sideways.
  type B = { lines: Line[]; l: number; r: number };
  const boxes: B[] = [];
  const overlap = (a: { l: number; r: number }, b: { l: number; r: number }) => Math.min(a.r, b.r) - Math.max(a.l, b.l);
  for (const s of segs.sort((a, b) => b.base - a.base)) {
    let best: B | null = null; let bestGap = Infinity;
    for (const b of boxes) {
      const last = b.lines[b.lines.length - 1]; const gap = last.base - s.base;
      if (gap < -0.5 || gap > Math.max(last.size, s.size) * 2.2) continue;
      if (overlap(b, s) < Math.min(b.r - b.l, s.r - s.l) * 0.3) continue;
      if (gap < bestGap) { best = b; bestGap = gap; }
    }
    if (best) { best.lines.push(s); best.l = Math.min(best.l, s.l); best.r = Math.max(best.r, s.r); } else boxes.push({ lines: [s], l: s.l, r: s.r });
  }
  const dbg = (globalThis as { krDebugP2D?: boolean }).krDebugP2D;
  if (dbg) console.warn('P2D placed-scan', segs.length, body.length, boxes.length, JSON.stringify(boxes.map((b) => [Math.round(b.l), Math.round(b.r), b.lines.length, b.lines[0].pieces.map((p) => p.text).join('').slice(0, 15)])));
  if (boxes.length < 3) return null;
  // Scattered: boxes stand beside one another at heights of their own (not the two halves of verse, whose
  // lines share every baseline), and no box is a column of text down the page.
  const spanOf = (b: B) => [b.lines[b.lines.length - 1].base, b.lines[0].base];
  let beside = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]; if (overlap(a, b) > 0) continue;
    const [a0, a1] = spanOf(a), [b0, b1] = spanOf(b); if (Math.min(a1, b1) - Math.max(a0, b0) < 0) continue;
    const shared = a.lines.every((la) => b.lines.some((lb) => Math.abs(la.base - lb.base) < 1)) || b.lines.every((lb) => a.lines.some((la) => Math.abs(la.base - lb.base) < 1));
    if (!shared) beside++;
  }
  // Or boxes narrow and set at many different places across the page, off its middle (a page of running text
  // has its paragraphs between two edges, its headings in the middle; a poem its halves in two columns).
  const span = [Math.min(...boxes.map((b) => b.l)), Math.max(...boxes.map((b) => b.r))];
  const narrow = boxes.filter((b) => b.r - b.l < (span[1] - span[0]) * 0.55);
  const offMid = narrow.filter((b) => Math.abs((b.l + b.r) / 2 - (span[0] + span[1]) / 2) > W * 0.08);
  const scattered = boxes.length >= 4 && narrow.length >= boxes.length * 0.6 && offMid.length >= 3 && new Set(narrow.map((b) => Math.round(b.l / 12))).size >= 3 && new Set(narrow.map((b) => Math.round(b.r / 12))).size >= 3;
  if (dbg) console.warn('P2D placed-beside', beside, 'scattered', scattered, narrow.length, offMid.length);
  if (beside < 2 && !scattered) return null;
  // (For a document to edit, boxes only stacked one under another — none beside another — are the page's text in
  // its order: a heading set in the middle, a list set in, a caption under a figure. Paragraphs, not frames.)
  if (edit && beside < 2) return null;
  // (Boxes whose edges all fall on two lines down the page are columns, whatever cut them.)
  if (new Set(boxes.map((b) => Math.round(b.l / 12))).size <= 2 && new Set(boxes.map((b) => Math.round(b.r / 12))).size <= 2) return null;
  const tall = boxes.filter((b) => b.lines.length >= 6 && b.r - b.l > W * 0.5);
  if (tall.length && tall.reduce((n, b) => n + b.lines.length, 0) > body.length * 0.6) return null;
  if (H <= 0) return null;
  return boxes.map((b) => ({ ...b, lines: b.lines.sort((x, y) => y.base - x.base) }));
}

function subLine(l: Line, pieces: Piece[]): Line {
  return { pieces, base: l.base, size: l.size, l: Math.min(...pieces.map((p) => p.l)), r: Math.max(...pieces.map((p) => p.r)), rtl: isRtlText(pieces.map((p) => p.text).join('')) };
}

const PRESENTATION = /^[\ufb50-\ufdff\ufe70-\ufefc]$/u;
/** Is this a word font — a glyph per word, under presentation-form codes (the King Fahd Complex QCF fonts)? */
function isWordFont(f: FontInfo, seq: GlyphUse[]): boolean {
  if (f.wordFont) return true;
  if (/^QCF/i.test(f.family)) return seq.every((u) => !u[1] || PRESENTATION.test(u[1]) || !u[1].trim());
  const pres = seq.filter((u) => PRESENTATION.test(u[1]));
  if (seq.length < 3 || pres.length < seq.length * 0.8) return false;
  // Words of a page run through consecutive codes; letters of real text do not.
  let run = 0; const cps = pres.map((u) => u[1].codePointAt(0)!).sort((a, b) => a - b);
  for (let i = 1; i < cps.length; i++) if (cps[i] - cps[i - 1] === 1) run++;
  return run >= (cps.length - 1) * 0.6;
}

/** Rebuild the embedded fonts from their glyphs and how the document uses them (see fontfix.ts). Fonts
 *  that are one face (same family and style: subsets of one font) or that share words (legacy Arabic fonts
 *  holding different letter forms) become one font. Returns family renames for the runs. */
async function buildDocFonts(fonts: Map<string, FontInfo>, store: UseStore, stretched: Set<string>, tick?: (done: number) => Promise<void>): Promise<{ alias: Map<string, string>; byKey: Map<string, string> }> {
  const alias = new Map<string, string>(); const byKey = new Map<string, string>();
  const parent = new Map<string, string>();
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
  const union = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
  const used = [...fonts].filter(([, f]) => f.uses && f.src);
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) for (const [k, f] of fonts) if (!(f.uses && f.src)) console.warn('P2D font-unused', k, f.family, f.uses, !!f.src, !!f.raw, f.legacy, f.wordFont);
  for (const [k] of used) parent.set(k, k);
  // Fonts of one name and style are subsets of one face — unless they draw the same characters with other
  // glyphs: two fonts that only share a name (a maker's own "Times New Roman" that draws Arabic under Latin
  // codes beside the real one; two different fonts a PDF tool called alike). Merged, each character got one of
  // the two glyphs and the other font's text drew the wrong ones; they stay apart, the second under a name of
  // its own. (Told by the characters both set: none of them drawn with the same outline.)
  const drawn = new Map<string, Map<string, Set<string>>>(); // font key → character → its glyphs' outlines
  let index: Map<string, number[]> | null = null; // font key → the lines it sets (worked out when first asked)
  const seqsOf = () => { if (!index) { index = new Map(); for (let si = 0; si < store.seqs.length; si++) { let last = ''; for (const font of store.seqs.fontsAt(si)) if (font !== last) { last = font; const l = index!.get(font) ?? index!.set(font, []).get(font)!; if (l[l.length - 1] !== si) l.push(si); } } } return index; };
  const drawnBy = (k: string): Map<string, Set<string>> => {
    let m = drawn.get(k); if (m) return m; m = new Map(); drawn.set(k, m);
    const f = fonts.get(k)!; const sf = readSfnt(f.src!.data); if (!sf) return m;
    try {
      const r = glyphReader(sf); const cm = cmapGlyphs(sf); const pairs = new Set<string>();
      for (const si of seqsOf().get(k) ?? []) for (const [font, u] of store.seqs.at(si)) if (font === k && u[1] && [...u[1]].length === 1 && u[1].trim() && !COMBINING.test(u[1])) pairs.add(`${u[0]}|${u[1]}`);
      const sc = 1000 / r.upem; const keyOf = new Map<number, string>();
      for (const pr of pairs) {
        const at = pr.indexOf('|'); const g = cm.get(f.src!.toFontChar[pr.slice(0, at)]); if (!g) continue;
        let key = keyOf.get(g);
        if (key === undefined) { const o = r.outline(g); key = o.contours.length ? o.contours.map((c) => c.map((q) => `${Math.round(q.x * sc)},${Math.round(q.y * sc)}`).join(';')).join('|') : ''; keyOf.set(g, key); }
        if (!key) continue;
        const ch = pr.slice(at + 1); (m.get(ch) ?? m.set(ch, new Set()).get(ch)!).add(key);
      }
    } catch { /* unreadable: no evidence either way */ }
    return m;
  };
  const alike = (a: string, b: string): boolean => {
    const x = drawnBy(a), y = drawnBy(b); let common = 0;
    for (const [ch, gs] of x) { const o = y.get(ch); if (!o) continue; common++; for (const g of gs) if (o.has(g)) return true; }
    return common < 3;
  };
  const byFace = new Map<string, string[]>();
  const firstName = new Map<string, string>(); // a group's first font → the name its font gets
  const taken = new Set([...fonts.values()].map((f) => f.family));
  for (const [k, f] of used) {
    const key = `${f.family}|${f.bold}|${f.italic}`; const reps = byFace.get(key);
    if (!reps) { byFace.set(key, [k]); continue; }
    const o = reps.find((r) => alike(r, k));
    if (o) { union(o, k); continue; }
    reps.push(k);
    let n = reps.length, name: string; do name = `${f.family} (${n++})`; while (taken.has(name));
    taken.add(name); firstName.set(k, name);
  }
  // Legacy fonts are one font when they meet inside words often (a bold face meets the regular one only now
  // and then, where a phrase in bold runs into its quote mark).
  const meet = new Map<string, number>();
  for (let si = 0; si < store.seqs.length; si++) for (let i = 1, seq = store.seqs.fontsAt(si); i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i];
    if (a !== b && parent.has(a) && parent.has(b) && fonts.get(a)!.legacy && fonts.get(b)!.legacy) { const k = a < b ? `${a}\n${b}` : `${b}\n${a}`; meet.set(k, (meet.get(k) ?? 0) + 1); }
  }
  const most = new Map<string, number>();
  for (const [k, n] of meet) for (const f of k.split('\n')) most.set(f, Math.max(most.get(f) ?? 0, n));
  for (const [k, n] of meet) {
    const [a, b] = k.split('\n');
    if (n >= 3 && n >= most.get(a)! * 0.2 && n >= most.get(b)! * 0.2) union(a, b);
  }
  const groups = new Map<string, string[]>();
  for (const [k] of used) { const r = find(k); (groups.get(r) ?? groups.set(r, []).get(r)!).push(k); }
  // (A font told apart from its namesake: it and its subsets go by their own name, and so do their runs.)
  const ownFamily = new Map<string, string>(); // font key → the family it had (what `stretched` knows it by)
  for (const keys of groups.values()) {
    const name = keys.map((k) => firstName.get(k)).find(Boolean); if (!name) continue;
    for (const k of keys) { const f = fonts.get(k)!; ownFamily.set(k, f.family); f.family = name; byKey.set(k, name); }
  }
  const debug = (globalThis as { krDebugP2D?: boolean }).krDebugP2D;
  // (A font's lines found from the index of the lines each font sets, in the book's order — not by going through
  // every line of the book for each font: a book of a thousand pages has a hundred and fifty thousand.)
  const linesOf = (keys: string[]): number[] => {
    if (keys.length === 1) return seqsOf().get(keys[0]) ?? [];
    const all = new Set<number>(); for (const k of keys) for (const si of seqsOf().get(k) ?? []) all.add(si);
    return [...all].sort((a, b) => a - b);
  };
  let nGroup = 0, lastTick = performance.now();
  // (Each font built by the font workers while the next is got ready here; put in place in the groups' order.)
  const builder = fontBuilder();
  const builds: { keys: string[]; lead: FontInfo; lines: ReturnType<LinePack['done']>; built: Promise<Uint8Array | null> }[] = [];
  for (const keys of groups.values()) {
    if (tick && performance.now() - lastTick > 30) { await tick(nGroup / groups.size); lastTick = performance.now(); }
    nGroup++;
    keys.sort((a, b) => (fonts.get(b)!.uses ?? 0) - (fonts.get(a)!.uses ?? 0));
    const lead = fonts.get(keys[0])!;
    // A complete TrueType font with a Unicode map is carried as it is.
    // A font of its own with a Unicode map that has the characters the document sets in it is carried as it is.
    // (Its characters as the runs will have them: a presentation form read as its letter — a word font's codes
    // stay as they are — and a sign font's symbol table counted, where its kept codes are looked up. Measured on
    // the glyphs' own text, the forms a Word-made subset maps passed, the letters the runs carry did not, and the
    // font was neither rebuilt nor embedded: "Droid Arabic Naskh" fell back to whatever Word had.)
    // (Every Arabic letter must be there: a letter that falls back to another font breaks its word's joining —
    // a «خ» missing from a subset showed 55 times in a stranger's shape. A missing sign or digit or two still may.)
    if (keys.length === 1 && lead.raw && !lead.legacy) {
      let cov: Set<number> | null = null; try { cov = new Set([...cmapCoverage(lead.raw), ...cmapCoverage(lead.raw, true)]); } catch { /* unreadable */ }
      if (cov?.size) {
        const used = new Set<number>();
        const asRun = (s: string) => (lead.wordFont || !/[ﭐ-﷯ﹰ-﻿]/.test(s) ? s : s.normalize('NFKC'));
        for (const si of linesOf([keys[0]])) for (const [font, u] of store.seqs.at(si)) if (font === keys[0]) for (const ch of asRun(u[1])) { const c = ch.codePointAt(0)!; if (c > 0x20 && !(c >= 0x200b && c <= 0x200f) && c !== 0xffff && !COMBINING.test(ch)) used.add(c); }
        let ok = 0, letters = 0; for (const c of used) if (cov.has(c)) ok++; else if (ARABIC_LETTER.test(String.fromCodePoint(c))) letters++;
        if (!used.size || (ok / used.size >= 0.97 && !letters)) continue;
      }
    }
    const sources: GlyphSource[] = []; const c2g: Map<number, number>[] = []; const idx = new Map<string, number>(); const datas: Uint8Array[] = [];
    for (const k of keys) {
      const f = fonts.get(k)!; const sf = readSfnt(f.src!.data); if (!sf) continue;
      try {
        const r = glyphReader(sf); const vm = verticalMetrics(sf); const cm = cmapGlyphs(sf);
        const m = new Map<number, number>();
        for (const [code, fc] of Object.entries(f.src!.toFontChar)) { const g = cm.get(fc); if (g) m.set(+code, g); }
        idx.set(k, sources.length); sources.push({ outline: r.outline, upem: r.upem, asc: vm?.asc, desc: vm?.desc }); c2g.push(m); datas.push(f.src!.data);
      } catch (e) { if (debug) console.warn('P2D font read failed', f.family, e); }
    }
    if (!sources.length) continue;
    const member = new Set(keys);
    // (Its lines packed as they are made — for the font worker, and never all of them as arrays at once — with the
    // screen given its turn every 30 ms: a book's main font sets most of its glyphs.)
    const pack = new LinePack(); let slice = performance.now();
    for (const si of linesOf(keys)) {
      const seq = store.seqs.at(si);
      let cur: Use[] = [];
      const push = (x: Use[]) => pack.add(x, seq.rtl);
      for (const [font, u] of seq) {
        const i = member.has(font) ? idx.get(font) : undefined;
        if (i === undefined) { if (cur.length) push(cur); cur = []; continue; }
        const g = c2g[i].get(u[0]); if (!g) continue;
        cur.push([i * 65536 + g, u[1], u[2], u[3], u[4], u[5], u[6]]);
      }
      if (cur.length) push(cur);
      if (tick && performance.now() - slice > 30) { await tick(nGroup / groups.size); slice = lastTick = performance.now(); }
    }
    const lines = pack.done();
    // The space code's glyph, when it is a blank one (a legacy font's "space" may be a letter).
    let sp = !lead.legacy && lead.spaceCode !== undefined && idx.has(keys[0]) ? c2g[idx.get(keys[0])!].get(lead.spaceCode) : undefined;
    if (sp !== undefined) { try { if (sources[idx.get(keys[0])!].outline(sp).contours.length) sp = undefined; } catch { sp = undefined; } }
    const meta = { family: lead.family, bold: lead.bold, italic: lead.italic, raw: !!lead.wordFont, tatweel: keys.some((k) => stretched.has(ownFamily.get(k) ?? fonts.get(k)!.family)), space: lead.spaceW ?? spaceFromGaps(keys.flatMap((k) => fonts.get(k)!.gaps ?? [])) };
    const spaceGid = sp === undefined ? undefined : idx.get(keys[0])! * 65536 + sp;
    const family = lead.family;
    builds.push({ keys, lead, lines, built: builder.build(datas, lines, meta, spaceGid, () => buildFont(sources, unpackLines(lines), meta, spaceGid)).catch((e) => { console.warn('P2D font rebuild failed', family, e); return null; }) });
  }
  try {
    for (let bi = 0; bi < builds.length; bi++) {
      const { keys, lead, lines, built: pending } = builds[bi]; (builds as unknown[])[bi] = null; // (each let go once in place)
      if (tick && performance.now() - lastTick > 30) { await tick(bi / builds.length); lastTick = performance.now(); }
      const built = await pending;
      if (debug) console.warn('P2D rebuilt', lead.family, keys.length, lines.rtl.length, built?.length, built ? (() => { try { const c = cmapCoverage(built); return `cov=${c.size} ${[...c].slice(0, 12).map((x) => x.toString(16)).join(' ')}`; } catch (e) { return `cov-err ${String(e)}`; } })() : '', JSON.stringify(unpackLines(lines).slice(0, 2).map((l) => l.slice(0, 4).map((u) => [u[0] >> 16, u[0] & 0xffff, u[1]]))));
      if (!built) continue;
      // (Its coverage is the new font's: the symbol table read from the PDF's copy no longer describes it.)
      lead.raw = built; lead.cov = undefined; lead.winCov = undefined; lead.rebuilt = true; lead.noUnicode = false;
      for (const k of keys.slice(1)) { const f = fonts.get(k)!; if (f.family !== lead.family) alias.set(f.family, lead.family); f.raw = undefined; }
    }
  } finally { builder.end(); }
  return { alias, byKey };
}

/** The font workers of a job (src/pdf2docx.fonts.worker.ts: one, two where there are cores to spare), started when
 *  the first font is sent and ended with the job. A font is built here instead where workers cannot start or one
 *  fails: the same font, on this thread. */
function fontBuilder(): { build(datas: Uint8Array[], lines: ReturnType<LinePack['done']>, meta: Parameters<typeof buildFont>[2], spaceGid: number | undefined, here: () => Uint8Array | null): Promise<Uint8Array | null>; end(): void } {
  type Wait = { res: (b: Uint8Array | null) => void; rej: (e: unknown) => void; here: () => Uint8Array | null };
  const pool: { w: Worker; waiting: Map<number, Wait> }[] = []; let broken = (globalThis as { krFontWorkers?: boolean }).krFontWorkers === false || typeof Worker === 'undefined';
  let n = 0;
  const fallBack = (waiting: Map<number, Wait>) => { for (const x of waiting.values()) { try { x.res(x.here()); } catch (e) { x.rej(e); } } waiting.clear(); };
  const start = () => {
    const size = Math.min(2, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 4)));
    for (let i = 0; i < size; i++) {
      try {
        const w = new Worker(new URL('./pdf2docxfonts.js', import.meta.url), { type: 'module' }); liveWorkers.add(w);
        const s = { w, waiting: new Map<number, Wait>() }; pool.push(s);
        w.onmessage = (e: MessageEvent<import('./fontpack').FontDone>) => { const x = s.waiting.get(e.data.id); if (!x) return; s.waiting.delete(e.data.id); if (e.data.error) x.rej(new Error(e.data.error)); else x.res(e.data.built); };
        w.onerror = (e) => { e.preventDefault(); broken = true; fallBack(s.waiting); };
      } catch { broken = true; }
    }
  };
  return {
    build(datas, lines, meta, spaceGid, here) {
      if (!broken && !pool.length) start();
      const s = pool.filter(() => !broken).sort((a, b) => a.waiting.size - b.waiting.size)[0];
      if (broken || !s) return Promise.resolve().then(here);
      const id = ++n;
      return new Promise((res, rej) => {
        s.waiting.set(id, { res, rej, here });
        // (A font's bytes that are part of a bigger buffer are sent alone: a view is sent with its whole buffer.)
        const own = datas.map((d) => (d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d : d.slice()));
        s.w.postMessage({ id, datas: own, meta, spaceGid, ...lines } satisfies import('./fontpack').FontJob);
      });
    },
    end() { for (const s of pool) { s.w.terminate(); liveWorkers.delete(s.w); fallBack(s.waiting); } pool.length = 0; },
  };
}

/** An Arabic letter (one that joins its word, or a hamza / alef form): not a mark, digit, sign or punctuation. */
const ARABIC_LETTER = /[ؠ-ؿف-يٮٯٱ-ۓەۮۯۺ-ۼۿ]/;

/** A space as wide as the commonest gap between words (em), when the PDF draws none. */
function spaceFromGaps(gaps: number[]): number {
  if (gaps.length < 3) return 0.25;
  const s = [...gaps].sort((a, b) => a - b);
  return Math.min(0.5, Math.max(0.2, s[Math.floor(s.length * 0.25)]));
}

/** Runs set in fonts merged into another take its name, and runs that now match are joined (Arabic joins only
 *  within a run). */
function renameRuns(pg: PageModel, alias: Map<string, string>, byKey = new Map<string, string>()) {
  const fix = (runs: Run[]) => {
    for (const r of runs) r.font = (r.fk !== undefined ? byKey.get(r.fk) : undefined) ?? alias.get(r.font) ?? r.font;
    for (let i = runs.length - 1; i > 0; i--) {
      const a = runs[i - 1], b = runs[i];
      if (a.font === b.font && a.size === b.size && a.bold === b.bold && a.italic === b.italic && a.color === b.color && a.sup === b.sup && a.rtl === b.rtl && a.raise === b.raise
        && a.cs === b.cs && !a.spacing && !b.spacing && !a.art && !b.art
        && a.note === undefined && b.note === undefined && !a.br && !b.br && b.tab === undefined) {
        if (a.kText !== undefined || b.kText !== undefined) a.kText = (a.kText ?? a.text) + (b.kText ?? b.text);
        a.text += b.text; runs.splice(i, 1);
      }
    }
  };
  eachRunList(pg, fix);
}

/** Every list of runs a page holds: its paragraphs', table cells', notes', running heads', boxes'. */
export function eachRunList(pg: PageModel, fix: (runs: Run[]) => void): void {
  const block = (b: Block) => { if (b.kind === 'p') fix(b.runs); else for (const row of b.rows) for (const cell of row) fix(cell); };
  for (const b of [...pg.body, ...pg.header, ...pg.footer, ...pg.notesRaw, ...pg.notes.flatMap((n) => n.paras), ...(pg.regions ?? []).flatMap((r) => r.cols.flat()), ...(pg.placed ?? []).flatMap((x) => x.blocks)]) block(b);
  for (const f of pg.furniture) fix(f.runs);
  for (const pp of pg.vert?.paras ?? []) fix(pp.runs);
  for (const bx of pg.boxes ?? []) fix(bx.runs);
}

/** Code points a word font's glyphs are filed under when fonts of them are merged: Arabic presentation forms
 *  (letters, so right to left like the codes the Quran fonts use themselves — a private-use code is left to
 *  right, and a verse's words would come out in the wrong order — and none the shapers treat apart: no
 *  harakat forms, no word ligatures like ﷲ). */
const WORD_CODES: number[] = (() => { const out: number[] = []; for (const [a, z] of [[0xfb50, 0xfdc7], [0xfe80, 0xfefc]]) for (let c = a; c <= z; c++) if (/\p{Script=Arabic}/u.test(String.fromCharCode(c)) && /\p{Lo}/u.test(String.fromCharCode(c))) out.push(c); return out; })();

/**
 * The Quran's word fonts (QCF: a font per page of the mushaf, each glyph a whole word filed under a code that
 * every page's font uses again for another word) put together into a few fonts: each word's glyph copied as it
 * is — outline and advance — under a code of its own, the runs' codes changed to match. A book quoting the
 * Quran carried a font per page it quotes (263 in one, Word's font list full of them); now a font for each set
 * of fonts that measure alike (units per em, ascent and descent, space), as many words as there are codes.
 * The runs' text was never the words (presentation-form codes standing for glyphs); it stays codes. A font
 * with shaping or kerning tables, a code it has no glyph for, or more words than codes, stays as it is.
 */
function mergeWordFonts(fonts: Map<string, FontInfo>, pages: PageModel[]): void {
  // (Of a name's copies, the one the text was set in — rebuilt or carried — as the font table would pick it; two
  // such copies of one name are left alone.)
  const cand = new Map<string, FontInfo[]>();
  for (const f of fonts.values()) if (f.wordFont && f.raw && /^QCF/i.test(f.family)) (cand.get(f.family) ?? cand.set(f.family, []).get(f.family)!).push(f);
  const fam = new Map<string, FontInfo>();
  for (const [k, list] of cand) { const live = list.filter((f) => f.uses || f.rebuilt); const pick = live.length ? live : list; if (pick.length === 1) fam.set(k, pick[0]); }
  if (fam.size < 2) return;
  const used = new Map<string, Set<number>>();
  for (const pg of pages) eachRunList(pg, (runs) => { for (const r of runs) if (fam.has(r.font)) { const u = used.get(r.font) ?? used.set(r.font, new Set()).get(r.font)!; for (const ch of r.text + (r.kText ?? '')) u.add(ch.codePointAt(0)!); } });
  const i16 = (t: Uint8Array | undefined, o: number) => (t && t.length >= o + 2 ? new DataView(t.buffer, t.byteOffset, t.byteLength).getInt16(o) : 0);
  const lookups = (t: Uint8Array | undefined) => { if (!t || t.length < 10) return 0; const d = new DataView(t.buffer, t.byteOffset, t.byteLength); const ll = d.getUint16(8); return ll && ll + 2 <= t.length ? d.getUint16(ll) : 0; };
  type Word = { outline: Outline; key: string };
  const groups = new Map<string, { name: string; words: Map<number, Word>; space?: Outline; upem: number; asc: number; desc: number; os2: Uint8Array; rebuilt: boolean }[]>();
  for (const [name, f] of fam) {
    const chars = used.get(name); if (!chars?.size) continue;
    const sf = readSfnt(f.raw!); if (!sf || sf.cff) continue;
    const os2 = sf.tables.get('OS/2'); if (!os2 || os2.length < 78) continue;
    if (lookups(sf.tables.get('GSUB')) || lookups(sf.tables.get('GPOS')) || sf.tables.has('kern')) continue;
    let cm: Map<number, number>, rd: ReturnType<typeof glyphReader>;
    try { cm = cmapGlyphs(sf); rd = glyphReader(sf); } catch { continue; }
    const words = new Map<number, Word>(); let space: Outline | undefined; let ok = true;
    for (const c of chars) {
      const g = cm.get(c); if (!g) { ok = false; break; }
      let o: Outline; try { o = rd.outline(g); } catch { ok = false; break; }
      if (c === 0x20) { space = o; continue; }
      words.set(c, { outline: o, key: `${o.adv}|${JSON.stringify(o.contours)}` });
    }
    if (!ok || words.size > WORD_CODES.length) continue;
    const hh = sf.tables.get('hhea');
    // (Fonts that measure alike: the merged font's lines and spaces are each of theirs.)
    const key = [rd.upem, i16(hh, 4), i16(hh, 6), i16(hh, 8), ...[68, 70, 72, 74, 76].map((o) => i16(os2, o)), space ? space.adv : -1, f.rebuilt ? 1 : 0].join('|');
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ name, words, space, upem: rd.upem, asc: i16(hh, 4), desc: i16(hh, 6), os2, rebuilt: !!f.rebuilt });
  }
  const taken = new Set([...fonts.values()].map((f) => f.family));
  let n = 0;
  const rename = new Map<string, { to: string; map: Map<number, number> }>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.name.localeCompare(b.name));
    let chunk: typeof members = [];
    const flush = () => {
      if (chunk.length < 2) { chunk = []; return; }
      let to: string; do { to = `QCF Merged ${++n}`; } while (taken.has(to));
      const outlines: Outline[] = [{ contours: [], adv: 0 }]; const map = new Map<number, number>(); const byKey = new Map<string, number>();
      const m0 = chunk[0];
      if (m0.space) { outlines.push(m0.space); map.set(0x20, outlines.length - 1); }
      for (const m of chunk) {
        const conv = new Map<number, number>();
        for (const [c, w] of m.words) {
          // (One word drawn alike on two pages is one glyph, under one code.)
          let code = byKey.get(w.key);
          if (code === undefined) { code = WORD_CODES[byKey.size]; byKey.set(w.key, code); outlines.push(w.outline); map.set(code, outlines.length - 1); }
          conv.set(c, code);
        }
        rename.set(m.name, { to, map: conv });
      }
      const data = plainFont({ family: to, upem: m0.upem, asc: m0.asc, desc: m0.desc }, outlines, map, m0.os2);
      fonts.set(`kr-words-${n}`, { family: to, bold: false, italic: false, raw: data, rebuilt: m0.rebuilt, wordFont: true, uses: chunk.reduce((a, m) => a + (fam.get(m.name)!.uses ?? 0), 0) });
      taken.add(to); chunk = [];
    };
    for (const m of members) {
      // (Distinct words so far in this font, give or take one drawn alike on two pages.)
      const have = new Set(chunk.flatMap((x) => [...x.words.values()].map((w) => w.key)));
      const more = [...m.words.values()].filter((w) => !have.has(w.key)).length;
      if (have.size + more > WORD_CODES.length) flush();
      chunk.push(m);
    }
    flush();
  }
  if (!rename.size) return;
  for (const pg of pages) eachRunList(pg, (runs) => {
    for (const r of runs) {
      const x = rename.get(r.font); if (!x) continue;
      const conv = (t: string) => [...t].map((ch) => { const c = x.map.get(ch.codePointAt(0)!); return c === undefined ? ch : String.fromCharCode(c); }).join('');
      r.text = conv(r.text); if (r.kText !== undefined) r.kText = conv(r.kText); r.font = x.to;
    }
  });
  for (const f of fonts.values()) if (rename.has(f.family)) f.raw = undefined;
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D words', JSON.stringify([...rename].map(([k, v]) => [k, v.to, [...v.map].map(([a, b]) => [a.toString(16), b.toString(16)])])));
}

/** A short hash of a font file (its first and last kilobytes and its length), to know it again. */
function fnv(b: Uint8Array): number { let h = 0x811c9dc5; const step = (i: number) => { h ^= b[i]; h = Math.imul(h, 0x01000193); }; for (let i = 0; i < Math.min(1024, b.length); i++) step(i); for (let i = Math.max(1024, b.length - 1024); i < b.length; i++) step(i); return h >>> 0; }

/** A haraka drawn on its own (another colour than its letter, so the page draws it apart) goes into its letter's
 *  text (see attachMarks). What it was is kept: its glyph goes with the letter's, so the rebuilt font learns the
 *  mark's glyph and where it sits on that letter (lost, the font had an empty mark and the haraka vanished); and
 *  its colour, when not the letter's, so the run can be cut there — Word colours a mark of its own run. */
function keepMark(m: Piece, host: Piece, base: string): void {
  const mark = m.text.trim();
  if (m.color !== host.color && !m.hidden) (host.tints ??= []).push({ base, mark, color: m.color });
  if (!m.codes?.length || !host.codes?.length || m.font !== host.font) return;
  const cx = (m.l + m.r) / 2;
  for (const u of m.codes) {
    if (!u[0]) continue;
    // (The letter's glyph the mark stands over — or the nearest — takes the mark into its text.)
    let k = -1, bd = Infinity;
    host.codes.forEach((h, i) => { if (!h[1] || !h[5]) return; const x0 = h[2], x1 = h[2] + h[5] * h[4]; const d = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0; if (d < bd) { bd = d; k = i; } });
    if (k < 0) return;
    const h = host.codes[k];
    const ch = u[1] && [...u[1]].every((c) => COMBINING.test(c)) ? u[1] : mark;
    // (Not onto a glyph whose text is not trusted, nor twice onto one that names the mark already.)
    if (h[1] !== '\uffff' && !h[1].includes(ch)) host.codes[k] = [h[0], h[1] + ch, h[2], h[3], h[4], h[5], h[6]];
    host.codes.splice(k + 1, 0, [u[0], '', u[2], u[3], u[4], 0, h[6]]);
  }
}

/** Text already asked of the worker for a page (the next page's, fetched while this one is being laid out). */
/** A page's drawing and text asked of pdf.js now, to be ready when the page is read. */
export function askAhead(pg: import('pdfjs-dist').PDFPageProxy): void { void pg.getOperatorList(); prefetched.set(pg, pg.getTextContent()); }
/** The pictures of the pages read so far, still being encoded (taken: the next page starts a new list). */
export function takePendingPngs(): Promise<void>[] { const p = pendingPngs; pendingPngs = []; return p; }
const prefetched = new WeakMap<object, Promise<Awaited<ReturnType<import('pdfjs-dist').PDFPageProxy['getTextContent']>>>>();

export async function analysePage(pdfjs: PdfJs, page: import('pdfjs-dist').PDFPageProxy, fonts: Map<string, FontInfo>, withGraphics: boolean, store: UseStore = { seqs: new GlyphRuns(), seen: new Map() }): Promise<PageModel> {
  const [, , W, H] = page.view;
  const T = (globalThis as { krTiming?: Record<string, number> }).krTiming; let t0 = performance.now();
  const lap = (k: string) => { if (T) { const n = performance.now(); T[k] = (T[k] ?? 0) + n - t0; t0 = n; } };
  const ol = await page.getOperatorList(); lap('ops');
  const tc = await (prefetched.get(page) ?? page.getTextContent()); lap('text');
  prefetched.delete(page);
  const pieces: Piece[] = [];
  const turnedItems: { text: string; angle: number; e: number; f: number; w: number; h: number; font: string; color: string; bold: boolean }[] = [];
  let spanSeq = 0;
  for (const it of tc.items as { str: string; transform: number[]; width: number; height: number; fontName: string; color?: string; fakeBold?: boolean; hidden?: boolean; strokeEm?: number; krCodes?: (number | string)[]; krSpan?: number; krLead?: boolean; krTints?: Piece['tints']; krInked?: boolean }[]) {
    if (typeof it.str !== 'string') continue;
    let text = cleanPdfText(it.str);
    if (/^\u2009+$/.test(text)) text = '\u2009'; else if (!text.trim()) continue;
    // A legacy font's kashida connector (a sliver joining two letter forms, several on a stretched line) is
    // no letter: the rebuilt font joins the letters itself, and Word stretches lines its own way. It still
    // tells that the letters on either side are one word.
    const conn = /^\u0640+$/.test(text) && it.width < (it.height || 10) * 0.12;
    const [a, b, , , e, f] = it.transform;
    const h = it.height || Math.hypot(a, b) || 10;
    // (Text set at an angle — a poster's diagonal stamp, a label up its side — goes to a turned text box of its own.)
    { const angle = Math.atan2(b, a); if (Math.abs(angle) > 0.03 && text.trim() && text !== '\u2009') { turnedItems.push({ text, angle, e, f, w: it.width, h, font: it.fontName, color: it.color || '000000', bold: !!it.fakeBold }); continue; } }
    // (A font met before under another name — the second copy's — is called by the first name here; the
    // drawing keeps the copy's own name, which is the one pdf.js draws with.)
    const drawnAs = it.fontName;
    if (store.same?.has(it.fontName)) it.fontName = store.same.get(it.fontName)!;
    // Fill+stroke "bold": Word's own synthetic bold strokes about 1/35 em; a much thinner stroke is
    // not bold in Word's terms (setting bold would draw it heavier than the page shows).
    pieces.push({ text, l: e, r: e + it.width, y: f, h, font: it.fontName, color: it.color || '000000', bold: !!it.fakeBold && (it.strokeEm ?? 0.03) >= 0.014, ...(conn ? { conn: true } : {}), ...(it.hidden ? { hidden: true } : {}), ...(it.krLead ? { keep: true } : {}), ...(it.krInked ? { inked: true } : {}), ...(drawnAs !== it.fontName ? { drawnAs } : {}), ...(it.krTints?.length ? { tints: it.krTints } : {}) });
    if (it.fontName && !fonts.has(it.fontName)) {
      let fo: { name?: string; bold?: boolean; black?: boolean; italic?: boolean; krRaw?: Uint8Array; krNoToUnicode?: boolean; isSymbolicFont?: boolean; isSerifFont?: boolean; isMonospace?: boolean; krSpaceCode?: number; krLegacy?: boolean; data?: Uint8Array; toFontChar?: Record<string, number>; widths?: Record<string, number>; fontMatrix?: number[] } | null = null;
      try { fo = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null; } catch { /* not loaded */ }
      // The same font file seen already (under the first copy's name): one font, not two.
      if (store.same && fo) {
        const r = fo.krRaw; const key = `${fo.name ?? ''}|${r ? `${r.length}|${fnv(r)}` : `0|${fo.isSymbolicFont ? 1 : 0}${fo.bold ? 1 : 0}${fo.italic ? 1 : 0}`}`;
        const first = (store.byFile ??= new Map()).get(key);
        if (first && first !== it.fontName && fonts.has(first)) { store.same.set(it.fontName, first); it.fontName = first; pieces[pieces.length - 1].font = first; }
        else store.byFile.set(key, it.fontName);
      }
    }
    if (store.pageFonts && it.fontName && !store.pageFonts.includes(it.fontName)) store.pageFonts.push(it.fontName);
    if (it.fontName && !fonts.has(it.fontName)) {
      let fo: { name?: string; bold?: boolean; black?: boolean; italic?: boolean; krRaw?: Uint8Array; krNoToUnicode?: boolean; isSymbolicFont?: boolean; isSerifFont?: boolean; isMonospace?: boolean; krSpaceCode?: number; krLegacy?: boolean; data?: Uint8Array; toFontChar?: Record<string, number>; widths?: Record<string, number>; fontMatrix?: number[] } | null = null;
      try { fo = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null; } catch { /* not loaded */ }
      const info: FontInfo = { ...parseFontName(fo?.name, fo), raw: fo?.krRaw, noUnicode: !!fo?.krNoToUnicode, symbolic: !!fo?.isSymbolicFont, serif: !!fo?.isSerifFont, mono: !!fo?.isMonospace, spaceCode: fo?.krSpaceCode, legacy: !!fo?.krLegacy, src: fo?.data && fo.toFontChar ? { data: fo.data, toFontChar: fo.toFontChar } : undefined };
      // Word carries TrueType outlines only: a CFF-flavoured OpenType file is rebuilt, never embedded as is.
      if (info.raw && info.raw[0] === 0x4f) info.raw = undefined;
      // The width of its space (em), for a rebuilt font whose space glyph pdf.js dropped.
      { const sc = fo?.krSpaceCode ?? 32; const w = fo?.widths?.[sc]; if (w) info.spaceW = w * (fo?.fontMatrix?.[0] ?? 0.001); }
      // The font file says whether it is a bold (or italic) face.
      const os2 = fo?.krRaw ? readOs2(fo.krRaw) : null;
      // (A face whose own tables say regular is regular, even named "… Bold": "AL-Mohanad Bold" is a family.)
      if (os2) { info.weight = os2.weight; if (os2.weight >= 600 || os2.bold) info.bold = true; else if (os2.weight > 0 && os2.weight < 600 && /\bbold\b/i.test(info.family)) info.bold = false; if (os2.italic) info.italic = true; }
      // The font's own family name is what Word looks for ("KFGQPC Uthman Taha Naskh", not its PostScript name).
      const own = fo?.krRaw ? fontFamilyName(fo.krRaw) : null;
      if (own) info.family = own.replace(/\s+(Regular)$/i, '');
      else if (!/\s/.test(info.family)) info.family = info.family.replace(/CJK(jp|kr|sc|tc|hk)$/i, (_m, r: string) => `CJK ${r.toUpperCase()}`).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D fontname', fo?.name, '→', info.family, '| own:', own);
      fonts.set(it.fontName, info);
      store.onFont?.(it.fontName, info, fo);
      if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) { const x = fo as unknown as { data?: Uint8Array; type?: string; subtype?: string; toFontChar?: Record<string, number>; mimetype?: string; composite?: boolean }; console.warn('P2D fontdata', info.family, x?.type, x?.subtype, x?.mimetype, x?.composite, x?.data?.length, x?.data ? String.fromCharCode(...x.data.subarray(0, 4)).replace(/[^\x20-\x7e]/g, '.') : '', JSON.stringify(Object.entries(x?.toFontChar ?? {}).slice(0, 5))); }
    }
    // (The glyphs of one /ActualText span are one cluster: its letter and that letter's marks.)
    if (it.krCodes) { const k = it.krCodes; const g = it.krSpan ? ++spanSeq : 0; const seq: GlyphUse[] = []; for (let i = 0; i + 5 < k.length; i += 6) seq.push([k[i] as number, k[i + 1] as string, k[i + 2] as number, k[i + 3] as number, k[i + 4] as number, k[i + 5] as number, g]); pieces[pieces.length - 1].codes = seq;
      // A glyph the page draws and then steps back over (Word's "هي" ligature at a word's end: its ink lies before
      // its origin, the next letter starts at that origin) comes as a piece of no width. It is read after the
      // letters that start at its origin — it stands a hair before it, to the left in right-to-left text — so the
      // word's letters keep their order and no gap opens in the word.
      { const pc = pieces[pieces.length - 1]; const adv = seq.reduce((t, u) => t + (u[5] > 0 ? u[5] * u[4] : 0), 0);
        if (pc.r - pc.l < h * 0.02 && adv > h * 0.3 && isRtlText(pc.text)) pc.l = pc.r - h * 0.05; }
      // A Quran word font (QCF): each glyph is a whole word, filed under an Arabic presentation-form code. Read as
      // letters, those codes are gibberish that sets nothing like the word; kept as they are, the font (carried
      // in the document) draws each word exactly as the page does.
      const fi = fonts.get(it.fontName);
      const wf = !!fi && seq.length > 0 && isWordFont(fi, seq);
      // (A reader of only some of the pages tells which fonts a word font met on an earlier page would change.)
      if (fi && seq.length && !fi.wordFont && !wf) store.stickyMiss?.add(it.fontName);
      if (fi && wf) {
        fi.wordFont = true;
        const ordered = [...seq].sort((a, b) => b[2] - a[2]); // right to left: reading order
        let txt = ''; let edge = Infinity;
        for (const u of ordered) { if (edge - (u[2] + u[5] * u[4]) > u[4] * 0.12 && txt) txt += ' '; txt += u[1]; edge = u[2]; }
        pieces[pieces.length - 1].text = txt;
      }
    }
  }
  // Text drawn twice in the same place (a design tool's "bold" made of two prints a hair apart, or a stray
  // second print) is one piece of text, not two words run together ("أحوالأحوال").
  if (pieces.length > 1) {
    const seen = new Map<string, Piece>();
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]; if (p.text === ' ' || p.conn) continue;
      const key = `${p.font}|${p.text}`;
      const q = seen.get(key);
      if (q && Math.abs(q.l - p.l) <= Math.max(0.8, p.h * 0.06) && Math.abs(q.y - p.y) <= Math.max(0.8, p.h * 0.06)) {
        if (Math.abs(q.l - p.l) > 0.15 || Math.abs(q.y - p.y) > 0.15) q.bold = true;
        // (The drawn copy stays, not an invisible one laid over it.)
        if (q.hidden && !p.hidden) { q.hidden = false; q.color = p.color; }
        pieces.splice(i, 1); i--; continue;
      }
      seen.set(key, p);
    }
  }
  // Invisible text (render mode 3) over a page that has text of its own: words laid over a title drawn as
  // outlines or a picture, so that it can be searched. The drawing shows those words; set again as text they
  // would show twice. (A scanned page carries only such text — that stays, there is nothing else to read.)
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D hidden', pieces.filter((p) => p.hidden).length, '/', pieces.length);
  if (pieces.some((p) => p.hidden)) {
    const visible = pieces.some((p) => !p.hidden && p.text.trim() && p.text !== '\u2009');
    // (Small drawn paths — letters as outlines — where the invisible words stand: the drawing has the words.)
    const inks = visible ? [] : findShapes(pdfjs, ol, true).filter((b) => b.top - b.bottom < 80 && b.r - b.l < 120);
    const outlined = (p: Piece) => { let n = 0; for (const b of inks) { const cx = (b.l + b.r) / 2, cy = (b.top + b.bottom) / 2; if (cx > p.l - 2 && cx < p.r + 2 && cy > p.y - p.h * 0.4 && cy < p.y + p.h * 1.1) n++; } return n >= 2; };
    for (let i = pieces.length - 1; i >= 0; i--) if (pieces[i].hidden && (visible || outlined(pieces[i]))) pieces.splice(i, 1);
  }
  // An honorific drawn as one glyph ("ﷺ" read out as "صلى الله عليه وسلم"): its one character, or the words
  // would take a phrase's room where the page has a sign's.
  for (const p of pieces) {
    const lig = HONORIFICS[p.text.replace(/[\s\u0640]+/g, ' ').trim()];
    if (!lig || p.r - p.l > p.h * 2.5) continue;
    const glyphs = p.codes?.filter((u) => u[5] > 0) ?? [];
    // (Only where its own glyph will carry the character: a font rebuilt from the page's glyph uses.)
    if (glyphs.length !== 1) continue;
    p.text = lig;
    for (const u of p.codes!) u[1] = ''; glyphs[0][1] = lig;
  }
  // Text in a decorative font that carries no letters (private-use codes, or Latin codes standing for
  // Arabic word art on an Arabic page) is not text a reader could use: it stays in the picture.
  const pageRtl = isRtlText(pieces.map((p) => p.text).join(''));
  const keepFonts = new Set<string>();
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i]; const f = fonts.get(p.font);
    if (p.text === '\u2009' || !f) continue;
    const pua = /[\uE000-\uF8FF]/.test(p.text);
    // (A sign font's glyph under a Latin code — "$" drawn as «رحمه الله» — shows itself by its width too: a
    // whole phrase is far wider than any one Latin character.)
    const wideSign = pageRtl && /^[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]$/.test(p.text.trim()) && (p.codes?.length ?? 0) === 1 && p.codes![0][5] > 1.2;
    const latinArt = pageRtl && (f.noUnicode || wideSign) && /^[\x20-\x7E]+$/.test(p.text) && !/^[\s\d().,:;\-–]+$/.test(p.text);
    // Codes the font itself has no character for (no ToUnicode, not in its own Unicode table): what is drawn
    // is not what the codes say (page numbers set in an ornamental font read "31" for "٤٠").
    let foreign = false;
    if (!pua && !latinArt && f.noUnicode && f.raw) { f.cov ??= cmapCoverage(f.raw); foreign = f.cov.size > 0 && [...p.text].some((c) => c.trim() && !f.cov!.has(c.codePointAt(0)!)); }
    if (!pua && !latinArt && !foreign) continue;
    // Private-use codes the embedded font itself draws (a heading font with a symbol cmap whose ToUnicode is
    // wrong, e.g. AL-Mateen), or Latin codes of a font that draws Arabic word signs under them ("$" for
    // "رحمه الله"): kept as those codes in drawing order, set in that font, they show exactly as the page draws
    // them, in their line (copying gives the codes, as copying the PDF itself would).
    // (Only a font its maker lets be embedded for editing: a "preview & print" font is not loaded by editors.)
    // (Not under a system font's name: the document would get the system's font, which lacks these codes.)
    if ((pua || latinArt) && f.raw && editableFont(f.raw) && !/^(Times New Roman|Arial|Calibri|Cambria|Tahoma|Verdana|Segoe UI|Courier New|Georgia|Traditional Arabic|Simplified Arabic|Arabic Typesetting|Sakkal Majalla|Liberation \w+|DejaVu \w+|Noto \w+|Wingdings|Webdings|Symbol|Marlett|MT Extra)\b/i.test(f.family)) {
      // (Codes the font's Windows table maps — the one Word and LibreOffice look in.)
      f.winCov ??= cmapCoverage(f.raw, true);
      if ([...p.text].every((c) => !c.trim() || f.winCov!.has(c.codePointAt(0)!))) {
        p.raw = true;
        // (In drawing order, left to right: pdf.js may have turned an item round.)
        if (p.codes?.length && p.codes.every((u) => u[1])) p.text = [...p.codes].sort((x, y) => x[2] - y[2]).map((u) => u[1]).join('');
        continue;
      }
    }
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D art', f.family, pua, latinArt, foreign, JSON.stringify(p.text.slice(0, 40)));
    // (Its place stays taken: a stand-in that sets nothing keeps the line's extent and its gaps true.)
    keepFonts.add(p.font); if (p.drawnAs) keepFonts.add(p.drawnAs); pieces[i] = { ...p, text: '\uFFFC', art: true, was: p.text, codes: undefined };
  }
  const boxes = turnedBoxes(turnedItems, fonts, H);
  // Vertical writing (tategaki): its columns are read as paragraphs, set in a section whose text runs top
  // to bottom, columns right to left, as Word and LibreOffice set Japanese and Chinese; the pieces leave the
  // line reading below (a running head or folio across the page stays as it is).
  let vert: VPage | undefined;
  {
    const solid = pieces.filter((p) => p.text.trim() && p.text !== '\u2009').length;
    const vf = findVertical(pieces.map((p) => ({ text: p.text, l: p.l, r: p.r, y: H - p.y, h: p.h })));
    if (vf.vertical.size >= 8 && vf.vertical.size >= solid * 0.5) {
      const segs = vf.segments; const cxs = (g: { l: number; r: number }) => (g.l + g.r) / 2;
      const steps: number[] = []; for (let k = 0; k + 1 < segs.length; k++) { const d = Math.abs(cxs(segs[k]) - cxs(segs[k + 1])); if (d > segs[k].size * 0.8 && d < segs[k].size * 4) steps.push(d); }
      const size = median(segs.map((g) => g.size)) || 10;
      const head = Math.min(...segs.map((g) => g.t)), foot = Math.max(...segs.map((g) => g.b));
      const paras: VPage['paras'] = []; let cur: Run[] = []; let first = -1;
      for (const g of segs) {
        if (first < 0) first = Math.max(0, g.t - head);
        // (The column's text as read — its spaces and punctuation put right — in the look of its main characters.)
        const main = pieces[g.items.find((i) => /[\p{L}\p{N}]/u.test(pieces[i].text)) ?? g.items[0]];
        const f = fonts.get(main.font);
        const look = { font: f?.family ?? 'MS Mincho', size: Math.round(main.h * 2) / 2, bold: !!(f?.bold || main.bold), italic: !!f?.italic, color: main.color, rtl: false, sup: false };
        const text = plainVerticalForms(g.text);
        const last = cur[cur.length - 1];
        if (last && last.font === look.font && last.size === look.size && last.bold === look.bold && last.color === look.color) last.text += text; else cur.push({ text, ...look });
        if (g.breakAfter) { if (cur.length) paras.push({ runs: cur, firstLine: first }); cur = []; first = -1; }
      }
      if (cur.length) paras.push({ runs: cur, firstLine: Math.max(0, first) });
      vert = { paras, pitch: steps.length ? median(steps) : size * 1.7, size, top: head, bottom: H - foot, left: Math.min(...segs.map((g) => g.l)), right: W - Math.max(...segs.map((g) => g.r)) };
      for (let i = pieces.length - 1; i >= 0; i--) if (vf.vertical.has(i)) pieces.splice(i, 1);
    }
  }
  // (For a document to edit: a list's bullets drawn as small shapes — a dot, a square — just before a line's first
  // word become the line's mark, a bullet the list takes; the shape leaves the page's drawing.)
  // (For a document to edit: the page's link annotations — a URL, or a place in the file — on the words under them.)
  if (p2d.edit) {
    const annots = await page.getAnnotations().catch(() => [] as unknown[]) as { subtype?: string; rect?: number[]; url?: string; unsafeUrl?: string; dest?: unknown }[];
    for (const a of annots) {
      if (a.subtype !== 'Link' || !a.rect) continue;
      const d = a.dest as { num?: number; gen?: number }[] | undefined;
      const target = a.url ?? (a.unsafeUrl && /^(https?|mailto|ftp):/i.test(a.unsafeUrl) ? a.unsafeUrl : undefined) ?? (Array.isArray(d) && d[0] && typeof d[0].num === 'number' ? `#ref${d[0].num}_${d[0].gen ?? 0}` : undefined);
      if (!target) continue;
      const [x0, y0, x1, y1] = [Math.min(a.rect[0], a.rect[2]), Math.min(a.rect[1], a.rect[3]), Math.max(a.rect[0], a.rect[2]), Math.max(a.rect[1], a.rect[3])];
      for (let k = 0; k < pieces.length; k++) {
        const p = pieces[k]; const cy = p.y + p.h * 0.3;
        if (cy < y0 - 1 || cy > y1 + 1 || p.r <= x0 || p.l >= x1 || p.art || p.pic) continue;
        // (A piece that holds more than the link's words — a whole line, as TeX draws it — is cut at the link's
        // edges, at the word boundaries nearest them.)
        if (p.l < x0 - 1 || p.r > x1 + 1) {
          const n = p.text.length; const at = (x: number) => { const raw = Math.round(((x - p.l) / Math.max(1e-6, p.r - p.l)) * n); let best = raw, d = Infinity; for (let j = 0; j <= n; j++) if ((j === 0 || j === n || /\s/.test(p.text[j - 1]) || /\s/.test(p.text[j])) && Math.abs(j - raw) < d) { d = Math.abs(j - raw); best = j; } return Math.max(0, Math.min(n, best)); };
          const a = p.l < x0 - 1 ? at(x0) : 0, b = p.r > x1 + 1 ? at(x1) : n;
          if (b <= a || !p.text.slice(a, b).trim()) continue;
          const xAt = (j: number) => p.l + ((p.r - p.l) * j) / n;
          // (Each part without the spaces at its ends, which stay as the gap between the parts.)
          const part = (i: number, j: number, link?: string): Piece => { const t = p.text.slice(i, j); const lead = t.length - t.trimStart().length, trail = t.length - t.trimEnd().length; return { ...p, text: t.trim(), l: xAt(i + lead), r: xAt(j - trail), codes: undefined, link }; };
          const parts = [a > 0 ? part(0, a) : null, part(a, b, target), b < n ? part(b, n) : null].filter((x): x is Piece => !!x && !!x.text);
          // (Its glyphs stay with the first part, for the font's sake.)
          parts[0].codes = p.codes;
          pieces.splice(k, 1, ...parts); k += parts.length - 1; continue;
        }
        p.link = target;
      }
    }
  }
  eraseNow = []; figNow = [];
  // (For a document to edit: underlines, strikes and shading go onto their words; the rules left over may be paragraphs' borders.)
  const leftRules = p2d.edit ? decorate(pieces, findStrokes(pdfjs, ol)) : [];
  if (p2d.edit) for (const d of findDots(pdfjs, ol)) {
    const cy = (d.top + d.bottom) / 2;
    const band = pieces.filter((p) => p.text.trim() && cy > p.y - p.h * 0.1 && cy < p.y + p.h * 0.8);
    // (Before the line's first word: to its left, or — right-to-left text — to its right.)
    let next: Piece | undefined = band.filter((p) => p.l >= d.r - 0.5 && p.l - d.r < p.h * 2.5).sort((a, b) => a.l - b.l)[0];
    if (next && (band.some((p) => p.r <= d.l + 0.5 && d.l - p.r < next!.h * 6) || isRtlText(next.text))) next = undefined;
    if (!next) { next = band.filter((p) => p.r <= d.l + 0.5 && d.l - p.r < p.h * 2.5).sort((a, b) => b.r - a.r)[0]; if (next && (!isRtlText(next.text) || band.some((p) => p.l >= d.r - 0.5 && p.l - d.r < next!.h * 6))) next = undefined; }
    if (!next || d.r - d.l > next.h * 0.6) continue;
    pieces.push({ text: d.kind === 'ring' ? '\u25e6' : d.kind === 'square' ? '\u25aa' : '\u2022', l: d.l, r: d.r, y: next.y, h: next.h, font: next.font, color: next.color, bold: false });
    eraseNow.push({ l: d.l - 0.5, r: d.r + 0.5, top: d.top + 0.5, bottom: d.bottom - 0.5 });
  }
  const arts = pieces.filter((p) => p.art);
  const lines = buildLines(attachMarks(pieces, keepMark).filter((p) => !/^[\u064B-\u065F\u0670\u06D6-\u06ED\s]+$/.test(p.text) || p.text === "\u2009"));
  // How embedded fonts are used: their glyphs along each line, in drawing order, cut where a word ends (a gap,
  // a space) so each glyph's joining form can be told.
  for (const l of lines) {
    let seq: [string, GlyphUse][] = []; let prevR = -Infinity;
    const flush = () => {
      if (!seq.length) return;
      let keep = false;
      for (const [font, u] of seq) {
        const fi = fonts.get(font); if (!fi) continue;
        const seen = store.seen.get(font) ?? store.seen.set(font, new Set()).get(font)!;
        if ((fi.uses ?? 0) < USE_CAP || !seen.has(u[0]) || store.keepAll) keep = true;
      }
      if (keep) for (const [font, u] of seq) { const fi = fonts.get(font)!; fi.uses = (fi.uses ?? 0) + 1; store.seen.get(font)!.add(u[0]); }
      if (keep) store.seqs.push(seq, l.rtl);
      seq = [];
    };
    for (const p of [...l.pieces].sort((a, b) => a.l - b.l)) {
      if (!p.codes) {
        // (A drawn space's width is the font's space, which a rebuilt font must have.)
        if (p.text === '\u2009' && p.r - p.l > 0.05 * p.h) { const fi = fonts.get(p.font); if (fi && (fi.gaps ??= []).length < 400) fi.gaps.push((p.r - p.l) / p.h); }
        if (p.text === '\u2009' || p.l - prevR > 0.5) flush(); prevR = Math.max(prevR, p.r); continue;
      }
      if (p.l - prevR > p.h * 0.12) flush();
      // Words inside one piece (a PDF that draws no spaces) are cut where the glyphs leave a gap; the gaps
      // tell how wide the font's space is when the PDF has none.
      let end = NaN;
      for (const c of p.codes) {
        const gap = (c[2] - end) / c[4];
        if (gap > 0.12) { flush(); if (gap < 1) { const fi = fonts.get(p.font); if (fi && (fi.gaps ??= []).length < 400) fi.gaps.push(gap); } }
        seq.push([p.font, c]);
        if (c[5] > 0) end = c[2] + c[5] * c[4];
      }
      prevR = Math.max(prevR, p.r);
    }
    flush();
  }
  if ((globalThis as { krDebugLine?: string }).krDebugLine) for (const l of lines) if ((globalThis as { krDebugLine?: string }).krDebugLine === '*' || l.pieces.some((p) => p.text.includes((globalThis as { krDebugLine?: string }).krDebugLine!))) console.warn('P2D line', JSON.stringify(l.pieces.map((p) => [p.text, +p.l.toFixed(1), +p.r.toFixed(1), p.font])));
  const textLines = lines.filter((l) => l.pieces.some((p) => p.text.trim() && p.text !== '\u2009'));
  // Typical baseline-to-baseline pitch for a given size, measured on this page.
  const pitchOf = pitchTable([textLines]);
  // Header / footer: lines in the top / bottom band of the page (running head, page number),
  // or a little further in when a clear gap cuts them off from the text.
  const header: Line[] = [], footer: Line[] = [];
  let body = [...textLines];
  // A running head or page number is sparse — a short title, a number, wide gaps — never a full line of text.
  const sparse = (l: Line) => {
    const ps = l.pieces.filter((p) => p.text.trim() && p.text !== '\u2009').sort((a, b) => a.l - b.l);
    let ink = 0, x0 = -Infinity, x1 = -Infinity;
    for (const p of ps) { if (p.l > x1 + l.size * 2.5) { if (x1 > x0) ink += x1 - x0; x0 = p.l; x1 = p.r; } else x1 = Math.max(x1, p.r); }
    if (x1 > x0) ink += x1 - x0;
    return ink < W * 0.42;
  };
  // A lone page number may sit well inside the page (TeX leaves wide bottom margins).
  const folio = (l: Line) => /^[\s\-\u2013\u2014(\[]*([0-9\u0660-\u0669\u06F0-\u06F9]{1,4}|[ivxlcdm]{1,6})[\s\-\u2013\u2014)\]]*$/i.test(l.pieces.map((p) => p.text).join(''));
  // A number standing apart at either end of a line ("١٤      بلوغ المرام"), or alone: a page number.
  const edgeFolio = (l: Line) => {
    if (folio(l)) return true;
    const ps = l.pieces.filter((p) => p.text.trim() && p.text !== '\u2009').sort((a, b) => a.l - b.l);
    for (const seq of [ps, [...ps].reverse()]) {
      const g: Piece[] = [];
      for (const p of seq) { const q = g[g.length - 1]; if (q && (seq === ps ? p.l - q.r : q.l - p.r) > l.size) break; g.push(p); }
      if (g.length < ps.length && /^[\s\-\u2013\u2014()[\]]*[0-9\u0660-\u0669\u06F0-\u06F9]{1,4}[\s\-\u2013\u2014()[\]]*$/.test(g.map((p) => p.text).join(''))) return true;
    }
    return false;
  };
  // (A line with a page number in the top or bottom band is the page's furniture even when the text starts close
  // below it, or its running head is long: books set their text nearer the head on some pages than on others.
  // Whether the number is the page's — it follows the pages' sequence — and whether a head without one repeats
  // is settled across the pages, and a line that turns out to be neither goes back into the text: see
  // sortFurniture.)
  const nearGap = (gap: number, next: Line) => gap > Math.max(pitchOf(next.size) * 0.85, next.size * 1.5);
  const cutTop = (i: number) => ((body[i].base > H * 0.88 || (body[i].base > H * 0.75 && folio(body[i]))) && body[i].base - body[i + 1].base > pitchOf(body[i + 1].size) * 1.2 && sparse(body[i]))
    || (body[i].base > H * 0.85 && nearGap(body[i].base - body[i + 1].base, body[i + 1]) && edgeFolio(body[i]));
  // (For a document to edit, a further line is the head's only when it stands nearer the head than the text: the
  // first lines of a page set close under a short head are the text's.)
  const nearerHead = () => !p2d.edit || !header.length || body.length < 2 || header[header.length - 1].base - body[0].base < body[0].base - body[1].base;
  while (body.length > 1 && header.length < 3 && cutTop(0) && nearerHead()) header.push(body.shift()!);
  const cutBottom = (i: number) => ((body[i].base < H * 0.08 || (body[i].base < H * 0.25 && folio(body[i]))) && body[i - 1].base - body[i].base > pitchOf(body[i].size) * 1.2 && sparse(body[i]))
    || (body[i].base < H * 0.12 && nearGap(body[i - 1].base - body[i].base, body[i - 1]) && folio(body[i]));
  // (A further line is the foot's only when it stands nearer the foot's line than the text above it: a page's last
  // footnote set close over a running foot is a note, not the foot — in either result.)
  // (Nor is a line that reads as a note — its number or mark, then words — whatever its place.)
  const noteLike = (l: Line) => { const t = l.pieces.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim(); return /^([0-9]{1,3}|[*\u2020\u2021\u00a7])\s?\p{L}/u.test(t) && t.split(/\s+/).length >= 3 && !edgeFolio(l) && !/\d\s*$/.test(t); };
  const nearerFoot = () => !noteLike(body[body.length - 1]) && (!footer.length || body.length < 2 || body[body.length - 1].base - footer[0].base < body[body.length - 2].base - body[body.length - 1].base);
  while (body.length > 1 && footer.length < 2 && cutBottom(body.length - 1) && nearerFoot()) footer.unshift(body.pop()!);
  // Columns: a gutter down the middle splits the text into regions — full-width lines (titles, an abstract)
  // and runs of lines set in two columns.
  // (A ruled table's columns are not the page's: its lines are left out when looking for a gutter, or a table of
  // two or three columns down the page reads as a page set in columns and its cells come apart.)
  const ruledLines = pullGrids(body, findShapes(pdfjs, ol, true), W, H).filter((l) => l.grid);
  const ruled = ruledLines.map((l) => l.grid!);
  const inRuled = (l: Line) => ruled.some((g) => l.base < g.ys[0] + 1 && l.base > g.ys[g.ys.length - 1] - 1 && l.l > g.xs[0] - 2 && l.r < g.xs[g.xs.length - 1] + 2);
  const findNoteRule = () => {
    const rules = findRules(pdfjs, ol);
    const Lb = median(body.map((l) => l.l)), Rb = median(body.map((l) => l.r));
    return rules.filter((r) => r.y < H * 0.75 && r.y > H * 0.05 && r.x1 - r.x0 < (Rb - Lb) * 0.75)
      .filter((r) => body.some((l) => l.base < r.y) && body.some((l) => l.base > r.y))
      // (A border of a ruled table is no footnote rule: the table's lower rows are not footnotes.)
      .filter((r) => !ruled.some((g) => r.y <= g.ys[0] + 2 && r.y >= g.ys[g.ys.length - 1] - 2 && r.x0 >= g.xs[0] - 2 && r.x1 <= g.xs[g.xs.length - 1] + 2))
      // (Nor is a line under words — a link's underline: text stands on it, where a footnote rule has room above.)
      .filter((r) => !body.some((l) => l.base >= r.y - 0.5 && l.base - r.y < l.size * 0.45 && l.l < r.x1 && l.r > r.x0))
      .sort((a, b) => b.y - a.y)[0];
  };
  let early: { rule: { x0: number; x1: number; y: number }; lines: Line[] } | null = null;
  if (p2d.edit) {
    const r0 = findNoteRule();
    if (r0) { const below = body.filter((l) => l.base < r0.y), above = body.filter((l) => l.base >= r0.y); if (below.length && median(below.map((l) => l.size)) < median(above.map((l) => l.size)) * 0.97) { early = { rule: r0, lines: below }; body = above; } }
  }
  const gutter = findGutter(ruled.length ? body.filter((l) => !inRuled(l)) : body, W);
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D gutter', JSON.stringify(gutter), body.length);
  // A designed page (a worksheet, a slide, an infographic): text in boxes scattered over the page, not a column
  // of text. Each box keeps its place on the page as a frame, over the page's drawing.
  // (Every line of the page is a candidate: a designed page has no running head to set apart.)
  // (A ruled table's cells are not boxes of a design: its lines are left out, or a page with a table of a few
  // columns reads as a designed page and the table comes apart into frames.)
  // (Save a page number alone at the head or foot: that is the page's, not a box of the design.)
  const placedBoxes = gutter ? null : findPlacedBoxes([...header, ...body, ...footer].filter((l) => !inRuled(l) && !((header.includes(l) || footer.includes(l)) && folio(l))).sort((a, b) => b.base - a.base), W, H, p2d.edit);
  if (placedBoxes) {
    const pitchP = pitchTable(placedBoxes.map((b) => b.lines));
    const placed: PlacedBox[] = placedBoxes.map((b) => {
      const first = b.lines[0], last = b.lines[b.lines.length - 1];
      const top = H - (first.base + BASE * pitchP(first.size));
      const bottom = H - (last.base - (1 - BASE) * pitchP(last.size));
      return { x: b.l, y: top, w: b.r - b.l, h: Math.max(bottom - top, first.size), blocks: buildBlocks(b.lines, fonts, b.l, b.r, pitchP, null, false) };
    });
    // A ruled table on a designed page is a box of its own, at its place: its lines were set apart from the boxes
    // above, and without this its words were in neither the text nor the drawing.
    for (const gl of ruledLines) {
      const g = gl.grid!; const x0 = g.xs[0], x1 = g.xs[g.xs.length - 1];
      placed.push({ x: x0, y: H - g.ys[0], w: x1 - x0, h: g.ys[0] - g.ys[g.ys.length - 1], blocks: buildBlocks([gl], fonts, x0, x1, pitchP, null) });
    }
    placed.sort((a, b) => a.y - b.y);
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D placed', JSON.stringify(placed.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h), b.blocks.map((k) => (k.kind === 'p' ? k.runs.map((x) => x.text).join('').slice(0, 20) : k.kind))])));
    const furnitureP = pinnedFurniture(header.filter(folio), footer.filter(folio), fonts, H);
    const picsP = withGraphics ? await renderGraphics(page, 2, keepFonts, ruled, arts, !drawsGraphics(pdfjs, ol)).catch(() => [] as Pic[]) : [];
    page.cleanup();
    return { ref: refOf(page), vert, w: W, h: H, pics: picsP, boxes, furniture: furnitureP, placed, header: [], footer: [], body: [], notes: [], notesRaw: [], notesBox: null, bodyBottom: 0, m: { top: 18, bottom: 18, left: 18, right: 18, header: 6, footer: 6 } };
  }
  if (gutter) {
    const [g0, g1] = gutter;
    const crosses = (l: Line) => l.pieces.some((p) => p.text.trim() && p.l < g1 - 1 && p.r > g0 + 1);
    type Raw = { full?: Line[]; left?: Line[]; right?: Line[]; orig?: Line[] };
    const raw: Raw[] = [];
    for (const l of body) {
      if (crosses(l)) { const cur = raw[raw.length - 1]; if (cur?.full) cur.full.push(l); else raw.push({ full: [l] }); continue; }
      let cur = raw[raw.length - 1]; if (!cur || cur.full) raw.push(cur = { left: [], right: [], orig: [] });
      cur.orig!.push(l);
      const lp = l.pieces.filter((p) => p.r <= g0 + 1), rp = l.pieces.filter((p) => p.l >= g1 - 1);
      if (lp.some((p) => p.text.trim())) cur.left!.push(subLine(l, lp));
      if (rp.some((p) => p.text.trim())) cur.right!.push(subLine(l, rp));
    }
    // A line or two between full-width ones that merely leaves the gutter blank (authors set apart under a
    // title) belongs with them, not in columns.
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (r.full || r.orig!.length > 2) continue;
      if ((i > 0 && !raw[i - 1].full) || (i < raw.length - 1 && !raw[i + 1].full)) continue;
      raw[i] = { full: r.orig };
    }
    // (A document to edit: lines under the columns that stand on one side only, well below the other side's last line, are
    // the text after the columns — a short line, code — not a column's.)
    if (p2d.edit) for (let i = 0; i < raw.length; i++) {
      const r = raw[i]; if (r.full || !r.left!.length || !r.right!.length) continue;
      const lowL = Math.min(...r.left!.map((l) => l.base)), lowR = Math.min(...r.right!.map((l) => l.base));
      const cut = Math.max(lowL, lowR) - 1.5 * median(r.orig!.map((l) => l.size));
      const tail = r.orig!.filter((l) => l.base < cut); if (!tail.length) continue;
      r.orig = r.orig!.filter((l) => l.base >= cut); r.left = r.left!.filter((l) => l.base >= cut); r.right = r.right!.filter((l) => l.base >= cut);
      raw.splice(i + 1, 0, { full: tail });
    }
    for (let i = raw.length - 1; i > 0; i--) if (raw[i].full && raw[i - 1].full) { raw[i - 1].full!.push(...raw[i].full!); raw.splice(i, 1); }
    // Lines were grouped across the whole page: a big title in one column can have swallowed the other
    // column's lines beside it (as raised pieces). Regroup each column on its own.
    const regroup = (ls: Line[]) => buildLines(ls.flatMap((l) => l.pieces.map((p) => ({ ...p, sup: undefined }))));
    for (const r of raw) if (!r.full) { r.left = regroup(r.left!); r.right = regroup(r.right!); }
    const formulasC: Box[] = [];
    const shapesC = findShapes(pdfjs, ol, true);
    if ((globalThis as { krDebugLine?: string }).krDebugLine === 'shapes') console.warn('P2D shapes', JSON.stringify(shapesC.map((s) => [+s.l.toFixed(1), +s.r.toFixed(1), +s.bottom.toFixed(1), +s.top.toFixed(1)])));
    const tidy = (ls: Line[]) => pullFormulas(pullGrids(ls, shapesC, W, H), formulasC);
    for (const r of raw) { if (r.full) r.full = tidy(r.full); else { r.left = tidy(r.left!); r.right = tidy(r.right!); } }
    const rtlPage = body.filter((l) => l.rtl).length > body.length / 2;
    // Pitches measured within each column (lines of two columns interleave on the page).
    const pitchCol = pitchTable(raw.flatMap((r) => (r.full ? [r.full] : [r.left!, r.right!])));
    const edgesOf = (ls: Line[]): [number, number] => [Math.min(...ls.map((l) => l.l)), Math.max(...ls.map((l) => l.r))];
    const regions: Region[] = []; let prevBase: number | null = null; let colTop: number | null = null;
    // (A document to edit: the next region's space above is measured from the foot of what stands above it — a table's
    // last rule, not its first line.)
    const endOf = (l: Line) => (p2d.edit && l.grid ? l.grid.ys[l.grid.ys.length - 1] + (1 - BASE) * pitchCol(l.size) : l.base);
    const pageLo = Math.min(...body.map((l) => l.l)), pageHi = Math.max(...body.map((l) => l.r));
    for (const r of raw) {
      if (r.full) {
        regions.push({ cols: [buildBlocks(r.full, fonts, pageLo, pageHi, pitchCol, prevBase)], edges: [[pageLo, pageHi]] });
        prevBase = endOf(r.full[r.full.length - 1]);
      } else {
        const sides = [r.left!, r.right!].filter((x) => x.length);
        if (sides.length < 2) {
          const ls = sides[0] ?? []; if (!ls.length) continue;
          regions.push({ cols: [buildBlocks(ls, fonts, pageLo, pageHi, pitchCol, prevBase)], edges: [[pageLo, pageHi]] });
          prevBase = endOf(ls[ls.length - 1]); continue;
        }
        const ordered = rtlPage ? [r.right!, r.left!] : [r.left!, r.right!];
        // Columns at the top of the page start where the page's top line starts: each column's first line keeps
        // its own height below it (a title in one column, text higher up in the other).
        let start = prevBase;
        if (start === null && !regions.length) { const t = [...r.left!, ...r.right!].reduce((a, b) => (b.base > a.base ? b : a)); start = t.base + BASE * pitchCol(t.size); colTop = start; }
        regions.push({ cols: ordered.map((ls) => { const e = edgesOf(ls); return buildBlocks(ls, fonts, e[0], e[1], pitchCol, start); }), edges: ordered.map(edgesOf) });
        prevBase = Math.min(...[...r.left!, ...r.right!].map(endOf));
      }
    }
    // (A document to edit: regions of one column one after another are one — a section break only where the columns change.)
    if (p2d.edit) for (let i = regions.length - 1; i > 0; i--) if (regions[i].cols.length === 1 && regions[i - 1].cols.length === 1) { regions[i - 1].cols[0].push(...regions[i].cols[0]); regions.splice(i, 1); }
    // (Figures, a document to edit: into the region and column they stand in — the first whose text goes on below
    // the figure's top, its column under the figure's middle.)
    if (p2d.edit) for (const f of findFigs(pdfjs, ol, body, W, H, pageLo, pageHi)) {
      const cx = (f.fb.l + f.fb.r) / 2;
      let put = false;
      for (const rg of regions) {
        const k = rg.cols.length > 1 ? rg.edges.findIndex(([a, b]) => cx >= a - 10 && cx <= b + 10) : 0; if (k < 0) continue;
        const bs = rg.cols[k]; if (!bs.some((b) => { const t = topOfBlock(b); return t !== null && t < f.fb.top - 1; })) continue;
        insertFig(bs, f); put = true; break;
      }
      if (!put && regions.length) insertFig(regions[regions.length - 1].cols[0], f);
    }
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D regions', JSON.stringify(regions.map((r) => r.cols.map((c) => c.map((b) => (b.kind === 'p' ? b.runs.map((x) => x.text).join('').slice(0, 25) : 'verse'))))));
    if (p2d.edit) for (const rg of regions) rg.cols.forEach((bs, k) => ruleBorders(bs, leftRules, rg.edges[k][0], rg.edges[k][1]));
    const lowestL = body[body.length - 1];
    const lo = Math.min(...regions.flatMap((r) => r.edges.map((e) => e[0]))), hi = Math.max(...regions.flatMap((r) => r.edges.map((e) => e[1])));
    const furnitureC = pinnedFurniture(header, footer, fonts, H);
    const firstPitchC = regions[0]?.cols[0]?.[0]?.pitch ?? pitchOf(body[0].size);
    const mC = {
      top: Math.max(6, colTop !== null ? H - colTop : H - body[0].base - BASE * firstPitchC),
      // Generous room below: a column that runs a little long must not push the next column onto a new page.
      bottom: Math.max(8, Math.min(lowestL.base - (1 - BASE) * pitchOf(lowestL.size) - 3 * pitchOf(lowestL.size), ...footer.map((l) => l.base + l.size * 1.2 + 4))),
      left: Math.max(10, lo - 3), right: Math.max(10, W - hi - 3), header: 6, footer: 6, slack: [3, 3] as [number, number],
    };
    // (A document to edit: the page's notes, found before the columns.)
    let notesC: Note[] = [], notesRawC: Block[] = [];
    if (early) {
      const nl = pullGrids(early.lines, shapesC, W, H);
      notesRawC = buildBlocks(nl, fonts, pageLo, pageHi, pitchCol, null); notesC = splitNotes(buildBlocks(nl, fonts, pageLo, pageHi, pitchCol, null));
      if (markNoteRefs(regions.flatMap((r) => r.cols.flat()), notesC)) eraseNow.push({ l: early.rule.x0 - 0.5, r: early.rule.x1 + 0.5, top: early.rule.y + 2, bottom: early.rule.y - 2 });
    }
    const gridsC = [...new Set(raw.flatMap((r) => (r.full ? [r.full] : [r.left!, r.right!])).flat().filter((l) => l.grid).map((l) => l.grid!))];
    const picsC = withGraphics ? await renderGraphics(page, 2, keepFonts, gridsC, arts, !drawsGraphics(pdfjs, ol)).catch(() => [] as Pic[]) : [];
    if (withGraphics) picsC.push(...await renderRegions(page, 3, formulasC).catch(() => [] as Pic[]));
    page.cleanup();
    return { ref: refOf(page), vert, w: W, h: H, pics: picsC, boxes, furniture: furnitureC, regions, header: [], footer: [], body: [], notes: notesC, notesRaw: notesRawC, notesBox: null, bodyBottom: 0, m: mC, low: Math.min(lowestL.base, ...(early ? early.lines.map((l) => l.base) : [])), lowPitch: pitchOf(lowestL.size) };
  }
  // Footnotes: below a short rule in the lower part of the page, in a smaller size.
  // (A document to edit finds them before looking for columns — see early — so a page in columns keeps its notes too.)
  let notesLines: Line[] = early ? early.lines : [];
  const rule = early ? early.rule : findNoteRule();
  if (rule && !early) {
    const below = body.filter((l) => l.base < rule.y);
    const above = body.filter((l) => l.base >= rule.y);
    if (below.length && median(below.map((l) => l.size)) < median(above.map((l) => l.size)) * 0.97) { notesLines = below; body = above; }
  }
  // Text block edges: where the wide lines (body and notes) start and end.
  const block = [...body, ...notesLines];
  const widest = Math.max(0, ...block.map((l) => l.r - l.l));
  const wide = block.filter((l) => l.r - l.l > widest * 0.6);
  const ref = wide.length ? wide : block.length ? block : textLines;
  // The edge most lines share (a cluster of equal starts/ends), the outermost such cluster winning.
  const edge = (vals: number[], outer: (a: number, b: number) => boolean, fallback: number) => {
    if (!vals.length) return fallback;
    const tol = 2.5; let best = vals[0], bestN = 0;
    for (const v of vals) {
      const n = vals.filter((x) => Math.abs(x - v) <= tol).length;
      if (n > bestN || (n >= Math.max(2, bestN * 0.6) && outer(v, best) && n >= 2)) { if (n > bestN || outer(v, best)) { best = v; bestN = Math.max(n, bestN); } }
    }
    // An outer edge that several full lines reach is the text's edge, even when more lines (notes set narrower,
    // indented quotations) share an inner one: text set out to it must fit.
    for (const v of vals) {
      const n = vals.filter((x) => Math.abs(x - v) <= tol).length;
      if (n >= 3 && outer(v, best) && Math.abs(v - best) > tol) best = v;
    }
    const near = vals.filter((x) => Math.abs(x - best) <= tol);
    return outer(1, 0) ? Math.max(...near) : Math.min(...near);
  };
  let L = edge(ref.map((l) => l.l), (a, b) => a < b, W * 0.1);
  let R = edge(ref.map((l) => l.r), (a, b) => a > b, W * 0.9);
  // A line of the text wider than the measure the others set (a title over a narrow list) must fit too, or
  // it wraps and pushes the page's end onto another page; a short note out in the margin does not count.
  for (const l of block) if (l.r - l.l >= (R - L) * 0.6) { if (l.l < L - 1) L = l.l; if (l.r > R + 1) R = l.r; }
  const bodySize = median(body.flatMap((l) => Array(Math.max(1, l.pieces.reduce((n, p) => n + p.text.length, 0))).fill(l.size))) || 12;
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D page', JSON.stringify({ W, H, L, R, bodySize, rule, lines: textLines.map((l) => ({ b: +l.base.toFixed(1), s: +l.size.toFixed(1), l: +l.l.toFixed(1), r: +l.r.toFixed(1), z: header.includes(l) ? 'H' : footer.includes(l) ? 'F' : notesLines.includes(l) ? 'N' : 'B', t: l.pieces.map((p) => p.text).join('|').slice(0, 60), ps: l.pieces.map((p) => [p.text.slice(0, 12), +p.l.toFixed(0), +p.r.toFixed(0), +p.y.toFixed(1), +p.h.toFixed(1)]), gaps: l.pieces.filter((p) => p.text.trim()).sort((x, y) => x.l - y.l).map((p, i, a) => (i ? +(p.l - a[i - 1].r).toFixed(1) : 0)).filter((g) => g > 8) })) }));
  const formulas: Box[] = [];
  const shapes = findShapes(pdfjs, ol, true);
  if ((globalThis as { krDebugLine?: string }).krDebugLine === 'shapes') console.warn('P2D shapes', JSON.stringify(shapes.map((s) => [+s.l.toFixed(1), +s.r.toFixed(1), +s.bottom.toFixed(1), +s.top.toFixed(1)])));
  const boxShapes = shapes.filter((s) => s.r - s.l >= 8 && s.top - s.bottom >= 8);
  const labels: Line[] | undefined = p2d.edit ? [] : undefined;
  const bodyBlocks = buildBlocks(pullFormulas(pullDiagrams(pullGrids(body, shapes, W, H), boxShapes, formulas, W, H, labels), formulas), fonts, L, R, pitchOf, null);
  // Figures (a document to edit): a picture standing in the text, no words over it, its own paragraph where it stands.
  if (p2d.edit) for (const f of findFigs(pdfjs, ol, body, W, H, L, R)) insertFig(bodyBlocks, f);
  for (const l of labels ?? []) {
    const runs = runsOf(l.pieces, fonts, l.rtl); if (!runs.some((r) => r.text.trim())) continue;
    const lh = l.size * 1.3;
    boxes.push({ runs, x: l.l - 1, y: H - l.base - BASE * lh, w: (l.r - l.l) * 1.08 + l.size, h: lh, rot: 0, line: lh });
  }
  const furniture = pinnedFurniture(header, footer, fonts, H);
  const headerBlocks: Block[] = [];
  const footerBlocks: Block[] = [];
  // Footnotes, split at their numbers (and kept whole, for pages whose notes cannot be Word footnotes).
  // In the page's flow the notes follow the text at the distance the page has between them.
  notesLines = pullGrids(notesLines, shapes, W, H);
  const notesRaw = buildBlocks(notesLines, fonts, L, R, pitchOf, body.length ? body[body.length - 1].base : null);
  const notesBox = notesLines.length ? { top: H - (rule ? rule.y : notesLines[0].base + notesLines[0].size), bottom: H - notesLines[notesLines.length - 1].base + notesLines[notesLines.length - 1].size * 0.4, l: L, r: R } : null;
  const notes = splitNotes(buildBlocks(notesLines, fonts, L, R, pitchOf, null));
  // Note references in the body: small raised numbers.
  const nums = new Set(notes.map((n) => n.num));
  for (const b of bodyBlocks) {
    const rowsRuns = b.kind === 'p' ? [b.runs] : b.rows.flat();
    for (const runs of rowsRuns) for (const r of runs) { const m = r.sup && DIGITS.exec(r.text); if (m && nums.has(toInt(m[1]))) r.note = toInt(m[1]); }
  }
  if (p2d.edit) {
    // (A document to edit: the notes' separator goes when the notes become Word's footnotes, which draw their own.)
    const refs = new Set<number>(); for (const b of bodyBlocks) for (const runs of b.kind === 'p' ? [b.runs] : b.kind === 'grid' ? b.rows.flat() : []) for (const r of runs) if (r.note !== undefined) refs.add(r.note);
    if (rule && notes.length && notes.every((n) => n.num >= 0 && refs.has(n.num))) eraseNow.push({ l: rule.x0 - 0.5, r: rule.x1 + 0.5, top: rule.y + 2, bottom: rule.y - 2 });
    ruleBorders(bodyBlocks, leftRules.filter((s) => !rule || Math.abs((s.y0 + s.y1) / 2 - rule.y) > 1 || s.x0 > rule.x1 || s.x1 < rule.x0), L, R);
  }
  // Margins from where the text sits.
  const top = body.length ? body[0] : textLines[0];
  // (A ruled table's line stands at the table's top: its foot is where the table ends. Or a table round the notes
  // takes the bottom margin up to its top, above the text, and the page's margins overlap.)
  const lowest0 = (notesLines.length ? notesLines : body).slice(-1)[0];
  const lowest = lowest0?.grid ? { ...lowest0, base: lowest0.grid.ys[lowest0.grid.ys.length - 1] + (1 - BASE) * pitchOf(lowest0.size) } : lowest0;
  const firstPitch = bodyBlocks[0]?.pitch ?? (top ? pitchOf(top.size) : 14);
  const m = {
    // The first line's baseline lands where the page has it; the last line's box ends just above the bottom margin.
    top: top ? Math.max(6, H - top.base - BASE * firstPitch) : 72,
    // About a line to spare below the last line: invisible, and it absorbs small drift instead of spilling a line.
    bottom: lowest ? Math.max(8, lowest.base - (1 - BASE) * pitchOf(lowest.size) - pitchOf(lowest.size)) : 72,
    // A little tolerance on each side: another font's slightly wider glyphs must not push a word to a new line.
    // (Three points and a little over one per cent of the measure on each side: a reader's font sets a word
    // a hair wider than the page's and justified text hides the difference, but a word wrapped to a new line
    // pushes the page's last line onto the next.)
    left: Math.max(10, L - 3 - (R - L) * 0.012), right: Math.max(10, W - R - 3 - (R - L) * 0.012),
    header: 6, footer: 6, slack: [0, 0] as [number, number],
  };
  m.slack = [L - m.left, W - R - m.right];
  // (Never margins that meet: Word would spread the page over several.)
  if (m.top + m.bottom > H - 36) m.bottom = Math.max(8, H - 36 - m.top);
  const grids = [...bodyBlocks, ...notesRaw].filter((b): b is Grid => b.kind === 'grid').map((b) => b.spec);
  lap('layout');
  const headBlocks = header.length && bodyBlocks.length ? buildBlocks(header, fonts, L, R, pitchOf, null) : [];
  // The lines taken as the running head, set as the text would have them — for sortFurniture to put back.
  // (A rule under a title taken for the running head goes with it, should it come back to the text.)
  if (p2d.edit && headBlocks.length) ruleBorders(headBlocks, leftRules, L, R);
  const pics = withGraphics ? await renderGraphics(page, 2, keepFonts, [...new Set(grids)], arts, !drawsGraphics(pdfjs, ol)).catch(() => [] as Pic[]) : [];
  lap('graphics');
  if (withGraphics) pics.push(...await renderRegions(page, 3, formulas).catch(() => [] as Pic[]));
  lap('regions');
  page.cleanup();
  const lastBody = body[body.length - 1];
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D notes', JSON.stringify({ lastBody: lastBody?.base, firstNote: notesLines[0]?.base, before: notesRaw[0] && notesRaw[0].before, pitch: notesRaw[0] && notesRaw[0].pitch, bodyBlocks: bodyBlocks.map((b) => [b.kind, +b.before.toFixed(1), +b.pitch.toFixed(1)]) }));
  const notesAt = notesLines.length && notesRaw[0] ? H - notesLines[0].base - BASE * notesRaw[0].pitch : undefined;
  const uncut = headBlocks.length ? { blocks: headBlocks, top: H - header[0].base - BASE * headBlocks[0].pitch, bottom: H - header[header.length - 1].base + (1 - BASE) * headBlocks[headBlocks.length - 1].pitch } : undefined;
  return { ref: refOf(page), vert, w: W, h: H, pics, boxes, furniture, header: headerBlocks, footer: footerBlocks, body: bodyBlocks, notes, notesRaw, notesBox, notesAt, bodyBottom: lastBody ? lastBody.base - lastBody.size * 0.4 : 0, m, uncut, low: lowest0?.base, lowPitch: lowest0 ? pitchOf(lowest0.size) : undefined };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/** How many lanes (page readers in workers of their own, see pdf2docx.lane.ts) a book is read in: at least one
 *  wherever workers can draw (OffscreenCanvas) — the pages are then laid out and drawn off the app's thread, which
 *  only puts them together and stays free for the screen, and everything a lane held goes when its worker ends —
 *  and one for each two cores beyond that, up to six on a computer and two on a phone; as many as its memory holds
 *  (each lane is a whole reader: its copy of the document in its pdf.js worker, a canvas), and fewer for a big
 *  file. One lane costs what reading on this thread costs (one copy of the document); none only for a short book
 *  (a lane's start-up is not worth it) or where workers cannot draw. */
function laneCount(pages: number, size: number): number {
  const forced = (globalThis as { krLanes?: number }).krLanes;
  if (forced !== undefined) return forced;
  if (pages < 8 || typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined' || typeof MessageChannel === 'undefined') return 0;
  const cores = navigator.hardwareConcurrency || 2;
  const phone = (globalThis as { krPhone?: boolean }).krPhone ?? (typeof window !== 'undefined' && onPhone());
  return Math.max(1, Math.min(phone ? 2 : 6, Math.floor(cores / 2), Math.ceil(pages / 8), size > 80 * 1024 * 1024 ? 1 : size > 40 * 1024 * 1024 ? 2 : 6, lanesForMemory()));
}
/** The device's memory in gigabytes (navigator.deviceMemory: rounded down to a power of two, at most 8; unknown
 *  where the browser does not tell). */
const deviceGb = (): number | undefined => (globalThis as { krDeviceMemory?: number }).krDeviceMemory ?? (navigator as { deviceMemory?: number }).deviceMemory;
/** The lanes the device's memory allows: one on a device of 2 GB or less, two under 8 GB; unknown leaves the
 *  cores to decide. */
function lanesForMemory(): number {
  const gb = deviceGb();
  return gb === undefined ? 6 : gb <= 2 ? 1 : gb < 8 ? 2 : 6;
}
/** The workers of the lanes of the conversions under way (theirs and their pdf.js workers'), for a test to see that
 *  none outlives its job. */
const liveWorkers = new Set<Worker>();
(globalThis as { krConvWorkers?: () => number }).krConvWorkers = () => liveWorkers.size;

/**
 * The pages read in lanes, put together here in page order exactly as one reader would have them: each font
 * known by its id in the file, first met where one reader would first meet it; glyph runs kept under the cap in
 * page order; and a page that a font of whole-word glyphs met on an earlier page (read in another lane) would
 * have read otherwise, read again. Null when the lanes could not do it (the caller reads the pages itself).
 */
async function readInLanes(file: Blob, nPages: number, nLanes: number, fonts: Map<string, FontInfo>, store: UseStore, progress: Progress): Promise<PageModel[] | null> {
  type Lane = { w: Worker; pw: Worker; out: number; ready: boolean; heard: number; said: string };
  const lanes: Lane[] = [];
  const done = new Map<number, import('./pdf2docx.lane').LanePage>();
  const defs = new Map<string, FontInfo>();
  let next = 1, failed: string | null = null, wake: (() => void) | null = null, heard = Date.now();
  const poke = () => { const w = wake; wake = null; w?.(); };
  const QUEUE = 3;
  // (A lane that says nothing for this long before it is ready — its script, pdf.js or pdf.js's worker never
  // started — is given up, and the pages are read here: a conversion never waits on lanes that cannot answer.)
  const OPEN_WAIT = Number((globalThis as { krLaneWait?: number }).krLaneWait ?? 20000);
  // (Never far ahead of the page being put together: pages done early wait here, pictures and all.)
  let at = 1; const AHEAD = 8 * nLanes;
  const feed = (l: Lane) => { while (l.out < QUEUE && next <= nPages && next < at + AHEAD) { l.w.postMessage({ t: 'page', n: next++ }); l.out++; } };
  const redoing = new Set<number>(), redone = new Set<number>();
  try {
    for (let i = 0; i < nLanes; i++) {
      // Each lane and its pdf.js worker are both started here, on the page, and joined by a channel: a worker
      // cannot start a worker everywhere (Windows' WebView2), and a lane that tried gave up there.
      const pw = new Worker(new URL('./pdfjsport.js', import.meta.url), { type: 'module' }); liveWorkers.add(pw);
      const w = new Worker(new URL('./pdf2docxlane.js', import.meta.url), { type: 'module' }); liveWorkers.add(w);
      const l: Lane = { w, pw, out: 0, ready: false, heard: Date.now(), said: 'nothing' }; lanes.push(l);
      w.onerror = (e) => { failed = failed ?? `lane ${i}: ${e.message || 'its script did not start'}`; poke(); };
      // (pdf.js listens to none of its worker's failures when given a channel: one that cannot start would leave
      // the lane waiting for ever. Seen here instead, so the pages are read on this thread at once.)
      pw.onerror = (e) => { e.preventDefault(); failed = failed ?? `pdf.js's worker for lane ${i} did not start (${e.message || 'no message'})`; poke(); };
      pw.onmessage = (e: MessageEvent<{ krPdfjs?: string; message?: string }>) => { if (e.data?.krPdfjs === 'failed') { failed = failed ?? `pdf.js's worker for lane ${i} did not start (${e.data.message})`; poke(); } };
      w.onmessage = (e: MessageEvent<import('./pdf2docx.lane').LaneOut>) => {
        const m = e.data; heard = l.heard = Date.now();
        if (m.t === 'step') l.said = m.s;
        else if (m.t === 'closed') endLane(l);
        else if (m.t === 'ready') { if (m.pages !== nPages) failed = failed ?? 'pages'; else l.ready = true; poke(); }
        else if (m.t === 'error') { failed = failed ?? m.message; poke(); }
        else { l.out--; done.set(m.n, m); redoing.delete(m.n); feed(l); poke(); }
      };
      // (The file itself goes, not its bytes: a Blob is passed, not copied — each lane reads it once and hands it
      // over to its pdf.js worker; nothing of it is kept here.)
      const ch = new MessageChannel();
      pw.postMessage({ krPort: ch.port1 }, [ch.port1]);
      w.postMessage({ t: 'open', file, lane: i, port: ch.port2, edit: p2d.edit } satisfies import('./pdf2docx.lane').LaneIn, [ch.port2]);
    }
    while (!lanes.every((l) => l.ready)) {
      if (failed) throw new Error(failed);
      const t = Date.now();
      if (lanes.some((l) => !l.ready && t - l.heard > OPEN_WAIT)) throw new Error(`lanes silent ${Math.round(OPEN_WAIT / 1000)} s before they were ready; last heard: ${lanes.map((l, i) => `lane ${i} «${l.ready ? 'ready' : l.said}»`).join(', ')}`);
      await new Promise<void>((r) => { wake = r; setTimeout(r, Math.min(1000, OPEN_WAIT)); });
    }
    for (const l of lanes) feed(l);
    const pages: PageModel[] = [];
    const words = new Set<string>();
    for (let n = 1; n <= nPages; n++) {
      while (!done.has(n) || redoing.has(n)) {
        if (failed) throw new Error(failed);
        // (A lane that went quiet — its worker gone without a word — is given up after two minutes.)
        if (Date.now() - heard > 120000) throw new Error('lanes went quiet');
        await new Promise<void>((r) => { wake = r; setTimeout(r, 5000); });
      }
      const r = done.get(n)!;
      // (The fonts a lane tells of once, the first time it meets them: kept even from a page read again.)
      for (const [id, info] of r.fonts) if (!defs.has(id)) defs.set(id, info);
      // A font of whole-word glyphs met on an earlier page that this page's lane did not know of: read again.
      if (!redone.has(n) && r.stickyMiss.some((id) => words.has(id))) {
        done.delete(n); redoing.add(n); redone.add(n);
        const l = lanes.reduce((a, b) => (b.out < a.out ? b : a)); l.out++;
        l.w.postMessage({ t: 'page', n, force: [...words] }); n--; continue;
      }
      done.delete(n);
      // (Each lane's pictures came as its own copies: one held for all that are the same.)
      for (const p of r.model.pics) p.png = samePng(p.png);
      eachRunList(r.model, (runs) => { for (const x of runs) if (x.art?.pic) x.art.pic.png = samePng(x.art.pic.png); });
      for (const [id, info] of r.fonts) if (!defs.has(id)) defs.set(id, info);
      for (const id of r.pageFonts) if (!fonts.has(id)) { const d = defs.get(id); if (d) fonts.set(id, { ...d }); }
      for (const s of r.seqs) {
        let keep = false;
        for (const [font, u] of s.uses) {
          const fi = fonts.get(font); if (!fi) continue;
          const seen = store.seen.get(font) ?? store.seen.set(font, new Set()).get(font)!;
          if ((fi.uses ?? 0) < USE_CAP || !seen.has(u[0])) keep = true;
        }
        if (keep) { for (const [font, u] of s.uses) { const fi = fonts.get(font)!; fi.uses = (fi.uses ?? 0) + 1; store.seen.get(font)!.add(u[0]); } store.seqs.push(s.uses, s.rtl); }
      }
      for (const [id, add] of r.gaps) { const fi = fonts.get(id); if (!fi) continue; const g = (fi.gaps ??= []); for (const x of add) { if (g.length >= 400) break; g.push(x); } }
      const found = r.wordFound.filter((id) => !words.has(id));
      if (found.length) { for (const id of found) { words.add(id); const fi = fonts.get(id); if (fi) fi.wordFont = true; } for (const l of lanes) l.w.postMessage({ t: 'word', ids: found }); }
      pages.push(r.model);
      at = n + 1; for (const l of lanes) feed(l);
      progress('pdfPage', Math.round((n / nPages) * 80));
    }
    return pages;
  } catch (e) {
    console.warn('[kurokawa] PDF → Word lanes: reading on this thread instead', e);
    return null;
  } finally {
    // (Each lane closes its document and says so, and is ended with its pdf.js worker then — or after a moment,
    // whatever it is doing: all that the lane and pdf.js held goes with them.)
    for (const l of lanes) { l.w.postMessage({ t: 'close' }); setTimeout(() => endLane(l), 1000); }
  }
}
function endLane(l: { w: Worker; pw: Worker }): void {
  l.w.onmessage = null; l.w.terminate(); l.pw.terminate();
  liveWorkers.delete(l.w); liveWorkers.delete(l.pw);
}

export async function pdfToDocx(book: Book, file: Blob, progress: Progress, password?: string, opts: { exact?: boolean } = {}): Promise<Blob> {
  p2d.edit = !opts.exact;
  // Whatever the job opened or drew on is let go when it ends — done, failed or cancelled: pdf.js's documents
  // (and the worker each keeps), the canvases kept from page to page, the pictures met. (A document left open by a
  // job that failed half-way held its whole file and pdf.js's caches until the app was closed.)
  const docs = new Set<{ destroy(): unknown }>();
  try { return await convertPdf(book, file, progress, password, (o) => { docs.add(o); return o; }); }
  finally {
    for (const o of docs) { try { await o.destroy(); } catch { /* gone */ } }
    for (const c of [graphicsCanvas, scanCanvas]) if (c) { c.width = 0; c.height = 0; }
    graphicsCanvas = null; scanCanvas = null;
    pngSeen.clear(); pendingPngs = [];
  }
}

async function convertPdf(book: Book, file: Blob, progress: Progress, password: string | undefined, track: <T extends { destroy(): unknown }>(o: T) => T): Promise<Blob> {
  const pdfjs = await loadPdfjs();
  const { yieldNow } = await import('./jobs');
  const RES = new URL('./pdfjs/', import.meta.url).href;
  // A protected file opens with the password given or remembered for it; one whose text pdf.js cannot read
  // (it comes out as control characters) is read from a copy decrypted here instead.
  const { openPdfjs, reopenDecrypted, looksGarbled } = await import('./pdfkeys');
  const jsOpts = { fontExtraProperties: true, useSystemFonts: false, cMapUrl: cmapsUrl(RES), cMapPacked: true, standardFontDataUrl: `${RES}standard_fonts/`, wasmUrl: `${RES}wasm/`, iccUrl: `${RES}iccs/` };
  let opened = track(await openPdfjs(pdfjs, new Uint8Array(await file.arrayBuffer()), jsOpts, { password }));
  if (opened.encrypted) {
    const p1 = await opened.doc.getPage(1); const tc = await p1.getTextContent();
    const text = (tc.items as { str?: string }[]).map((i) => i.str ?? '').join('');
    if (looksGarbled(text, text.length)) opened = track((await reopenDecrypted(pdfjs, opened, jsOpts)) ?? opened);
  }
  let doc = opened.doc;
  // (For a document to edit: the document's outline — its bookmarks — names its headings.)
  const outline = p2d.edit ? await readOutline(doc).catch(() => []) : [];
  const fonts = new Map<string, FontInfo>();
  pngSeen.clear();
  let store: UseStore = { seqs: new GlyphRuns(), seen: new Map() };
  let pages: PageModel[] = [];
  pendingPngs = [];
  // On a device with cores to spare, the pages are read in lanes (workers of their own, each with its copy of
  // the document) and only put together here.
  // (Not a protected file: the lanes read the file as it is, without its password — and a copy decrypted here,
  // the bytes pdf.js was given and kept, is not that file.)
  const nLanes = opened.encrypted || opened.bytes.byteLength > 0 ? 0 : laneCount(doc.numPages, file.size);
  let laned: PageModel[] | null = null;
  if (nLanes >= 1) {
    // (The copy opened here to count the pages is closed while the lanes read theirs — on a phone, the memory
    // of a whole document that only waits — and opened again only if the lanes could not do it.)
    const nPages = doc.numPages;
    await opened.destroy();
    laned = await readInLanes(file, nPages, nLanes, fonts, store, progress);
    if (!laned) { opened = track(await openPdfjs(pdfjs, new Uint8Array(await file.arrayBuffer()), jsOpts, { password })); doc = opened.doc; }
  }
  if (laned) pages = laned;
  else {
    fonts.clear();
    // On a device with cores to spare, a second copy of the document in a worker of its own reads the even pages
    // while the first reads the odd ones: pdf.js parses a page's drawing and its text in one thread, and that
    // thread, not this one, is what a long book waits on. (The fonts the second copy loads are the first's again
    // under other names; buildDocFonts makes one of each face.)
    // (Not where memory is short: the second copy is another document parsed in full.)
    const twice = doc.numPages >= 6 && !opened.encrypted && file.size < 60 * 1024 * 1024 && ((globalThis as { krTwoWorkers?: boolean }).krTwoWorkers ?? ((navigator.hardwareConcurrency ?? 2) >= 4 && (deviceGb() ?? 4) > 2));
    const opened2 = twice ? await openPdfjs(pdfjs, new Uint8Array(await file.arrayBuffer()), jsOpts, { password }).then(track).catch(() => null) : null;
    const doc2 = opened2 && opened2.doc.numPages === doc.numPages ? opened2.doc : null;
    if (opened2 && !doc2) void opened2.destroy();
    const docOf = (n: number) => (doc2 && n % 2 === 0 ? doc2 : doc);
    const task = { destroy: async () => { await opened.destroy(); if (doc2) await opened2!.destroy(); } };
    store = { seqs: new GlyphRuns(), seen: new Map(), ...(doc2 ? { same: new Map(), byFile: new Map() } : {}) };
    pages = [];
    pendingPngs = [];
    // The worker reads the next pages (their drawing and their text) while this one is laid out here — a couple
    // ahead, so that neither side waits for the other (each page's pictures let go once it is laid out).
    const AHEAD = Number((globalThis as { krAhead?: number }).krAhead ?? (doc2 ? 3 : 2));
    const ask = (n: number) => docOf(n).getPage(n).then((pg) => { void pg.getOperatorList(); prefetched.set(pg, pg.getTextContent()); return pg; });
    const asked = new Map<number, Promise<import('pdfjs-dist').PDFPageProxy>>();
    for (let p = 1; p <= doc.numPages; p++) {
      for (let k = p; k <= Math.min(doc.numPages, p + AHEAD); k++) if (!asked.has(k)) asked.set(k, ask(k));
      progress('pdfPage', Math.round((p / doc.numPages) * 80));
      const page = await asked.get(p)!; asked.delete(p);
      pages.push(await analysePage(pdfjs, page, fonts, true, store));
      if (p % 8 === 0) await yieldNow();
    }
    await task.destroy();
    await Promise.all(pendingPngs); pendingPngs = [];
  }
  progress('build', 85);
  memMark('read');
  const TT = (globalThis as { krTiming?: Record<string, number> }).krTiming; const tb = performance.now();

  // The PDF's embedded fonts, rebuilt as TrueType fonts Word can carry (subsets of one face merged, and the
  // several fonts a legacy Arabic book spreads its letter forms over made one), then runs renamed to them.
  // Fonts whose text Word stretches with kashidas (verses, tatweel-justified paragraphs, tatweels kept in the
  // text) keep their tatweel; the others lose it, or LibreOffice would stretch every justified line with it.
  // Page numbers and running heads, across the pages.
  sortFurniture(pages);
  // For a document to edit: a paragraph cut by a page break is one again, and a paragraph's lines are one text.
  if (p2d.edit) { mergeAcrossPages(pages); flowPages(pages); structure(pages, outline, writerLists); joinLines(pages); placeLinks(pages); }
  // (Footnotes numbered on from page to page — a later page's first note not 1 — count on in Word too.)
  notesRestart = !pages.some((pg) => realNotes(pg) && Math.min(...pg.notes.map((n) => n.num)) > 1);
  // (Between the passes over the whole book, the screen gets its turn: each is tens of milliseconds on a long one.)
  await yieldNow();
  const stretched = new Set<string>();
  for (const pg of pages) for (const b of [...pg.body, ...pg.notesRaw, ...pg.notes.flatMap((n) => n.paras), ...(pg.regions ?? []).flatMap((r) => r.cols.flat()), ...(pg.placed ?? []).flatMap((x) => x.blocks)]) {
    if (b.kind === 'verse') { for (const row of b.rows) for (const cell of row) for (const r of cell) stretched.add(r.font); }
    else if (b.kind === 'grid') { for (const row of b.rows) for (const cell of row) for (const r of cell) if (r.text.includes('\u0640')) stretched.add(r.font); }
    else for (const r of b.runs) if (b.kashida || r.text.includes('\u0640')) stretched.add(r.font);
  }
  await yieldNow();
  // (The fonts take a while on a long book — seconds here, more on a phone: the progress moves on with them.)
  const { alias, byKey } = await buildDocFonts(fonts, store, stretched, async (done) => { progress('build', 85 + Math.round(done * 4)); await yieldNow(); });
  memMark('docFonts');
  store.seqs = new GlyphRuns();
  memMark('runsFreed');
  await yieldNow();
  if (alias.size || byKey.size) for (const pg of pages) renameRuns(pg, alias, byKey);
  mergeWordFonts(fonts, pages);
  await yieldNow();
  // In a font rebuilt from the PDF's own glyphs, the page's own tatweels give its lines exactly their width:
  // they stay, and Word adds none.
  const exact = new Set([...fonts.values()].filter((f) => f.rebuilt && f.raw).map((f) => f.family));
  for (const [a, b] of alias) if (exact.has(b)) exact.add(a);

  // The document's XML, written straight (src/docxwrite.ts): a paragraph, a run, a table each a string.
  const W_ = await import('./docxwrite');
  // (Counted, not kept: a list of every block of the book would hold every page until the end.)
  let nBlocks = 0, nRtl = 0;
  for (const p of pages) for (const b of [...p.body, ...(p.regions ?? []).flatMap((r) => r.cols.flat()), ...(p.placed ?? []).flatMap((x) => x.blocks)]) { nBlocks++; if (b.rtl) nRtl++; }
  const rtlDoc = nRtl > nBlocks / 2;
  const writer = new W_.DocxWriter({ creator: 'KurokawaReader', title: book.title, rtl: rtlDoc, defaultFont: rtlDoc ? { ascii: 'Times New Roman', cs: 'Traditional Arabic', hAnsi: 'Times New Roman', eastAsia: 'Times New Roman' } : 'Times New Roman' });
  // (A document to edit: its heading styles, and its lists in the order structure() numbered them.)
  if (p2d.edit) { writer.structure = true; writer.thinSections = true; for (const l of writerLists) writer.listOf(l); writerLists.length = 0; }

  const usedChars = new Map<string, Set<number>>();
  const propsOf = (r: Run): import('./docxwrite').RunProps => ({
    font: r.font, size: Math.max(2, Math.round(r.size * 2)),
    scale: r.cs && r.cs !== 100 ? r.cs : undefined,
    spacing: r.spacing ? Math.round(r.spacing * PT) : undefined,
    bold: r.bold, italic: r.italic,
    color: r.color && r.color !== '000000' ? r.color : undefined,
    rtl: r.rtl || undefined,
    // Raised by exactly what the page raises it, at its own size (Word's superscript would shrink it again).
    ...(r.sup ? (r.raise ? { position: Math.round(r.raise * 2) } : { superScript: true }) : {}),
    ...(r.u ? { underline: r.u } : {}), ...(r.strike ? { strike: true } : {}), ...(r.shd ? { shading: r.shd } : {}),
  });
  const runFor = (r: Run, footnotes: Map<number, number> | null, part: InstanceType<typeof W_.Part>): string => {
    if (r.art) {
      const pic = r.art.pic;
      if (!pic) { if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D art-nopic', r.art.font, r.art.l.toFixed(1), r.art.y.toFixed(1)); return ''; }
      return W_.inlineImage(part, pic.png, pic.kind ?? 'png', Math.max(1, Math.round(pic.w * 96 / 72)), Math.max(1, Math.round(pic.h * 96 / 72)));
    }
    if (r.note !== undefined && footnotes?.has(r.note) && !r.br) return W_.footnoteRef(footnotes.get(r.note)!);
    const key = `${r.font}|${r.bold && r.italic ? 'BoldItalic' : r.bold ? 'Bold' : r.italic ? 'Italic' : 'Regular'}`;
    let set = usedChars.get(key); if (!set) usedChars.set(key, set = new Set());
    for (const ch of r.text) set.add(ch.codePointAt(0)!);
    return W_.textRun(r.text, propsOf(r), { br: !!r.br, tab: r.tab !== undefined });
  };
  // A running head's or page number's runs: the page number a PAGE field (its digits, as the page has them, its
  // last result), the marks and words round it plain text.
  const furnitureRuns = (f: Furniture, part: InstanceType<typeof W_.Part>): string => {
    if (!f.num) return f.runs.map((r) => runFor(r, null, part)).join('');
    const { from, to } = f.num;
    let at = 0, out = '', result = '', look: Run | null = null;
    const close = () => { if (result) out += W_.field('PAGE', result, propsOf(look!)); result = ''; };
    for (const r of f.runs) {
      const a = at; at += r.text.length;
      const i = Math.max(0, Math.min(r.text.length, from - a)), j = Math.max(0, Math.min(r.text.length, to - a));
      if (i >= j || r.art) { if (a >= to) close(); out += runFor(r, null, part); continue; }
      // (A line break or tab before the number stays outside the field.)
      if (i > 0 || r.br || r.tab !== undefined) out += runFor({ ...r, text: r.text.slice(0, i) }, null, part);
      look ??= r;
      result += runFor({ ...r, text: r.text.slice(i, j), br: false, tab: undefined }, null, part);
      if (j < r.text.length) { close(); out += runFor({ ...r, text: r.text.slice(j), br: false, tab: undefined }, null, part); }
    }
    close();
    return out;
  };
  const alignOf = (a: Para['align']): import('./docxwrite').Align => (a === 'center' ? 'center' : a === 'both' ? 'both' : a === 'end' ? 'end' : 'start');
  const markRun = (b: { runs?: Run[]; rtl: boolean; size: number }): import('./docxwrite').RunProps => {
    const r = b.runs?.find((x) => x.text.trim()); const half = Math.max(2, Math.round((r?.size ?? b.size) * 2));
    return r ? { font: r.font, size: half, rtl: b.rtl || undefined } : { size: half, rtl: b.rtl || undefined };
  };
  // A stretched paragraph set in a rebuilt font keeps the page's tatweels and is justified by its spaces.
  const ownStretch = (b: Para): Para => (b.kashida && b.runs.every((r) => !r.text.trim() || exact.has(r.font)) ? { ...b, kashida: false, runs: b.runs.map((r) => (r.kText ? { ...r, text: r.kText } : r)) } : b);
  // The page's margins leave a little room beyond the text's edges (see analysePage): a paragraph takes it back
  // on the side it is aligned to, so its text stands where the page has it, and keeps it on the other side as
  // the room a slightly wider rendering may need.
  let slackNow: [number, number] = [0, 0];
  const indentOf = (b: Para) => {
    const [sl, sr] = slackNow; const start = b.rtl ? sr : sl, end = b.rtl ? sl : sr;
    const addStart = b.align === 'start' || b.align === 'both' || b.align === 'center' ? start : 0;
    const addEnd = b.align === 'end' || b.align === 'center' ? end : 0;
    return { start: Math.round((b.indStart + addStart) * PT), end: Math.round((b.indEnd + addEnd) * PT), ...(b.firstLine >= 0 ? { firstLine: Math.round(b.firstLine * PT) } : { hanging: Math.round(-b.firstLine * PT) }) };
  };
  // (For a document to edit: a paragraph's lines at the page's pitch, as a multiple of the "single" line of the font its
  // text is set in — the font the file carries, known once the fonts are built, so the body's paragraphs hold a token
  // filled in then: see lineFix.)
  const lineFix: { pitch: number; size: number; font: string }[] = [];
  const domFont = (runs: Run[]) => { const w = new Map<string, number>(); for (const r of runs) if (!r.art && r.text.trim()) w.set(r.font, (w.get(r.font) ?? 0) + r.text.length); return [...w].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''; };
  const autoLine = (pitch: number, size: number, runs: Run[], part: InstanceType<typeof W_.Part>): number | string => {
    if (part !== writer.body) return Math.max(200, Math.min(720, Math.round(240 * pitch / (size * (NAMED_LINE[domFont(runs)] ?? 1.17)))));
    lineFix.push({ pitch, size, font: domFont(runs) }); return `\u00a7${lineFix.length - 1}\u00a7`;
  };
  const paraFor = (b0: Para, footnotes: Map<number, number> | null, part: InstanceType<typeof W_.Part>, extra: { before?: number; colBreak?: boolean; frame?: import('./docxwrite').Frame } = {}): string => {
    const b1 = ownStretch(b0); const b = p2d.edit && !extra.frame ? { ...b1, runs: plainRuns(b1.runs) } : b1;
    return W_.paragraph({
      style: b.heading === undefined ? undefined : b.heading === 0 ? 'Title' : `Heading${b.heading}`,
      outline: b.heading ? b.heading - 1 : undefined,
      num: b.list ? { id: b.list.id, lvl: b.list.lvl } : undefined,
      bidi: b.rtl, mark: markRun(b), widowControl: false,
      // (Justified by its spaces even where the page used tatweels: a line ending in a line break is stretched by
      // Word and LibreOffice alike only that way.)
      align: alignOf(b.align),
      indent: b.list && b.listInd && b.align !== 'center' && b.align !== 'end' ? undefined : indentOf(b),
      // (For a document to edit, the lines' pitch as a multiple of the type's own line — Word's automatic spacing,
      // which grows with a bigger letter or a picture in the line instead of cutting it off.)
      spacing: p2d.edit && !extra.frame && b.runs.length ? { before: Math.round((extra.before ?? b.before) * PT), after: 0, line: autoLine(b.pitch, b.size, b.runs, part), lineRule: 'auto' } : { before: Math.round((extra.before ?? b.before) * PT), after: 0, line: Math.round(b.pitch * PT), lineRule: 'exact' },
      // (Stops are measured from the text's edge less 3 pt; the margin stands further out by the page's slack — see
      // indentOf: a stop is set from the margin, as Word measures it.)
      tabs: b.tabs?.map((t) => ({ type: t.type, pos: Math.round((t.pos + (extra.frame ? 0 : (b.rtl ? slackNow[1] : slackNow[0]) - 3)) * PT) })),
      frame: extra.frame, borders: b.bdr,
    }, (extra.colBreak ? W_.columnBreak() : '') + linked(b.runs, (r) => runFor(r, footnotes, part), part));
  };
  const none: import('./docxwrite').Border = { style: 'none', size: 0, color: 'FFFFFF' };
  // Runs under one link together in a w:hyperlink: out of the document by its relationship, inside it by a bookmark.
  function linked(runs: Run[], one: (r: Run) => string, part: InstanceType<typeof W_.Part>): string {
    let out = ''; let i = 0;
    while (i < runs.length) {
      const l = runs[i].link; if (!l) { out += one(runs[i++]); continue; }
      let j = i; let inner = ''; while (j < runs.length && runs[j].link === l) inner += one(runs[j++]);
      out += l.startsWith('#') ? `<w:hyperlink w:anchor="${W_.esc(l.slice(1))}" w:history="1">${inner}</w:hyperlink>` : `<w:hyperlink r:id="${writer.link(part, l)}" w:history="1">${inner}</w:hyperlink>`;
      i = j;
    }
    return out;
  }
  const verseFor = (v: Verse, footnotes: Map<number, number> | null, part: InstanceType<typeof W_.Part>): string => {
    const cols = v.rows[0].length;
    const midW = cols === 3 ? Math.round(Math.max(v.midW, v.size * 2.5) * PT) : 0;
    // The gap between the halves becomes cell padding (half on each side of each cell), so the table grows by it.
    const pad = cols === 2 ? Math.round((v.gap / 2) * PT) : 0;
    const colW = Math.round(((v.width * PT) - midW) / 2) + pad;
    // A verse numbered at its start ("٥٢ ــــ نَكِرَةٌ…"): its first half is wider by the number, the second
    // narrower; each column as wide as its widest half, or the first half, in a column of half the line, broke
    // in two.
    const lead = cols === 2 && v.lead && v.exts?.length ? [0, 1].map((i) => Math.max(...v.exts!.map((e) => e[i]))) : null;
    const widths = cols === 3 ? [colW, midW, colW] : lead ? lead.map((w) => Math.round(w * PT) + 2 * pad) : [colW, colW];
    const indent = Math.round((v.indStart + (v.rtl ? slackNow[1] : slackNow[0])) * PT) - pad;
    return W_.table({ rtl: v.rtl, width: widths.reduce((a, b) => a + b, 0), columns: widths, indent: indent || undefined, borders: none },
      v.rows.map((row, i) => W_.tableRow({}, row.map((runs, c) => W_.tableCell({ width: widths[c], margins: { top: 0, bottom: 0, left: pad, right: pad } },
        W_.paragraph({
          bidi: v.rtl,
          // Each half-line fills its cell the way the book stretches it (Word adds the kashidas).
          // (In a rebuilt font the half-line keeps the page's own tatweels, which give it its width.)
          align: cols === 3 && c === 1 ? 'center' : 'distribute',
          widowControl: false,
          spacing: { before: i === 0 ? Math.round(v.before * PT) : 0, after: 0, line: Math.round(v.pitch * PT), lineRule: 'exact' },
        }, runs.map((r) => runFor(exact.has(r.font) ? r : { ...r, text: dropStretch(r.text) }, footnotes, part)).join('')))).join(''))).join(''));
  };
  // A ruled table: its columns and rows as the page draws them, each cell's lines as the page breaks them.
  const gridFor = (g: Grid, footnotes: Map<number, number> | null, part: InstanceType<typeof W_.Part>, float?: { x: number; y: number }): string => {
    const pad = g.pad; // points of room inside each cell
    const order = <T,>(a: T[]) => (g.rtl ? [...a].reverse() : a);
    const sz = Math.max(2, Math.min(24, Math.round(g.spec.rule * 8)));
    const line: import('./docxwrite').Border = { style: 'single', size: sz, color: '000000' };
    const colTw = g.colW.map((w) => Math.round(w * PT));
    const colsIn = (c0: number, span: number) => colTw.slice(c0, c0 + span).reduce((a, b) => a + b, 0);
    return W_.table({ rtl: g.rtl, width: colTw.reduce((a, b) => a + b, 0), columns: order(colTw), indent: float ? undefined : Math.round((g.indStart + (g.rtl ? slackNow[1] : slackNow[0]) + pad) * PT), borders: line, float },
      g.rows.map((row, i) => W_.tableRow({ height: { value: Math.round(g.rowH[i] * PT), rule: 'atLeast' }, header: i === 0 && g.header },
        order(row.map((runs, k) => ({ runs, meta: g.cells[i][k], spec: g.spec.rows[i][k] }))).map(({ runs, meta, spec }) => W_.tableCell({
          width: colsIn(spec.c0, spec.span), span: meta.span > 1 ? meta.span : undefined, vMerge: meta.vmerge, vAlign: meta.vcenter ? 'center' : 'top', fill: spec.fill,
          // (An open table: only the rules the page draws across, each at its row's edge.)
          borders: g.spec.rules ? { top: g.spec.rules[i] ? line : none, bottom: g.spec.rules[i + 1] ? line : none, left: none, right: none } : undefined,
          margins: { top: 0, bottom: 0, left: Math.round(pad * PT), right: Math.round(pad * PT) },
        }, W_.paragraph({ bidi: g.rtl, widowControl: false, align: alignOf(meta.align), spacing: p2d.edit && runs.some((r) => r.text.trim()) ? { before: 0, after: 0, line: autoLine(meta.pitch, median(runs.filter((r) => r.text.trim()).map((r) => r.size)), runs, part), lineRule: 'auto' } : { before: 0, after: 0, line: Math.round(meta.pitch * PT), lineRule: 'exact' } }, (p2d.edit ? plainRuns(runs) : runs).map((r) => runFor(r, footnotes, part)).join('')))).join(''))).join(''));
  };
  const hairline = (before: number, children = ''): string => W_.paragraph({ spacing: { before: Math.round(before), after: 0, line: 20, lineRule: 'exact' } }, children || W_.textRun('', { size: 2 }));
  // (A table has no space above of its own: an empty line of that height goes before it.)
  // (As space before a hairline paragraph, so it goes where a paragraph's space before would — none at the top
  // of a column.)
  const gridBlock = (g: Grid, footnotes: Map<number, number> | null, part: InstanceType<typeof W_.Part>): string => (g.before > 1 ? hairline((g.before - 1) * PT) : '') + gridFor(g, footnotes, part);
  const blocksFor = (bs: Block[], footnotes: Map<number, number> | null, part: InstanceType<typeof W_.Part>): string => bs.map((b) => (b.kind === 'p' ? paraFor(b, footnotes, part) : b.kind === 'grid' ? gridBlock(b, footnotes, part) : verseFor(b, footnotes, part))).join('');
  const emptyPara = '<w:p/>';

  const sectionsOf = (pg: PageModel): import('./docxwrite').Section[] => {
    slackNow = pg.m.slack ?? [0, 0];
    const body = writer.body;
    const map = new Map<number, number>();
    // (Real Word footnotes are off — REAL_FOOTNOTES — so the note area stays in the page's flow, numbers and all,
    // right where the page has it.)
    let flowNotes = pg.notesRaw;
    // (A document to edit: the page's notes, when each answers a number in its text, are Word footnotes — out of
    // the flow, each its number Word's own.)
    if (realNotes(pg)) {
      for (const n of pg.notes) {
        const xml = n.paras.map((b, i) => {
          const x = b.kind === 'p' ? paraFor({ ...b, before: 0, indStart: 0, firstLine: 0, heading: undefined, list: undefined }, null, writer.notesPart) : blocksFor([b], null, writer.notesPart);
          return i === 0 && b.kind === 'p' ? x.replace(/^(<w:p>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?)/, '$1<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>') : x;
        }).join('');
        map.set(n.num, writer.footnote(xml));
      }
      flowNotes = [];
    }
    const hdr = writer.newPart(), ftr = writer.newPart();
    // (Stacked in the order the page has them: its drawing first, a formula's or a diagram's picture with its
    // words over it — not by their heights, which is what Word goes by when it is not told.)
    const picRuns = pg.pics.map((pic, i) => W_.anchoredImage(hdr, pic.png, pic.kind ?? 'png', Math.max(1, Math.round(pic.w * 96 / 72)), Math.max(1, Math.round(pic.h * 96 / 72)), Math.round(pic.x * EMU), Math.round(pic.y * EMU), 1 + i)).join('');
    // Running heads and page numbers: plain header/footer paragraphs placed by spacing (the 4/5 baseline rule)
    // with each item on a centre tab stop at its original centre — exact in any word processor and font.
    const pinned = (items: Furniture[], startAt: number, part: InstanceType<typeof W_.Part>) => {
      const lines: Furniture[][] = [];
      for (const f of [...items].sort((a, b) => a.base - b.base)) { const g = lines.find((x) => Math.abs(x[0].base - f.base) < 3); if (g) g.push(f); else lines.push([f]); }
      let cursor = startAt; let out = '';
      for (const ln of lines) {
        const size = Math.max(...ln.map((f) => f.size)); const L = Math.max(size * 1.3, 6);
        const top = ln[0].base - BASE * L;
        const sorted = [...ln].sort((a, b) => a.cx - b.cx);
        out += W_.paragraph({
          align: 'left', widowControl: false, indent: { left: 0, right: 0 },
          spacing: { before: Math.max(0, Math.round((top - cursor) * PT)), after: 0, line: Math.round(L * PT), lineRule: 'exact' },
          tabs: sorted.map((f) => ({ type: 'center' as const, pos: Math.max(0, Math.round((f.cx - pg.m.left) * PT)) })),
        }, sorted.map((f) => W_.tabRun() + furnitureRuns(f, part)).join(''));
        cursor = top + L;
      }
      return { paras: out, end: cursor };
    };
    const headerPinned = pinned(pg.furniture.filter((f) => f.top), pg.m.header + (pg.pics.length ? 1 : 0), hdr);
    const footerItems = pg.furniture.filter((f) => !f.top);
    let footerPinned = { paras: '', end: 0 };
    let footerDist = pg.m.footer;
    if (footerItems.length) {
      // The footer's top is where its first line's box starts; Word then measures the footer distance from its bottom.
      const firstTop = Math.min(...footerItems.map((f) => f.base - BASE * Math.max(f.size * 1.3, 6)));
      footerPinned = pinned(footerItems, firstTop, ftr);
      footerDist = Math.max(4, pg.h - footerPinned.end);
    }
    const boxRuns = (pg.boxes ?? []).map((bx, i) => W_.anchoredTextBox(Math.max(1, bx.w * 96 / 72), Math.max(1, bx.h * 96 / 72), bx.x * EMU, bx.y * EMU, bx.rot, W_.paragraph({ align: 'left', widowControl: false, indent: { left: 0, right: 0 }, spacing: { before: 0, after: 0, line: Math.round(bx.line * PT), lineRule: 'exact' } }, bx.runs.map((r) => runFor(r, null, hdr)).join('')), 100 + pg.pics.length + i, 5000 + i)).join('');
    const headerXml = (picRuns || boxRuns ? hairline(0, picRuns + boxRuns + W_.textRun('', { size: 2 })) : '') + headerPinned.paras + blocksFor(pg.header, null, hdr);
    const footerXml = footerPinned.paras + blocksFor(pg.footer, null, ftr);
    // The pinned lines live in the page's header part with the decorations: positioned against the page, taking
    // no room, and keeping the body free to start like any page (LibreOffice mis-reads a section that opens
    // with frames before a table).
    const page: import('./docxwrite').PageSetup = { width: Math.round(pg.w * PT), height: Math.round(pg.h * PT), margin: { top: Math.round(pg.m.top * PT), bottom: Math.round(pg.m.bottom * PT), left: Math.round(pg.m.left * PT), right: Math.round(pg.m.right * PT), header: Math.round(pg.m.header * PT), footer: Math.round(footerDist * PT), gutter: 0 } };
    const header = { xml: headerXml || emptyPara, part: hdr };
    const footer = footerXml ? { xml: footerXml, part: ftr } : undefined;
    if (pg.vert) {
      // Vertical writing: the page's text flows top to bottom, columns right to left; the margins are where its
      // columns stand, the line pitch the distance between columns, a paragraph's first column set lower by its
      // indent.
      const v = pg.vert;
      const vpage: import('./docxwrite').PageSetup = { ...page, margin: { ...page.margin, top: Math.round(Math.max(18, v.top - v.size * 0.1) * PT), bottom: Math.round(Math.max(18, v.bottom - v.size * 0.05) * PT), left: Math.round(Math.max(18, v.left - v.pitch * 1.2) * PT), right: Math.round(Math.max(18, v.right - (v.pitch - v.size) / 2) * PT) }, textDirection: 'tbRl' };
      const kids = v.paras.map((pp) => W_.paragraph({
        widowControl: false,
        indent: pp.firstLine > v.size * 0.4 ? { firstLine: Math.round(pp.firstLine * PT) } : undefined,
        spacing: { before: 0, after: 0, line: Math.round(v.pitch * PT), lineRule: 'exact' },
        // (Two or three digits or letters stand across in their column, as the page sets them: tate-chu-yoko.)
      }, pp.runs.flatMap((r) => r.text.split(/([0-9A-Za-z]{1,3}(?![0-9A-Za-z]))/).filter(Boolean).map((t) => runFor({ ...r, text: /^[0-9A-Za-z]{1,3}$/.test(t) && /[0-9A-Za-z]/.test(t) ? `${t}` : t }, null, body))).join('')));
      const rest = blocksFor(pg.body, map, body) + blocksFor(flowNotes, null, body);
      return [{ type: 'nextPage', page: vpage, header, footer, children: kids.length || rest ? [...kids, rest] : [emptyPara] }];
    }
    if (pg.placed?.length) {
      // A designed page: each box of text is a frame at its own place on the page (paragraphs with the same
      // frame settings, one after another, are one frame in Word), over the page's drawing in the header.
      const kids: string[] = [];
      for (const b of pg.placed) {
        // (A hairline of plain text between two frames: LibreOffice otherwise lets a frame's paragraphs loose
        // into the page's own text when another frame follows them.)
        if (kids.length) kids.push(hairline(0));
        // (The slack goes on the side the text runs away from: a right-to-left box keeps its right edge.)
        const rtlBox = b.blocks.filter((k) => k.rtl).length * 2 >= b.blocks.length;
        const fw = b.w * 1.04 + 6;
        const frame: import('./docxwrite').Frame = { x: Math.round((rtlBox ? b.x + b.w + 2 - fw : b.x - 2) * PT), y: Math.round(b.y * PT), w: Math.round(fw * PT), h: Math.round(b.h * PT), rule: 'atLeast', anchorLock: true };
        for (const k of b.blocks) {
          // (A ruled table: floating at its place, as the frames are.)
          if (k.kind === 'grid') { kids.push(gridFor(k, null, body, { x: Math.round(b.x * PT), y: Math.round(b.y * PT) })); continue; }
          if (k.kind !== 'p') { kids.push(blocksFor([k], null, body)); continue; }
          kids.push(paraFor(k, null, body, { frame }));
        }
      }
      if (!kids.length) kids.push(emptyPara);
      return [{ type: 'nextPage', page, header, footer, children: kids }];
    }
    if (pg.regions?.length) {
      // A page in columns: one continuous section per region, each with its own column layout; the columns'
      // widths and gap follow the page, and a column break starts each column after the first.
      const textL = pg.m.left, textR = pg.w - pg.m.right;
      return pg.regions.map((rg, i): import('./docxwrite').Section => {
        const kids: string[] = [];
        rg.cols.forEach((bs, c) => {
          // The second column starts with a column break inside its first paragraph (a paragraph of its own
          // would add its height to the column).
          // (The page's notes, when Word footnotes, are referenced from the columns: see map.)
          const fm = map.size ? map : null;
          if (c > 0 && bs[0]?.kind === 'p') { kids.push(paraFor(bs[0], fm, body, { colBreak: true }), blocksFor(bs.slice(1), fm, body)); return; }
          // (A table first in its column: the break goes in the hairline paragraph that sets its space above.)
          if (c > 0 && bs[0]?.kind === 'grid') { const g = bs[0]; kids.push(hairline(Math.max(0, g.before - 1) * PT, W_.columnBreak()), gridFor(g, fm, body), blocksFor(bs.slice(1), fm, body)); return; }
          if (c > 0) kids.push(hairline(0, W_.columnBreak()));
          kids.push(blocksFor(bs, fm, body));
        });
        // (Notes that are not Word footnotes follow the page's last region, in the flow.)
        if (i === pg.regions!.length - 1 && flowNotes.length) kids.push(blocksFor(flowNotes, null, body));
        if (!kids.join('')) kids.push(emptyPara);
        let columns: import('./docxwrite').Columns | undefined;
        if (rg.cols.length > 1) {
          // Visual left-to-right column boxes, then in the section's reading order.
          const boxes = rg.edges.map(([a, b]) => [Math.max(textL, a - 3), Math.min(textR, b + 3)] as [number, number]).sort((x, y) => x[0] - y[0]);
          const widths = [boxes[0][1] - textL, textR - boxes[1][0]];
          const space = Math.max(6, textR - textL - widths[0] - widths[1]);
          const rtlCols = rg.edges[0][0] > rg.edges[1][0];
          const ordered = rtlCols ? [widths[1], widths[0]] : widths;
          columns = { space: Math.round(space * PT), widths: ordered.map((w) => Math.round(w * PT)) };
        }
        return { type: i === 0 ? 'nextPage' : 'continuous', page, columns, ...(i === 0 ? { header, footer } : {}), children: kids };
      });
    }
    // Text far below the rest (a short page, its notes or a closing line at the foot): a frame at its own place
    // on the page — the gap above it no longer a fixed space in the flow, which a line the reader's font wraps
    // one word sooner would push, notes and all, onto a page of their own.
    const all = [...pg.body, ...flowNotes];
    let foot = -1;
    // (Not in a document to edit: there the text flows, and Word finds its pages.)
    for (let i = all.length - 1; i > 0 && !p2d.edit; i--) {
      const b = all[i];
      if (b.kind !== 'p') break;
      if (b.before > 4 * b.pitch && b.base0 !== undefined && b.base0 < pg.h * 0.45) { foot = i; break; }
    }
    if (foot > 0) {
      const b0 = all[foot] as Para;
      const at = pg.h - b0.base0! - BASE * b0.pitch;
      const frame: import('./docxwrite').Frame = { x: Math.round(pg.m.left * PT), y: Math.round(at * PT), w: Math.round((pg.w - pg.m.left - pg.m.right) * PT), h: Math.round(b0.pitch * PT), rule: 'atLeast', anchorLock: true };
      const nBody = pg.body.length;
      const above = all.slice(0, foot);
      const aboveXml = blocksFor(above.slice(0, Math.min(foot, nBody)), map, body) + blocksFor(above.slice(nBody), null, body);
      const footXml = all.slice(foot).map((b, i) => paraFor(i === 0 ? { ...(b as Para), before: 0 } : (b as Para), foot + i < nBody ? map : null, body, { frame })).join('');
      // (A hairline between the text and the frame: LibreOffice otherwise takes the frame's paragraphs into the text.)
      return [{ type: 'nextPage', page, header, footer, children: [(aboveXml || emptyPara) + hairline(0) + footXml] }];
    }
    const children = blocksFor(pg.body, map, body) + blocksFor(flowNotes, null, body);
    return [{ type: 'nextPage', page, header, footer, children: [children || emptyPara] }];
  };
  // The document's body is written page by page (each page's sections turned to bytes at once — see
  // DocxWriter.addSection — with the finishing pass's changes to them made there), and each page let go once
  // written: the book is never held twice, as pages and as text.
  const eaSeq = { n: 1 };
  writer.fixBody = (xml) => fixBodyXml(xml, rtlDoc, eaSeq);
  // Each page with its number in a PAGE field starts its section at that number, in the page's digits: Word shows
  // the number the page shows, whatever came before (a page the reader's fonts spill onto a second one included).
  // (Not on a page's later, continuous sections: a number set there would count the page again.)
  const nums = pages.map((p) => p.furniture.find((f) => f.num)?.num);
  let pi = -1, slice = performance.now();
  for (let i = 0; i < pages.length; i++) {
    const cont = !!pages[i].cont;
    for (const [k, s] of sectionsOf(pages[i]).entries()) {
      if (s.type === 'nextPage' || (cont && k === 0)) pi++;
      // (A page a paragraph runs onto, in a document to edit: no break before it — Word breaks the page where its
      // text fills it.)
      if (cont && k === 0) s.type = 'continuous';
      // (A page a link lands on: its bookmark at its first paragraph.)
      const mark = pages[i].mark;
      if (mark && k === 0 && s.children.length) { const id = 9000 + i; s.children[0] = s.children[0].replace(/^(<w:p>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?)/, `$1<w:bookmarkStart w:id="${id}" w:name="${mark}"/><w:bookmarkEnd w:id="${id}"/>`); }
      const num = nums[pi];
      if (num) s.pageNumbers = { fmt: num.fmt, ...(s.type === 'nextPage' ? { start: num.value } : {}) };
      writer.addSection(s);
    }
    (pages as (PageModel | null)[])[i] = null;
    // (Every 30 ms of work the screen gets its turn: a page with many runs takes several.)
    if (performance.now() - slice > 30) { progress('build', 89 + Math.round((i / pages.length) * 3)); await yieldNow(); slice = performance.now(); }
  }
  pages = [];

  memMark('sections');
  // Embed the PDF's own fonts — each face (regular, bold, …) under its family — where they can draw
  // every character used with them in that style.
  type Face = 'Regular' | 'Bold' | 'Italic' | 'BoldItalic';
  const faceOf = (bold: boolean, italic: boolean): Face => (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular');
  const faces = new Map<string, Map<Face, Uint8Array>>();
  const best = new Map<string, { score: number }>();
  // (A copy of a face whose glyphs no text of the document used — a subset met only for its spaces — does not
  // compete with the copy rebuilt or carried for the text: an equal score let it in, missing what the text set.)
  const usedFace = new Set([...fonts.values()].filter((f) => f.raw && (f.uses || f.rebuilt)).map((f) => `${f.family}|${faceOf(f.bold && (f.weight ?? (f.bold ? 700 : 400)) >= 600, f.italic)}`));
  for (const f of fonts.values()) {
    if (!f.raw) continue;
    const face = faceOf(f.bold && (f.weight ?? (f.bold ? 700 : 400)) >= 600, f.italic);
    if (!f.uses && !f.rebuilt && usedFace.has(`${f.family}|${face}`)) continue;
    // (A font carried as the PDF has it whose maker allows no editable embedding — "preview & print" or
    // restricted — is not put in an editable document: Word may open such a file read-only, and LibreOffice
    // leaves the font out. Its runs keep its name, declared for Word to substitute.)
    if (!f.rebuilt && !embeddable(f.raw)) continue;
    const used = usedChars.get(`${f.family}|${face}`); if (!used?.size) continue;
    // (Its symbol table too: codes kept as drawn — a sign font's — are looked up there.)
    const cov = new Set([...(f.cov ??= cmapCoverage(f.raw)), ...(f.winCov ??= cmapCoverage(f.raw, true))]);
    let ok = 0, total = 0;
    for (const c of used) { if (c <= 0x20 || (c >= 0x200b && c <= 0x200f) || c === 0x2060 || c === 0xfeff || COMBINING.test(String.fromCodePoint(c))) continue; total++; if (cov.has(c)) ok++; }
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D font', f.family, face, ok, '/', total, [...used].filter((c) => c > 0x20 && !COMBINING.test(String.fromCodePoint(c)) && !cov.has(c)).map((c) => c.toString(16)).join(' '));
    if (!total || ok / total < 0.97) continue; // a missing character or two falls back in Word
    // (Several fonts of one family and style — subsets of it — compete: the one that covers most, a rebuilt
    // one on a tie.)
    const score = ok / total + (f.rebuilt ? 0.001 : 0);
    const k = `${f.family}|${face}`; if ((best.get(k)?.score ?? -1) >= score) continue;
    best.set(k, { score });
    let m = faces.get(f.family); if (!m) faces.set(f.family, m = new Map());
    m.set(face, f.raw);
  }
  // What the font table says of each font the document names, for Word to find a stand-in when it has not got
  // it (or cannot load the copy carried): taken from the PDF's own copy of the font when there is one, else
  // from what the text set in it is (Arabic, Latin), with a common font of that kind as its other name.
  const KNOWN: Record<string, import('./docxwrite').FontDecl> = {
    'Times New Roman': { panose: '02020603050405020304', family: 'roman', sig: { usb: [0xe0002eff, 0xc000785b, 0x00000009, 0], csb: [0x000001ff, 0] } },
    'Arial': { panose: '020B0604020202020204', family: 'swiss', sig: { usb: [0xe0002eff, 0xc000785b, 0x00000009, 0], csb: [0x000001ff, 0] } },
    'Traditional Arabic': { charset: 'B2', family: 'roman', sig: { usb: [0x00002003, 0x80000000, 0x00000008, 0], csb: [0x00000041, 0] } },
    'Courier New': { panose: '02070309020205020404', family: 'modern', pitch: 'fixed', sig: { usb: [0xe0002eff, 0xc0007843, 0x00000009, 0], csb: [0x000001ff, 0] } },
    'Microsoft YaHei': { panose: '020B0503020204020204', charset: '86', family: 'swiss', sig: { usb: [0x80000287, 0x2acf3c50, 0x00000016, 0], csb: [0x0004001f, 0] } },
    'SimSun': { panose: '02010600030101010101', charset: '86', family: 'auto', sig: { usb: [0x00000003, 0x288f0000, 0x00000016, 0], csb: [0x00040001, 0] } },
    'MS Gothic': { panose: '020B0609070205080204', charset: '80', family: 'modern', pitch: 'fixed' },
    'MS Mincho': { panose: '02020609040205080304', charset: '80', family: 'modern', pitch: 'fixed' },
  };
  const declOf = (name: string, data?: Uint8Array): import('./docxwrite').FontDecl => {
    if (KNOWN[name]) return KNOWN[name];
    const info = [...fonts.values()].find((f) => f.family === name && (f.raw || f.src)) ?? [...fonts.values()].find((f) => f.family === name);
    const raw = data ?? info?.raw;
    const os2 = raw ? readOs2(raw) : null;
    const chars = [...usedChars.entries()].filter(([k]) => k.startsWith(`${name}|`)).flatMap(([, s]) => [...s]);
    const arabic = chars.some((c) => (c >= 0x600 && c <= 0x6ff) || (c >= 0x750 && c <= 0x77f) || (c >= 0xfb50 && c <= 0xfeff));
    const cjk = chars.some((c) => (c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef));
    // (A font whose only map is the symbol one draws signs under its codes: Word's symbol character set.)
    const symbol = !!raw && cmapCoverage(raw).size === 0 && cmapCoverage(raw, true).size > 0;
    const p = os2?.panose && os2.panose !== '0'.repeat(20) ? os2.panose : undefined;
    const pb = p ? p.match(/../g)!.map((h) => parseInt(h, 16)) : null;
    // (An Arabic font's PANOSE often says nothing true — old makers left "monospaced" in it.)
    const mono = !!info?.mono || (!!pb && pb[3] === 9 && !arabic);
    const family: import('./docxwrite').FontDecl['family'] = symbol ? 'decorative' : mono ? 'modern' : pb?.[0] === 3 ? 'script' : pb?.[0] === 4 || pb?.[0] === 5 ? 'decorative' : pb?.[0] === 2 ? (pb[1] >= 11 && pb[1] <= 13 ? 'swiss' : 'roman') : info?.serif ? 'roman' : 'auto';
    const sig = os2 && (os2.usb.some((x) => x) || os2.csb.some((x) => x)) ? { usb: os2.usb, csb: os2.csb } : { usb: [(arabic && !chars.some((c) => c < 0x600) ? 0 : 1) | (arabic ? 0x2000 : 0), 0, 0, 0], csb: [(arabic && !chars.some((c) => c < 0x600) ? 0 : 1) | (arabic ? 0x40 : 0) | (symbol ? 0x80000000 : 0), 0] };
    const sub = fontSubstitute(name, info);
    const sansLike = /kufi|sans|arial|tahoma|frutiger|gess|helvet|verdana|segoe|calibri/i.test(name) || family === 'swiss';
    return {
      panose: p, family, pitch: mono ? 'fixed' : 'variable',
      charset: symbol ? '02' : arabic || (os2 && os2.csb[0] & 0x40 && !(os2.csb[0] & 1)) ? 'B2' : cjk ? (/^(MS |Yu |Meiryo)/.test(name) ? '80' : '86') : '00',
      sig,
      alt: symbol || COMMON_FONTS.test(name) ? undefined : arabic ? (sansLike ? 'Arial' : 'Traditional Arabic') : cjk ? sub?.ea : sub?.latin,
    };
  };
  const embedded: import('./docxwrite').EmbeddedFont[] = [];
  const extraFaces: { family: string; face: Face; data: Uint8Array }[] = [];
  const sigs = new Map<string, Os2>();
  for (const [family, m] of faces) {
    const arabic = [...(usedChars.get(`${family}|Regular`) ?? []), ...(usedChars.get(`${family}|Bold`) ?? [])].some((c) => c >= 0x600 && c <= 0x6ff);
    const first = (m.get('Regular') ?? m.values().next().value)!;
    const firstFace = [...m.entries()].find(([, v]) => v === first)![0];
    // (Every face named after the family the runs ask for, in all its records: see renamedFont.)
    const sub = (f: Face) => (f === 'BoldItalic' ? 'Bold Italic' : f);
    embedded.push({ name: family, data: renamedFont(first, family, sub(firstFace)) ?? first, arabic, ...declOf(family, first), alt: undefined });
    for (const [face, data] of m) if (data !== first) extraFaces.push({ family, face, data: renamedFont(data, family, sub(face)) ?? data });
    if (firstFace !== 'Regular') extraFaces.push({ family, face: firstFace, data: new Uint8Array(0) }); // marks: move embedRegular to this face
    const os2 = readOs2(first); if (os2) sigs.set(family, os2);
  }

  progress('build', 92);
  if (TT) TT.build = performance.now() - tb;
  // Fonts that are neither carried in the file nor common: named after a common font of the same kind.
  const subs = new Map<string, { latin: string; cs: string; ea: string }>();
  for (const key of usedChars.keys()) {
    const family = key.split('|')[0];
    if (faces.has(family) || subs.has(family)) continue;
    // Arabic book faces keep their name: readers of such books mostly have them, and no common font
    // looks like a given naskh.
    const arabicUse = [...usedChars.entries()].some(([k, set]) => k.startsWith(`${family}|`) && [...set].some((c) => (c >= 0x600 && c <= 0x6ff) || (c >= 0x750 && c <= 0x77f) || (c >= 0xfb50 && c <= 0xfeff)));
    if (arabicUse) continue;
    const info = [...fonts.values()].find((f) => f.family === family);
    const sub = fontSubstitute(family, info);
    if (sub) subs.set(family, sub);
  }
  // (The body's line spacing, now the fonts it carries are known: see autoLine.)
  if (lineFix.length) {
    const fac = new Map<string, number>();
    const factorOf = (font: string) => { let f = fac.get(font); if (f === undefined) { const m = faces.get(font); const bytes = m ? m.get('Regular') ?? m.values().next().value : undefined; const own = bytes ? lineFactor(bytes) : null;
      // (A carried font whose metrics are its glyphs' extremes — some PDFs' CJK subsets say nearly three lines — is not
      // what a word processor sets it at: the name's own line, else 1.2.)
      f = own && own <= 1.6 ? own : NAMED_LINE[font] || (own ? Math.min(own, 1.2) : 1.2); fac.set(font, f); } return f; };
    await writer.mapBody((xml) => xml.replace(/w:line="\u00a7(\d+)\u00a7"/g, (_m, i: string) => { const x = lineFix[+i]; return `w:line="${Math.max(120, Math.min(720, Math.round(240 * x.pitch / (x.size * factorOf(x.font)))))}"`; }), yieldNow);
  }
  const tc0 = performance.now();
  const zip = await writer.pack(embedded);
  memMark('pack');
  await finishDocx(zip as unknown as ZipLike, rtlDoc, extraFaces, sigs, subs, declOf, writer, yieldNow);
  if (TT) TT.compile = performance.now() - tc0;
  memMark('finish');
  progress('build', 95);
  const { zipOut } = await import('./ziputil');
  const blob = await zipOut(zip as unknown as ZipLike, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', undefined, new Map([['word/document.xml', writer.documentBlob()]]));
  if (TT) TT.pack = performance.now() - tb - TT.build;
  pngSeen.clear();
  memMark('zip');
  progress('build', 100);
  return blob;
}


/** The finishing pass's changes to the document's own XML, each local to a run or to a section's properties (so
 *  made on the body piece by piece as it is written, in order — `ea` numbers the vertical runs on): characters
 *  set upright in vertical text, the notes' numbering and the sections' direction, raised runs in half-points. */
function fixBodyXml(xml: string, rtl: boolean, ea: { n: number }): string {
  const fixed = (!xml.includes('\uE000') ? xml : xml.replace(/<w:r>(<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*)<\/w:rPr>(<w:t[^>]*>)\uE000([^<]*)<\/w:t>/g, (_m, pr: string, t: string, txt: string) => `<w:r>${pr}<w:eastAsianLayout w:id="${ea.n++}" w:vert="1" w:vertCompress="1"/></w:rPr>${t}${txt}</w:t>`))
    // (Each where the schema has it — the notes' settings after the header and footer references, the
    // direction just before the grid — or Word may call the file damaged.)
    .replace(/<w:sectPr>((?:<w:(?:header|footer)Reference [^>]*\/>)*)/g, (_m, refs: string) => `<w:sectPr>${refs}<w:footnotePr><w:numRestart w:val="${notesRestart ? 'eachPage' : 'continuous'}"/></w:footnotePr>`)
    .replace(/(<w:sectPr[^>]*>[\s\S]*?)(<w:docGrid [^>]*\/>)?(<\/w:sectPr>)/g, (m, a: string, g: string | undefined, b: string) => (rtl && !a.includes('<w:bidi') ? `${a}<w:bidi/>${g ?? ''}${b}` : m));
  return fixed.includes('<w:position w:val="') ? positionsInHalfPoints(fixed) : fixed;
}
/** A raised run's position in half-points (docx wrote "4pt", which LibreOffice and older Words ignore). */
const positionsInHalfPoints = (xml: string): string => xml.replace(/<w:position w:val="(-?[\d.]+)pt"\/>/g, (_m, v: string) => `<w:position w:val="${Math.round(+v * 2)}"/>`);

/** Word details the library has no option for: right-to-left sections, footnote numbers restart on each page. */
async function finishDocx(zip: ZipLike, rtl: boolean, extraFaces: { family: string; face: string; data: Uint8Array }[] = [], sigs = new Map<string, Os2>(), subs = new Map<string, { latin: string; cs: string; ea: string }>(), declOf?: (name: string) => import('./docxwrite').FontDecl, writer?: { mapBody(fix: (xml: string) => string, pause?: () => Promise<void>): Promise<void> }, pause?: () => Promise<void>): Promise<void> {
  // (The document's own XML — word/document.xml, a placeholder in the zip — was written by the writer piece by
  // piece and changed as it was written (fixBodyXml); what is done to it here is done to its pieces.)
  const DOC = 'word/document.xml';
  // Fonts: the other faces of each embedded family (bold, …), the fonts' own signatures, and the switch that
  // tells Word the document carries its fonts.
  const ft = zip.file('word/fontTable.xml');
  if (ft) {
    let table = await ft.async('string');
    let rels = (await zip.file('word/_rels/fontTable.xml.rels')?.async('string')) ?? '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    let n = 100;
    const hex8 = (v: number) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
    for (const [family, o] of sigs) {
      const esc = family.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
      table = table.replace(new RegExp(`(<w:font w:name="${esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">[\\s\\S]*?)<w:sig [^>]*/>`), `$1<w:sig w:usb0="${hex8(o.usb[0])}" w:usb1="${hex8(o.usb[1])}" w:usb2="${hex8(o.usb[2])}" w:usb3="${hex8(o.usb[3])}" w:csb0="${hex8(o.csb[0])}" w:csb1="${hex8(o.csb[1])}"/>`);
    }
    for (const { family, face, data } of extraFaces) {
      const esc = family.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(<w:font w:name="${esc}">[\\s\\S]*?)(</w:font>)`);
      if (!data.length) { table = table.replace(re, (m) => m.replace('<w:embedRegular ', `<w:embed${face} `)); continue; }
      const guid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      const key = `{${guid.slice(0, 8)}-${guid.slice(8, 12)}-${guid.slice(12, 16)}-${guid.slice(16, 20)}-${guid.slice(20)}}`;
      const kb = (guid.match(/../g) ?? []).map((h) => parseInt(h, 16)).reverse();
      const ob = (await import('./docxwrite')).editableEmbedding(data.slice()); for (let i = 0; i < 32 && i < ob.length; i++) ob[i] ^= kb[i % 16];
      const id = `rIdK${n++}`;
      zip.file(`word/fonts/kr-${id}.odttf`, ob);
      rels = rels.replace('</Relationships>', `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/kr-${id}.odttf"/></Relationships>`);
      table = table.replace(re, `$1<w:embed${face} r:id="${id}" w:fontKey="${key}"/>$2`);
    }
    zip.file('word/fontTable.xml', table);
    zip.file('word/_rels/fontTable.xml.rels', rels);
  }
  if (!writer) { const docXml = await zip.file(DOC)!.async('string'); zip.file(DOC, fixBodyXml(docXml, rtl, { n: 1 })); }
  // Full-width punctuation keeps its full width (as the PDF sets it): no squeezing that would fit more
  // characters into a line or column than the page has.
  const st = zip.file('word/settings.xml');
  if (st) { const x = await st.async('string'); if (!x.includes('characterSpacingControl')) zip.file('word/settings.xml', x.replace(/(<w:compat>)/, '<w:characterSpacingControl w:val="doNotCompress"/>$1')); }
  // A raised run's position in half-points (docx writes "4pt", which LibreOffice and older Words ignore).
  for (const name of Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(n))) {
    if (writer && name === DOC) continue; // (done as it was written: fixBodyXml)
    const xml = await zip.file(name)!.async('string');
    if (xml.includes('<w:position w:val="')) zip.file(name, positionsInHalfPoints(xml));
  }
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const bySlot = new Map([...subs].map(([k, v]) => [esc(k), v]));
  const subbed = (xml: string) => xml.replace(/w:(ascii|hAnsi|cs|eastAsia)="([^"]*)"/g, (m, slot: string, v: string) => {
    const sub = bySlot.get(v); if (!sub) return m;
    return `w:${slot}="${slot === 'cs' ? sub.cs : slot === 'eastAsia' ? sub.ea : sub.latin}"`;
  });
  // (The body's pieces read once here: the fonts' stand-ins put in, and the font names its runs give noted, in
  // order, for the font table below.)
  const bodyNames: string[] = [];
  if (writer) {
    const noted = new Set<string>();
    await writer.mapBody((xml) => {
      const out = subs.size ? subbed(xml) : xml;
      for (const m of out.matchAll(/w:(?:ascii|hAnsi|cs|eastAsia)="([^"]*)"/g)) if (!noted.has(m[1])) { noted.add(m[1]); bodyNames.push(m[1]); }
      return out;
    }, pause);
  }
  if (subs.size) {
    for (const name of Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(n))) {
      if (writer && name === DOC) continue;
      const xml = await zip.file(name)!.async('string');
      zip.file(name, subbed(xml));
    }
  }
  // Every font a run, a paragraph mark or the defaults name is in the font table — the ones the document does not
  // carry too, with what Word needs to pick a stand-in of the same kind (unlisted, Word substitutes blindly:
  // "Droid Arabic Naskh", "louts shamy" and the default "Traditional Arabic" were named and never declared).
  if (ft && declOf) {
    const unesc = (t: string) => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    let table = await zip.file('word/fontTable.xml')!.async('string');
    const have = new Set([...table.matchAll(/<w:font w:name="([^"]*)"/g)].map((m) => unesc(m[1])));
    const named: string[] = [];
    for (const name of Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes|styles)\.xml$/.test(n))) {
      const values = writer && name === DOC ? bodyNames : Array.from((await zip.file(name)!.async('string')).matchAll(/w:(?:ascii|hAnsi|cs|eastAsia)="([^"]*)"/g), (m) => m[1]);
      for (const raw of values) { const v = unesc(raw); if (v && !have.has(v)) { have.add(v); named.push(v); } }
    }
    if (named.length) {
      const { fontEntry } = await import('./docxwrite');
      table = table.replace('</w:fonts>', `${named.map((n) => fontEntry(n, declOf(n))).join('')}</w:fonts>`);
      zip.file('word/fontTable.xml', table);
    }
  }
  // The page already shows the book's own rule above the notes (in the background): Word's separator goes.
  const fn = zip.file('word/footnotes.xml');
  // (The page's look has no separator line over its notes; a document to edit keeps Word's.)
  if (fn && !p2d.edit) zip.file('word/footnotes.xml', (await fn.async('string')).replace(/<w:separator\/>|<w:continuationSeparator\/>/g, ''));
  const settings = zip.file('word/settings.xml');
  if (settings) {
    let s = await settings.async('string');
    if (!s.includes('w:footnotePr')) s = s.replace(/<w:settings([^>]*)>/, (m) => `${m}<w:footnotePr><w:numRestart w:val="${notesRestart ? 'eachPage' : 'continuous'}"/></w:footnotePr>`);
    if (ft && !s.includes('w:embedTrueTypeFonts')) s = s.replace(/<w:settings([^>]*)>/, (m) => `${m}<w:embedTrueTypeFonts/>`);
    zip.file('word/settings.xml', s);
  }
}
