// The Reader's engine test results (written by the shared crate's selftest.rs for src-tauri/src/enginetest.rs) as
// Markdown, for CI's step summary and the workflow's artifact: node enginetest-report.cjs <results.json> <exit code>
// <label> [<out.md>]. Prints the report (and writes it to <out.md> when given). Always exits 0 — the workflow step
// exits with the app's own code.
'use strict';
const fs = require('node:fs');

const [file, codeText, label, outMd] = process.argv.slice(2);
const code = Number(codeText);
const MEANING = { 0: 'passed', 1: 'a required check failed', 2: 'watchdog: no verdict in time', 124: 'killed by timeout', 142: 'killed by timeout' };
const CASES = { run: 'run', env: '1 environment', storage: '2 storage', storage2: '2 storage (after a reload)', epub: '3 EPUB and Arabic', arui: '3 Arabic interface', text: '4 text book', pdf: '5 PDF', convert: '6 converter', speech: '7 read-aloud', window: '8 full screen, printing, drag and drop', fonts: '9 fonts', page: 'page errors (reported)' };
let doc = null;
try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { doc = null; }
const cell = (s) => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const out = [];
out.push(`### ${label || 'Tauri'} — engine test: ${code === 0 ? 'passed' : 'FAILED'} (exit ${codeText}${MEANING[code] ? `, ${MEANING[code]}` : ''})`);
out.push('');
if (!doc) {
  out.push(`No results file (${cell(file)}): the app did not get as far as writing one.`);
} else {
  if (doc.note) out.push(`Note: ${cell(doc.note)}`, '');
  const rows = Array.isArray(doc.results) ? doc.results : [];
  const req = rows.filter((r) => r.required !== false);
  out.push(`${cell(doc.os)}/${cell(doc.arch)}, written with code ${cell(doc.code)}: ${rows.length} checks, ${req.filter((r) => r.ok).length}/${req.length} required passed, ${rows.filter((r) => r.required === false && !r.ok).length} reported failures.`, '');
  const env = rows.find((r) => r.case === 'env' && r.name === 'engine');
  if (env) { try { const e = JSON.parse(env.detail); out.push(`Engine: **${cell(e.engine)}** · ${cell(e.ua)} · DPR ${cell(e.dpr)} · deviceMemory ${cell(e.deviceMemory)} · screen ${cell(e.screen)} · window ${cell(e.window)} · origin ${cell(e.origin)}`, ''); } catch (x) { /* detail cut short */ } }
  out.push('| Case | Check | Result | Required | Time | Detail |', '|---|---|---|---|---:|---|');
  const order = Object.keys(CASES);
  const sorted = rows.slice().sort((a, b) => (order.indexOf(a.case) + 100) % 100 - (order.indexOf(b.case) + 100) % 100);
  for (const r of sorted) out.push(`| ${cell(CASES[r.case] || r.case)} | ${cell(r.name)} | ${r.ok ? 'ok' : '**FAIL**'} | ${r.required === false ? 'no' : 'yes'} | ${r.ms == null ? '' : `${(r.ms / 1000).toFixed(1)} s`} | ${cell(r.detail)} |`);
  if (!rows.length) out.push('| (none) | | | | | |');
}
out.push('');
const text = out.join('\n');
console.log(text);
if (outMd) { try { fs.writeFileSync(outMd, text + '\n'); } catch (e) { console.log(`(could not write ${outMd}: ${e.message})`); } }
