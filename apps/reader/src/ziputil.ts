// Zips the converter writes: what a zip gains nothing by squeezing is stored as it is.

/** A zip being made (JSZip's, or docx's own copy of it). */
export interface ZipLike {
  file(name: string): { async(type: 'string'): Promise<string> } | null;
  file(name: string, data: string | Uint8Array | Blob, o?: { compression?: 'STORE' | 'DEFLATE' }): unknown;
  files: Record<string, unknown>;
  generateAsync(o: { type: 'blob'; mimeType?: string; compression?: 'DEFLATE' | 'STORE'; compressionOptions?: { level: number } }): Promise<Blob>;
}

/** Pictures, sound and compressed fonts are compressed already: deflating them again takes most of the time a
 *  book's zip takes, for nothing. They are stored as they are. */
export function storeCompressed(zip: ZipLike): void {
  for (const [name, f] of Object.entries(zip.files)) {
    if (!/\.(png|jpe?g|gif|webp|avif|woff2?|mp3|m4a|ogg|opus|mp4|zip)$/i.test(name)) continue;
    const o = (f as { options?: { compression?: string } }).options;
    if (o) o.compression = 'STORE';
  }
}

/** A Word document from docx, zipped once with its pictures stored (docx's own packer deflates them too);
 *  `finish` may change its parts first. */
export async function packDocx(doc: unknown, finish?: (zip: ZipLike) => Promise<void> | void): Promise<Blob> {
  const { Packer } = await import('docx');
  const compiler = (Packer as unknown as { compiler?: { compile(f: unknown): ZipLike } }).compiler;
  const tc = performance.now();
  const zip: ZipLike = compiler ? compiler.compile(doc) : ((await (await import('jszip')).default.loadAsync(await Packer.toBlob(doc as never))) as unknown as ZipLike);
  await finish?.(zip);
  const T = (globalThis as { krTiming?: Record<string, number> }).krTiming; const t0 = performance.now();
  if (T) T.compile = (T.compile ?? 0) + (t0 - tc);
  const out = await zipOut(zip, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  if (T) T.deflate = (T.deflate ?? 0) + (performance.now() - t0);
  return out;
}

/** A JSZip's files written out: by the browser's own deflate when it has one (several times faster than JSZip's
 *  in JS), else by JSZip. */
export async function zipOut(zip: ZipLike, mimeType: string, first?: string): Promise<Blob> {
  const { canDeflate, zipWrite, STORED } = await import('./zipstore');
  if (!canDeflate()) { storeCompressed(zip); return zip.generateAsync({ type: 'blob', mimeType, compression: 'DEFLATE' }); }
  const names = Object.keys(zip.files).filter((n) => !(zip.files[n] as { dir?: boolean }).dir);
  if (first && names.includes(first)) names.splice(names.indexOf(first), 1), names.unshift(first);
  const files: { name: string; blob: Blob | Uint8Array; store?: boolean }[] = [];
  const enc = new TextEncoder();
  for (const name of names) {
    const f = zip.files[name] as { async(type: 'uint8array'): Promise<Uint8Array>; _data?: unknown };
    // (JSZip holds what it was given — a string or bytes, behind a promise — read here as it is rather than
    // through its own stream, which costs a millisecond a part; a part as bytes stays bytes: each trip from a
    // Blob to its bytes is a message to the browser.)
    let raw = f._data; if (raw && typeof (raw as { then?: unknown }).then === 'function') raw = await (raw as Promise<unknown>);
    const bytes = typeof raw === 'string' ? enc.encode(raw) : raw instanceof Uint8Array ? raw : raw instanceof Blob ? raw : await f.async('uint8array');
    files.push({ name, blob: bytes, store: STORED.test(name) || name === first });
  }
  return zipWrite(files, { type: mimeType });
}
