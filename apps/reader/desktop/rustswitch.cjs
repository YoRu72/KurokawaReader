// The Electron build's move to the Rust (Tauri) build — the decisions only (stage R6b; main.cjs runs them when its
// RUST_SWITCH is on). Which release carries the Tauri build for this computer (of this version or newer: the switch
// is offered even when the Electron copy is already the release's own version), its file by the names the release
// workflow gives — the same as desktop-tauri/src-tauri/src/updatelogic.rs and src/updateCore.ts (tests/updatenames.cjs
// keeps the three equal) —, and the SHA-256 that file must have (GitHub's digest, the release's SHA256SUMS file).
'use strict';

const APP = 'KurokawaReader';

/** SemVer's order (src/updateCore.ts cmpVersion): negative when `a` is older. */
function cmpVersion(a, b) {
  const parse = (v) => { const s = String(v).trim().replace(/^v/i, '').split('+')[0]; const i = s.indexOf('-'); return { core: (i < 0 ? s : s.slice(0, i)).split('.').map((x) => Number(x) || 0), pre: i < 0 ? [] : s.slice(i + 1).split('.').filter(Boolean) }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length, 3); i++) { const d = (x.core[i] || 0) - (y.core[i] || 0); if (d) return d; }
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]; if (p === undefined) return -1; if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { const d = Number(p) - Number(q); if (d) return d; } else if (pn !== qn) return pn ? -1 : 1; else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const archWord = (arch) => (arch === 'arm64' || arch === 'aarch64' ? 'arm64' : 'x64');

/** The Tauri build's file that replaces an Electron copy on this system: the installer on Windows (never the
 *  portable zip: portable copies move by hand), the universal disk image on a Mac, the AppImage on Linux (Electron's
 *  Linux build is an AppImage). (The disk image ends «.DMG» and the AppImage «.appimage»: every Electron copy's own
 *  page takes «the first /\.dmg$/» and «the first /\.AppImage$/» of a release — case-sensitive, and frozen in the
 *  copies out there —, so none can take the Rust build's file and skip the hand-over; macOS and Linux go by the
 *  extension whatever its case.) */
function rustAssetName(version, os, arch) {
  const a = archWord(arch);
  if (os === 'win32') return `${APP}-${version}-windows-${a}-setup.exe`;
  if (os === 'darwin') return `${APP}-${version}-macos-universal.DMG`;
  if (os === 'linux') return `${APP}-${version}-linux-${a}.appimage`;
  return null;
}
const sumsName = (version) => `${APP}-${version}-SHA256SUMS.txt`;

/** Of GitHub's releases list, the newest reader release (tag v<version>, not a draft; pre-releases on the beta channel
 *  only) of `current` or newer that carries the Tauri build's file for this system → { version, asset: { name, url,
 *  size, digest }, sums: { name, url } | null, page } or null. */
function pickRust(releases, current, os, arch, o = {}) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    const tag = String(r && r.tag_name || '');
    if (!r || r.draft || (r.prerelease && !o.beta) || !/^v\d+\.\d/.test(tag)) continue;
    const v = tag.slice(1);
    if (!o.beta && v.includes('-')) continue;
    if (cmpVersion(v, current) < 0 || (best && cmpVersion(v, best.version) <= 0)) continue;
    const want = rustAssetName(v, os, arch); const assets = Array.isArray(r.assets) ? r.assets : [];
    const a = assets.find((x) => x && x.name === want); if (!a) continue;
    const s = assets.find((x) => x && x.name === sumsName(v));
    best = { version: v, asset: { name: a.name, url: a.browser_download_url, size: Number(a.size) || 0, digest: a.digest || null }, sums: s ? { name: s.name, url: s.browser_download_url } : null, page: r.html_url || '' };
  }
  return best;
}

/** A SHA256SUMS file → Map(name → hash in lower case). */
function parseSums(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m) out.set(m[2].split(/[\\/]/).pop(), m[1].toLowerCase());
  }
  return out;
}

/** The SHA-256 the file must have: GitHub's digest («sha256:…») and the SHA256SUMS line, whichever there are (both:
 *  they must agree) → { sha } or { error: 'nochecksum' | 'checksum' }. */
function expectedSha(digest, sumsLine) {
  const a = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || '').trim()); const x = a ? a[1].toLowerCase() : null;
  const y = /^[0-9a-f]{64}$/i.test(String(sumsLine || '')) ? String(sumsLine).toLowerCase() : null;
  if (x && y && x !== y) return { error: 'checksum' };
  if (x || y) return { sha: x || y };
  return { error: 'nochecksum' };
}

module.exports = { APP, cmpVersion, rustAssetName, sumsName, pickRust, parseSums, expectedSha };
