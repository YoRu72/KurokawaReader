// Subf2m (subf2m.co): the title searched (a name or an IMDb id), the title's page per language scraped; the
// download link is read from each subtitle's page when tapped. The site sits behind Cloudflare and may refuse.
const BASE = 'https://subf2m.co';
const PATHS = { en: 'english', ar: 'arabic', ja: 'japanese', ko: 'korean', zh: 'chinese_bg_code', fr: 'french', de: 'german', es: 'spanish', pt: 'portuguese', it: 'italian', ru: 'russian', tr: 'turkish', fa: 'farsi_persian', id: 'indonesian', vi: 'vietnamese', th: 'thai', nl: 'dutch', pl: 'polish', sv: 'swedish', he: 'hebrew', hi: 'hindi', ms: 'malay', el: 'greek', ro: 'romanian', hu: 'hungarian', cs: 'czech', uk: 'ukrainian', bg: 'bulgarian', hr: 'croatian', sr: 'serbian', da: 'danish', fi: 'finnish', no: 'norwegian', bn: 'big 5 code' };
const doc = (html) => new DOMParser().parseFromString(html, 'text/html');
const ord = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth'];
export default {
  async search(q) {
    const r = await q.fetch(`${BASE}/subtitles/searchbytitle?query=${encodeURIComponent(q.imdbId || q.title)}&l=`); if (!r.ok) throw new Error(`Subf2m: HTTP ${r.status}${r.status === 403 ? ' (Cloudflare)' : ''}`);
    const d = doc(await r.text()); let links = Array.from(d.querySelectorAll('li div.title a')).map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim() })).filter((x) => x.href);
    if (q.kind !== 'movie' && q.season) { const want = links.filter((x) => new RegExp(`\\b(${ord[q.season] || 'zz'} Season|Season ${q.season}\\b|S${String(q.season).padStart(2, '0')})`, 'i').test(x.text)); if (want.length) links = want; }
    const out = [];
    for (const l of links.slice(0, 2)) for (const lang of q.languages) {
      const rr = await q.fetch(`${BASE}${l.href}/${PATHS[lang] || lang}`); if (!rr.ok) continue; const dd = doc(await rr.text());
      for (const item of Array.from(dd.querySelectorAll('li.item'))) {
        const rel = Array.from(item.querySelectorAll('ul.scrolllist li')).map((x) => x.textContent.trim()).filter(Boolean); const a = item.querySelector('a.download');
        if (!a || !rel.length) continue; const text = rel.join(' ');
        if (q.episode) { const m = /S(\d{1,2})E(\d{1,3})/i.exec(text) || /\b-\s*(\d{1,3})\b/.exec(text); if (m && Number(m[2] ?? m[1]) !== q.episode && !/complete|season|batch/i.test(text)) continue; }
        out.push({ title: rel[0], note: rel.slice(1, 4).join(' / ') || undefined, language: lang, site: 'Subf2m', hi: !!item.querySelector('.hi'), page: `${BASE}${a.getAttribute('href')}`, resolve: { page: `${BASE}${a.getAttribute('href')}` }, archive: 'zip' });
      }
    }
    return out;
  },
  async resolve(res, q) { const r = await q.fetch(res.resolve.page); if (!r.ok) throw new Error(`Subf2m: HTTP ${r.status}`); const a = doc(await r.text()).querySelector('a#downloadButton'); if (!a) throw new Error('Subf2m: no download button'); return { url: `${BASE}${a.getAttribute('href')}` }; },
};
