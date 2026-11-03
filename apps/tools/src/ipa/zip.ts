// A ZIP read in place from a File or Blob (an IPA is one): its list of entries from the central directory at its
// end, and any one entry's bytes on request — stored or deflated (the browser's own inflater) — without reading
// the rest of what may be gigabytes.
export interface ZipEntry { name: string; method: number; csize: number; usize: number; offset: number }

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);
const slice = async (b: Blob, from: number, to: number) => new DataView(await b.slice(from, to).arrayBuffer());

/** The entries of a ZIP (ZIP64 sizes and offsets read too). */
export async function zipEntries(b: Blob): Promise<ZipEntry[]> {
  const tail = Math.min(b.size, 65557); const end = await slice(b, b.size - tail, b.size);
  let at = -1; for (let i = tail - 22; i >= 0; i--) if (u32(end, i) === 0x06054b50) { at = i; break; }
  if (at < 0) throw new Error('notZip');
  let count = u16(end, at + 10), cdSize = u32(end, at + 12), cdOff = u32(end, at + 16);
  // (ZIP64: the real numbers in the ZIP64 end record, found through its locator just before.)
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = at - 20; if (loc >= 0 && u32(end, loc) === 0x07064b50) {
      const recOff = Number(end.getBigUint64(loc + 8, true)); const rec = await slice(b, recOff, recOff + 56);
      count = Number(rec.getBigUint64(32, true)); cdSize = Number(rec.getBigUint64(40, true)); cdOff = Number(rec.getBigUint64(48, true));
    }
  }
  const cd = await slice(b, cdOff, cdOff + cdSize); const dec = new TextDecoder(); const out: ZipEntry[] = [];
  for (let p = 0, n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const method = u16(cd, p + 10); let csize = u32(cd, p + 20), usize = u32(cd, p + 24); const nl = u16(cd, p + 28), xl = u16(cd, p + 30), cl = u16(cd, p + 32); let offset = u32(cd, p + 42);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
    // (ZIP64 extra field: the sizes and offset that did not fit.)
    let x = p + 46 + nl; const xe = x + xl;
    while (x + 4 <= xe) { const id = u16(cd, x), sz = u16(cd, x + 2); if (id === 1) { let q = x + 4; if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; } if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; } if (offset === 0xffffffff) offset = Number(cd.getBigUint64(q, true)); } x += 4 + sz; }
    out.push({ name, method, csize, usize, offset }); p += 46 + nl + xl + cl;
  }
  return out;
}

/** One entry's bytes (at most `max`, for a look at a big one). */
export async function zipRead(b: Blob, e: ZipEntry, max = Infinity): Promise<Uint8Array> {
  const lh = await slice(b, e.offset, e.offset + 30); if (u32(lh, 0) !== 0x04034b50) throw new Error('badEntry');
  const start = e.offset + 30 + u16(lh, 26) + u16(lh, 28);
  const raw = b.slice(start, start + e.csize);
  if (e.method === 0) return new Uint8Array(await raw.slice(0, Math.min(e.csize, max)).arrayBuffer());
  if (e.method !== 8) throw new Error('unsupported');
  const ds = new DecompressionStream('deflate-raw'); const r = raw.stream().pipeThrough(ds).getReader();
  const parts: Uint8Array[] = []; let n = 0;
  for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; if (n >= max) { void r.cancel(); break; } }
  const all = new Uint8Array(Math.min(n, max)); let o = 0; for (const p of parts) { const take = Math.min(p.length, all.length - o); all.set(p.subarray(0, take), o); o += take; if (o >= all.length) break; }
  return all;
}
