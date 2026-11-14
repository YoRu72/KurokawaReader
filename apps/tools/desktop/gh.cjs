// GitHub's API for the shell (yt-dlp's and gallery-dl's newest releases, this app's releases): every call with a time
// limit, the answer kept ten minutes in memory, and asked again conditionally — the ETag of the last answer sent as
// If-None-Match, so an unchanged list costs a 304 (no body, and no count against GitHub's hourly limit) — the bodies
// kept in the app's data folder (gh-cache.json, the last 20 addresses).
'use strict';
const { app, net } = require('electron'); const fs = require('node:fs'); const path = require('node:path');
const TTL = 10 * 60 * 1000; const mem = new Map(); let disk = null;
const file = () => path.join(app.getPath('userData'), 'gh-cache.json');
const load = () => { if (disk) return disk; try { disk = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { disk = {}; } return disk; };
const save = () => { try { const keys = Object.keys(disk).sort((a, b) => (disk[b].at || 0) - (disk[a].at || 0)).slice(0, 20); const out = {}; for (const k of keys) out[k] = disk[k]; disk = out; fs.writeFileSync(file(), JSON.stringify(out)); } catch { /* not kept */ } };
/** The JSON at a GitHub API address: from memory within ten minutes, else asked (conditionally when an ETag is kept). */
async function ghJson(url, o = {}) {
  const hit = mem.get(url); if (hit && Date.now() - hit.at < (o.ttl ?? TTL)) return hit.json;
  const d = load(); const kept = d[url];
  const headers = { accept: 'application/vnd.github+json', ...(kept && kept.etag ? { 'if-none-match': kept.etag } : {}) };
  const r = await net.fetch(url, { headers, signal: AbortSignal.timeout(o.timeoutMs ?? 15000) });
  let json;
  if (r.status === 304 && kept) json = kept.json;
  else { if (!r.ok) throw new Error('HTTP ' + r.status); json = await r.json(); const etag = r.headers && r.headers.get ? r.headers.get('etag') : null; if (etag) { d[url] = { etag, json, at: Date.now() }; save(); } }
  mem.set(url, { at: Date.now(), json }); return json;
}
/** Forget the memory copy (a forced check). */
function forget(url) { if (url) mem.delete(url); else mem.clear(); }
module.exports = { ghJson, forget };
