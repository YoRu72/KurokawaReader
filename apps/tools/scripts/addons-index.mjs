// The add-on index's checksums: every entry of repo/tools/index.json with a `module` (and a `manifest`) carries the
// file's SHA-256 (hex) and size, which the app checks before it keeps or loads it (src/addons.ts).
//   node scripts/addons-index.mjs            fill them in (only those lines change; the rest of the file stays byte for byte)
//   node scripts/addons-index.mjs --check    fail when one is missing or stale (the preflight's static checks run this)
//   node scripts/addons-index.mjs --index F  another index file (its files read beside it; the tests use it)
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const INDEX = args.includes('--index') ? path.resolve(args[args.indexOf('--index') + 1]) : path.resolve(root, '..', '..', 'repo', 'tools', 'index.json');
const DIR = path.dirname(INDEX);
const check = args.includes('--check');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const text = await fs.readFile(INDEX, 'utf8');
const ix = JSON.parse(text);
if (ix.kurokawa !== 'addons' || !Array.isArray(ix.addons)) { console.error(`${INDEX}: not an add-on index`); process.exit(1); }

/** What each entry's checksum fields must be. */
const want = new Map();
for (const a of ix.addons) {
  const w = {};
  for (const [file, hk, sk] of [[a.module, 'sha256', 'size'], [a.manifest, 'manifestSha256', 'manifestSize']]) {
    if (!file) continue;
    const p = path.resolve(DIR, file);
    if (!p.startsWith(DIR + path.sep)) { console.error(`${a.id}: ${file} is outside the index's folder`); process.exit(1); }
    const b = await fs.readFile(p).catch(() => null);
    if (!b) { console.error(`${a.id}: ${file} is missing`); process.exit(1); }
    w[hk] = sha(b); w[sk] = b.length;
  }
  if (Object.keys(w).length) want.set(a.id, w);
}

if (check) {
  const bad = [];
  for (const a of ix.addons) { const w = want.get(a.id); if (!w) continue; for (const [k, v] of Object.entries(w)) if (a[k] !== v) bad.push(`${a.id}.${k}`); }
  if (bad.length) { console.error(`add-on index out of date (run node apps/tools/scripts/addons-index.mjs): ${bad.join(', ')}`); process.exit(1); }
  console.log(`add-on checksums up to date (${want.size})`);
  process.exit(0);
}

// Writing: line by line inside each entry's object. An existing field's value is replaced on its own line; a new
// one goes right after the `module`/`manifest` line, with that line's indent (and the commas kept right).
const lines = text.split('\n');
let entry = null; let depth = 0; let changed = 0;
const out = [];
const idOf = (l) => /^\s*"id":\s*"([^"]+)"/.exec(l)?.[1];
// (The entries are the objects one level inside "addons": [ … ] — depth 2 from the root.)
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const before = depth;
  for (const ch of l.replace(/"(?:[^"\\]|\\.)*"/g, '""')) { if (ch === '{' || ch === '[') depth++; else if (ch === '}' || ch === ']') depth--; }
  if (before === 3 && entry === null) entry = { id: null };
  if (entry && before === 3 && !entry.id) { const id = idOf(l); if (id) entry.id = id; }
  const w = entry?.id ? want.get(entry.id) : null;
  if (w && before === 3) {
    const m = /^(\s*)"(sha256|size|manifestSha256|manifestSize)":\s*("[^"]*"|\d+)(,?)$/.exec(l);
    if (m) { const v = w[m[2]]; if (v === undefined) { out.push(l); continue; } const nl = `${m[1]}"${m[2]}": ${JSON.stringify(v)}${m[4]}`; if (nl !== l) changed++; out.push(nl); entry.done = { ...(entry.done ?? {}), [m[2]]: true }; continue; }
    const f = /^(\s*)"(module|manifest)":\s*"[^"]*"(,?)$/.exec(l);
    if (f) {
      const [hk, sk] = f[2] === 'module' ? ['sha256', 'size'] : ['manifestSha256', 'manifestSize'];
      // (Fields already further down are replaced where they are; only missing ones are added here.)
      const rest = lines.slice(i + 1, i + 40).join('\n');
      const has = (k) => new RegExp(`^\\s*"${k}":`, 'm').test(rest.split(/^\s{4}\}/m)[0]);
      const add = [hk, sk].filter((k) => !has(k));
      if (add.length) {
        const last = f[3] !== ',';
        out.push(last ? l + ',' : l);
        add.forEach((k, j) => out.push(`${f[1]}"${k}": ${JSON.stringify(w[k])}${j === add.length - 1 && last ? '' : ','}`));
        changed += add.length; continue;
      }
    }
  }
  out.push(l);
  if (entry && depth === 2) entry = null;
}
const next = out.join('\n');
// (The result must still be the same index with only the checksum fields changed.)
const strip = (o) => JSON.stringify(o.addons.map(({ sha256, size, manifestSha256, manifestSize, ...r }) => r)) + JSON.stringify({ ...o, addons: 0 });
const parsed = JSON.parse(next);
if (strip(parsed) !== strip(ix)) { console.error('internal: the rewrite changed more than the checksums'); process.exit(1); }
for (const [id, w] of want) { const a = parsed.addons.find((x) => x.id === id); for (const [k, v] of Object.entries(w)) if (a[k] !== v) { console.error(`internal: ${id}.${k} not written`); process.exit(1); } }
if (next !== text) await fs.writeFile(INDEX, next);
console.log(`${want.size} entries with files; ${changed} line(s) changed`);
