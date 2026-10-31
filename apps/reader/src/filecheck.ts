// A downloaded file looked at before it goes into the library: a web page in its place (a site's check, a
// sign-in, an error page sent with "200 OK"), nothing at all, or a file that stopped short — an EPUB, a CBZ, an
// Office file whose zip has no end ("Can't find end of central directory"), a file smaller than the site said.

export type FileFault = 'empty' | 'page' | 'cut';

/** Zip packages: the file's last part holds the directory of its contents. */
const ZIPS = /\.(epub|kepub|cbz|zip|docx|xlsx|pptx|odt|ods|odp|apkg|3mf)$/i;
/** Files that are pages themselves (a web page in their place is no fault). */
const PAGES = /\.(html?|xhtml|htm|xml|txt|md|svg|json|csv|srt|vtt|ass)$/i;

const ascii = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };

/** What is wrong with a downloaded file, or null when it looks whole. `size`: the size the site gave, if any. */
export async function fileFault(file: Blob, name: string, size?: number): Promise<FileFault | null> {
  if (!file.size) return 'empty';
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const start = ascii(head).replace(/^﻿|^ï»¿/, '').trimStart().slice(0, 300).toLowerCase();
  if (!PAGES.test(name) && /^(<!doctype html|<html|<head|<body|<\?xml[^>]*>\s*<html|<!--)/.test(start)) return 'page';
  if (ZIPS.test(name)) {
    if (head[0] !== 0x50 || head[1] !== 0x4b) return start.startsWith('<') ? 'page' : 'cut';
    // (The end-of-directory record: within the last 64 KB and 22 bytes — the most a zip's comment can take.)
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
    let found = false;
    for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { found = true; break; }
    if (!found) return 'cut';
  }
  if (/\.pdf$/i.test(name) && !ascii(head).includes('%PDF')) return start.startsWith('<') ? 'page' : 'cut';
  // (Smaller than the site said — by more than its rounding.)
  if (size && size > 4096 && file.size < size * 0.97) return 'cut';
  return null;
}
