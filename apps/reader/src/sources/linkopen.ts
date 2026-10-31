// A link shared to the app or pasted into its search: the page it names opened in the source that has it — a
// novel of an added extension (by the extension's site), a Shamela book (at its page), an Internet Archive item
// — or, for a link no source knows, the app's browser on it. As LNReader does: the link's address without its
// query, an extension chosen only when it alone has the site.
import { listRepos, installedItems, type Repo } from './repos';
import { sourceIdOf } from './ext/source';

export type LinkTarget = { route: string } | { browser: string };

/** The first web address in a text ("Title — https://…" as browsers share it), or null. */
export function linkIn(text: string): string | null {
  const m = /https?:\/\/[^\s<>"'«»]+/i.exec(text);
  if (!m) return null;
  const u = m[0].replace(/[.,;:!?)\]}،؛]+$/, '');
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; }
}

const bookRoute = (src: string, id: string) => `/sources/${src}/book/${encodeURIComponent(id)}`;
const trim = (s: string) => s.replace(/\/+$/, '');

/** Where a link leads in the app. `repos` for tests. */
export async function targetOf(link: string, repos?: Repo[]): Promise<LinkTarget> {
  let u: URL; try { u = new URL(link); } catch { return { browser: link }; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'shamela.ws') {
    const m = /\/book\/(\d+)(?:\/(\d+))?/.exec(u.pathname);
    if (m) return { route: bookRoute('shamela', m[2] ? `${m[1]}#${m[2]}` : m[1]) };
  }
  if (host === 'archive.org') {
    const m = /^\/(?:details|download|stream)\/([^/?#]+)/.exec(u.pathname);
    if (m) return { route: bookRoute('archive', decodeURIComponent(m[1])) };
  }
  const bare = trim(u.origin + u.pathname);
  const all = repos ?? await listRepos().catch(() => [] as Repo[]);
  const hits: { id: string; site: string; kind: string }[] = [];
  for (const r of all) {
    if (r.kind === 'folder') continue;
    for (const i of (repos ? r.items : installedItems(r)).filter((x) => x.runnable && x.site)) {
      // (Its site as given, and with or without "www.": a link copied from a phone may have either.)
      const sites = new Set([trim(i.site), trim(i.site).replace('://www.', '://'), trim(i.site).replace(/:\/\/(?!www\.)/, '://www.')]);
      for (const s of sites) if (bare.startsWith(s) && (bare.length === s.length || bare[s.length] === '/')) { hits.push({ id: sourceIdOf(r, i), site: s, kind: i.kind }); break; }
    }
  }
  // (One extension alone: two for the same site — a copy in another repo — would be a guess.)
  const ids = new Set(hits.map((h) => h.id));
  if (ids.size === 1) {
    const h = hits[0];
    const rest = bare.slice(h.site.length);
    // (LNReader's plugins are given the path after their site, without slashes around it; Mangayomi's the
    // address's own path, with its query.)
    const p = h.kind === 'lnreader' ? rest.replace(/^\/+|\/+$/g, '') : u.pathname + u.search;
    if (p && p !== '/') return { route: bookRoute(h.id, p) };
    return { route: `/sources/${h.id}` };
  }
  return { browser: link };
}

/** Shared or pasted text opened: the page its link names (or the app's browser on it), or — no link — every
 *  source searched for its words. */
export async function openShared(text: string): Promise<void> {
  const { navigate } = await import('../router');
  const link = linkIn(text);
  if (!link) { const q = text.replace(/\s+/g, ' ').trim().slice(0, 200); if (q) navigate(`/sources/~all?q=${encodeURIComponent(q)}`); return; }
  const to = await targetOf(link);
  if ('route' in to) { navigate(to.route); return; }
  const { openBrowser } = await import('./http');
  await openBrowser(to.browser);
}
