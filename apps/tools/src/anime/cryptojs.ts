// The `CryptoJS` Seanime gives its extensions (AES encrypt/decrypt in CBC with PKCS#7, a passphrase turned into a
// key the OpenSSL way, the Utf8/Base64/Hex/Latin1/Utf16 encoders), synchronous like theirs: the streaming
// extensions decrypt their sources inline. AES itself is the textbook cipher (FIPS-197).

/* ---------- AES ---------- */
const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
(() => { let p = 1, q = 1; do { p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0); q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09; const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4)); SBOX[p] = (x ^ 0x63) & 0xff; } while (p !== 1); SBOX[0] = 0x63; for (let i = 0; i < 256; i++) INV[SBOX[i]] = i; })();
const xt = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a: number, b: number) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
function expand(key: Uint8Array): Uint8Array[] {
  const nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1)); w.set(key); let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4);
    if (i % nk === 0) { t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]); rcon = xt(rcon); } else if (nk > 6 && i % nk === 4) t = t.map((b) => SBOX[b]);
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
  }
  return Array.from({ length: nr + 1 }, (_, r) => w.subarray(r * 16, r * 16 + 16));
}
function encBlock(b: Uint8Array, ks: Uint8Array[]): Uint8Array {
  let s = b.map((x, i) => x ^ ks[0][i]); const nr = ks.length - 1;
  for (let r = 1; r <= nr; r++) {
    s = s.map((x) => SBOX[x]);
    s = new Uint8Array([s[0], s[5], s[10], s[15], s[4], s[9], s[14], s[3], s[8], s[13], s[2], s[7], s[12], s[1], s[6], s[11]]);
    if (r < nr) { const m = new Uint8Array(16); for (let c = 0; c < 4; c++) { const [a0, a1, a2, a3] = s.subarray(c * 4, c * 4 + 4); m[c * 4] = xt(a0) ^ xt(a1) ^ a1 ^ a2 ^ a3; m[c * 4 + 1] = a0 ^ xt(a1) ^ xt(a2) ^ a2 ^ a3; m[c * 4 + 2] = a0 ^ a1 ^ xt(a2) ^ xt(a3) ^ a3; m[c * 4 + 3] = xt(a0) ^ a0 ^ a1 ^ a2 ^ xt(a3); } s = m; }
    s = s.map((x, i) => x ^ ks[r][i]);
  }
  return s;
}
function decBlock(b: Uint8Array, ks: Uint8Array[]): Uint8Array {
  const nr = ks.length - 1; let s = b.map((x, i) => x ^ ks[nr][i]);
  for (let r = nr - 1; r >= 0; r--) {
    s = new Uint8Array([s[0], s[13], s[10], s[7], s[4], s[1], s[14], s[11], s[8], s[5], s[2], s[15], s[12], s[9], s[6], s[3]]);
    s = s.map((x) => INV[x]); s = s.map((x, i) => x ^ ks[r][i]);
    if (r > 0) { const m = new Uint8Array(16); for (let c = 0; c < 4; c++) { const [a0, a1, a2, a3] = s.subarray(c * 4, c * 4 + 4); m[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9); m[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13); m[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11); m[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14); } s = m; }
  }
  return s;
}
export function aesCbc(data: Uint8Array, key: Uint8Array, iv: Uint8Array, encrypt: boolean): Uint8Array {
  const ks = expand(key); let prev = iv;
  if (encrypt) { const pad = 16 - (data.length % 16); const p = new Uint8Array(data.length + pad); p.set(data); p.fill(pad, data.length); const out = new Uint8Array(p.length); for (let i = 0; i < p.length; i += 16) { const x = p.subarray(i, i + 16).map((v, j) => v ^ prev[j]); prev = encBlock(x, ks); out.set(prev, i); } return out; }
  const out = new Uint8Array(data.length); for (let i = 0; i + 16 <= data.length; i += 16) { const blk = data.subarray(i, i + 16); out.set(decBlock(blk, ks).map((v, j) => v ^ prev[j]), i); prev = blk; }
  const pad = out[out.length - 1]; return pad > 0 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
}

/* ---------- MD5 (for the passphrase's key, EVP_BytesToKey) ---------- */
export function md5(m: Uint8Array): Uint8Array {
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const l = m.length, n = (((l + 8) >> 6) + 1) * 64, b = new Uint8Array(n); b.set(m); b[l] = 0x80; const bits = l * 8; for (let i = 0; i < 8; i++) b[n - 8 + i] = Math.floor(bits / 2 ** (8 * i)) & 0xff;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476; const dv = new DataView(b.buffer);
  for (let o = 0; o < n; o += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) { let F: number, g: number; if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + dv.getUint32(o + g * 4, true)) >>> 0; A = D; D = C; C = B; const sh = S[(i >> 4) * 4 + (i % 4)]; B = (B + ((F << sh) | (F >>> (32 - sh)))) >>> 0; }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16); const ov = new DataView(out.buffer); ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true); return out;
}
function evpKey(pass: Uint8Array, salt: Uint8Array): { key: Uint8Array; iv: Uint8Array } { let d: Uint8Array = new Uint8Array(0), prev: Uint8Array = new Uint8Array(0); while (d.length < 48) { const x = new Uint8Array(prev.length + pass.length + salt.length); x.set(prev); x.set(pass, prev.length); x.set(salt, prev.length + pass.length); prev = md5(x); const n = new Uint8Array(d.length + 16); n.set(d); n.set(prev, d.length); d = n; } return { key: d.subarray(0, 32), iv: d.subarray(32, 48) }; }

/* ---------- encoders and the WordArray stand-in ---------- */
const te = new TextEncoder(), td = new TextDecoder();
const b64 = { stringify: (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }, parse: (s: string) => Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0)) };
const enc = {
  Utf8: { stringify: (u: Uint8Array) => td.decode(u), parse: (s: string) => te.encode(s) },
  Base64: b64,
  Hex: { stringify: (u: Uint8Array) => Array.from(u, (x) => x.toString(16).padStart(2, '0')).join(''), parse: (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16)) },
  Latin1: { stringify: (u: Uint8Array) => String.fromCharCode(...u), parse: (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff) },
  Utf16: { stringify: (u: Uint8Array) => { let s = ''; for (let i = 0; i + 1 < u.length; i += 2) s += String.fromCharCode((u[i] << 8) | u[i + 1]); return s; }, parse: (s: string) => { const u = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { u[i * 2] = s.charCodeAt(i) >> 8; u[i * 2 + 1] = s.charCodeAt(i) & 0xff; } return u; } },
  Utf16LE: { stringify: (u: Uint8Array) => { let s = ''; for (let i = 0; i + 1 < u.length; i += 2) s += String.fromCharCode(u[i] | (u[i + 1] << 8)); return s; }, parse: (s: string) => { const u = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { u[i * 2] = s.charCodeAt(i) & 0xff; u[i * 2 + 1] = s.charCodeAt(i) >> 8; } return u; } },
};
type Encoder = { stringify(u: Uint8Array): string; parse(s: string): Uint8Array };
type WordArray = Uint8Array & { iv?: Uint8Array; toString(e?: Encoder): string };
const wa = (u: Uint8Array, iv?: Uint8Array, defaultEnc: Encoder = b64): WordArray => { const w = u as WordArray; w.iv = iv; w.toString = (e?: Encoder) => (e ?? defaultEnc).stringify(u); return w; };
const bytes = (x: string | Uint8Array): Uint8Array => (typeof x === 'string' ? te.encode(x) : x);
type Cfg = { iv?: Uint8Array | string };
/** Seanime's CryptoJS: a string key is a passphrase (OpenSSL's «Salted__» format, key and IV from MD5), a
 *  Uint8Array key is the key itself (the IV then given in `cfg.iv`). */
export const CryptoJS = {
  AES: {
    encrypt(message: string, key: string | Uint8Array, cfg: Cfg = {}): WordArray {
      if (typeof key === 'string' && !cfg.iv) { const salt = crypto.getRandomValues(new Uint8Array(8)); const { key: k, iv } = evpKey(te.encode(key), salt); const ct = aesCbc(te.encode(message), k, iv, true); const out = new Uint8Array(16 + ct.length); out.set(te.encode('Salted__')); out.set(salt, 8); out.set(ct, 16); return wa(out, iv); }
      const iv = cfg.iv ? bytes(cfg.iv) : new Uint8Array(16); return wa(aesCbc(te.encode(message), bytes(key), iv, true), iv);
    },
    decrypt(message: string | Uint8Array, key: string | Uint8Array, cfg: Cfg = {}): WordArray {
      const data = typeof message === 'string' ? b64.parse(message) : message;
      if (typeof key === 'string' && !cfg.iv && td.decode(data.subarray(0, 8)) === 'Salted__') { const { key: k, iv } = evpKey(te.encode(key), data.subarray(8, 16)); return wa(aesCbc(data.subarray(16), k, iv, false), iv, enc.Utf8); }
      const iv = cfg.iv ? bytes(cfg.iv) : new Uint8Array(16); return wa(aesCbc(data, bytes(key), iv, false), iv, enc.Utf8);
    },
  },
  enc,
};
