// Nyaa for anime episodes (the Hayase source interface): one RSS query per title, seeders first; the app
// checks the episode numbers in the names.
const ep2 = (n) => String(n).padStart(2, '0');
const text = (xml, tag) => { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml); return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : ''; };
const toBytes = (s) => { const m = /([\d.]+)\s*(KiB|MiB|GiB|TiB|B)/i.exec(s); if (!m) return 0; return Math.round(Number(m[1]) * { b: 1, kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776 }[m[2].toLowerCase()]); };
async function rss(fetch, domain, q, cat, filter) {
  const r = await fetch(`${domain}/?page=rss&q=${encodeURIComponent(q)}&c=${cat}&f=${filter}&s=seeders&o=desc`); if (!r.ok) throw new Error(`Nyaa: HTTP ${r.status}`);
  return (await r.text()).split('<item>').slice(1).map((it) => ({ title: text(it, 'title'), link: `magnet:?xt=urn:btih:${text(it, 'nyaa:infoHash')}&dn=${encodeURIComponent(text(it, 'title'))}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`, hash: text(it, 'nyaa:infoHash').toLowerCase(), size: toBytes(text(it, 'nyaa:size')), seeders: Number(text(it, 'nyaa:seeders')) || 0, leechers: Number(text(it, 'nyaa:leechers')) || 0, downloads: Number(text(it, 'nyaa:downloads')) || 0, date: new Date(text(it, 'pubDate')), accuracy: 'low' })).filter((x) => x.hash);
}
// (All the queries in one request — Nyaa's «|» between them, each quoted —; nothing back: each on its own, all at
// once, not one after the other.)
const quoted = (s) => `"${s.replace(/["|()*]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
async function many(fetch, o, queries, cat) {
  const domain = (o.domain || 'https://nyaa.si').replace(/\/$/, ''); const seen = new Set(); const out = [];
  const take = (rows) => { for (const r of rows) if (r.hash && !seen.has(r.hash)) { seen.add(r.hash); out.push(r); } };
  if (queries.length > 1) take(await rss(fetch, domain, queries.map((q) => `(${quoted(q)})`).join('|'), cat, o.filter || '0').catch(() => []));
  if (!out.length) { const got = await Promise.allSettled(queries.map((q) => rss(fetch, domain, q, cat, o.filter || '0'))); for (const g of got) if (g.status === 'fulfilled') take(g.value); if (!out.length && got.every((g) => g.status === 'rejected')) throw got[0].reason; }
  return out.sort((a, b) => b.seeders - a.seeders);
}
const cat = (o) => (o.category || '1_2');
export default {
  async test(q) { const r = await q.fetch('https://nyaa.si/?page=rss'); return r.ok; },
  async single(q, o = {}) { const ts = q.titles.slice(0, 3); const qs = []; for (const t of ts) { qs.push(`${t} - ${ep2(q.episode)}`, `${t} ${ep2(q.episode)}`); } if (q.absoluteEpisodeNumber && q.absoluteEpisodeNumber !== q.episode) qs.push(`${ts[0]} ${ep2(q.absoluteEpisodeNumber)}`); if (o.keyword) qs.forEach((x, i) => { qs[i] = `${x} ${o.keyword}`; }); return many(q.fetch, o, [...new Set(qs)], cat(o)); },
  async batch(q, o = {}) { const ts = q.titles.slice(0, 2); const qs = ts.flatMap((t) => [`${t} batch`, `${t} complete`, `${t} season`]); return (await many(q.fetch, o, qs, cat(o))).map((r) => ({ ...r, type: 'batch' })); },
  async movie(q, o = {}) { return many(q.fetch, o, q.titles.slice(0, 3), cat(o)); },
};
