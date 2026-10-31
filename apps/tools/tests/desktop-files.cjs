// Every module the desktop app requires is packaged: each `require('./x.cjs')` of the desktop files has to be in
// electron-builder's `files` list, or the installed app stops at its first line.
const fs = require('node:fs'); const path = require('node:path');
const D = path.join(__dirname, '..', 'desktop'); const pkg = JSON.parse(fs.readFileSync(path.join(D, 'package.json'), 'utf8'));
const listed = new Set(pkg.build.files.filter((f) => typeof f === 'string'));
const missing = []; const seen = new Set(); const visit = (f) => { if (seen.has(f)) return; seen.add(f); if (!listed.has(f)) missing.push(f); for (const m of fs.readFileSync(path.join(D, f), 'utf8').matchAll(/require\(['"]\.\/([^'"]+\.cjs)['"]\)/g)) visit(m[1]); };
visit(pkg.main || 'main.cjs'); visit('preload.cjs');
if (missing.length) { console.error('not packaged:', missing.join(', ')); process.exit(1); }
console.log(`desktop modules packaged (${seen.size})`);
