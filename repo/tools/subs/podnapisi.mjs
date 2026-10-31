// Podnapisi.NET: the advanced search answered as JSON; the download is a zip; no key needed.
export default {
  async search(q) {
    const out = []; const seen = new Set();
    for (const lang of q.languages) {
      const p = new URLSearchParams({ keywords: q.title, language: lang }); if (q.year && q.kind === 'movie') p.set('year', String(q.year));
      if (q.kind === 'movie') p.set('movie_type', 'movie'); else { p.append('movie_type', 'tv-series'); p.append('movie_type', 'mini-series'); if (q.season) p.set('seasons', String(q.season)); if (q.episode) p.set('episodes', String(q.episode)); }
      const r = await q.fetch(`https://www.podnapisi.net/subtitles/search/advanced?${p}`, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(`Podnapisi: HTTP ${r.status}`);
      let j; try { j = await r.json(); } catch { throw new Error('Podnapisi answered with a page, not data'); }
      for (const d of j.data || []) { if (seen.has(d.id)) continue; seen.add(d.id); const rel = [...(d.releases || []), ...(d.custom_releases || [])]; out.push({ title: rel[0] || `${d.movie?.title || q.title}${d.movie?.year ? ` (${d.movie.year})` : ''}`, note: rel.slice(1).join(' / ') || undefined, language: (d.language || lang).toLowerCase().slice(0, 2), site: 'Podnapisi', hi: (d.flags || []).includes('hearing_impaired'), page: d.url, url: `https://www.podnapisi.net/subtitles/${d.id}/download?container=zip`, archive: 'zip', season: d.movie?.episode_info?.season, episode: d.movie?.episode_info?.episode }); }
    }
    return out;
  },
};
