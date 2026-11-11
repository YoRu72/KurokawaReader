// Where the app's space goes, freeing what can be rebuilt, and moving books that
// were copied into the app out to a folder on the device (they are then linked,
// the way books imported since 0.22 are).
import { db, type Book } from './db';
import { nativePlatform } from './native';

type Kr = {
  storageInfo?(): Promise<{ webview: number; cache: number; files: number; total: number }>;
  clearCaches?(): Promise<{ freed: number }>;
  pickTree?(): Promise<{ uri: string; name: string }>;
  writeDocument?(o: { tree?: string; uri?: string; name?: string; mime?: string; data: string }): Promise<{ uri: string }>;
  docInfo?(o: { uri: string }): Promise<{ size: number }>;
};
const kr = (): Kr | undefined => (window as unknown as { Capacitor?: { Plugins?: { Kurokawa?: Kr } } }).Capacitor?.Plugins?.Kurokawa;
const desk = () => window.kurokawaDesktop as (typeof window.kurokawaDesktop & { pickFolder?(): Promise<string | null>; writeBinary?(p: string, b64: string, append?: boolean): Promise<boolean>; fileSize?(p: string): Promise<number>; readFile?(p: string): Promise<ArrayBuffer> }) | undefined;

export interface StorageReport { total?: number; books: number; booksBytes: number; copied: Book[]; copiedBytes: number; linked: number; cache?: number }

export async function storageReport(): Promise<StorageReport> {
  const all = await db.allBooks();
  const copied = all.filter((b) => !b.source);
  const r: StorageReport = { books: all.length, booksBytes: all.reduce((a, b) => a + (b.size || 0), 0), copied, copiedBytes: copied.reduce((a, b) => a + (b.size || 0), 0), linked: all.length - copied.length };
  if (nativePlatform() === 'android' && kr()?.storageInfo) { try { const i = await kr()!.storageInfo!(); r.total = i.total; r.cache = i.cache; } catch { /* old build */ } }
  else { try { const e = await navigator.storage?.estimate?.(); r.total = e?.usage; } catch { /* ignore */ } }
  return r;
}

/** Caches, page copies, downloaded updates. */
export async function freeSpace(): Promise<number> {
  let freed = 0;
  try { for (const k of await caches.keys()) { if (k === 'kurokawa-ext' && !(nativePlatform() === 'android')) continue; await caches.delete(k); } } catch { /* ignore */ }
  if (nativePlatform() === 'android') { try { freed += (await kr()?.clearCaches?.())?.freed ?? 0; } catch { /* old build */ } }
  return freed;
}

export function canMoveOut(): boolean { return (nativePlatform() === 'android' && !!kr()?.writeDocument) || !!desk()?.writeBinary; }

const CHUNK = 3 * 1024 * 1024;
const b64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/** A file's size on the desktop, -1 when there is none (an older desktop shell without `fileSize`: read whole). */
async function deskSize(p: string): Promise<number> {
  const d = desk()!; if (d.fileSize) return d.fileSize(p);
  try { const b = await d.readFile!(p); return b.byteLength; } catch { return -1; }
}
/** A name not yet taken in the folder (nor by another book moved now): «name.epub», «name (2).epub»… */
async function freePath(dir: string, name: string, taken: Set<string>): Promise<string> {
  const sep = dir.includes('\\') ? '\\' : '/'; const dot = name.lastIndexOf('.'); const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) { const p = `${dir}${sep}${i === 1 ? name : `${base} (${i})${ext}`}`; if (!taken.has(p.toLowerCase()) && await deskSize(p) < 0) { taken.add(p.toLowerCase()); return p; } }
}

/** Write every copied book to a folder the user picks, link it there, and drop the copy inside the app — only once
 *  the file outside is there whole (its size checked). A file already in the folder is never written over (a new
 *  name is found; Android's document provider finds one itself), and a book whose writing failed keeps its copy. */
export async function moveBooksOut(books: Book[], onProgress: (done: number, total: number, name: string) => void): Promise<number> {
  let target: { tree?: string; dir?: string } | null = null;
  if (nativePlatform() === 'android') { try { const t = await kr()!.pickTree!(); target = { tree: t.uri }; } catch { return 0; } }
  else { const d = await desk()?.pickFolder?.(); if (!d) return 0; target = { dir: d }; }
  let moved = 0; const taken = new Set<string>();
  for (const [i, book] of books.entries()) {
    onProgress(i, books.length, book.title);
    const file = await db.getFile(book.id); if (!file) continue;
    const name = book.fileName || `${book.title}.${book.format}`;
    try {
      let source: Book['source'];
      if (target.tree) {
        let uri: string | undefined;
        for (let off = 0; off < file.size || off === 0; off += CHUNK) {
          const part = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
          uri = (await kr()!.writeDocument!(uri ? { uri, data: b64(part) } : { tree: target.tree, name, mime: file.type || book.mime || 'application/octet-stream', data: b64(part) })).uri;
          if (file.size === 0) break;
        }
        if (!uri) throw new Error('not written');
        // (The size as the provider reports it; one that reports none (-1) is taken at its word.)
        const size = kr()!.docInfo ? (await kr()!.docInfo!({ uri })).size : -1;
        if (size >= 0 && size !== file.size) throw new Error(`written ${size} of ${file.size}`);
        source = { uri };
      } else {
        const path = await freePath(target.dir!, name, taken);
        for (let off = 0; off < file.size || off === 0; off += CHUNK) {
          await desk()!.writeBinary!(path, b64(new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer())), off > 0);
          if (file.size === 0) break;
        }
        const size = await deskSize(path);
        if (size !== file.size) throw new Error(`written ${size} of ${file.size}`);
        source = { path };
      }
      await db.updateBook(book.id, (b) => { b.source = source; });
      await db.deleteFile(book.id);
      moved++;
    } catch (err) { console.warn('[kurokawa] move out failed', book.title, err); }
  }
  onProgress(books.length, books.length, '');
  return moved;
}
