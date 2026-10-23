// PDF → DOCX that keeps the page: every PDF page becomes a Word section of the same size and
// margins; its decorations (frames, ornaments, rules, pictures) are drawn once without text and laid
// behind it; the text is real, editable Word text — paragraphs with their alignment, indents,
// spacing and line pitch, runs with their font, size, weight and colour, two-column verse as a
// borderless table, the running head in the page header, and footnotes as Word footnotes.
// Arabic is right-to-left throughout (bidi paragraphs and tables, complex-script fonts and sizes).
import { loadPdfjs } from './formats/pdf';
import { cleanPdfText, isRtlText, joinLine, COMBINING, attachMarks } from './pdftext';
import type { Book } from './db';
import type { Progress } from './convert';

type PdfJs = Awaited<ReturnType<typeof loadPdfjs>>;
type FontInfo = { family: string; bold: boolean; italic: boolean; raw?: Uint8Array; noUnicode?: boolean; symbolic?: boolean; cov?: Set<number>; weight?: number };
type Piece = { text: string; l: number; r: number; y: number; h: number; font: string; color: string; bold: boolean; sup?: boolean; art?: boolean };
/** OS/2 of a TrueType font: weight, italic, and the Unicode/code-page ranges Word reads as its signature. */
type Os2 = { weight: number; italic: boolean; bold: boolean; usb: number[]; csb: number[] };
type Line = { pieces: Piece[]; base: number; size: number; l: number; r: number; rtl: boolean };
type Run = { text: string; font: string; size: number; bold: boolean; italic: boolean; color: string; rtl: boolean; sup: boolean; note?: number; br?: boolean };
type Para = { kind: 'p'; runs: Run[]; align: 'start' | 'end' | 'center' | 'both'; kashida?: boolean; rtl: boolean; indStart: number; indEnd: number; firstLine: number; before: number; pitch: number; size: number };
type Verse = { kind: 'verse'; rows: Run[][][]; rtl: boolean; before: number; pitch: number; size: number; width: number; indStart: number; midW: number; gap: number };
type Block = Para | Verse;
type Note = { num: number; paras: Para[] };
type Furniture = { runs: Run[]; cx: number; base: number; size: number; top: boolean };
type PageModel = { w: number; h: number; pics: Pic[]; furniture: Furniture[]; header: Block[]; footer: Block[]; body: Block[]; notes: Note[]; notesRaw: Block[]; notesBox: { top: number; bottom: number; l: number; r: number } | null; bodyBottom: number; m: { top: number; bottom: number; left: number; right: number; header: number; footer: number } };

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
  n = n.replace(/([a-z])([A-Z])/g, (s, a: string, b: string) => (/^(Times|Courier|Arial|Traditional|Simplified)/.test(n) ? `${a} ${b}` : s)).replace(/PSMT$|MT$/, '').trim();
  if (/^TimesNewRoman/i.test(n.replace(/\s/g, ''))) n = 'Times New Roman';
  if (/^Arial$/i.test(n.replace(/\s/g, ''))) n = 'Arial';
  return { family: n || 'Times New Roman', bold, italic };
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
async function renderGraphics(page: import('pdfjs-dist').PDFPageProxy, scale: number, keepFonts: Set<string>): Promise<Pic[]> {
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas') as HTMLCanvasElement & { krNoText?: boolean; krKeepFonts?: Set<string> };
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); c.krNoText = true; c.krKeepFonts = keepFonts;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvas: c, canvasContext: ctx, viewport: vp, background: 'rgba(255,255,255,1)' } as Parameters<typeof page.render>[0]).promise;
  const W = c.width, H = c.height;
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

/* ------------------------------------------------------------------ */
/* Layout analysis                                                     */
/* ------------------------------------------------------------------ */

function buildLines(pieces: Piece[]): Line[] {
  pieces.sort((a, b) => b.y - a.y);
  const groups: Piece[][] = [];
  for (const p of pieces) {
    const g = groups.find((gr) => Math.abs(gr[0].y - p.y) < Math.max(gr[0].h, p.h) * 0.4);
    if (g) g.push(p); else groups.push([p]);
  }
  // (Harakat reported on their own were already put back into their words: see attachMarks.)
  // Raised, smaller pieces (note markers) belong to the line they sit on.
  const sizeOf = (g: Piece[]) => median(g.map((p) => p.h));
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]; const sz = sizeOf(g);
    const host = groups.find((o) => o !== g && sizeOf(o) > sz * 1.15 && g[0].y > o[0].y && g[0].y - o[0].y < sizeOf(o) * 0.75 && g.every((p) => p.r > Math.min(...o.map((q) => q.l)) - sizeOf(o) * 3 && p.l < Math.max(...o.map((q) => q.r)) + sizeOf(o) * 3));
    if (host) { g.forEach((p) => { p.sup = true; }); host.push(...g); groups.splice(i, 1); }
  }
  return groups.map((g) => {
    const normal = g.filter((p) => !p.sup);
    const base = median(normal.map((p) => p.y));
    const size = median(normal.flatMap((p) => Array(Math.max(1, Math.round(p.text.length))).fill(p.h)));
    const text = g.map((p) => p.text).join('');
    return { pieces: g, base, size, l: Math.min(...g.map((p) => p.l)), r: Math.max(...g.map((p) => p.r)), rtl: isRtlText(text) };
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
    if (left.length + right.length + midNums.length === ps.length && span(left) > width * 0.25 && span(right) > width * 0.25 && gapL > line.size * 0.6 && gapR > line.size * 0.6) {
      const all = line.pieces;
      return [all.filter((p) => p.l >= nr - 1 && !midNums.includes(p)), all.filter((p) => p.r <= nl + 1 && !midNums.includes(p)), midNums];
    }
  }
  let best = -1, bestGap = 0;
  let edge = ps[0].r;
  for (let i = 1; i < ps.length; i++) { const gap = ps[i].l - edge; if (gap > bestGap) { bestGap = gap; best = i; } edge = Math.max(edge, ps[i].r); }
  if (best < 0 || bestGap < line.size * 0.75) return null;
  const left = ps.slice(0, best), right = ps.slice(best);
  const gapMid = (Math.max(...left.map((p) => p.r)) + Math.min(...right.map((p) => p.l))) / 2;
  const lw = Math.max(...left.map((p) => p.r)) - Math.min(...left.map((p) => p.l)), rw = Math.max(...right.map((p) => p.r)) - Math.min(...right.map((p) => p.l));
  // A wide gap near the middle, or a narrower one right at the centre with two long halves.
  const wideGap = bestGap >= Math.max(line.size * 1.5, width * 0.045) && Math.abs(gapMid - mid) <= width * 0.18 && lw >= width * 0.3 && rw >= width * 0.3;
  const centred = Math.abs(gapMid - mid) <= width * 0.03 && lw >= width * 0.35 && rw >= width * 0.35;
  if (!wideGap && !centred) return null;
  const all = line.pieces;
  const inLeft = (p: Piece) => p.r <= gapMid + 0.01;
  return [all.filter((p) => !inLeft(p)), all.filter(inLeft), []];
}

function runsOf(pieces: Piece[], fonts: Map<string, FontInfo>, rtlLine: boolean): Run[] {
  // Order and space the pieces like the copy text does, then merge neighbours with the same look.
  const ordered: { p: Piece; space: boolean }[] = [];
  const marked = pieces.some((p) => p.text === '\u2009');
  const sorted = [...pieces].sort((a, b) => (rtlLine ? b.l - a.l || b.r - a.r : a.l - b.l || a.r - b.r));
  let prev: Piece | null = null; let pendingSpace = false;
  for (const p of sorted) {
    if (p.text === '\u2009') { pendingSpace = true; continue; }
    if (!p.text.trim()) { pendingSpace = true; continue; }
    let space = pendingSpace;
    if (prev && !marked) { const gap = rtlLine ? prev.l - p.r : p.l - prev.r; if (gap > Math.min(prev.h, p.h) * 0.18) space = true; }
    if (COMBINING.test(p.text[0])) space = false;
    ordered.push({ p, space: space && ordered.length > 0 });
    pendingSpace = false;
    prev = prev && (rtlLine ? p.l > prev.l : p.r < prev.r) ? { ...p, l: Math.min(prev.l, p.l), r: Math.max(prev.r, p.r) } : p;
  }
  const runs: Run[] = [];
  for (const { p, space } of ordered) {
    const f = fonts.get(p.font) ?? { family: 'Times New Roman', bold: false, italic: false };
    // A piece stored in drawing order (mark before its letter) reads in logical order through joinLine.
    const text = joinLine([{ text: p.text, l: p.l, r: p.r, h: p.h }]).text;
    const look: Omit<Run, 'text'> = { font: f.family, size: Math.round(p.h * 2) / 2, bold: f.bold || p.bold, italic: f.italic, color: p.color, rtl: isRtlText(text) || (rtlLine && !/[A-Za-z0-9]/.test(text)), sup: !!p.sup };
    const last = runs[runs.length - 1];
    if (space && last) last.text += ' ';
    if (last && last.font === look.font && last.size === look.size && last.bold === look.bold && last.italic === look.italic && last.color === look.color && last.sup === look.sup && last.rtl === look.rtl) last.text += text;
    else if (space && last && last.text.endsWith(' ')) runs.push({ ...look, text });
    else runs.push({ ...look, text });
  }
  for (const r of runs) r.text = r.text.replace(/\s+(?=[\u064B-\u065F\u0670])/g, '').replace(/([\u060C\u061B\u061F.,:;!)(»«\]\[]+)([\u064B-\u065F\u0670]+)/g, '$2$1').replace(/\s{2,}/g, ' ');
  return runs.filter((r) => r.text.length);
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
    const pitch = ls.length > 1 ? median(ls.slice(1).map((l, i) => ls[i].base - l.base)) : pitchOf(size);
    let align: Para['align'];
    if (ls.every(centered)) align = 'center';
    else if (ls.length > 1 && ls.slice(0, -1).every((l, i) => (i === 0 ? endGap(l) < tolOf(l) : full(l)))) align = 'both';
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
    const kashida = align === 'both' && rtl && runs.some((r) => /\u0640/.test(r.text));
    if (kashida) for (const r of runs) r.text = r.text.replace(/\u0640+/g, '');
    blocks.push({ kind: 'p', runs, align, kashida, rtl, indStart, indEnd, firstLine, before, pitch, size });
    prevBase = ls[ls.length - 1].base; prevPitch = pitch;
    cur = null;
  };
  let verse: Verse | null = null;
  const closeVerse = () => { if (verse) blocks.push(verse); verse = null; };
  for (const line of lines) {
    const halves = splitVerse(line, L, R);
    if (halves) {
      closePara();
      const rtl = line.rtl;
      const midRuns = halves[2].length ? runsOf(halves[2], fonts, rtl) : null;
      const first = rtl ? halves[0] : halves[1], second = rtl ? halves[1] : halves[0];
      const row: Run[][] = midRuns ? [runsOf(first, fonts, rtl), midRuns, runsOf(second, fonts, rtl)] : [runsOf(first, fonts, rtl), runsOf(second, fonts, rtl)];
      const midW = halves[2].length ? Math.max(...halves[2].map((p) => p.r)) - Math.min(...halves[2].map((p) => p.l)) + line.size : 0;
      const ext = (a: Piece[]) => (a.length ? [Math.min(...a.map((p) => p.l)), Math.max(...a.map((p) => p.r))] : [0, 0]);
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
        || (startGap(line) > startGap(last) + tolOf(line) && full(last) && !(cur.lines.length === 1 && /^\s*[(（[]?[0-9\u0660-\u0669\u06F0-\u06F9]+[)）\].\-–]/.test(joinLine(last.pieces.map((p) => ({ text: p.text, l: p.l, r: p.r, h: p.h }))).text)))
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

async function analysePage(pdfjs: PdfJs, page: import('pdfjs-dist').PDFPageProxy, fonts: Map<string, FontInfo>, withGraphics: boolean): Promise<PageModel> {
  const [, , W, H] = page.view;
  const ol = await page.getOperatorList();
  const tc = await page.getTextContent();
  const pieces: Piece[] = [];
  for (const it of tc.items as { str: string; transform: number[]; width: number; height: number; fontName: string; color?: string; fakeBold?: boolean; strokeEm?: number }[]) {
    if (typeof it.str !== 'string') continue;
    let text = cleanPdfText(it.str);
    if (/^\u2009+$/.test(text)) text = '\u2009'; else if (!text.trim()) continue;
    const [a, b, , , e, f] = it.transform;
    const h = it.height || Math.hypot(a, b) || 10;
    // Fill+stroke "bold": Word's own synthetic bold strokes about 1/35 em; a much thinner stroke is
    // not bold in Word's terms (setting bold would draw it heavier than the page shows).
    pieces.push({ text, l: e, r: e + it.width, y: f, h, font: it.fontName, color: it.color || '000000', bold: !!it.fakeBold && (it.strokeEm ?? 0.03) >= 0.014 });
    if (it.fontName && !fonts.has(it.fontName)) {
      let fo: { name?: string; bold?: boolean; black?: boolean; italic?: boolean; krRaw?: Uint8Array; krNoToUnicode?: boolean; isSymbolicFont?: boolean } | null = null;
      try { fo = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null; } catch { /* not loaded */ }
      const info: FontInfo = { ...parseFontName(fo?.name, fo), raw: fo?.krRaw, noUnicode: !!fo?.krNoToUnicode, symbolic: !!fo?.isSymbolicFont };
      // The font file says whether it is a bold (or italic) face.
      const os2 = fo?.krRaw ? readOs2(fo.krRaw) : null;
      if (os2) { info.weight = os2.weight; if (os2.weight >= 600 || os2.bold) info.bold = true; if (os2.italic) info.italic = true; }
      // The font's own family name is what Word looks for ("KFGQPC Uthman Taha Naskh", not its PostScript name).
      const own = fo?.krRaw ? fontFamilyName(fo.krRaw) : null;
      if (own) info.family = own.replace(/\s+(Regular)$/i, '');
      else if (!/\s/.test(info.family)) info.family = info.family.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D fontname', fo?.name, '→', info.family, '| own:', own);
      fonts.set(it.fontName, info);
    }
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
    keepFonts.add(p.font); pieces.splice(i, 1);
  }
  const lines = buildLines(attachMarks(pieces).filter((p) => !/^[\u064B-\u065F\u0670\u06D6-\u06ED\s]+$/.test(p.text) || p.text === "\u2009"));
  const textLines = lines.filter((l) => l.pieces.some((p) => p.text.trim() && p.text !== '\u2009'));
  // Typical baseline-to-baseline pitch for a given size, measured on this page.
  const pitches = new Map<number, number[]>();
  textLines.forEach((l, i) => { const n = textLines[i + 1]; if (n && Math.abs(n.size - l.size) < l.size * 0.1) { const d = l.base - n.base; if (d > l.size * 0.9 && d < l.size * 2.6) { const k = Math.round(l.size); pitches.set(k, [...(pitches.get(k) ?? []), d]); } } });
  const pitchOf = (size: number) => { const p = pitches.get(Math.round(size)); return p?.length ? median(p) : size * 1.65; };
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
  const cutTop = (i: number) => body[i].base > H * 0.88 && body[i].base - body[i + 1].base > pitchOf(body[i + 1].size) * 1.2 && sparse(body[i]);
  while (body.length > 1 && header.length < 3 && cutTop(0)) header.push(body.shift()!);
  const cutBottom = (i: number) => body[i].base < H * 0.08 && body[i - 1].base - body[i].base > pitchOf(body[i].size) * 1.2 && sparse(body[i]);
  while (body.length > 1 && footer.length < 2 && cutBottom(body.length - 1)) footer.unshift(body.pop()!);
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
    const near = vals.filter((x) => Math.abs(x - best) <= tol);
    return outer(1, 0) ? Math.max(...near) : Math.min(...near);
  };
  const L = edge(ref.map((l) => l.l), (a, b) => a < b, W * 0.1);
  const R = edge(ref.map((l) => l.r), (a, b) => a > b, W * 0.9);
  const bodySize = median(body.flatMap((l) => Array(Math.max(1, l.pieces.reduce((n, p) => n + p.text.length, 0))).fill(l.size))) || 12;
  if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D page', JSON.stringify({ W, H, L, R, bodySize, rule, lines: textLines.map((l) => ({ b: +l.base.toFixed(1), s: +l.size.toFixed(1), l: +l.l.toFixed(1), r: +l.r.toFixed(1), z: header.includes(l) ? 'H' : footer.includes(l) ? 'F' : notesLines.includes(l) ? 'N' : 'B', t: l.pieces.map((p) => p.text).join('|').slice(0, 60), ps: l.pieces.map((p) => [p.text.slice(0, 12), +p.l.toFixed(0), +p.r.toFixed(0), +p.y.toFixed(1), +p.h.toFixed(1)]), gaps: l.pieces.filter((p) => p.text.trim()).sort((x, y) => x.l - y.l).map((p, i, a) => (i ? +(p.l - a[i - 1].r).toFixed(1) : 0)).filter((g) => g > 8) })) }));
  const bodyBlocks = buildBlocks(body, fonts, L, R, pitchOf, null);
  // Running heads and page numbers: each line pinned to the page in a frame centred on where its glyphs
  // are, so a font's slightly different width cannot move it out of its ornament.
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
  const headerBlocks: Block[] = [];
  const footerBlocks: Block[] = [];
  // Footnotes, split at their numbers (and kept whole, for pages whose notes cannot be Word footnotes).
  // In the page's flow the notes follow the text at the distance the page has between them.
  const notesRaw = buildBlocks(notesLines, fonts, L, R, pitchOf, body.length ? body[body.length - 1].base : null);
  const notesBox = notesLines.length ? { top: H - (rule ? rule.y : notesLines[0].base + notesLines[0].size), bottom: H - notesLines[notesLines.length - 1].base + notesLines[notesLines.length - 1].size * 0.4, l: L, r: R } : null;
  const notes: Note[] = [];
  for (const b of buildBlocks(notesLines, fonts, L, R, pitchOf, null)) {
    if (b.kind !== 'p') continue;
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
  const pics = withGraphics ? await renderGraphics(page, 2, keepFonts).catch(() => [] as Pic[]) : [];
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
  const pages: PageModel[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    progress('pdfPage', Math.round((p / doc.numPages) * 80));
    const page = await doc.getPage(p);
    pages.push(await analysePage(pdfjs, page, fonts, true));
    if (p % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await task.destroy();
  progress('build', 85);

  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, LineRuleType, FootnoteReferenceRun, Header, Footer, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType, SectionType, TableLayoutType, CharacterSet, Tab, TabStopType } = docx;

  const usedChars = new Map<string, Set<number>>();
  const runFor = (r: Run, footnotes: Map<number, number> | null) => {
    if (r.note !== undefined && footnotes?.has(r.note) && !r.br) return new FootnoteReferenceRun(footnotes.get(r.note)!);
    const key = `${r.font}|${r.bold && r.italic ? 'BoldItalic' : r.bold ? 'Bold' : r.italic ? 'Italic' : 'Regular'}`;
    let set = usedChars.get(key); if (!set) usedChars.set(key, set = new Set());
    for (const ch of r.text) set.add(ch.codePointAt(0)!);
    const half = Math.max(2, Math.round(r.size * 2));
    return new TextRun({
      text: r.text,
      break: r.br ? 1 : undefined,
      font: { ascii: r.font, hAnsi: r.font, cs: r.font, eastAsia: r.font },
      size: half, sizeComplexScript: half,
      bold: r.bold, boldComplexScript: r.bold, italics: r.italic, italicsComplexScript: r.italic,
      color: r.color && r.color !== '000000' ? r.color : undefined,
      rightToLeft: r.rtl || undefined,
      superScript: r.sup ? true : undefined,
    });
  };
  const alignOf = (a: Para['align'], kashida = false) => (a === 'center' ? AlignmentType.CENTER : a === 'both' ? (kashida ? AlignmentType.MEDIUM_KASHIDA : AlignmentType.BOTH) : a === 'end' ? AlignmentType.END : AlignmentType.START);
  const markRun = (b: { runs?: Run[]; rtl: boolean; size: number }) => {
    const r = b.runs?.find((x) => x.text.trim()); const half = Math.max(2, Math.round((r?.size ?? b.size) * 2));
    return r ? { font: { ascii: r.font, hAnsi: r.font, cs: r.font, eastAsia: r.font }, size: half, sizeComplexScript: half, rightToLeft: b.rtl || undefined } : { size: half, sizeComplexScript: half, rightToLeft: b.rtl || undefined };
  };
  const paraFor = (b: Para, footnotes: Map<number, number> | null, extra: { before?: number } = {}) => new Paragraph({
    bidirectional: b.rtl,
    run: markRun(b),
    widowControl: false,
    alignment: alignOf(b.align, b.kashida),
    indent: { start: Math.round(b.indStart * PT), end: Math.round(b.indEnd * PT), ...(b.firstLine >= 0 ? { firstLine: Math.round(b.firstLine * PT) } : { hanging: Math.round(-b.firstLine * PT) }) },
    spacing: { before: Math.round((extra.before ?? b.before) * PT), after: 0, line: Math.round(b.pitch * PT), lineRule: LineRuleType.EXACT },
    children: b.runs.map((r) => runFor(r, footnotes)),
  });
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
            alignment: cols === 3 && c === 1 ? AlignmentType.CENTER : AlignmentType.DISTRIBUTE,
            widowControl: false,
            spacing: { before: i === 0 ? Math.round(v.before * PT) : 0, after: 0, line: Math.round(v.pitch * PT), lineRule: LineRuleType.EXACT },
            children: runs.map((r) => runFor({ ...r, text: r.text.replace(/\u0640+/g, '') }, footnotes)),
          })],
        })),
      })),
    });
  };
  const blocksFor = (bs: Block[], footnotes: Map<number, number> | null) => bs.map((b) => (b.kind === 'p' ? paraFor(b, footnotes) : verseFor(b, footnotes)));

  const footnoteDefs: Record<number, { children: InstanceType<typeof Paragraph>[] }> = {};
  let noteId = 1;
  const sections = pages.map((pg) => {
    const map = new Map<number, number>();
    // Real Word footnotes when every note is numbered and called from the text; otherwise the note area
    // is placed as a block exactly where the page has it.
    const allCalled = REAL_FOOTNOTES && pg.notes.length > 0 && pg.notes.every((n) => n.num >= 0 && pg.body.some((b) => (b.kind === 'p' ? [b.runs] : b.rows.flat()).some((rs) => rs.some((r) => r.note === n.num))));
    for (const n of allCalled ? pg.notes : []) {
      if (n.num < 0 || map.has(n.num)) continue;
      const referenced = pg.body.some((b) => (b.kind === 'p' ? [b.runs] : b.rows.flat()).some((rs) => rs.some((r) => r.note === n.num)));
      if (!referenced) continue;
      map.set(n.num, noteId);
      footnoteDefs[noteId] = { children: n.paras.map((p) => paraFor(p, null, { before: 0 })) };
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
    const children = [...blocksFor(pg.body, map), ...blocksFor(flowNotes, null)];
    const bottom = pg.m.bottom;
    if (!children.length) children.push(new Paragraph({ children: [] }));
    return {
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: { width: Math.round(pg.w * PT), height: Math.round(pg.h * PT) }, margin: { top: Math.round(pg.m.top * PT), bottom: Math.round(bottom * PT), left: Math.round(pg.m.left * PT), right: Math.round(pg.m.right * PT), header: Math.round(pg.m.header * PT), footer: Math.round(footerDist * PT), gutter: 0 } },
      },
      headers: { default: new Header({ children: headerChildren.length ? headerChildren : [new Paragraph({ children: [] })] }) },
      footers: footerChildren.length ? { default: new Footer({ children: footerChildren }) } : undefined,
      children,
    };
  });

  // Embed the PDF's own fonts — each face (regular, bold, …) under its family — where they can draw
  // every character used with them in that style.
  type Face = 'Regular' | 'Bold' | 'Italic' | 'BoldItalic';
  const faceOf = (bold: boolean, italic: boolean): Face => (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular');
  const faces = new Map<string, Map<Face, Uint8Array>>();
  for (const f of fonts.values()) {
    if (!f.raw) continue;
    const face = faceOf(f.bold && (f.weight ?? 400) >= 600, f.italic);
    const used = usedChars.get(`${f.family}|${face}`); if (!used?.size) continue;
    const cov = (f.cov ??= cmapCoverage(f.raw));
    let ok = 0, total = 0;
    for (const c of used) { if (c <= 0x20 || COMBINING.test(String.fromCodePoint(c))) continue; total++; if (cov.has(c)) ok++; }
    if ((globalThis as { krDebugP2D?: boolean }).krDebugP2D) console.warn('P2D font', f.family, face, ok, '/', total);
    if (!total || ok / total < 0.97) continue; // a missing character or two falls back in Word
    let m = faces.get(f.family); if (!m) faces.set(f.family, m = new Map());
    if (!m.has(face)) m.set(face, f.raw);
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

  const rtlDoc = pages.flatMap((p) => p.body).filter((b) => b.rtl).length > pages.flatMap((p) => p.body).length / 2;
  const d = new Document({
    creator: 'KurokawaReader', title: book.title,
    fonts: embedded.length ? (embedded as never) : undefined,
    footnotes: footnoteDefs,
    styles: { default: { document: { run: { font: rtlDoc ? { ascii: 'Times New Roman', cs: 'Traditional Arabic', hAnsi: 'Times New Roman', eastAsia: 'Times New Roman' } : 'Times New Roman' }, paragraph: { spacing: { after: 0 } } } } },
    sections,
  });
  progress('build', 92);
  let blob = await Packer.toBlob(d);
  blob = await finishDocx(blob, rtlDoc, extraFaces, sigs);
  progress('build', 100);
  return blob;
}

/** Word details the library has no option for: right-to-left sections, footnote numbers restart on each page. */
async function finishDocx(blob: Blob, rtl: boolean, extraFaces: { family: string; face: string; data: Uint8Array }[] = [], sigs = new Map<string, Os2>()): Promise<Blob> {
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
