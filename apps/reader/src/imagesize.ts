// A picture's kind and size read from its first bytes — no decoding (a book's pictures decoded one after
// another only to be measured took time and memory for nothing).

export type ImageKind = 'png' | 'jpg' | 'gif' | 'bmp' | 'webp';

/** The kind and pixel size of a PNG, JPEG, GIF, BMP or WebP from its header; null for anything else. */
export function imageSize(b: Uint8Array): { kind: ImageKind; w: number; h: number } | null {
  const u16 = (o: number) => (b[o] << 8) | b[o + 1];
  const u16le = (o: number) => b[o] | (b[o + 1] << 8);
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u32le = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: 'png', w: u32(16), h: u32(20) };
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { kind: 'gif', w: u16le(6), h: u16le(8) };
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return { kind: 'bmp', w: u32le(18), h: Math.abs(u32le(22) | 0) };
  if (b.length >= 30 && u32(0) === 0x52494646 && u32(8) === 0x57454250) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8 ') return { kind: 'webp', w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') { const v = u32le(21); return { kind: 'webp', w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8X') return { kind: 'webp', w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // The frame header (SOF0–SOF15, not DHT/JPG/DAC) holds the size; the markers before it are stepped over.
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { o += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { kind: 'jpg', w: u16(o + 7), h: u16(o + 5) };
      o += 2 + u16(o + 2);
    }
  }
  return null;
}
