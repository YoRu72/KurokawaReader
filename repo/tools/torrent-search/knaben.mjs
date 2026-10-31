// Knaben (knaben.org) — one search across many public trackers (The Pirate Bay, 1337x, Nyaa, RARBG's heirs and
// more), through its API. search(query, { fetch, settings }) → results.
export const settings = [{ id: 'size', label: 'Results', type: 'number', value: 60 }, { id: 'hideXxx', label: 'Hide adult results', type: 'toggle', value: true }];
export async function search(query, ctx) {
  const cfg = ctx.settings || {};
  const r = await ctx.fetch('https://api.knaben.org/v1', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ search_type: '100%', search_field: 'title', query, order_by: 'seeders', order_direction: 'desc', from: 0, size: Math.min(150, Number(cfg.size) || 60), hide_unsafe: true, hide_xxx: cfg.hideXxx !== false }) });
  if (!r.ok) throw new Error(`Knaben: HTTP ${r.status}`);
  const j = await r.json();
  return (j.hits || []).map((x) => {
    const hash = (x.hash || '').toLowerCase();
    const magnet = x.magnetUrl || (hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(x.title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce` : undefined);
    return { title: x.title, source: 'knaben', magnet, url: magnet ? undefined : x.link, size: Number(x.bytes) || undefined, seeds: Number(x.seeders) || 0, peers: Number(x.peers) || 0, date: [x.tracker, (x.date || '').slice(0, 10)].filter(Boolean).join(' '), link: x.details, quality: /\b(2160p|1080p|720p|480p)\b/i.exec(x.title)?.[1] };
  }).filter((x) => x.magnet || x.url);
}
