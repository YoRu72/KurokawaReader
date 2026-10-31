// AnimeTosho's subtitle attachments: the episode's torrents (by AniDB id, else by name), each torrent's files
// and their subtitle attachments — .xz files the app unpacks on download.
const FEED = 'https://feed.animetosho.org/json';
export default {
  async search(q) {
    if (!q.anilistId && !q.anidbAid) return [];
    const epn = q.animeEpisode ?? q.episode; const ep = epn ? ` ${String(epn).padStart(2, "0")}` : "";
    const r = await q.fetch(q.anidbAid ? `${FEED}?aid=${q.anidbAid}${epn ? `&q=${encodeURIComponent(`"${ep.trim()}"`)}&qx=1` : ''}` : `${FEED}?q=${encodeURIComponent(q.title + ep)}&qx=1`); if (!r.ok) throw new Error(`AnimeTosho: HTTP ${r.status}`);
    const entries = (await r.json()).slice(0, 8); const out = [];
    for (const e of entries) {
      const rr = await q.fetch(`${FEED}?show=torrent&id=${e.id}`); if (!rr.ok) continue; const t = await rr.json();
      for (const f of t.files || []) for (const a of f.attachments || []) {
        if (a.type !== 'subtitle') continue; const lang = (a.info?.lang || '').toLowerCase().slice(0, 2);
        if (q.languages.length && lang && !q.languages.includes(lang)) continue;
        out.push({ title: `${f.filename}${a.info?.name ? ` · ${a.info.name}` : ''}`, language: lang || undefined, site: 'AnimeTosho', url: `https://animetosho.org/storage/attach/${a.id.toString(16).padStart(8, '0')}/${a.id}.xz`, archive: 'xz', note: e.title });
      }
    }
    return out;
  },
};
