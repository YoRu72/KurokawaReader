// The one quiet line a download's details (and a torrent's trackers) show while DNS over HTTPS is on: which resolver
// found the site's name, or that it came from memory, from the system's DNS (allowed in Settings), or that no
// resolver answered (0.21 P9). Asked of the shell once, kept ten seconds — the details page redraws often.
import { h } from './dom';
import { t, localDigits } from '../i18n';
import { dohLabel } from '../dohProviders';
import { dohApi } from './dohSettings';

const kept = new Map<string, { at: number; via: string | null }>();

/** A resolver's failure reason as the shells give it («timeout», «HTTP 503», «DNS answer truncated»…) in the page's
 *  words — never the raw text. */
export function reasonText(raw: string | undefined | null): string {
  const r = String(raw ?? '').trim();
  if (!r) return t('dohWhy_other');
  const http = /HTTP (\d{3})/.exec(r); if (http) return t('dohWhy_http', { code: localDigits(Number(http[1])) });
  const table: [RegExp, string][] = [[/^private$/i, 'dohWhy_private'], [/blocked/i, 'dohWhy_blocked'], [/deadline/i, 'dohWhy_deadline'], [/timeout|timed out/i, 'dohWhy_timeout'], [/no usable address/i, 'dohWhy_noAddress'], [/no such name|NXDOMAIN|does not exist/i, 'dohWhy_noSuchName'], [/no resolver answered/i, 'dohWhy_noResolver'], [/busy/i, 'dohWhy_busy'], [/DNS answer|not a DNS answer|another question|DoH JSON/i, 'dohWhy_badAnswer'], [/unknown/i, 'dohWhy_unknown'], [/not reached|refused|unreachable|reset|ECONN|EHOST|ENETUNREACH|connect|handshake|closed|no answer|own name not found/i, 'dohWhy_notReached']];
  for (const [re, k] of table) if (re.test(r)) return t(k as 'dohWhy_other');
  return t('dohWhy_other');
}

/** A shell's answer («doh:<id>:<ms>», «cache:<id>», «stale:<id>», «system», «local», «none:<id>», «blocked:<id>»,
 *  «private», «failed», «engine», «dropped…») in words. */
export function viaText(via: string): string {
  const [k, id, ms] = via.split(':'); const name = dohLabel(id ?? '');
  switch (k) {
    case 'blocked': return t('dohVia_blocked', { name });
    case 'private': return t('dohVia_private');
    case 'dropped': return t('dohVia_dropped');
    case 'doh': return t('dohVia_doh', { name, ms: localDigits(Number(ms) || 0) });
    case 'cache': return t('dohVia_cache', { name });
    case 'stale': return t('dohVia_stale', { name });
    case 'none': return t('dohVia_none', { name });
    case 'system': return t('dohVia_system');
    case 'local': return t('dohVia_local');
    case 'failed': return t('dohVia_failed');
    case 'engine': return t('dohVia_engine');
    default: return t('dohVia_unknown');
  }
}

/** What answered `host` (null: not asked through the chain yet, or DoH off). */
export async function viaFor(host: string): Promise<string | null> {
  const k = host.toLowerCase(); const had = kept.get(k); if (had && Date.now() - had.at < 10000) return had.via;
  const api = dohApi(); if (!api) return null;
  let via: string | null = null; try { const u = await api.used([k]); via = u?.on ? u.hosts[k]?.via ?? null : null; } catch { via = null; }
  kept.set(k, { at: Date.now(), via }); if (kept.size > 200) kept.delete(kept.keys().next().value!);
  return via;
}

/** The line for a download from `url` (empty and hidden until — and unless — there is something to say). */
export function dohLine(url: string): HTMLElement {
  const el = h('p', { class: 'src doh-line', hidden: true }); let host = '';
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return el; }
  void viaFor(host).then((via) => { if (!via) return; el.textContent = viaText(via); el.dataset.via = via.split(':')[0]; el.hidden = false; });
  return el;
}
