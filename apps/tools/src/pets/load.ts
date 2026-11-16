// A pack chosen by the user from his own files: a folder (the system's folder chooser) or a zip, read into memory
// within the limits (count, each file's size, the total) before anything is decoded; then its frames made into PNG
// pictures of their own (a strip's cells cut, a GIF's frames composed), ready for the library.
import { LIMITS } from './model';
import { PackError, type FrameSrc, type PackFile } from './source';
import { gifFrames } from './gif';

const WANTED = /\.(png|webp|gif|json|xml|txt|md)$/i;
function choose(o: { dir?: boolean; accept?: string }): Promise<File[] | null> {
  return new Promise((res) => {
    const f = document.createElement('input'); f.type = 'file'; f.style.display = 'none';
    if (o.dir) { f.setAttribute('webkitdirectory', ''); f.setAttribute('directory', ''); f.multiple = true; }
    if (o.accept) f.accept = o.accept;
    const done = (v: File[] | null) => { res(v); f.remove(); };
    f.addEventListener('change', () => done(f.files && f.files.length ? Array.from(f.files) : null));
    f.addEventListener('cancel', () => done(null));
    document.body.append(f); f.click();
  });
}
/** The files of a folder the user picks (null when the chooser was closed). */
export async function pickFolder(): Promise<PackFile[] | null> {
  const files = await choose({ dir: true }); if (!files) return null;
  return readFiles(files.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f })));
}
/** A zip the user picks. */
export async function pickZip(): Promise<PackFile[] | null> {
  const files = await choose({ accept: '.zip,application/zip' }); if (!files?.[0]) return null;
  return readZip(files[0]);
}
export async function readFiles(list: { path: string; file: Blob }[]): Promise<PackFile[]> {
  const keep = list.filter((x) => WANTED.test(x.path));
  if (keep.length > LIMITS.files) throw new PackError('tooManyFiles');
  let total = 0; for (const x of keep) if (x.file.size <= LIMITS.fileBytes) total += x.file.size;
  if (total > LIMITS.totalBytes) throw new PackError('tooBig');
  const out: PackFile[] = [];
  for (const x of keep) { if (x.file.size > LIMITS.fileBytes) { out.push({ path: x.path, bytes: new Uint8Array(LIMITS.fileBytes + 1) }); continue; } out.push({ path: x.path, bytes: new Uint8Array(await x.file.arrayBuffer()) }); }
  // (Files of other kinds are named, not read, so the report can say they were left out.)
  for (const x of list) if (!WANTED.test(x.path)) out.push({ path: x.path, bytes: new Uint8Array(0) });
  return out;
}
export async function readZip(b: Blob): Promise<PackFile[]> {
  const { zipEntries, zipRead } = await import('../ipa/zip');
  let entries; try { entries = await zipEntries(b); } catch { throw new PackError('notZip'); }
  entries = entries.filter((e) => !e.name.endsWith('/'));
  if (entries.length > LIMITS.files * 2) throw new PackError('tooManyFiles');
  const out: PackFile[] = []; let total = 0;
  for (const e of entries) {
    if (!WANTED.test(e.name)) { out.push({ path: e.name, bytes: new Uint8Array(0) }); continue; }
    if (e.usize > LIMITS.fileBytes) { out.push({ path: e.name, bytes: new Uint8Array(LIMITS.fileBytes + 1) }); continue; }
    // (What a deflated entry really unpacks to is counted, not what it claims: a bomb stops at the limit.)
    const bytes = await zipRead(b, e, LIMITS.fileBytes + 1).catch(() => null); if (!bytes) continue;
    total += bytes.length; if (total > LIMITS.totalBytes) throw new PackError('tooBig');
    out.push({ path: e.name, bytes });
  }
  return out;
}

/* ---------- frames into pictures ---------- */
async function bitmapOf(bytes: Uint8Array, type: string): Promise<ImageBitmap> {
  try { return await createImageBitmap(new Blob([bytes as BlobPart], { type })); } catch { throw new PackError('badPicture'); }
}
function canvasOf(w: number, h: number): HTMLCanvasElement { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const toPng = (c: HTMLCanvasElement): Promise<Blob> => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new PackError('encode'))), 'image/png'));
/** Each frame as its own PNG, with its size; `progress` told as they are made. */
export async function makeFrames(frames: FrameSrc[], files: PackFile[], progress?: (done: number, total: number) => void): Promise<{ blobs: Blob[]; sizes: [number, number][] }> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const bitmaps = new Map<string, ImageBitmap>(); const gifs = new Map<string, ReturnType<typeof gifFrames>>();
  const blobs: Blob[] = []; const sizes: [number, number][] = [];
  try {
    for (let i = 0; i < frames.length; i++) {
      const fr = frames[i]; const f = byPath.get(fr.file); if (!f) throw new PackError('missing');
      let c: HTMLCanvasElement;
      if (fr.gif !== undefined) {
        let g = gifs.get(fr.file); if (!g) { try { g = gifFrames(f.bytes, LIMITS.framePx * LIMITS.framePx); } catch { throw new PackError('badPicture'); } gifs.set(fr.file, g); }
        const one = g.frames[fr.gif]; if (!one) throw new PackError('badPicture');
        c = canvasOf(g.w, g.h); c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(one.rgba), g.w, g.h), 0, 0);
      } else {
        let bm = bitmaps.get(fr.file); if (!bm) { bm = await bitmapOf(f.bytes, f.path.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/png'); bitmaps.set(fr.file, bm); }
        const [x, y, w, h] = fr.cell ?? [0, 0, bm.width, bm.height];
        if (w > LIMITS.framePx || h > LIMITS.framePx || x + w > bm.width || y + h > bm.height) throw new PackError('frameTooBig');
        c = canvasOf(w, h); c.getContext('2d')!.drawImage(bm, x, y, w, h, 0, 0, w, h);
      }
      blobs.push(await toPng(c)); sizes.push([c.width, c.height]); c.width = c.height = 0;
      progress?.(i + 1, frames.length);
    }
  } finally { for (const b of bitmaps.values()) b.close(); }
  return { blobs, sizes };
}
