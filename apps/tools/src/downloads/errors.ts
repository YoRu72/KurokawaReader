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

/** Tasks begun by the direct fallback in this session (their log says so; the engine's own meta may not keep the mark). */
export const retried = new Set<string>();
export const wasRetried = (x: { id: string; meta?: { directRetry?: boolean } }): boolean => retried.has(x.id) || !!x.meta?.directRetry;
