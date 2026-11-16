// The one quiet line a download's details (and a torrent's trackers) show while DNS over HTTPS is on: which resolver
// found the site's name, or that it came from memory, from the system's DNS (allowed in Settings), or that no
// resolver answered (0.21 P9). Asked of the shell once, kept ten seconds — the details page redraws often.
import { h } from './dom';
import { t, localDigits } from '../i18n';
import { dohLabel } from '../dohProviders';
import { dohApi } from './dohSettings';

const kept = new Map<string, { at: number; via: string | null }>();

/** A shell's answer («doh:<id>:<ms>», «cache:<id>», «stale:<id>», «system», «local», «none:<id>», «failed», «engine»)
 *  in words. */
export function viaText(via: string): string {
  const [k, id, ms] = via.split(':'); const name = dohLabel(id ?? '');
  switch (k) {
    case 'doh': return t('dohVia_doh', { name, ms: localDigits(Number(ms) || 0) });
    case 'cache': return t('dohVia_cache', { name });
    case 'stale': return t('dohVia_stale', { name });
    case 'none': return t('dohVia_none', { name });
    case 'system': return t('dohVia_system');
    case 'local': return t('dohVia_local');
    case 'failed': return t('dohVia_failed');
    case 'engine': return t('dohVia_engine');
    default: return via;
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
