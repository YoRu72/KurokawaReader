// CI (tauri-check.yml, «Hand-over — the Tauri build brings it», Windows): while the Tauri build runs the handed-over
// downloads, the Electron side's own rule (desktop/ownerlock.cjs — what the bridge build runs before it resumes one)
// is asked against the REAL owner file and the REAL process: it must find them held by a live Tauri app, refuse to
// resume each handed-over id, and not take them unasked. (The released Electron build has RUST_SWITCH off, so its
// window would not ask: the rule is run here as it would.)
//   node tests/ownerprobe.cjs <Electron userData> <expected.json> <out.json>   → exit 0 when all hold, 1 otherwise
'use strict';
const fs = require('node:fs'); const path = require('node:path');
const L = require('../desktop/ownerlock.cjs');
const [dir, expFile, outFile] = process.argv.slice(2);
(async () => {
  const exp = JSON.parse(fs.readFileSync(expFile, 'utf8')); const gids = (exp.engine && exp.engine.gids) || [];
  const file = path.join(dir, L.FILE);
  // (The Tauri app writes it at its start: waited for, up to two minutes.)
  let rec = null; const until = Date.now() + 120000;
  while (Date.now() < until) { try { rec = L.parse(fs.readFileSync(file, 'utf8')); } catch { rec = null; } if (rec && rec.owner === 'tauri' && !rec.released) break; await new Promise((r) => setTimeout(r, 500)); }
  const lock = new L.OwnerLock(dir, { pause: async () => [], told: () => undefined });
  const st = rec ? lock.status(rec) : 'none';
  const refused = []; for (const g of gids) if (!(await lock.allowResume(g))) refused.push(g);
  const tookUnasked = await lock.take(false);
  const out = { record: rec && { owner: rec.owner, pid: rec.pid, ids: rec.ids, age: Date.now() - rec.heartbeat }, status: st, refused, gids, tookUnasked, pidAlive: rec ? L.pidAlive(rec.pid) : false };
  const ok = !!rec && rec.owner === 'tauri' && st === 'held' && refused.length === gids.length && gids.length > 0 && !tookUnasked;
  fs.writeFileSync(outFile, JSON.stringify({ ok, ...out }));
  console.log((ok ? 'ok   ' : 'FAIL ') + 'a second Electron, while the Tauri app runs them: ' + JSON.stringify(out));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
