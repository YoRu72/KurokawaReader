// A download's failure in words the reader can use: what the engines throw as raw English («yt-dlp made no file»,
// «Unsupported URL: …») said plainly in the page's language. The raw line is kept in the log and under the plain one.
import { t } from '../i18n';

/** The extractor (yt-dlp) ended with no file. */
export const NO_FILE = /made no file/i;
/** The extractor does not know the link. */
export const UNSUPPORTED = /unsupported url/i;
/** Failures of the extractor on a link that may be a plain file: the direct engine is tried once (downloads/fallback.ts). */
export const EXTRACTOR_MISS = /made no file|unsupported url|no video formats found|is not a valid url/i;
/** A certificate the engine would not accept (aria2's words, Java's, Node's). */
export const CERT = /certificate|SSL\/TLS handshake|x509|CERT_|PKIX|self.signed/i;
/** Whether the raw line is one the page should not show as it is (the DoH chain's own words). */
export const hideRaw = (raw: string): boolean => /DNS over HTTPS:/.test(raw) || CERT.test(raw);
const NAMES: Record<string, string> = { cloudflare: 'Cloudflare', google: 'Google', quad9: 'Quad9', adguard: 'AdGuard', 'adguard-unfiltered': 'AdGuard (unfiltered)', dnssb: 'DNS.SB', controld: 'Control D', wikimedia: 'Wikimedia DNS', dns4eu: 'DNS4EU' };
const providerName = (id: string): string => (id === 'custom' ? t('dohCustomName') : NAMES[id] ?? t('dohCustomName'));

/** The plain wording of a raw engine error, or null when it has none (it is shown as it is then). */
export function plainEngineError(raw: string): string | null {
  // (0.21 P9: the DNS-over-HTTPS chain's own failures, and a certificate the engine refused.)
  const blocked = /DNS over HTTPS: \S+ is blocked by (\S+)/.exec(raw); if (blocked) return t('errDohBlocked', { name: providerName(blocked[1]) });
  if (/DNS over HTTPS: no resolver answered/.test(raw)) return /not allowed/.test(raw) ? t('errDohNoneNoSystem') : t('errDohNone');
  if (CERT.test(raw)) return t('errCert');
  if (NO_FILE.test(raw)) return t('errExtractorNoFile');
  if (UNSUPPORTED.test(raw)) return t('errExtractorUnsupported');
  return null;
}

/** What a failed download's card says and offers next (D4): the engines' raw failures — the phone's («HTTP 403»,
 *  «incomplete», «Too many redirects», «No space left on device», Java's network messages), aria2's on a computer
 *  («… status=403 (22)», «Not enough disk space (9)»: its message and its code) — as one plain reason in the page's
 *  language, and the step that can help: a new link (the bytes here kept), another folder, the page in the browser,
 *  or trying again. `net`: failed for want of a connection (tried again by itself when the device is back online).
 *  Null: no plain wording (the raw line is shown, as before). */
export type FailStep = 'newUrl' | 'chooseFolder' | 'browser' | 'retry';
export interface Failure { text: string; step: FailStep; net?: boolean }
export function failureOf(raw: string | undefined): Failure | null {
  if (!raw) return null;
  if (raw === 'page') return { text: t('errPageShort'), step: 'browser' };
  const aria = /\((\d+)\)\s*$/.exec(raw); const code = aria ? Number(aria[1]) : -1;
  const status = Number((/^HTTP (\d{3})$/.exec(raw) ?? /status=(\d{3})/.exec(raw) ?? [])[1] ?? 0);
  if (raw === 'noFolderAccess' || /EPERM|EACCES|Permission denied|Read-only file system/i.test(raw) || code === 16 || code === 18) return { text: t('failFolder'), step: 'chooseFolder' };
  if (/No space left|ENOSPC|disk space/i.test(raw) || code === 9) return { text: t('failFull'), step: 'chooseFolder' };
  if (status === 401 || status === 403 || status === 410 || code === 24) return { text: t('failExpired'), step: 'newUrl' };
  if (status === 404 || code === 3) return { text: t('failGone'), step: 'newUrl' };
  if (status === 429 || status === 503 || code === 29) return { text: t('failBusy'), step: 'retry' };
  if (status >= 500) return { text: t('failServer'), step: 'retry' };
  if (/Too many redirects/i.test(raw) || code === 23) return { text: t('failRedirects'), step: 'retry' };
  if (/stalled|too slow/i.test(raw) || code === 5) return { text: t('failStalled'), step: 'retry' };
  if (/incomplete|Premature EOF|unexpected end|closed early|Connection reset|broken pipe/i.test(raw) || code === 8) return { text: t('failCut'), step: 'retry' };
  if (/Unable to resolve host|UnknownHost|Name resolution|Network is unreachable|failed to connect|Connection refused|No route to host|timed out|timeout|Network problem/i.test(raw) || code === 19 || code === 6 || code === 2) return { text: t('failNet'), step: 'retry', net: true };
  if (/checksum|hash mismatch/i.test(raw) || code === 32) return { text: t('failChecksum'), step: 'retry' };
  if (code === 17 || /I\/O error|EIO/i.test(raw)) return { text: t('failFile'), step: 'chooseFolder' };
  const plain = plainEngineError(raw); return plain ? { text: plain, step: 'retry' } : null;
}

/** Back online: the downloads that failed for want of a connection tried again by themselves, once for each time the
 *  connection comes back (the engine's own waits end after its tries; this picks them up). */
let onlineWired = false;
export function retryWhenOnline(list: () => Promise<{ id: string; state: string; error?: string }[]>, resume: (id: string) => Promise<unknown>, said: (n: number) => void): void {
  if (onlineWired) return; onlineWired = true;
  window.addEventListener('online', () => { void list().then(async (xs) => { const net = xs.filter((x) => x.state === 'failed' && failureOf(x.error)?.net); let n = 0; for (const x of net) { try { await resume(x.id); n++; } catch { /* one at a time */ } } if (n) said(n); }).catch(() => undefined); });
}

/** Tasks begun by the direct fallback in this session (their log says so; the engine's own meta may not keep the mark). */
export const retried = new Set<string>();
export const wasRetried = (x: { id: string; meta?: { directRetry?: boolean } }): boolean => retried.has(x.id) || !!x.meta?.directRetry;
