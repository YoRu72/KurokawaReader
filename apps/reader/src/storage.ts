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
};
const kr = (): Kr | undefined => (window as unknown as { Capacitor?: { Plugins?: { Kurokawa?: Kr } } }).Capacitor?.Plugins?.Kurokawa;
const desk = () => window.kurokawaDesktop as (typeof window.kurokawaDesktop & { pickFolder?(): Promise<string | null>; writeBinary?(p: string, b64: string, append?: boolean): Promise<boolean> }) | undefined;

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

/** Write every copied book to a folder the user picks, link it there, and drop the copy inside the app. */
export async function moveBooksOut(books: Book[], onProgress: (done: number, total: number, name: string) => void): Promise<number> {
  let target: { tree?: string; dir?: string } | null = null;
  if (nativePlatform() === 'android') { try { const t = await kr()!.pickTree!(); target = { tree: t.uri }; } catch { return 0; } }
  else { const d = await desk()?.pickFolder?.(); if (!d) return 0; target = { dir: d }; }
  let moved = 0;
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
        source = { uri };
      } else {
        const sep = target.dir!.includes('\\') ? '\\' : '/';
        const path = `${target.dir}${sep}${name}`;
        for (let off = 0; off < file.size || off === 0; off += CHUNK) {
          await desk()!.writeBinary!(path, b64(new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer())), off > 0);
          if (file.size === 0) break;
        }
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
