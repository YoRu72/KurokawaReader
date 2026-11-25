// What kind of archive a file is, by its first bytes and not by its name (a «.cbr» that is a zip is a zip, a «.cbz»
// that is a RAR is a RAR): RAR 4 and 5, 7-Zip, tar (the «ustar» mark at byte 257), a tar in gzip, xz or bzip2 (read by
// name — a compressed stream says nothing of what it holds), and a zip, which only needs the other way when protected.
export interface ArchiveKind { kind: 'zip' | 'rar' | '7z' | 'tar'; /** As shown: «Made from: RAR». */ label: string }

const TAR_NAME = /\.(tar\.(gz|xz|bz2)|tgz|txz|tbz2?)$/i;
/** The archive kinds libarchive.js reads here; null for anything else (a book, a picture, text). */
export async function sniffArchive(file: Blob, name = ''): Promise<ArchiveKind | null> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const at = (...b: number[]) => b.every((v, i) => head[i] === v);
  if (at(0x50, 0x4b, 0x03, 0x04)) return { kind: 'zip', label: 'ZIP' };
  if (at(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return { kind: 'rar', label: 'RAR' };
  if (at(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return { kind: '7z', label: '7Z' };
  if (file.size > 512 && String.fromCharCode(...new Uint8Array(await file.slice(257, 262).arrayBuffer())) === 'ustar') return { kind: 'tar', label: 'TAR' };
  if (TAR_NAME.test(name)) {
    if (at(0x1f, 0x8b)) return { kind: 'tar', label: 'TAR.GZ' };
    if (at(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return { kind: 'tar', label: 'TAR.XZ' };
    if (at(0x42, 0x5a, 0x68)) return { kind: 'tar', label: 'TAR.BZ2' };
  }
  return null;
}

/** Whether `file` is an archive the comic reader reads through libarchive (RAR, 7z, tar — and a zip only when protected). */
export async function needsLibarchive(file: Blob, name: string): Promise<ArchiveKind | null> {
  const k = await sniffArchive(file, name);
  if (!k) return null;
  if (k.kind !== 'zip') return k;
  const { zipIsProtected } = await import('./pages');
  return (await zipIsProtected(file)) ? k : null;
}

/** An archive's name without its archive extension, for the book it becomes (`x.cbr` → `x`, `x.tar.gz` → `x`). */
export const comicStem = (name: string): string => name.replace(/\.(tar\.(gz|xz|bz2)|tgz|txz|tbz2?|cbr|cb7|cbt|cbz|rar|7z|tar|zip)$/i, '');
export const ARCHIVE_NAME = /\.(cbz|zip|cbr|rar|cb7|7z|cbt|tar|tgz|txz|tbz2?|tar\.(gz|xz|bz2))$/i;
