// Protected PDFs, handled quietly: a password is asked for once and remembered for that file (kept on this
// device only, with the library), and a file pdf.js cannot read properly is opened from a copy decrypted
// here instead (src/pdfcrypt.ts).
import { db } from './db';

const KEY = 'pdfPasswords';
type Keyring = Record<string, string>;
let ring: Promise<Keyring> | null = null;
const load = (): Promise<Keyring> => (ring ??= db.getMeta<Keyring>(KEY).then((r) => r ?? {}).catch((): Keyring => ({})));

/** A fingerprint of a file's bytes (its size and FNV-1a of its first and last 64 KB). */
export function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  const take = (a: number, b: number) => { for (let i = a; i < b; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; } };
  const n = bytes.length, k = 1 << 16;
  take(0, Math.min(n, k)); if (n > k) take(Math.max(k, n - k), n);
  return `${n.toString(36)}-${h.toString(36)}`;
}

/** The password remembered for this file (by its fingerprint), if any. */
export async function knownPassword(fp: string): Promise<string | undefined> {
  return (await load())[fp];
}

/** Remember the password that opened this file. */
export async function rememberPassword(fp: string, password: string | undefined): Promise<void> {
  if (!password) return;
  const r = await load();
  if (r[fp] === password) return;
  r[fp] = password;
  await db.setMeta(KEY, r).catch(() => { /* best effort */ });
}

/** Is this PDF encrypted? (A quick look; pdf.js and pdfcrypt have the final word.) */
export async function isEncrypted(bytes: Uint8Array): Promise<boolean> {
  const { looksEncrypted } = await import('./pdfcrypt');
  return looksEncrypted(bytes);
}

/** The same PDF without its encryption, decrypted here; null when that cannot be done (wrong password, a
 *  handler this code does not know). */
export async function decryptedCopy(bytes: Uint8Array, password = ''): Promise<Uint8Array | null> {
  try {
    const { openPdf } = await import('./pdfcrypt');
    const doc = await openPdf(bytes, password);
    return await doc.save({ useObjectStreams: false });
  } catch { return null; }
}

/** Text that came out of a protected file broken — mostly control or replacement characters, or nothing at
 *  all where glyphs were drawn — is the sign that its strings were not decrypted. */
export function looksGarbled(text: string, glyphs: number): boolean {
  const t = text.replace(/\s+/g, '');
  if (glyphs > 40 && t.length < glyphs * 0.05) return true;
  if (t.length < 20) return false;
  let bad = 0;
  for (const ch of t) { const c = ch.codePointAt(0)!; if (c < 0x20 || c === 0xfffd || (c >= 0x7f && c < 0xa0)) bad++; }
  return bad / t.length > 0.2;
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type Opened = { doc: import('pdfjs-dist').PDFDocumentProxy; destroy: () => void; encrypted: boolean; password?: string; bytes: Uint8Array };

/**
 * Open a PDF with pdf.js the quiet way: with the password remembered for it (or the one given), asking for
 * one only when `ask` is set (otherwise a missing or wrong one throws Error('password')), remembering the
 * one that worked, and — when pdf.js cannot open a protected file — from a copy decrypted here.
 */
export async function openPdfjs(pdfjs: PdfJs, bytes: Uint8Array, options: Record<string, unknown>, opts: { password?: string; ask?: (wrong: boolean) => string | null } = {}): Promise<Opened> {
  const fp = fingerprint(bytes);
  const encrypted = await isEncrypted(bytes);
  let used = opts.password ?? (encrypted ? await knownPassword(fp) : undefined);
  let cancelled = false;
  const attempt = async (data: Uint8Array, password: string | undefined, prompt: boolean) => {
    // (pdf.js takes over the buffer it is given: a protected file keeps its own copy for the fallback.)
    const task = pdfjs.getDocument({ ...options, data: encrypted ? data.slice() : data, password } as Parameters<PdfJs['getDocument']>[0]);
    if (prompt && opts.ask) {
      task.onPassword = (update: (pw: string) => void, reason: number) => {
        const pw = opts.ask!(reason === 2);
        if (!pw) { cancelled = true; void task.destroy(); return; }
        used = pw; update(pw);
      };
    }
    const doc = await task.promise;
    return { doc, destroy: () => { void task.destroy(); } };
  };
  try {
    const o = await attempt(bytes, used, true);
    if (encrypted && used) void rememberPassword(fp, used);
    return { ...o, encrypted, password: used, bytes };
  } catch (e) {
    if (cancelled) throw new Error('cancelled');
    const name = (e as Error).name;
    if (name === 'PasswordException') {
      if (used && opts.password === undefined) {
        // A remembered password that no longer opens it: forget it and ask as usual.
        const r = await load(); delete r[fp]; await db.setMeta(KEY, r).catch(() => {});
      }
      throw new Error('password');
    }
    if (!encrypted) throw e;
    const plain = await decryptedCopy(bytes, used ?? '');
    if (!plain) throw e;
    const o = await attempt(plain, undefined, false);
    return { ...o, encrypted: false, bytes: plain };
  }
}

/** Reopen a protected file from a copy decrypted here (its text came out broken through pdf.js). */
export async function reopenDecrypted(pdfjs: PdfJs, o: Opened, options: Record<string, unknown>): Promise<Opened | null> {
  const plain = await decryptedCopy(o.bytes, o.password ?? '');
  if (!plain) return null;
  o.destroy();
  const task = pdfjs.getDocument({ ...options, data: plain } as Parameters<PdfJs['getDocument']>[0]);
  const doc = await task.promise;
  return { doc, destroy: () => { void task.destroy(); }, encrypted: false, bytes: plain };
}
