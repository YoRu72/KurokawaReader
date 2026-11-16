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


/* ---------- the space a job needs ---------- */
/** `n` bytes as the disk keeps them: whole blocks (an empty file still costs its entry, counted as nothing). */
const blocks = (n, bs = 4096) => (n <= 0 ? 0 : Math.ceil(n / bs) * bs);
/**
 * The replay: units in the order they are taken out (in place: last first), each `out` bytes written and `freed`
 * archive bytes given back once it is committed. → { normal, inPlace, peakAt } where `normal` is what extracting keeping
 * the archive needs and `inPlace` the most the disk holds at once while the archive shrinks (only when archive and
 * destination share a volume: across volumes the archive's bytes free nothing there). `overhead`: the journal and the
 * saved tail; `margin` is added by the caller (the setting).
 */
function replaySpace(units, { sameVolume = true, blockSize = 4096, overhead = 0 } = {}) {
  let written = 0; let freed = 0; let peak = overhead; let peakAt = -1; let normal = overhead;
  units.forEach((u, i) => { written += blocks(u.out, blockSize); const now = overhead + written - (sameVolume ? freed : 0); if (now > peak) { peak = now; peakAt = i; } freed += u.freed; });
  for (const u of units) normal += blocks(u.out, blockSize);
  return { normal, inPlace: sameVolume ? peak : normal, peakAt };
}

/* ---------- conflicts ---------- */
/** «name (2).ext» from 2 on, the first `taken` does not hold (the batch rename's numbering: the last dot, the extension's case kept; a folder takes no extension). */
function keepBothName(name, taken, dir = false) {
  const dot = dir ? -1 : name.lastIndexOf('.'); const base = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) { const c = `${base} (${i})${ext}`; if (!taken(c)) return c; }
}
/**
 * One conflict model (extraction now, copy/move later): each item that meets an existing one gets «replace», «skip» or
 * «both». `answers`: { default, files?, folders?, per: { [path]: choice } } — what the user said for one item, for the
 * rest of its kind, for the rest. → the choice for `path`.
 */
function conflictChoice(answers, path, isDir) {
  const a = answers || {}; if (a.per && a.per[path]) return a.per[path];
  const kind = isDir ? a.folders : a.files; return kind || a.default || null;
}

/* ---------- the pre-flight ---------- */
const NAME_REFUSALS = new Set(['empty', 'nul', 'dot', 'dotdot', 'absolute', 'drive', 'reservedSuffix', 'pathLong']);
/** What the user can do about each kind of problem (a key the page words; the same in every language file). */
const FIX = { method: 'fixMethod', password: 'fixPassword', names: 'fixNames', clash: 'fixClash', links: 'fixLinks', space: 'fixSpace', layout: 'fixLayout', damaged: 'fixDamaged', volumes: 'fixVolumes', readonly: 'fixReadonly', saf: 'fixSaf', busy: 'fixBusy', ratio: 'fixRatio', existing: 'fixExisting', rewrite: 'fixRewrite', otherVolume: 'fixOtherVolume', resume: 'fixResume' };
/**
 * Everything checked before anything is written. `f` (facts the engine gathered, nothing changed yet): { format, size,
 * entries: [{ path, dir, link?, target?, method?, encrypted?, csize?, usize, crc?, headerOk? }], supported: [methods the
 * device decodes itself], external?: [methods a helper (7-Zip) decodes — normal mode only], encrypted, password: 'none'|
 * 'ok'|'wrong'|'missing', damaged?: [names] (verify-first), layoutBad?: [names] (directory vs local header, overlap),
 * volumes?: { missing: [], odd: [] }, archiveWritable, destWritable, saf, sameVolume, free, existing: [paths], busy,
 * platform, destLen, inPlaceFormat (zip/tar), blockSize }. `o`: { margin, answers }. → the report the sheet shows.
 */
function preflight(f, o = {}) {
  const P = []; const add = (kind, severity, names, extra = {}) => { if (!names.length) return; P.push({ kind, severity, count: names.length, names: names.slice(0, 5), fix: FIX[kind], ...extra }); };
  const files = f.entries.filter((e) => !e.dir);
  // Names, for the real destination.
  const set = checkSet(f.entries.map((e) => ({ path: e.path, dir: !!e.dir, link: e.link, target: e.target })), f.platform, f.destLen || 0);
  const refusedNames = set.problems.filter((p) => NAME_REFUSALS.has(p.kind)).map((p) => p.path);
  const clashes = set.problems.filter((p) => ['duplicate', 'caseClash', 'rewriteClash', 'fileDir'].includes(p.kind));
  const links = set.problems.filter((p) => p.kind === 'linkOutside' || p.kind === 'throughLink').map((p) => p.path);
  const rewrites = set.items.filter((x) => x.action === 'rewrite' && x.reasons.length).map((x) => ({ from: x.path, to: x.out, reasons: x.reasons }));
  const flagged = set.items.filter((x) => x.flags.includes('bidi') || x.flags.includes('control')).map((x) => x.path);
  add('names', 'block', refusedNames); add('clash', 'inPlace', clashes.map((p) => p.path), { kinds: [...new Set(clashes.map((p) => p.kind))] }); add('links', 'block', links);
  add('rewrite', 'info', rewrites.map((r) => r.from), { rewrites: rewrites.slice(0, 50) });
  if (flagged.length) add('bidi', 'info', flagged);
  // Methods: what this device decodes (in place needs our own decoder; a helper may do a normal extraction).
  const sup = new Set(f.supported || []); const ext = new Set(f.external || []);
  const own = files.filter((e) => e.method != null && !sup.has(e.method)); const none = own.filter((e) => !ext.has(e.method));
  if (own.length) P.push({ kind: 'method', severity: none.length ? 'block' : 'inPlace', count: own.length, names: own.slice(0, 5).map((e) => e.path), methods: [...new Set(own.map((e) => e.method))], fix: FIX.method });
  // Encryption: the password proved on the smallest locked file before anything is written.
  if (f.encrypted && f.password !== 'ok') add('password', 'block', [f.password === 'wrong' ? 'wrong' : 'missing']);
  if (f.encrypted) P.push({ kind: 'encryptedInPlace', severity: 'inPlace', count: 1, names: [], fix: FIX.password });
  if (f.damaged && f.damaged.length) add('damaged', 'inPlace', f.damaged);
  if (f.layoutBad && f.layoutBad.length) add('layout', 'inPlace', f.layoutBad);
  if (f.volumes && (f.volumes.missing.length || f.volumes.odd.length)) add('volumes', 'block', [...f.volumes.missing, ...f.volumes.odd]);
  if (f.busy) add('busy', 'block', ['busy']);
  if (f.saf) add('saf', 'inPlace', ['saf']);
  if (!f.archiveWritable) add('readonly', 'inPlace', ['archive']);
  if (!f.destWritable) add('readonly', 'block', ['destination']);
  if (!f.inPlaceFormat) P.push({ kind: 'formatInPlace', severity: 'inPlace', count: 1, names: [], fix: 'fixFormat' });
  // Already there: counted, each to be asked about (or the «for the rest» answer).
  const exist = new Set((f.existing || []).map((x) => foldKey(x, f.platform))); const there = set.items.filter((x) => x.action !== 'refuse' && exist.has(foldKey(x.out, f.platform))).map((x) => x.path);
  add('existing', 'ask', there);
  // A calm word about extreme squeeze (a «zip bomb»): the numbers, nothing refused.
  const packed = files.reduce((a, e) => a + (e.csize || 0), 0); const total = files.reduce((a, e) => a + Math.max(0, e.usize || 0), 0);
  const ratio = packed > 0 ? total / packed : 0; if (ratio > 100 && total > 1024 ** 3) P.push({ kind: 'ratio', severity: 'info', count: 1, names: [], ratio: Math.round(ratio), total, packed, fix: FIX.ratio });
  // Space: normal = every output; in place = the replay's peak (last unit first), plus the saved tail and journal.
  const order = f.inPlaceFormat ? [...files].sort((a, b) => (b.offset ?? 0) - (a.offset ?? 0)) : files;
  const tail = f.tailBytes || 0; const overhead = 65536 + tail; const margin = o.margin || 0;
  const sp = replaySpace(order.map((e) => ({ out: Math.max(0, e.usize || 0), freed: e.unitBytes ?? e.csize ?? 0 })), { sameVolume: !!f.sameVolume, blockSize: f.blockSize || 4096, overhead });
  const space = { free: f.free, normal: sp.normal, inPlace: sp.inPlace, margin, sameVolume: !!f.sameVolume, fitsNormal: f.free < 0 || sp.normal + margin <= f.free, fitsInPlace: f.free < 0 || sp.inPlace + margin <= f.free };
  const blockers = P.filter((p) => p.severity === 'block');
  const inPlaceBlockers = P.filter((p) => p.severity === 'inPlace' || p.severity === 'block');
  const normal = { ok: !blockers.length && space.fitsNormal, why: blockers.map((p) => p.kind).concat(space.fitsNormal ? [] : ['space']) };
  const inPlace = { ok: !inPlaceBlockers.length && space.fitsInPlace && !!f.sameVolume, why: inPlaceBlockers.map((p) => p.kind).concat(space.fitsInPlace ? [] : ['space']).concat(f.sameVolume ? [] : ['otherVolume']) };
  if (!normal.ok && !inPlace.ok && !space.fitsNormal) add('space', 'block', ['space']);
  if (!f.sameVolume && !space.fitsNormal) add('otherVolume', 'info', ['otherVolume']);
  // What the sheet recommends, and why.
  const recommend = normal.ok && (!inPlace.ok || space.fitsNormal) ? 'normal' : inPlace.ok ? 'inPlace' : 'none';
  const why = recommend === 'normal' ? (inPlace.ok ? 'bothFit' : 'normalOnly') : recommend === 'inPlace' ? 'onlyInPlaceFits' : space.fitsNormal || space.fitsInPlace ? 'blocked' : normal.why.includes('space') && !f.sameVolume ? 'otherVolume' : 'nothingFits';
  return { ok: normal.ok || inPlace.ok, files: files.length, total, problems: P, rewrites, space, normal, inPlace, recommend, why };
}

/* ---------- the journal's text (version 2) ---------- */
const JOURNAL_VERSION = 2;
/** The journal as written: its JSON, a newline, its CRC-32 in hex (a cut or edited journal never passes). */
function journalText(body) { const j = JSON.stringify({ ...body, kt: 'extract', version: JOURNAL_VERSION }); return `${j}\n${crc32(j).toString(16).padStart(8, '0')}\n`; }
/**
 * A journal read back: { ok: true, body } or { ok: false, why } where why is 'corrupt' (a cut, a changed byte, not ours),
 * 'future' (a later version: never replayed by this one) or 'v1' (the first design: { committed, output, length? }).
 */
function journalRead(text) {
  const nl = text.indexOf('\n'); const j = nl < 0 ? text : text.slice(0, nl); const sum = nl < 0 ? '' : text.slice(nl + 1).trim();
  let o; try { o = JSON.parse(j); } catch { return { ok: false, why: 'corrupt' }; }
  if (!o || typeof o !== 'object') return { ok: false, why: 'corrupt' };
  if (o.version === 1 && !sum && typeof o.committed === 'number') return { ok: false, why: 'v1', body: o };
  if (typeof o.version !== 'number' || o.kt !== 'extract') return { ok: false, why: 'corrupt' };
  if (sum !== crc32(j).toString(16).padStart(8, '0')) return { ok: false, why: 'corrupt' };
  if (o.version > JOURNAL_VERSION) return { ok: false, why: 'future', body: o };
  return { ok: true, body: o };
}

module.exports = { SPEC, PLATFORMS, measure, cutName, nameRule, pathRule, foldKey, checkSet, crc32, crcTable, blocks, replaySpace, keepBothName, conflictChoice, preflight, journalText, journalRead, JOURNAL_VERSION, NAME_REFUSALS };
