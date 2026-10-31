// Before electron-builder: the aria2c binary for this platform and arch into desktop/aria2/<plat>-<arch>/, from
// GitHub releases only (Windows: aria2's own build; Linux: abcfy2's static musl builds; macOS: none exists —
// the app looks for Homebrew's aria2c at run time). Also writes the repository slug into package.json for the
// updater (GITHUB_REPOSITORY in CI).
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const arch = process.env.KT_ARCH || process.arch;
const URLS = {
  'win-x64': 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip',
  'linux-x64': 'https://github.com/abcfy2/aria2-static-build/releases/latest/download/aria2-x86_64-linux-musl_static.zip',
  'linux-arm64': 'https://github.com/abcfy2/aria2-static-build/releases/latest/download/aria2-aarch64-linux-musl_static.zip',
};
// package.json: the repository slug for the updater.
const pkgPath = path.join(here, 'package.json'); const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
if (process.env.GITHUB_REPOSITORY) { pkg.kurokawa = { ...(pkg.kurokawa || {}), repo: process.env.GITHUB_REPOSITORY }; await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n'); }
// The web build copied beside the shell: electron-builder wants everything it packs under this folder.
const distSrc = path.join(here, '..', 'dist'), distDst = path.join(here, 'dist');
if (await fs.stat(distSrc).then(() => true).catch(() => false)) { await fs.rm(distDst, { recursive: true, force: true }); await fs.cp(distSrc, distDst, { recursive: true }); console.log('fetch-aria2: dist/ copied beside the shell'); }
const url = URLS[`${plat}-${arch}`];
if (!url) { console.log(`fetch-aria2: no bundled aria2c for ${plat}-${arch} (the app uses one on the PATH)`); process.exit(0); }
const outDir = path.join(here, 'aria2', `${plat}-${arch}`); await fs.mkdir(outDir, { recursive: true });
const exe = plat === 'win' ? 'aria2c.exe' : 'aria2c';
if (await fs.stat(path.join(outDir, exe)).then(() => true).catch(() => false)) { console.log('fetch-aria2: already here'); process.exit(0); }
const zip = path.join(outDir, 'aria2.zip');
const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
await new Promise((res, rej) => { const ws = createWriteStream(zip); r.body.pipeTo(new WritableStream({ write(c) { ws.write(Buffer.from(c)); }, close() { ws.end(res); }, abort: rej })).catch(rej); });
// Unzip in Node itself (Git Bash's tar on Windows reads «D:\...» as a host name; unzip may be missing).
const tmp = path.join(outDir, 'x'); await fs.mkdir(tmp, { recursive: true });
await unzip(zip, tmp);
/** Extracts a ZIP (stored or deflated entries) by its central directory. */
async function unzip(file, dest) {
  const b = await fs.readFile(file);
  let eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); if (eocd < 0) throw new Error('not a zip');
  const count = b.readUInt16LE(eocd + 10); let off = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory');
    const method = b.readUInt16LE(off + 10), csize = b.readUInt32LE(off + 20), nameLen = b.readUInt16LE(off + 28), extraLen = b.readUInt16LE(off + 30), commentLen = b.readUInt16LE(off + 32), local = b.readUInt32LE(off + 42);
    const name = b.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.includes('..')) continue;
    const lNameLen = b.readUInt16LE(local + 26), lExtraLen = b.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen; const raw = b.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null; if (!data) throw new Error(`unsupported zip method ${method} for ${name}`);
    const out = path.join(dest, name); await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, data);
  }
}
async function find(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const f = await find(p); if (f) return f; } else if (e.name === exe) return p; } return null; }
const bin = await find(tmp); if (!bin) throw new Error('aria2c not found in the archive');
await fs.copyFile(bin, path.join(outDir, exe)); if (plat !== 'win') await fs.chmod(path.join(outDir, exe), 0o755);
await fs.rm(tmp, { recursive: true, force: true }); await fs.rm(zip, { force: true });
console.log(`fetch-aria2: ${plat}-${arch} → ${path.join(outDir, exe)}`);
