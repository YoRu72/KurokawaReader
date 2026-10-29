// Reaching a site from a source: the request goes through native code on the phone and the desktop (so a
// site with no CORS headers answers, and the app's own cookies go with it — the clearance a Cloudflare check
// leaves behind), with the browser's own identity; what comes back is read for the things that go wrong —
// a Cloudflare check, a rate limit, the network gone — so the view can say so and offer the way through.
//
// A site that turns the app away (Cloudflare's or DDoS-Guard's check, or a refusal of anything that is not a
// browser — some sites' rules look at the connection itself, so even a passed check's clearance does not let
// the app's own requests through) is reached through the app's own browser instead, from then on: a web view
// of the app's, out of sight, opened on the site once (its check passed as any browser passes it) makes the
// requests itself (native/android/KrBrowser.java, desktop/main.cjs, the iOS plugin's KrBrowser.swift). When the
// check wants a person — a captcha — the reader is asked: the site opens in a window that says so ("confirm
// you are human") and closes by itself once the site shows its own page; then the request is made again. One
// check at a time per site, the other requests waiting for it. A site that says "busy" (429, or 503 with a
// Retry-After) is given the wait it asks for and asked again; a connection that drops is tried once more.
// (In the spirit of Mihon's Cloudflare interceptor — the same identity for the app and its web view, one
// cookie jar, a stale clearance dropped before a check is passed again — with the browser itself making the
// requests where the clearance is not enough.)
import { http, isWebOnly, withBody, bodyBytes, type HttpInit, type HttpResult } from '../net';
import { SourceError } from './types';
import { t } from '../i18n';

const CHALLENGE = /<title>\s*(Just a moment|Attention Required|Один момент|لحظة واحدة|Please wait|Checking your browser|Verifying you are human|DDoS-Guard|Access denied)|cf-chl|challenge-platform|_cf_chl_opt|cf-browser-verification|cf_chl_|cdn-cgi\/challenge-platform|turnstile|__ddg|ddos-guard|sucuri_cloudproxy/i;
const CHALLENGE_TITLE = /Just a moment|Attention Required|Один момент|لحظة|Please wait|Checking your browser|Verifying you are human|DDoS-Guard|Access denied/i;

export interface RequestInit extends HttpInit {
  /** Never show a window for a check (a request in the background): the error is raised instead. */
  quiet?: boolean;
  /** How many times to ask again after a "busy" answer (429 / 503 with Retry-After); 2 by default. */
  retries?: number;
  /** A download: the browser lane writes the answer to a file and tells its progress under this id. */
  downloadId?: string;
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
/** The answer is a refusal of the app by the site's shield rather than the site's own: a check, or a 403/503
 *  of Cloudflare's or DDoS-Guard's (their server name on it) — what a browser may well be let through. */
export function refusesApps(r: HttpResult, binary = false): boolean {
  if (looksLikeChallenge(r, binary)) return true;
  if (r.status !== 403 && r.status !== 503) return false;
  const server = (r.headers.server ?? '').toLowerCase();
  return server.includes('cloudflare') || server.includes('ddos-guard') || !!r.headers['cf-ray'];
}
/** The title of a page answered (base64 when binary), for an error to quote. */
function titleOf(r: HttpResult, binary: boolean): string {
  let head = r.body.slice(0, 6000);
  if (binary) { try { head = atob(head.slice(0, 6000 - (6000 % 4))); } catch { return ''; } }
  return /<title[^>]*>([^<]{1,140})/i.exec(head)?.[1]?.trim() ?? '';
}

/* ---------- the app's own browser ---------- */
type BrowserInit = { url: string; method?: string; headers?: Record<string, string>; body?: string | null; bodyBase64?: boolean; binary?: boolean; timeout?: number; page?: string; openTimeout?: number; downloadId?: string };
type CheckInit = { url: string; hidden?: boolean; timeout?: number; fresh?: boolean; message?: string; done?: string; reload?: string; /** stays open until the reader closes it */ stay?: boolean; /** a browser of its own: address bar, back and forward */ browse?: boolean; back?: string; forward?: string; placeholder?: string; rtl?: boolean };
type CheckResult = { passed?: boolean; blocked?: boolean; title?: string };
interface Browser {
  check?(o: CheckInit): Promise<CheckResult>;
  fetch?(o: BrowserInit): Promise<HttpResult & { via?: string }>;
  reset?(url: string): Promise<unknown>;
  forget?(url: string, all: boolean): Promise<{ cleared?: number } | unknown>;
}
type NativeKurokawa = { openWebView?(o: CheckInit): Promise<CheckResult | void>; browserFetch?(o: BrowserInit): Promise<HttpResult & { via?: string }>; browserReset?(o: { url: string }): Promise<unknown>; browserForget?(o: { url: string; all?: boolean }): Promise<{ cleared?: number }> };
type DesktopBridge = { openWebView?(o: CheckInit): Promise<CheckResult | boolean | void>; browserFetch?(o: BrowserInit): Promise<HttpResult & { via?: string }>; browserReset?(url: string): Promise<unknown>; browserForget?(url: string, all?: boolean): Promise<{ cleared?: number }> };
/** The app's own browser on this platform (Android, iOS, the desktop), or null on the web. */
function browser(): Browser | null {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; Plugins?: { Kurokawa?: NativeKurokawa } } }).Capacitor;
  const k = cap?.isNativePlatform?.() ? cap.Plugins?.Kurokawa : undefined;
  if (k) return {
    check: k.openWebView ? (o) => k.openWebView!(o).then((r) => (r ?? {})) : undefined,
    fetch: k.browserFetch ? async (o) => withBody(await k.browserFetch!(o)) : undefined,
    reset: k.browserReset ? (url) => k.browserReset!({ url }) : undefined,
    forget: k.browserForget ? (url, all) => k.browserForget!({ url, all }) : undefined,
  };
  const d = (window as unknown as { kurokawaDesktop?: DesktopBridge }).kurokawaDesktop;
  if (d) return {
    check: d.openWebView ? (o) => d.openWebView!(o).then((r) => (typeof r === 'object' && r ? r : { passed: !!r })) : undefined,
    fetch: d.browserFetch ? (o) => d.browserFetch!(o) : undefined,
    reset: d.browserReset ? (url) => d.browserReset!(url) : undefined,
    forget: d.browserForget ? (url, all) => d.browserForget!(url, all) : undefined,
  };
  return null;
}
/** Whether this platform has the app's own browser to make requests in. */
export const hasBrowser = (): boolean => !!browser()?.fetch;

/** The sites reached through the app's browser (each with until when): kept, so a site that turned the app
 *  away is not asked the plain way first again — for a week after it last did, or as long as a source says. */
const BROWSER_KEY = 'kr.browserHosts';
let browserHosts: Record<string, number> | null = null;
function hostsKept(): Record<string, number> {
  if (!browserHosts) { try { browserHosts = JSON.parse(localStorage.getItem(BROWSER_KEY) ?? '{}') as Record<string, number>; } catch { browserHosts = {}; } }
  return browserHosts ?? {};
}
export function viaBrowser(host: string): boolean { return (hostsKept()[host] ?? 0) > Date.now(); }
/** Reach `host` through the app's browser from now on (for `days`). */
export function useBrowserFor(host: string, days = 7): void {
  const m = hostsKept(); const until = Date.now() + days * 86400000;
  // (Written again only when a day or more would be gained.)
  if ((m[host] ?? 0) >= until - 86400000) return;
  m[host] = until;
  for (const [h, u] of Object.entries(m)) if (u < Date.now()) delete m[h];
  try { localStorage.setItem(BROWSER_KEY, JSON.stringify(m)); } catch { /* kept for this session only */ }
}

/** The app's browser closed on the site: its next request opens it again with the cookies as they are now. */
export async function resetBrowser(url: string): Promise<void> { await browser()?.reset?.(url).catch(() => undefined); }
/** The site's clearance (or, with `all`, every cookie of it) cleared and its browser closed — for a check
 *  gone stale that keeps failing. Returns how many cookies were cleared. */
export async function forgetSite(url: string, all = false): Promise<number> {
  const r = await browser()?.forget?.(url, all).catch(() => null);
  return Number((r as { cleared?: number } | null)?.cleared ?? 0);
}

/* ---------- the check passed ---------- */
const passing = new Map<string, Promise<boolean>>();
const declined = new Map<string, number>();   // a site whose check the reader closed without passing: not shown again for a while
const refused = new Map<string, string>();    // a site that refuses even a browser: its page's title
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const checkWords = (url: string): Pick<CheckInit, 'message' | 'done' | 'reload'> => ({ message: t('checkPrompt', { site: hostOf(url) }), done: t('checkClose'), reload: t('checkReload') });

/** Pass the site's check: out of sight first (unless the browser has just waited for it already), then —
 *  unless `quiet` — in a window that asks the reader to. Resolves true when the site showed a page of its own;
 *  the app's browser on the site is then set aside once (not by every request that waited for the check), so
 *  the next request opens it afresh with the new cookies. */
export async function solveChallenge(url: string, quiet = false, waited = false): Promise<boolean> {
  const host = hostOf(url);
  const running = passing.get(host); if (running) return running;
  const p = (async () => {
    const b = browser(); if (!b?.check) return false;
    try {
      if (!waited) {
        const hid = await b.check({ url, hidden: true, timeout: 15000 }).catch(() => null);
        if (hid?.passed) { await resetBrowser(url); return true; }
        if (hid?.blocked) { refused.set(host, hid.title ?? ''); return false; }
      }
      if (quiet || (declined.get(host) ?? 0) > Date.now()) return false;
      // (A clearance gone stale is dropped first, so the site gives a check of its own to pass.)
      const vis = await b.check({ url, timeout: 300000, fresh: true, ...checkWords(url) }).catch(() => null);
      if (vis?.blocked && !vis.passed) refused.set(host, vis.title ?? '');
      if (!vis?.passed) { declined.set(host, Date.now() + 90_000); return false; }
      await resetBrowser(url);
      return true;
    } finally { passing.delete(host); }
  })();
  passing.set(host, p);
  return p;
}

/** Open the site's check for the reader (the button in an error): a window that says what to do and closes
 *  by itself once it is done; the app's browser on the site is opened again afterwards with the new cookies.
 *  On the web it can only open the site in a tab. */
export async function passChallenge(url: string): Promise<void> {
  declined.delete(hostOf(url)); refused.delete(hostOf(url));
  const b = browser();
  if (b?.check) { await b.check({ url, timeout: 300000, fresh: true, ...checkWords(url) }).catch(() => undefined); await resetBrowser(url); return; }
  window.open(url, '_blank', 'noopener');
}

/** The site in the app's own browser for the reader to use as they wish — sign in, pass a check — as Mihon's
 *  WebView: it stays until closed, and the app's requests then carry what was done there. On the web, a tab. */
export async function openSite(url: string): Promise<void> {
  const b = browser();
  if (b?.check) {
    await b.check({ url, timeout: 1800000, stay: true, message: t('siteInApp', { site: hostOf(url) }), done: t('checkClose'), reload: t('checkReload') }).catch(() => undefined);
    declined.delete(hostOf(url)); refused.delete(hostOf(url));
    await resetBrowser(url);
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/** The app's browser opened on its own (Settings), as a browser: an address bar, back and forward. */
export async function openBrowser(start = 'https://duckduckgo.com/'): Promise<void> {
  const b = browser();
  if (!b?.check) { window.open(start, '_blank', 'noopener'); return; }
  await b.check({ url: start, timeout: 86400000, stay: true, browse: true, message: t('appBrowser'), done: t('checkClose'), reload: t('checkReload'), back: t('back'), forward: t('forward'), placeholder: t('addressOrSearch'), rtl: document.documentElement.dir === 'rtl' }).catch(() => undefined);
}

/* ---------- DNS over HTTPS (as 1DM+): sites asked of a resolver over HTTPS instead of the network's DNS ---------- */
export const DOH_PROVIDERS = ['off', 'cloudflare', 'google', 'quad9', 'adguard'] as const;
const DOH_KEY = 'kr.doh';
type DohBridge = { setDoh?(o: { provider?: string; test?: string }): Promise<{ provider?: string; ips?: string[] }> };
type DohDesktop = { setDoh?(provider?: string | null, test?: string): Promise<{ provider?: string; ok?: boolean; ms?: number; error?: string }> };
const dohNative = (): DohBridge | null => { const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; Plugins?: { Kurokawa?: DohBridge } } }).Capacitor; const k = cap?.isNativePlatform?.() ? cap.Plugins?.Kurokawa : undefined; return k?.setDoh ? k : null; };
const dohDesktop = (): DohDesktop | null => { const d = (window as unknown as { kurokawaDesktop?: DohDesktop }).kurokawaDesktop; return d?.setDoh ? d : null; };
/** Whether this platform can resolve by DoH (the apps; not a browser tab). */
export const hasDoh = (): boolean => !!(dohNative() || dohDesktop());
export function dohProvider(): string { try { return localStorage.getItem(DOH_KEY) || 'off'; } catch { return 'off'; } }
/** Chooses the resolver ('off', a provider's name, or an https:// address of one). */
export async function setDoh(provider: string): Promise<void> {
  try { localStorage.setItem(DOH_KEY, provider); } catch { /* the app keeps its own copy */ }
  const n = dohNative(); if (n) { await n.setDoh!({ provider }); return; }
  const d = dohDesktop(); if (d) await d.setDoh!(provider);
}
/** Tries the resolver on `host`: resolves to what was found (its addresses, or the time the site took), or throws. */
export async function testDoh(host = 'example.com'): Promise<{ ips?: string[]; ms?: number }> {
  const n = dohNative();
  if (n) { const started = Date.now(); const r = await n.setDoh!({ test: host }); return { ips: (r.ips ?? []).slice(0, 2), ms: Date.now() - started }; }
  const d = dohDesktop();
  if (d) { const r = await d.setDoh!(null, host); if (!r.ok) throw new Error(r.error || 'failed'); return { ms: r.ms ?? 0 }; }
  throw new Error('unsupported');
}

/* ---------- requests: a few at a time per site, asked again when the site says so ---------- */
const lanes = new Map<string, { running: number; queue: (() => void)[] }>();
const PER_HOST = 6;
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

/** A request with the whole treatment: the app's identity, a site that turns the app away reached through
 *  the app's own browser, a check passed (by the reader when it must) and the request made again, a busy
 *  site waited for. Throws a SourceError for what cannot be helped. */
export async function request(url: string, init: RequestInit = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  for (const [k, v] of Object.entries(init.headers ?? {})) { const key = k.toLowerCase(); if (key === 'accept-encoding') continue; headers[key] = v; }
  if (!isWebOnly() && !headers['user-agent']) headers['user-agent'] = navigator.userAgent;
  const host = hostOf(url);
  return lane(host, async () => {
    let r: HttpResult | null = null; let passed = false; let tries = 0; let hops = 0;
    const b = browser();
    let inBrowser = !!b?.fetch && viaBrowser(host);
    let browserBroke = false; let browserTried = false;
    const retries = init.retries ?? 2;
    for (;;) {
      try {
        r = inBrowser && b?.fetch
          ? await b.fetch({ url, method: init.method ?? 'GET', headers, body: init.body ?? null, bodyBase64: !!init.bodyBase64, binary: !!init.binary, timeout: init.downloadId ? 1800000 : init.binary ? 180000 : 90000, openTimeout: 20000, ...(init.downloadId ? { downloadId: init.downloadId } : {}) })
          : await http(url, { ...init, headers });
      } catch (e) {
        // (The app's browser could not reach the site at all — no network, a page that would not load: the
        // plain way, once.)
        if (inBrowser) { inBrowser = false; browserBroke = true; continue; }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SourceError('offline', 'offline');
        if (isWebOnly()) throw new SourceError('cors', 'cors');
        if (tries < 1) { tries++; await sleep(800); continue; }
        // (The plain way failing outright twice — a connection a site's shield cuts — the app's browser, once.)
        if (!browserBroke && !browserTried && b?.fetch) { browserTried = true; inBrowser = true; continue; }
        throw new SourceError(String((e as Error).message ?? e), 'offline');
      }
      // (A site the plain way could not reach at all but the browser could: reached through it from now on.)
      if (browserTried && inBrowser && !viaBrowser(host) && !looksLikeChallenge(r, !!init.binary)) useBrowserFor(host);
      const lanesSays = (r.headers['x-kr-lane'] ?? '').toLowerCase();
      // A site that refuses even a browser: nothing to pass — said as such, with what its page says.
      if (lanesSays === 'blocked') throw new SourceError('blocked', 'blocked', r.status, titleOf(r, !!init.binary));
      if (inBrowser ? looksLikeChallenge(r, !!init.binary) : refusesApps(r, !!init.binary)) {
        // Turned away: the site is reached through the app's browser from now on.
        if (!inBrowser && !browserBroke && b?.fetch) { useBrowserFor(host); inBrowser = true; continue; }
        // A check the browser could not pass by itself: the reader passes it, and the request is made again.
        if (!passed && !isWebOnly()) {
          passed = true;
          if (await solveChallenge(url, init.quiet, lanesSays === 'challenge')) continue;
          const no = refused.get(host);
          if (no !== undefined) throw new SourceError('blocked', 'blocked', r.status, no);
        }
        throw new SourceError('cloudflare', 'cloudflare', r.status, titleOf(r, !!init.binary));
      }
      if ((r.status === 429 || (r.status === 503 && r.headers['retry-after'])) && tries < retries) { tries++; await sleep(retryAfter(r, tries)); continue; }
      // A redirect the platform did not follow — Android's own client will not go from https to http, which a
      // server behind a proxy often asks for ("…/folder" → "http://…/folder/") — is followed here, kept on
      // https for the same site. (A POST is asked again as a GET only for 303, as browsers do. The browser's
      // own requests follow their redirects themselves.)
      if (!inBrowser && r.status >= 300 && r.status < 400 && r.headers.location && hops < 5) {
        let next: URL; try { next = new URL(r.headers.location, url); } catch { return r; }
        const from = new URL(url);
        if (next.protocol === 'http:' && from.protocol === 'https:' && next.host === from.host) next.protocol = 'https:';
        if (next.href !== url) { hops++; url = next.href; if (r.status === 303) { init = { ...init, method: 'GET', body: undefined }; } continue; }
      }
      if (!r.url) r.url = url;
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

/** The bytes of a binary answer (as bytes when the platform handed them so, else its base64 decoded by the
 *  browser itself — a cover's megabyte decoded character by character in script would stall the screen). */
export const bytesOfAsync = bodyBytes;
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
  const bytes = await bodyBytes(r);
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
