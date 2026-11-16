#!/usr/bin/env node
// Resolves the one conflict every work branch of a release makes in the same two workflow files: the test chain
// of release-tools.yml (one very long «npm install … && node tests/a.cjs && node tests/b.cjs …» line, to which every
// branch adds its tests) and the list of std-only Rust test files of tauri-check.yml («for f in a.rs b.rs …; do»).
// Two branches that each add to such a line always conflict in git, although what they mean is a union.
//
//   git merge --no-ff work-t21-anime            (conflict in .github/workflows/release-tools.yml)
//   node scripts/merge-chain.mjs                resolves that file: the line three-way merged item by item, the
//                                               rest of the file by git's own merge (conflicts left as markers, if any)
//   node scripts/merge-chain.mjs .github/workflows/tauri-check.yml
//   git add <file> && git commit --no-edit
//
// Item merge: ours, then what theirs removed from the base's line (removed), then what theirs added, each placed after
// the item that preceded it in theirs (appended at the end when that item is gone). An item both sides added once is
// kept once. The script prints what it added and removed; it never touches a file that has no conflict stage.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const cwd = process.env.MERGE_CHAIN_CWD || process.cwd();
const file = argv.find((a) => !a.startsWith('--')) || '.github/workflows/release-tools.yml';
const git = (args, input) => spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 64 << 20 });
const stage = (n) => { const r = git(['show', `:${n}:${file}`]); return r.status === 0 ? r.stdout : null; };
const base = stage(1), ours = stage(2), theirs = stage(3);
if (base === null || ours === null || theirs === null) { console.error(`merge-chain: ${file} has no conflict stages (is a merge in progress, and is this file in conflict?)`); process.exit(2); }

// The two shapes of line: where it is and how it splits into items.
const SHAPES = [
  { name: 'test chain', find: (l) => /^\s*- run: npm install --no-save playwright@[\d.]+ .*&& node tests\/\S+\.cjs/.test(l), split: (l) => { const p = l.split(' && '); return { items: p, join: (it) => it.join(' && ') }; } },
  { name: 'rust test files', find: (l) => /^\s*for f in (\S+\.rs ?)+; do\s*$/.test(l), split: (l) => { const m = l.match(/^(\s*for f in )(.*?)(; do\s*)$/); return { items: [m[1], ...m[2].split(' ')], join: (it) => it[0] + it.slice(1).join(' ') + m[3] }; } },
];
const findLine = (text, shape) => { const ls = text.split('\n'); const i = ls.findIndex(shape.find); return { ls, i }; };
const shape = SHAPES.find((s) => findLine(ours, s).i >= 0 && findLine(base, s).i >= 0 && findLine(theirs, s).i >= 0);
if (!shape) { console.error(`merge-chain: no test chain or Rust test list in ${file}; resolve it by hand`); process.exit(2); }
const part = (text) => { const { ls, i } = findLine(text, shape); const s = shape.split(ls[i]); return { ls, i, ...s }; };
const B = part(base), O = part(ours), T = part(theirs);

// items: ours, minus what theirs deleted from base, plus what theirs inserted
const inBase = new Set(B.items), inTheirs = new Set(T.items);
const removed = B.items.filter((x) => !inTheirs.has(x));
let merged = O.items.filter((x) => !removed.includes(x));
const added = [];
for (let k = 0; k < T.items.length; k++) {
  const it = T.items[k]; if (inBase.has(it) || merged.includes(it)) continue;
  let at = merged.length; // after the nearest earlier item of theirs that is in the result
  for (let p = k - 1; p >= 0; p--) { const j = merged.indexOf(T.items[p]); if (j >= 0) { at = j + 1; break; } }
  merged.splice(at, 0, it); added.push(it);
}
const line = shape.split(O.ls[O.i]).join(merged);

// the rest of the file: git's merge with that line replaced by one marker in all three
const MARK = '@@MERGE-CHAIN-LINE@@';
const withMark = (p) => p.ls.map((l, i) => (i === p.i ? MARK : l)).join('\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-chain-'));
const wr = (n, t) => { const f = path.join(tmp, n); fs.writeFileSync(f, t); return f; };
const r = git(['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', wr('ours', withMark(O)), wr('base', withMark(B)), wr('theirs', withMark(T))]);
fs.rmSync(tmp, { recursive: true, force: true });
if (r.status < 0 || r.status > 127) { console.error('merge-chain: git merge-file failed: ' + r.stderr); process.exit(2); }
const out = r.stdout.replace(MARK, () => line);
fs.writeFileSync(path.join(cwd, file), out);
console.log(`merge-chain: ${file}: ${shape.name}: ${O.items.length} items in ours, ${added.length} added from theirs${added.length ? ' (' + added.map((x) => x.replace(/^node tests\//, '')).join(', ') + ')' : ''}, ${removed.length} removed${removed.length ? ' (' + removed.map((x) => x.replace(/^node tests\//, '')).join(', ') + ')' : ''}`);
if (r.status > 0) console.log(`merge-chain: the rest of the file still has ${r.status} conflict(s) (markers in the file): resolve them by hand`);
else console.log(`merge-chain: no other conflict in the file. Next: git add ${file}`);
process.exit(r.status > 0 ? 1 : 0);
