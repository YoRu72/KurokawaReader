// A zip of files stored as they are (no compression — pictures do not shrink), written without a library: the
// headers in small buffers between the files' own blobs, so nothing is copied; only the CRC reads each file once.

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
async function crcOf(blob: Blob): Promise<number> {
  // (Big files in pieces, so a hundred megabytes are never one array.)
  const STEP = 8 * 1024 * 1024; let crc = 0;
  for (let at = 0; at < blob.size; at += STEP) crc = crc32(new Uint8Array(await blob.slice(at, at + STEP).arrayBuffer()), crc);
  return crc;
}
function dosTime(d: Date): [number, number] {
  return [((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff];
}

/** The files, in order, as a zip (stored). */
export async function zipStore(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const parts: BlobPart[] = []; const central: Uint8Array<ArrayBuffer>[] = [];
  const enc = new TextEncoder(); const [tm, dt] = dosTime(new Date());
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name); const crc = await crcOf(f.blob); const size = f.blob.size;
    const zip64 = size >= 0xffffffff;
    const local = new Uint8Array(new ArrayBuffer(30 + name.length)); const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, zip64 ? 45 : 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
    v.setUint16(10, tm, true); v.setUint16(12, dt, true); v.setUint32(14, crc, true); v.setUint32(18, zip64 ? 0xffffffff : size, true); v.setUint32(22, zip64 ? 0xffffffff : size, true);
    v.setUint16(26, name.length, true); v.setUint16(28, 0, true); local.set(name, 30);
    parts.push(local, f.blob);
    const c = new Uint8Array(new ArrayBuffer(46 + name.length)); const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 45, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, tm, true); cv.setUint16(14, dt, true); cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, Math.min(offset, 0xffffffff), true);
    c.set(name, 46); central.push(c);
    offset += local.length + size;
  }
  const cdStart = offset; let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }
  const end = new Uint8Array(new ArrayBuffer(22)); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, Math.min(files.length, 0xffff), true); ev.setUint16(10, Math.min(files.length, 0xffff), true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, Math.min(cdStart, 0xffffffff), true);
  parts.push(end);
  return new Blob(parts, { type: 'application/zip' });
}
