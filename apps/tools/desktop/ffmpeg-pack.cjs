// Release step: ffmpeg for the desktop as a pack instead of inside the installer. ffmpeg-static's own install has
// already fetched the binary for this machine; extra architectures (`node ffmpeg-pack.cjs x64` on an arm64 Mac, for
// the universal build) are fetched the same way. Each binary's architecture is read from its header before it is
// published: out/KurokawaTools-pack-ffmpeg-<platform>-<arch>.gz, and a .packpart.json the release merges into the
// packs file.
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const zlib = require('node:zlib'); const crypto = require('node:crypto'); const { execFileSync } = require('node:child_process');
const dir = path.dirname(require.resolve('ffmpeg-static/package.json'));
const bin = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const out = path.join(__dirname, 'out'); fs.mkdirSync(out, { recursive: true });

/** The CPU a program is built for, from its header (PE, Mach-O or ELF). */
function archOf(file) {
  const b = Buffer.alloc(4096); const fd = fs.openSync(file, 'r'); fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd);
  if (b[0] === 0x4d && b[1] === 0x5a) { const pe = b.readUInt32LE(0x3c); const m = b.readUInt16LE(pe + 4); return m === 0x8664 ? 'x64' : m === 0xaa64 ? 'arm64' : m === 0x14c ? 'ia32' : '?'; }
  if (b.readUInt32LE(0) === 0xfeedfacf) { const c = b.readUInt32LE(4); return c === 0x01000007 ? 'x64' : c === 0x0100000c ? 'arm64' : '?'; }
  if (b[0] === 0x7f && b[1] === 0x45) { const m = b.readUInt16LE(18); return m === 62 ? 'x64' : m === 183 ? 'arm64' : '?'; }
  return '?';
}
function publish(arch) {
  if (!fs.existsSync(bin)) throw new Error('no ffmpeg at ' + bin);
  const got = archOf(bin); if (got !== arch) { console.warn(`::warning::ffmpeg for ${arch} not published: the binary is ${got}`); return; }
  const key = `${process.platform}-${arch}`; const name = `KurokawaTools-pack-ffmpeg-${key}.gz`;
  const gz = zlib.gzipSync(fs.readFileSync(bin), { level: 9 }); fs.writeFileSync(path.join(out, name), gz);
  const part = { [key]: { file: name, size: gz.length, sha256: crypto.createHash('sha256').update(gz).digest('hex'), unpacked: fs.statSync(bin).size } };
  fs.writeFileSync(path.join(out, `ffmpeg-${key}.packpart.json`), JSON.stringify(part));
  console.log(`ffmpeg pack ${key}: ${(gz.length / 1048576).toFixed(1)} MB (${(part[key].unpacked / 1048576).toFixed(1)} MB unpacked)`);
}
publish(process.arch);
for (const extra of process.argv.slice(2)) {
  if (extra === process.arch) continue;
  fs.rmSync(bin, { force: true });
  try { execFileSync(process.execPath, [path.join(dir, 'install.js')], { cwd: dir, stdio: 'inherit', env: { ...process.env, npm_config_arch: extra, npm_config_platform: process.platform } }); publish(extra); }
  catch (e) { console.warn(`::warning::ffmpeg for ${extra} could not be fetched: ${e.message}`); }
}
