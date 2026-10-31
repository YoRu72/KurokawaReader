// Audiobooks and audio files: MP3, M4A/M4B, AAC, OGG/Opus, FLAC, WAV.
// Title, author, cover and chapters are read from the tags (ID3v2, MP4 atoms incl.
// Nero `chpl` chapters, Vorbis comments); playback is the system's own decoder.
import type { BookMeta } from './types';
import { titleFromFileName } from './types';

export interface AudioChapter { title: string; start: number }   // seconds
export interface AudioInfo extends BookMeta { chapters: AudioChapter[]; duration?: number }

const dec = (b: Uint8Array, enc = 'utf-8') => { try { return new TextDecoder(enc).decode(b).replace(/\0+$/g, '').trim(); } catch { return ''; } };
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

export async function readAudioMeta(file: Blob, fileName: string): Promise<AudioInfo> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const tag = String.fromCharCode(...head.slice(0, 4));
  let info: AudioInfo = { title: '', chapters: [] };
  try {
    if (tag.startsWith('ID3')) info = await id3(file);
    else if (String.fromCharCode(...head.slice(4, 8)) === 'ftyp') info = await mp4(file);
    else if (tag === 'fLaC') info = await flac(file);
    else if (tag === 'OggS') info = await ogg(file);
  } catch (e) { console.warn('[kurokawa] audio tags', e); }
  return { ...info, title: info.title || titleFromFileName(fileName) };
}

/* ---------- ID3v2 (MP3) ---------- */
async function id3(file: Blob): Promise<AudioInfo> {
  const h = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const ver = h[3];
  const size = (h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9];
  const b = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  const out: AudioInfo = { title: '', chapters: [] };
  const text = (f: Uint8Array) => { const enc = f[0]; const body = f.subarray(1); return enc === 1 || enc === 2 ? dec(body, enc === 2 ? 'utf-16be' : 'utf-16') : enc === 3 ? dec(body) : dec(body, 'latin1'); };
  let i = 0;
  const chapters: AudioChapter[] = [];
  while (i + 10 <= b.length) {
    const id = String.fromCharCode(...b.subarray(i, i + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const sz = ver === 4 ? (b[i + 4] << 21) | (b[i + 5] << 14) | (b[i + 6] << 7) | b[i + 7] : u32(b, i + 4);
    const f = b.subarray(i + 10, i + 10 + sz);
    if (id === 'TIT2') out.title = text(f);
    else if (id === 'TALB' && !out.title) out.title = text(f);
    else if (id === 'TPE1' || (id === 'TPE2' && !out.author)) out.author = text(f);
    else if (id === 'APIC' && !out.cover) {
      const enc = f[0]; let p = 1; while (f[p]) p++; const mime = dec(f.subarray(1, p), 'latin1') || 'image/jpeg'; p += 2;   // mime\0 + picture type
      if (enc === 1 || enc === 2) { while (p + 1 < f.length && !(f[p] === 0 && f[p + 1] === 0)) p += 2; p += 2; } else { while (f[p]) p++; p++; }
      out.cover = new Blob([f.slice(p) as BlobPart], { type: mime.includes('/') ? mime : `image/${mime.toLowerCase()}` });
    } else if (id === 'CHAP') {
      let p = 0; while (f[p]) p++; p++;
      const start = u32(f, p) / 1000; p += 16;
      let title = '';
      while (p + 10 <= f.length) { const sid = String.fromCharCode(...f.subarray(p, p + 4)); const ssz = ver === 4 ? (f[p + 4] << 21) | (f[p + 5] << 14) | (f[p + 6] << 7) | f[p + 7] : u32(f, p + 4); if (sid === 'TIT2') title = text(f.subarray(p + 10, p + 10 + ssz)); p += 10 + ssz; }
      chapters.push({ title: title || `${chapters.length + 1}`, start });
    }
    i += 10 + sz;
  }
  out.chapters = chapters.sort((a, c) => a.start - c.start);
  return out;
}

/* ---------- MP4 / M4A / M4B ---------- */
async function mp4(file: Blob): Promise<AudioInfo> {
  const out: AudioInfo = { title: '', chapters: [] };
  // Find `moov` at the top level (it may sit after a huge `mdat`).
  let off = 0; let moov: Uint8Array | null = null;
  while (off < file.size) {
    const hdr = new Uint8Array(await file.slice(off, off + 16).arrayBuffer());
    if (hdr.length < 8) break;
    let size = u32(hdr, 0); const type = String.fromCharCode(...hdr.slice(4, 8));
    let hl = 8; if (size === 1) { size = Number((BigInt(u32(hdr, 8)) << 32n) + BigInt(u32(hdr, 12))); hl = 16; } else if (size === 0) size = file.size - off;
    if (type === 'moov') { moov = new Uint8Array(await file.slice(off + hl, off + size).arrayBuffer()); break; }
    if (size < 8) break; off += size;
  }
  if (!moov) return out;
  const walk = (b: Uint8Array, path: string[], fn: (type: string, body: Uint8Array, path: string[]) => void) => {
    let i = 0;
    while (i + 8 <= b.length) {
      const size = u32(b, i); const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
      if (size < 8 || i + size > b.length) break;
      const body = b.subarray(i + 8, i + size);
      fn(type, body, path);
      if (['trak', 'mdia', 'minf', 'stbl', 'udta', 'ilst', 'edts'].includes(type)) walk(body, [...path, type], fn);
      else if (type === 'meta') walk(body.subarray(4), [...path, type], fn);
      else if (path[path.length - 1] === 'ilst') walk(body, [...path, type], fn);
      i += size;
    }
  };
  walk(moov, [], (type, body, path) => {
    const parent = path[path.length - 1];
    if (type === 'data' && path[path.length - 2] === 'ilst') {
      const val = body.subarray(8);
      if (parent === '©nam') out.title = dec(val);
      else if (parent === '©alb' && !out.title) out.title = dec(val);
      else if (parent === '©ART' || (parent === 'aART' && !out.author)) out.author = dec(val);
      else if (parent === 'covr' && !out.cover) { const kind = u32(body, 0) & 0xffffff; out.cover = new Blob([val.slice() as BlobPart], { type: kind === 14 ? 'image/png' : 'image/jpeg' }); }
    }
    if (type === 'chpl') {   // Nero chapters: version(1) flags(3) reserved(1) count(1 or 4) then [time(8, 100ns) len(1) title]
      // v1 (ffmpeg, Nero): 4 reserved bytes then a 1-byte count; v0: 1 reserved byte then the count.
      const ver = body[0]; let p = ver === 1 ? 8 : 5; const count = body[p++] ?? 0;
      for (let c = 0; c < count && p + 9 <= body.length; c++) {
        const hi = u32(body, p), lo = u32(body, p + 4); const t = (hi * 2 ** 32 + lo) / 1e7; p += 8;
        const len = body[p++]; const title = dec(body.subarray(p, p + len)); p += len;
        out.chapters.push({ title: title || `${c + 1}`, start: t });
      }
    }
  });
  return out;
}

/* ---------- FLAC / Ogg (Vorbis comments) ---------- */
function vorbis(b: Uint8Array, out: AudioInfo): void {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0; const vlen = dv.getUint32(p, true); p += 4 + vlen; const n = dv.getUint32(p, true); p += 4;
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const len = dv.getUint32(p, true); p += 4; const s = dec(b.subarray(p, p + len)); p += len;
    const eq = s.indexOf('='); const k = s.slice(0, eq).toUpperCase(); const v = s.slice(eq + 1);
    if (k === 'TITLE') out.title = v; else if (k === 'ALBUM' && !out.title) out.title = v;
    else if (k === 'ARTIST' || (k === 'ALBUMARTIST' && !out.author)) out.author = v;
    else if (/^CHAPTER\d+$/.test(k)) { const [hh, mm, ss] = v.split(':').map(Number); out.chapters.push({ title: '', start: (hh || 0) * 3600 + (mm || 0) * 60 + (ss || 0) }); }
    else if (/^CHAPTER\d+NAME$/.test(k)) { const c = out.chapters[out.chapters.length - 1]; if (c) c.title = v; }
    else if (k === 'METADATA_BLOCK_PICTURE' && !out.cover) { try { out.cover = flacPicture(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))); } catch { /* ignore */ } }
  }
}
function flacPicture(b: Uint8Array): Blob {
  let p = 4; const ml = u32(b, p); p += 4; const mime = dec(b.subarray(p, p + ml), 'latin1'); p += ml;
  const dl = u32(b, p); p += 4 + dl + 16; const len = u32(b, p); p += 4;
  return new Blob([b.slice(p, p + len) as BlobPart], { type: mime || 'image/jpeg' });
}
async function flac(file: Blob): Promise<AudioInfo> {
  const out: AudioInfo = { title: '', chapters: [] };
  let p = 4;
  for (let guard = 0; guard < 64; guard++) {
    const h = new Uint8Array(await file.slice(p, p + 4).arrayBuffer()); if (h.length < 4) break;
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) vorbis(new Uint8Array(await file.slice(p + 4, p + 4 + len).arrayBuffer()), out);
    else if (type === 6 && !out.cover) out.cover = flacPicture(new Uint8Array(await file.slice(p + 4, p + 4 + len).arrayBuffer()));
    p += 4 + len; if (last) break;
  }
  return out;
}
async function ogg(file: Blob): Promise<AudioInfo> {
  const out: AudioInfo = { title: '', chapters: [] };
  const b = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  // Join the first pages' payloads and look for the comment header.
  const payload: number[] = []; let p = 0;
  for (let page = 0; page < 8 && p + 27 <= b.length; page++) {
    const segs = b[p + 26]; let len = 0; for (let s = 0; s < segs; s++) len += b[p + 27 + s];
    const start = p + 27 + segs; for (let k = start; k < start + len && k < b.length; k++) payload.push(b[k]); p = start + len;
  }
  const data = Uint8Array.from(payload);
  const find = (sig: number[]) => { outer: for (let i = 0; i < data.length - sig.length; i++) { for (let j = 0; j < sig.length; j++) if (data[i + j] !== sig[j]) continue outer; return i + sig.length; } return -1; };
  let at = find([0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]);            // \x03vorbis
  if (at < 0) at = find([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // OpusTags
  if (at >= 0) try { vorbis(data.subarray(at), out); } catch { /* truncated */ }
  return out;
}

/** Duration via the platform decoder (metadata only). */
export function probeDuration(url: string): Promise<number> {
  return new Promise((res) => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => res(Number.isFinite(a.duration) ? a.duration : 0); a.onerror = () => res(0); a.src = url; setTimeout(() => res(0), 8000); });
}
