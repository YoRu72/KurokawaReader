// Nyaa (nyaa.si) — anime (and more) torrents, through its RSS feed. search(query, { fetch, settings, title }) → results.
// A picked work is asked for by all its names at once (Nyaa's «|» between quoted names, one request), its episode
// with them; anime is looked for in the anime category; a mirror, the category and the filter are its settings.
const TR = ['http://nyaa.tracker.wf:7777/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.opentrackr.org:1337/announce', 'udp://exodus.desync.com:6969/announce'].map((x) => `&tr=${encodeURIComponent(x)}`).join('');
const text = (xml, tag) => { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml); return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : ''; };
const size = (s) => { const m = /([\d.]+)\s*(KiB|MiB|GiB|TiB|B)/i.exec(s); if (!m) return undefined; return Math.round(Number(m[1]) * { b: 1, kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776 }[m[2].toLowerCase()]); };
const ep2 = (n) => String(n).padStart(2, '0');
// (A name as Nyaa matches it: quoted, the characters its search treats as operators dropped.)
const quoted = (s) => `"${s.replace(/["|()*-]/g, ' ').replace(/\s+/g, ' ').trim()}"`;

function queryOf(query, t) {
  if (!t || !(t.titles?.length || t.title)) return query;
  const names = [...new Set([t.title, ...(t.titles || [])].filter((x) => x && /[\p{L}\p{N}]/u.test(x)))].slice(0, 4);
  const ep = t.kind !== 'movie' && t.episode ? t.episode : undefined;
  const parts = names.flatMap((n) => (ep ? [`${quoted(n)} ${ep2(ep)}`] : [quoted(n)]));
  return parts.length > 1 ? parts.map((p) => `(${p})`).join('|') : parts[0] || query;
}

async function rss(ctx, base, q, cat, filter) {
  const r = await ctx.fetch(`${base}/?page=rss&q=${encodeURIComponent(q)}&c=${cat}&f=${filter}&s=seeders&o=desc`);
  if (!r.ok) throw new Error(`Nyaa: HTTP ${r.status}`);
  return (await r.text()).split('<item>').slice(1).map((it) => {
    const title = text(it, 'title'); const hash = text(it, 'nyaa:infoHash').toLowerCase(); const page = text(it, 'guid');
    const flags = [text(it, 'nyaa:trusted') === 'Yes' ? 'trusted' : '', text(it, 'nyaa:remake') === 'Yes' ? 'remake' : ''].filter(Boolean);
    const when = Date.parse(text(it, 'pubDate'));
    return {
      title, source: 'nyaa', magnet: hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${TR}` : undefined, url: hash ? undefined : text(it, 'link'),
      size: size(text(it, 'nyaa:size')), seeds: Number(text(it, 'nyaa:seeders')) || 0, peers: Number(text(it, 'nyaa:leechers')) || 0,
      date: [isFinite(when) ? new Date(when).toISOString().slice(0, 10) : '', text(it, 'nyaa:category'), ...flags].filter(Boolean).join(' · '), link: page || undefined,
      quality: /\b(2160p|1080p|720p|480p)\b/i.exec(title)?.[1],
    };
  }).filter((x) => x.title && (x.magnet || x.url));
}

export async function search(query, ctx) {
  const cfg = ctx.settings || {}; const t = ctx.title;
  const base = String(cfg.domain || 'https://nyaa.si').replace(/\/+$/, '');
  const cat = !cfg.category || cfg.category === 'auto' ? (t?.kind === 'anime' ? '1_0' : '0_0') : cfg.category;
  const filter = String(cfg.filter ?? '0');
  const q = queryOf(query, t);
  // (The names all at once first; nothing back — a name Nyaa spells otherwise —: what was typed, as it is.)
  const rows = await rss(ctx, base, q, cat, filter);
  if (rows.length || q === query) return rows;
  return rss(ctx, base, query, cat, filter);
}
