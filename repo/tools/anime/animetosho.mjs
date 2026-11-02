// AnimeTosho (feed.animetosho.org/json): by AniDB id when the app knows it, by name otherwise — the Hayase
// source interface.
const BASE = 'https://feed.animetosho.org/json';
const map = (rows) => rows.filter((e) => e.info_hash).map((e) => ({ title: e.title || e.torrent_name, link: e.magnet_uri || e.torrent_url, hash: e.info_hash.toLowerCase(), size: e.total_size || 0, seeders: e.seeders ?? 0, leechers: e.leechers ?? 0, downloads: e.torrent_downloaded_count ?? 0, date: new Date((e.timestamp || 0) * 1000), accuracy: 'medium' }));
// (Asked twice when it is slow or busy; a web page instead of JSON — its check, an outage — said in words.)
async function get(q, qs) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await q.fetch(`${BASE}?${qs}`); const body = await r.text();
      if (r.status === 404) return [];
      if (!r.ok) { last = new Error(`AnimeTosho: HTTP ${r.status}`); if (r.status < 500 && r.status !== 429) break; }
      else { try { const j = JSON.parse(body); return Array.isArray(j) ? map(j) : []; } catch { last = new Error('AnimeTosho answered with a web page instead of results (it may be down or checking visitors); try again later'); } }
    } catch (e) { last = e; }
    await new Promise((ok) => setTimeout(ok, 1200));
  }
  throw last;
}
const quality = (q) => (q.resolution ? `&qx=1&q=${encodeURIComponent(`"${q.resolution}"`)}` : '');
export default {
  async test(q) { const r = await q.fetch(BASE); return r.ok; },
  async single(q) { if (q.anidbEid) { const rs = await get(q, `eid=${q.anidbEid}${quality(q)}`).catch(() => []); if (rs.length) return rs; } if (q.anidbAid) { const rs = await get(q, `aid=${q.anidbAid}${quality(q)}`).catch(() => []); const ep = new RegExp(`(?:E|[ _.-])0*${q.episode}(?:v\\d)?(?=[ _.\\]\\[)-]|$)`, 'i'); const mine = rs.filter((r) => ep.test(r.title) || /batch|complete|\\d+\\s*[-~]\\s*\\d+/i.test(r.title)); if (mine.length) return mine; } return get(q, `q=${encodeURIComponent(`${q.titles[0]} ${String(q.episode).padStart(2, '0')}`)}&qx=1`); },
  async batch(q) { if (q.anidbAid) return (await get(q, `order=size-d&aid=${q.anidbAid}${quality(q)}`)).map((r) => ({ ...r, type: 'batch' })); return (await get(q, `q=${encodeURIComponent(`${q.titles[0]} batch`)}&qx=1`)).map((r) => ({ ...r, type: 'batch' })); },
  async movie(q) { if (q.anidbAid) return get(q, `aid=${q.anidbAid}${quality(q)}`); return get(q, `q=${encodeURIComponent(q.titles[0])}&qx=1`); },
};
