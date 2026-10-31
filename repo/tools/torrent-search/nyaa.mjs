// Nyaa (nyaa.si) — anime torrents, through its RSS feed. search(query, { fetch }) → results.
const SITE = 'https://nyaa.si';
const text = (xml, tag) => { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml); return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : ''; };
const size = (s) => { const m = /([\d.]+)\s*(KiB|MiB|GiB|TiB|B)/i.exec(s); if (!m) return undefined; const mul = { b: 1, kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776 }[m[2].toLowerCase()]; return Math.round(Number(m[1]) * mul); };
export async function search(query, ctx) {
  const r = await ctx.fetch(`${SITE}/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0&s=seeders&o=desc`);
  if (!r.ok) throw new Error(`Nyaa: HTTP ${r.status}`);
  const xml = await r.text();
  const items = xml.split('<item>').slice(1);
  return items.map((it) => {
    const title = text(it, 'title'); const hash = text(it, 'nyaa:infoHash'); const torrent = text(it, 'link');
    return { title, source: 'nyaa', magnet: hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce` : undefined, url: hash ? undefined : torrent, size: size(text(it, 'nyaa:size')), seeds: Number(text(it, 'nyaa:seeders')) || 0, peers: Number(text(it, 'nyaa:leechers')) || 0, date: text(it, 'pubDate').slice(5, 16), link: text(it, 'guid'), quality: /\b(2160p|1080p|720p|480p)\b/i.exec(title)?.[1] };
  }).filter((x) => x.title);
}
