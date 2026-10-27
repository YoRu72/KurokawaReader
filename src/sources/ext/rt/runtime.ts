// The sandbox: a frame of its own origin where the extensions' code runs, talking to the app only by messages.
// Built apart from the app (an IIFE), inlined into the frame by sources/ext/sandbox.ts.
import { settle, post, log } from './bridge';
import { loadLnPlugin, describeLn, type LnPlugin } from './lnreader';
import { loadMangayomi, type MExtension, type MPrefs, type MSource } from './mangayomi';

type Loaded = { kind: 'lnreader'; plugin: LnPlugin } | { kind: 'mangayomi'; ext: MExtension; prefs: MPrefs };
const plugins = new Map<string, Loaded>();
const plain = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

async function call(key: string, method: string, args: unknown[]): Promise<unknown> {
  const p = plugins.get(key); if (!p) throw new Error('Extension not loaded');
  if (p.kind === 'lnreader') {
    const pl = p.plugin as unknown as Record<string, unknown>;
    if (method === 'info') return describeLn(p.plugin);
    if (method === 'resolveUrl') return typeof p.plugin.resolveUrl === 'function' ? p.plugin.resolveUrl(String(args[0]), !!args[1]) : (/^(https?:)?\/\//.test(String(args[0])) ? String(args[0]) : p.plugin.site + String(args[0]));
    const fn = pl[method]; if (typeof fn !== 'function') throw new Error(`The plugin has no ${method}`);
    return plain(await (fn as (...a: unknown[]) => unknown).apply(p.plugin, args));
  }
  const ext = p.ext as unknown as Record<string, unknown>;
  if (method === 'info') {
    let filters: unknown = []; let prefs: unknown = []; let supportsLatest = true; let headers: unknown = null;
    try { filters = p.ext.getFilterList?.() ?? []; } catch { filters = []; }
    try { prefs = p.ext.getSourcePreferences?.() ?? []; } catch { prefs = []; }
    try { supportsLatest = p.ext.supportsLatest !== false; } catch { supportsLatest = true; }
    try { headers = p.ext.getHeaders?.(p.ext.source.baseUrl) ?? null; } catch { headers = null; }
    return plain({ source: p.ext.source, filters, prefs, supportsLatest, headers });
  }
  const fn = ext[method]; if (typeof fn !== 'function') throw new Error(`The extension has no ${method}`);
  return plain(await (fn as (...a: unknown[]) => unknown).apply(p.ext, args));
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const m = e.data as Record<string, unknown>; if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'res': settle(Number(m.id), !!m.ok, m.value); break;
    case 'load': {
      try {
        const key = String(m.key); const code = String(m.code);
        if (m.kind === 'lnreader') plugins.set(key, { kind: 'lnreader', plugin: loadLnPlugin(code, String(m.pluginId ?? key), (m.storage as Record<string, { created: string; value: unknown; expires?: number }>) ?? {}) });
        else plugins.set(key, { kind: 'mangayomi', ...loadMangayomi(code, m.source as MSource, key, (m.storage as Record<string, unknown>) ?? {}) });
        post({ t: 'loaded', id: m.id, ok: true });
      } catch (err) { post({ t: 'loaded', id: m.id, ok: false, error: String((err as Error)?.message ?? err) }); }
      break;
    }
    case 'unload': plugins.delete(String(m.key)); break;
    case 'call': {
      const id = m.id;
      call(String(m.key), String(m.method), (m.args as unknown[]) ?? []).then((value) => post({ t: 'done', id, ok: true, value }), (err) => { log('error', [String((err as Error)?.stack ?? err)]); post({ t: 'done', id, ok: false, error: String((err as Error)?.message ?? err) }); });
      break;
    }
  }
});
post({ t: 'ready' });
