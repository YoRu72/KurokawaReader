// Runs a search through the installed add-ons' sources, each add-on's results under its name as they come, a
// tap on a result adding its download. The add-ons' modules define `search(query, ctx)` → results.
import { h, icon, toast } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { getEngine } from '../engine';
import { moduleUrl, loadIndex, nameOf, addonSettings } from '../addons';
import { getLang } from '../i18n';
import { addonFetch } from '../http';

export interface SearchResult { title: string; magnet?: string; url?: string; torrent?: string; size?: number; seeds?: number; peers?: number; date?: string; source: string; link?: string; quality?: string; meta?: Record<string, unknown> }
export interface SearchModule { search(query: string, ctx: { fetch: typeof fetch; lang: string; settings: Record<string, string | number | boolean> }): Promise<SearchResult[]> }

export async function runSearch(query: string, addons: string[], box: HTMLElement, only?: string): Promise<void> {
  box.replaceChildren();
  if (!query) return;
  const ix = await loadIndex().catch(() => null);
  const lang = getLang();
  await Promise.all(addons.filter((id) => !only || id === only).map(async (id) => {
    const entry = ix?.addons.find((a) => a.id === id);
    if (entry?.kind === 'group') return;
    const sec = h('section', { class: 'search-source' }, h('h4', null, entry ? nameOf(entry, lang) : id), h('div', { class: 'spinner small' }));
    box.append(sec);
    try {
      const u = await moduleUrl(id); if (!u) { sec.remove(); return; }
      const mod = (await import(/* @vite-ignore */ u)) as SearchModule & { default?: SearchModule };
      const m = mod.default ?? mod; if (typeof m.search !== 'function') { sec.remove(); return; }
      const rows = await m.search(query, { fetch: addonFetch() as unknown as typeof fetch, lang, settings: entry ? addonSettings(entry) : {} });
      if (!rows.length) { sec.remove(); return; }
      sec.replaceChildren(h('h4', null, `${entry ? nameOf(entry, lang) : id} · ${localDigits(rows.length)}`), ...rows.slice(0, 60).map((r) => h('button', { type: 'button', class: 'result-row', onclick: () => void add(r) },
        icon(r.magnet || r.torrent ? 'magnet' : 'link'), h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.title), h('small', { class: 'src' }, [r.quality, r.size ? formatBytes(r.size) : '', r.seeds !== undefined ? `↑${localDigits(r.seeds)}` : '', r.date ?? ''].filter(Boolean).join(' · '))))));
    } catch (e) { sec.replaceChildren(h('h4', null, entry ? nameOf(entry, lang) : id), h('p', { class: 'src' }, String((e as Error).message ?? e))); }
  }));
  if (!box.children.length) box.append(h('p', { class: 'empty small' }, t('noResults')));
}
async function add(r: SearchResult): Promise<void> {
  try { const tk = await getEngine().add({ source: r.magnet ? { magnet: r.magnet } : r.torrent ? { torrent: r.torrent } : { url: r.url! }, name: r.magnet || r.torrent ? undefined : r.title, sequential: true, meta: { addon: r.source, title: r.title, quality: r.quality } }); toast(t('taskAdded', { name: tk.name || r.title })); }
  catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
}
