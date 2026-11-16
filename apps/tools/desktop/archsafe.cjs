// Archive safety, the pure part (no file system): the one name table (namesafe.json) for every target, the checks a
// whole archive's names must pass, the space a job needs at its peak, the conflict plan, the pre-flight report and the
// journal's text. Electron's engine (inplace.cjs, archive.cjs) and the page (src/archives/safety.ts) use this file;
// KtNameSafe.java (Android) and kt-core's archsafe.rs (Tauri) are its twins, run on the same vectors
// (tests/data/namesafe-vectors.tsv) by tests/extractsafe.cjs. Nothing here writes; nothing is renamed silently: every
// rewrite comes back with its reason so the sheet can show it.
'use strict';
const SPEC = require('./namesafe.json');

const PLATFORMS = Object.keys(SPEC.platforms);
const RESERVED = new Set(SPEC.reservedNames);
const BIDI = new Set(SPEC.bidi);
const REPL = SPEC.replacement;

/** Length of `s` in the target's unit (UTF-8 bytes or UTF-16 code units). */
function measure(s, unit) {
  if (unit === 'utf16') return s.length;
  let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n;
}
/** `name` cut between characters to `max` units, its extension (a last dot within `extKeep` of the end) kept. */
function cutName(name, max, unit = 'utf8') {
  if (measure(name, unit) <= max) return name;
  const dot = name.lastIndexOf('.'); const hasExt = dot > 0 && name.length - dot <= SPEC.extKeep; const ext = hasExt ? name.slice(dot) : '';
  const stem = hasExt ? name.slice(0, dot) : name; const room = Math.max(1, max - measure(ext, unit)); let out = ''; let n = 0;
  for (const ch of stem) { const w = measure(ch, unit); if (n + w > room) break; out += ch; n += w; }
  return out + ext;
}
const isControl = (c) => (c >= 1 && c <= 0x1f) || c === 0x7f;

/**
 * One path component for one target: { action: 'allow'|'rewrite'|'refuse', out, reasons, flags }. Reasons say why it
 * was refused or rewritten (empty, nul, dot, dotdot, reservedSuffix, colon, illegal, control, trailing, reserved, long);
 * flags are kept-but-shown (control, bidi, spaces, hidden).
 */
function nameRule(comp, platform) {
  const P = SPEC.platforms[platform]; if (!P) throw new Error('platform ' + platform);
  const reasons = []; const flags = []; const refuse = (r) => ({ action: 'refuse', out: '', reasons: [r], flags: [] });
  if (comp === '') return refuse('empty');
  if (comp.includes('\0')) return refuse('nul');
  if (comp === '.') return refuse('dot');
  if (comp === '..') return refuse('dotdot');
  if (comp.toLowerCase().endsWith(SPEC.tempSuffix)) return refuse('reservedSuffix');
  let out = '';
  for (const ch of comp) {
    const c = ch.codePointAt(0);
    if (P.illegal.includes(ch)) { out += REPL; const r = ch === ':' ? 'colon' : 'illegal'; if (!reasons.includes(r)) reasons.push(r); continue; }
    if (isControl(c)) { if (P.control === 'rewrite') { out += REPL; if (!reasons.includes('control')) reasons.push('control'); continue; } if (!flags.includes('control')) flags.push('control'); }
    if (BIDI.has(c) && !flags.includes('bidi')) flags.push('bidi');
    out += ch;
  }
  const trail = () => { if (P.trailing !== 'rewrite') return; const m = /[. ]+$/.exec(out); if (m) { out = out.slice(0, m.index) + REPL.repeat(m[0].length); if (!reasons.includes('trailing')) reasons.push('trailing'); } };
  trail();
  if (P.reserved) { const st = out.split('.')[0].replace(/ +$/, '').toUpperCase(); if (RESERVED.has(st)) { out = REPL + out; reasons.push('reserved'); } }
  const limit = P.maxName - SPEC.tempSuffix.length;
  if (measure(out, P.unit) > limit) { out = cutName(out, limit, P.unit); reasons.push('long'); trail(); }
  if (/^ | $/.test(out)) flags.push('spaces');
  if (out.startsWith('.')) flags.push('hidden');
  return { action: out === comp ? 'allow' : 'rewrite', out, reasons, flags };
}

/**
 * A whole relative path from an archive for one target. `destLen`: the destination folder's length in the target's
 * unit (with its separator), for the total-length rule. → { action, out (without a trailing slash), reasons, flags }.
 */
function pathRule(path, platform, destLen = 0) {
  const P = SPEC.platforms[platform]; if (!P) throw new Error('platform ' + platform);
  const refuse = (r) => ({ action: 'refuse', out: '', reasons: [r], flags: [] });
  if (path === '') return refuse('empty');
  if (path.includes('\0')) return refuse('nul');
  if (path.startsWith('/') || path.startsWith('\\')) return refuse('absolute');
  if (/^[A-Za-z]:/.test(path)) return refuse('drive');
  const comps = path.split('/').filter((c) => c !== '' && c !== '.');
  if (!comps.length) return refuse('empty');
  const outs = []; const reasons = []; const flags = []; let refused = null;
  for (const c of comps) {
    const r = nameRule(c, platform);
    if (r.action === 'refuse') { refused = r.reasons[0]; break; }
    outs.push(r.out); for (const x of r.reasons) if (!reasons.includes(x)) reasons.push(x); for (const x of r.flags) if (!flags.includes(x)) flags.push(x);
  }
  if (refused) return refuse(refused);
  const out = outs.join('/'); const len = destLen + measure(out, P.unit);
  if (len > P.maxPath) return refuse('pathLong');
  if (P.longPath && len > P.longPath) flags.push('longPath');
  return { action: out === comps.join('/') && reasons.length === 0 ? 'allow' : 'rewrite', out, reasons, flags };
}

/** The key two names share when the target cannot keep them apart (case and, on macOS, Unicode form). */
function foldKey(path, platform) {
  const P = SPEC.platforms[platform]; let k = path;
  if (P.foldForm) k = k.normalize('NFD');
  if (P.foldCase) k = k.toLowerCase();
  return k;
}

/**
 * The names of a whole archive checked together for one target. entries: [{ path, dir?, link?: 'sym'|'hard',
 * target? }]. → { items: [{ path, out, action, reasons, flags }], problems: [{ kind, path, other? }] } where kind is a
 * refusal reason, 'duplicate', 'caseClash' (case/form twins the target folds), 'rewriteClash' (two names made one by a
 * rewrite), 'fileDir' (a file where a folder is needed), 'linkOutside', 'throughLink'.
 */
function checkSet(entries, platform, destLen = 0) {
  const items = []; const problems = []; const byOut = new Map(); const byKey = new Map(); const dirs = new Set(); const dirKeys = new Set(); const files = new Map(); const links = new Set();
  for (const e of entries) {
    const r = pathRule(e.path, platform, destLen); items.push({ path: e.path, out: r.out, action: r.action, reasons: r.reasons, flags: r.flags });
    if (r.action === 'refuse') { problems.push({ kind: r.reasons[0], path: e.path }); continue; }
    const parts = r.out.split('/'); for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); dirs.add(d); dirKeys.add(foldKey(d, platform)); }
    if (e.dir) { dirs.add(r.out); dirKeys.add(foldKey(r.out, platform)); continue; }
    if (e.link === 'sym') {
      links.add(r.out);
      const t = String(e.target ?? ''); const base = parts.slice(0, -1);
      const bad = t === '' || t.startsWith('/') || t.startsWith('\\') || /^[A-Za-z]:/.test(t) || (() => { const st = [...base]; for (const c of t.split(/[\\/]/)) { if (c === '' || c === '.') continue; if (c === '..') { if (!st.length) return true; st.pop(); } else st.push(c); } return false; })();
      if (bad) { problems.push({ kind: 'linkOutside', path: e.path }); continue; }
    }
    if (e.link === 'hard') { const t = String(e.target ?? ''); if (!entries.some((x) => x !== e && !x.dir && x.path === t)) { problems.push({ kind: 'linkOutside', path: e.path }); continue; } }
    const prev = byOut.get(r.out);
    if (prev !== undefined) { problems.push({ kind: prev === e.path ? 'duplicate' : 'rewriteClash', path: e.path, other: prev }); continue; }
    const k = foldKey(r.out, platform); const pk = byKey.get(k);
    if (pk !== undefined) { problems.push({ kind: 'caseClash', path: e.path, other: pk }); continue; }
    byOut.set(r.out, e.path); byKey.set(k, e.path); if (!e.link) files.set(k, e.path);
  }
  for (const [k, p] of files) if (dirKeys.has(k)) problems.push({ kind: 'fileDir', path: p });
  for (const it of items) { if (it.action === 'refuse') continue; const parts = it.out.split('/'); for (let i = 1; i < parts.length; i++) if (links.has(parts.slice(0, i).join('/'))) { problems.push({ kind: 'throughLink', path: it.path }); break; } }
  return { items, problems };
}

/* ---------- crc-32 (journal checksums, tail checks) ---------- */
let TABLE; function crcTable() { if (TABLE) return TABLE; TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; } return TABLE; }
/** CRC-32 of bytes (a Uint8Array) or of a string's UTF-8; `prev` continues one. */
function crc32(data, prev = 0) { const T = crcTable(); const b = typeof data === 'string' ? new TextEncoder().encode(data) : data; let c = (prev ^ 0xffffffff) >>> 0; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

module.exports = { SPEC, PLATFORMS, measure, cutName, nameRule, pathRule, foldKey, checkSet, crc32, crcTable };
