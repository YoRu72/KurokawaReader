// node tests/pdftools/crypt.mjs <file.pdf> [password]: open an encrypted PDF with src/pdfcrypt.ts, save it
// unencrypted next to /tmp output, and compare its text (pdftotext) with qpdf's own decryption.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(os.tmpdir(), 'kr-pdfcrypt.mjs');
await esbuild.build({ entryPoints: [path.join(root, 'src/pdfcrypt.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', nodePaths: [path.join(root, 'node_modules')] });
const { openPdf } = await import(out + '?' + Date.now());
const [file, pw = ''] = process.argv.slice(2);
const t0 = Date.now();
let doc;
try { doc = await openPdf(new Uint8Array(fs.readFileSync(file)), pw); } catch (e) { console.log(path.basename(file), 'FAILED', e.message); process.exit(1); }
const saved = await doc.save();
const mine = path.join(os.tmpdir(), 'kr-mine.pdf'), ref = path.join(os.tmpdir(), 'kr-ref.pdf');
fs.writeFileSync(mine, saved);
execFileSync('qpdf', [`--password=${pw}`, '--decrypt', file, ref]);
const txt = (f) => execFileSync('pdftotext', ['-layout', f, '-']).toString();
const a = txt(mine), b = txt(ref);
const enc = execFileSync('qpdf', ['--show-encryption', mine]).toString().split('\n')[0];
console.log(path.basename(file), a === b ? 'TEXT OK' : 'TEXT DIFFERS', `${a.length} chars`, `${doc.getPageCount()} pages`, `${Date.now() - t0} ms`, '|', enc);
