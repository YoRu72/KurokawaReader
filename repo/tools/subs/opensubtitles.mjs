// OpenSubtitles: with the user's API key, the REST v1 API (by IMDb id — a show's parent id with season and
// episode — or text; each download link asked for when tapped). Without a key, opensubtitles.org's own JSON
// search (by IMDb id, season and episode, or text) with its zip downloads, so the source works out of the box.
const L = { zh: 'zh-CN', pt: 'pt-PT' };
// opensubtitles.org's three-letter language ids.
const L3 = { en: 'eng', ar: 'ara', ja: 'jpn', ko: 'kor', zh: 'chi', fr: 'fre', de: 'ger', es: 'spa', pt: 'por', it: 'ita', ru: 'rus', tr: 'tur', fa: 'per', id: 'ind', vi: 'vie', th: 'tha', nl: 'dut', pl: 'pol', sv: 'swe', he: 'heb', hi: 'hin', ms: 'may', el: 'ell', ro: 'rum', hu: 'hun', cs: 'cze', uk: 'ukr', bg: 'bul', hr: 'hrv', sr: 'scc', da: 'dan', fi: 'fin', no: 'nor', bn: 'ben', ur: 'urd' };
const UA = 'KurokawaTools v1';
async function keyless(q) {
  // (One language per request: the search takes a single value per field.)
  const one = async (lang) => {
    const seg = [];
    if (q.kind !== 'movie' && q.episode) seg.push(`episode-${q.episode}`);
    seg.push(q.imdbId ? `imdbid-${q.imdbId.replace(/^tt/, '')}` : `query-${encodeURIComponent(q.title.toLowerCase())}`);
    if (q.kind !== 'movie' && q.season) seg.push(`season-${q.season}`);
    seg.push(`sublanguageid-${L3[lang] || lang}`);
    const r = await q.fetch(`https://rest.opensubtitles.org/search/${seg.join('/')}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`OpenSubtitles: HTTP ${r.status}`);
    let j; try { j = await r.json(); } catch { throw new Error('OpenSubtitles answered with a page, not data'); }
    return Array.isArray(j) ? j : [];
  };
  const got = await Promise.allSettled(q.languages.slice(0, 4).map(one));
  const ok = got.filter((x) => x.status === 'fulfilled').flatMap((x) => x.value);
  if (!ok.length && got.some((x) => x.status === 'rejected')) throw got.find((x) => x.status === 'rejected').reason;
  return ok.filter((s) => s.ZipDownloadLink).map((s) => ({ title: (s.MovieReleaseName || s.SubFileName || '').trim() || s.SubFileName, note: s.SubFileName, language: (s.ISO639 || '').toLowerCase().slice(0, 2) || undefined, site: 'OpenSubtitles', hi: s.SubHearingImpaired === '1', ai: s.SubAutoTranslation === '1', downloads: Number(s.SubDownloadsCnt) || 0, page: s.SubtitlesLink, season: Number(s.SeriesSeason) || undefined, episode: Number(s.SeriesEpisode) || undefined, url: s.ZipDownloadLink, archive: 'zip' }));
}
export default {
  async search(q, ctx) {
    const key = ctx.settings.apiKey; if (!key) return keyless(q);
    const headers = { 'Api-Key': key, 'User-Agent': UA, Accept: 'application/json' };
    const p = new URLSearchParams({ languages: q.languages.map((l) => L[l] || l).join(','), order_by: 'download_count', order_direction: 'desc' });
    if (q.imdbId) { const id = q.imdbId.replace(/^tt/, ''); if (q.kind === 'movie' || !q.episode) p.set('imdb_id', id); else p.set('parent_imdb_id', id); } else p.set('query', q.title);
    if (q.season) p.set('season_number', String(q.season)); if (q.episode) p.set('episode_number', String(q.episode));
    const r = await q.fetch(`https://api.opensubtitles.com/api/v1/subtitles?${p}`, { headers });
    // (A key refused or the API out of service: the keyless search instead of nothing.)
    if (!r.ok) { if (r.status === 401 || r.status === 403 || r.status >= 500) return keyless(q); throw new Error(`OpenSubtitles: HTTP ${r.status}`); }
    const j = await r.json();
    return (j.data || []).filter((d) => d.attributes?.files?.length).map((d) => { const a = d.attributes; return { title: a.release || a.files[0].file_name, language: (a.language || '').toLowerCase().slice(0, 2), site: 'OpenSubtitles', hi: a.hearing_impaired, downloads: a.download_count, page: a.url, season: a.feature_details?.season_number, episode: a.feature_details?.episode_number, ai: a.ai_translated || a.machine_translated, resolve: { fileId: a.files[0].file_id } }; });
  },
  /** The direct link of one result (OpenSubtitles hands it out per download). */
  async resolve(res, q, ctx) {
    const r = await q.fetch('https://api.opensubtitles.com/api/v1/download', { method: 'POST', headers: { 'Api-Key': ctx.settings.apiKey, 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ file_id: res.resolve.fileId }) });
    if (!r.ok) throw new Error(`OpenSubtitles: HTTP ${r.status}`); const j = await r.json(); if (!j.link) throw new Error(j.message || 'no link'); return { url: j.link, name: j.file_name };
  },
};
