// The hybrid torrent engine's switch (stage P4, «far seeks»): desktop-tauri/rqbit-feature.cjs turns librqbit on in a
// copy of src-tauri/Cargo.toml (CI's) and «off» gives the committed text back byte for byte; the committed file is off.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../desktop-tauri/rqbit-feature.cjs');

const cargo = fs.readFileSync(path.join(__dirname, '../desktop-tauri/src-tauri/Cargo.toml'), 'utf8');
assert.ok(!F.isOn(cargo), 'the committed Cargo.toml has librqbit off');
assert.ok(cargo.split('\n').includes(F.PLAIN), 'the committed feature line is there');
assert.ok(!cargo.split('\n').some((l) => !l.startsWith('#') && /librqbit/.test(l)), 'the committed Cargo.toml never names the librqbit dependency');

const on = F.turnOn(cargo);
assert.ok(F.isOn(on));
// (Composed with the committed default list — the original system's wv2 kept, "rqbit" added, nothing dropped.)
const committedDefault = cargo.split('\n').find((l) => /^default\s*=/.test(l));
assert.ok(committedDefault && committedDefault.includes('"wv2"'), 'the committed defaults name wv2');
const onDefault = on.split('\n').find((l) => /^default\s*=/.test(l));
assert.strictEqual(onDefault, committedDefault.replace(/\]$/, ', "rqbit"]'), 'rqbit added to the defaults there are');
assert.ok(on.includes('\nrqbit = ["dep:librqbit", "dep:tokio"]\n'), 'feature on');
assert.ok(/\[dependencies\.librqbit\]\nversion = "=8\.1\.1"\noptional = true\n/.test(on), 'librqbit pinned, optional');
assert.ok(/\[dependencies\.tokio\]\nversion = "1"\noptional = true\nfeatures = \["rt-multi-thread", "io-util", "time"\]\n/.test(on), 'tokio');
assert.ok(on.includes('\npanic = "unwind"') && !on.includes('\npanic = "abort"'), 'the build with librqbit unwinds');
assert.ok(cargo.includes('\npanic = "abort"\n'), 'the plain build aborts, as before');
assert.strictEqual(on.split('\n').filter((l) => /^default\s*=/.test(l)).length, 1);
assert.strictEqual(F.turnOn(on), on, 'on twice is on');
assert.strictEqual(F.turnOff(on), cargo, 'off gives the committed text back');
assert.strictEqual(F.turnOff(cargo), cargo, 'off twice is off');

// (A Windows checkout's CRLF.)
const crlf = cargo.replace(/\n/g, '\r\n');
const onCr = F.turnOn(crlf);
assert.ok(F.isOn(onCr) && !/[^\r]\n/.test(onCr), 'CRLF kept');
assert.strictEqual(F.turnOff(onCr), crlf);

assert.throws(() => F.turnOn('[features]\nother = []\n'), /no «rqbit = \[\]» line/);
assert.throws(() => F.turnOn('[features]\ndefault = ["x"]\ndefault = ["y"]\nrqbit = []\n[profile.release]\npanic = "abort"\n'), /more than one default/);
assert.throws(() => F.turnOn('[features]\ndefault = ["rqbit"]\nrqbit = []\n[profile.release]\npanic = "abort"\n'), /a default already/);
// (No default list: one of its own made, and taken away again.)
const noDef = '[features]\nrqbit = []\nx = []\n\n[profile.release]\npanic = "abort"\n';
const noDefOn = F.turnOn(noDef);
assert.ok(noDefOn.includes('default = ["rqbit"]\nrqbit = ["dep:librqbit", "dep:tokio"]\nx = []'), noDefOn);
assert.strictEqual(F.turnOff(noDefOn), noDef);
// (Several defaults: each kept, in order.)
const many = '[features]\ndefault = ["a", "b"]\nrqbit = []\n[profile.release]\npanic = "abort"\n';
assert.ok(F.turnOn(many).includes('default = ["a", "b", "rqbit"]\n'));
assert.strictEqual(F.turnOff(F.turnOn(many)), many);
assert.throws(() => F.turnOff(on.replace('version = "=8.1.1"', 'version = "8"')), /changed by hand/);
console.log('rqbitfeature: ok');
