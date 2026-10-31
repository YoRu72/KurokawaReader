// Gestdown (api.gestdown.info, an Addic7ed mirror): shows by TVDB id or name, then a season's subtitles per
// language; no key needed.
const NAMES = { en: 'English', ar: 'Arabic', ja: 'Japanese', ko: 'Korean', zh: 'Chinese (Simplified)', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese', it: 'Italian', ru: 'Russian', tr: 'Turkish', fa: 'Persian', id: 'Indonesian', vi: 'Vietnamese', th: 'Thai', nl: 'Dutch', pl: 'Polish', sv: 'Swedish', he: 'Hebrew', hi: 'Hindi', ms: 'Malay', el: 'Greek', ro: 'Romanian', hu: 'Hungarian', cs: 'Czech', uk: 'Ukrainian', bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', da: 'Danish', fi: 'Finnish', no: 'Norwegian', bn: 'Bengali' };
const BASE = 'https://api.gestdown.info';
export default {
  async search(q) {
    if (q.kind === 'movie') return [];
    let shows = [];
    if (q.tvdbId) { const r = await q.fetch(`${BASE}/shows/external/tvdb/${q.tvdbId}`); if (r.ok) shows = (await r.json()).shows || []; }
    if (!shows.length) { const r = await q.fetch(`${BASE}/shows/search/${encodeURIComponent(q.title)}`); if (!r.ok) { if (r.status === 404) return []; throw new Error(`Gestdown: HTTP ${r.status}`); } shows = ((await r.json()).shows || []).slice(0, 2); }
    const season = q.season || 1; const out = [];
    for (const s of shows) for (const lang of q.languages) {
      const r = await q.fetch(`${BASE}/shows/${s.id}/${season}/${encodeURIComponent(NAMES[lang] || lang)}`); if (!r.ok) continue;
      for (const ep of (await r.json()).episodes || []) { if (q.episode && ep.number !== q.episode) continue; for (const sub of ep.subtitles || []) out.push({ title: `${s.name} S${String(season).padStart(2, '0')}E${String(ep.number).padStart(2, '0')} · ${sub.version}`, language: lang, site: 'Gestdown (Addic7ed)', hi: sub.hearingImpaired, partial: !sub.completed, url: `${BASE}${sub.downloadUri}`, season, episode: ep.number }); }
    }
    return out;
  },
};
