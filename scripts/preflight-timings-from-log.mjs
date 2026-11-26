#!/usr/bin/env node
// Seeds scripts/preflight.timings.json from the text of finished preflight runs (the «PASS  test x.cjs  (n/N)  — 9.2s»
// lines of a GitHub Actions log or of a local run). Plain Node. Later log files win over earlier ones; a time from a
// passing run wins over one from a failing or timed-out run. A test the config splits into parts («parts» in
// scripts/preflight.config.json, e.g. uihunt.cjs -> en / ar) that the log ran whole gets its time shared by the parts.
//
//   node scripts/preflight-timings-from-log.mjs <tools|reader> <log> [<log> ...]
//
// After this, the normal way to keep the file true is a full run's --json files:
//   node scripts/preflight.mjs --write-timings <file-or-folder>[,<more>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'scripts/preflight.timings.json');
const [app, ...logs] = process.argv.slice(2);
if (!['tools', 'reader'].includes(app) || !logs.length) { console.error('usage: node scripts/preflight-timings-from-log.mjs <tools|reader> <log> [<log> ...]'); process.exit(2); }

const LINE = /^\S*\s+(PASS|FAIL|FLAKY|WARN|KNOWN|FIXED)\s+test (.+?)\s+\((\d+)\/(\d+)\)\s+— (.*)$/;
// rank: 3 = a clean pass, 2 = a failure that ended on its own, 1 = a timeout (only a lower bound)
const parse = (status, detail) => {
  let m;
  if (['PASS', 'WARN', 'FIXED'].includes(status) && (m = detail.match(/^([\d.]+)s$/))) return { sec: +m[1], rank: 3 };
  if (status === 'FAIL' && (m = detail.match(/^timed out after (\d+)s/))) return { sec: +m[1], rank: 1 };
  if (status === 'FAIL' && (m = detail.match(/after ([\d.]+)s/))) return { sec: +m[1], rank: 2 };
  return null;
};
const got = new Map(); // label -> {sec, rank}
for (const log of logs) {
  for (const raw of fs.readFileSync(log, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = raw.replace(/\x1b\[[0-9;]*m/g, '').match(LINE); if (!m) continue;
    const t = parse(m[1], m[5].trim()); if (!t) continue;
    const label = m[2].trim().replace(/\s+/g, ' ');
    const old = got.get(label);
    if (!old || t.rank >= old.rank) got.set(label, t);
  }
}
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/preflight.config.json'), 'utf8'));
const parts = (cfg[app] && cfg[app].parts) || {};
const t = (doc[app] = doc[app] || {}); let n = 0;
for (const [label, v] of got) {
  const sec = Math.max(1, Math.round(v.sec));
  if (parts[label]) { for (const a of parts[label]) { t[`${label} ${a.join(' ')}`] = Math.max(1, Math.round(sec / parts[label].length)); n++; } continue; }
  t[label] = sec; n++;
}
doc[app] = Object.fromEntries(Object.entries(t).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
console.log(`${app}: ${got.size} test(s) read from ${logs.length} log(s); ${n} timing(s) written to ${path.relative(ROOT, FILE)}`);
