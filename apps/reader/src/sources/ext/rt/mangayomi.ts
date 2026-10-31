// Mangayomi's JavaScript extensions in the sandbox: the globals the app's QuickJS runtime defines for them —
// MProvider, Client, Document/Element (jsoup-like, over the browser's parser), SharedPreferences, the
// Kotlin-style String helpers, the utilities — and `new DefaultExtension()` from the extension's code.
import { select, matches } from './select';
import { httpRequest, decode, log, post } from './bridge';

const OPTS = { icontains: true };
const unquote = (s: string) => s;
const firstAttr = (html: string, name: string): string => { const m = new RegExp(`${name}="([^"]+)"`).exec(html); return m ? m[1] : ''; };

/** An element as Mangayomi hands it to the extension; a missing one answers with empty strings. */
export class MElement {
  constructor(readonly el: Element | null) {}
  get text(): string { return this.el?.textContent ?? ''; }
  get outerHtml(): string { return this.el?.outerHTML ?? ''; }
  get innerHtml(): string { return this.el?.innerHTML ?? ''; }
  get className(): string { return this.el?.className ?? ''; }
  get localName(): string { return this.el?.localName ?? ''; }
  get namespaceUri(): string { return this.el?.namespaceURI ?? ''; }
  get getSrc(): string { return firstAttr(this.outerHtml, 'src'); }
  get getImg(): string { return firstAttr(this.outerHtml, 'img'); }
  get getHref(): string { return firstAttr(this.outerHtml, 'href'); }
  get getDataSrc(): string { return firstAttr(this.outerHtml, 'data-src'); }
  get previousElementSibling(): MElement { return new MElement(this.el?.previousElementSibling ?? null); }
  get nextElementSibling(): MElement { return new MElement(this.el?.nextElementSibling ?? null); }
  get parent(): MElement { return new MElement(this.el?.parentElement ?? null); }
  get children(): MElement[] { return Array.from(this.el?.children ?? []).map((c) => new MElement(c)); }
  getElementsByTagName(name: string): MElement[] { return Array.from(this.el?.getElementsByTagName(name) ?? []).map((c) => new MElement(c)); }
  getElementsByClassName(name: string): MElement[] { return Array.from(this.el?.getElementsByClassName(name) ?? []).map((c) => new MElement(c)); }
  attr(name: string): string { return this.el?.getAttribute(name) ?? ''; }
  hasAttr(name: string): boolean { return !!this.el?.hasAttribute(name); }
  selectFirst(sel: string): MElement { return new MElement(this.el ? select([this.el], unquote(sel), OPTS)[0] ?? null : null); }
  select(sel: string): MElement[] { return this.el ? select([this.el], unquote(sel), OPTS).map((e) => new MElement(e)) : []; }
  matches(sel: string): boolean { return !!this.el && matches(this.el, sel, OPTS); }
  xpath(): string[] { throw new Error('XPath is not available in this reader'); }
  xpathFirst(): string { throw new Error('XPath is not available in this reader'); }
  toString(): string { return this.outerHtml; }
}
export class MDocument {
  readonly doc: Document;
  constructor(readonly html: string) { this.doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html'); }
  get body(): MElement { return new MElement(this.doc.body); }
  get head(): MElement { return new MElement(this.doc.head); }
  get documentElement(): MElement { return new MElement(this.doc.documentElement); }
  get parent(): MElement { return new MElement(this.doc.documentElement); }
  get text(): string { return this.doc.documentElement?.textContent ?? ''; }
  get outerHtml(): string { return this.doc.documentElement?.outerHTML ?? ''; }
  get children(): MElement[] { return Array.from(this.doc.documentElement?.children ?? []).map((c) => new MElement(c)); }
  selectFirst(sel: string): MElement { return new MElement(select([this.doc], unquote(sel), OPTS)[0] ?? null); }
  select(sel: string): MElement[] { return select([this.doc], unquote(sel), OPTS).map((e) => new MElement(e)); }
  getElementsByTagName(name: string): MElement[] { return Array.from(this.doc.getElementsByTagName(name)).map((c) => new MElement(c)); }
  getElementsByClassName(name: string): MElement[] { return Array.from(this.doc.getElementsByClassName(name)).map((c) => new MElement(c)); }
  getElementById(id: string): MElement { return new MElement(this.doc.getElementById(id)); }
  attr(name: string): string { return this.doc.documentElement?.getAttribute(name) ?? ''; }
  hasAttr(name: string): boolean { return !!this.doc.documentElement?.hasAttribute(name); }
  xpath(): string[] { throw new Error('XPath is not available in this reader'); }
  xpathFirst(): string { throw new Error('XPath is not available in this reader'); }
}

/** The HTTP client: answers {body, headers, statusCode, …} as Mangayomi's does. */
export class MClient {
  constructor(readonly reqcopyWith?: unknown) {}
  private async send(method: string, url: string, headers?: Record<string, string> | null, body?: unknown) {
    const h: Record<string, string> = {}; for (const [k, v] of Object.entries(headers ?? {})) h[k] = String(v);
    let data: string | null = null;
    if (body !== undefined && body !== null) {
      const ct = Object.entries(h).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
      if (typeof body === 'string') data = body;
      else if (/application\/json/i.test(ct)) data = JSON.stringify(body);
      else if (Array.isArray(body)) data = JSON.stringify(body);
      else { data = new URLSearchParams(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, String(v)])).toString(); if (!ct) h['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8'; }
    }
    const r = await httpRequest(url, { method, headers: h, body: data });
    const bytes = new Uint8Array(r.body);
    const m = /charset=["']?([\w-]+)/i.exec(r.headers['content-type'] ?? '');
    return { body: decode(bytes, m ? m[1] : 'utf-8'), headers: r.headers, statusCode: r.status, isRedirect: false, persistentConnection: true, reasonPhrase: r.statusText, request: { url, method, headers: h, contentLength: data?.length ?? 0, finalized: true, followRedirects: true, maxRedirects: 5, persistentConnection: true } };
  }
  head(url: string, headers?: Record<string, string>) { return this.send('HEAD', url, headers); }
  get(url: string, headers?: Record<string, string>) { return this.send('GET', url, headers); }
  post(url: string, headers?: Record<string, string>, body?: unknown) { return this.send('POST', url, headers, body); }
  put(url: string, headers?: Record<string, string>, body?: unknown) { return this.send('PUT', url, headers, body); }
  delete(url: string, headers?: Record<string, string>, body?: unknown) { return this.send('DELETE', url, headers, body); }
  patch(url: string, headers?: Record<string, string>, body?: unknown) { return this.send('PATCH', url, headers, body); }
}

/** Dart's DateFormat patterns, enough for the dates the sources print: "MMMM dd, yyyy", "dd/MM/yyyy", "yyyy-MM-dd HH:mm". */
export function parseDates(value: string, dateFormat: string, _locale?: string): string {
  const s = String(value ?? '').trim(); if (!s) return String(Date.now());
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  if (!dateFormat) { const t = Date.parse(s); return String(isNaN(t) ? Date.now() : t); }
  const tokens = /yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s|a|EEEE|EEE|E|'[^']*'|./g;
  let y = 1970, mo = 0, d = 1, hh = 0, mi = 0, se = 0, pm: boolean | null = null, pos = 0;
  const num = (max: number) => { const m = new RegExp(`^\\d{1,${max}}`).exec(s.slice(pos)); if (!m) return null; pos += m[0].length; return Number(m[0]); };
  for (const t of dateFormat.match(tokens) ?? []) {
    if (t.startsWith("'")) { pos += t.length - 2; continue; }
    let v: number | null;
    switch (t) {
      case 'yyyy': v = num(4); if (v === null) return String(Date.now()); y = v; break;
      case 'yy': v = num(2); if (v === null) return String(Date.now()); y = v + 2000; break;
      case 'MMMM': case 'MMM': { const rest = s.slice(pos).toLowerCase(); const i = MONTHS.findIndex((m) => rest.startsWith(t === 'MMM' ? m.slice(0, 3) : m)); if (i < 0) return String(Date.now()); mo = i; pos += t === 'MMM' ? 3 : MONTHS[i].length; break; }
      case 'MM': case 'M': v = num(2); if (v === null) return String(Date.now()); mo = v - 1; break;
      case 'dd': case 'd': v = num(2); if (v === null) return String(Date.now()); d = v; break;
      case 'HH': case 'H': case 'hh': case 'h': v = num(2); if (v === null) return String(Date.now()); hh = v; break;
      case 'mm': case 'm': v = num(2); if (v === null) return String(Date.now()); mi = v; break;
      case 'ss': case 's': v = num(2); if (v === null) return String(Date.now()); se = v; break;
      case 'a': { const m = /^(am|pm)/i.exec(s.slice(pos)); if (m) { pm = m[1].toLowerCase() === 'pm'; pos += 2; } break; }
      case 'EEEE': case 'EEE': case 'E': { const m = /^[A-Za-z]+/.exec(s.slice(pos)); if (m) pos += m[0].length; break; }
      default: if (s[pos] === t) pos++; else if (/\s/.test(t) && /\s/.test(s[pos] ?? '')) pos++;
    }
  }
  if (pm !== null) { if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
  const dt = new Date(y, mo, d, hh, mi, se).getTime();
  return String(isNaN(dt) ? Date.now() : dt);
}

/** Dean Edwards' packer, unpacked (p,a,c,k,e,d). */
export function unpackJs(packed: string): string {
  const m = /\}\s*\('(.*)',\s*(\d+|\[\]),\s*(\d+),\s*'(.*)'\.split\('\|'\)/s.exec(packed);
  if (!m) return '';
  const payload = m[1]; const radix = m[2] === '[]' ? 62 : Number(m[2]); const count = Number(m[3]); const words = m[4].split('|');
  const encode = (c: number): string => (c < radix ? '' : encode(Math.floor(c / radix))) + ((c % radix) > 35 ? String.fromCharCode((c % radix) + 29) : (c % radix).toString(36));
  const dict: Record<string, string> = {};
  for (let i = count - 1; i >= 0; i--) { const k = encode(i); dict[k] = words[i] || k; }
  return payload.replace(/\b\w+\b/g, (w) => dict[w] ?? w).replace(/\\'/g, "'");
}

export function stringHelpers(): void {
  const S = String.prototype as unknown as Record<string, unknown>;
  if (S.substringAfter) return;
  S.substringAfter = function (this: string, p: string) { const i = this.indexOf(p); return i === -1 ? this.substring(0) : this.substring(i + p.length); };
  S.substringAfterLast = function (this: string, p: string) { return this.split(p).pop(); };
  S.substringBefore = function (this: string, p: string) { const i = this.indexOf(p); return i === -1 ? this.substring(0) : this.substring(0, i); };
  S.substringBeforeLast = function (this: string, p: string) { const i = this.lastIndexOf(p); return i === -1 ? this.substring(0) : this.substring(0, i); };
  S.substringBetween = function (this: string, l: string, r: string) { const i = this.indexOf(l); if (i === -1) return ''; const li = i + l.length; const ri = this.indexOf(r, li); return ri === -1 ? '' : this.substring(li, ri); };
}

export interface MSource { id?: number | string; name: string; lang: string; baseUrl: string; apiUrl?: string; iconUrl?: string; typeSource?: string; itemType?: number; version?: string; dateFormat?: string; dateFormatLocale?: string; isNsfw?: boolean; hasCloudflare?: boolean; headers?: string; [k: string]: unknown }

export interface MExtension {
  source: MSource;
  supportsLatest?: boolean;
  getHeaders?(url: string): Record<string, string>;
  getPopular(page: number): Promise<{ list: { name: string; imageUrl?: string; link: string }[]; hasNextPage: boolean }>;
  getLatestUpdates(page: number): Promise<{ list: { name: string; imageUrl?: string; link: string }[]; hasNextPage: boolean }>;
  search(query: string, page: number, filters: unknown[]): Promise<{ list: { name: string; imageUrl?: string; link: string }[]; hasNextPage: boolean }>;
  getDetail(url: string): Promise<{ name?: string; imageUrl?: string; description?: string; author?: string; artist?: string; status?: number; genre?: string[]; chapters?: { name: string; url: string; dateUpload?: string; scanlator?: string }[]; link?: string }>;
  getHtmlContent?(name: string, url: string): Promise<string>;
  cleanHtmlContent?(html: string): Promise<string>;
  getPageList?(url: string): Promise<unknown[]>;
  getFilterList?(): unknown[];
  getSourcePreferences?(): unknown[];
}

/** Preferences: what the app saved for this extension, or the extension's own defaults. */
export class MPrefs {
  constructor(private readonly key: string, private readonly saved: Record<string, unknown>, private readonly defaults: () => Record<string, unknown>) {}
  get(k: string): unknown { if (k in this.saved) return this.saved[k]; const d = this.defaults(); return d[k] ?? ''; }
  getString(k: string, def: string): string { return k in this.saved ? String(this.saved[k]) : def; }
  setString(k: string, v: string): void { this.saved[k] = v; post({ t: 'store', key: this.key, op: 'set', k, v }); }
}

/** The extension's preference defaults, from getSourcePreferences(), keyed. */
export function prefDefaults(ext: MExtension): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let list: unknown[] = [];
  try { list = ext.getSourcePreferences?.() ?? []; } catch { list = []; }
  for (const p of list as Record<string, unknown>[]) {
    const key = String(p.key ?? ''); if (!key) continue;
    const lp = p.listPreference as { entryValues?: unknown[]; valueIndex?: number } | undefined;
    if (lp) { out[key] = lp.entryValues?.[lp.valueIndex ?? 0] ?? lp.valueIndex; continue; }
    const cb = (p.checkBoxPreference ?? p.switchPreferenceCompat) as { value?: unknown } | undefined; if (cb) { out[key] = cb.value; continue; }
    const ms = p.multiSelectListPreference as { values?: unknown } | undefined; if (ms) { out[key] = ms.values; continue; }
    const et = p.editTextPreference as { value?: unknown } | undefined; if (et) { out[key] = et.value; continue; }
  }
  return out;
}

export function loadMangayomi(code: string, source: MSource, key: string, saved: Record<string, unknown>): { ext: MExtension; prefs: MPrefs } {
  stringHelpers();
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.parseDates) Object.assign(g, {
    parseDates, unpackJs, unpackJsAndCombine: unpackJs,
    deobfuscateJsPassword: () => { throw new Error('deobfuscateJsPassword is not available in this reader'); },
    cryptoHandler: () => { throw new Error('cryptoHandler is not available in this reader'); },
    encryptAESCryptoJS: () => { throw new Error('AES is not available in this reader'); },
    decryptAESCryptoJS: () => { throw new Error('AES is not available in this reader'); },
    decryptAESGCM: () => { throw new Error('AES is not available in this reader'); },
    evaluateJavascriptViaWebview: async () => { throw new Error('A web view is not available to the extension in this reader'); },
    createHlsProxyUrl: async (u: string) => u,
    parseEpub: async () => { throw new Error('EPUB sources are not available in this reader'); },
    parseEpubChapter: async () => { throw new Error('EPUB sources are not available in this reader'); },
  });
  const src = JSON.parse(JSON.stringify(source));
  class MProvider {
    get source() { return src; }
    get supportsLatest() { return true; }
    getHeaders(_url: string): Record<string, string> { throw new Error('getHeaders not implemented'); }
    async getPopular(_page: number): Promise<never> { throw new Error('getPopular not implemented'); }
    async getLatestUpdates(_page: number): Promise<never> { throw new Error('getLatestUpdates not implemented'); }
    async search(_q: string, _page: number, _filters: unknown[]): Promise<never> { throw new Error('search not implemented'); }
    async getDetail(_url: string): Promise<never> { throw new Error('getDetail not implemented'); }
    async getPageList(): Promise<never> { throw new Error('getPageList not implemented'); }
    async getVideoList(_url: string): Promise<never> { throw new Error('getVideoList not implemented'); }
    async getHtmlContent(_name: string, _url: string): Promise<never> { throw new Error('getHtmlContent not implemented'); }
    async cleanHtmlContent(_html: string): Promise<never> { throw new Error('cleanHtmlContent not implemented'); }
    getFilterList(): never { throw new Error('getFilterList not implemented'); }
    getSourcePreferences(): never { throw new Error('getSourcePreferences not implemented'); }
  }
  let prefs: MPrefs | null = null;
  class SharedPreferences { get(k: string) { return prefs!.get(k); } getString(k: string, d: string) { return prefs!.getString(k, d); } setString(k: string, v: string) { prefs!.setString(k, v); } }
  const console = { log: (...a: unknown[]) => log('log', a), warn: (...a: unknown[]) => log('warn', a), error: (...a: unknown[]) => log('error', a), info: (...a: unknown[]) => log('log', a), debug: () => undefined };
  const fn = new Function('MProvider', 'Client', 'Document', 'Element', 'SharedPreferences', 'console', `${code}\n;if (typeof DefaultExtension !== 'function') throw new Error('Not a Mangayomi extension (no DefaultExtension)');\nreturn new DefaultExtension();`);
  const ext = fn(MProvider, MClient, MDocument, MElement, SharedPreferences, console) as MExtension;
  prefs = new MPrefs(key, saved, () => prefDefaults(ext));
  return { ext, prefs };
}
