// Extension marketplaces, browsed in the app the way Seanime's own marketplace page lists them: the community
// lists of Seanime extensions (with their working / broken marks and languages), Hayase repositories and
// Stremio add-ons; each anime torrent source installed by itself with one tap. The lists are read where their
// owners publish them, never copied.
import { request } from '../http';
import { readRepo, type ProviderEntry } from './providers';

export interface Market { id: string; name: string; url: string; kind: 'seanime' | 'hayase' | 'stremio'; note?: string }
export const MARKETS: Market[] = [
  { id: 'seanime', name: 'Seanime Marketplace', url: 'https://raw.githubusercontent.com/Bas1874/Seanime-Marketplace/refs/heads/main/Marketplace/Main.json', kind: 'seanime' },
  { id: 'hayase-tanzim', name: 'Hayase extensions (tanzim2000)', url: 'https://raw.githubusercontent.com/tanzim2000/hayase-extension/refs/heads/main/index.json', kind: 'hayase' },
  { id: 'asleepy', name: 'ASleepyDrink', url: 'https://raw.githubusercontent.com/ASleepyDrink/Seanime-Stuff/refs/heads/main/marketplace.json', kind: 'seanime' },
  { id: 'paldroid', name: 'Pal-droid', url: 'https://raw.githubusercontent.com/Pal-droid/Seanime-Providers/main/marketplace/main.json', kind: 'seanime' },
  { id: 'jhoorodre', name: 'Jhoorodre (PT-BR)', url: 'https://raw.githubusercontent.com/Jhoorodre/seanime-provider/master/marketplace.json', kind: 'seanime' },
];
/** Stremio add-ons that answer for anime (by Kitsu id) — added from their manifest address. */
export const STREMIO_SUGGESTED: { name: string; url: string }[] = [
  { name: 'Torrentio', url: 'https://torrentio.strem.fun/manifest.json' },
  { name: 'Comet', url: 'https://comet.elfhosted.com/manifest.json' },
  { name: 'MediaFusion', url: 'https://mediafusion.elfhosted.com/manifest.json' },
];

export interface MarketItem { entry: ProviderEntry; lang?: string; status?: 'working' | 'broken' | 'deprecated'; author?: string; updatedAt?: string }
type SeaRaw = { id: string; name: string; version?: string; description?: string; type: string; lang?: string; language?: string; icon?: string; author?: string; manifestURI?: string; payloadURI?: string; payload?: string; workingTag?: boolean; brokenTag?: boolean; deprecatedTag?: boolean; updatedAt?: string };

const cache = new Map<string, { at: number; items: MarketItem[] }>();
/** The anime torrent sources a marketplace lists (fetched fresh after ten minutes). */
export async function readMarket(m: Market): Promise<MarketItem[]> {
  const had = cache.get(m.id); if (had && Date.now() - had.at < 600000) return had.items;
  let items: MarketItem[];
  if (m.kind === 'seanime') {
    const r = await request(m.url); if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(r.body) as SeaRaw[] | { extensions?: SeaRaw[]; urls?: string[] };
    const list: SeaRaw[] = Array.isArray(j) ? j : j.extensions ?? [];
    if (!list.length && !Array.isArray(j) && j.urls) items = (await readRepo(m.url)).map((entry) => ({ entry }));
    else items = list.filter((x) => x && x.type === 'anime-torrent-provider' && (x.payloadURI || x.payload || x.manifestURI)).map((x) => ({
      entry: { id: `sea:${x.id}`, name: x.name, description: x.description, version: x.version ?? '0', format: 'seanime', icon: x.icon, code: x.payloadURI ?? (x.payload ? `inline:${x.payload}` : `manifest:${x.manifestURI}`), manifest: x.manifestURI, repo: m.url, enabled: true },
      lang: x.lang ?? (x.language && x.language.length <= 5 ? x.language : undefined), author: x.author, updatedAt: x.updatedAt,
      status: x.deprecatedTag ? 'deprecated' : x.brokenTag ? 'broken' : x.workingTag ? 'working' : undefined,
    }));
  } else items = (await readRepo(m.url)).map((entry) => ({ entry }));
  cache.set(m.id, { at: Date.now(), items });
  return items;
}
/** The entry made ready to install: a Seanime entry known only by its manifest gets its payload address (and
 *  its settings) from it first. */
export async function resolveEntry(it: MarketItem): Promise<ProviderEntry> {
  const e = it.entry;
  if (e.format === 'seanime' && (e.code.startsWith('manifest:') || !e.options) && e.manifest) {
    const got = await readRepo(e.manifest).catch(() => [] as ProviderEntry[]);
    const full = got.find((x) => x.id === e.id) ?? got[0];
    if (full) return { ...e, ...full, id: e.id, repo: e.repo };
    if (e.code.startsWith('manifest:')) throw new Error(`${e.name}: manifest`);
  }
  return e;
}
