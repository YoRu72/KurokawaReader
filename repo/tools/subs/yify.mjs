// YIFY Subtitles (yifysubtitles.ch): films by IMDb id; the page scraped; no key needed.
const BASE = 'https://yifysubtitles.ch';
const NAMES = { english: 'en', arabic: 'ar', japanese: 'ja', korean: 'ko', chinese: 'zh', french: 'fr', german: 'de', spanish: 'es', portuguese: 'pt', 'brazilian-portuguese': 'pt', italian: 'it', russian: 'ru', turkish: 'tr', farsi: 'fa', persian: 'fa', indonesian: 'id', vietnamese: 'vi', thai: 'th', dutch: 'nl', polish: 'pl', swedish: 'sv', hebrew: 'he', hindi: 'hi', malay: 'ms', greek: 'el', romanian: 'ro', hungarian: 'hu', czech: 'cs', ukrainian: 'uk', bulgarian: 'bg', croatian: 'hr', serbian: 'sr', danish: 'da', finnish: 'fi', norwegian: 'no', bengali: 'bn' };
export default {
  async search(q) {
    if (q.kind !== 'movie' || !q.imdbId) return [];
    const r = await q.fetch(`${BASE}/movie-imdb/${q.imdbId}`); if (!r.ok) { if (r.status === 404) return []; throw new Error(`YIFY: HTTP ${r.status}`); }
    const d = new DOMParser().parseFromString(await r.text(), 'text/html'); const out = [];
    for (const row of Array.from(d.querySelectorAll('table tbody tr'))) {
      const a = row.querySelector('a[href^="/subtitles/"]'); if (!a) continue; const langName = (row.querySelector('.sub-lang')?.textContent || '').trim().toLowerCase(); const lang = NAMES[langName] || langName.slice(0, 2);
      if (q.languages.length && !q.languages.includes(lang)) continue;
      const slug = a.getAttribute('href').replace(/^\/subtitles\//, '');
      out.push({ title: a.textContent.replace(/^subtitle\s*/i, '').trim(), language: lang, site: 'YIFY', hi: !!row.querySelector('.hi-subtitle'), page: `${BASE}${a.getAttribute('href')}`, url: `${BASE}/subtitle/${slug}.zip`, archive: 'zip', rating: Number(row.querySelector('.rating-cell')?.textContent) || undefined });
    }
    return out;
  },
};
