// SubSource: the title found by name (the closest by title and year, a show's season picked), its subtitles in
// each wanted language, and — when one is tapped — its download token asked for. This is the site's own open
// API, so no key is needed.
const NAMES = { en: 'english', ar: 'arabic', ja: 'japanese', ko: 'korean', zh: 'chinese_simplified,chinese_traditional,chinese_bg_code', fr: 'french', de: 'german', es: 'spanish', pt: 'portuguese', it: 'italian', ru: 'russian', tr: 'turkish', fa: 'farsi_persian', id: 'indonesian', vi: 'vietnamese', th: 'thai', nl: 'dutch', pl: 'polish', sv: 'swedish', he: 'hebrew', hi: 'hindi', ms: 'malay', el: 'greek', ro: 'romanian', hu: 'hungarian', cs: 'czech', uk: 'ukrainian', bg: 'bulgarian', hr: 'croatian', sr: 'serbian', da: 'danish', fi: 'finnish', no: 'norwegian', bn: 'bengali' };
const CODES = Object.fromEntries(Object.entries(NAMES).flatMap(([k, v]) => v.split(',').map((n) => [n, k])));
const API = 'https://api.subsource.net/v1';
const unesc = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const epOf = (s) => { const m = /\bS(\d{1,2})\s*E(\d{1,4})\b/i.exec(s) || /\b(?:E|EP|Episode)\s*(\d{1,4})\b/i.exec(s) || /\s-\s(\d{1,4})(?:v\d)?\b/.exec(s); return m ? Number(m[m.length - 1]) : undefined; };
export default {
  async search(q) {
    const r = await q.fetch(`${API}/movie/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query: q.title, includeSeasons: true, limit: 15 }) });
    if (!r.ok) throw new Error(`SubSource: HTTP ${r.status}`);
    const j = await r.json(); const hits = j.results || [];
    const titles = new Set([q.title, ...(q.titles || [])].map(norm));
    const want = q.kind === 'movie' ? 'movie' : 'tvseries';
    const score = (m) => (titles.has(norm(m.title)) ? 4 : 0) + (m.type === want ? 2 : 0) + (q.year && m.releaseYear === q.year ? 2 : q.year && Math.abs((m.releaseYear || 0) - q.year) <= 1 ? 1 : 0);
    const best = hits.map((m) => ({ m, s: score(m) })).filter((x) => x.s >= 4).sort((a, b) => b.s - a.s)[0]?.m; if (!best) return [];
    const slug = String(best.link || '').replace(/^\/(series|subtitles)\//, '').split('/')[0]; if (!slug) return [];
    const path = best.type === 'tvseries' ? `${slug}/season-${q.season || 1}` : slug;
    const p = new URLSearchParams(); p.set('language', q.languages.map((l) => NAMES[l] || l).join(','));
    const rr = await q.fetch(`${API}/subtitles/${path}?${p}`, { headers: { Accept: 'application/json' } }); if (!rr.ok) throw new Error(`SubSource: HTTP ${rr.status}`);
    const list = (await rr.json()).subtitles || [];
    return list.map((s) => { const info = unesc(s.release_info || best.title); const ep = epOf(info); return { title: info, language: CODES[s.language] || String(s.language || '').slice(0, 2), site: 'SubSource', hi: !!s.hearing_impaired, page: `https://subsource.net/subtitle/${s.link}`, episode: ep, season: ep ? q.season : undefined, note: s.caption ? unesc(s.caption).split(/\r?\n/)[0].trim().slice(0, 120) || undefined : undefined, archive: 'zip', resolve: { link: s.link } }; });
  },
  /** The download link: the subtitle's details carry a token for it. */
  async resolve(res, q) {
    const r = await q.fetch(`${API}/subtitle/${res.resolve.link}`, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(`SubSource: HTTP ${r.status}`);
    const tok = (await r.json()).subtitle?.download_token; if (!tok) throw new Error('SubSource: no download');
    return { url: `${API}/subtitle/download/${tok}`, name: `${res.title}.zip` };
  },
};
