// Builds the theme packs and their index from themes-src/<id>/ (theme.json, its pictures, its licence) into
// repo/themes/ — the Kurokawa repository, which every build of both apps reads from main (raw.githubusercontent).
//   node scripts/themes.mjs            build (writes <id>.ktheme and themes.json)
//   node scripts/themes.mjs --check    fail if repo/themes/ is not what the sources make (for CI)
//   node scripts/themes.mjs --out DIR  build into DIR instead
// Pack format (theme/packs.ts reads it): "KTHEME1\n", u32 BE header length, header JSON, the assets' bytes unchanged.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SRC = path.join(root, 'themes-src');
const OUT = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.resolve(root, '..', '..', 'repo', 'themes');
const check = args.includes('--check');
const sha = (b) => createHash('sha256').update(b).digest('hex');

export async function build(srcDir) {
  const meta = JSON.parse(await fs.readFile(path.join(srcDir, 'theme.json'), 'utf8'));
  const notice = meta.license ? (await fs.readFile(path.join(srcDir, meta.license.file), 'utf8')).trim() : undefined;
  let off = 0; const assets = []; const blobs = [];
  for (const a of meta.assets ?? []) { const b = await fs.readFile(path.join(srcDir, a.file)); assets.push({ name: a.name, type: a.type, size: b.length, sha256: sha(b), offset: off }); off += b.length; blobs.push(b); }
  const header = { format: 1, id: meta.id, name: meta.name, by: meta.by, version: meta.version, license: meta.license ? { spdx: meta.license.spdx, notice } : undefined, assets, tokens: meta.tokens };
  const head = Buffer.from(JSON.stringify(header), 'utf8'); const len = Buffer.alloc(4); len.writeUInt32BE(head.length);
  const file = Buffer.concat([Buffer.from('KTHEME1\n', 'utf8'), len, head, ...blobs]);
  return { meta, file, entry: { id: meta.id, file: `${meta.id}.ktheme`, size: file.length, sha256: sha(file), name: meta.name, by: meta.by, version: meta.version, assets: assets.map((a) => a.name), preview: meta.preview } };
}
const ids = (await fs.readdir(SRC, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const built = []; for (const id of ids) built.push(await build(path.join(SRC, id)));
const index = JSON.stringify({ format: 1, themes: built.map((b) => b.entry) }, null, 1) + '\n';
if (check) {
  let bad = 0;
  for (const b of built) { const have = await fs.readFile(path.join(OUT, b.entry.file)).catch(() => null); if (!have || sha(have) !== b.entry.sha256) { console.error(`out of date: ${b.entry.file}`); bad++; } }
  if ((await fs.readFile(path.join(OUT, 'themes.json'), 'utf8').catch(() => '')) !== index) { console.error('out of date: themes.json'); bad++; }
  if (bad) process.exit(1); console.log(`theme packs up to date (${built.length})`);
} else {
  await fs.mkdir(OUT, { recursive: true });
  for (const b of built) await fs.writeFile(path.join(OUT, b.entry.file), b.file);
  await fs.writeFile(path.join(OUT, 'themes.json'), index);
  for (const b of built) console.log(`${b.entry.file}  ${b.entry.size} bytes  sha256 ${b.entry.sha256}`);
}
