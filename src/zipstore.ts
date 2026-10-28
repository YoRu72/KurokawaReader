// Zips written without a library: the headers in small buffers between the files' own bytes, so nothing is copied
// twice; files that gain nothing by squeezing (pictures, fonts already packed) stored as they are, the rest
// deflated by the browser's own zlib (CompressionStream — native, several times faster than deflate in JS).

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
async function crcOf(data: Blob | Uint8Array): Promise<number> {
  if (data instanceof Uint8Array) return crc32(data);
  // (Big files in pieces, so a hundred megabytes are never one array.)
  const STEP = 8 * 1024 * 1024; let crc = 0;
  for (let at = 0; at < data.size; at += STEP) crc = crc32(new Uint8Array(await data.slice(at, at + STEP).arrayBuffer()), crc);
  return crc;
}
const sizeOf = (d: Blob | Uint8Array) => (d instanceof Uint8Array ? d.byteLength : d.size);
const asPart = (d: Blob | Uint8Array): BlobPart => (d instanceof Uint8Array ? (d as Uint8Array<ArrayBuffer>) : d);
function dosTime(d: Date): [number, number] {
  return [((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff];
}

/** Whether the browser deflates natively. */
export const canDeflate = () => typeof CompressionStream !== 'undefined';
// (A stream costs a millisecond or two to set up whatever it carries: the many small parts of a document
// are squeezed in JS, the big ones by the browser.)
const SMALL = 16 * 1024;
let pakoP: Promise<{ deflateRaw(d: Uint8Array, o?: { level?: number }): Uint8Array }> | null = null;
// (Bytes in hand stay bytes: each trip from a Blob to its bytes is a message to the browser — a millisecond or
// two — and a document has hundreds of parts.)
async function deflate(data: Blob | Uint8Array): Promise<Blob | Uint8Array> {
  if (sizeOf(data) < SMALL) {
    const pako = await (pakoP ??= import('pako').then((m) => (m.default ?? m) as { deflateRaw(d: Uint8Array, o?: { level?: number }): Uint8Array }));
    return pako.deflateRaw(data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer()), { level: 6 });
  }
  const blob = data instanceof Uint8Array ? new Blob([data as Uint8Array<ArrayBuffer>]) : data;
  return new Response(blob.stream().pipeThrough(new CompressionStream('deflate-raw' as CompressionFormat))).blob();
}
/** Names of files a zip gains nothing by squeezing. */
export const STORED = /\.(png|jpe?g|gif|webp|avif|woff2?|odttf|mp3|m4a|ogg|opus|mp4|zip)$/i;

/** The files, in order, as a zip: each deflated (natively) unless `store` says to keep it as it is. */
export async function zipWrite(files: { name: string; blob: Blob | Uint8Array; store?: boolean }[], o: { type?: string } = {}): Promise<Blob> {
  const parts: BlobPart[] = []; const central: Uint8Array<ArrayBuffer>[] = [];
  const enc = new TextEncoder(); const [tm, dt] = dosTime(new Date());
  let offset = 0;
  // (The squeezing of the next files goes on in the browser while this one's CRC is read.)
  const packed = files.map((f) => (f.store || !canDeflate() ? null : deflate(f.blob)));
  for (const [i, f] of files.entries()) {
    const name = enc.encode(f.name); const crc = await crcOf(f.blob); const size = sizeOf(f.blob);
    let data = f.blob; let method = 0;
    const d = packed[i] ? await packed[i]! : null;
    if (d && sizeOf(d) < size) { data = d; method = 8; }
    const csize = sizeOf(data);
    const zip64 = size >= 0xffffffff || csize >= 0xffffffff;
    const local = new Uint8Array(new ArrayBuffer(30 + name.length)); const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, zip64 ? 45 : 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, method, true);
    v.setUint16(10, tm, true); v.setUint16(12, dt, true); v.setUint32(14, crc, true); v.setUint32(18, zip64 ? 0xffffffff : csize, true); v.setUint32(22, zip64 ? 0xffffffff : size, true);
    v.setUint16(26, name.length, true); v.setUint16(28, 0, true); local.set(name, 30);
    parts.push(local, asPart(data));
    const c = new Uint8Array(new ArrayBuffer(46 + name.length)); const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 45, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true);
    cv.setUint16(12, tm, true); cv.setUint16(14, dt, true); cv.setUint32(16, crc, true); cv.setUint32(20, csize, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, Math.min(offset, 0xffffffff), true);
    c.set(name, 46); central.push(c);
    offset += local.length + csize;
  }
  const cdStart = offset; let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }
  const end = new Uint8Array(new ArrayBuffer(22)); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, Math.min(files.length, 0xffff), true); ev.setUint16(10, Math.min(files.length, 0xffff), true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, Math.min(cdStart, 0xffffffff), true);
  parts.push(end);
  return new Blob(parts, { type: o.type ?? 'application/zip' });
}

/** The files, in order, as a zip (stored). */
export const zipStore = (files: { name: string; blob: Blob }[]): Promise<Blob> => zipWrite(files.map((f) => ({ ...f, store: true })));
