// PDF tools: pictures into a PDF, PDFs merged into one, pages kept, removed, reordered or turned — always a
// new file, the original untouched. Encrypted PDFs open with their password (or none, when they only restrict
// printing and copying) and come out unencrypted. Text stays text: pages are copied, never re-rendered.
import { PDFDocument, degrees, type PDFPage } from 'pdf-lib';
import { openPdf } from './pdfcrypt';

/** `fit`: the picture's own size; `page`: as wide as A4 (or as tall, lying), its height following the picture. */
export type PageSize = 'fit' | 'page' | 'a4' | 'letter';
const SIZES: Record<Exclude<PageSize, 'fit' | 'page'>, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };

/** Bytes of a picture as JPEG or PNG (the two formats a PDF embeds directly), upright. */
async function pictureBytes(file: Blob): Promise<{ bytes: Uint8Array; kind: 'jpg' | 'png'; w: number; h: number }> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isJpeg = head[0] === 0xff && head[1] === 0xd8;
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  // A JPEG taken on a phone is often stored sideways with an orientation tag: those go through a canvas.
  const upright = isJpeg ? jpegOrientation(new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer())) <= 1 : true;
  if ((isJpeg && upright) || isPng) {
    const bmp = await createImageBitmap(file);
    const r = { bytes: new Uint8Array(await file.arrayBuffer()), kind: isJpeg ? 'jpg' as const : 'png' as const, w: bmp.width, h: bmp.height };
    bmp.close(); return r;
  }
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d')!;
  // (Transparent pictures keep their transparency as PNG; the rest become JPEG.)
  const alpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/gif';
  if (!alpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bmp, 0, 0); bmp.close();
  const out = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('image'))), alpha ? 'image/png' : 'image/jpeg', 0.92));
  return { bytes: new Uint8Array(await out.arrayBuffer()), kind: alpha ? 'png' : 'jpg', w: canvas.width, h: canvas.height };
}

/** The EXIF orientation of a JPEG (1 = upright), or 0 when it has none. */
export function jpegOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10; const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
      const ifd = t + u32(t + 4); const n = u16(ifd);
      for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) return u16(e + 8); }
      return 0;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return 0;
}

/** Pictures, in the order given, one per page. `fit`: each page the picture's own size; otherwise the paper
 *  size, turned to the picture's orientation, with the picture centred within the margin (points). */
/** Pictures as a PDF, a page each. `overlays`: for each picture, a PDF page of its text alone (invisible, from
 *  OCR) laid exactly over it, so the PDF can be searched and its text selected. */
export async function imagesToPdf(files: Blob[], opts: { size: PageSize; margin: number; overlays?: (Uint8Array | null | undefined)[] }, progress?: (done: number) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  let n = 0;
  for (const [fi, f] of files.entries()) {
    const p = await pictureBytes(f);
    const img = p.kind === 'jpg' ? await doc.embedJpg(p.bytes) : await doc.embedPng(p.bytes);
    // A picture is placed at 72 dpi-equivalent of its pixels at most 96 dpi: screenshots keep their size.
    const iw = p.w * 0.75, ih = p.h * 0.75;
    let page: PDFPage;
    let at: { x: number; y: number; width: number; height: number };
    if (opts.size === 'page') {
      // (A photographed page: a page's size whatever the camera's resolution.)
      const land = p.w > p.h; const k = (land ? 841.89 : 595.28) / p.w;
      page = doc.addPage([p.w * k + 2 * opts.margin, p.h * k + 2 * opts.margin]);
      at = { x: opts.margin, y: opts.margin, width: p.w * k, height: p.h * k };
    } else if (opts.size === 'fit') {
      page = doc.addPage([iw + 2 * opts.margin, ih + 2 * opts.margin]);
      at = { x: opts.margin, y: opts.margin, width: iw, height: ih };
    } else {
      const [a, b] = SIZES[opts.size]; const land = p.w > p.h;
      const W = land ? b : a, H = land ? a : b;
      page = doc.addPage([W, H]);
      const k = Math.min((W - 2 * opts.margin) / iw, (H - 2 * opts.margin) / ih);
      const w = iw * k, h = ih * k;
      at = { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h };
    }
    page.drawImage(img, at);
    const ov = opts.overlays?.[fi];
    if (ov) { try { const [text] = await doc.embedPdf(ov); page.drawPage(text, at); } catch { /* the picture alone */ } }
    progress?.(++n);
  }
  return doc.save();
}

export type Source = { name: string; bytes: Uint8Array; password?: string };

/** Open a PDF (decrypting it when it is encrypted). */
export async function loadPdf(s: Source): Promise<PDFDocument> {
  return openPdf(s.bytes, s.password ?? '');
}

/** Page count of a PDF. */
export async function pageCount(s: Source): Promise<number> {
  return (await loadPdf(s)).getPageCount();
}

/** Several PDFs, one after another, in the order given (each may be cut to some of its pages). */
export async function mergePdfs(parts: (Source & { pages?: number[] })[], progress?: (done: number) => void): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  let n = 0;
  for (const part of parts) {
    const src = await loadPdf(part);
    const idx = part.pages ?? src.getPageIndices();
    const copied = await out.copyPages(src, idx);
    copied.forEach((p) => out.addPage(p));
    progress?.(++n);
  }
  return out.save();
}

/** A new PDF of the given pages (0-based, in the order given; a page may repeat), each turned by its rotation
 *  (degrees, added to its own). Removing pages = keeping the others; extracting = keeping some; reordering =
 *  keeping all in another order. */
export async function pickPages(s: Source, pages: number[], rotate: Record<number, number> = {}): Promise<Uint8Array> {
  const src = await loadPdf(s);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pages);
  copied.forEach((p, i) => {
    const r = rotate[pages[i]] ?? 0;
    if (r) p.setRotation(degrees((((p.getRotation().angle + r) % 360) + 360) % 360));
    out.addPage(p);
  });
  // The document's own title and author travel with it.
  const title = src.getTitle(); if (title) out.setTitle(title);
  const author = src.getAuthor(); if (author) out.setAuthor(author);
  return out.save();
}

/** The same PDF without its encryption (and so without its printing / copying restrictions). */
export async function unlockPdf(s: Source): Promise<Uint8Array> {
  return (await loadPdf(s)).save();
}

/** "1-3, 5, 8-" → 0-based page numbers (in that order), for a document of `count` pages. */
/** Page indexes (0-based) written the short way: "1-3, 7, 10-12". */
export function formatRanges(pages: number[]): string {
  const ps = [...new Set(pages)].sort((a, b) => a - b); const out: string[] = [];
  for (let i = 0; i < ps.length;) { let j = i; while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++; out.push(j > i ? `${ps[i] + 1}-${ps[j] + 1}` : `${ps[i] + 1}`); i = j + 1; }
  return out.join(', ');
}

export function parseRanges(text: string, count: number): number[] {
  const out: number[] = [];
  const norm = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)).replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/[–—~〜～－]/g, '-').replace(/[،؛，、；;]/g, ',');
  for (const part of norm.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : count;
      const [lo, hi] = [Math.max(1, Math.min(a, b)), Math.min(count, Math.max(a, b))];
      const seq: number[] = []; for (let p = lo; p <= hi; p++) seq.push(p - 1);
      out.push(...(a > b ? seq.reverse() : seq));
    } else if (/^\d+$/.test(part)) { const p = +part; if (p >= 1 && p <= count) out.push(p - 1); }
  }
  return out;
}
