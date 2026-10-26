// Starter books bundled with the app (public domain): Maqāmāt al-Ḥarīrī from
// the user's Shamela library, and Alice's Adventures in Wonderland (Standard
// Ebooks). They are precached by the service worker, so this works offline.
import { importFiles } from './library';
import type { Book } from './db';

export const SAMPLES = [
  { path: 'samples/maqamat-al-hariri.epub', name: 'maqamat-al-hariri.epub' },
  { path: 'samples/alice-in-wonderland.epub', name: 'alice-in-wonderland.epub' },
];

export async function importSamples(): Promise<Book[]> {
  const files: File[] = [];
  for (const s of SAMPLES) {
    const r = await fetch(s.path);
    if (!r.ok) throw new Error(`${s.name}: ${r.status}`);
    files.push(new File([await r.blob()], s.name, { type: 'application/epub+zip' }));
  }
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
