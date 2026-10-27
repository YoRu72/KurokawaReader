// Reaching a site from a source: the request goes through native code on the phone and the desktop (so a
// site with no CORS headers answers, and the app's own cookies go with it — the clearance a Cloudflare check
// leaves behind), with the browser's own identity; what comes back is read for the things that go wrong —
// a Cloudflare check, a rate limit, the network gone — so the view can say so and offer the way through.
import { http, isWebOnly, type HttpInit } from '../net';
import { SourceError } from './types';

const CHALLENGE = /<title>\s*(Just a moment|Attention Required|Один момент|لحظة واحدة)|cf-chl|challenge-platform|_cf_chl_opt|cf-browser-verification/i;

/** GET a page or a JSON document as text. */
export async function fetchText(url: string, init: HttpInit = {}): Promise<string> {
  const headers: Record<string, string> = { 'accept-language': 'ar,en;q=0.8', accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...init.headers };
  if (!isWebOnly()) headers['user-agent'] = navigator.userAgent;
  let r;
  try { r = await http(url, { ...init, headers }); }
  catch (e) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SourceError('offline', 'offline');
    if (isWebOnly()) throw new SourceError('cors', 'cors');
    throw new SourceError(String((e as Error).message ?? e), 'offline');
  }
  if ((r.status === 403 || r.status === 503 || r.status === 429) && CHALLENGE.test(r.body.slice(0, 4000))) throw new SourceError('cloudflare', 'cloudflare', r.status);
  if (r.status === 429) throw new SourceError('rate', 'rate', 429);
  if (r.status === 401) throw new SourceError('auth', 'auth', 401);
  if (r.status >= 400) throw new SourceError(`HTTP ${r.status}`, 'http', r.status);
  return r.body;
}

export async function fetchJson<T>(url: string, init: HttpInit = {}): Promise<T> {
  const text = await fetchText(url, { ...init, headers: { accept: 'application/json', ...init.headers } });
  try { return JSON.parse(text) as T; } catch { throw new SourceError('parse', 'parse'); }
}

/** A page's document (parsed, scripts inert). */
export async function fetchDoc(url: string, init: HttpInit = {}): Promise<Document> {
  const html = await fetchText(url, init);
  return new DOMParser().parseFromString(html, 'text/html');
}

/** A file, as bytes, with progress where the platform reports it. */
export async function fetchBytes(url: string, onProgress?: (p: { pct: number; got: number; total: number }) => void): Promise<Uint8Array> {
  onProgress?.({ pct: 0, got: 0, total: 0 });
  const headers: Record<string, string> = {};
  if (!isWebOnly()) headers['user-agent'] = navigator.userAgent;
  const r = await http(url, { binary: true, headers });
  if (r.status >= 400) throw new SourceError(`HTTP ${r.status}`, r.status === 429 ? 'rate' : 'http', r.status);
  const bin = atob(r.body); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  onProgress?.({ pct: 100, got: bytes.length, total: bytes.length });
  return bytes;
}

/** Open the site in a view that shares the app's cookies, so a Cloudflare check can be passed by hand; the
 *  promise resolves when the view closes. On the web it can only open the site in a tab. */
export async function passChallenge(url: string): Promise<void> {
  const cap = (window as unknown as { Capacitor?: { Plugins?: { Kurokawa?: { openWebView?(o: { url: string }): Promise<unknown> } } } }).Capacitor;
  if (cap?.Plugins?.Kurokawa?.openWebView) { await cap.Plugins.Kurokawa.openWebView({ url }); return; }
  const desk = (window as unknown as { kurokawaDesktop?: { openWebView?(u: string): Promise<unknown> } }).kurokawaDesktop;
  if (desk?.openWebView) { await desk.openWebView(url); return; }
  window.open(url, '_blank', 'noopener');
}

/** Run several requests at once, a few at a time, in order of the input. */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>, live?: () => boolean): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  const worker = async () => { while (next < items.length && (!live || live())) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
