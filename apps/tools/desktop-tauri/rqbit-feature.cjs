#!/usr/bin/env node
// Turns the hybrid torrent engine's librqbit half on or off in src-tauri/Cargo.toml (stage P4, «far seeks»).
//
// The committed Cargo.toml never names librqbit: its `rqbit` feature is empty, so a plain build neither resolves nor
// compiles librqbit and a librqbit that moved can never break it. «on» makes the feature real and the default —
// `default = ["rqbit"]`, `rqbit = ["dep:librqbit", "dep:tokio"]` and the two dependencies below, pinned — in the copy
// it is run on (CI's checkout; a release job's, see switch-over/NOTES.md); «off» puts the committed text back exactly.
// Usage: node rqbit-feature.cjs on|off|status [path/to/Cargo.toml]
'use strict';
const fs = require('fs');
const path = require('path');

const PLAIN = 'rqbit = []';
const ON = 'default = ["rqbit"]\nrqbit = ["dep:librqbit", "dep:tokio"]';
const MARK = '# (Added by rqbit-feature.cjs on — removed by «off».)';
// (librqbit 8.1.1: what CI resolved and built in runs 43586049375 and 43597302499. tokio: already in the build through
// Tauri; librqbit's own runtime (stream_rqbit.rs) needs rt-multi-thread, the stream's reads and timeouts io-util and time.)
const DEPS = `\n${MARK}\n[dependencies.librqbit]\nversion = "=8.1.1"\noptional = true\n\n[dependencies.tokio]\nversion = "1"\noptional = true\nfeatures = ["rt-multi-thread", "io-util", "time"]\n`;
// (The build with librqbit unwinds instead of aborting, so a panic inside librqbit is caught — stream_hybrid.rs's
// \`safe\` — and the torrent handed back to aria2, never the program taken down. The plain build keeps «abort».)
const ABORT = 'panic = "abort"';
const UNWIND = 'panic = "unwind" # (rqbit-feature.cjs on: a librqbit panic is caught, aria2 takes over)';

function isOn(text) {
  return text.includes(MARK);
}

/** The committed Cargo.toml text → the text with librqbit on (the same text when it already is). */
function turnOn(text) {
  if (isOn(text)) return text;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.replace(/\r$/, '') === PLAIN);
  if (at < 0) throw new Error('no «' + PLAIN + '» line in [features]');
  if (lines.some((l) => /^default\s*=/.test(l))) throw new Error('a default feature list is there already');
  const cr = lines[at].endsWith('\r') ? '\r' : '';
  lines[at] = ON.split('\n').join(cr + '\n') + cr;
  const p = lines.findIndex((l) => l.replace(/\r$/, '') === ABORT);
  if (p < 0) throw new Error('no «' + ABORT + '» line in [profile.release]');
  lines[p] = UNWIND + (lines[p].endsWith('\r') ? '\r' : '');
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out + (cr ? DEPS.replace(/\n/g, '\r\n') : DEPS);
}

/** The inverse of turnOn: the committed text again (the same text when librqbit is off). */
function turnOff(text) {
  if (!isOn(text)) return text;
  const crlf = text.includes('\r\n');
  const deps = crlf ? DEPS.replace(/\n/g, '\r\n') : DEPS;
  const on = crlf ? ON.replace(/\n/g, '\r\n') : ON;
  let out = text;
  const d = out.lastIndexOf(deps);
  if (d < 0) throw new Error('the added dependencies were changed by hand');
  out = out.slice(0, d) + out.slice(d + deps.length);
  if (!out.includes(on)) throw new Error('the feature lines were changed by hand');
  if (!out.includes(UNWIND)) throw new Error('the panic line was changed by hand');
  return out.replace(on, PLAIN).replace(UNWIND, ABORT);
}

module.exports = { turnOn, turnOff, isOn, PLAIN, ON, DEPS, ABORT, UNWIND };

if (require.main === module) {
  const [cmd, file] = process.argv.slice(2);
  const p = path.resolve(file || path.join(__dirname, 'src-tauri', 'Cargo.toml'));
  const text = fs.readFileSync(p, 'utf8');
  if (cmd === 'on') fs.writeFileSync(p, turnOn(text));
  else if (cmd === 'off') fs.writeFileSync(p, turnOff(text));
  else if (cmd !== 'status') { console.error('usage: node rqbit-feature.cjs on|off|status [Cargo.toml]'); process.exit(2); }
  console.log('librqbit: ' + (isOn(fs.readFileSync(p, 'utf8')) ? 'on (default feature, librqbit =8.1.1)' : 'off (plain build)') + ' — ' + p);
}
