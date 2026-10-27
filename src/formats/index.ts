import type { Format } from '../db';
import type { Handler, FlowHandler, BookMeta } from './types';
import { titleFromFileName } from './types';
import { epubHandler } from './epub';
import { docxHandler } from './docx';
import { xlsxHandler, csvHandler } from './sheet';
import { pptxHandler } from './pptx';
import { txtHandler, mdHandler, htmlHandler } from './text';
import { fb2Handler, odtHandler, cbzHandler, imageHandler } from './misc';
import { pdfMeta } from './pdf';
import { mobiHandler } from './mobi';
import { readAudioMeta } from './audio';
import { shamelaHandler } from './shamela';
import { prewarmEpub } from './epub';

/**
 * Warm up what opening `book` will need, while the library is idle: the parsed EPUB
 * package, or the pdf.js chunk and worker. Cheap, and makes the next open feel instant.
 */
export function prewarm(book: { id: string; format: Format }, getFile: () => Promise<Blob | undefined>): void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  const idle = (fn: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(fn, { timeout: 2500 }) : window.setTimeout(fn, 400));
  idle(() => {
    if (book.format === 'pdf') { void import('./pdf').then((m) => m.loadPdfjs()).catch(() => {}); return; }
    if (book.format === 'epub') void getFile().then((f) => { if (f) prewarmEpub(f, book.id); }).catch(() => {});
  });
}

const EXT: Record<string, Format> = {
  epub: 'epub', pdf: 'pdf', docx: 'docx', docm: 'docx', dotx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', csv: 'csv', tsv: 'csv', pptx: 'pptx', ppsx: 'pptx',
  txt: 'txt', text: 'txt', log: 'txt', md: 'md', markdown: 'md', html: 'html', htm: 'html', xhtml: 'html', fb2: 'fb2', odt: 'odt', cbz: 'cbz',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', bmp: 'image',
  mobi: 'mobi', azw: 'mobi', azw3: 'mobi', kf8: 'mobi', prc: 'mobi',
  apkg: 'anki', colpkg: 'anki',
  mp3: 'audio', m4a: 'audio', m4b: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', flac: 'audio', wav: 'audio',
};

export function detectFormat(fileName: string, mime?: string): Format {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (EXT[ext]) return EXT[ext];
  if (mime) {
    if (mime.includes('epub')) return 'epub';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.includes('wordprocessingml')) return 'docx';
    if (mime.includes('spreadsheetml')) return 'xlsx';
    if (mime.includes('presentationml')) return 'pptx';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.includes('mobipocket') || mime.includes('kindle') || mime.includes('x-mobi8')) return 'mobi';
    if (mime.includes('anki')) return 'anki';
    if (mime === 'text/markdown') return 'md';
    if (mime === 'text/html') return 'html';
    if (mime === 'text/csv') return 'csv';
    if (mime.startsWith('text/')) return 'txt';
  }
  return 'unknown';
}

/** Sniff the first bytes when the extension is missing or lying. */
export async function sniffFormat(file: Blob, fileName: string): Promise<Format> {
  const byName = detectFormat(fileName.replace(/\.bin$/i, ''), file.type);
  if (byName !== 'unknown' && byName !== 'txt') return byName;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (String.fromCharCode(...new Uint8Array(await file.slice(60, 68).arrayBuffer())) === 'BOOKMOBI') return 'mobi';
  if (ascii.startsWith('ID3') || ascii.startsWith('fLaC') || ascii.startsWith('OggS') || (ascii.slice(4, 8) === 'ftyp' && /M4[AB]|mp4|isom/.test(ascii.slice(8, 12)))) return 'audio';
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // Some zip: look inside for the tell-tale parts.
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(file);
      const names = Object.keys(zip.files);
      if (names.some((n) => n.startsWith('collection.anki2'))) return 'anki';
      if (names.some((n) => n === 'mimetype' || n.startsWith('META-INF/container.xml'))) return 'epub';
      if (names.some((n) => n.startsWith('word/'))) return 'docx';
      if (names.some((n) => n.startsWith('xl/'))) return 'xlsx';
      if (names.some((n) => n.startsWith('ppt/'))) return 'pptx';
      if (names.some((n) => n === 'content.xml')) return 'odt';
      if (names.some((n) => /\.(jpe?g|png|webp)$/i.test(n))) return 'cbz';
    } catch { /* ignore */ }
  }
  if (/^\xff\xd8|^\x89PNG|^GIF8|^RIFF/.test(ascii)) return 'image';
  if (ascii.trimStart().startsWith('<')) {
    const text = await file.slice(0, 2000).text();
    if (/<FictionBook/i.test(text)) return 'fb2';
    if (/<html|<!doctype html/i.test(text)) return 'html';
  }
  return byName === 'unknown' ? 'txt' : byName;
}

const HANDLERS: Partial<Record<Format, Handler>> = {
  epub: epubHandler, docx: docxHandler, xlsx: xlsxHandler, csv: csvHandler, pptx: pptxHandler,
  txt: txtHandler, md: mdHandler, html: htmlHandler, fb2: fb2Handler, odt: odtHandler, cbz: cbzHandler, image: imageHandler,
  pdf: { kind: 'pdf', format: 'pdf', readMeta: pdfMeta },
  mobi: mobiHandler,
  shamela: shamelaHandler,
  anki: { kind: 'deck', format: 'anki', readMeta: async (file) => { const { deckMeta } = await import('../anki'); const m = await deckMeta(file); return { title: m.title, pageCount: m.cards }; } },
  audio: { kind: 'audio', format: 'audio', readMeta: async (file, name) => { const m = await readAudioMeta(file, name); return { title: m.title, author: m.author, cover: m.cover }; } },
};

export function handlerFor(format: Format): Handler | undefined {
  return HANDLERS[format];
}

export function flowHandlerFor(format: Format): FlowHandler | undefined {
  const h = HANDLERS[format];
  return h && h.kind === 'flow' ? h : undefined;
}

export async function readMeta(file: Blob, fileName: string, format: Format): Promise<BookMeta> {
  const h = HANDLERS[format];
  if (!h) return { title: titleFromFileName(fileName) };
  try {
    const m = await h.readMeta(file, fileName);
    return { ...m, title: m.title?.trim() || titleFromFileName(fileName) };
  } catch (err) {
    console.warn('[kurokawa] metadata failed for', fileName, err);
    return { title: titleFromFileName(fileName) };
  }
}

export const SUPPORTED_ACCEPT = '.epub,.pdf,.docx,.docm,.xlsx,.xlsm,.csv,.tsv,.pptx,.ppsx,.txt,.md,.markdown,.html,.htm,.xhtml,.fb2,.odt,.cbz,.jpg,.jpeg,.png,.gif,.webp,.avif,.svg,.bmp,application/epub+zip,application/pdf,text/*,image/*,.mobi,.azw,.azw3,.kf8,.prc,.apkg,.colpkg,.mp3,.m4a,.m4b,.aac,.ogg,.oga,.opus,.flac,.wav,audio/*';
