// Torrentio (torrentio.strem.fun) — torrents of films, series and anime by id: the IMDb id of the work picked
// (or found by name through Cinemeta), a series by season and episode, an anime by its Kitsu id and episode.
// search(query, { fetch, settings, title }) → results; the user's debrid key, when set in the add-on's
// settings, goes in the configuration so Torrentio returns cached links.
const META = 'https://v3-cinemeta.strem.io';
const ADDON = 'https://torrentio.strem.fun';
export const settings = [{ id: 'debrid', label: 'Debrid service', type: 'select', options: ['', 'realdebrid', 'alldebrid', 'premiumize', 'torbox', 'debridlink', 'offcloud', 'putio'] }, { id: 'debridKey', label: 'Debrid API key', type: 'password' }, { id: 'limit', label: 'Results per quality', type: 'number', value: 10 }];
const parseStream = (s, meta) => {
  // (The stream's text was `title` in older Stremio add-ons and is `description` now.)
  const text = s.description || s.title || ''; const lines = text.split('\n'); const name = (lines[0] || meta.name || '').trim();
  const info = lines.slice(1).join(' ');
  const seeds = Number(/👤\s*(\d+)/.exec(info)?.[1]); const sizeM = /💾\s*([\d.]+)\s*(TB|GB|MB|KB)/.exec(info); const provider = /⚙️\s*([^\n]+?)(?:\s{2,}|$)/.exec(info)?.[1]?.trim();
  const quality = /\b(2160p|4k|1080p|720p|480p)\b/i.exec(`${s.name || ''} ${name}`)?.[1]?.toLowerCase().replace('4k', '2160p');
  const mul = { TB: 1099511627776, GB: 1073741824, MB: 1048576, KB: 1024 };
  const trackers = (s.sources || []).filter((x) => x.startsWith('tracker:')).map((x) => `&tr=${encodeURIComponent(x.slice(8))}`).join('');
  const file = s.behaviorHints?.filename;
  return { title: name, source: 'torrentio', magnet: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(name)}${trackers}` : undefined, url: s.url, size: sizeM ? Math.round(Number(sizeM[1]) * mul[sizeM[2]]) : undefined, seeds: Number.isFinite(seeds) ? seeds : undefined, quality, date: provider, meta: { imdbId: meta.imdb_id, title: meta.name, fileIdx: s.fileIdx, file } };
};
async function streams(ctx, base, type, id, meta) {
  const r = await ctx.fetch(`${base}/stream/${type}/${id}.json`); if (!r.ok) throw new Error(`Torrentio: HTTP ${r.status}`);
  const j = await r.json(); return (j.streams || []).map((s) => parseStream(s, meta));
}
export async function search(query, ctx) {
  const cfg = ctx.settings || {};
  const config = [cfg.debrid && cfg.debridKey ? `${cfg.debrid}=${cfg.debridKey}` : '', `limit=${cfg.limit || 10}`].filter(Boolean).join('|');
  const base = config ? `${ADDON}/${config}` : ADDON;
  const t = ctx.title;
  if (t) {
    if (t.kind === 'anime' && t.kitsu) return streams(ctx, base, 'series', `kitsu:${t.kitsu}${t.episode ? `:${t.episode}` : ''}`, { name: t.title });
    if (t.imdb) return t.kind === 'movie' ? streams(ctx, base, 'movie', t.imdb, { name: t.title, imdb_id: t.imdb }) : streams(ctx, base, 'series', `${t.imdb}:${t.season || 1}:${t.episode || 1}`, { name: t.title, imdb_id: t.imdb });
  }
  const q = query.trim(); const m = /^(.*?)\s+s(\d{1,2})e(\d{1,3})$/i.exec(q);
  const name = (m ? m[1] : q).replace(/\s(19|20)\d\d$/, '');
  const metas = [];
  for (const type of m ? ['series'] : ['movie', 'series']) { const r = await ctx.fetch(`${META}/catalog/${type}/top/search=${encodeURIComponent(name)}.json`); if (r.ok) { const j = await r.json(); for (const x of (j.metas || []).slice(0, 2)) metas.push({ ...x, type }); } }
  const out = [];
  for (const meta of metas.slice(0, 3)) {
    const id = meta.type === 'series' ? `${meta.imdb_id}:${m ? Number(m[2]) : 1}:${m ? Number(m[3]) : 1}` : meta.imdb_id;
    try { out.push(...(await streams(ctx, base, meta.type, id, meta))); } catch { /* the next one */ }
  }
  return out;
}
