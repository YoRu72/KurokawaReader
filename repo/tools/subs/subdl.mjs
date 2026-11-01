// SubDL (api.subdl.com): by IMDb id or name, season and episode; needs the user's free API key.
export default {
  async search(q, ctx) {
    const key = ctx.settings.apiKey; if (!key) { const e = new Error('SubDL needs an API key (free at subdl.com)'); e.code = 'key'; e.site = 'https://subdl.com/panel/api'; throw e; }
    const p = new URLSearchParams({ api_key: key, languages: q.languages.map((l) => l.toUpperCase()).join(','), subs_per_page: '30' });
    if (q.imdbId) p.set('imdb_id', q.imdbId); else p.set('film_name', q.title);
    if (q.kind !== 'movie') { p.set('type', 'tv'); if (q.season) p.set('season_number', String(q.season)); if (q.episode) p.set('episode_number', String(q.episode)); } else p.set('type', 'movie');
    const r = await q.fetch(`https://api.subdl.com/api/v1/subtitles?${p}`); if (!r.ok) throw new Error(`SubDL: HTTP ${r.status}`);
    const j = await r.json(); if (!j.status) throw new Error(`SubDL: ${j.error || 'no results'}`);
    return (j.subtitles || []).map((s) => ({ title: s.release_name || s.name, language: (s.lang || s.language || '').toLowerCase().slice(0, 2) || undefined, url: `https://dl.subdl.com${s.url}`, site: 'SubDL', season: s.season, episode: s.episode, hi: !!s.hi, archive: 'zip' }));
  },
};
