// Opening encrypted PDFs for editing (merge, delete or extract pages…): pdf-lib reads only unencrypted files,
// so the standard security handler is implemented here — RC4 40–128-bit (revisions 2–4), AES-128 (crypt
// filters, revision 4) and AES-256 (revisions 5 and 6) — and every string and stream is decrypted in place.
// The result is an ordinary, unencrypted PDFDocument. Either password opens the file: the user password
// (empty for files that only restrict printing or copying) or the owner password.
import { PDFDocument, PDFParser, PDFObjectStreamParser, PDFRawStream, PDFDict, PDFArray, PDFName, PDFString, PDFHexString, PDFNumber, PDFRef, type PDFObject, type PDFContext } from 'pdf-lib';

/* ---------------------------------------------------------------- primitives */

function md5(data: Uint8Array): Uint8Array {
  const K = new Uint32Array(64); for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const n = data.length; const total = ((n + 8) >> 6) + 1 << 6;
  const buf = new Uint8Array(total); buf.set(data); buf[n] = 0x80;
  const bits = n * 8; for (let i = 0; i < 8; i++) buf[total - 8 + i] = i < 4 ? (bits >>> (8 * i)) & 0xff : Math.floor(bits / 2 ** (8 * i)) & 0xff;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = buf[off + 4 * i] | (buf[off + 4 * i + 1] << 8) | (buf[off + 4 * i + 2] << 16) | (buf[off + 4 * i + 3] << 24);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0; A = D; D = C; C = B; B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => { for (let k = 0; k < 4; k++) out[4 * i + k] = (v >>> (8 * k)) & 0xff; });
  return out;
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 0xff; [s[i], s[j]] = [s[j], s[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 0xff; j = (j + s[i]) & 0xff; [s[i], s[j]] = [s[j], s[i]]; out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff]; }
  return out;
}

// AES (FIPS-197), with CBC on top: enough for PDF's AESV2/AESV3 streams and the revision 6 key hash.
const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
{
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff; INV[SBOX[p]] = p;
  } while (p !== 1);
  SBOX[0] = 0x63; INV[0x63] = 0;
}
const xt = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a: number, b: number) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
function expandKey(key: Uint8Array): Uint8Array[] {
  const nk = key.length / 4, nr = nk + 6; const w: number[][] = [];
  for (let i = 0; i < nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = [...w[i - 1]];
    if (i % nk === 0) { t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]; rcon = xt(rcon); } else if (nk > 6 && i % nk === 4) t = t.map((b) => SBOX[b]);
    w.push(w[i - nk].map((b, k) => b ^ t[k]));
  }
  const rk: Uint8Array[] = []; for (let r = 0; r <= nr; r++) rk.push(Uint8Array.from(w.slice(4 * r, 4 * r + 4).flat()));
  return rk;
}
function encryptBlock(rk: Uint8Array[], b: Uint8Array): Uint8Array {
  const s = b.map((x, i) => x ^ rk[0][i]); const nr = rk.length - 1;
  for (let r = 1; r <= nr; r++) {
    const t = new Uint8Array(16);
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[4 * c + row] = SBOX[s[4 * ((c + row) % 4) + row]];
    if (r < nr) for (let c = 0; c < 4; c++) { const [a0, a1, a2, a3] = t.slice(4 * c, 4 * c + 4); t[4 * c] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3; t[4 * c + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3; t[4 * c + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3); t[4 * c + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2); }
    for (let i = 0; i < 16; i++) s[i] = t[i] ^ rk[r][i];
  }
  return s;
}
function decryptBlock(rk: Uint8Array[], b: Uint8Array): Uint8Array {
  const nr = rk.length - 1; const s = b.map((x, i) => x ^ rk[nr][i]);
  for (let r = nr - 1; r >= 0; r--) {
    const t = new Uint8Array(16);
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[4 * ((c + row) % 4) + row] = INV[s[4 * c + row]];
    for (let i = 0; i < 16; i++) t[i] ^= rk[r][i];
    if (r > 0) for (let c = 0; c < 4; c++) { const [a0, a1, a2, a3] = t.slice(4 * c, 4 * c + 4); t[4 * c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9); t[4 * c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13); t[4 * c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11); t[4 * c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14); }
    s.set(t);
  }
  return s;
}
/** AES-CBC decryption; `padded` strips PKCS#5 padding when it is well formed. */
function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array, padded: boolean): Uint8Array {
  const rk = expandKey(key); const n = data.length - (data.length % 16); const out = new Uint8Array(n);
  let prev = iv;
  for (let o = 0; o < n; o += 16) { const blk = data.subarray(o, o + 16); const d = decryptBlock(rk, blk); for (let i = 0; i < 16; i++) out[o + i] = d[i] ^ prev[i]; prev = blk; }
  if (padded && n) { const p = out[n - 1]; if (p >= 1 && p <= 16 && out.subarray(n - p).every((x) => x === p)) return out.subarray(0, n - p); }
  return out;
}
function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const rk = expandKey(key); const out = new Uint8Array(data.length); let prev = iv;
  for (let o = 0; o < data.length; o += 16) { const x = data.subarray(o, o + 16).map((b, i) => b ^ prev[i]); const e = encryptBlock(rk, x); out.set(e, o); prev = e; }
  return out;
}

const sha = async (alg: 'SHA-256' | 'SHA-384' | 'SHA-512', d: Uint8Array) => new Uint8Array(await crypto.subtle.digest(alg, d as BufferSource));
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const eq = (a: Uint8Array, b: Uint8Array, n = a.length) => a.length >= n && b.length >= n && a.subarray(0, n).every((x, i) => x === b[i]);

/* ---------------------------------------------------------------- the security handler */

const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
const padded = (pw: string) => { const b = Uint8Array.from([...pw].map((c) => c.charCodeAt(0) & 0xff)).subarray(0, 32); return cat(b, PAD.subarray(0, 32 - b.length)); };

type Handler = { V: number; R: number; key: Uint8Array; stm: 'rc4' | 'aes' | 'none'; str: 'rc4' | 'aes' | 'none'; encryptMetadata: boolean };

const bytesOf = (o: PDFObject | undefined): Uint8Array => (o instanceof PDFString || o instanceof PDFHexString ? o.asBytes() : new Uint8Array(0));
const num = (o: PDFObject | undefined, d: number) => (o instanceof PDFNumber ? o.asNumber() : d);

async function hash6(pw: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let k = await sha('SHA-256', cat(pw, salt, udata));
  for (let i = 0; ; i++) {
    const one = cat(pw, k, udata); const k1 = new Uint8Array(one.length * 64); for (let r = 0; r < 64; r++) k1.set(one, r * one.length);
    const e = aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);
    let m = 0; for (let j = 0; j < 16; j++) m += e[j];
    k = await sha(m % 3 === 0 ? 'SHA-256' : m % 3 === 1 ? 'SHA-384' : 'SHA-512', e);
    if (i >= 63 && e[e.length - 1] <= i - 31) break;
  }
  return k.subarray(0, 32);
}

/** The file key from the password (user or owner), or null when it opens neither. */
async function fileKey(enc: PDFDict, id0: Uint8Array, password: string): Promise<Handler | null> {
  const V = num(enc.get(PDFName.of('V')), 0), R = num(enc.get(PDFName.of('R')), 2);
  const O = bytesOf(enc.get(PDFName.of('O'))), U = bytesOf(enc.get(PDFName.of('U')));
  const P = num(enc.get(PDFName.of('P')), 0);
  const em = enc.get(PDFName.of('EncryptMetadata'));
  const encryptMetadata = !(em && em.toString() === 'false');
  // Crypt filters (V4, V5): what streams and strings use.
  const method = (name: string | undefined): 'rc4' | 'aes' | 'none' => {
    if (V < 4) return 'rc4';
    if (!name || name === 'Identity') return 'none';
    const cf = enc.lookup(PDFName.of('CF')); const f = cf instanceof PDFDict ? cf.lookup(PDFName.of(name)) : undefined;
    const cfm = f instanceof PDFDict ? f.get(PDFName.of('CFM'))?.toString() : undefined;
    return cfm === '/AESV2' || cfm === '/AESV3' ? 'aes' : cfm === '/None' ? 'none' : 'rc4';
  };
  const nameOf = (k: string) => enc.get(PDFName.of(k))?.toString().replace(/^\//, '');
  const stm = method(nameOf('StmF')), str = method(nameOf('StrF'));
  if (R >= 5) {
    const pw = new TextEncoder().encode(password).subarray(0, 127);
    const h = R === 5 ? (s: Uint8Array, u: Uint8Array) => sha('SHA-256', cat(pw, s, u)).then((x) => x) : (s: Uint8Array, u: Uint8Array) => hash6(pw, s, u);
    const UE = bytesOf(enc.get(PDFName.of('UE'))), OE = bytesOf(enc.get(PDFName.of('OE')));
    const zero = new Uint8Array(16);
    if (eq(await h(U.subarray(32, 40), new Uint8Array(0)), U, 32)) {
      const k = aesCbcDecrypt(await h(U.subarray(40, 48), new Uint8Array(0)), zero, UE, false);
      return { V, R, key: k.subarray(0, 32), stm, str, encryptMetadata };
    }
    if (eq(await h(O.subarray(32, 40), U.subarray(0, 48)), O, 32)) {
      const k = aesCbcDecrypt(await h(O.subarray(40, 48), U.subarray(0, 48)), zero, OE, false);
      return { V, R, key: k.subarray(0, 32), stm, str, encryptMetadata };
    }
    return null;
  }
  const n = R === 2 ? 5 : Math.max(5, Math.min(16, num(enc.get(PDFName.of('Length')), 40) / 8));
  const keyFor = (pwPadded: Uint8Array) => {
    const p = Uint8Array.of(P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >>> 24) & 0xff);
    let k = md5(cat(pwPadded, O.subarray(0, 32), p, id0, R >= 4 && !encryptMetadata ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array(0)));
    if (R >= 3) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, n));
    return k.subarray(0, n);
  };
  const checkUser = (k: Uint8Array) => {
    if (R === 2) return eq(rc4(k, PAD), U, 32);
    let x = rc4(k, md5(cat(PAD, id0)));
    for (let i = 1; i <= 19; i++) x = rc4(k.map((b) => b ^ i), x);
    return eq(x, U, 16);
  };
  let k = keyFor(padded(password));
  if (checkUser(k)) return { V, R, key: k, stm, str, encryptMetadata };
  // The owner password: it unlocks the user password.
  let ok = md5(padded(password));
  if (R >= 3) for (let i = 0; i < 50; i++) ok = md5(ok);
  ok = ok.subarray(0, n);
  let user = O.subarray(0, 32);
  if (R === 2) user = rc4(ok, user); else for (let i = 19; i >= 0; i--) user = rc4(ok.map((b) => b ^ i), user);
  k = keyFor(user);
  return checkUser(k) ? { V, R, key: k, stm, str, encryptMetadata } : null;
}

function objectKey(h: Handler, how: 'rc4' | 'aes', ref: PDFRef): Uint8Array {
  if (h.V >= 5) return h.key;
  const n = ref.objectNumber, g = ref.generationNumber;
  const ext = Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, g & 0xff, (g >> 8) & 0xff);
  return md5(cat(h.key, ext, how === 'aes' ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0))).subarray(0, Math.min(16, h.key.length + 5));
}

/** A stream's bytes decrypted — AES through the platform's own (fast) implementation when the padding is
 *  well formed, otherwise here. */
async function decryptStream(h: Handler, how: 'rc4' | 'aes' | 'none', ref: PDFRef, data: Uint8Array): Promise<Uint8Array> {
  if (how !== 'aes' || data.length < 32 || data.length % 16 || !globalThis.crypto?.subtle) return decryptBytes(h, how, ref, data);
  try {
    const k = await crypto.subtle.importKey('raw', objectKey(h, how, ref) as BufferSource, 'AES-CBC', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: data.slice(0, 16) }, k, data.subarray(16) as BufferSource));
  } catch { return decryptBytes(h, how, ref, data); }
}

function decryptBytes(h: Handler, how: 'rc4' | 'aes' | 'none', ref: PDFRef, data: Uint8Array): Uint8Array {
  if (how === 'none') return data;
  let key = h.key;
  if (h.V < 5) {
    const n = ref.objectNumber, g = ref.generationNumber;
    const ext = Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, g & 0xff, (g >> 8) & 0xff);
    key = md5(cat(h.key, ext, how === 'aes' ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0))).subarray(0, Math.min(16, h.key.length + 5));
  }
  if (how === 'rc4') return rc4(key, data);
  if (data.length < 16) return new Uint8Array(0);
  return aesCbcDecrypt(key, data.subarray(0, 16), data.subarray(16), true);
}

/* ---------------------------------------------------------------- loading */

/** Is this PDF encrypted? (A quick look at the bytes; the parser has the final word.) */
export function looksEncrypted(bytes: Uint8Array): boolean {
  // (The trailer — or the cross-reference stream that holds it, which can be long — is near the end.)
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - (1 << 20))));
  if (/\/Encrypt\s/.test(tail)) return true;
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16)));
  return /\/Encrypt\s/.test(head);
}

/**
 * Open a PDF for editing, decrypting it when it is encrypted. Throws Error('password') when the file needs a
 * password that was not given (or was wrong).
 */
export async function openPdf(bytes: Uint8Array, password = ''): Promise<PDFDocument> {
  if (!looksEncrypted(bytes)) {
    try { return await PDFDocument.load(bytes, { updateMetadata: false }); } catch (e) { if (!/encrypt/i.test(String(e))) throw e; }
  }
  // Parse with object streams held back: their contents are encrypted as a whole.
  const held: { ref: PDFRef; stream: PDFRawStream }[] = [];
  const origFor = PDFObjectStreamParser.forStream;
  const proto = PDFParser.prototype as unknown as { parseIndirectObjectHeader: () => PDFRef };
  const origHeader = proto.parseIndirectObjectHeader;
  let last: PDFRef | null = null;
  proto.parseIndirectObjectHeader = function (this: unknown) { last = origHeader.call(this); return last; };
  (PDFObjectStreamParser as unknown as { forStream: unknown }).forStream = (stream: PDFRawStream) => {
    if (last) held.push({ ref: last, stream });
    return { parseIntoContext: async () => undefined };
  };
  let context: PDFContext;
  try {
    context = await PDFParser.forBytesWithOptions(bytes, Infinity, false, false).parseDocument();
  } finally {
    (PDFObjectStreamParser as unknown as { forStream: unknown }).forStream = origFor;
    proto.parseIndirectObjectHeader = origHeader;
  }
  const encRef = context.trailerInfo.Encrypt;
  const enc = context.lookup(encRef);
  if (!(enc instanceof PDFDict)) {
    for (const { stream } of held) await origFor(stream).parseIntoContext();
    return finish(context);
  }
  const filter = enc.get(PDFName.of('Filter'))?.toString();
  if (filter && filter !== '/Standard') throw new Error('unsupported-encryption');
  const idArr = context.trailerInfo.ID instanceof PDFArray ? context.trailerInfo.ID : context.lookup(context.trailerInfo.ID);
  const id0 = idArr instanceof PDFArray ? bytesOf(idArr.get(0)) : new Uint8Array(0);
  const h = await fileKey(enc, id0, password);
  if (!h) throw new Error('password');

  const jobs: Promise<void>[] = [];
  const decStrings = (o: PDFObject, ref: PDFRef): PDFObject => {
    if (o instanceof PDFString || o instanceof PDFHexString) return PDFHexString.of([...decryptBytes(h, h.str, ref, o.asBytes())].map((b) => b.toString(16).padStart(2, '0')).join(''));
    if (o instanceof PDFDict) { for (const [k, v] of o.entries()) o.set(k, decStrings(v, ref)); return o; }
    if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) o.set(i, decStrings(o.get(i), ref)); return o; }
    if (o instanceof PDFRawStream) {
      decStrings(o.dict, ref);
      const type = o.dict.get(PDFName.of('Type'))?.toString();
      if (type === '/XRef' || (type === '/Metadata' && !h.encryptMetadata)) return o;
      const f = o.dict.lookup(PDFName.of('Filter'));
      const crypt = f instanceof PDFArray ? f.asArray().some((x) => x.toString() === '/Crypt') : f?.toString() === '/Crypt';
      if (!crypt) jobs.push(decryptStream(h, h.stm, ref, o.contents).then((c) => { (o as unknown as { contents: Uint8Array }).contents = c; }));
    }
    return o;
  };
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (encRef instanceof PDFRef && ref === encRef) continue;
    // A signature's /Contents is never encrypted.
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type'))?.toString() === '/Sig') { const c = obj.get(PDFName.of('Contents')); decStrings(obj, ref); if (c) obj.set(PDFName.of('Contents'), c); continue; }
    decStrings(obj, ref);
  }
  await Promise.all(jobs);
  // Object streams: decrypted whole, then their objects (not encrypted on their own) join the document.
  for (const { ref, stream } of held) {
    const plain = PDFRawStream.of(stream.dict, await decryptStream(h, h.stm, ref, stream.contents));
    await origFor(plain).parseIntoContext();
  }
  if (encRef instanceof PDFRef) context.delete(encRef);
  delete context.trailerInfo.Encrypt;
  return finish(context);
}

function finish(context: PDFContext): PDFDocument {
  // (PDFDocument.load does exactly this once the parser is done.)
  const Doc = PDFDocument as unknown as new (c: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument;
  return new Doc(context, true, false);
}
