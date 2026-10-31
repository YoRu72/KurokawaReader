// Jimaku (jimaku.cc): Japanese (and some English) anime subtitles by AniList id; needs the user's free API key.
const BASE = 'https://jimaku.cc/api';
export default {
  async search(q, ctx) {
    if (!q.anilistId) return []; const key = ctx.settings.apiKey; if (!key) throw new Error('Jimaku needs an API key (free at jimaku.cc)');
    const h = { Authorization: key };
    const r = await q.fetch(`${BASE}/entries/search?anilist_id=${q.anilistId}`, { headers: h }); if (!r.ok) throw new Error(`Jimaku: HTTP ${r.status}`);
    const out = [];
    for (const e of (await r.json()).slice(0, 3)) {
      const rr = await q.fetch(`${BASE}/entries/${e.id}/files${(q.animeEpisode ?? q.episode) ? `?episode=${q.animeEpisode ?? q.episode}` : ""}`, { headers: h }); if (!rr.ok) continue;
      for (const f of await rr.json()) out.push({ title: f.name, language: e.english_name && /\beng?\b|english/i.test(f.name) ? 'en' : 'ja', site: 'Jimaku', url: f.url, size: f.size, archive: /\.(zip|rar|7z)$/i.test(f.name) ? f.name.split('.').pop().toLowerCase() : undefined });
    }
    return out.filter((x) => !q.languages.length || q.languages.includes(x.language));
  },
};
