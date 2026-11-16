// The pets the user imported: kept in the app's own data (its IndexedDB, the same store the theme packs' pictures
// use — never localStorage), a pack's model beside its frames as PNG pictures. The list (name, credit, licence, how
// many frames, how big) is what the library shows; a pet is loaded into pictures only when shown.
import { db, uid } from '../db';
import { checkPack, type PetPack } from './model';

export interface PetEntry { id: string; name: string; credit: string; licence: string; source: PetPack['source']; frames: number; bytes: number; at: number }
const LIB = 'pets.library';
const packKey = (id: string) => `pet:${id}`;
const frameKey = (id: string, i: number) => `pet/${id}/${i}`;
type Listener = () => void; const listeners = new Set<Listener>();
export function onLibrary(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => { for (const f of listeners) f(); };

export async function listPets(): Promise<PetEntry[]> { const l = await db.getMeta<PetEntry[]>(LIB).catch(() => undefined); return Array.isArray(l) ? l : []; }
/** How many pets, and how many bytes of their pictures, the library keeps at most. */
export const LIBRARY_MAX = { count: 24, bytes: 256 << 20 };
/** A pet kept: all of it or nothing (frames written are taken back when any part fails); refused past the library's
 *  limits (Error 'libraryFull'). */
export async function addPet(pack: PetPack, blobs: Blob[], sizes: [number, number][]): Promise<PetEntry> {
  checkPack(pack); if (blobs.length !== pack.frames || sizes.length !== pack.frames) throw new Error('badPack:frames');
  const lib = await listPets(); const bytes = blobs.reduce((a, b) => a + b.size, 0);
  if (lib.length >= LIBRARY_MAX.count || lib.reduce((a, e) => a + (e.bytes || 0), 0) + bytes > LIBRARY_MAX.bytes) throw new Error('libraryFull');
  const id = uid(); let written = 0;
  try {
    for (let i = 0; i < blobs.length; i++) { await db.putFile(frameKey(id, i), blobs[i]); written = i + 1; }
    await db.setMeta(packKey(id), { pack, sizes });
    const e: PetEntry = { id, name: pack.name, credit: pack.credit, licence: pack.licence, source: pack.source, frames: pack.frames, bytes, at: Date.now() };
    await db.setMeta(LIB, [...(await listPets()), e]); changed();
    return e;
  } catch (err) {
    for (let i = 0; i < written; i++) await db.deleteFile(frameKey(id, i)).catch(() => undefined);
    await db.deleteMeta(packKey(id)).catch(() => undefined);
    throw err;
  }
}
export async function renamePet(id: string, name: string): Promise<void> {
  const n = name.trim().slice(0, 80); if (!n) return;
  const l = await listPets(); const e = l.find((x) => x.id === id); if (!e) return; e.name = n;
  const rec = await db.getMeta<{ pack: PetPack; sizes: [number, number][] }>(packKey(id)); if (rec) { rec.pack.name = n; await db.setMeta(packKey(id), rec); }
  await db.setMeta(LIB, l); changed();
}
export async function removePet(id: string): Promise<void> {
  const l = await listPets(); const e = l.find((x) => x.id === id);
  await db.setMeta(LIB, l.filter((x) => x.id !== id));
  if (e) for (let i = 0; i < e.frames; i++) await db.deleteFile(frameKey(id, i)).catch(() => undefined);
  await db.deleteMeta(packKey(id)).catch(() => undefined); changed();
}
export interface LoadedPet { id: string; pack: PetPack; sizes: [number, number][]; images: ImageBitmap[] }
/** A pet with its frames as pictures (each frame read once); null when it is not (or no longer) here. */
export async function loadPet(id: string): Promise<LoadedPet | null> {
  const rec = await db.getMeta<{ pack: PetPack; sizes: [number, number][] }>(packKey(id)).catch(() => undefined); if (!rec) return null;
  // (Checked again as it is read: the stored model is trusted no more than an imported one.)
  try { checkPack(rec.pack); } catch { return null; }
  if (!Array.isArray(rec.sizes) || rec.sizes.length !== rec.pack.frames) return null;
  const images: ImageBitmap[] = [];
  try {
    for (let i = 0; i < rec.pack.frames; i++) { const b = await db.getFile(frameKey(id, i)); if (!b) throw new Error('missing'); images.push(await createImageBitmap(b)); }
  } catch { for (const im of images) im.close(); return null; }
  return { id, pack: rec.pack, sizes: rec.sizes, images };
}
/** One frame's picture (the library's small preview). */
export async function frameBlob(id: string, i: number): Promise<Blob | undefined> { return db.getFile(frameKey(id, i)).catch(() => undefined); }
