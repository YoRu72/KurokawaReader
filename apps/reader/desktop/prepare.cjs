// Before electron-builder: the web build (../dist) copied beside the shell, since everything packed must sit
// under this folder once asarUnpack is in use.
const fs = require('node:fs'); const path = require('node:path');
const src = path.join(__dirname, '..', 'dist'), dst = path.join(__dirname, 'dist');
if (fs.existsSync(src)) { fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); console.log('prepare: dist/ copied beside the shell'); }
