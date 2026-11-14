#!/usr/bin/env node
// Turns the hybrid torrent engine's librqbit half on or off in src-tauri/Cargo.toml (stage P4, «far seeks»).
//
// The committed Cargo.toml never names librqbit: its `rqbit` feature is empty, so a plain build neither resolves nor
// compiles librqbit and a librqbit that moved can never break it. «on» makes the feature real and a default — "rqbit"
// added to the default list already there (the original system's `wv2`, ../PORTING.md; never one dropped), or a list
// of its own; `rqbit = ["dep:librqbit", "dep:tokio"]` and the two dependencies below, pinned — in the copy it is run on
// (CI's checkout; a release job's, see switch-over/NOTES.md); «off» puts the committed text back exactly (the list as
// it was is kept in the added block).
// Usage: node rqbit-feature.cjs on|off|status [path/to/Cargo.toml]
'use strict';
const fs = require('fs');
const path = require('path');

const PLAIN = 'rqbit = []';
const FEATURE = 'rqbit = ["dep:librqbit", "dep:tokio"]';
const MARK = '# (Added by rqbit-feature.cjs on — removed by «off».)';
// (The default feature list before «on», kept in the added block so «off» puts it back exactly — the committed file has
// its own defaults (the original system's `wv2`); «on» only adds "rqbit" to them, never drops one.)
const BEFORE = '# (default before: ';
// (librqbit 8.1.1: what CI resolved and built in runs 43586049375 and 43597302499. tokio: already in the build through
// Tauri; librqbit's own runtime (stream_rqbit.rs) needs rt-multi-thread, the stream's reads and timeouts io-util and time.)
const DEPS_BODY = '[dependencies.librqbit]\nversion = "=8.1.1"\noptional = true\n\n[dependencies.tokio]\nversion = "1"\noptional = true\nfeatures = ["rt-multi-thread", "io-util", "time"]\n';
function deps(before) {
  return `\n${MARK}\n${BEFORE}${before})\n${DEPS_BODY}`;
}
// (The build with librqbit unwinds instead of aborting, so a panic inside librqbit is caught — stream_hybrid.rs's
// \`safe\` — and the torrent handed back to aria2, never the program taken down. The plain build keeps «abort».)
const ABORT = 'panic = "abort"';
const UNWIND = 'panic = "unwind" # (rqbit-feature.cjs on: a librqbit panic is caught, aria2 takes over)';
const DEFAULT_RE = /^default\s*=\s*\[(.*)\]\s*$/;

function isOn(text) {
  return text.includes(MARK);
}

/** A default list's items (quoted names) → the list's line. */
function defaultLine(items) {
  return 'default = [' + items.map((x) => JSON.stringify(x)).join(', ') + ']';
}
function items(line) {
  const m = DEFAULT_RE.exec(line);
  if (!m) return null;
  return m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/^"|"$/g, ''));
}

/** The committed Cargo.toml text → the text with librqbit on (the same text when it already is): the feature made
 *  real, "rqbit" added to the default list there is (or a list of its own made), panic = "unwind", the two pinned
 *  dependencies at the end. */
function turnOn(text) {
  if (isOn(text)) return text;
  const lines = text.split('\n');
  const bare = (l) => l.replace(/\r$/, '');
  const at = lines.findIndex((l) => bare(l) === PLAIN);
  if (at < 0) throw new Error('no «' + PLAIN + '» line in [features]');
  const cr = lines[at].endsWith('\r') ? '\r' : '';
  const defs = lines.map((l, i) => [bare(l), i]).filter(([l]) => /^default\s*=/.test(l));
  if (defs.length > 1) throw new Error('more than one default feature list');
  let before = 'none';
  if (defs.length === 1) {
    const [line, i] = defs[0];
    const it = items(line);
    if (!it) throw new Error('a default feature list on more than one line');
    if (it.includes('rqbit')) throw new Error('"rqbit" is a default already');
    before = line;
    lines[i] = defaultLine(it.concat(['rqbit'])) + cr;
    lines[at] = FEATURE + cr;
  } else {
    lines[at] = defaultLine(['rqbit']) + cr + '\n' + FEATURE + cr;
  }
  const p = lines.findIndex((l) => bare(l) === ABORT);
  if (p < 0) throw new Error('no «' + ABORT + '» line in [profile.release]');
  lines[p] = UNWIND + (lines[p].endsWith('\r') ? '\r' : '');
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  const d = deps(before);
  return out + (cr ? d.replace(/\n/g, '\r\n') : d);
}

/** The inverse of turnOn: the committed text again (the same text when librqbit is off). */
function turnOff(text) {
  if (!isOn(text)) return text;
  const crlf = text.includes('\r\n');
  const nl = crlf ? '\r\n' : '\n';
  const m = new RegExp(MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n' + BEFORE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(.*)\\)\\r?\\n').exec(text);
  if (!m) throw new Error('the added block was changed by hand');
  const before = m[1];
  const block = (crlf ? deps(before).replace(/\n/g, '\r\n') : deps(before));
  const at = text.lastIndexOf(block);
  if (at < 0) throw new Error('the added dependencies were changed by hand');
  let out = text.slice(0, at) + text.slice(at + block.length);
  if (!out.includes(UNWIND)) throw new Error('the panic line was changed by hand');
  out = out.replace(UNWIND, ABORT);
  if (before === 'none') {
    const pair = defaultLine(['rqbit']) + nl + FEATURE + nl;
    if (!out.includes(pair)) throw new Error('the feature lines were changed by hand');
    out = out.replace(pair, PLAIN + nl);
  } else {
    const it = items(before);
    const now = defaultLine(it.concat(['rqbit'])) + nl;
    if (!out.includes(now) || !out.includes(FEATURE + nl)) throw new Error('the feature lines were changed by hand');
    out = out.replace(now, before + nl).replace(FEATURE + nl, PLAIN + nl);
  }
  return out;
}

module.exports = { turnOn, turnOff, isOn, PLAIN, FEATURE, MARK, ABORT, UNWIND };

if (require.main === module) {
  const [cmd, file] = process.argv.slice(2);
  const p = path.resolve(file || path.join(__dirname, 'src-tauri', 'Cargo.toml'));
  const text = fs.readFileSync(p, 'utf8');
  if (cmd === 'on') fs.writeFileSync(p, turnOn(text));
  else if (cmd === 'off') fs.writeFileSync(p, turnOff(text));
  else if (cmd !== 'status') { console.error('usage: node rqbit-feature.cjs on|off|status [Cargo.toml]'); process.exit(2); }
  console.log('librqbit: ' + (isOn(fs.readFileSync(p, 'utf8')) ? 'on (default feature, librqbit =8.1.1)' : 'off (plain build)') + ' — ' + p);
}
