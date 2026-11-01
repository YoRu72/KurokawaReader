// Podnapisi.NET: the advanced search answered as JSON (one request per language, the languages asked at once);
// the download is a zip; no key needed. When the site puts up a browser check, the app says so and offers to
// open the site once so the check is passed in its own window.
const SITE = 'https://www.podnapisi.net';
export default {
  async search(q) {
    const one = async (lang) => {
      const p = new URLSearchParams({ keywords: q.title, language: lang }); if (q.year && q.kind === 'movie') p.set('year', String(q.year));
      if (q.kind === 'movie') p.set('movie_type', 'movie'); else { p.append('movie_type', 'tv-series'); p.append('movie_type', 'mini-series'); if (q.season) p.set('seasons', String(q.season)); if (q.episode) p.set('episodes', String(q.episode)); }
      const r = await q.fetch(`${SITE}/subtitles/search/advanced?${p}`, { headers: { Accept: 'application/json' } });
      const text = await r.text();
      if (r.status === 403 || r.status === 503 || /<html|just a moment|cf-chl|challenge/i.test(text.slice(0, 2000))) { const e = new Error('Podnapisi asks for a browser check'); e.code = 'check'; e.site = SITE; throw e; }
      if (!r.ok) throw new Error(`Podnapisi: HTTP ${r.status}`);
      let j; try { j = JSON.parse(text); } catch { throw new Error('Podnapisi answered with a page, not data'); }
      return (j.data || []).map((d) => ({ d, lang }));
    };
    const got = await Promise.allSettled(q.languages.slice(0, 4).map(one));
    const ok = got.filter((x) => x.status === 'fulfilled').flatMap((x) => x.value);
    if (!ok.length && got.some((x) => x.status === 'rejected')) throw got.find((x) => x.status === 'rejected').reason;
    const out = []; const seen = new Set();
    for (const { d, lang } of ok) { if (seen.has(d.id)) continue; seen.add(d.id); const rel = [...(d.releases || []), ...(d.custom_releases || [])]; out.push({ title: rel[0] || `${d.movie?.title || q.title}${d.movie?.year ? ` (${d.movie.year})` : ''}`, note: rel.slice(1).join(' / ') || undefined, language: (d.language || lang).toLowerCase().slice(0, 2), site: 'Podnapisi', hi: (d.flags || []).includes('hearing_impaired'), page: d.url ? new URL(d.url, SITE).href : undefined, url: `${SITE}/subtitles/${d.id}/download?container=zip`, archive: 'zip', season: d.movie?.episode_info?.season, episode: d.movie?.episode_info?.episode }); }
    return out;
  },
};
