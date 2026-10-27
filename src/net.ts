// A request that reaches any server: native code on the phone and the desktop (no CORS), fetch on the web.
// Shared by the catalogues (OPDS), the sources (archive.org, Shamela) and anything else that talks to a site.

export interface HttpResult { status: number; headers: Record<string, string>; body: string; url?: string /* where the answer came from, after redirects */ }
export type HttpInit = { method?: string; headers?: Record<string, string>; body?: string; binary?: boolean; bodyBase64?: boolean };

export async function http(url: string, init: HttpInit = {}): Promise<HttpResult> {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; Plugins?: { Kurokawa?: { httpRequest?(o: unknown): Promise<HttpResult> } } } }).Capacitor;
  if (cap?.isNativePlatform?.() && cap.Plugins?.Kurokawa?.httpRequest) return cap.Plugins.Kurokawa.httpRequest({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null, binary: !!init.binary, bodyBase64: !!init.bodyBase64 });
  const desk = (window as unknown as { kurokawaDesktop?: { http?(o: unknown): Promise<HttpResult> } }).kurokawaDesktop;
  if (desk?.http) return desk.http({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null, binary: !!init.binary, bodyBase64: !!init.bodyBase64 });
  const r = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body });
  const headers: Record<string, string> = {}; r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  if (!init.binary) return { status: r.status, headers, body: await r.text(), url: r.url };
  const bytes = new Uint8Array(await r.arrayBuffer()); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { status: r.status, headers, body: btoa(s), url: r.url };
}


/** True on the web (a page in a browser), where a site without CORS headers cannot be read. */
export function isWebOnly(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean } }).Capacitor;
  return !cap?.isNativePlatform?.() && !(window as unknown as { kurokawaDesktop?: unknown }).kurokawaDesktop;
}
