// The files kept the same in both apps (each app builds on its own): a change to one has to go to the other.
const fs = require('node:fs'); const path = require('node:path');
const A = path.join(__dirname, '..', '..'); const pairs = [['tools/desktop/appicon.cjs', 'reader/desktop/appicon.cjs'], ['tools/src/ui/iconCrop.ts', 'reader/src/ui/iconCrop.ts'], ['tools/src/ui/brandIcon.ts', 'reader/src/ui/brandIcon.ts'], ['tools/src/ui/titlebar.ts', 'reader/src/ui/titlebar.ts'], ['tools/desktop/titlebar.cjs', 'reader/desktop/titlebar.cjs']];
const bad = pairs.filter(([a, b]) => !fs.existsSync(path.join(A, b)) || fs.readFileSync(path.join(A, a), 'utf8') !== fs.readFileSync(path.join(A, b), 'utf8'));
if (bad.length) { console.error('not the same in both apps:', bad.map((x) => x.join(' / ')).join(', ')); process.exit(1); }
console.log(`shared files the same in both apps (${pairs.length})`);
