#!/usr/bin/env node
// node scripts/release-prep.test.mjs — release-prep.mjs and release-check.mjs on a made-up app tree in a temp folder
// (RELEASE_PREP_ROOT / RELEASE_CHECK_ROOT): dry run writes nothing; --write bumps both version fields and makes the
// notes from the template; the template is refused by the release check; --drop / --finish take out the lines of a
// branch that is not in the release; going backwards, a split version and a Tauri config with its own version are
// refused. No network, no repository files touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra ?? ''))); if (!cond) fails++; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-relprep-'));
const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const r = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const run = (script, ...args) => { const x = spawnSync(process.execPath, [path.join(HERE, script), ...args], { env: { ...process.env, RELEASE_PREP_ROOT: root, RELEASE_CHECK_ROOT: root }, encoding: 'utf8' }); return { code: x.status, out: x.stdout + x.stderr }; };

w('apps/tools/package.json', '{\n  "name": "kurokawa-tools",\n  "version": "0.20.0",\n  "scripts": { "build": "x", "version": "keep" }\n}\n');
w('apps/tools/desktop/package.json', '{\n  "name": "d",\n  "version": "0.20.0"\n}\n');
w('apps/tools/desktop-tauri/src-tauri/tauri.conf.json', '{\n  "version": "../../package.json"\n}\n');
w('apps/tools/docs/notes/v0.20.0.md', '### Fixes\n- **Old note that is long enough to pass the length rule of the check.**\n');

// 1. dry run
let x = run('release-prep.mjs', 'tools', '0.21.0');
ok('dry run exits 0 and says so', x.code === 0 && /dry run: nothing written/.test(x.out), x);
ok('dry run wrote nothing', /"version": "0.20.0"/.test(r('apps/tools/package.json')) && !fs.existsSync(path.join(root, 'apps/tools/docs/notes/v0.21.0.md')));
ok('dry run names both version fields and the notes file', /package\.json: "version" 0\.20\.0 -> 0\.21\.0/.test(x.out) && /desktop\/package\.json/.test(x.out) && /create apps\/tools\/docs\/notes\/v0\.21\.0\.md/.test(x.out), x.out);

// 2. write
x = run('release-prep.mjs', 'tools', '0.21.0', '--write');
ok('--write exits 0', x.code === 0, x);
ok('both version fields bumped, nothing else touched', /"version": "0\.21\.0"/.test(r('apps/tools/package.json')) && /"version": "0\.21\.0"/.test(r('apps/tools/desktop/package.json')) && /"version": "keep"/.test(r('apps/tools/package.json')) && r('apps/tools/package.json').includes('"name": "kurokawa-tools"'));
ok('notes made from the template', /### Fixes/.test(r('apps/tools/docs/notes/v0.21.0.md')) && r('apps/tools/docs/notes/v0.21.0.md').includes('«—»'));
ok('it tells what is left to do', /placeholders/.test(x.out), x.out);
x = run('release-check.mjs', 'tools');
ok('release check refuses the template', x.code === 1 && /placeholder/.test(x.out) && /dependency marker/.test(x.out), x);

// 3. idempotent
x = run('release-prep.mjs', 'tools', '0.21.0', '--write');
ok('a second --write changes nothing and says "already"', x.code === 0 && /\(already\)/.test(x.out), x);

// 4. drop and finish
w('apps/tools/docs/notes/v0.21.0.md', [
  '### Fixes', '- **A fix that stays that is long enough.** <!-- branch: work-a -->', '- **A fix that goes.** <!-- branch: work-b -->', '  - a line under it', '  - another', '- **A fix for both.** <!-- branch: work-a, work-b -->', '',
  '### New <!-- branch: work-b -->', '- **A whole section that goes.**', '', '### What we ask you to try', '- Try the thing.', ''].join('\n'));
x = run('release-prep.mjs', 'tools', '0.21.0', '--write', '--drop', 'work-b', '--finish');
const n = r('apps/tools/docs/notes/v0.21.0.md');
ok('--drop removes a tagged bullet with the lines under it', !n.includes('A fix that goes') && !n.includes('a line under it') && !n.includes('another'), n);
ok('--drop removes a line that needs the dropped branch among several', !n.includes('A fix for both'), n);
ok('--drop removes a tagged section whole', !n.includes('### New') && !n.includes('A whole section'), n);
ok('what is not tagged for the dropped branch stays, markers gone', n.includes('A fix that stays') && n.includes('### What we ask you to try') && !/<!--/.test(n), n);
x = run('release-check.mjs', 'tools', '--github-output', path.join(root, 'out.txt'));
ok('the release check passes the finished notes', x.code === 0, x);
ok('it writes v and tag for the workflow', r('out.txt') === 'v=0.21.0\ntag=tools-v0.21.0\n', r('out.txt'));

// 5. refusals
x = run('release-prep.mjs', 'tools', '0.20.5', '--write');
ok('going backwards is refused and nothing is written', x.code === 1 && /backwards/.test(x.out) && /"version": "0\.21\.0"/.test(r('apps/tools/package.json')), x);
w('apps/tools/desktop/package.json', '{\n  "version": "0.20.0"\n}\n');
x = run('release-check.mjs', 'tools');
ok('a split version fails the release check', x.code === 1 && /parity/.test(x.out), x);
x = run('release-prep.mjs', 'tools', '0.21.0', '--write');
ok('release-prep repairs a split version', x.code === 0 && /differ/.test(x.out) && /"version": "0\.21\.0"/.test(r('apps/tools/desktop/package.json')), x);
w('apps/tools/desktop-tauri/src-tauri/tauri.conf.json', '{\n  "version": "1.2.3"\n}\n');
x = run('release-prep.mjs', 'tools', '0.21.1', '--write');
ok('a Tauri config with its own version is flagged', x.code === 1 && /own version/.test(x.out), x);
w('apps/tools/docs/notes/v0.21.1.md', 'x');
fs.rmSync(path.join(root, 'apps/tools/docs/notes/v0.21.1.md'));
x = run('release-check.mjs', 'reader');
ok('an app that is not there fails (non-zero exit)', x.code !== 0, x);

fs.rmSync(root, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
