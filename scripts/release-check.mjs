#!/usr/bin/env node
// The release gate of the two release workflows (and of whoever releases by hand): one place that says what the
// version of an app is and whether it may be released as that version. It fails — loudly, before anything is built —
// when the two package.json files disagree, the notes file for that version is missing, empty or unfinished, or the
// version is not a plain x.y.z.
//
//   node scripts/release-check.mjs <tools|reader> [--github-output <file>]
//
// Prints the version and the tag the release will carry (tools-v<version> for Tools, v<version> for the Reader), and
// with --github-output appends «v=<version>» and «tag=<tag>» to that file (the workflows' version job).
// The same rules, run earlier on a work branch, are the preflight's «version parity» and «release notes» rows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.RELEASE_CHECK_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const app = argv.find((a) => a === 'tools' || a === 'reader');
const outIdx = argv.indexOf('--github-output');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : '';
if (!app) { console.error('usage: node scripts/release-check.mjs <tools|reader> [--github-output <file>]'); process.exit(2); }

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const problems = [];
const fail = (m) => problems.push(m);
const dir = path.join(ROOT, 'apps', app);
const pkg = readJson(path.join(dir, 'package.json'));
const desk = readJson(path.join(dir, 'desktop', 'package.json'));
const version = String(pkg.version || '');

if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`apps/${app}/package.json: version «${version}» is not x.y.z`);
if (desk.version !== pkg.version) fail(`version parity: apps/${app}/package.json says ${pkg.version}, apps/${app}/desktop/package.json says ${desk.version}`);

const notes = path.join(dir, 'docs', 'notes', `v${version}.md`);
if (!fs.existsSync(notes)) fail(`release notes: apps/${app}/docs/notes/v${version}.md is missing (the release body is taken from it; there is no fallback text)`);
else {
  const t = fs.readFileSync(notes, 'utf8');
  if (t.trim().length < 40) fail(`release notes: apps/${app}/docs/notes/v${version}.md is empty or a stub (under 40 characters)`);
  if (t.includes('«—»')) fail('release notes: contains a «—» placeholder');
  if (/\b(TODO|TBD|XXX|FIXME)\b/.test(t)) fail('release notes: contains TODO / TBD / XXX / FIXME');
  if (/<!--\s*(branch|needs)\s*:/i.test(t)) fail('release notes: still carries a «<!-- branch: … -->» dependency marker (scripts/release-prep.mjs --finish removes them)');
  if (!/^###? /m.test(t)) fail('release notes: no heading (### Fixes, ### New …) — the house style has them');
}

const tag = app === 'tools' ? `tools-v${version}` : `v${version}`;
if (problems.length) {
  for (const p of problems) console.error('::error::' + p);
  console.error(`release-check ${app}: ${problems.length} problem(s) — nothing is built`);
  process.exit(1);
}
console.log(`release-check ${app}: version ${version}, tag ${tag}, notes apps/${app}/docs/notes/v${version}.md (${fs.statSync(notes).size} bytes) — ok`);
if (outFile) fs.appendFileSync(outFile, `v=${version}\ntag=${tag}\n`);
