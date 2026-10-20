// Starter books bundled with the app (public domain): Maqāmāt al-Ḥarīrī from
// the user's Shamela library, and Alice's Adventures in Wonderland (Standard
// Ebooks). They are precached by the service worker, so this works offline.
import { importFiles } from './library';
import type { Book } from './db';

export const SAMPLES = [
  { path: '/samples/maqamat-al-hariri.epub', name: 'maqamat-al-hariri.epub' },
  { path: '/samples/alice-in-wonderland.epub', name: 'alice-in-wonderland.epub' },
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
