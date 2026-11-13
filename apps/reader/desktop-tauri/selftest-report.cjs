// The Reader's runtime self-test results (written by the shared crate's selftest.rs, for src-tauri/src/selftest.rs)
// as a Markdown table, for CI's step summary: node selftest-report.cjs <results.json> <exit code> <label>. Always
// exits 0 — the workflow step exits with the app's own code.
'use strict';
const fs = require('node:fs');

const [file, codeText, label] = process.argv.slice(2);
const code = Number(codeText);
const MEANING = { 0: 'passed', 1: 'a required check failed', 2: 'watchdog: no verdict in time', 124: 'killed by timeout', 142: 'killed by timeout' };
let doc = null;
try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { doc = null; }
const cell = (s) => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const out = [];
out.push(`### ${label || 'Tauri'} — runtime self-test: ${code === 0 ? 'passed' : 'FAILED'} (exit ${codeText}${MEANING[code] ? `, ${MEANING[code]}` : ''})`);
out.push('');
if (!doc) {
  out.push(`No results file (${cell(file)}): the app did not get as far as writing one.`);
} else {
  if (doc.note) out.push(`Note: ${cell(doc.note)}`, '');
  out.push(`${cell(doc.os)}/${cell(doc.arch)}, written with code ${cell(doc.code)}.`, '');
  const rows = Array.isArray(doc.results) ? doc.results : [];
  out.push('| Check | Result | Required | Detail |', '|---|---|---|---|');
  for (const r of rows) out.push(`| ${cell(r.name)} | ${r.ok ? 'ok' : 'FAIL'} | ${r.required === false ? 'no' : 'yes'} | ${cell(r.detail)} |`);
  if (!rows.length) out.push('| (none) | | | |');
}
out.push('');
console.log(out.join('\n'));
