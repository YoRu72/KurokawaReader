// A download's failure in words the reader can use: what the engines throw as raw English («yt-dlp made no file»,
// «Unsupported URL: …») said plainly in the page's language. The raw line is kept in the log and under the plain one.
import { t } from '../i18n';

/** The extractor (yt-dlp) ended with no file. */
export const NO_FILE = /made no file/i;
/** The extractor does not know the link. */
export const UNSUPPORTED = /unsupported url/i;
/** Failures of the extractor on a link that may be a plain file: the direct engine is tried once (downloads/fallback.ts). */
export const EXTRACTOR_MISS = /made no file|unsupported url|no video formats found|is not a valid url/i;
/** The plain wording of a raw engine error, or null when it has none (it is shown as it is then). */
export function plainEngineError(raw: string): string | null {
  if (NO_FILE.test(raw)) return t('errExtractorNoFile');
  if (UNSUPPORTED.test(raw)) return t('errExtractorUnsupported');
  return null;
}

/** Tasks begun by the direct fallback in this session (their log says so; the engine's own meta may not keep the mark). */
export const retried = new Set<string>();
export const wasRetried = (x: { id: string; meta?: { directRetry?: boolean } }): boolean => retried.has(x.id) || !!x.meta?.directRetry;
