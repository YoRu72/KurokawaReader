// A file's format by its name (or its MIME type), and the kinds the file picker offers: the little the library
// needs at start, kept apart from the format readers themselves (fetched when a book is added or opened).
import type { Format } from '../db';

const EXT: Record<string, Format> = {
  epub: 'epub', pdf: 'pdf', docx: 'docx', docm: 'docx', dotx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', csv: 'csv', tsv: 'csv', pptx: 'pptx', ppsx: 'pptx',
  txt: 'txt', text: 'txt', log: 'txt', md: 'md', markdown: 'md', html: 'html', htm: 'html', xhtml: 'html', fb2: 'fb2', odt: 'odt', cbz: 'cbz',
  // (Comics in other archives — RAR, 7-Zip, tar: told by their content on import, then kept as a CBZ: src/comic/repack.ts.)
  cbr: 'cbz', rar: 'cbz', cb7: 'cbz', '7z': 'cbz', cbt: 'cbz', tar: 'cbz', tgz: 'cbz', txz: 'cbz', tbz: 'cbz', tbz2: 'cbz',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', bmp: 'image',
  mobi: 'mobi', azw: 'mobi', azw3: 'mobi', kf8: 'mobi', prc: 'mobi',
  apkg: 'anki', colpkg: 'anki',
  mp3: 'audio', m4a: 'audio', m4b: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', flac: 'audio', wav: 'audio',
};

export function detectFormat(fileName: string, mime?: string): Format {
  if (/\.tar\.(gz|xz|bz2)$/i.test(fileName)) return 'cbz';
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

export const SUPPORTED_ACCEPT = '.epub,.pdf,.docx,.docm,.xlsx,.xlsm,.csv,.tsv,.pptx,.ppsx,.txt,.md,.markdown,.html,.htm,.xhtml,.fb2,.odt,.cbz,.cbr,.rar,.cb7,.7z,.cbt,.tar,.tgz,.txz,.tbz2,.tar.gz,.tar.xz,.tar.bz2,.jpg,.jpeg,.png,.gif,.webp,.avif,.svg,.bmp,application/epub+zip,application/pdf,text/*,image/*,.mobi,.azw,.azw3,.kf8,.prc,.apkg,.colpkg,.mp3,.m4a,.m4b,.aac,.ogg,.oga,.opus,.flac,.wav,audio/*';
