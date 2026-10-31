// SubSource (api.subsource.net v1): the title by IMDb id (or text), then its subtitles per language; needs the
// user's API key.
const NAMES = { en: 'english', ar: 'arabic', ja: 'japanese', ko: 'korean', zh: 'chinese', fr: 'french', de: 'german', es: 'spanish', pt: 'portuguese', it: 'italian', ru: 'russian', tr: 'turkish', fa: 'farsi_persian', id: 'indonesian', vi: 'vietnamese', th: 'thai', nl: 'dutch', pl: 'polish', sv: 'swedish', he: 'hebrew', hi: 'hindi', ms: 'malay', el: 'greek', ro: 'romanian', hu: 'hungarian', cs: 'czech', uk: 'ukrainian', bg: 'bulgarian', hr: 'croatian', sr: 'serbian', da: 'danish', fi: 'finnish', no: 'norwegian', bn: 'bengali' };
const BASE = 'https://api.subsource.net/api/v1';
export default {
  async search(q, ctx) {
    const key = ctx.settings.apiKey; if (!key) throw new Error('SubSource needs an API key (subsource.net)');
    const sp = new URLSearchParams({ api_key: key }); if (q.imdbId) { sp.set('searchType', 'imdb'); sp.set('imdb', q.imdbId); } else { sp.set('searchType', 'text'); sp.set('q', q.title.toLowerCase()); } if (q.season) sp.set('season', String(q.season));
    const r = await q.fetch(`${BASE}/movies/search?${sp}`); if (!r.ok) throw new Error(`SubSource: HTTP ${r.status}`);
    const j = await r.json(); if (j.success === false) throw new Error(`SubSource: ${j.error}`);
    const out = [];
    for (const m of (j.data || []).slice(0, 2)) for (const lang of q.languages) {
      const p = new URLSearchParams({ api_key: key, movieId: String(m.movieId), language: NAMES[lang] || lang, limit: '100' }); if (q.season) p.set('seasonNumber', String(q.season)); if (q.episode) p.set('episodeNumber', String(q.episode));
      const rr = await q.fetch(`${BASE}/subtitles?${p}`); if (!rr.ok) continue; const jj = await rr.json();
      for (const s of jj.data || []) out.push({ title: (s.releaseInfo || []).join(' / ') || m.title, language: lang, site: 'SubSource', hi: s.hearingImpaired, url: `${BASE}/subtitles/${s.subtitleId}/download?api_key=${encodeURIComponent(key)}`, archive: 'zip', note: s.commentary || undefined });
    }
    return out;
  },
};
