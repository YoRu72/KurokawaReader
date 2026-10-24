// Reading the text in pictures (OCR), on the device: Tesseract (tesseract.js, WebAssembly, in its own worker
// thread) with its compact ("fast") Arabic and English models, shipped with the app — nothing is sent anywhere.
// Arabic and English each have their own worker (one model for both reads Arabic much worse).
import type { Worker as TWorker } from 'tesseract.js';

export type OcrLang = 'ara' | 'eng';
export type OcrResult = { text: string; confidence: number; lang: OcrLang; pdf?: Uint8Array };

const BASE = new URL('./ocr/', import.meta.url).href;
const workers = new Map<OcrLang, Promise<TWorker>>();
let idleTimer = 0;

let available: Promise<boolean> | null = null;
/** Whether the app was built with the reading models (a build without them simply has no OCR). */
export function ocrAvailable(): Promise<boolean> {
  available ??= fetch(`${BASE}lang/ara.traineddata`, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  return available;
}

async function simd(): Promise<boolean> {
  // (The smallest module using a SIMD instruction: validates only where SIMD is supported.)
  try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; }
}

function worker(lang: OcrLang): Promise<TWorker> {
  let w = workers.get(lang);
  if (!w) {
    w = (async () => {
      // (A CommonJS package: its exports may come as the module's default.)
      const m = await import('tesseract.js') as unknown as typeof import('tesseract.js') & { default?: typeof import('tesseract.js') };
      const { createWorker, OEM } = m.default ?? m;
      const core = (await simd()) ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
      const tw = await createWorker(lang, OEM.LSTM_ONLY, {
        workerPath: `${BASE}worker.js`, corePath: `${BASE}core/${core}`, langPath: `${BASE}lang`,
        gzip: false, cacheMethod: 'none', workerBlobURL: false,
      });
      // Lines kept as blocks of their own (PSM 4: a page of lines); left: the spaces as Tesseract sees them
      // (keeping them joins the last two Arabic words of a line).
      await tw.setParameters({ tessedit_pageseg_mode: (lang === 'eng' ? '6' : '4') as never });
      return tw;
    })();
    workers.set(lang, w);
    w.catch(() => workers.delete(lang));
  }
  return w;
}

/** Workers are let go of a minute after the last reading (each holds tens of megabytes). */
function scheduleRelease(): void {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => { for (const [k, w] of workers) { void w.then((x) => x.terminate()).catch(() => undefined); workers.delete(k); } }, 60_000);
}

const clean = (s: string) => s.replace(/[‎‏‪-‮]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const arabicShare = (s: string) => { const letters = s.match(/\p{L}/gu)?.length ?? 0; const ar = s.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g)?.length ?? 0; return letters ? ar / letters : 0; };

/**
 * The picture at a size Tesseract reads best (print about 30–40 pixels tall): a scan from the camera is enlarged
 * when its page is narrower than about 2000 pixels.
 */
async function prepared(img: Blob | HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  const bmp = await createImageBitmap(img as Blob);
  const k = clamp(2000 / Math.max(1, Math.min(bmp.width, bmp.height * 0.75)), 1, 1.8);
  const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  const g = c.getContext('2d', { willReadFrequently: true })!; g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  // Grey as the darkest of the three colours: print in colour (red or green headings, a blue verse) reads as dark
  // as black print — plain greyscale makes red print pale.
  const id = g.getImageData(0, 0, c.width, c.height); const d = id.data;
  for (let i = 0; i < d.length; i += 4) { const m = Math.min(d[i], d[i + 1], d[i + 2]); d[i] = d[i + 1] = d[i + 2] = m; }
  g.putImageData(id, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

type Line = { text: string; confidence: number };
/** The lines read, without the noise read in pictures, rules and stains (lines hardly letters, or read unsurely). */
function goodText(blocks: unknown, fallback: string): string {
  const lines: Line[] = [];
  const walk = (o: unknown) => { if (!o || typeof o !== 'object') return; const r = o as { lines?: Line[]; paragraphs?: unknown[] }; if (Array.isArray(r.paragraphs)) for (const p of r.paragraphs) { const pl = (p as { lines?: Line[] }).lines; if (pl) lines.push(...pl); lines.push({ text: '', confidence: 100 }); } };
  if (Array.isArray(blocks)) for (const b of blocks) walk(b); else return fallback;
  if (!lines.length) return fallback;
  return lines.filter((l) => {
    const t = l.text.trim(); if (!t) return true;
    // Noise reads as runs of one- and two-letter scraps, digits and marks; print as words.
    const toks = t.split(/\s+/).filter(Boolean); const wordy = toks.filter((x) => (x.match(/\p{L}/gu)?.length ?? 0) >= 3).length;
    const letters = t.match(/\p{L}/gu)?.length ?? 0, all = t.replace(/\s/g, '').length;
    return l.confidence >= 8 && letters >= all * 0.6 && wordy >= Math.max(1, toks.length * 0.4);
  }).map((l) => l.text.trim()).join('\n');
}

/** Read a picture in one language. With `pdf`, also a PDF page of the text alone (invisible), to lay over it. */
export async function recognize(img: Blob | HTMLCanvasElement | OffscreenCanvas, lang: OcrLang, opts: { pdf?: boolean } = {}): Promise<OcrResult> {
  window.clearTimeout(idleTimer);
  const w = await worker(lang);
  try {
    const input = await prepared(img);
    const { data } = await w.recognize(input as Blob, opts.pdf ? { pdfTitle: 'OCR', pdfTextOnly: true } as never : {}, { text: true, blocks: true, pdf: !!opts.pdf } as never);
    const pdf = (data as unknown as { pdf?: number[] | Uint8Array | null }).pdf;
    return { text: clean(goodText((data as unknown as { blocks?: unknown }).blocks, data.text ?? '')), confidence: data.confidence ?? 0, lang, pdf: pdf ? Uint8Array.from(pdf as ArrayLike<number>) : undefined };
  } finally { scheduleRelease(); }
}

/**
 * Read a picture in whichever of Arabic and English it is written: Arabic first; when what comes back is hardly
 * Arabic, English too, and the more confident reading is kept.
 */
export async function recognizeAuto(img: Blob | HTMLCanvasElement | OffscreenCanvas, opts: { pdf?: boolean; prefer?: OcrLang } = {}): Promise<OcrResult> {
  const first: OcrLang = opts.prefer ?? 'ara';
  const a = await recognize(img, first, opts);
  const share = arabicShare(a.text);
  const looksRight = first === 'ara' ? share >= 0.4 : share <= 0.2;
  if (looksRight && a.confidence >= 55) return a;
  const b = await recognize(img, first === 'ara' ? 'eng' : 'ara', opts);
  return b.confidence > a.confidence ? b : a;
}
