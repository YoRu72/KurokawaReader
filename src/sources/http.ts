// Reaching a site from a source: the request goes through native code on the phone and the desktop (so a
// site with no CORS headers answers, and the app's own cookies go with it — the clearance a Cloudflare check
// leaves behind), with the browser's own identity; what comes back is read for the things that go wrong —
// a Cloudflare check, a rate limit, the network gone — so the view can say so and offer the way through.
//
// A browser check is passed on the app's own: the page is opened in a web view of the app's (its cookies and
// identity are those the requests carry), out of sight first — the plain JavaScript checks pass by themselves
// in a few seconds — and shown only when the site insists on a click; then the request is made again. One
// pass at a time per site, the other requests waiting for it. A site that says "busy" (429, or 503 with a
// Retry-After) is given the wait it asks for and asked again; a connection that drops is tried once more.
import { http, isWebOnly, type HttpInit, type HttpResult } from '../net';
import { SourceError } from './types';

const CHALLENGE = /<title>\s*(Just a moment|Attention Required|Один момент|لحظة واحدة|Please wait|Checking your browser|Verifying you are human|DDoS-Guard|Access denied)|cf-chl|challenge-platform|_cf_chl_opt|cf-browser-verification|cf_chl_|cdn-cgi\/challenge-platform|turnstile|__ddg|ddos-guard|sucuri_cloudproxy/i;
const CHALLENGE_TITLE = /Just a moment|Attention Required|Один момент|لحظة|Please wait|Checking your browser|Verifying you are human|DDoS-Guard|Access denied/i;

export interface RequestInit extends HttpInit {
  /** Never show a web view for a browser check (a check in the background): the error is raised instead. */
  quiet?: boolean;
  /** How many times to ask again after a "busy" answer (429 / 503 with Retry-After); 2 by default. */
  retries?: number;
}

/** The answer looks like a browser check (Cloudflare's, DDoS-Guard's…) rather than the page. */
export function looksLikeChallenge(r: HttpResult, binary = false): boolean {
  if ((r.headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge') return true;
  if (r.status !== 403 && r.status !== 503 && r.status !== 401 && r.status !== 429) return false;
  if (r.body.length > 2_000_000) return false;
  let head = r.body.slice(0, 8000);
  if (binary) { try { head = atob(head.slice(0, 8000 - (8000 % 4))); } catch { return false; } }
  return CHALLENGE.test(head);
}

/* ---------- the pass through a browser check ---------- */
type Opener = { openWebView(o: { url: string; hidden?: boolean; timeout?: number }): Promise<{ passed?: boolean } | void> };
function opener(): Opener | null {
  const cap = (window as unknown as { Capacitor?: { Plugins?: { Kurokawa?: Opener } } }).Capacitor;
  if (cap?.Plugins?.Kurokawa?.openWebView) return cap.Plugins.Kurokawa;
  const desk = (window as unknown as { kurokawaDesktop?: { openWebView?(u: string | { url: string; hidden?: boolean; timeout?: number }): Promise<{ passed?: boolean } | boolean | void> } }).kurokawaDesktop;
  if (desk?.openWebView) return { openWebView: (o) => desk.openWebView!(o).then((r) => (typeof r === 'object' && r ? r : { passed: !!r })) };
  return null;
}
const passing = new Map<string, Promise<boolean>>();
const declined = new Map<string, number>();   // a site whose check the reader closed without passing: not shown again for a while
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** Pass the site's check: out of sight first, then — unless `quiet` — in a view the reader can act in.
 *  Resolves true when the site answered with a page of its own afterwards. */
export async function solveChallenge(url: string, quiet = false): Promise<boolean> {
  const host = hostOf(url);
  const running = passing.get(host); if (running) return running;
  const p = (async () => {
    const o = opener(); if (!o) return false;
    try {
      const hid = await o.openWebView({ url, hidden: true, timeout: 14000 }).catch(() => ({ passed: false }));
      if (hid && (hid as { passed?: boolean }).passed) return true;
      if (quiet) return false;
      if ((declined.get(host) ?? 0) > Date.now()) return false;
      const vis = await o.openWebView({ url, timeout: 180000 }).catch(() => ({ passed: false }));
      const ok = !!(vis && (vis as { passed?: boolean }).passed);
      if (!ok) declined.set(host, Date.now() + 90_000);
      return ok;
    } finally { passing.delete(host); }
  })();
  passing.set(host, p);
  return p;
}

/** Open the site in a view that shares the app's cookies, so a check can be passed by hand (the button in an
 *  error); the promise resolves when the view closes. On the web it can only open the site in a tab. */
export async function passChallenge(url: string): Promise<void> {
  declined.delete(hostOf(url));
  const o = opener();
  if (o) { await o.openWebView({ url, timeout: 180000 }).catch(() => undefined); return; }
  window.open(url, '_blank', 'noopener');
}

/* ---------- requests: a few at a time per site, asked again when the site says so ---------- */
const lanes = new Map<string, { running: number; queue: (() => void)[] }>();
const PER_HOST = 4;
async function lane<T>(host: string, fn: () => Promise<T>): Promise<T> {
  let l = lanes.get(host); if (!l) { l = { running: 0, queue: [] }; lanes.set(host, l); }
  if (l.running >= PER_HOST) await new Promise<void>((r) => l!.queue.push(r));
  l.running++;
  try { return await fn(); }
  finally { l.running--; const next = l.queue.shift(); if (next) next(); else if (!l.running) lanes.delete(host); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryAfter = (r: HttpResult, attempt: number) => { const h = Number(r.headers['retry-after']); return Math.min(20000, (Number.isFinite(h) && h > 0 ? h * 1000 : 1500 * attempt) + Math.random() * 400); };

const DEFAULT_HEADERS: Record<string, string> = { 'accept-language': 'ar,en;q=0.8', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,image/avif,image/webp,*/*;q=0.8' };

/** A request with the whole treatment: the app's identity, a browser check passed and the request made again,
 *  a busy site waited for. Throws a SourceError for what cannot be helped. */
export async function request(url: string, init: RequestInit = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  for (const [k, v] of Object.entries(init.headers ?? {})) { const key = k.toLowerCase(); if (key === 'accept-encoding') continue; headers[key] = v; }
  if (!isWebOnly() && !headers['user-agent']) headers['user-agent'] = navigator.userAgent;
  const host = hostOf(url);
  return lane(host, async () => {
    let r: HttpResult | null = null; let passed = false; let tries = 0; let hops = 0;
    const retries = init.retries ?? 2;
    for (;;) {
      try { r = await http(url, { ...init, headers }); }
      catch (e) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SourceError('offline', 'offline');
        if (isWebOnly()) throw new SourceError('cors', 'cors');
        if (tries < 1) { tries++; await sleep(800); continue; }
        throw new SourceError(String((e as Error).message ?? e), 'offline');
      }
      if (looksLikeChallenge(r, !!init.binary)) {
        if (!passed && !isWebOnly()) { passed = true; if (await solveChallenge(url, init.quiet)) continue; }
        throw new SourceError('cloudflare', 'cloudflare', r.status);
      }
      if ((r.status === 429 || (r.status === 503 && r.headers['retry-after'])) && tries < retries) { tries++; await sleep(retryAfter(r, tries)); continue; }
      // A redirect the platform did not follow — Android's own client will not go from https to http, which a
      // server behind a proxy often asks for ("…/folder" → "http://…/folder/") — is followed here, kept on
      // https for the same site. (A POST is asked again as a GET only for 303, as browsers do.)
      if (r.status >= 300 && r.status < 400 && r.headers.location && hops < 5) {
        let next: URL; try { next = new URL(r.headers.location, url); } catch { return r; }
        const from = new URL(url);
        if (next.protocol === 'http:' && from.protocol === 'https:' && next.host === from.host) next.protocol = 'https:';
        if (next.href !== url) { hops++; url = next.href; if (r.status === 303) { init = { ...init, method: 'GET', body: undefined }; } continue; }
      }
      if (r && !r.url) r.url = url;
      return r;
    }
  });
}

/** GET a page or a JSON document as text. */
export async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  const r = await request(url, init);
  if (r.status === 429) throw new SourceError('rate', 'rate', 429);
  if (r.status === 401) throw new SourceError('auth', 'auth', 401);
  if (r.status >= 400) throw new SourceError(`HTTP ${r.status}`, 'http', r.status);
  return r.body;
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const text = await fetchText(url, { ...init, headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.8', ...init.headers } });
  try { return JSON.parse(text) as T; } catch { throw new SourceError('parse', 'parse'); }
}

/** A page's document (parsed, scripts inert). */
export async function fetchDoc(url: string, init: RequestInit = {}): Promise<Document> {
  const html = await fetchText(url, init);
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Base64 to bytes. */
export function bytesOf(b64: string): Uint8Array {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** A file, as bytes, with progress where the platform reports it. */
export async function fetchBytes(url: string, onProgress?: (p: { pct: number; got: number; total: number }) => void, init: RequestInit = {}): Promise<Uint8Array> {
  onProgress?.({ pct: 0, got: 0, total: 0 });
  const r = await request(url, { ...init, binary: true, headers: { accept: '*/*', ...init.headers } });
  if (r.status >= 400) throw new SourceError(`HTTP ${r.status}`, r.status === 429 ? 'rate' : 'http', r.status);
  const bytes = bytesOf(r.body);
  onProgress?.({ pct: 100, got: bytes.length, total: bytes.length });
  return bytes;
}

/** The charset a response's text is in: the header's, else a <meta> in the first bytes, else UTF-8. */
export function charsetOf(headers: Record<string, string>, head?: Uint8Array): string {
  const ct = headers['content-type'] ?? '';
  const m = /charset=["']?([\w-]+)/i.exec(ct); if (m) return m[1].toLowerCase();
  if (head) {
    let s = ''; const n = Math.min(head.length, 2048); for (let i = 0; i < n; i++) s += String.fromCharCode(head[i]);
    const mm = /<meta[^>]+charset=["']?([\w-]+)/i.exec(s); if (mm) return mm[1].toLowerCase();
  }
  return 'utf-8';
}
/** Bytes as text, in the charset named (unknown names fall back to UTF-8). */
export function decodeText(bytes: Uint8Array, charset: string): string {
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

/** Run several requests at once, a few at a time, in order of the input. */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>, live?: () => boolean): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  const worker = async () => { while (next < items.length && (!live || live())) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export { CHALLENGE_TITLE };
