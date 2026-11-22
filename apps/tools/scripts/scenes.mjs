// Builds the repository's wallpapers (scenes) and their catalogue from scenes-src/<id>/ into repo/scenes/ — the
// Kurokawa repository every build reads from main (raw.githubusercontent); mirrors scripts/themes.mjs.
//   scenes-src/<id>/scene.json   the scene (ktscene/1, as src/theme/scenes/*.json; at most 256 KB, the engine's limit)
//   scenes-src/<id>/meta.json    { "names": { "en", "ar", "ja", "ko", "zh" }, "version": "1.0", "engine": 2,
//                                  "preview": { "dark": ["#rrggbb", …], "light": [...] } }
//                                (engine: the lowest scene-engine level it needs — sceneRepo.ts ENGINE_LEVEL)
//   node scripts/scenes.mjs            build (writes <id>.json and scenes.json)
//   node scripts/scenes.mjs --check    fail if repo/scenes/ is not what the sources make (the preflight's static checks)
//   node scripts/scenes.mjs --src DIR --out DIR   other folders (the tests use them)
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n) => (args.includes(n) ? path.resolve(args[args.indexOf(n) + 1]) : null);
const SRC = arg('--src') ?? path.join(root, 'scenes-src');
const OUT = arg('--out') ?? path.resolve(root, '..', '..', 'repo', 'scenes');
const check = args.includes('--check');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const LANGS = ['en', 'ar', 'ja', 'ko', 'zh'];
const fail = (m) => { console.error(m); process.exit(1); };

async function build(dir, id) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  const file = await fs.readFile(path.join(dir, 'scene.json'));
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) fail(`${id}: an id is lower-case letters, digits and «-»`);
  if (file.length > 256 * 1024) fail(`${id}: scene.json is ${file.length} bytes; the engine reads at most 256 KB`);
  let doc; try { doc = JSON.parse(file.toString('utf8')); } catch { fail(`${id}: scene.json is not JSON`); }
  if (doc.format !== 'ktscene/1') fail(`${id}: scene.json is not ktscene/1`);
  for (const l of LANGS) if (typeof meta.names?.[l] !== 'string' || !meta.names[l].trim()) fail(`${id}: meta.json needs names.${l}`);
  if (typeof meta.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(meta.version)) fail(`${id}: meta.json version (dotted numbers)`);
  if (!Number.isInteger(meta.engine) || meta.engine < 1) fail(`${id}: meta.json engine (the level it needs, 1 or more)`);
  // (A scene also built into the app, src/theme/scenes/<id>.json: the two files the same, so the catalogue never drifts from it.)
  const builtIn = await fs.readFile(path.join(root, 'src', 'theme', 'scenes', `${id}.json`)).catch(() => null);
  if (builtIn && !arg('--src') && sha(builtIn) !== sha(file)) fail(`${id}: scene.json differs from the built-in src/theme/scenes/${id}.json (keep them the same)`);
  const preview = {}; for (const m of ['dark', 'light']) if (Array.isArray(meta.preview?.[m])) preview[m] = meta.preview[m].filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  return { file, entry: { id, names: Object.fromEntries(LANGS.map((l) => [l, meta.names[l]])), version: meta.version, sha256: sha(file), size: file.length, engine: meta.engine, preview } };
}
const ids = (await fs.readdir(SRC, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const built = []; for (const id of ids) built.push(await build(path.join(SRC, id), id));
const index = JSON.stringify({ format: 1, scenes: built.map((b) => b.entry) }, null, 1) + '\n';
if (check) {
  let bad = 0;
  for (const b of built) { const have = await fs.readFile(path.join(OUT, `${b.entry.id}.json`)).catch(() => null); if (!have || sha(have) !== b.entry.sha256) { console.error(`out of date: ${b.entry.id}.json`); bad++; } }
  if ((await fs.readFile(path.join(OUT, 'scenes.json'), 'utf8').catch(() => '')) !== index) { console.error('out of date: scenes.json (run node apps/tools/scripts/scenes.mjs)'); bad++; }
  if (bad) process.exit(1); console.log(`scene catalogue up to date (${built.length})`);
} else {
  await fs.mkdir(OUT, { recursive: true });
  for (const b of built) await fs.writeFile(path.join(OUT, `${b.entry.id}.json`), b.file);
  await fs.writeFile(path.join(OUT, 'scenes.json'), index);
  for (const b of built) console.log(`${b.entry.id}.json  ${b.entry.size} bytes  sha256 ${b.entry.sha256}`);
  console.log(`scenes.json  ${built.length} scene(s)`);
}
