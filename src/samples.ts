// Starter books bundled with the app (public domain): Maqāmāt al-Ḥarīrī from
// the user's Shamela library, and Alice's Adventures in Wonderland (Standard
// Ebooks). They are precached by the service worker, so this works offline.
import { importFiles } from './library';
import type { Book } from './db';

export const SAMPLES = [
  { path: 'samples/maqamat-al-hariri.epub', name: 'maqamat-al-hariri.epub' },
  { path: 'samples/alice-in-wonderland.epub', name: 'alice-in-wonderland.epub' },
];

/** Where a sample the app does not carry is fetched from: the web app's own copy (the apps leave Alice out —
 *  4 MB of engravings — and fetch it when asked). */
const WEB_SAMPLES = 'https://yoru72.github.io/KurokawaReader/';

export async function importSamples(): Promise<Book[]> {
  const files: File[] = [];
  let lastError: unknown = null;
  for (const s of SAMPLES) {
    try {
      // (Only a real EPUB counts: the desktop app answers a file it lacks with its own page, and says "OK".)
      const epub = async (url: string) => { const r = await fetch(url).catch(() => null); if (!r?.ok) return null; const b = await r.blob(); const head = new Uint8Array(await b.slice(0, 2).arrayBuffer()); return head[0] === 0x50 && head[1] === 0x4b ? b : null; };
      const blob = (await epub(s.path)) ?? (await epub(WEB_SAMPLES + s.path));
      if (!blob) throw new Error(`${s.name}: not available`);
      files.push(new File([blob], s.name, { type: 'application/epub+zip' }));
    } catch (e) { lastError = e; }
  }
  // (Offline, the one the app carries comes in alone.)
  if (!files.length) throw lastError ?? new Error('samples');
  return importFiles(files);
}

/** One-off: give an already-imported Maqāmāt its new cover (and file) without touching notes or progress. */
export async function refreshSampleCovers(): Promise<void> {
  const { db } = await import('./db');
  const KEY = 'samples.cover.v2';
  if (await db.getMeta<boolean>(KEY)) return;
  const books = await db.allBooks();
  const old = books.find((b) => b.fileName === 'maqamat-al-hariri.epub');
  if (old) {
    try {
      const r = await fetch('samples/maqamat-al-hariri.epub');
      if (r.ok) {
        const blob = await r.blob();
        const { readMeta } = await import('./formats');
        const meta = await readMeta(blob, old.fileName, 'epub');
        await db.putFile(old.id, blob);
        await db.updateBook(old.id, (b) => { b.cover = meta.cover; b.size = blob.size; });
        const { forgetCover } = await import('./library');
        forgetCover(old.id);
      }
    } catch { /* offline or missing — try again next start */ return; }
  }
  await db.setMeta(KEY, true);
}
