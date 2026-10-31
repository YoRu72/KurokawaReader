// The app's side of the extension sandbox: a hidden frame of its own (opaque) origin runs the extensions'
// code — it can reach neither the library nor the app's storage, only what it is handed — and this module
// speaks to it: loads a plugin's code, calls its methods, answers its requests to the web through the app's
// own request layer (cookies, identity, browser checks, limits), and keeps the small key-value stores the
// plugins write. The frame's code (sources/ext/rt/runtime.ts) is built apart and inlined here.
import { request } from '../http';
import { SourceError } from '../types';

type Resolver = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let frame: HTMLIFrameElement | null = null;
let ready: Promise<Window> | null = null;
const waiting = new Map<number, Resolver>();
let seq = 0;
const loaded = new Set<string>();
const STORE_PREFIX = 'kr.ext.store.';
// The last request that failed for a reason worth naming (a browser check, the network gone): a plugin
// that swallows the error and fails in its own words still gets that reason reported.
let lastHttpError: { at: number; err: SourceError } | null = null;
// While a check runs in the background, no web view is shown for a browser check (the error is raised instead).
let quietDepth = 0;
export async function withQuiet<T>(fn: () => Promise<T>): Promise<T> { quietDepth++; try { return await fn(); } finally { quietDepth--; } }

/** The runtime's code, fetched once from the built assets. */
async function runtimeCode(): Promise<string> {
  const url = new URL('assets/ext-runtime.js', document.baseURI).href;
  const r = await fetch(url); if (!r.ok) throw new Error('The extension runtime could not be loaded');
  return r.text();
}

function boot(): Promise<Window> {
  if (ready) return ready;
  ready = (async () => {
    const code = await runtimeCode();
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-1px;top:-1px';
    f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>extensions</title></head><body><script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
    const win = await new Promise<Window>((resolve, reject) => {
      const onMsg = (e: MessageEvent) => { if (e.source === f.contentWindow && e.data?.t === 'ready') { window.removeEventListener('message', onMsg); resolve(f.contentWindow!); } };
      window.addEventListener('message', onMsg);
      document.body.append(f);
      setTimeout(() => reject(new Error('The extension sandbox did not start')), 15000);
    });
    frame = f;
    window.addEventListener('message', onMessage);
    return win;
  })();
  ready.catch(() => { ready = null; frame?.remove(); frame = null; });
  return ready;
}

function storeKey(key: string): string { return STORE_PREFIX + key; }
export function readStore(key: string): Record<string, unknown> { try { return JSON.parse(localStorage.getItem(storeKey(key)) ?? '{}') as Record<string, unknown>; } catch { return {}; } }
function writeStore(key: string, map: Record<string, unknown>): void { try { localStorage.setItem(storeKey(key), JSON.stringify(map)); } catch { /* full */ } }

function onMessage(e: MessageEvent): void {
  if (!frame || e.source !== frame.contentWindow) return;
  const m = e.data as Record<string, unknown>; if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'done': case 'loaded': { const w = waiting.get(Number(m.id)); if (!w) return; waiting.delete(Number(m.id)); if (m.ok) w.resolve(m.value); else w.reject(new Error(String(m.error ?? 'failed'))); break; }
    case 'http': { void serveHttp(Number(m.id), String(m.url), (m.init as Record<string, unknown>) ?? {}); break; }
    case 'store': {
      const key = String(m.key); const map = readStore(key);
      if (m.op === 'set') map[String(m.k)] = m.v; else if (m.op === 'del') delete map[String(m.k)]; else if (m.op === 'clear') for (const k of Object.keys(map)) delete map[k];
      writeStore(key, map); break;
    }
    case 'log': { const msg = String(m.msg ?? ''); if (m.level === 'error') console.warn('[extension]', msg); else console.debug('[extension]', msg); break; }
  }
}

async function serveHttp(id: number, url: string, init: Record<string, unknown>): Promise<void> {
  const win = frame?.contentWindow; if (!win) return;
  try {
    if (!/^https?:\/\//i.test(url)) throw new SourceError('Only http(s) URLs can be fetched', 'http');
    const r = await request(url, { method: String(init.method ?? 'GET'), headers: (init.headers as Record<string, string>) ?? {}, body: (init.body as string | null) ?? undefined, bodyBase64: !!init.bodyBase64, binary: true, quiet: !!init.quiet || quietDepth > 0 });
    const bin = atob(r.body); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // (An answer that is an error — a busy site's 503, a 429 — noted: a plugin that makes an empty list of it is
    // told apart from a list that has ended.)
    if (r.status >= 400 && r.status !== 404) lastBadStatus = { at: Date.now(), status: r.status };
    const value = { status: r.status, statusText: '', headers: r.headers, url: (r as { url?: string }).url ?? url, body: bytes.buffer };
    win.postMessage({ t: 'res', id, ok: true, value }, '*', [bytes.buffer]);
  } catch (e) {
    const err = e as SourceError;
    if (err instanceof SourceError && err.kind !== 'http') lastHttpError = { at: Date.now(), err };
    win.postMessage({ t: 'res', id, ok: false, value: err instanceof SourceError ? `kr:${err.kind}:${err.message}` : String((e as Error)?.message ?? e) }, '*');
  }
}

function ask<T>(win: Window, msg: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => { waiting.set(id, { resolve: resolve as (v: unknown) => void, reject }); win.postMessage({ ...msg, id }, '*'); });
}

/** Load a plugin's code into the sandbox under `key` (again, when the code changed). */
export async function loadPlugin(key: string, kind: 'lnreader' | 'mangayomi', code: string, meta: { pluginId?: string; source?: unknown }): Promise<void> {
  const win = await boot();
  await ask(win, { t: 'load', key, kind, code, pluginId: meta.pluginId, source: meta.source, storage: readStore(key) });
  loaded.add(key);
}
export function isLoaded(key: string): boolean { return loaded.has(key); }
export async function unloadPlugin(key: string): Promise<void> { if (!frame?.contentWindow) return; frame.contentWindow.postMessage({ t: 'unload', key }, '*'); loaded.delete(key); }

/** Call a method of a loaded plugin; errors the plugin raised come back as Errors, the web's as SourceErrors. */
let lastBadStatus: { at: number; status: number } | null = null;
/** The last error status a plugin's request was answered with since `since` (ms), if any. */
export const badStatusSince = (since: number): number | undefined => (lastBadStatus && lastBadStatus.at >= since ? lastBadStatus.status : undefined);

export async function callPlugin<T>(key: string, method: string, ...args: unknown[]): Promise<T> {
  const win = await boot();
  const started = Date.now();
  try { return await ask<T>(win, { t: 'call', key, method, args }); }
  catch (e) {
    const m = /^kr:(offline|cloudflare|blocked|rate|http|parse|auth|cors):(.*)$/.exec(String((e as Error).message));
    if (m) throw new SourceError(m[2], m[1] as SourceError['kind']);
    if (lastHttpError && lastHttpError.at >= started) throw lastHttpError.err;
    throw e;
  }
}

/** The sandbox and everything in it, gone (the next call starts it afresh). */
export function resetSandbox(): void {
  frame?.remove(); frame = null; ready = null; loaded.clear();
  for (const w of waiting.values()) w.reject(new Error('sandbox reset')); waiting.clear();
}
