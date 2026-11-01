// AnimeTosho's subtitle attachments: the episode's torrents — by its AniDB episode id (from ani.zip) when known,
// else the show's AniDB id and the episode number, else the name — each torrent's files and their subtitle
// attachments, .xz files the app unpacks on download. Torrents are read a few at a time; one that fails is left out.
const FEED = 'https://feed.animetosho.org/json';
// AnimeTosho names languages with three letters (ISO 639-2).
const L = { eng: 'en', ara: 'ar', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', por: 'pt', ita: 'it', rus: 'ru', tur: 'tr', per: 'fa', fas: 'fa', ind: 'id', vie: 'vi', tha: 'th', dut: 'nl', nld: 'nl', pol: 'pl', swe: 'sv', heb: 'he', hin: 'hi', may: 'ms', msa: 'ms', gre: 'el', ell: 'el', rum: 'ro', ron: 'ro', hun: 'hu', cze: 'cs', ces: 'cs', ukr: 'uk', bul: 'bg', hrv: 'hr', srp: 'sr', dan: 'da', fin: 'fi', nor: 'no', nob: 'no', ben: 'bn', fil: 'tl', tgl: 'tl' };
const lang2 = (s) => { const x = String(s || '').toLowerCase(); return L[x] || (x.length === 2 ? x : ''); };
async function json(q, url) { const r = await q.fetch(url, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(`AnimeTosho: HTTP ${r.status}`); try { return await r.json(); } catch { throw new Error('AnimeTosho answered with a page, not data'); } }
async function eidOf(q, epn) {
  if (!q.anilistId || !epn) return 0;
  try { const r = await q.fetch(`https://api.ani.zip/mappings?anilist_id=${q.anilistId}`); if (!r.ok) return 0; const j = await r.json(); return Number(j.episodes?.[String(epn)]?.anidbEid) || 0; } catch { return 0; }
}
export default {
  async search(q) {
    if (!q.anilistId && !q.anidbAid) return [];
    const epn = q.animeEpisode ?? q.episode; const pad = epn ? String(epn).padStart(2, '0') : '';
    const eid = await eidOf(q, epn);
    let entries = [];
    if (eid) entries = await json(q, `${FEED}?eid=${eid}`);
    if (!entries.length && q.anidbAid) entries = await json(q, `${FEED}?aid=${q.anidbAid}${pad ? `&q=${encodeURIComponent(`"${pad}"`)}&qx=1` : ''}`);
    if (!entries.length) entries = await json(q, `${FEED}?q=${encodeURIComponent(`${q.title}${pad ? ` ${pad}` : ''}`)}&qx=1`);
    if (!Array.isArray(entries)) throw new Error(`AnimeTosho: ${entries?.error || 'unexpected answer'}`);
    const out = [];
    const read = async (e) => {
      let t; try { t = await json(q, `${FEED}?show=torrent&id=${e.id}`); } catch { return; }
      for (const f of t.files || []) for (const a of f.attachments || []) {
        if (a.type !== 'subtitle') continue; const lang = lang2(a.info?.lang);
        if (q.languages.length && lang && !q.languages.includes(lang)) continue;
        out.push({ title: `${f.filename}${a.info?.name ? ` · ${a.info.name}` : ''}`, language: lang || undefined, site: 'AnimeTosho', url: `https://animetosho.org/storage/attach/${Number(a.id).toString(16).padStart(8, '0')}/${a.id}.xz`, archive: 'xz', note: e.title, episode: epn || undefined });
      }
    };
    const list = entries.slice(0, 8);
    for (let i = 0; i < list.length; i += 4) await Promise.all(list.slice(i, i + 4).map(read));
    return out;
  },
};
