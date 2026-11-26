#!/usr/bin/env node
// The one result of a sharded Preflight. Reads the --json files of every shard (a folder, searched recursively, as
// actions/download-artifact leaves them), merges them and prints ONE markdown table: every FAIL, KNOWN, FIXED, FLAKY and
// WARN row and the INFO rows that say how the tests were chosen, each with its app and shard. Exits 1 when any row is a
// FAIL, or when an expected shard left no result (a cancelled, crashed or timed-out shard job must not pass quietly).
// Plain Node, no dependencies.
//
//   node scripts/preflight-verdict.mjs <folder> [--expect '<json list of {app,shard,of}>'] [--title <text>]
//
// (preflight.yml pipes the output into $GITHUB_STEP_SUMMARY and the log; the exit code is the verdict job's result.)
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--expect' && argv[argv.indexOf(a) - 1] !== '--title');
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (!dir) { console.error("usage: node scripts/preflight-verdict.mjs <folder> [--expect '<json>'] [--title <text>]"); process.exit(2); }

const files = []; const walk = (p) => { let st; try { st = fs.statSync(p); } catch { return; } if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f)); else if (p.endsWith('.json')) files.push(p); };
walk(dir);
let expect = []; try { expect = JSON.parse(opt('--expect') || '[]'); } catch { console.error('--expect is not JSON'); process.exit(2); }

const seen = new Set(); const rows = []; const counts = {}; const modes = [];
for (const f of files) {
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { rows.push({ app: '?', shard: path.basename(f), status: 'FAIL', step: 'result file', detail: 'is not readable JSON' }); continue; }
  const shard = j.shard ? `${j.shard.i}/${j.shard.n}` : '1/1';
  for (const r of j.results || []) {
    seen.add(`${r.app} ${shard}`);
    for (const x of r.rows || []) {
      counts[r.app] = counts[r.app] || {}; counts[r.app][x.status] = (counts[r.app][x.status] || 0) + 1;
      if (['FAIL', 'KNOWN', 'FIXED', 'FLAKY', 'WARN', 'INFO'].includes(x.status)) rows.push({ app: r.app, shard, status: x.status, step: x.step, detail: x.detail || '' });
    }
  }
}
for (const e of expect) if (!seen.has(`${e.app} ${e.shard}/${e.of}`)) rows.push({ app: e.app, shard: `${e.shard}/${e.of}`, status: 'FAIL', step: 'shard result', detail: 'this shard left no result file: its job was cancelled, crashed or timed out (see its log)' });

// INFO rows say how the tests were chosen: keep one per app and distinct text, shard 1's wording first
const order = { FAIL: 0, FLAKY: 1, KNOWN: 2, FIXED: 3, WARN: 4, INFO: 5 };
const keepInfo = new Set(); const out = rows.filter((r) => { if (r.status !== 'INFO') return true; const k = r.app + r.detail.split('; shard ')[0]; if (keepInfo.has(k)) return false; keepInfo.add(k); return true; });
out.sort((a, b) => order[a.status] - order[b.status] || a.app.localeCompare(b.app) || a.shard.localeCompare(b.shard, undefined, { numeric: true }));
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, 300);
const fails = out.filter((r) => r.status === 'FAIL').length;
const lines = [];
lines.push(`### ${opt('--title') || 'Preflight verdict'}: ${fails ? `FAILED (${fails} new failure${fails > 1 ? 's' : ''})` : 'passed'}`);
lines.push('');
for (const [app, c] of Object.entries(counts)) lines.push(`- **${app}**: ` + ['FAIL', 'FLAKY', 'KNOWN', 'FIXED', 'WARN', 'SKIP', 'PASS'].filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(', '));
if (out.length) { lines.push('', '| App | Shard | Result | Step | Detail |', '|---|---|---|---|---|'); for (const r of out) lines.push(`| ${r.app} | ${r.shard} | ${r.status} | ${cell(r.step)} | ${cell(r.detail)} |`); }
else lines.push('', '(no rows to show: nothing failed, nothing was flaky, known or worth a warning)');
console.log(lines.join('\n'));
process.exit(fails ? 1 : 0);
