// A book of pictures as an ordered list of pages (the comic reader's source — src/views/comic.ts): a CBZ or any zip
// of pictures, or one picture alone. Nothing is read before it is asked for: a zip's directory is read from the end
// of the file (the file itself is never loaded whole — a 400 MB archive costs the few kilobytes of its directory),
// each page's bytes are a slice of the file (a stored entry: nothing copied) or that slice inflated as it is asked
// for, and a page's object URL is made when the viewer wants the page and let go when it is far from it. A zip the
// directory reader cannot follow (an odd or damaged one) is opened by JSZip, as before, entry by entry.
// Pages: picture entries in natural, case-insensitive order; folders' system files (__MACOSX, dot files, Thumbs.db)
// left out. Each folder holding pages is a chapter when there are two or more. Sizes come from the pictures' headers
// (src/imagesize.ts), else from decoding them once, and are kept per book (meta `comic:<id>`).
import { imageSize } from '../imagesize';

export interface ComicPage {
  index: number;
  /** The entry's path in the archive (or the file's name). */
  name: string;
  width?: number;
  height?: number;
  /** The chapter (a folder) the page is in. */
  chapter: number;
  blob(): Promise<Blob>;
}
export interface ComicChapter { label: string; start: number }

export interface PageSource {
  pages: ComicPage[];
  chapters: ComicChapter[];
  /** The page's object URL, made now if it has none. */
  url(i: number): Promise<string>;
  /** Let go of every page's URL farther than `radius` pages from any of the `keep` pages. */
  keepNear(keep: number[], radius: number): void;
  /** The page's pixel size (from its header, else decoded once); known sizes are kept for the next opening. */
  size(i: number): Promise<{ w: number; h: number }>;
  /** Object URLs alive now (for tests and the Performance page). */
  liveUrls(): number;
  dispose(): void;
}

const PICTURE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
/** A system entry, not a page: macOS's resource folder, dot files and folders, Windows' thumbnails. */
const hidden = (path: string) => path.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('.') || /^thumbs\.db$/i.test(seg) || /^desktop\.ini$/i.test(seg));
export const naturalCompare = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
/** Whether an entry of a zip is a page. */
export const isPageEntry = (path: string): boolean => PICTURE.test(path) && !hidden(path);

interface Entry { name: string; method: number; flags: number; csize: number; size: number; local: number }

/** The central directory of a zip, read from the end of the file only; null when it cannot be followed. */
async function readDirectory(file: Blob): Promise<Entry[] | null> {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let count = tail.getUint16(eocd + 10, true); let cdSize = tail.getUint32(eocd + 12, true); let cdOff = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    // (Zip64: the locator just before the end record points at the larger record.)
    const loc = eocd - 20; if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) return null;
    const at = Number(tail.getBigUint64(loc + 8, true));
    const rec = new DataView(await file.slice(at, at + 56).arrayBuffer());
    if (rec.getUint32(0, true) !== 0x06064b50) return null;
    count = Number(rec.getBigUint64(32, true)); cdSize = Number(rec.getBigUint64(40, true)); cdOff = Number(rec.getBigUint64(48, true));
  }
  if (cdOff + cdSize > file.size) return null;
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const utf8 = new TextDecoder('utf-8'); const out: Entry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) return null;
    const flags = cd.getUint16(p + 8, true), method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true), size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    let local = cd.getUint32(p + 42, true);
    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // (Zip64 sizes and offset, in the order the record leaves them out.)
    if (csize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      let e = p + 46 + nameLen; const end = e + extraLen;
      while (e + 4 <= end) {
        const id = cd.getUint16(e, true), len = cd.getUint16(e + 2, true); let q = e + 4;
        if (id === 1) {
          if (size === 0xffffffff) { size = Number(cd.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (local === 0xffffffff) { local = Number(cd.getBigUint64(q, true)); }
          break;
        }
        e += 4 + len;
      }
    }
    if (!name.endsWith('/')) out.push({ name, method, flags, csize, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** An entry's bytes: a slice of the file when stored, inflated when deflated; null when this reader cannot. */
async function entryBlob(file: Blob, e: Entry): Promise<Blob | null> {
  const head = new DataView(await file.slice(e.local, e.local + 30).arrayBuffer());
  if (head.getUint32(0, true) !== 0x04034b50) return null;
  const start = e.local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = file.slice(start, start + e.csize);
  if (e.method === 0) return new Blob([raw], { type: mimeOf(e.name) });
  if (e.method !== 8 || typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat));
    const b = await new Response(stream).blob();
    return new Blob([b], { type: mimeOf(e.name) });
  } catch { return null; }
}

interface SizeCache { n: number; s: ([number, number] | 0)[] }

/** Open a book of pictures. `kind`: 'image' for one picture, else a zip of them. `cache` keeps sizes per book. */
export async function openPages(file: Blob, kind: 'cbz' | 'image', fileName: string, cache?: { get(): Promise<unknown>; set(v: unknown): Promise<void> | void }): Promise<PageSource> {
  type Item = { name: string; blob: () => Promise<Blob> };
  let items: Item[];
  if (kind === 'image') items = [{ name: fileName, blob: async () => file }];
  else {
    const dir = await readDirectory(file).catch(() => null);
    const usable = dir && !dir.some((e) => e.flags & 1) ? dir : null;
    if (usable) {
      let jszip: Promise<import('jszip')> | null = null;
      const viaJszip = (name: string) => { jszip ??= import('jszip').then((m) => m.default.loadAsync(file)); return jszip.then(async (z) => { const f = z.file(name); if (!f) throw new Error('missing page'); return new Blob([await f.async('blob')], { type: mimeOf(name) }); }); };
      items = usable.filter((e) => isPageEntry(e.name)).sort((a, b) => naturalCompare(a.name, b.name))
        .map((e) => ({ name: e.name, blob: async () => (await entryBlob(file, e)) ?? viaJszip(e.name) }));
    } else {
      // (A zip the directory reader could not follow: JSZip, as before — each entry still inflated only when asked.)
      const JSZip = (await import('jszip')).default; const z = await JSZip.loadAsync(file);
      items = Object.keys(z.files).filter((n) => !z.files[n].dir && isPageEntry(n)).sort(naturalCompare)
        .map((n) => ({ name: n, blob: async () => new Blob([await z.files[n].async('blob')], { type: mimeOf(n) }) }));
    }
  }
  // Chapters: the folders holding pages, in page order — only when there are two or more.
  const folderOf = (n: string) => (n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '');
  const folders: string[] = []; const chapOf: number[] = [];
  for (const it of items) { const f = folderOf(it.name); if (folders[folders.length - 1] !== f) folders.push(f); chapOf.push(folders.length - 1); }
  const chaptered = new Set(folders).size >= 2;
  const chapters: ComicChapter[] = chaptered ? folders.map((f, k) => ({ label: f.split('/').pop() || f || '—', start: chapOf.indexOf(k) })) : [];
  const pages: ComicPage[] = items.map((it, i) => ({ index: i, name: it.name, chapter: chaptered ? chapOf[i] : 0, blob: it.blob }));

  // Sizes kept from an earlier opening (the same number of pages: the same book).
  let saved: SizeCache | null = null;
  try { const v = (await cache?.get()) as SizeCache | undefined; if (v && v.n === pages.length && Array.isArray(v.s)) saved = v; } catch { /* none */ }
  if (saved) saved.s.forEach((s, i) => { if (s && pages[i]) { pages[i].width = s[0]; pages[i].height = s[1]; } });
  let saveTimer = 0; let dirty = false;
  const saveSizes = () => { dirty = true; if (saveTimer) return; saveTimer = window.setTimeout(() => { saveTimer = 0; if (!dirty) return; dirty = false; void cache?.set({ n: pages.length, s: pages.map((p) => (p.width && p.height ? [p.width, p.height] : 0)) }); }, 1500); };

  const urls = new Map<number, string>();
  const making = new Map<number, Promise<string>>();
  let gone = false;
  // (The pages the viewer last said it keeps: a URL that arrives for a page let go meanwhile is not made.)
  let keepSet: number[] | null = null; let keepR = 0;
  const learn = (i: number, w: number, h: number) => { const p = pages[i]; if (!p || !w || !h || (p.width === w && p.height === h)) return; p.width = w; p.height = h; saveSizes(); };
  const url = (i: number): Promise<string> => {
    const have = urls.get(i); if (have) return Promise.resolve(have);
    let m = making.get(i);
    if (!m) {
      m = pages[i].blob().then(async (b) => {
        if (!pages[i].width) { try { const head = imageSize(new Uint8Array(await b.slice(0, 65536).arrayBuffer())); if (head) learn(i, head.w, head.h); } catch { /* decoded later */ } }
        if (gone) throw new Error('closed');
        if (keepSet && !keepSet.some((k) => Math.abs(k - i) <= keepR)) { making.delete(i); throw new Error('released'); }
        const u = URL.createObjectURL(b); urls.set(i, u); making.delete(i); return u;
      });
      m.catch(() => making.delete(i));
      making.set(i, m);
    }
    return m;
  };
  const size = async (i: number): Promise<{ w: number; h: number }> => {
    const p = pages[i]; if (p.width && p.height) return { w: p.width, h: p.height };
    try { const b = await p.blob(); const head = imageSize(new Uint8Array(await b.slice(0, 65536).arrayBuffer())); if (head) { learn(i, head.w, head.h); return { w: head.w, h: head.h }; } } catch { /* decode */ }
    // (A kind whose header is not read here — AVIF —: decoded once to be measured.)
    try { const bmp = await createImageBitmap(await p.blob()); learn(i, bmp.width, bmp.height); const r = { w: bmp.width, h: bmp.height }; bmp.close(); return r; } catch { return { w: 0, h: 0 }; }
  };
  return {
    pages, chapters, url, size,
    keepNear(keep, radius) { keepSet = keep; keepR = radius; for (const [i, u] of urls) if (!keep.some((k) => Math.abs(k - i) <= radius)) { URL.revokeObjectURL(u); urls.delete(i); } },
    liveUrls: () => urls.size,
    dispose() { gone = true; for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear(); if (saveTimer) { window.clearTimeout(saveTimer); saveTimer = 0; if (dirty) void cache?.set({ n: pages.length, s: pages.map((p) => (p.width && p.height ? [p.width, p.height] : 0)) }); } },
  };
}
