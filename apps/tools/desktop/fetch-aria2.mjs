// Before electron-builder: the aria2c binary for this platform and arch into desktop/aria2/<plat>-<arch>/, from
// GitHub releases only (Windows: aria2's own build; Linux: abcfy2's static musl builds; macOS: none exists —
// the app looks for Homebrew's aria2c at run time). Also writes the repository slug into package.json for the
// updater (GITHUB_REPOSITORY in CI).
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
const url = URLS[`${plat}-${arch}`];
if (!url) { console.log(`fetch-aria2: no bundled aria2c for ${plat}-${arch} (the app uses one on the PATH)`); process.exit(0); }
const outDir = path.join(here, 'aria2', `${plat}-${arch}`); await fs.mkdir(outDir, { recursive: true });
const exe = plat === 'win' ? 'aria2c.exe' : 'aria2c';
if (await fs.stat(path.join(outDir, exe)).then(() => true).catch(() => false)) { console.log('fetch-aria2: already here'); process.exit(0); }
const zip = path.join(outDir, 'aria2.zip');
const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
await new Promise((res, rej) => { const ws = createWriteStream(zip); r.body.pipeTo(new WritableStream({ write(c) { ws.write(Buffer.from(c)); }, close() { ws.end(res); }, abort: rej })).catch(rej); });
// (Unzip with what the platform has: tar knows zip on Windows 10+ and macOS; unzip on Linux.)
const tmp = path.join(outDir, 'x'); await fs.mkdir(tmp, { recursive: true });
try { execFileSync(plat === 'linux' ? 'unzip' : 'tar', plat === 'linux' ? ['-qo', zip, '-d', tmp] : ['-xf', zip, '-C', tmp]); } catch (e) { console.error('unzip failed', e.message); process.exit(1); }
async function find(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const f = await find(p); if (f) return f; } else if (e.name === exe) return p; } return null; }
const bin = await find(tmp); if (!bin) throw new Error('aria2c not found in the archive');
await fs.copyFile(bin, path.join(outDir, exe)); if (plat !== 'win') await fs.chmod(path.join(outDir, exe), 0o755);
await fs.rm(tmp, { recursive: true, force: true }); await fs.rm(zip, { force: true });
console.log(`fetch-aria2: ${plat}-${arch} → ${path.join(outDir, exe)}`);
