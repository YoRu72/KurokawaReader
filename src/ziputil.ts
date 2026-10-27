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
  const zip: ZipLike = compiler ? compiler.compile(doc) : ((await (await import('jszip')).default.loadAsync(await Packer.toBlob(doc as never))) as unknown as ZipLike);
  await finish?.(zip);
  storeCompressed(zip);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
}
