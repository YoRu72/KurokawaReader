// The sandbox's side of the bridge to the app: requests to the web go out as messages and come back as bytes
// (the app makes them through native code, with cookies, identity and browser checks handled there); the
// plugins' key-value storage is kept in the app and mirrored here; logs are forwarded.

export interface HttpRes { status: number; statusText: string; headers: Record<string, string>; url: string; body: ArrayBuffer }
interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }
const pending = new Map<number, Pending>();
let seq = 0;

export function post(msg: Record<string, unknown>, transfer?: Transferable[]): void {
  window.parent.postMessage(msg, '*', transfer);
}
export function rpc<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => { pending.set(id, { resolve: resolve as (v: unknown) => void, reject }); post({ ...msg, id }); });
}
export function settle(id: number, ok: boolean, value: unknown): void {
  const p = pending.get(id); if (!p) return; pending.delete(id);
  if (ok) p.resolve(value); else p.reject(new Error(String(value)));
}
export function log(level: 'log' | 'warn' | 'error', args: unknown[]): void {
  post({ t: 'log', level, msg: args.map((a) => { try { return typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a); } catch { return String(a); } }).join(' ').slice(0, 2000) });
}

/* ---------- requests ---------- */
export interface ReqInit { method?: string; headers?: Record<string, string> | Headers | [string, string][]; body?: string | FormData | URLSearchParams | ArrayBuffer | Uint8Array | null; redirect?: string; quiet?: boolean }
const headersOf = (h?: ReqInit['headers']): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) { h.forEach((v, k) => { out[k.toLowerCase()] = v; }); return out; }
  if (Array.isArray(h)) { for (const [k, v] of h) out[k.toLowerCase()] = v; return out; }
  for (const [k, v] of Object.entries(h)) if (v !== undefined && v !== null) out[k.toLowerCase()] = String(v);
  return out;
};
const toBase64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/** The request, as the app makes it; the answer's bytes. */
export async function httpRequest(url: string, init: ReqInit = {}): Promise<HttpRes> {
  const headers = headersOf(init.headers);
  let body: string | null = null; let bodyBase64 = false;
  const b = init.body;
  if (typeof b === 'string') body = b;
  else if (b instanceof URLSearchParams) { body = b.toString(); if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'; }
  else if (typeof FormData !== 'undefined' && b instanceof FormData) {
    const boundary = '----KurokawaForm' + Math.random().toString(36).slice(2);
    const parts: string[] = [];
    b.forEach((v, k) => { parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${typeof v === 'string' ? v : ''}\r\n`); });
    body = parts.join('') + `--${boundary}--\r\n`; headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
  } else if (b instanceof ArrayBuffer || b instanceof Uint8Array) { body = toBase64(b instanceof ArrayBuffer ? new Uint8Array(b) : b); bodyBase64 = true; }
  const r = await rpc<HttpRes>({ t: 'http', url, init: { method: init.method ?? (body !== null ? 'POST' : 'GET'), headers, body, bodyBase64, quiet: !!init.quiet } });
  return r;
}

const charsetOf = (headers: Record<string, string>, head: Uint8Array): string => {
  const m = /charset=["']?([\w-]+)/i.exec(headers['content-type'] ?? ''); if (m) return m[1].toLowerCase();
  let s = ''; const n = Math.min(head.length, 2048); for (let i = 0; i < n; i++) s += String.fromCharCode(head[i]);
  const mm = /<meta[^>]+charset=["']?([\w-]+)/i.exec(s); return mm ? mm[1].toLowerCase() : 'utf-8';
};
export const decode = (bytes: Uint8Array, charset: string): string => { try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); } };

/** A Response as fetch() gives one, over the bytes the app fetched. */
export class LnResponse {
  readonly ok: boolean; readonly status: number; readonly statusText: string; readonly url: string; readonly headers: Headers; bodyUsed = false; readonly redirected = false; readonly type = 'basic';
  constructor(private readonly res: HttpRes) {
    this.status = res.status; this.ok = res.status >= 200 && res.status < 300; this.statusText = res.statusText || ''; this.url = res.url;
    this.headers = new Headers(); for (const [k, v] of Object.entries(res.headers)) { try { this.headers.append(k, v); } catch { /* a header name the browser refuses */ } }
  }
  private bytes(): Uint8Array { this.bodyUsed = true; return new Uint8Array(this.res.body); }
  async text(): Promise<string> { const b = this.bytes(); return decode(b, charsetOf(this.res.headers, b)); }
  async json(): Promise<unknown> { return JSON.parse(await this.text()); }
  async arrayBuffer(): Promise<ArrayBuffer> { return this.bytes().slice().buffer; }
  async blob(): Promise<Blob> { return new Blob([this.bytes().slice().buffer as ArrayBuffer], { type: this.res.headers['content-type'] ?? '' }); }
  async formData(): Promise<FormData> { const fd = new FormData(); for (const [k, v] of new URLSearchParams(await this.text())) fd.append(k, v); return fd; }
  clone(): LnResponse { return new LnResponse(this.res); }
  get body(): ReadableStream<Uint8Array> | null { return null; }
}

export async function fetchLike(url: string, init?: ReqInit): Promise<LnResponse> {
  return new LnResponse(await httpRequest(String(url), init));
}
