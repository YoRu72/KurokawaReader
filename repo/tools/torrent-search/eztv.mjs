// EZTV — episodes of series, by IMDb id (a series has to be picked first: EZTV has no name search in its API).
// search(query, { fetch, title }) → results, the picked season and episode first.
export const settings = [{ id: 'domain', label: 'API address', type: 'text', value: 'https://eztvx.to' }];
export async function search(query, ctx) {
  const t = ctx.title; if (!t?.imdb || t.kind === 'movie') return [];
  const base = String(ctx.settings?.domain || 'https://eztvx.to').replace(/\/+$/, ''); const id = t.imdb.replace(/^tt/, '');
  const out = [];
  const take = (rows) => { for (const x of rows) {
      const s = Number(x.season), e = Number(x.episode);
      if (t.season && s && s !== t.season) continue; if (t.episode && e && e !== t.episode) continue;
      out.push(({ title: x.title || x.filename, source: 'eztv', magnet: x.magnet_url, url: x.magnet_url ? undefined : x.torrent_url, size: Number(x.size_bytes) || undefined, seeds: Number(x.seeds) || 0, peers: Number(x.peers) || 0, date: x.date_released_unix ? new Date(Number(x.date_released_unix) * 1000).toISOString().slice(0, 10) : undefined, link: x.episode_url, quality: /\b(2160p|1080p|720p|480p)\b/i.exec(x.title || '')?.[1] }));
    } };
  const page = async (n) => { const r = await ctx.fetch(`${base}/api/get-torrents?imdb_id=${id}&limit=100&page=${n}`); if (!r.ok) throw new Error(`EZTV: HTTP ${r.status}`); return (await r.json()).torrents || []; };
  // (The first page; a full one: the next two at once.)
  const first = await page(1); take(first);
  if (first.length >= 100) for (const g of await Promise.allSettled([page(2), page(3)])) if (g.status === 'fulfilled') take(g.value);
  return out;
}
