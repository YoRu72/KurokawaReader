// The DNS-over-HTTPS resolvers the settings offer — core/kt-core/src/doh-providers.txt's ids, names, addresses and
// what each blocks by itself (tests/dohchain.cjs checks this copy against the table). Loaded with the DoH settings
// only (never at start).
export type DohProvider = { id: string; label: string; url: string; filters: 'none' | 'malware' | 'ads' | 'phishing' | 'legal' };
export const DOH_PROVIDERS: DohProvider[] = [
  { id: 'cloudflare', label: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query', filters: 'none' },
  { id: 'google', label: 'Google', url: 'https://dns.google/dns-query', filters: 'none' },
  { id: 'quad9', label: 'Quad9', url: 'https://dns.quad9.net/dns-query', filters: 'malware' },
  { id: 'adguard', label: 'AdGuard', url: 'https://dns.adguard-dns.com/dns-query', filters: 'ads' },
  { id: 'adguard-unfiltered', label: 'AdGuard (unfiltered)', url: 'https://unfiltered.adguard-dns.com/dns-query', filters: 'none' },
  { id: 'dnssb', label: 'DNS.SB', url: 'https://185.222.222.222/dns-query', filters: 'none' },
  { id: 'controld', label: 'Control D', url: 'https://freedns.controld.com/p0', filters: 'none' },
  { id: 'wikimedia', label: 'Wikimedia DNS', url: 'https://wikimedia-dns.org/dns-query', filters: 'none' },
  { id: 'dns4eu', label: 'DNS4EU', url: 'https://unfiltered.joindns4.eu/dns-query', filters: 'legal' },
];
/** A provider's name as shown (the id when it is not in the table: «custom», an old one). */
export const dohLabel = (id: string): string => DOH_PROVIDERS.find((p) => p.id === id)?.label ?? id;
/** A saved choice no longer offered (Mullvad, discontinued; OpenDNS, removed) is «auto». */
export const dohChoice = (v: string): string => (v === 'mullvad' || v === 'opendns' ? 'auto' : v);

/** The user's own address checked — kt-core dohchain.rs validate_custom's twin: 'ok' or why it is refused. */
export function validateDohUrl(url: string): 'ok' | 'notHttps' | 'noHost' | 'badPort' | 'userinfo' | 'badPath' | 'space' | 'tooLong' {
  const u = url.trim(); if (u.length > 512) return 'tooLong'; if (/[\s\x00-\x1f\x7f]/.test(u)) return 'space';
  const lower = u.toLowerCase(); let rest: string;
  const hostOf = (r: string) => { const a = r.split(/[/?#]/)[0].split('@').pop() ?? ''; return a.startsWith('[') ? a.slice(1).split(']')[0] : a.split(':')[0]; };
  if (lower.startsWith('https://')) rest = lower.slice(8);
  else if (lower.startsWith('http://')) { if (!['127.0.0.1', 'localhost', '::1'].includes(hostOf(lower.slice(7)))) return 'notHttps'; rest = lower.slice(7); }
  else return 'notHttps';
  const end = rest.search(/[/?#]/); const auth = end < 0 ? rest : rest.slice(0, end); const p = end < 0 ? '' : rest.slice(end);
  if (auth.includes('@')) return 'userinfo';
  let host: string; let port: string | undefined;
  if (auth.startsWith('[')) { const i = auth.indexOf(']'); if (i < 0) return 'noHost'; host = auth.slice(1, i); const after = auth.slice(i + 1); port = after.startsWith(':') ? after.slice(1) : undefined; }
  else { const i = auth.indexOf(':'); host = i < 0 ? auth : auth.slice(0, i); port = i < 0 ? undefined : auth.slice(i + 1); }
  if (!host) return 'noHost';
  if (port !== undefined && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return 'badPort';
  if (p.includes('#') || !p.startsWith('/') || p === '/' || p.startsWith('/?')) return 'badPath';
  return 'ok';
}
