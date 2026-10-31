// SeaDex (releases.moe): the community's best releases of a show, as batches — the Hayase source interface.
const API = 'https://releases.moe/api/collections/entries/records';
async function entries(q) {
  const r = await q.fetch(`${API}?filter=alID%3D%22${q.anilistId}%22&expand=trs`); if (!r.ok) throw new Error(`SeaDex: HTTP ${r.status}`);
  const j = await r.json(); const out = [];
  for (const e of j.items || []) for (const t of e.expand?.trs || []) {
    if (!t.infoHash || t.infoHash === '<redacted>') continue;
    const size = (t.files || []).reduce((a, f) => a + (f.length || 0), 0); const name = `[${t.releaseGroup}] ${q.titles[0]}${t.dualAudio ? ' (Dual Audio)' : ''} [${t.tracker}]`;
    out.push({ title: name, link: `magnet:?xt=urn:btih:${t.infoHash}&dn=${encodeURIComponent(name)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`, hash: t.infoHash.toLowerCase(), size, seeders: 0, leechers: 0, downloads: 0, accuracy: 'high', date: new Date(t.created || Date.now()), type: t.isBest ? 'best' : 'alt' });
  }
  return out;
}
export default { async test(q) { const r = await q.fetch(`${API}?perPage=1`); return r.ok; }, single: entries, batch: entries, movie: entries };
