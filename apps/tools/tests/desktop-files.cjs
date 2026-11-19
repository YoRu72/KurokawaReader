// Every module the desktop app requires is packaged: each `require('./x.cjs')` of the desktop files has to be in
// electron-builder's `files` list, or the installed app stops at its first line.
const fs = require('node:fs'); const path = require('node:path');
const D = path.join(__dirname, '..', 'desktop'); const pkg = JSON.parse(fs.readFileSync(path.join(D, 'package.json'), 'utf8'));
const listed = new Set(pkg.build.files.filter((f) => typeof f === 'string'));
const missing = []; const seen = new Set(); const visit = (f) => { if (seen.has(f)) return; seen.add(f); if (!listed.has(f)) missing.push(f); for (const m of fs.readFileSync(path.join(D, f), 'utf8').matchAll(/require\(['"]\.\/([^'"]+\.cjs)['"]\)/g)) visit(m[1]); };
visit(pkg.main || 'main.cjs'); visit('preload.cjs');
if (missing.length) { console.error('not packaged:', missing.join(', ')); process.exit(1); }
console.log(`desktop modules packaged (${seen.size})`);
// (0.21, device battery — ../NOTICE.md.) The battery code is GPL-3.0-or-later and lives only under apps/tools: nothing the
// Reader builds from (its sources, its manifests and build lists, and shared/) names the kt-battery crate or the Tauri
// shell's battery.rs, so the Reader (MIT) never takes it in.
{
  const ROOT = path.join(__dirname, '..', '..', '..'); const hits = [];
  const SKIP = /(^|[\\/])(node_modules|dist|dist-old|target|releases|\.git|android|ios)([\\/]|$)/;
  const TEXT = /\.(ts|tsx|js|mjs|cjs|json|rs|toml|ya?ml|gradle|html|sh|ps1|nsi|nsh)$/;
  const scan = (dir) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (SKIP.test(p.slice(ROOT.length))) continue; if (e.isDirectory()) scan(p); else if (TEXT.test(e.name) && fs.statSync(p).size < 4e6) { const t = fs.readFileSync(p, 'utf8'); if (/kt[-_]battery|src-tauri[\\/]src[\\/]battery\.rs/.test(t)) hits.push(path.relative(ROOT, p)); } } };
  scan(path.join(ROOT, 'apps', 'reader')); scan(path.join(ROOT, 'shared'));
  if (hits.length) { console.error('the Reader or shared/ names the GPL battery code:', hits.join(', ')); process.exit(1); }
  console.log('the Reader and shared/ name nothing of kt-battery');
}
