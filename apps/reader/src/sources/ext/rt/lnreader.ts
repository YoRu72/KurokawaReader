// LNReader plugins in the sandbox: the CommonJS bundle is given the `require` the LNReader app gives it —
// @libs/fetch over the bridge, cheerio and htmlparser2 over the browser's parser, dayjs, the storage, the
// filter and status enums — and its default export is the plugin.
import { load as cheerioLoad } from './cheerio';
import { Parser } from './htmlparser';
import { dayjs } from './dayjs';
import { fetchLike, httpRequest, decode, log, post, type ReqInit } from './bridge';

export const NovelStatus = { Unknown: 'Unknown', Ongoing: 'Ongoing', Completed: 'Completed', Licensed: 'Licensed', PublishingFinished: 'Publishing Finished', Cancelled: 'Cancelled', OnHiatus: 'On Hiatus', STUB: 'STUB', Inactive: 'Inactive' };
export const FilterTypes = { TextInput: 'Text', Picker: 'Picker', CheckboxGroup: 'Checkbox', Switch: 'Switch', ExcludableCheckboxGroup: 'XCheckbox' };
const defaultCover = 'https://github.com/lnreader/lnreader-plugins/blob/master/public/static/coverNotAvailable.webp?raw=true';
const isUrlAbsolute = (url: string): boolean => {
  if (!url) return false;
  if (url.indexOf('//') === 0) return true;
  if (url.indexOf('://') === -1) return false;
  if (url.indexOf('.') === -1) return false;
  if (url.indexOf('/') === -1) return false;
  if (url.indexOf(':') > url.indexOf('/')) return false;
  return url.indexOf('://') < url.indexOf('.');
};

/* ---------- @libs/fetch ---------- */
const DEFAULT_HEADERS: Record<string, string> = { Connection: 'keep-alive', Accept: '*/*', 'Accept-Language': '*', 'Sec-Fetch-Mode': 'cors', 'Cache-Control': 'max-age=0' };
const withDefaults = (init?: ReqInit): ReqInit => {
  const h: Record<string, string> = { ...DEFAULT_HEADERS };
  if (init?.headers) { if (init.headers instanceof Headers) init.headers.forEach((v, k) => { h[k] = v; }); else if (Array.isArray(init.headers)) for (const [k, v] of init.headers) h[k] = v; else Object.assign(h, init.headers); }
  return { ...init, headers: h };
};
export const fetchApi = (url: string, init?: ReqInit) => fetchLike(url, withDefaults(init));
export const fetchText = async (url: string, init?: ReqInit, encoding?: string): Promise<string> => {
  try {
    const r = await httpRequest(url, withDefaults(init));
    if (r.status < 200 || r.status >= 300) return '';
    const bytes = new Uint8Array(r.body);
    if (encoding) return decode(bytes, encoding);
    return new LnText(r.headers, bytes).text();
  } catch { return ''; }
};
class LnText { constructor(private h: Record<string, string>, private b: Uint8Array) {} text(): string { const m = /charset=["']?([\w-]+)/i.exec(this.h['content-type'] ?? ''); return decode(this.b, m ? m[1] : 'utf-8'); } }
const fetchProto = async (): Promise<never> => { throw new Error('fetchProto (protobuf) is not available in this reader'); };

/* ---------- @libs/storage ---------- */
interface Stored { created: string; value: unknown; expires?: number }
export class Storage {
  constructor(private readonly key: string, private readonly map: Record<string, Stored>) {}
  set(k: string, value: unknown, expires?: Date | number): void {
    const item: Stored = { created: new Date().toISOString(), value, expires: expires instanceof Date ? expires.getTime() : expires };
    this.map[k] = item; post({ t: 'store', key: this.key, op: 'set', k, v: item });
  }
  get(k: string, raw?: boolean): unknown {
    const item = this.map[k]; if (!item) return undefined;
    if (item.expires && Date.now() > item.expires) { this.delete(k); return undefined; }
    return raw ? item : item.value;
  }
  delete(k: string): void { delete this.map[k]; post({ t: 'store', key: this.key, op: 'del', k }); }
  clearAll(): void { for (const k of Object.keys(this.map)) delete this.map[k]; post({ t: 'store', key: this.key, op: 'clear' }); }
  getAllKeys(): string[] { return Object.keys(this.map); }
}
class WebStorage { get(): undefined { return undefined; } }

/* ---------- urlencode ---------- */
const urlencode = { encode: (s: string) => encodeURIComponent(String(s)).replace(/%20/g, '+'), decode: (s: string) => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch { return String(s); } }, stringify: (o: Record<string, string>) => new URLSearchParams(o).toString(), parse: (s: string) => Object.fromEntries(new URLSearchParams(s)) };

/* ---------- the plugin ---------- */
export interface LnPlugin {
  id: string; name: string; site: string; version: string; lang?: string; icon?: string;
  filters?: Record<string, { label: string; type: string; value: unknown; options?: { label: string; value: string }[] }>;
  pluginSettings?: Record<string, { label: string; value: unknown; type?: string; options?: { label: string; value: string }[] }>;
  imageRequestInit?: { headers?: Record<string, string>; method?: string; body?: string };
  popularNovels(page: number, o?: { showLatestNovels?: boolean; filters?: Record<string, { type: string; value: unknown }> }): Promise<{ name: string; path: string; cover?: string }[]>;
  searchNovels(term: string, page: number): Promise<{ name: string; path: string; cover?: string }[]>;
  parseNovel(path: string): Promise<{ name: string; path: string; cover?: string; genres?: string; summary?: string; author?: string; artist?: string; status?: string; chapters: unknown[]; totalPages?: number }>;
  parsePage?(path: string, page: string): Promise<{ chapters: unknown[] }>;
  parseChapter(path: string): Promise<string>;
  resolveUrl?(path: string, isNovel?: boolean): string;
}

export function loadLnPlugin(code: string, pluginId: string, storage: Record<string, Stored>): LnPlugin {
  const packages: Record<string, unknown> = {
    htmlparser2: { Parser },
    cheerio: { load: cheerioLoad },
    dayjs,
    urlencode,
    '@libs/novelStatus': { NovelStatus },
    '@libs/fetch': { fetchApi, fetchText, fetchProto },
    '@libs/isAbsoluteUrl': { isUrlAbsolute },
    '@libs/filterInputs': { FilterTypes },
    '@libs/defaultCover': { defaultCover },
    '@libs/aes': { gcm: () => ({ encrypt: () => { throw new Error('AES-GCM is not available in this reader'); }, decrypt: () => { throw new Error('AES-GCM is not available in this reader'); } }) },
    '@libs/utils': { utf8ToBytes: (s: string) => new TextEncoder().encode(s), bytesToUtf8: (b: Uint8Array) => new TextDecoder().decode(b) },
    '@/types/constants': { NovelStatus },
    '@libs/storage': { storage: new Storage(pluginId, storage), localStorage: new WebStorage(), sessionStorage: new WebStorage() },
  };
  const require = (name: string): unknown => {
    if (name in packages) return packages[name];
    if (name === 'dayjs/plugin/localizedFormat' || name === 'dayjs/plugin/relativeTime' || name === 'dayjs/plugin/customParseFormat' || name.startsWith('dayjs/')) return () => undefined;
    throw new Error(`Module not available in this reader: ${name}`);
  };
  const module = { exports: {} as Record<string, unknown> };
  const fn = new Function('require', 'module', 'exports', 'console', `${code}\n;return module.exports && module.exports.default ? module.exports.default : module.exports;`);
  const console = { log: (...a: unknown[]) => log('log', a), warn: (...a: unknown[]) => log('warn', a), error: (...a: unknown[]) => log('error', a), info: (...a: unknown[]) => log('log', a), debug: () => undefined };
  const plugin = fn(require, module, module.exports, console) as LnPlugin;
  if (!plugin || typeof plugin.popularNovels !== 'function') throw new Error('Not an LNReader plugin (no popularNovels)');
  return plugin;
}

/** Plain data of the plugin for the app: its card, filters and settings. */
export function describeLn(p: LnPlugin): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ id: p.id, name: p.name, site: p.site, version: p.version, lang: p.lang, icon: p.icon, filters: p.filters ?? null, pluginSettings: p.pluginSettings ?? null, imageRequestInit: p.imageRequestInit ?? null, hasPages: typeof p.parsePage === 'function', hasResolve: typeof p.resolveUrl === 'function' }));
}
