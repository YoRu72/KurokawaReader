// Torrentio (torrentio.strem.fun) — torrents of films and series by their IMDb id, the id found by name
// through Cinemeta's catalogue search. search(query, { fetch }) → results; the user's debrid key, when set in
// the add-on's settings, is passed in the configuration so Torrentio returns cached links.
const META = 'https://v3-cinemeta.strem.io';
const ADDON = 'https://torrentio.strem.fun';
export const settings = [{ id: 'debrid', label: 'Debrid service', type: 'select', options: ['', 'realdebrid', 'alldebrid', 'premiumize', 'torbox', 'debridlink', 'offcloud', 'putio'] }, { id: 'debridKey', label: 'Debrid API key', type: 'password' }, { id: 'limit', label: 'Results per quality', type: 'number', value: 10 }];
const parseStream = (s, meta) => {
  const lines = (s.title || '').split('\n'); const name = lines[0] || meta.name;
  const info = lines.slice(1).join(' ');
  const seeds = Number(/👤\s*(\d+)/.exec(info)?.[1]); const sizeM = /💾\s*([\d.]+)\s*(GB|MB)/.exec(info); const provider = /⚙️\s*([^\s]+)/.exec(info)?.[1];
  const quality = /\b(2160p|4k|1080p|720p|480p)\b/i.exec(s.name || '')?.[1];
  return { title: name, source: 'torrentio', magnet: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(name)}${(s.sources || []).filter((x) => x.startsWith('tracker:')).map((x) => `&tr=${encodeURIComponent(x.slice(8))}`).join('')}` : undefined, url: s.url, size: sizeM ? Math.round(Number(sizeM[1]) * (sizeM[2] === 'GB' ? 1073741824 : 1048576)) : undefined, seeds: Number.isFinite(seeds) ? seeds : undefined, quality, date: provider, meta: { imdbId: meta.imdb_id, title: meta.name, fileIdx: s.fileIdx } };
};
export async function search(query, ctx) {
  const cfg = ctx.settings || {};
  const config = [cfg.debrid && cfg.debridKey ? `${cfg.debrid}=${cfg.debridKey}` : '', `limit=${cfg.limit || 10}`].filter(Boolean).join('|');
  const base = config ? `${ADDON}/${config}` : ADDON;
  const q = query.trim(); const m = /^(.*?)\s+s(\d{1,2})e(\d{1,3})$/i.exec(q);
  const name = m ? m[1] : q;
  const metas = [];
  for (const type of ['movie', 'series']) { const r = await ctx.fetch(`${META}/catalog/${type}/top/search=${encodeURIComponent(name)}.json`); if (r.ok) { const j = await r.json(); for (const x of (j.metas || []).slice(0, 3)) metas.push({ ...x, type }); } }
  const out = [];
  for (const meta of metas.slice(0, 4)) {
    const id = meta.type === 'series' ? `${meta.imdb_id}:${m ? Number(m[2]) : 1}:${m ? Number(m[3]) : 1}` : meta.imdb_id;
    const r = await ctx.fetch(`${base}/stream/${meta.type}/${id}.json`); if (!r.ok) continue;
    const j = await r.json();
    for (const s of j.streams || []) out.push(parseStream(s, meta));
  }
  return out;
}
