// node tests/pdftools/protect.mjs <file.pdf>: protect the PDF with AES-256 (user "u", owner "o", no copying),
// check the file with qpdf, open it again with each password through src/pdfcrypt.ts, and compare the text.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(os.tmpdir(), 'kr-pdfcrypt2.mjs');
await esbuild.build({ entryPoints: [path.join(root, 'src/pdfcrypt.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', nodePaths: [path.join(root, 'node_modules')] });
const { openPdf, protectPdf } = await import(out + '?' + Date.now());
const file = process.argv[2];
const t0 = Date.now();
const doc = await openPdf(new Uint8Array(fs.readFileSync(file)), process.argv[3] ?? '');
const bytes = await protectPdf(doc, 'u', 'o', { copy: false });
const t1 = Date.now() - t0;
const prot = path.join(os.tmpdir(), 'kr-prot.pdf'); fs.writeFileSync(prot, bytes);
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok' : 'FAIL') + ' ' + n); if (!c) fails++; };
const enc = execFileSync('qpdf', ['--password=u', '--show-encryption', prot]).toString();
ok('qpdf reads it: R6 AES-256, user password, copying restricted', /R = 6/.test(enc) && /Supplied password is user password/.test(enc) && /extract for any purpose: not allowed/.test(enc) && /stream encryption method: AESv3/.test(enc));
const enc2 = execFileSync('qpdf', ['--password=o', '--show-encryption', prot]).toString();
ok('the owner password is the owner password', /Supplied password is owner password/.test(enc2));
let check = ''; try { check = execFileSync('qpdf', ['--password=u', '--check', prot], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch (e) { check = String(e.stdout) + String(e.stderr); }
// (A malformed source — objects qpdf already warns about — stays as malformed; no new warning may appear.)
let orig = ''; try { orig = execFileSync('qpdf', [`--password=${process.argv[3] ?? ''}`, '--check', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch (e) { orig = String(e.stdout) + String(e.stderr); }
const warnings = (x) => (x.match(/^WARNING:/gm) ?? []).length;
ok('qpdf --check passes (no warning the source did not have)', (/No syntax or stream encoding errors found/.test(check) || /succeeded with warnings/.test(check)) && warnings(check) <= warnings(orig));
const ref = path.join(os.tmpdir(), 'kr-prot-ref.pdf');
// (qpdf exits 3 on a file with warnings — a malformed source is still a reference.)
try { execFileSync('qpdf', [`--password=${process.argv[3] ?? ''}`, '--decrypt', file, ref], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { if (e.status !== 3) throw e; }
const txt = (f, pw) => execFileSync('pdftotext', ['-layout', ...(pw ? ['-upw', pw] : []), f, '-'], { maxBuffer: 1 << 28 }).toString();
ok('the text reads the same (pdftotext with the user password)', txt(prot, 'u') === txt(ref));
const again = await openPdf(bytes, 'o'); const again2 = await openPdf(bytes, 'u');
ok('opens again here with either password', again.getPageCount() === doc.getPageCount() && again2.getPageCount() === doc.getPageCount());
let wrong = false; try { await openPdf(bytes, 'x'); } catch (e) { wrong = e.message === 'password'; }
ok('a wrong password is refused', wrong);
console.log(`${path.basename(file)} protected in ${t1} ms, ${bytes.length} B;`, fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
