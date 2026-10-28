// A request that reaches any server: native code on the phone and the desktop (no CORS), fetch on the web.
// Shared by the catalogues (OPDS), the sources (archive.org, Shamela) and anything else that talks to a site.

export interface HttpResult { status: number; headers: Record<string, string>; body: string; url?: string /* where the answer came from, after redirects */; /** a binary answer's bytes, when it came as bytes (see bodyBytes) */ bytes?: Uint8Array }
export type HttpInit = { method?: string; headers?: Record<string, string>; body?: string; binary?: boolean; bodyBase64?: boolean };

let fileSeq = 0;
/** A native answer whose binary body came as a file (`bodyPath`: too big for the bridge's JSON): read through
 *  the app's file server as bytes; its base64 `body` made only if something asks for it. */
export async function withBody<T extends HttpResult & { bodyPath?: string }>(r: T): Promise<T> {
  if (!r || !r.bodyPath) return r;
  const cap = (window as unknown as { Capacitor?: { convertFileSrc?(p: string): string } }).Capacitor;
  const src = cap?.convertFileSrc ? cap.convertFileSrc(`file://${r.bodyPath}`) : null;
  if (!src) return r;
  const bytes = new Uint8Array(await (await fetch(`${src}?v=${++fileSeq}`, { cache: 'no-store' })).arrayBuffer());
  r.bytes = bytes; delete r.bodyPath;
  let b64: string | null = null;
  Object.defineProperty(r, 'body', { configurable: true, enumerable: true, get() { if (b64 === null) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); b64 = btoa(s); } return b64; }, set(v: string) { b64 = v; } });
  return r;
}
/** The bytes of a binary answer, however it came. */
export async function bodyBytes(r: HttpResult): Promise<Uint8Array> {
  if (r.bytes) return r.bytes;
  if (r.body.length >= 32 * 1024) { try { return new Uint8Array(await (await fetch(`data:application/octet-stream;base64,${r.body}`)).arrayBuffer()); } catch { /* below */ } }
  const bin = atob(r.body); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function http(url: string, init: HttpInit = {}): Promise<HttpResult> {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; Plugins?: { Kurokawa?: { httpRequest?(o: unknown): Promise<HttpResult> } } } }).Capacitor;
  if (cap?.isNativePlatform?.() && cap.Plugins?.Kurokawa?.httpRequest) return withBody(await cap.Plugins.Kurokawa.httpRequest({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null, binary: !!init.binary, bodyBase64: !!init.bodyBase64 }));
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
