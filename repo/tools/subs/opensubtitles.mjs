// OpenSubtitles (REST v1): by IMDb id (a show's parent id with season and episode) or text; needs the user's
// API key (free consumer key from opensubtitles.com); each download link is asked for when tapped.
const L = { zh: 'zh-CN', pt: 'pt-PT' };
export default {
  async search(q, ctx) {
    const key = ctx.settings.apiKey; if (!key) throw new Error('OpenSubtitles needs an API key (free at opensubtitles.com/consumers)');
    const headers = { 'Api-Key': key, 'User-Agent': 'KurokawaTools v1', Accept: 'application/json' };
    const p = new URLSearchParams({ languages: q.languages.map((l) => L[l] || l).join(','), order_by: 'download_count', order_direction: 'desc' });
    if (q.imdbId) { const id = q.imdbId.replace(/^tt/, ''); if (q.kind === 'movie' || !q.episode) p.set('imdb_id', id); else p.set('parent_imdb_id', id); } else p.set('query', q.title);
    if (q.season) p.set('season_number', String(q.season)); if (q.episode) p.set('episode_number', String(q.episode));
    const r = await q.fetch(`https://api.opensubtitles.com/api/v1/subtitles?${p}`, { headers }); if (!r.ok) throw new Error(`OpenSubtitles: HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || []).filter((d) => d.attributes?.files?.length).map((d) => { const a = d.attributes; return { title: a.release || a.files[0].file_name, language: (a.language || '').toLowerCase().slice(0, 2), site: 'OpenSubtitles', hi: a.hearing_impaired, downloads: a.download_count, page: a.url, season: a.feature_details?.season_number, episode: a.feature_details?.episode_number, ai: a.ai_translated || a.machine_translated, resolve: { fileId: a.files[0].file_id } }; });
  },
  /** The direct link of one result (OpenSubtitles hands it out per download). */
  async resolve(res, q, ctx) {
    const r = await q.fetch('https://api.opensubtitles.com/api/v1/download', { method: 'POST', headers: { 'Api-Key': ctx.settings.apiKey, 'User-Agent': 'KurokawaTools v1', 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ file_id: res.resolve.fileId }) });
    if (!r.ok) throw new Error(`OpenSubtitles: HTTP ${r.status}`); const j = await r.json(); if (!j.link) throw new Error(j.message || 'no link'); return { url: j.link, name: j.file_name };
  },
};
