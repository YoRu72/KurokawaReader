// Made-up comic books for the comic reader's tests (tests/comicreader.cjs, tests/uihunt.cjs): CBZ files built in
// memory — numbered pages of made-up art (a big digit in a coloured frame), PNGs encoded here with zlib. No real comic
// pages anywhere. Options: pages, size, folders (page counts per folder: chapters), wide / tall / bordered page
// numbers (1-based), noise (bytes of random rows per page, to make a big archive), store (no deflate).
const zlib = require('zlib'); const path = require('path');
const JSZip = require(path.resolve(__dirname, '../../node_modules/jszip'));

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
/** A PNG (8-bit RGB) from a function giving each pixel's colour. */
function png(w, h, px, o = {}) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  // (`tail`: raw rows copied in at the foot as they are — a big page's noise made once, not pixel by pixel.)
  const from = o.tail ? h - o.tailRows : h;
  for (let y = 0; y < from; y++) { const row = y * (w * 3 + 1); raw[row] = 0; for (let x = 0; x < w; x++) { const c = px(x, y); const i = row + 1 + x * 3; raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; } }
  if (o.tail) { const span = o.tail.length - w * 3; let at = ((o.seed ?? 0) * 7919 * 3) % span; for (let y = from; y < h; y++) { const row = y * (w * 3 + 1); raw[row] = 0; if (at > span) at = 0; o.tail.copy(raw, row + 1, at, at + w * 3); at += w * 3; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: o.level ?? 6 })), chunk('IEND', Buffer.alloc(0))]);
}
// A 5×7 font for the digits.
const DIGITS = ['01110100011001110101110011000101110', '00100011000010000100001000010001110', '01110100010000100010001000100011111', '11111000100010000010000011000101110', '00010001100101010010111110001000010', '11111100001111000001000011000101110', '00110010001000011110100011000101110', '11111000010001000100010000100001000', '01110100011000101110100011000101110', '01110100011000101111000010001001100'];
// Frame colours: blue, teal, violet, rose, green, slate (no yellow, amber or orange).
const FRAMES = [[52, 110, 200], [32, 150, 140], [120, 90, 200], [200, 70, 110], [60, 150, 70], [80, 96, 120]];
/** One page: white paper, a coloured frame, the page's number large in the middle; `border`: a wide white margin
 *  round a black field (for border cropping); `noise`: that many bytes of random rows at the foot. */
function page(n, w, h, o = {}) {
  const frame = FRAMES[(n - 1) % FRAMES.length]; const digits = String(n).split('').map(Number);
  const cell = Math.max(4, Math.floor(Math.min(w / (digits.length * 6 + 1), h / 9) * 0.8));
  const tw = digits.length * 6 * cell - cell, th = 7 * cell; const ox = Math.floor((w - tw) / 2), oy = Math.floor((h - th) / 2);
  const f = Math.max(6, Math.round(Math.min(w, h) * 0.04));
  // (Noise: rows of random bytes added at the foot — the page grows by them — so a big archive is big for real.)
  const noiseRows = o.noise ? Math.ceil(o.noise / (w * 3)) : 0;
  if (noiseRows) { NOISE ??= require('crypto').randomBytes(4 << 20); }
  const H = h + noiseRows;
  return png(w, H, (x, y) => {
    if (o.border) { const m = Math.round(Math.min(w, h) * 0.12); if (x < m || y < m || x >= w - m || y >= h - m) return [255, 255, 255]; }
    if (x < f || y < f || x >= w - f || y >= h - f) return frame;
    const dx = x - ox, dy = y - oy;
    if (dx >= 0 && dy >= 0 && dx < tw && dy < th) { const k = Math.floor(dx / (6 * cell)); const cx = Math.floor((dx % (6 * cell)) / cell), cy = Math.floor(dy / cell); if (cx < 5 && DIGITS[digits[k]][cy * 5 + cx] === '1') return [20, 20, 24]; }
    return o.border ? [10, 10, 10] : [246, 244, 240];
  }, { level: o.noise ? 1 : 6, tail: noiseRows ? NOISE : null, tailRows: noiseRows, seed: n });
}
let NOISE = null;
/** A CBZ as a Buffer. */
async function makeCbz(o = {}) {
  const n = o.pages ?? 12, w = o.width ?? 600, h = o.height ?? 900;
  const z = new JSZip(); const folders = o.folders ?? null;
  const at = (i) => { if (!folders) return ''; let k = 0, left = i; while (k < folders.length && left >= folders[k]) { left -= folders[k]; k++; } return `Chapter ${String(k + 1).padStart(2, '0')}/`; };
  for (let i = 1; i <= n; i++) {
    const wide = o.wide?.includes(i), tall = o.tall?.includes(i), border = o.bordered?.includes(i);
    const pw = wide ? Math.round(h * 1.5) : w, ph = tall ? h * 5 : h;
    z.file(`${at(i - 1)}page-${i}.png`, page(i, pw, ph, { border, noise: o.noise }));
  }
  // (Entries the reader must leave out: a system folder, a dot file, a text file.)
  z.file('__MACOSX/._page-1.png', Buffer.from('x')); z.file('.hidden.png', Buffer.from('x')); z.file('info.txt', 'made-up comic');
  return z.generateAsync({ type: 'nodebuffer', compression: o.store ? 'STORE' : 'DEFLATE' });
}
module.exports = { makeCbz, png, page };
