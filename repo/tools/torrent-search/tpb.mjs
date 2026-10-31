// The Pirate Bay — through its public JSON API (apibay.org). search(query, { fetch }) → results.
const TR = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce', 'udp://exodus.desync.com:6969/announce'].map((x) => `&tr=${encodeURIComponent(x)}`).join('');
export const settings = [{ id: 'domain', label: 'API address', type: 'text', value: 'https://apibay.org' }];
export async function search(query, ctx) {
  const base = String(ctx.settings?.domain || 'https://apibay.org').replace(/\/+$/, '');
  const q = ctx.title?.imdb && ctx.title.kind === 'movie' ? ctx.title.imdb : query;
  const r = await ctx.fetch(`${base}/q.php?q=${encodeURIComponent(q)}&cat=0`); if (!r.ok) throw new Error(`TPB: HTTP ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j) ? j : []).filter((x) => x.info_hash && !/^0+$/.test(x.info_hash) && x.name !== 'No results returned').map((x) => ({
    title: x.name, source: 'tpb', magnet: `magnet:?xt=urn:btih:${x.info_hash.toLowerCase()}&dn=${encodeURIComponent(x.name)}${TR}`, size: Number(x.size) || undefined, seeds: Number(x.seeders) || 0, peers: Number(x.leechers) || 0,
    date: x.added ? new Date(Number(x.added) * 1000).toISOString().slice(0, 10) : undefined, link: `https://thepiratebay.org/description.php?id=${x.id}`, quality: /\b(2160p|1080p|720p|480p)\b/i.exec(x.name)?.[1], meta: x.imdb ? { imdbId: x.imdb } : undefined,
  }));
}
