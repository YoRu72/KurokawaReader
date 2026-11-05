// Requests for the add-ons' sources, past the page's CORS: the phone's plugin (with the WebView's identity and
// cookies), the desktop's main process, or — on the web — the browser's fetch, which only the sites that allow
// it will answer.
import { ktPlugin } from './native';

export interface HttpResult { status: number; url: string; headers: Record<string, string>; body: string }
export interface HttpInit { method?: string; headers?: Record<string, string>; body?: string; bodyBase64?: boolean; binary?: boolean }

export async function request(url: string, init: HttpInit = {}): Promise<HttpResult> {
  const d = window.kurokawaTools as (typeof window.kurokawaTools & { http?(o: HttpInit & { url: string }): Promise<HttpResult> }) | undefined;
  if (d?.http) return d.http({ url, ...init });
  const p = ktPlugin() as (ReturnType<typeof ktPlugin> & { httpRequest?(o: HttpInit & { url: string }): Promise<HttpResult> }) | null;
  if (p?.httpRequest) {
    // (A site whose TLS the phone's own client cannot get through — some networks refuse its hello, as AniList's
    // «SSL handshake failure» — is asked through the web view's fetch instead, Chromium's own network stack, the way
    // Hayase reaches AniList; that works for the sites that allow it (AniList, Cinemeta…), and the route is kept a day.)
    const host = hostOf(url);
    if (viaWeb(host)) { try { return await webFetch(url, init); } catch { forgetWeb(host); } }
    try { return await p.httpRequest({ url, ...init }); }
    catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (!TLS_FAIL.test(m)) throw e;
      try { const r = await webFetch(url, init); rememberWeb(host); return r; } catch { throw e; }
    }
  }
  return webFetch(url, init);
}
const TLS_FAIL = /SSL|TLS|handshake|certificate|CertPath|Trust anchor|ECONNRESET|Connection reset|unexpected end of stream|EOF/i;
const WEB_KEY = 'kt.http.web';
const hostOf = (u: string): string => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
const webHosts = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(WEB_KEY) ?? '{}') as Record<string, number>; } catch { return {}; } };
const viaWeb = (host: string): boolean => { const at = webHosts()[host]; return !!at && Date.now() - at < 86400e3; };
const rememberWeb = (host: string): void => { const w = webHosts(); w[host] = Date.now(); try { localStorage.setItem(WEB_KEY, JSON.stringify(w)); } catch { /* full */ } };
const forgetWeb = (host: string): void => { const w = webHosts(); delete w[host]; try { localStorage.setItem(WEB_KEY, JSON.stringify(w)); } catch { /* full */ } };
async function webFetch(url: string, init: HttpInit): Promise<HttpResult> {
  const r = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body ? (init.bodyBase64 ? Uint8Array.from(atob(init.body), (c) => c.charCodeAt(0)) : init.body) : undefined });
  const headers: Record<string, string> = {}; r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const buf = new Uint8Array(await r.arrayBuffer());
  let body: string; if (init.binary) { let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); body = btoa(s); } else body = new TextDecoder().decode(buf);
  return { status: r.status, url: r.url, headers, body };
}
/** A fetch-like function handed to add-ons: the app's request layer behind the Response they expect. */
export function addonFetch(): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) { if (init.headers instanceof Headers) init.headers.forEach((v, k) => { headers[k] = v; }); else if (Array.isArray(init.headers)) for (const [k, v] of init.headers) headers[k] = v; else Object.assign(headers, init.headers as Record<string, string>); }
    const r = await request(String(input), { method: init?.method, headers, body: typeof init?.body === 'string' ? init.body : undefined, binary: false });
    return new Response(r.body, { status: r.status || 200, headers: r.headers });
  };
}
