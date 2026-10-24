// PDF → DOCX that keeps the page: every PDF page becomes a Word section of the same size and
// margins; its decorations (frames, ornaments, rules, pictures) are drawn once without text and laid
// behind it; the text is real, editable Word text — paragraphs with their alignment, indents,
// spacing and line pitch, runs with their font, size, weight and colour, two-column verse as a
// borderless table, the running head in the page header, and footnotes as Word footnotes.
// Arabic is right-to-left throughout (bidi paragraphs and tables, complex-script fonts and sizes).
import { buildFont, type GlyphUse, type Use, type GlyphSource } from './fontfix';
import { readSfnt, cmapGlyphs, glyphReader, verticalMetrics } from './fontbuild';
import { loadPdfjs } from './formats/pdf';
import { cleanPdfText, isRtlText, joinLine, COMBINING, attachMarks, logicalNeutral, fixLoneBrackets, dropBuriedSpaces, balanceBrackets } from './pdftext';
import type { Book } from './db';
import type { Progress } from './convert';

type PdfJs = Awaited<ReturnType<typeof loadPdfjs>>;
type FontInfo = { family: string; bold: boolean; italic: boolean; raw?: Uint8Array; noUnicode?: boolean; symbolic?: boolean; cov?: Set<number>; weight?: number; serif?: boolean; mono?: boolean; rebuilt?: boolean; spaceCode?: number; src?: { data: Uint8Array; toFontChar: Record<string, number> }; legacy?: boolean; uses?: number; spaceW?: number; gaps?: number[]; wordFont?: boolean };
/** How the document uses its embedded fonts' glyphs: runs of glyphs along a line, cut where a word ends (each
 *  glyph tagged with its PDF font — a legacy Arabic font spreads one word over several). */
type UseStore = { seqs: ([string, GlyphUse][] & { rtl?: boolean })[]; seen: Map<string, Set<number>> };
const USE_CAP = 150000; // glyph uses kept per font (later only for glyphs not seen yet)
type Piece = { text: string; l: number; r: number; y: number; h: number; font: string; color: string; bold: boolean; sup?: boolean; art?: boolean; codes?: GlyphUse[]; conn?: boolean; ordered?: boolean; keep?: boolean; raw?: boolean; pic?: { png: Uint8Array; w: number; h: number; drop: number } };
/** OS/2 of a TrueType font: weight, italic, and the Unicode/code-page ranges Word reads as its signature. */
type Os2 = { weight: number; italic: boolean; bold: boolean; usb: number[]; csb: number[] };
type Line = { pieces: Piece[]; base: number; size: number; l: number; r: number; rtl: boolean; spacer?: number; grid?: GridSpec };
/** A page area in PDF coordinates (y up). */
type Box = { l: number; r: number; top: number; bottom: number };
type Run = { text: string; font: string; size: number; bold: boolean; italic: boolean; color: string; rtl: boolean; sup: boolean; note?: number; br?: boolean; tab?: number; raise?: number; kText?: string; cs?: number; spacing?: number; art?: Piece };
type Para = { kind: 'p'; runs: Run[]; align: 'start' | 'end' | 'center' | 'both'; kashida?: boolean; rtl: boolean; indStart: number; indEnd: number; firstLine: number; before: number; pitch: number; size: number; tabs?: number[] };
type Verse = { kind: 'verse'; rows: Run[][][]; rtl: boolean; before: number; pitch: number; size: number; width: number; indStart: number; midW: number; gap: number };
/** A ruled table: its columns (page x, left to right) and rows (page y, top down), and per row its cells
 *  left to right — each spanning `span` columns, `cont` when it carries on the cell above (no rule between). */
type GridCell = { c0: number; span: number; cont?: boolean; lines: Piece[][]; fill?: string };
type GridSpec = { xs: number[]; ys: number[]; rows: GridCell[][]; rule: number };
type Grid = { kind: 'grid'; rows: Run[][][]; cells: { span: number; vmerge?: 'restart' | 'continue'; align: Para['align']; vcenter: boolean; pitch: number }[][]; spec: GridSpec; colW: number[]; rowH: number[]; rtl: boolean; before: number; indStart: number; size: number; pitch: number };
type Block = Para | Verse | Grid;
type Note = { num: number; paras: Block[] };
type Furniture = { runs: Run[]; cx: number; base: number; size: number; top: boolean };
/** Part of a page: full width (one column) or set in columns (blocks per column in reading order, column edges in page x). */
type Region = { cols: Block[][]; edges: [number, number][] };
type PageModel = { w: number; h: number; pics: Pic[]; furniture: Furniture[]; regions?: Region[]; header: Block[]; footer: Block[]; body: Block[]; notes: Note[]; notesRaw: Block[]; notesBox: { top: number; bottom: number; l: number; r: number } | null; bodyBottom: number; m: { top: number; bottom: number; left: number; right: number; header: number; footer: number } };

const PT = 20; // twips per point
// In a line with exact spacing Word puts the baseline about 4/5 of the line height below the line's top.
const BASE = 0.8;
// Word footnotes reflow nicely when the text is edited, but Word lays out the footnote area its own way;
// keeping the notes in the page's flow reproduces the page exactly. Fidelity first.
const REAL_FOOTNOTES = false;
const EMU = 12700; // EMU per point
const DIGITS = /^[\s(（[]*([0-9٠-٩۰-۹]+)[\s)）\]]*$/;
const toInt = (s: string) => parseInt(s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)), 10);
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
    for (let i = 0; i < count; i++) {
      const r = nt + 6 + i * 12;
      const pid = dv.getUint16(r), eid = dv.getUint16(r + 2), lang = dv.getUint16(r + 4), id = dv.getUint16(r + 6), len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
      if (id !== 1 && id !== 16) continue;
      let str = '';
      if (pid === 3 || pid === 0) { for (let k = 0; k < len; k += 2) str += String.fromCharCode(dv.getUint16(strings + off + k)); if (pid === 3 && eid === 0) continue; }
      else if (pid === 1) { for (let k = 0; k < len; k++) str += String.fromCharCode(bytes[strings + off + k]); }
      // Prefer the English (US) name.
      if (str && (found[id] === undefined || (pid === 3 && lang === 0x409))) found[id] = str.trim();
    }
    const name = found[1] || found[16]; // Word selects by the legacy family name
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
    return { weight: dv.getUint16(o + 4), italic: !!(sel & 1), bold: !!(sel & 32), usb: [42, 46, 50, 54].map((k) => dv.getUint32(o + k)), csb: version >= 1 ? [dv.getUint32(o + 78), dv.getUint32(o + 82)] : [1, 0] };
  } catch { return null; }
}

/** Code points a TrueType font's cmap covers (to decide whether embedding it can render the text). */
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

function cmapCoverage(bytes: Uint8Array): Set<number> {
  const out = new Set<number>();
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint16(4); let cm = -1;
    for (let i = 0; i < n; i++) { const r = 12 + i * 16; if (String.fromCharCode(...bytes.subarray(r, r + 4)) === 'cmap') cm = dv.getUint32(r + 8); }
    if (cm < 0) return out;
    for (let i = 0, nn = dv.getUint16(cm + 2); i < nn; i++) {
      const p = dv.getUint16(cm + 4 + i * 8), e = dv.getUint16(cm + 6 + i * 8), s = cm + dv.getUint32(cm + 8 + i * 8);
      if (!(p === 3 && (e === 1 || e === 10) || p === 0)) continue;
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

type Pic = { png: Uint8Array; x: number; y: number; w: number; h: number };
/** The page drawn without its text, cut into the pieces that carry ink (header ornament, frame, rules,
 *  pictures) — each cropped tight, so pieces that repeat from page to page are stored once. */
async function renderGraphics(page: import('pdfjs-dist').PDFPageProxy, scale: number, keepFonts: Set<string>, grids: GridSpec[] = [], arts: Piece[] = []): Promise<Pic[]> {
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas') as HTMLCanvasElement & { krNoText?: boolean; krKeepFonts?: Set<string> };
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); c.krNoText = true; c.krKeepFonts = keepFonts;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvas: c, canvasContext: ctx, viewport: vp, background: 'rgba(255,255,255,1)' } as Parameters<typeof page.render>[0]).promise;
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
      const cols = pts.map(([x, y]) => { const v = ctx.getImageData(Math.max(0, Math.min(W - 1, px(x))), Math.max(0, Math.min(H - 1, py(y))), 1, 1).data; return [v[0], v[1], v[2]]; });
      const hex = (v: number[]) => v.map((n) => n.toString(16).padStart(2, '0')).join('');
      const same = cols.filter((v) => Math.abs(v[0] - cols[0][0]) + Math.abs(v[1] - cols[0][1]) + Math.abs(v[2] - cols[0][2]) < 24).length;
      if (same >= 3 && cols[0].some((n) => n < 245)) cell.fill = hex(cols[0]);
    }));
    ctx.fillStyle = '#fff';
    const x0 = px(g.xs[0]) - Math.ceil(2 * scale), x1 = px(g.xs[g.xs.length - 1]) + Math.ceil(2 * scale);
    const y0 = py(g.ys[0]) - Math.ceil(2 * scale), y1 = py(g.ys[g.ys.length - 1]) + Math.ceil(2 * scale);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  // Text kept as drawn goes into its line as a picture of its own: cut out here, tight to its ink.
  for (const p of arts) {
    const x0 = Math.max(0, Math.floor((p.l - p.h * 0.15) * scale)), x1 = Math.min(W, Math.ceil((p.r + p.h * 0.15) * scale));
    const y0 = Math.max(0, Math.floor((ph - (p.y + p.h * 1.15)) * scale)), y1 = Math.min(H, Math.ceil((ph - (p.y - p.h * 0.5)) * scale));
    if (x1 <= x0 || y1 <= y0) continue;
    const px = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data; const w = x1 - x0;
    let a = Infinity, b = -1, t = Infinity, u = -1;
    for (let i = 0, k = 0; i < px.length; i += 4, k++) if (!(px[i] > 250 && px[i + 1] > 250 && px[i + 2] > 250)) { const x = k % w, y = (k / w) | 0; if (x < a) a = x; if (x > b) b = x; if (y < t) t = y; if (y > u) u = y; }
    if (b < 0) continue;
    const cw = b - a + 1, chh = u - t + 1;
    const cc = document.createElement('canvas'); cc.width = cw; cc.height = chh;
    const cx = cc.getContext('2d')!; cx.drawImage(c, x0 + a, y0 + t, cw, chh, 0, 0, cw, chh);
    const im = cx.getImageData(0, 0, cw, chh); for (let i = 0; i < im.data.length; i += 4) if (im.data[i] > 250 && im.data[i + 1] > 250 && im.data[i + 2] > 250) im.data[i + 3] = 0; cx.putImageData(im, 0, 0);
    p.pic = { png: await canvasPng(cc), w: cw / scale, h: chh / scale, drop: ph - (y0 + u + 1) / scale - p.y };
    ctx.fillStyle = '#fff'; ctx.fillRect(x0 + a, y0 + t, cw, chh);
  }
  const img = ctx.getImageData(0, 0, W, H); const d = img.data;
  const ink = new Uint8Array(W * H);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) d[i + 3] = 0; // white → transparent
    else ink[k] = 1;
  }
  ctx.putImageData(img, 0, 0);
  const rowInk = (y: number, x0: number, x1: number) => { for (let x = x0; x < x1; x++) if (ink[y * W + x]) return true; return false; };
  const colInk = (x: number, y0: number, y1: number) => { for (let y = y0; y < y1; y++) if (ink[y * W + x]) return true; return false; };
  // Bands of rows with ink (small gaps bridged), then clusters of columns within each band.
  const boxes: [number, number, number, number][] = [];
  const gapY = Math.round(6 * scale), gapX = Math.round(24 * scale);
  for (let y = 0; y < H;) {
    if (!rowInk(y, 0, W)) { y++; continue; }
    let y1 = y, blank = 0;
    for (let yy = y; yy < H; yy++) { if (rowInk(yy, 0, W)) { y1 = yy; blank = 0; } else if (++blank > gapY) break; }
    for (let x = 0; x < W;) {
      if (!colInk(x, y, y1 + 1)) { x++; continue; }
      let x1 = x, b2 = 0;
      for (let xx = x; xx < W; xx++) { if (colInk(xx, y, y1 + 1)) { x1 = xx; b2 = 0; } else if (++b2 > gapX) break; }
      boxes.push([x, y, x1 + 1, y1 + 1]);
      x = x1 + 1;
    }
    y = y1 + 1;
  }
  if (!boxes.length) return [];
  // A page that is mostly picture (a cover) stays one image.
  const area = boxes.reduce((a, [x0, y0, x1, y1]) => a + (x1 - x0) * (y1 - y0), 0);
  const parts = area > W * H * 0.5 || boxes.length > 60 ? [[0, 0, W, H] as [number, number, number, number]] : boxes;
  const out: Pic[] = [];
  for (const [x0, y0, x1, y1] of parts) {
    const cc = document.createElement('canvas'); cc.width = x1 - x0; cc.height = y1 - y0;
    cc.getContext('2d')!.drawImage(c, x0, y0, cc.width, cc.height, 0, 0, cc.width, cc.height);
    out.push({ png: await canvasPng(cc), x: x0 / scale, y: y0 / scale, w: cc.width / scale, h: cc.height / scale });
  }
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
    if (ls.some((l) => words(l) > 5) || ls.every((l) => l.rtl)) { out.push(...ls); i = j + 1; continue; }
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
  const c = document.createElement('canvas');
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
      if ((r - l >= 8 && top - bottom >= 8) || (thin && Math.max(r - l, top - bottom) >= 6)) out.push({ l, r, top, bottom });
    }
  }
  return out;
}

/** A chart — words set in drawn boxes joined by lines — cannot flow as paragraphs: its lines are scattered
 *  over the boxes. Where several separate small boxes each hold a line or two of text, that part of the page
 *  is kept as drawn (a picture of it, with an empty line of its height in the text), like a formula. */
function pullDiagrams(lines: Line[], shapes: Box[], boxes: Box[], W: number, H: number): Line[] {
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
  boxes.push(reg);
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
  const hs = inPage.filter((s) => s.top - s.bottom <= 2 && s.r - s.l >= 6).map((s) => ({ x0: s.l, x1: s.r, y: (s.top + s.bottom) / 2, w: s.top - s.bottom }));
  const vs = inPage.filter((s) => s.r - s.l <= 2 && s.top - s.bottom >= 6).map((s) => ({ y0: s.bottom, y1: s.top, x: (s.l + s.r) / 2, w: s.r - s.l }));
  if (hs.length < 2 || vs.length < 2) return lines;
  // Rules that meet belong to one table.
  const n = hs.length + vs.length; const up = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i])));
  hs.forEach((h, i) => vs.forEach((v, j) => { if (v.x > h.x0 - 2 && v.x < h.x1 + 2 && h.y > v.y0 - 2 && h.y < v.y1 + 2) up[find(i)] = find(hs.length + j); }));
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
    const gridLine: Line = { pieces: [], base: yTop, size: median(rows.flatMap((r) => r.flatMap((c) => c.lines.flat().map((p) => p.h)))) || 10, l: x0, r: x1, rtl: isRtlText(rows.flatMap((r) => r.flatMap((c) => c.lines.flat().map((p) => p.text))).join('')), grid: spec };
    kept.splice(at < 0 ? kept.length : at, 0, gridLine);
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D grid', xs.length - 1, ys.length - 1, used, JSON.stringify(xs.map((x) => +x.toFixed(1))), JSON.stringify(ys.map((y) => +y.toFixed(1))));
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
  const sizeOf = (g: Piece[]) => median(g.map((p) => p.h));
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]; const sz = sizeOf(g);
    const host = groups.find((o) => o !== g && sizeOf(o) > sz * 1.15 && g[0].y > o[0].y && g[0].y - o[0].y < sizeOf(o) * 0.75 && g.every((p) => p.r > Math.min(...o.map((q) => q.l)) - sizeOf(o) * 3 && p.l < Math.max(...o.map((q) => q.r)) + sizeOf(o) * 3));
    if (host) { g.forEach((p) => { p.sup = true; }); host.push(...g); groups.splice(i, 1); continue; }
    // Smaller print set a little low in a gap of a bigger line (a verse citation after the verse, beside a
    // Quran font whose words sit on their own baseline) is part of that line.
    const inGap = (o: Piece[]) => g.every((p) => p.l >= Math.min(...o.map((q) => q.l)) - 1 && p.r <= Math.max(...o.map((q) => q.r)) + 1 && !o.some((q) => q.text.trim() && q.text !== '\u2009' && q.l < p.r - 0.5 && q.r > p.l + 0.5));
    const low = groups.find((o) => o !== g && sizeOf(o) > sz * 1.15 && g[0].y < o[0].y && o[0].y - g[0].y < sizeOf(o) * 0.6 && inGap(o));
    if (low && !(globalThis as { krNoLow?: boolean }).krNoLow) { low.push(...g); groups.splice(i, 1); }
  }
  // A smaller piece raised above the others of its line is a superscript (a note number on a line of
  // running text), even when it sits close enough to be grouped with them.
  for (const g of groups) {
    if (g.length < 2) continue;
    const big = Math.max(...g.map((p) => p.h));
    const host = g.filter((p) => p.h > big * 0.9); const hb = median(host.map((p) => p.y));
    for (const p of g) if (p.h < big * 0.85 && p.y - hb > big * 0.18 && /^[\s(\[]*[0-9\u0660-\u0669\u06F0-\u06F9*\u2020\u2021a-z]{1,3}[)\]]?\s*$/.test(p.text)) p.sup = true;
  }
  for (const sp of spaces) {
    let best: Piece[] | null = null, bd = Infinity;
    for (const g of groups) {
      const words = g.filter((p) => !p.sup); if (!words.length) continue;
      const y = median(words.map((p) => p.y)), h = Math.max(...words.map((p) => p.h));
      const lo = Math.min(...words.map((p) => p.l)), hi = Math.max(...words.map((p) => p.r));
      const d = Math.abs(y - sp.y);
      if (d < h * 0.5 && sp.l >= lo - 0.5 && sp.r <= hi + 0.5 && d < bd) { bd = d; best = g; }
    }
    best?.push(sp);
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
    return { pieces: g, base, size, l: Math.min(...ext.map((p) => p.l)), r: Math.max(...ext.map((p) => p.r)), rtl: isRtlText(text) };
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
  let best = -1, bestGap = 0;
  let edge = ps[0].r;
  for (let i = 1; i < ps.length; i++) { const gap = ps[i].l - edge; if (gap > bestGap) { bestGap = gap; best = i; } edge = Math.max(edge, ps[i].r); }
  if (best < 0 || bestGap < line.size * 0.5) return null;
  const left = ps.slice(0, best), right = ps.slice(best);
  const gapMid = (Math.max(...left.map((p) => p.r)) + Math.min(...right.map((p) => p.l))) / 2;
  const lw = Math.max(...left.map((p) => p.r)) - Math.min(...left.map((p) => p.l)), rw = Math.max(...right.map((p) => p.r)) - Math.min(...right.map((p) => p.l));
  // A wide gap near the middle, or a narrower one right at the centre with two long halves.
  const wideGap = bestGap >= Math.max(line.size * 1.5, width * 0.045) && Math.abs(gapMid - mid) <= width * 0.18 && lw >= width * 0.3 && rw >= width * 0.3;
  const centred = Math.abs(gapMid - mid) <= width * 0.03 && lw >= width * 0.35 && rw >= width * 0.35 && bestGap >= line.size * (0.75 - (/\u0640/.test(left.map((p) => p.text).join('')) && /\u0640/.test(right.map((p) => p.text).join('')) ? 0.25 : 0));
  if (!wideGap && !centred) return null;
  const all = line.pieces;
  const inLeft = (p: Piece) => p.r <= gapMid + 0.01;
  const res: [Piece[], Piece[], Piece[]] & { weak?: number } = [all.filter((p) => !inLeft(p)), all.filter(inLeft), []];
  // Only a narrow gap: verse if a neighbouring line splits there too (a wide space after a full stop is not).
  if (!wideGap) res.weak = gapMid;
  return res;
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
  let prev: Piece | null = null; let pendingSpace = false; let pendingW = 0;
  // Word gaps of a stretched line are all wide: a tab is much wider than the line's usual gap.
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) { const a = sorted[i - 1], b = sorted[i]; if (!b.text.trim() || !a.text.trim() || a.conn || b.conn || a.art || b.art) continue; const g = rtlLine ? a.l - b.r : b.l - a.r; if (g > 0.5) gaps.push(g); }
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
  const lineCs = Math.abs(midCs) >= 0.05 && avgAdv > 0 ? Math.max(80, Math.min(110, Math.round(100 * (1 + midCs / avgAdv)))) : undefined;
  const normalY = pieces.filter((p) => !p.sup && p.text.trim()).map((p) => p.y);
  const lineBase = normalY.length ? median(normalY) : null;
  for (const p of sorted) {
    if (p.text === '\u2009') { pendingSpace = true; pendingW += p.r - p.l; continue; }
    if (p.conn) { const pv = prev as Piece | null; if (pv) prev = { ...pv, l: Math.min(pv.l, p.l), r: Math.max(pv.r, p.r) }; continue; }
    if (!p.text.trim()) { pendingSpace = true; pendingW += p.r - p.l; continue; }
    let space = pendingSpace;
    const gap = prev ? (rtlLine ? prev.l - p.r : p.l - prev.r) : 0;
    if (prev && gap > Math.min(prev.h, p.h) * (marked ? 0.3 : 0.18)) space = true;
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
    const look: Omit<Run, 'text'> = { font: f.family, size: Math.round(p.h * 2) / 2, bold: f.bold || p.bold, italic: f.italic, color: p.color, rtl: !p.raw && (isRtlText(text) || (rtlLine && !/[A-Za-z0-9]/.test(text))), sup: !!p.sup, raise: p.sup && lineBase !== null ? Math.round((p.y - lineBase) * 2) / 2 : undefined, cs: lineCs };
    const last = runs[runs.length - 1];
    if (tab !== undefined) { if (last) last.text = last.text.replace(/\s+$/, ''); runs.push({ ...look, text, tab }); continue; }
    if (blank !== undefined && last) { last.text = last.text.replace(/\s+$/, ''); runs.push({ ...look, sup: false, raise: undefined, text: ' ', spacing: Math.max(0, blank - p.h * 0.25) }); }
    if (space && last?.art) text = ` ${text}`;
    else if (space && last) last.text += ' ';
    if (last && !last.spacing && !last.art && blank === undefined && last.font === look.font && last.size === look.size && last.bold === look.bold && last.italic === look.italic && last.color === look.color && last.sup === look.sup && last.rtl === look.rtl && last.cs === look.cs) last.text += text;
    else if (space && last && last.text.endsWith(' ')) runs.push({ ...look, text });
    else runs.push({ ...look, text });
  }
  for (const r of runs) r.text = r.text.replace(/\s+(?=[\u064B-\u065F\u0670])/g, '').replace(/([\u060C\u061B\u061F.,:;!)(»«\]\[]+)([\u064B-\u065F\u0670]+)/g, '$2$1').replace(/\s{2,}/g, ' ');
  return runs.filter((r) => r.text.length || r.art);
}

function buildBlocks(lines: Line[], fonts: Map<string, FontInfo>, L: number, R: number, pitchOf: (size: number) => number, prevBaseStart: number | null): Block[] {
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
    else if (ls.length > 1 && ls.slice(0, -1).every((l, i) => (i === 0 ? endGap(l) < tolOf(l) : full(l)))) align = 'both';
    // (An indented block — a list item whose lines all start inside the margin — fills its own width.)
    else if (ls.length > 2 && (() => { const rest = ls.slice(1, -1); const lo = Math.min(...ls.map((l) => l.l)), hi = Math.max(...rest.map((l) => l.r)); return endGap(first) < tolOf(first) && rest.every((l) => l.l - lo < tolOf(l) && hi - l.r < tolOf(l)); })()) align = 'both';
    else if (ls.length === 1 && full(first)) align = 'both';
    else if (ls.every((l) => startGap(l) < tolOf(l) * 1.5) || ls.some((l) => startGap(l) < tolOf(l))) align = 'start';
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
    ls.forEach((l, i) => {
      const rs = runsOf(l.pieces, fonts, l.rtl);
      // Every line ends where the page ends it (a line break inside the paragraph; justified lines
      // still stretch), so small differences in font widths cannot reflow the page.
      if (i > 0 && runs.length && rs.length) rs[0] = { ...rs[0], br: true };
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
    if (!kashida && align === 'both' && rtl) for (const r of runs) r.text = r.text.replace(/\u0640+/g, '');
    // Elsewhere a stretch drawn as overlapping tatweels would come out wider than the page drew it: it goes
    // (a single tatweel — "بـ(" — is writing, not stretching, and stays).
    else if (!kashida && rtl) for (const r of runs) r.text = r.text.replace(/(?<=[\u0620-\u064a][\u064b-\u0652]*)\u0640{2,}/g, '');
    if (kashida) for (const r of runs) { if (r.text.includes('\u0640')) r.kText = r.text; r.text = r.text.replace(/\u0640+/g, ''); }
    // A wide gap before a run that fills the rest of the line is a stretched word space, not a tab: a tab there
    // would leave the run no room and push it onto a line of its own.
    for (const r of runs) if (r.tab !== undefined) {
      const pos = rtl ? R + 3 - r.tab : r.tab - (L - 3);
      if (pos + r.text.length * r.size * 0.45 > R - L + 6) { r.tab = undefined; r.text = ` ${r.text}`; }
    }
    const tabX = runs.filter((r) => r.tab !== undefined).map((r) => r.tab!);
    let tabs: number[] | undefined;
    if (tabX.length) {
      // Tab stops are measured from the text's edge (the margin, 3pt outside L/R).
      // A piece set at the very end of the line stops a little short of it, so a slightly wider font cannot push it over.
      const room = R - L + 6;
      tabs = [...new Set(runs.filter((r) => r.tab !== undefined).map((r) => {
        const pos = rtl ? R + 3 - r.tab! : r.tab! - (L - 3);
        const w = r.text.length * r.size * 0.5;
        return Math.round(Math.max(0, Math.min(pos, room - w * 1.25 - 3)) * 2) / 2;
      }))].sort((a, b) => a - b);
      // Positioned text: set flush from the start, no stretching (a justified line would spread the text after the last tab).
      if (align === 'center' || ls.length === 1) { indStart = 0; indEnd = 0; firstLine = Math.max(0, startGap(first)); }
      align = 'start';
    }
    blocks.push({ kind: 'p', runs, align, kashida, rtl, indStart, indEnd, firstLine, before, pitch, size, tabs });
    prevBase = ls[ls.length - 1].base; prevPitch = pitch;
    cur = null;
  };
  let verse: Verse | null = null;
  const closeVerse = () => { if (verse) blocks.push(verse); verse = null; };
  const splits = lines.map((l) => splitVerse(l, L, R) as ReturnType<typeof splitVerse> & { weak?: number } | null);
  const gapAt = (h: (typeof splits)[number]) => (h ? h.weak ?? (Math.max(...h[1].map((p) => p.r)) + Math.min(...h[0].map((p) => p.l))) / 2 : NaN);
  lines.forEach((l, i) => {
    const h = splits[i]; if (!h || h.weak === undefined) return;
    const near = [splits[i - 1], splits[i + 1]].some((o) => o && Math.abs(gapAt(o) - h.weak!) < l.size * 1.5);
    // (A lone verse shows itself by its halves: each stretched with tatweel to fill its half of the line.)
    const stretched = (ps: Piece[]) => ps.some((p) => /\u0640/.test(p.text));
    if (!near && !(stretched(h[0]) && stretched(h[1]))) splits[i] = null;
  });
  for (const [li, line] of lines.entries()) {
    if (line.grid) {
      closePara(); closeVerse();
      const g = line.grid; const rtl = line.rtl;
      const rowsRuns: Run[][][] = []; const cells: Grid['cells'] = [];
      g.rows.forEach((row) => {
        const rr: Run[][] = []; const cc: Grid['cells'][number] = [];
        for (const c of row) {
          const runs: Run[] = [];
          const ls = [...c.lines].sort((a, b) => median(b.map((p) => p.y)) - median(a.map((p) => p.y)));
          ls.forEach((ps, i) => { const rs = runsOf(ps, fonts, rtl); if (i > 0 && runs.length && rs.length) rs[0] = { ...rs[0], br: true }; runs.push(...rs); });
          const cl = g.xs[c.c0], cr = g.xs[c.c0 + c.span];
          const all = c.lines.flat().filter((p) => p.text.trim() && p.text !== '\u2009');
          let align: Para['align'] = 'start'; let pitch = all.length ? median(all.map((p) => p.h)) * 1.25 : 12;
          if (all.length) {
            const lo = Math.min(...all.map((p) => p.l)), hi = Math.max(...all.map((p) => p.r));
            const a = lo - cl, b = cr - hi;
            if (Math.abs(a - b) < Math.max(3, (cr - cl) * 0.08) && a > 3) align = 'center';
            else if (rtl ? b > a + 3 && a < 6 : a > b + 3 && b < 6) align = 'end';
            if (ls.length > 1) pitch = median(ls.slice(1).map((l, i) => median(ls[i].map((p) => p.y)) - median(l.map((p) => p.y))));
            // (One line fills its row exactly, or the row grows.)
            else pitch = Math.min(pitch, g.ys[g.rows.indexOf(row)] - g.ys[g.rows.indexOf(row) + 1] - 0.3);
          }
          rr.push(c.cont ? [] : runs);
          cc.push({ span: c.span, vmerge: c.cont ? 'continue' : g.rows.some((r2, j2) => j2 > g.rows.indexOf(row) && r2.some((x) => x.cont && x.c0 === c.c0 && x.span === c.span)) ? 'restart' : undefined, align, vcenter: false, pitch });
        }
        rowsRuns.push(rr); cells.push(cc);
      });
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
      const rowH = g.ys.slice(1).map((y, i) => g.ys[i] - y);
      blocks.push({ kind: 'grid', rows: rowsRuns, cells, spec: g, colW, rowH, rtl, before, indStart: rtl ? R - g.xs[g.xs.length - 1] : g.xs[0] - L, size, pitch });
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
        const need = ink + spaces * line.size * 0.3;
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
      prevBase = line.base; prevPitch = verse.pitch;
      continue;
    }
    closeVerse();
    if (cur) {
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
        || (centered(line) && centered(last));
      if (brk) closePara();
    }
    if (!cur) cur = { lines: [] };
    cur.lines.push(line);
  }
  closePara(); closeVerse();
  return blocks;
}

/** Running heads and page numbers: each item centred on where its glyphs are, so a font's slightly different
 *  width cannot move it out of its ornament. */
function pinnedFurniture(header: Line[], footer: Line[], fonts: Map<string, FontInfo>, H: number): Furniture[] {
  const furniture: Furniture[] = [];
  for (const l of [...header, ...footer]) {
    const ps = l.pieces.filter((p) => p.text.trim() || p.text === '\u2009').sort((a, b) => a.l - b.l);
    const groups: Piece[][] = [];
    for (const p of ps) { const g = groups[groups.length - 1]; if (g && p.l - Math.max(...g.map((q) => q.r)) < l.size * 2.5) g.push(p); else groups.push([p]); }
    for (const g of groups) {
      const runs = runsOf(g, fonts, l.rtl); if (!runs.length) continue;
      furniture.push({ runs, cx: (Math.min(...g.map((p) => p.l)) + Math.max(...g.map((p) => p.r))) / 2, base: H - l.base, size: l.size, top: header.includes(l) });
    }
  }
  return furniture;
}

/** Typical baseline-to-baseline pitch for a given size, measured on runs of consecutive lines. */
function pitchTable(runs: Line[][]): (size: number) => number {
  const pitches = new Map<number, number[]>();
  for (const ls of runs) ls.forEach((l, i) => { const n = ls[i + 1]; if (n && Math.abs(n.size - l.size) < l.size * 0.1) { const d = l.base - n.base; if (d > l.size * 0.9 && d < l.size * 2.6) { const k = Math.round(l.size); pitches.set(k, [...(pitches.get(k) ?? []), d]); } } });
  return (size: number) => { const p = pitches.get(Math.round(size)); return p?.length ? median(p) : size * 1.65; };
}

/** A vertical gutter through the middle of the text: page x range [g0, g1], or null. */
function findGutter(lines: Line[], W: number): [number, number] | null {
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
  const side = (inSide: (p: Piece) => boolean) => ls.map((l) => l.pieces.filter((p) => p.text.trim() && p.text !== '\u2009' && inSide(p))).filter((ps) => ps.length);
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
function buildDocFonts(fonts: Map<string, FontInfo>, store: UseStore, stretched: Set<string>): Map<string, string> {
  const alias = new Map<string, string>();
  const parent = new Map<string, string>();
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
  const union = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
  const used = [...fonts].filter(([, f]) => f.uses && f.src);
  for (const [k] of used) parent.set(k, k);
  const byFace = new Map<string, string>();
  for (const [k, f] of used) { const key = `${f.family}|${f.bold}|${f.italic}`; const o = byFace.get(key); if (o) union(o, k); else byFace.set(key, k); }
  // Legacy fonts are one font when they meet inside words often (a bold face meets the regular one only now
  // and then, where a phrase in bold runs into its quote mark).
  const meet = new Map<string, number>();
  for (const seq of store.seqs) for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1][0], b = seq[i][0];
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
  const debug = (globalThis as { krDebugP2D?: boolean }).krDebugP2D;
  for (const keys of groups.values()) {
    keys.sort((a, b) => (fonts.get(b)!.uses ?? 0) - (fonts.get(a)!.uses ?? 0));
    const lead = fonts.get(keys[0])!;
    // A complete TrueType font with a Unicode map is carried as it is.
    // A font of its own with a Unicode map that has the characters the document sets in it is carried as it is.
    if (keys.length === 1 && lead.raw && !lead.legacy) {
      let cov: Set<number> | null = null; try { cov = cmapCoverage(lead.raw); } catch { /* unreadable */ }
      if (cov?.size) {
        const used = new Set<number>();
        for (const seq of store.seqs) for (const [font, u] of seq) if (font === keys[0]) for (const ch of u[1]) { const c = ch.codePointAt(0)!; if (c > 0x20 && !COMBINING.test(ch)) used.add(c); }
        let ok = 0; for (const c of used) if (cov.has(c)) ok++;
        if (!used.size || ok / used.size >= 0.97) continue;
      }
    }
    const sources: GlyphSource[] = []; const c2g: Map<number, number>[] = []; const idx = new Map<string, number>();
    for (const k of keys) {
      const f = fonts.get(k)!; const sf = readSfnt(f.src!.data); if (!sf) continue;
      try {
        const r = glyphReader(sf); const vm = verticalMetrics(sf); const cm = cmapGlyphs(sf);
        const m = new Map<number, number>();
        for (const [code, fc] of Object.entries(f.src!.toFontChar)) { const g = cm.get(fc); if (g) m.set(+code, g); }
        idx.set(k, sources.length); sources.push({ outline: r.outline, upem: r.upem, asc: vm?.asc, desc: vm?.desc }); c2g.push(m);
      } catch (e) { if (debug) console.warn('P2D font read failed', f.family, e); }
    }
    if (!sources.length) continue;
    const member = new Set(keys);
    const lines: Use[][] = [];
    for (const seq of store.seqs) {
      let cur: Use[] = [];
      const push = (x: Use[]) => lines.push(Object.assign(x, { rtl: seq.rtl }));
      for (const [font, u] of seq) {
        const i = member.has(font) ? idx.get(font) : undefined;
        if (i === undefined) { if (cur.length) push(cur); cur = []; continue; }
        const g = c2g[i].get(u[0]); if (!g) continue;
        cur.push([i * 65536 + g, u[1], u[2], u[3], u[4], u[5], u[6]]);
      }
      if (cur.length) push(cur);
    }
    // The space code's glyph, when it is a blank one (a legacy font's "space" may be a letter).
    let sp = !lead.legacy && lead.spaceCode !== undefined && idx.has(keys[0]) ? c2g[idx.get(keys[0])!].get(lead.spaceCode) : undefined;
    if (sp !== undefined) { try { if (sources[idx.get(keys[0])!].outline(sp).contours.length) sp = undefined; } catch { sp = undefined; } }
    let built: Uint8Array | null = null;
    try { built = buildFont(sources, lines, { family: lead.family, bold: lead.bold, italic: lead.italic, raw: !!lead.wordFont, tatweel: keys.some((k) => stretched.has(fonts.get(k)!.family)), space: lead.spaceW ?? spaceFromGaps(keys.flatMap((k) => fonts.get(k)!.gaps ?? [])) }, sp === undefined ? undefined : idx.get(keys[0])! * 65536 + sp); } catch (e) { console.warn('P2D font rebuild failed', lead.family, e); }
    if (debug) console.warn('P2D rebuilt', lead.family, keys.map((k) => fonts.get(k)!.family).join('+'), lines.length, built?.length);
    if (!built) continue;
    lead.raw = built; lead.cov = undefined; lead.rebuilt = true; lead.noUnicode = false;
    for (const k of keys.slice(1)) { const f = fonts.get(k)!; if (f.family !== lead.family) alias.set(f.family, lead.family); f.raw = undefined; }
  }
  return alias;
}

/** A space as wide as the commonest gap between words (em), when the PDF draws none. */
function spaceFromGaps(gaps: number[]): number {
  if (gaps.length < 3) return 0.25;
  const s = [...gaps].sort((a, b) => a - b);
  return Math.min(0.5, Math.max(0.2, s[Math.floor(s.length * 0.25)]));
}

/** Runs set in fonts merged into another take its name, and runs that now match are joined (Arabic joins only
 *  within a run). */
function renameRuns(pg: PageModel, alias: Map<string, string>) {
  const fix = (runs: Run[]) => {
    for (const r of runs) r.font = alias.get(r.font) ?? r.font;
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
  const block = (b: Block) => { if (b.kind === 'p') fix(b.runs); else for (const row of b.rows) for (const cell of row) fix(cell); };
  for (const b of [...pg.body, ...pg.header, ...pg.footer, ...pg.notesRaw, ...pg.notes.flatMap((n) => n.paras), ...(pg.regions ?? []).flatMap((r) => r.cols.flat())]) block(b);
  for (const f of pg.furniture) fix(f.runs);
}

async function analysePage(pdfjs: PdfJs, page: import('pdfjs-dist').PDFPageProxy, fonts: Map<string, FontInfo>, withGraphics: boolean, store: UseStore = { seqs: [], seen: new Map() }): Promise<PageModel> {
  const [, , W, H] = page.view;
  const ol = await page.getOperatorList();
  const tc = await page.getTextContent();
  const pieces: Piece[] = [];
  let spanSeq = 0;
  for (const it of tc.items as { str: string; transform: number[]; width: number; height: number; fontName: string; color?: string; fakeBold?: boolean; strokeEm?: number; krCodes?: (number | string)[]; krSpan?: number; krLead?: boolean }[]) {
    if (typeof it.str !== 'string') continue;
    let text = cleanPdfText(it.str);
    if (/^\u2009+$/.test(text)) text = '\u2009'; else if (!text.trim()) continue;
    // A legacy font's kashida connector (a sliver joining two letter forms, several on a stretched line) is
    // no letter: the rebuilt font joins the letters itself, and Word stretches lines its own way. It still
    // tells that the letters on either side are one word.
    const conn = /^\u0640+$/.test(text) && it.width < (it.height || 10) * 0.12;
    const [a, b, , , e, f] = it.transform;
    const h = it.height || Math.hypot(a, b) || 10;
    // Fill+stroke "bold": Word's own synthetic bold strokes about 1/35 em; a much thinner stroke is
    // not bold in Word's terms (setting bold would draw it heavier than the page shows).
    pieces.push({ text, l: e, r: e + it.width, y: f, h, font: it.fontName, color: it.color || '000000', bold: !!it.fakeBold && (it.strokeEm ?? 0.03) >= 0.014, ...(conn ? { conn: true } : {}), ...(it.krLead ? { keep: true } : {}) });
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
      if (os2) { info.weight = os2.weight; if (os2.weight >= 600 || os2.bold) info.bold = true; if (os2.italic) info.italic = true; }
      // The font's own family name is what Word looks for ("KFGQPC Uthman Taha Naskh", not its PostScript name).
      const own = fo?.krRaw ? fontFamilyName(fo.krRaw) : null;
      if (own) info.family = own.replace(/\s+(Regular)$/i, '');
      else if (!/\s/.test(info.family)) info.family = info.family.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D fontname', fo?.name, '→', info.family, '| own:', own);
      fonts.set(it.fontName, info);
      if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) { const x = fo as unknown as { data?: Uint8Array; type?: string; subtype?: string; toFontChar?: Record<string, number>; mimetype?: string; composite?: boolean }; console.warn('P2D fontdata', info.family, x?.type, x?.subtype, x?.mimetype, x?.composite, x?.data?.length, x?.data ? String.fromCharCode(...x.data.subarray(0, 4)).replace(/[^\x20-\x7e]/g, '.') : '', JSON.stringify(Object.entries(x?.toFontChar ?? {}).slice(0, 5))); }
    }
    // (The glyphs of one /ActualText span are one cluster: its letter and that letter's marks.)
    if (it.krCodes) { const k = it.krCodes; const g = it.krSpan ? ++spanSeq : 0; const seq: GlyphUse[] = []; for (let i = 0; i + 5 < k.length; i += 6) seq.push([k[i] as number, k[i + 1] as string, k[i + 2] as number, k[i + 3] as number, k[i + 4] as number, k[i + 5] as number, g]); pieces[pieces.length - 1].codes = seq;
      // A Quran word font (QCF): each glyph is a whole word, filed under an Arabic presentation-form code. Read as
      // letters, those codes are gibberish that sets nothing like the word; kept as they are, the font (carried
      // in the document) draws each word exactly as the page does.
      const fi = fonts.get(it.fontName);
      if (fi && seq.length && isWordFont(fi, seq)) {
        fi.wordFont = true;
        const ordered = [...seq].sort((a, b) => b[2] - a[2]); // right to left: reading order
        let txt = ''; let edge = Infinity;
        for (const u of ordered) { if (edge - (u[2] + u[5] * u[4]) > u[4] * 0.12 && txt) txt += ' '; txt += u[1]; edge = u[2]; }
        pieces[pieces.length - 1].text = txt;
      }
    }
  }
  // An honorific drawn as one glyph ("ﷺ" read out as "صلى الله عليه وسلم"): its one character, or the words
  // would take a phrase's room where the page has a sign's.
  for (const p of pieces) {
    const lig = HONORIFICS[p.text.replace(/[\s\u0640]+/g, ' ').trim()];
    if (!lig || p.r - p.l > p.h * 2.5) continue;
    const glyphs = p.codes?.filter((u) => u[5] > 0) ?? [];
    if (p.codes && glyphs.length !== 1) continue;
    p.text = lig;
    if (glyphs.length === 1) { for (const u of p.codes!) u[1] = ''; glyphs[0][1] = lig; }
  }
  // Text in a decorative font that carries no letters (private-use codes, or Latin codes standing for
  // Arabic word art on an Arabic page) is not text a reader could use: it stays in the picture.
  const pageRtl = isRtlText(pieces.map((p) => p.text).join(''));
  const keepFonts = new Set<string>();
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i]; const f = fonts.get(p.font);
    if (p.text === '\u2009' || !f) continue;
    const pua = /[\uE000-\uF8FF]/.test(p.text);
    const latinArt = pageRtl && f.noUnicode && /^[\x20-\x7E]+$/.test(p.text) && !/^[\s\d().,:;\-–]+$/.test(p.text);
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
    if ((pua || latinArt) && f.raw && editableFont(f.raw)) {
      f.cov ??= cmapCoverage(f.raw);
      if ([...p.text].every((c) => !c.trim() || f.cov!.has(c.codePointAt(0)!) || /[().:،؛\-]/.test(c))) {
        p.raw = true;
        // (In drawing order, left to right: pdf.js may have turned an item round.)
        if (p.codes?.length && p.codes.every((u) => u[1])) p.text = [...p.codes].sort((x, y) => x[2] - y[2]).map((u) => u[1]).join('');
        continue;
      }
    }
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D art', f.family, pua, latinArt, foreign, JSON.stringify(p.text.slice(0, 40)));
    // (Its place stays taken: a stand-in that sets nothing keeps the line's extent and its gaps true.)
    keepFonts.add(p.font); pieces[i] = { ...p, text: '\uFFFC', art: true, codes: undefined };
  }
  const arts = pieces.filter((p) => p.art);
  const lines = buildLines(attachMarks(pieces).filter((p) => !/^[\u064B-\u065F\u0670\u06D6-\u06ED\s]+$/.test(p.text) || p.text === "\u2009"));
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
        if ((fi.uses ?? 0) < USE_CAP || !seen.has(u[0])) keep = true;
      }
      if (keep) for (const [font, u] of seq) { const fi = fonts.get(font)!; fi.uses = (fi.uses ?? 0) + 1; store.seen.get(font)!.add(u[0]); }
      if (keep) store.seqs.push(Object.assign(seq, { rtl: l.rtl }));
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
  const cutTop = (i: number) => (body[i].base > H * 0.88 || (body[i].base > H * 0.75 && folio(body[i]))) && body[i].base - body[i + 1].base > pitchOf(body[i + 1].size) * 1.2 && sparse(body[i]);
  while (body.length > 1 && header.length < 3 && cutTop(0)) header.push(body.shift()!);
  const cutBottom = (i: number) => (body[i].base < H * 0.08 || (body[i].base < H * 0.25 && folio(body[i]))) && body[i - 1].base - body[i].base > pitchOf(body[i].size) * 1.2 && sparse(body[i]);
  while (body.length > 1 && footer.length < 2 && cutBottom(body.length - 1)) footer.unshift(body.pop()!);
  // Columns: a gutter down the middle splits the text into regions — full-width lines (titles, an abstract)
  // and runs of lines set in two columns.
  const gutter = findGutter(body, W);
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D gutter', JSON.stringify(gutter), body.length);
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
    for (let i = raw.length - 1; i > 0; i--) if (raw[i].full && raw[i - 1].full) { raw[i - 1].full!.push(...raw[i].full!); raw.splice(i, 1); }
    // Lines were grouped across the whole page: a big title in one column can have swallowed the other
    // column's lines beside it (as raised pieces). Regroup each column on its own.
    const regroup = (ls: Line[]) => buildLines(ls.flatMap((l) => l.pieces.map((p) => ({ ...p, sup: undefined }))));
    for (const r of raw) if (!r.full) { r.left = regroup(r.left!); r.right = regroup(r.right!); }
    const formulasC: Box[] = [];
    for (const r of raw) { if (r.full) r.full = pullFormulas(r.full, formulasC); else { r.left = pullFormulas(r.left!, formulasC); r.right = pullFormulas(r.right!, formulasC); } }
    const rtlPage = body.filter((l) => l.rtl).length > body.length / 2;
    // Pitches measured within each column (lines of two columns interleave on the page).
    const pitchCol = pitchTable(raw.flatMap((r) => (r.full ? [r.full] : [r.left!, r.right!])));
    const edgesOf = (ls: Line[]): [number, number] => [Math.min(...ls.map((l) => l.l)), Math.max(...ls.map((l) => l.r))];
    const regions: Region[] = []; let prevBase: number | null = null; let colTop: number | null = null;
    const pageLo = Math.min(...body.map((l) => l.l)), pageHi = Math.max(...body.map((l) => l.r));
    for (const r of raw) {
      if (r.full) {
        regions.push({ cols: [buildBlocks(r.full, fonts, pageLo, pageHi, pitchCol, prevBase)], edges: [[pageLo, pageHi]] });
        prevBase = r.full[r.full.length - 1].base;
      } else {
        const sides = [r.left!, r.right!].filter((x) => x.length);
        if (sides.length < 2) {
          const ls = sides[0] ?? []; if (!ls.length) continue;
          regions.push({ cols: [buildBlocks(ls, fonts, pageLo, pageHi, pitchCol, prevBase)], edges: [[pageLo, pageHi]] });
          prevBase = ls[ls.length - 1].base; continue;
        }
        const ordered = rtlPage ? [r.right!, r.left!] : [r.left!, r.right!];
        // Columns at the top of the page start where the page's top line starts: each column's first line keeps
        // its own height below it (a title in one column, text higher up in the other).
        let start = prevBase;
        if (start === null && !regions.length) { const t = [...r.left!, ...r.right!].reduce((a, b) => (b.base > a.base ? b : a)); start = t.base + BASE * pitchCol(t.size); colTop = start; }
        regions.push({ cols: ordered.map((ls) => { const e = edgesOf(ls); return buildBlocks(ls, fonts, e[0], e[1], pitchCol, start); }), edges: ordered.map(edgesOf) });
        prevBase = Math.min(...[...r.left!, ...r.right!].map((l) => l.base));
      }
    }
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D regions', JSON.stringify(regions.map((r) => r.cols.map((c) => c.map((b) => (b.kind === 'p' ? b.runs.map((x) => x.text).join('').slice(0, 25) : 'verse'))))));
    const lowestL = body[body.length - 1];
    const lo = Math.min(...regions.flatMap((r) => r.edges.map((e) => e[0]))), hi = Math.max(...regions.flatMap((r) => r.edges.map((e) => e[1])));
    const furnitureC = pinnedFurniture(header, footer, fonts, H);
    const firstPitchC = regions[0]?.cols[0]?.[0]?.pitch ?? pitchOf(body[0].size);
    const mC = {
      top: Math.max(6, colTop !== null ? H - colTop : H - body[0].base - BASE * firstPitchC),
      // Generous room below: a column that runs a little long must not push the next column onto a new page.
      bottom: Math.max(8, Math.min(lowestL.base - (1 - BASE) * pitchOf(lowestL.size) - 3 * pitchOf(lowestL.size), ...footer.map((l) => l.base + l.size * 1.2 + 4))),
      left: Math.max(10, lo - 3), right: Math.max(10, W - hi - 3), header: 6, footer: 6,
    };
    const picsC = withGraphics ? await renderGraphics(page, 2, keepFonts, [], arts).catch(() => [] as Pic[]) : [];
    if (withGraphics) picsC.push(...await renderRegions(page, 3, formulasC).catch(() => [] as Pic[]));
    page.cleanup();
    return { w: W, h: H, pics: picsC, furniture: furnitureC, regions, header: [], footer: [], body: [], notes: [], notesRaw: [], notesBox: null, bodyBottom: 0, m: mC };
  }
  // Footnotes: below a short rule in the lower part of the page, in a smaller size.
  let notesLines: Line[] = [];
  const rules = findRules(pdfjs, ol);
  const Lb = median(body.map((l) => l.l)), Rb = median(body.map((l) => l.r));
  const rule = rules.filter((r) => r.y < H * 0.75 && r.y > H * 0.05 && r.x1 - r.x0 < (Rb - Lb) * 0.75)
    .filter((r) => body.some((l) => l.base < r.y) && body.some((l) => l.base > r.y))
    .sort((a, b) => b.y - a.y)[0];
  if (rule) {
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
  const L = edge(ref.map((l) => l.l), (a, b) => a < b, W * 0.1);
  const R = edge(ref.map((l) => l.r), (a, b) => a > b, W * 0.9);
  const bodySize = median(body.flatMap((l) => Array(Math.max(1, l.pieces.reduce((n, p) => n + p.text.length, 0))).fill(l.size))) || 12;
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D page', JSON.stringify({ W, H, L, R, bodySize, rule, lines: textLines.map((l) => ({ b: +l.base.toFixed(1), s: +l.size.toFixed(1), l: +l.l.toFixed(1), r: +l.r.toFixed(1), z: header.includes(l) ? 'H' : footer.includes(l) ? 'F' : notesLines.includes(l) ? 'N' : 'B', t: l.pieces.map((p) => p.text).join('|').slice(0, 60), ps: l.pieces.map((p) => [p.text.slice(0, 12), +p.l.toFixed(0), +p.r.toFixed(0), +p.y.toFixed(1), +p.h.toFixed(1)]), gaps: l.pieces.filter((p) => p.text.trim()).sort((x, y) => x.l - y.l).map((p, i, a) => (i ? +(p.l - a[i - 1].r).toFixed(1) : 0)).filter((g) => g > 8) })) }));
  const formulas: Box[] = [];
  const shapes = findShapes(pdfjs, ol, true);
  if ((globalThis as { krDebugLine?: string }).krDebugLine === 'shapes') console.warn('P2D shapes', JSON.stringify(shapes.map((s) => [+s.l.toFixed(1), +s.r.toFixed(1), +s.bottom.toFixed(1), +s.top.toFixed(1)])));
  const boxShapes = shapes.filter((s) => s.r - s.l >= 8 && s.top - s.bottom >= 8);
  const bodyBlocks = buildBlocks(pullFormulas(pullDiagrams(pullGrids(body, shapes, W, H), boxShapes, formulas, W, H), formulas), fonts, L, R, pitchOf, null);
  const furniture = pinnedFurniture(header, footer, fonts, H);
  const headerBlocks: Block[] = [];
  const footerBlocks: Block[] = [];
  // Footnotes, split at their numbers (and kept whole, for pages whose notes cannot be Word footnotes).
  // In the page's flow the notes follow the text at the distance the page has between them.
  notesLines = pullGrids(notesLines, shapes, W, H);
  const notesRaw = buildBlocks(notesLines, fonts, L, R, pitchOf, body.length ? body[body.length - 1].base : null);
  const notesBox = notesLines.length ? { top: H - (rule ? rule.y : notesLines[0].base + notesLines[0].size), bottom: H - notesLines[notesLines.length - 1].base + notesLines[notesLines.length - 1].size * 0.4, l: L, r: R } : null;
  const notes: Note[] = [];
  for (const b of buildBlocks(notesLines, fonts, L, R, pitchOf, null)) {
    // (A table or verse in a note belongs to the note it follows.)
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
  // Note references in the body: small raised numbers.
  const nums = new Set(notes.map((n) => n.num));
  for (const b of bodyBlocks) {
    const rowsRuns = b.kind === 'p' ? [b.runs] : b.rows.flat();
    for (const runs of rowsRuns) for (const r of runs) { const m = r.sup && DIGITS.exec(r.text); if (m && nums.has(toInt(m[1]))) r.note = toInt(m[1]); }
  }
  // Margins from where the text sits.
  const top = body.length ? body[0] : textLines[0];
  const lowest = (notesLines.length ? notesLines : body).slice(-1)[0];
  const firstPitch = bodyBlocks[0]?.pitch ?? (top ? pitchOf(top.size) : 14);
  const m = {
    // The first line's baseline lands where the page has it; the last line's box ends just above the bottom margin.
    top: top ? Math.max(6, H - top.base - BASE * firstPitch) : 72,
    // About a line to spare below the last line: invisible, and it absorbs small drift instead of spilling a line.
    bottom: lowest ? Math.max(8, lowest.base - (1 - BASE) * pitchOf(lowest.size) - pitchOf(lowest.size)) : 72,
    // A little tolerance on each side: another font's slightly wider glyphs must not push a word to a new line.
    left: Math.max(10, L - 3), right: Math.max(10, W - R - 3),
    header: 6, footer: 6,
  };
  const grids = [...bodyBlocks, ...notesRaw].filter((b): b is Grid => b.kind === 'grid').map((b) => b.spec);
  const pics = withGraphics ? await renderGraphics(page, 2, keepFonts, [...new Set(grids)], arts).catch(() => [] as Pic[]) : [];
  if (withGraphics) pics.push(...await renderRegions(page, 3, formulas).catch(() => [] as Pic[]));
  page.cleanup();
  const lastBody = body[body.length - 1];
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D notes', JSON.stringify({ lastBody: lastBody?.base, firstNote: notesLines[0]?.base, before: notesRaw[0] && notesRaw[0].before, pitch: notesRaw[0] && notesRaw[0].pitch, bodyBlocks: bodyBlocks.map((b) => [b.kind, +b.before.toFixed(1), +b.pitch.toFixed(1)]) }));
  return { w: W, h: H, pics, furniture, header: headerBlocks, footer: footerBlocks, body: bodyBlocks, notes, notesRaw, notesBox, bodyBottom: lastBody ? lastBody.base - lastBody.size * 0.4 : 0, m };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export async function pdfToDocx(book: Book, file: Blob, progress: Progress, password?: string): Promise<Blob> {
  const pdfjs = await loadPdfjs();
  const RES = new URL('./pdfjs/', import.meta.url).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password, fontExtraProperties: true, useSystemFonts: false, cMapUrl: `${RES}cmaps/`, cMapPacked: true, standardFontDataUrl: `${RES}standard_fonts/`, wasmUrl: `${RES}wasm/`, iccUrl: `${RES}iccs/` } as Parameters<typeof pdfjs.getDocument>[0]);
  let doc; try { doc = await task.promise; } catch (e) { if ((e as Error).name === 'PasswordException') throw new Error('password'); throw e; }
  const fonts = new Map<string, FontInfo>();
  const store: UseStore = { seqs: [], seen: new Map() };
  const pages: PageModel[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    progress('pdfPage', Math.round((p / doc.numPages) * 80));
    const page = await doc.getPage(p);
    pages.push(await analysePage(pdfjs, page, fonts, true, store));
    if (p % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await task.destroy();
  progress('build', 85);

  // The PDF's embedded fonts, rebuilt as TrueType fonts Word can carry (subsets of one face merged, and the
  // several fonts a legacy Arabic book spreads its letter forms over made one), then runs renamed to them.
  // Fonts whose text Word stretches with kashidas (verses, tatweel-justified paragraphs, tatweels kept in the
  // text) keep their tatweel; the others lose it, or LibreOffice would stretch every justified line with it.
  const stretched = new Set<string>();
  for (const pg of pages) for (const b of [...pg.body, ...pg.notesRaw, ...pg.notes.flatMap((n) => n.paras), ...(pg.regions ?? []).flatMap((r) => r.cols.flat())]) {
    if (b.kind === 'verse') { for (const row of b.rows) for (const cell of row) for (const r of cell) stretched.add(r.font); }
    else if (b.kind === 'grid') { for (const row of b.rows) for (const cell of row) for (const r of cell) if (r.text.includes('\u0640')) stretched.add(r.font); }
    else for (const r of b.runs) if (b.kashida || r.text.includes('\u0640')) stretched.add(r.font);
  }
  const alias = buildDocFonts(fonts, store, stretched);
  // In a font rebuilt from the PDF's own glyphs, the page's own tatweels give its lines exactly their width:
  // they stay, and Word adds none.
  const exact = new Set([...fonts.values()].filter((f) => f.rebuilt && f.raw).map((f) => f.family));
  for (const [a, b] of alias) if (exact.has(b)) exact.add(a);
  store.seqs = [];
  if (alias.size) for (const pg of pages) renameRuns(pg, alias);

  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, LineRuleType, FootnoteReferenceRun, Header, Footer, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType, SectionType, TableLayoutType, CharacterSet, Tab, TabStopType, Column, ColumnBreak, HeightRule, VerticalMergeType, VerticalAlign, ShadingType } = docx;

  const usedChars = new Map<string, Set<number>>();
  const runFor = (r: Run, footnotes: Map<number, number> | null) => {
    if (r.art) {
      const pic = r.art.pic;
      if (!pic) return new TextRun({ text: '' });
      return new ImageRun({ type: 'png', data: pic.png, transformation: { width: Math.max(1, Math.round(pic.w * 96 / 72)), height: Math.max(1, Math.round(pic.h * 96 / 72)) } });
    }
    if (r.note !== undefined && footnotes?.has(r.note) && !r.br) return new FootnoteReferenceRun(footnotes.get(r.note)!);
    const key = `${r.font}|${r.bold && r.italic ? 'BoldItalic' : r.bold ? 'Bold' : r.italic ? 'Italic' : 'Regular'}`;
    let set = usedChars.get(key); if (!set) usedChars.set(key, set = new Set());
    for (const ch of r.text) set.add(ch.codePointAt(0)!);
    const half = Math.max(2, Math.round(r.size * 2));
    return new TextRun({
      ...(r.tab !== undefined ? { children: [new Tab(), r.text] } : { text: r.text }),
      break: r.br ? 1 : undefined,
      font: { ascii: r.font, hAnsi: r.font, cs: r.font, eastAsia: r.font },
      size: half, sizeComplexScript: half,
      ...(r.cs && r.cs !== 100 ? { scale: r.cs } : {}),
      ...(r.spacing ? { characterSpacing: Math.round(r.spacing * PT) } : {}),
      bold: r.bold, boldComplexScript: r.bold, italics: r.italic, italicsComplexScript: r.italic,
      color: r.color && r.color !== '000000' ? r.color : undefined,
      rightToLeft: r.rtl || undefined,
      // Raised by exactly what the page raises it, at its own size (Word's superscript would shrink it again).
      ...(r.sup ? (r.raise ? { position: `${r.raise}pt` } : { superScript: true }) : {}),
    });
  };
  const alignOf = (a: Para['align'], kashida = false) => (a === 'center' ? AlignmentType.CENTER : a === 'both' ? (kashida ? AlignmentType.MEDIUM_KASHIDA : AlignmentType.BOTH) : a === 'end' ? AlignmentType.END : AlignmentType.START);
  const markRun = (b: { runs?: Run[]; rtl: boolean; size: number }) => {
    const r = b.runs?.find((x) => x.text.trim()); const half = Math.max(2, Math.round((r?.size ?? b.size) * 2));
    return r ? { font: { ascii: r.font, hAnsi: r.font, cs: r.font, eastAsia: r.font }, size: half, sizeComplexScript: half, rightToLeft: b.rtl || undefined } : { size: half, sizeComplexScript: half, rightToLeft: b.rtl || undefined };
  };
  // A stretched paragraph set in a rebuilt font keeps the page's tatweels and is justified by its spaces.
  const ownStretch = (b: Para): Para => (b.kashida && b.runs.every((r) => !r.text.trim() || exact.has(r.font)) ? { ...b, kashida: false, runs: b.runs.map((r) => (r.kText ? { ...r, text: r.kText } : r)) } : b);
  const paraFor = (b0: Para, footnotes: Map<number, number> | null, extra: { before?: number; colBreak?: boolean } = {}) => { const b = ownStretch(b0); return new Paragraph({
    bidirectional: b.rtl,
    run: markRun(b),
    widowControl: false,
    // (Justified by its spaces even where the page used tatweels: a line ending in a line break is stretched by
    // Word and LibreOffice alike only that way.)
    alignment: alignOf(b.align, false),
    indent: { start: Math.round(b.indStart * PT), end: Math.round(b.indEnd * PT), ...(b.firstLine >= 0 ? { firstLine: Math.round(b.firstLine * PT) } : { hanging: Math.round(-b.firstLine * PT) }) },
    spacing: { before: Math.round((extra.before ?? b.before) * PT), after: 0, line: Math.round(b.pitch * PT), lineRule: LineRuleType.EXACT },
    tabStops: b.tabs?.map((t) => ({ type: TabStopType.LEFT, position: Math.round(t * PT) })),
    children: [...(extra.colBreak ? [new ColumnBreak()] : []), ...b.runs.map((r) => runFor(r, footnotes))],
  }); };
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const verseFor = (v: Verse, footnotes: Map<number, number> | null) => {
    const cols = v.rows[0].length;
    const midW = cols === 3 ? Math.round(Math.max(v.midW, v.size * 2.5) * PT) : 0;
    // The gap between the halves becomes cell padding (half on each side of each cell), so the table grows by it.
    const pad = cols === 2 ? Math.round((v.gap / 2) * PT) : 0;
    const colW = Math.round(((v.width * PT) - midW) / 2) + pad;
    const widths = cols === 3 ? [colW, midW, colW] : [colW, colW];
    const indent = Math.round(v.indStart * PT) - pad;
    return new Table({
      visuallyRightToLeft: v.rtl,
      layout: TableLayoutType.FIXED,
      width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      columnWidths: widths,
      indent: indent ? { size: indent, type: WidthType.DXA } : undefined,
      borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
      rows: v.rows.map((row, i) => new TableRow({
        children: row.map((runs, c) => new TableCell({
          width: { size: widths[c], type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: pad, right: pad },
          children: [new Paragraph({
            bidirectional: v.rtl,
            // Each half-line fills its cell the way the book stretches it (Word adds the kashidas).
            // (In a rebuilt font the half-line keeps the page's own tatweels, which give it its width.)
            alignment: cols === 3 && c === 1 ? AlignmentType.CENTER : AlignmentType.DISTRIBUTE,
            widowControl: false,
            spacing: { before: i === 0 ? Math.round(v.before * PT) : 0, after: 0, line: Math.round(v.pitch * PT), lineRule: LineRuleType.EXACT },
            children: runs.map((r) => runFor(exact.has(r.font) ? r : { ...r, text: r.text.replace(/\u0640+/g, '') }, footnotes)),
          })],
        })),
      })),
    });
  };
  // A ruled table: its columns and rows as the page draws them, each cell's lines as the page breaks them.
  const gridFor = (g: Grid, footnotes: Map<number, number> | null) => {
    const pad = 2; // points of room inside each cell
    const order = <T,>(a: T[]) => (g.rtl ? [...a].reverse() : a);
    const sz = Math.max(2, Math.min(24, Math.round(g.spec.rule * 8)));
    const line = { style: BorderStyle.SINGLE, size: sz, color: '000000' };
    const colTw = g.colW.map((w) => Math.round(w * PT));
    const colsIn = (c0: number, span: number) => colTw.slice(c0, c0 + span).reduce((a, b) => a + b, 0);
    return new Table({
      visuallyRightToLeft: g.rtl,
      layout: TableLayoutType.FIXED,
      width: { size: colTw.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      columnWidths: order(colTw),
      indent: { size: Math.round((g.indStart + 3 + pad) * PT), type: WidthType.DXA },
      borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
      rows: g.rows.map((row, i) => new TableRow({
        height: { value: Math.round(g.rowH[i] * PT), rule: HeightRule.ATLEAST },
        children: order(row.map((runs, k) => ({ runs, meta: g.cells[i][k], spec: g.spec.rows[i][k] }))).map(({ runs, meta, spec }) => new TableCell({
          width: { size: colsIn(spec.c0, spec.span), type: WidthType.DXA },
          ...(meta.span > 1 ? { columnSpan: meta.span } : {}),
          ...(meta.vmerge ? { verticalMerge: meta.vmerge === 'restart' ? VerticalMergeType.RESTART : VerticalMergeType.CONTINUE } : {}),
          verticalAlign: meta.vcenter ? VerticalAlign.CENTER : VerticalAlign.TOP,
          ...(spec.fill ? { shading: { fill: spec.fill, type: ShadingType.CLEAR, color: 'auto' } } : {}),
          margins: { top: 0, bottom: 0, left: Math.round(pad * PT), right: Math.round(pad * PT) },
          children: [new Paragraph({
            bidirectional: g.rtl, widowControl: false,
            alignment: alignOf(meta.align),
            spacing: { before: i === 0 ? 0 : 0, after: 0, line: Math.round(meta.pitch * PT), lineRule: LineRuleType.EXACT },
            children: runs.map((r) => runFor(r, footnotes)),
          })],
        })),
      })),
    });
  };
  // (A table has no space above of its own: an empty line of that height goes before it.)
  const gridBlock = (g: Grid, footnotes: Map<number, number> | null) => (g.before > 1 ? [new Paragraph({ spacing: { before: 0, after: 0, line: Math.round(g.before * PT), lineRule: LineRuleType.EXACT }, children: [new TextRun({ text: '', size: 2 })] }), gridFor(g, footnotes)] : [gridFor(g, footnotes)]);
  const blocksFor = (bs: Block[], footnotes: Map<number, number> | null) => bs.flatMap((b) => (b.kind === 'p' ? [paraFor(b, footnotes)] : b.kind === 'grid' ? gridBlock(b, footnotes) : [verseFor(b, footnotes)]));

  const footnoteDefs: Record<number, { children: InstanceType<typeof Paragraph>[] }> = {};
  let noteId = 1;
  const sections = pages.flatMap((pg) => {
    const map = new Map<number, number>();
    // Real Word footnotes when every note is numbered and called from the text; otherwise the note area
    // is placed as a block exactly where the page has it.
    const allCalled = REAL_FOOTNOTES && pg.notes.length > 0 && pg.notes.every((n) => n.num >= 0 && pg.body.some((b) => (b.kind === 'p' ? [b.runs] : b.rows.flat()).some((rs) => rs.some((r) => r.note === n.num))));
    for (const n of allCalled ? pg.notes : []) {
      if (n.num < 0 || map.has(n.num)) continue;
      const referenced = pg.body.some((b) => (b.kind === 'p' ? [b.runs] : b.rows.flat()).some((rs) => rs.some((r) => r.note === n.num)));
      if (!referenced) continue;
      map.set(n.num, noteId);
      footnoteDefs[noteId] = { children: n.paras.flatMap((p) => (p.kind === 'p' ? [paraFor(p, null, { before: 0 })] : blocksFor([p], null))) as InstanceType<typeof Paragraph>[] };
      noteId++;
    }
    // Otherwise the note area stays in the page's flow, numbers and all, right where the page has it.
    const flowNotes = allCalled ? [] : pg.notesRaw;
    const picRuns = pg.pics.map((pic) => new ImageRun({
      type: 'png', data: pic.png,
      transformation: { width: Math.max(1, Math.round(pic.w * 96 / 72)), height: Math.max(1, Math.round(pic.h * 96 / 72)) },
      floating: { horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: Math.round(pic.x * EMU) }, verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: Math.round(pic.y * EMU) }, behindDocument: true, allowOverlap: true, lockAnchor: true, wrap: { type: TextWrappingType.NONE } },
    }));
    // Running heads and page numbers: plain header/footer paragraphs placed by spacing (the 4/5 baseline rule)
    // with each item on a centre tab stop at its original centre — exact in any word processor and font.
    const pinned = (items: Furniture[], fromTop: boolean, startAt: number) => {
      const lines: Furniture[][] = [];
      for (const f of [...items].sort((a, b) => (fromTop ? a.base - b.base : a.base - b.base))) { const g = lines.find((x) => Math.abs(x[0].base - f.base) < 3); if (g) g.push(f); else lines.push([f]); }
      let cursor = startAt; const out: InstanceType<typeof Paragraph>[] = [];
      for (const ln of lines) {
        const size = Math.max(...ln.map((f) => f.size)); const L = Math.max(size * 1.3, 6);
        const top = ln[0].base - BASE * L;
        const sorted = [...ln].sort((a, b) => a.cx - b.cx);
        out.push(new Paragraph({
          bidirectional: false, alignment: AlignmentType.LEFT, widowControl: false,
          indent: { left: 0, right: 0 },
          spacing: { before: Math.max(0, Math.round((top - cursor) * PT)), after: 0, line: Math.round(L * PT), lineRule: LineRuleType.EXACT },
          tabStops: sorted.map((f) => ({ type: TabStopType.CENTER, position: Math.max(0, Math.round((f.cx - pg.m.left) * PT)) })),
          children: sorted.flatMap((f) => [new TextRun({ children: [new Tab()] }), ...f.runs.map((r) => runFor(r, null))]),
        }));
        cursor = top + L;
      }
      return { paras: out, end: cursor };
    };
    const headerPinned = pinned(pg.furniture.filter((f) => f.top), true, pg.m.header + (pg.pics.length ? 1 : 0));
    const footerItems = pg.furniture.filter((f) => !f.top);
    let footerPinned: { paras: InstanceType<typeof Paragraph>[]; end: number } = { paras: [], end: 0 };
    let footerDist = pg.m.footer;
    if (footerItems.length) {
      // The footer's top is where its first line's box starts; Word then measures the footer distance from its bottom.
      const firstTop = Math.min(...footerItems.map((f) => f.base - BASE * Math.max(f.size * 1.3, 6)));
      footerPinned = pinned(footerItems, true, firstTop);
      footerDist = Math.max(4, pg.h - footerPinned.end);
    }
    const frames = headerPinned.paras;
    const tiny = { size: 2, sizeComplexScript: 2 };
    const headerChildren = [
      ...(picRuns.length ? [new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: [...picRuns, new TextRun({ text: '', ...tiny })] })] : []),
      ...frames,
      ...blocksFor(pg.header, null),
    ];
    const footerChildren = [...footerPinned.paras, ...blocksFor(pg.footer, null)];
    // The pinned lines live in the page's header part with the decorations: positioned against the page, taking
    // no room, and keeping the body free to start like any page (LibreOffice mis-reads a section that opens
    // with frames before a table).
    const bottom = pg.m.bottom;
    const page = { size: { width: Math.round(pg.w * PT), height: Math.round(pg.h * PT) }, margin: { top: Math.round(pg.m.top * PT), bottom: Math.round(bottom * PT), left: Math.round(pg.m.left * PT), right: Math.round(pg.m.right * PT), header: Math.round(pg.m.header * PT), footer: Math.round(footerDist * PT), gutter: 0 } };
    const headers = { default: new Header({ children: headerChildren.length ? headerChildren : [new Paragraph({ children: [] })] }) };
    const footers = { default: new Footer({ children: footerChildren.length ? footerChildren : [new Paragraph({ children: [] })] }) };
    if (pg.regions?.length) {
      // A page in columns: one continuous section per region, each with its own column layout; the columns'
      // widths and gap follow the page, and a column break starts each column after the first.
      const textL = pg.m.left, textR = pg.w - pg.m.right;
      return pg.regions.map((rg, i) => {
        const kids: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
        rg.cols.forEach((bs, c) => {
          // The second column starts with a column break inside its first paragraph (a paragraph of its own
          // would add its height to the column).
          if (c > 0 && bs[0]?.kind === 'p') { kids.push(paraFor(bs[0], null, { colBreak: true }), ...blocksFor(bs.slice(1), null)); return; }
          if (c > 0) kids.push(new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: [new ColumnBreak()] }));
          kids.push(...blocksFor(bs, null));
        });
        if (!kids.length) kids.push(new Paragraph({ children: [] }));
        let column: object | undefined;
        if (rg.cols.length > 1) {
          // Visual left-to-right column boxes, then in the section's reading order.
          const boxes = rg.edges.map(([a, b]) => [Math.max(textL, a - 3), Math.min(textR, b + 3)] as [number, number]).sort((x, y) => x[0] - y[0]);
          const widths = [boxes[0][1] - textL, textR - boxes[1][0]];
          const space = Math.max(6, textR - textL - widths[0] - widths[1]);
          const rtlCols = rg.edges[0][0] > rg.edges[1][0];
          const ordered = rtlCols ? [widths[1], widths[0]] : widths;
          column = { count: 2, equalWidth: false, space: Math.round(space * PT), children: [new Column({ width: Math.round(ordered[0] * PT), space: Math.round(space * PT) }), new Column({ width: Math.round(ordered[1] * PT) })] };
        }
        return {
          properties: { type: i === 0 ? SectionType.NEXT_PAGE : SectionType.CONTINUOUS, page, ...(column ? { column } : {}) },
          ...(i === 0 ? { headers, footers } : {}),
          children: kids,
        };
      });
    }
    const children = [...blocksFor(pg.body, map), ...blocksFor(flowNotes, null)];
    if (!children.length) children.push(new Paragraph({ children: [] }));
    return [{
      properties: { type: SectionType.NEXT_PAGE, page },
      headers,
      footers: footerChildren.length ? footers : undefined,
      children,
    }];
  });

  // Embed the PDF's own fonts — each face (regular, bold, …) under its family — where they can draw
  // every character used with them in that style.
  type Face = 'Regular' | 'Bold' | 'Italic' | 'BoldItalic';
  const faceOf = (bold: boolean, italic: boolean): Face => (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular');
  const faces = new Map<string, Map<Face, Uint8Array>>();
  const best = new Map<string, { score: number }>();
  for (const f of fonts.values()) {
    if (!f.raw) continue;
    const face = faceOf(f.bold && (f.weight ?? 400) >= 600, f.italic);
    const used = usedChars.get(`${f.family}|${face}`); if (!used?.size) continue;
    const cov = (f.cov ??= cmapCoverage(f.raw));
    let ok = 0, total = 0;
    for (const c of used) { if (c <= 0x20 || COMBINING.test(String.fromCodePoint(c))) continue; total++; if (cov.has(c)) ok++; }
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
  const embedded: { name: string; data: Uint8Array; characterSet?: (typeof CharacterSet)[keyof typeof CharacterSet] }[] = [];
  const extraFaces: { family: string; face: Face; data: Uint8Array }[] = [];
  const sigs = new Map<string, Os2>();
  for (const [family, m] of faces) {
    const arabic = [...(usedChars.get(`${family}|Regular`) ?? []), ...(usedChars.get(`${family}|Bold`) ?? [])].some((c) => c >= 0x600 && c <= 0x6ff);
    const first = (m.get('Regular') ?? m.values().next().value)!;
    const firstFace = [...m.entries()].find(([, v]) => v === first)![0];
    embedded.push({ name: family, data: first, characterSet: arabic ? CharacterSet.ARABIC : CharacterSet.ANSI });
    for (const [face, data] of m) if (data !== first) extraFaces.push({ family, face, data });
    if (firstFace !== 'Regular') extraFaces.push({ family, face: firstFace, data: new Uint8Array(0) }); // marks: move embedRegular to this face
    const os2 = readOs2(first); if (os2) sigs.set(family, os2);
  }

  const allBlocks = pages.flatMap((p) => [...p.body, ...(p.regions ?? []).flatMap((r) => r.cols.flat())]);
  const rtlDoc = allBlocks.filter((b) => b.rtl).length > allBlocks.length / 2;
  const d = new Document({
    creator: 'KurokawaReader', title: book.title,
    fonts: embedded.length ? (embedded as never) : undefined,
    footnotes: footnoteDefs,
    styles: { default: { document: { run: { font: rtlDoc ? { ascii: 'Times New Roman', cs: 'Traditional Arabic', hAnsi: 'Times New Roman', eastAsia: 'Times New Roman' } : 'Times New Roman' }, paragraph: { spacing: { after: 0 } } } } },
    sections,
  });
  progress('build', 92);
  let blob = await Packer.toBlob(d);
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
  blob = await finishDocx(blob, rtlDoc, extraFaces, sigs, subs);
  progress('build', 100);
  return blob;
}

/** Word details the library has no option for: right-to-left sections, footnote numbers restart on each page. */
async function finishDocx(blob: Blob, rtl: boolean, extraFaces: { family: string; face: string; data: Uint8Array }[] = [], sigs = new Map<string, Os2>(), subs = new Map<string, { latin: string; cs: string; ea: string }>()): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(blob);
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
      const ob = data.slice(); for (let i = 0; i < 32 && i < ob.length; i++) ob[i] ^= kb[i % 16];
      const id = `rIdK${n++}`;
      zip.file(`word/fonts/kr-${id}.odttf`, ob);
      rels = rels.replace('</Relationships>', `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/kr-${id}.odttf"/></Relationships>`);
      table = table.replace(re, `$1<w:embed${face} r:id="${id}" w:fontKey="${key}"/>$2`);
    }
    zip.file('word/fontTable.xml', table);
    zip.file('word/_rels/fontTable.xml.rels', rels);
  }
  const docXml = await zip.file('word/document.xml')!.async('string');
  const fixed = docXml.replace(/<w:sectPr([^>]*)>/g, (m) => `${m}<w:footnotePr><w:numRestart w:val="eachPage"/></w:footnotePr>`)
    .replace(/(<w:sectPr[^>]*>[\s\S]*?)(<\/w:sectPr>)/g, (m, a: string, b: string) => (rtl && !a.includes('<w:bidi') ? `${a}<w:bidi/>${b}` : m));
  zip.file('word/document.xml', fixed);
  // A raised run's position in half-points (docx writes "4pt", which LibreOffice and older Words ignore).
  for (const name of Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(n))) {
    const xml = await zip.file(name)!.async('string');
    if (xml.includes('<w:position w:val="')) zip.file(name, xml.replace(/<w:position w:val="(-?[\d.]+)pt"\/>/g, (m, v: string) => `<w:position w:val="${Math.round(+v * 2)}"/>`));
  }
  if (subs.size) {
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const bySlot = new Map([...subs].map(([k, v]) => [esc(k), v]));
    for (const name of Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(n))) {
      const xml = await zip.file(name)!.async('string');
      zip.file(name, xml.replace(/w:(ascii|hAnsi|cs|eastAsia)="([^"]*)"/g, (m, slot: string, v: string) => {
        const sub = bySlot.get(v); if (!sub) return m;
        return `w:${slot}="${slot === 'cs' ? sub.cs : slot === 'eastAsia' ? sub.ea : sub.latin}"`;
      }));
    }
  }
  // The page already shows the book's own rule above the notes (in the background): Word's separator goes.
  const fn = zip.file('word/footnotes.xml');
  if (fn) zip.file('word/footnotes.xml', (await fn.async('string')).replace(/<w:separator\/>|<w:continuationSeparator\/>/g, ''));
  const settings = zip.file('word/settings.xml');
  if (settings) {
    let s = await settings.async('string');
    if (!s.includes('w:footnotePr')) s = s.replace(/<w:settings([^>]*)>/, (m) => `${m}<w:footnotePr><w:numRestart w:val="eachPage"/></w:footnotePr>`);
    if (ft && !s.includes('w:embedTrueTypeFonts')) s = s.replace(/<w:settings([^>]*)>/, (m) => `${m}<w:embedTrueTypeFonts/>`);
    zip.file('word/settings.xml', s);
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
}
