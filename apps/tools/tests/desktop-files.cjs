// The licence line (0.21, device battery — ../NOTICE.md): the GPL battery code stays under apps/tools. (This test once also checked
// that every module the Electron desktop app required was in electron-builder's `files` list; there is no Electron build now.)
const fs = require('node:fs'); const path = require('node:path');
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
