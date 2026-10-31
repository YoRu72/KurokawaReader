// YTS — films in small encodes, by IMDb id when one is picked, else by name. search(query, { fetch }) → results.
const TR = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce', 'udp://tracker.openbittorrent.com:6969/announce'].map((x) => `&tr=${encodeURIComponent(x)}`).join('');
export const settings = [{ id: 'domain', label: 'API address', type: 'text', value: 'https://yts.mx' }];
export async function search(query, ctx) {
  const t = ctx.title; if (t && t.kind !== 'movie') return [];
  const base = String(ctx.settings?.domain || 'https://yts.mx').replace(/\/+$/, '');
  const term = t?.imdb || query.replace(/\s(19|20)\d\d$/, '');
  const r = await ctx.fetch(`${base}/api/v2/list_movies.json?query_term=${encodeURIComponent(term)}&limit=20&sort_by=seeds`); if (!r.ok) throw new Error(`YTS: HTTP ${r.status}`);
  const j = await r.json(); const out = [];
  for (const m of j.data?.movies || []) for (const x of m.torrents || []) {
    const title = `${m.title_long || m.title} [${x.quality}] [${x.type || ''}] [YTS]`.replace(/\s*\[\]/g, '');
    out.push({ title, source: 'yts', magnet: `magnet:?xt=urn:btih:${x.hash.toLowerCase()}&dn=${encodeURIComponent(title)}${TR}`, size: Number(x.size_bytes) || undefined, seeds: Number(x.seeds) || 0, peers: Number(x.peers) || 0, date: (x.date_uploaded || '').slice(0, 10), link: m.url, quality: x.quality, meta: { imdbId: m.imdb_code } });
  }
  return out;
}
