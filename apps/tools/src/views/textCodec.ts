// A text file's characters told from its bytes and written back the same way (the text editor of Files and of
// «Edit with Kurokawa»): a byte-order mark first (UTF-8, UTF-16 LE/BE), then UTF-16 without one (every other byte
// zero), then strict UTF-8, then Windows-1256 (Arabic subtitles of old). A file is editable only when writing the text
// back gives the very bytes read — anything else (a binary file, a cut-off read, an encoding not known here) opens
// read-only with a notice, so a file is never spoilt by a save.
export type Charset = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1256' | 'windows-1252' | 'shift_jis';
export type Decoded = { text: string; charset: Charset; bom: boolean; safe: boolean; why?: 'binary' | 'partial' | 'unknown' };

const tables = new Map<string, Map<string, number>>();
/** A single-byte charset's characters → bytes, read from the platform's own decoder. */
function byteTable(label: 'windows-1256' | 'windows-1252'): Map<string, number> {
  const have = tables.get(label); if (have) return have;
  const m = new Map<string, number>(); const dec = new TextDecoder(label);
  for (let b = 0; b < 256; b++) { const ch = dec.decode(new Uint8Array([b])); if (ch !== '�' && !m.has(ch)) m.set(ch, b); }
  tables.set(label, m); return m;
}
const same = (a: Uint8Array, b: Uint8Array | null): boolean => !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** Bytes for the text in this charset (with its mark when the file had one); null when a character has no place in it. */
export function encodeText(text: string, charset: Charset, bom = false): Uint8Array | null {
  if (charset === 'utf-8') { const body = new TextEncoder().encode(text); if (!bom) return body; const out = new Uint8Array(body.length + 3); out.set([0xef, 0xbb, 0xbf]); out.set(body, 3); return out; }
  if (charset === 'utf-16le' || charset === 'utf-16be') {
    const head = bom ? 2 : 0; const out = new Uint8Array(head + text.length * 2); const le = charset === 'utf-16le';
    if (bom) out.set(le ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[head + i * 2 + (le ? 0 : 1)] = c & 0xff; out[head + i * 2 + (le ? 1 : 0)] = c >> 8; }
    return out;
  }
  // (Shift_JIS has no encoder in the platform: it is read, never written — null.)
  if (charset === 'shift_jis') return null;
  const t = byteTable(charset); const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) { const b = t.get(text[i]); if (b === undefined) return null; out[i] = b; }
  return out;
}
/** The charsets that can be written back safely, and those only read. */
export const canWrite = (c: Charset): boolean => c !== 'shift_jis';
/** The bytes read as the charset asked (the reader's choice, «Re-open as…»): safe only when writing the text back gives the very bytes. */
export function decodeAs(b: Uint8Array, charset: Charset, bom: boolean, whole = true): Decoded {
  const label = charset === 'utf-8' ? 'utf-8' : charset;
  const skip = bom ? (charset === 'utf-8' && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : (charset === 'utf-16le' && b[0] === 0xff && b[1] === 0xfe) || (charset === 'utf-16be' && b[0] === 0xfe && b[1] === 0xff) ? 2 : 0) : 0;
  const text = new TextDecoder(label, { ignoreBOM: true }).decode(b.subarray(skip));
  if (!whole) return { text, charset, bom, safe: false, why: 'partial' };
  return same(b, encodeText(text, charset, bom && skip > 0)) ? { text, charset, bom: bom && skip > 0, safe: true } : { text, charset, bom, safe: false, why: 'unknown' };
}
/** The line endings of a text: all «\n», all «\r\n», all «\r», or a mixture (then not changed unless asked). */
export type Eol = 'lf' | 'crlf' | 'cr' | 'mixed';
export function detectEol(text: string): Eol {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 13) { if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++; } else if (c === 10) lf++; }
  const kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0); if (kinds > 1) return 'mixed'; return crlf ? 'crlf' : cr ? 'cr' : 'lf';
}
export const toLf = (text: string): string => text.replace(/\r\n?/g, '\n');
export const withEol = (text: string, eol: Eol): string => (eol === 'crlf' ? text.replace(/\n/g, '\r\n') : eol === 'cr' ? text.replace(/\n/g, '\r') : text);

/** The text of these bytes. `whole`: false when only the start of a bigger file was read (then read-only). */
export function decodeText(b: Uint8Array, whole = true): Decoded {
  const done = (text: string, charset: Charset, bom: boolean): Decoded => {
    if (!whole) return { text, charset, bom, safe: false, why: 'partial' };
    return same(b, encodeText(text, charset, bom)) ? { text, charset, bom, safe: true } : { text, charset, bom, safe: false, why: 'unknown' };
  };
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return done(new TextDecoder('utf-8').decode(b.subarray(3)), 'utf-8', true);
  if (b[0] === 0xff && b[1] === 0xfe) return done(new TextDecoder('utf-16le').decode(b.subarray(2)), 'utf-16le', true);
  if (b[0] === 0xfe && b[1] === 0xff) return done(new TextDecoder('utf-16be').decode(b.subarray(2)), 'utf-16be', true);
  // (UTF-16 without a mark: most of the odd — or even — bytes zero, as Latin text in UTF-16 is.)
  if (b.length >= 4 && b.length % 2 === 0) {
    let odd = 0, even = 0; const n = Math.min(b.length, 4096);
    for (let i = 0; i < n; i += 2) { if (b[i] === 0) even++; if (b[i + 1] === 0) odd++; }
    if (odd > n / 2 * 0.6 && even === 0) return done(new TextDecoder('utf-16le').decode(b), 'utf-16le', false);
    if (even > n / 2 * 0.6 && odd === 0) return done(new TextDecoder('utf-16be').decode(b), 'utf-16be', false);
  }
  // (Zero bytes or other control bytes in a file that is not UTF-16: a binary file, shown but never written.)
  let ctrl = 0; for (let i = 0; i < Math.min(b.length, 65536); i++) { const c = b[i]; if (c === 0) { ctrl = 1e9; break; } if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++; }
  if (ctrl > 8) return { text: new TextDecoder('utf-8').decode(b), charset: 'utf-8', bom: false, safe: false, why: 'binary' };
  // (A file cut off by the read may end inside a character: its last three bytes are not held against UTF-8.)
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(whole ? b : b.subarray(0, Math.max(0, b.length - 3))); return done(whole ? text : new TextDecoder('utf-8').decode(b), 'utf-8', false); }
  catch { return done(new TextDecoder('windows-1256').decode(b), 'windows-1256', false); }
}

/** Base64 ↔ bytes (the plugin hands bytes over as base64). */
export function fromB64(s: string): Uint8Array { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
export function toB64(b: Uint8Array): string { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }
/** The charset's name for people. */
export const charsetName = (c: Charset): string => ({ 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', 'windows-1256': 'Windows-1256', 'windows-1252': 'Windows-1252', shift_jis: 'Shift_JIS' })[c];
