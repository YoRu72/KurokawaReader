#!/usr/bin/env node
// node scripts/merge-chain.test.mjs — merge-chain.mjs on a made-up repository in a temp folder: two branches that
// each add tests to the one-line chain of a workflow (and one that also removes one) are merged one after the other;
// the result has every test once, the other lines of the file are merged by git, and the Rust list shape works too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x ?? ''))); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-mchain-'));
const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
const resolve = (...a) => spawnSync(process.execPath, [path.join(HERE, 'merge-chain.mjs'), ...a], { cwd: dir, encoding: 'utf8' });
const F = '.github/workflows/release-tools.yml', G = '.github/workflows/tauri-check.yml';
const wf = (tests, extra = '', rs = 'a.rs b.rs') => `jobs:\n  web:\n    steps:\n      - run: npm install --no-save playwright@1.64.1 ts-api@npm:typescript@6.0.3 && ${tests.map((t) => 'node tests/' + t).join(' && ')}\n${extra}      - name: Package\n        run: zip\n`;
const tauri = (rs) => `steps:\n  - run: |\n      for f in ${rs}; do\n        rustc $f\n      done\n`;
const put = (rel, t) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), t); };
const get = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const items = (rel) => get(rel).split('\n').find((l) => /playwright@/.test(l)).split(' && ').slice(1).map((s) => s.replace('node tests/', ''));

git('init', '-q', '-b', 'main'); git('config', 'user.email', 'a@b'); git('config', 'user.name', 't');
put(F, wf(['a.cjs', 'b.cjs', 'c.cjs'])); put(G, tauri('x.rs y.rs')); git('add', '-A'); git('commit', '-qm', 'base');
git('checkout', '-qb', 'one'); put(F, wf(['a.cjs', 'one.cjs', 'b.cjs', 'c.cjs'], '      - run: echo one\n')); put(G, tauri('x.rs one.rs y.rs')); git('commit', '-qam', 'one');
git('checkout', '-q', 'main'); git('checkout', '-qb', 'two'); put(F, wf(['a.cjs', 'b.cjs', 'c.cjs', 'two.cjs', 'two2.cjs'])); put(G, tauri('x.rs y.rs two.rs')); git('commit', '-qam', 'two');
git('checkout', '-q', 'main'); git('checkout', '-qb', 'three'); put(F, wf(['a.cjs', 'c.cjs', 'three.cjs'])); git('commit', '-qam', 'three');
git('checkout', '-q', 'main');
let m = git('merge', '--no-ff', '-q', 'one', '-m', 'm1'); ok('first merge is clean (only one side changed)', m.status === 0, m);
m = git('merge', '--no-ff', '-q', 'two', '-m', 'm2'); ok('second merge conflicts in the chain, as git does', m.status !== 0 && /CONFLICT/.test(m.stdout), m.stdout);
let r = resolve(F); ok('merge-chain resolves the chain', r.status === 0 && /2 added/.test(r.stdout), r);
ok('no markers left', !/<<<<<<<|>>>>>>>/.test(get(F)));
ok('the chain has the union once, in place', items(F).join(',') === 'a.cjs,one.cjs,b.cjs,c.cjs,two.cjs,two2.cjs', items(F));
ok('the other lines are git\'s merge (the extra step of the first branch is kept)', get(F).includes('echo one'));
r = resolve(G); ok('the Rust list resolves too', r.status === 0 && /rust test files/.test(r.stdout) && /for f in x\.rs one\.rs y\.rs two\.rs; do/.test(get(G)), r.stdout + get(G));
git('add', '-A'); git('commit', '-qm', 'merged');
m = git('merge', '--no-ff', '-q', 'three', '-m', 'm3'); ok('third merge conflicts', m.status !== 0, m);
r = resolve(F); ok('merge-chain applies a removal of theirs (b.cjs, two.cjs, two2.cjs, one.cjs were not in its base chain: only b.cjs is removed)', items(F).includes('three.cjs') && !items(F).includes('b.cjs') && items(F).includes('one.cjs') && items(F).includes('two.cjs'), items(F));
r = resolve('.github/workflows/nothing.yml'); ok('a file without conflict stages is refused', r.status === 2, r);
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
