#!/usr/bin/env node
// node scripts/release-prep-headings.test.mjs — release-prep.mjs --finish / --drop and the headings of the notes: a «## New»
// followed directly by «###» sub-headings is not an empty section; a really empty one still goes (also one that only holds empty
// sub-headings); the headings that stay are printed before anything is written. A made-up app tree in a temp folder, built from a
// copy of apps/reader/docs/notes/v0.67.0.md; nothing in the repository changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra ?? ''))); if (!cond) fails++; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-headings-'));
const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const r = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const prep = (...args) => { const x = spawnSync(process.execPath, [path.join(HERE, 'release-prep.mjs'), 'reader', '0.67.0', ...args], { env: { ...process.env, RELEASE_PREP_ROOT: root }, encoding: 'utf8' }); return { code: x.status, out: x.stdout + x.stderr }; };
const NOTES = 'apps/reader/docs/notes/v0.67.0.md';
w('apps/reader/package.json', '{ "name": "r", "version": "0.67.0" }\n');
w('apps/reader/desktop/package.json', '{ "name": "d", "version": "0.67.0" }\n');

// 1. the real notes file reshaped: «## New» directly followed by «###» sub-headings
const real = fs.readFileSync(path.join(REPO, NOTES), 'utf8');
let shaped = real.replace(/^## New: /gm, '### ');
shaped = shaped.replace(/^### /m, '## New\n### '); // «## New» before the first sub-heading, nothing between
shaped = shaped.replace(/^(- .*)$/m, '$1 <!-- branch: work-kept -->'); // one marker, to be finished off
const heads = (t) => t.split('\n').filter((l) => /^#{1,6}\s/.test(l));
w(NOTES, shaped);
ok('the made-up shape has «## New» then «###» straight after', /^## New\n### /m.test(shaped));
let x = prep('--write', '--finish');
ok('--finish exits 0', x.code === 0, x);
ok('«## New» stays', /^## New$/m.test(r(NOTES)), x.out);
ok('no «empty section removed» for it', !/empty section removed: ## New/.test(x.out), x.out);
ok('every heading of the notes is still there', JSON.stringify(heads(r(NOTES))) === JSON.stringify(heads(shaped)), [heads(r(NOTES)), heads(shaped)]);
ok('the markers are gone, nothing else changed', r(NOTES) === shaped.replace(/\s*<!--\s*branch\s*:[^>]*-->/g, ''));
ok('it prints the headings it keeps', /headings kept \(\d+\):.*## New/.test(x.out), x.out);

// 2. a really empty section still goes, also one that only holds empty sub-headings
w(NOTES, '## Fixed\n- **A line long enough to pass the length rule of the check.**\n\n## Empty\n\n## Holds only empty ones\n### Nothing here\n\n### Nor here\n\n## New\n### Real\n- **Text under a sub-heading.**\n');
x = prep('--write', '--finish');
const after = r(NOTES);
ok('an empty «## Empty» is removed', !/## Empty/.test(after) && /empty section removed: ## Empty/.test(x.out), x.out);
ok('a section holding only empty sub-headings is removed with them', !/Holds only empty ones|Nothing here|Nor here/.test(after), after);
ok('«## New» with a real sub-heading stays', /## New\n### Real\n- \*\*Text/.test(after), after);
ok('«## Fixed» stays', /^## Fixed$/m.test(after));

// 3. --drop of a tagged section is explicit; the rest stays and the kept headings are printed
w(NOTES, '## Fixed\n- **A line long enough to pass the length rule of the check.**\n\n## New: Gone <!-- branch: work-gone -->\n- **Dropped with its heading.**\n\n## New: Stays\n- **Stays.**\n');
x = prep('--write', '--drop', 'work-gone', '--finish');
ok('--drop removes the tagged section, keeps the other', x.code === 0 && !/Gone|Dropped/.test(r(NOTES)) && /## New: Stays\n- \*\*Stays/.test(r(NOTES)), x);
ok('the dry run prints the kept headings and writes nothing', (() => { w(NOTES, '## A\n- text\n'); const y = prep('--finish'); return y.code === 0 && /headings kept \(1\): ## A/.test(y.out) && r(NOTES) === '## A\n- text\n' && /dry run/.test(y.out); })());

fs.rmSync(root, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
