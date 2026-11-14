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
assert.ok(on.includes('default = ["rqbit"]\nrqbit = ["dep:librqbit", "dep:tokio"]\n'), 'feature on and the default');
assert.ok(/\[dependencies\.librqbit\]\nversion = "=8\.1\.1"\noptional = true\n/.test(on), 'librqbit pinned, optional');
assert.ok(/\[dependencies\.tokio\]\nversion = "1"\noptional = true\nfeatures = \["io-util", "time"\]\n/.test(on), 'tokio');
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
assert.throws(() => F.turnOn('[features]\ndefault = ["x"]\nrqbit = []\n'), /default feature list/);
assert.throws(() => F.turnOff(on.replace('version = "=8.1.1"', 'version = "8"')), /changed by hand/);
console.log('rqbitfeature: ok');
