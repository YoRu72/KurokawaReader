// Torrentio for anime (the Hayase source interface): Kitsu ids the app looks up, the anime providers of
// Torrentio (nyaa, tokyotosho, anidex, nekobt, horriblesubs); with a debrid key the links come resolved.
const ADDON = 'https://torrentio.strem.fun';
const parse = (s) => {
  const lines = (s.description || s.title || '').split('\n'); const name = lines[0] || ''; const info = lines.slice(1).join(' ');
  const seeders = Number(/👤\s*(\d+)/.exec(info)?.[1]) || 0; const sz = /💾\s*([\d.]+)\s*(GB|MB|KB)/.exec(info); const size = sz ? Math.round(Number(sz[1]) * ({ GB: 1073741824, MB: 1048576, KB: 1024 }[sz[2]])) : 0;
  const trackers = (s.sources || []).filter((x) => x.startsWith('tracker:')).map((x) => `&tr=${encodeURIComponent(x.slice(8))}`).join('');
  return { title: (s.behaviorHints && s.behaviorHints.filename) || name, link: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(name)}${trackers}` : (s.url || ''), hash: (s.infoHash || '').toLowerCase(), url: s.url, fileIdx: s.fileIdx, size, seeders, leechers: 0, downloads: 0, accuracy: 'high', date: new Date() };
};
async function streams(q, o, path) {
  const cfg = [`providers=${o.providers || 'nyaasi,horriblesubs,tokyotosho,anidex,nekobt'}`, o.debrid && o.debridKey ? `${o.debrid}=${o.debridKey}` : '', `sort=${o.sort || 'seeders'}`, `limit=${o.limit || 10}`].filter(Boolean).join('|');
  let r = await q.fetch(`${ADDON}/${cfg}/stream/${path}.json`); if (r.status >= 500 || r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); r = await q.fetch(`${ADDON}/${cfg}/stream/${path}.json`); } if (r.status === 404) return []; if (!r.ok) throw new Error(`Torrentio: HTTP ${r.status}`);
  return ((await r.json()).streams || []).map(parse).filter((x) => x.hash || x.url);
}
export default {
  async test(q) { const r = await q.fetch(`${ADDON}/manifest.json`); return r.ok; },
  async single(q, o = {}) { if (q.kitsuId) return streams(q, o, `anime/kitsu:${q.kitsuId}:${q.absoluteEpisodeNumber || q.episode}`); if (q.imdbId) return streams(q, o, `series/${q.imdbId}:1:${q.episode}`); return []; }, // (Torrentio finds shows by their ids only; a show without them, or a name typed by hand, is for the other sources.)
  async batch(q, o = {}) { if (q.kitsuId) return (await streams(q, o, `anime/kitsu:${q.kitsuId}`)).map((r) => ({ ...r, type: 'batch' })); return []; },
  async movie(q, o = {}) { if (q.kitsuId) return streams(q, o, `anime/kitsu:${q.kitsuId}`); if (q.imdbId) return streams(q, o, `movie/${q.imdbId}`); return []; },
};
