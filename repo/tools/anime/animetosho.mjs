// AnimeTosho (feed.animetosho.org/json): by AniDB id when the app knows it, by name otherwise — the Hayase
// source interface.
const BASE = 'https://feed.animetosho.org/json';
const map = (rows) => rows.filter((e) => e.info_hash).map((e) => ({ title: e.title || e.torrent_name, link: e.magnet_uri || e.torrent_url, hash: e.info_hash.toLowerCase(), size: e.total_size || 0, seeders: e.seeders ?? 0, leechers: e.leechers ?? 0, downloads: e.torrent_downloaded_count ?? 0, date: new Date((e.timestamp || 0) * 1000), accuracy: 'medium' }));
async function get(q, qs) { const r = await q.fetch(`${BASE}?${qs}`); if (!r.ok) throw new Error(`AnimeTosho: HTTP ${r.status}`); return map(await r.json()); }
const quality = (q) => (q.resolution ? `&qx=1&q=${encodeURIComponent(`"${q.resolution}"`)}` : '');
export default {
  async test(q) { const r = await q.fetch(BASE); return r.ok; },
  async single(q) { if (q.anidbAid) { const rs = await get(q, `aid=${q.anidbAid}${quality(q)}`); if (rs.length) return rs; } return get(q, `q=${encodeURIComponent(`${q.titles[0]} ${String(q.episode).padStart(2, '0')}`)}&qx=1`); },
  async batch(q) { if (q.anidbAid) return (await get(q, `order=size-d&aid=${q.anidbAid}${quality(q)}`)).map((r) => ({ ...r, type: 'batch' })); return (await get(q, `q=${encodeURIComponent(`${q.titles[0]} batch`)}&qx=1`)).map((r) => ({ ...r, type: 'batch' })); },
  async movie(q) { if (q.anidbAid) return get(q, `aid=${q.anidbAid}${quality(q)}`); return get(q, `q=${encodeURIComponent(q.titles[0])}&qx=1`); },
};
