// Helper of tests/pets.cjs and tests/petsui.cjs (not a test): made-up pictures for pet packs — plain coloured shapes
// (rectangles, circles) with the frame's number drawn in, as PNG and GIF — and the packs made of them (our pet.json,
// a Shimeji-style pack, a folder of frames) written to a folder, and a small stored zip. No character, no real art.
const zlib = require('node:zlib'); const fs = require('node:fs'); const path = require('node:path');
/* ---------- generated pictures ---------- */
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
/** RGBA w×h: a coloured rectangle (transparent margin), the number n drawn in white. */
function shape(w, h, n, col = [70, 130, 160], round = false) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { if (round && ((x - w / 2) / (w / 2 - 2)) ** 2 + ((y - h / 2) / (h / 2 - 2)) ** 2 > 1) continue; const o = (y * w + x) * 4; px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255; }
  const s = String(n); const sc = Math.max(1, Math.floor(Math.min(w / (s.length * 4 + 2), h / 7)));
  for (let d = 0; d < s.length; d++) { const g = DIGITS[Number(s[d])]; for (let i = 0; i < 15; i++) if (g[i] === '1') for (let yy = 0; yy < sc; yy++) for (let xx = 0; xx < sc; xx++) { const X = sc + (d * 4 + (i % 3)) * sc + xx, Y = sc + Math.floor(i / 3) * sc + yy; if (X < w && Y < h) { const o = (Y * w + X) * 4; px[o] = px[o + 1] = px[o + 2] = 255; px[o + 3] = 255; } } }
  return px;
}
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, n, col, round) {
  const px = shape(w, h, n, col, round); const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
/** A PNG header claiming any size (no pixels: what a hostile pack could send). */
function pngHeader(w, h) { const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IEND', Buffer.alloc(0))])); }
/** A GIF of `frames` frames, w×h, 4 colours (0 transparent): frame k is colour 1+k%3 with a band of colour 0 at row k. */
function gif(w, h, frames) {
  const out = [Buffer.from('GIF89a'), Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0x81, 0, 0]), Buffer.from([0, 0, 0, 200, 60, 60, 60, 200, 60, 60, 60, 200])];
  for (let k = 0; k < frames; k++) {
    out.push(Buffer.from([0x21, 0xf9, 4, (2 << 2) | 1, 10, 0, 0, 0]));
    out.push(Buffer.from([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2]));
    // (Codes of 3 bits: a clear code before every two pixels keeps the table from growing.)
    const codes = []; for (let i = 0; i < w * h; i++) { if (i % 2 === 0) codes.push(4); const y = Math.floor(i / w); codes.push(y === k % h ? 0 : 1 + (k % 3)); } codes.push(5);
    const bytes = []; let acc = 0, bits = 0; for (const c of codes) { acc |= c << bits; bits += 3; while (bits >= 8) { bytes.push(acc & 255); acc >>= 8; bits -= 8; } } if (bits) bytes.push(acc & 255);
    for (let i = 0; i < bytes.length; i += 255) { const part = bytes.slice(i, i + 255); out.push(Buffer.from([part.length, ...part])); } out.push(Buffer.from([0]));
  }
  out.push(Buffer.from([0x3b])); return new Uint8Array(Buffer.concat(out));
}

/** A stored (uncompressed) zip of { name: bytes }. */
function zip(files) {
  const parts = [], cd = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const nb = Buffer.from(name); const b = Buffer.from(data); const c = crc(b);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(b.length, 18); lh.writeUInt32LE(b.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(b.length, 20); ch.writeUInt32LE(b.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, b); cd.push(ch, nb); off += 30 + nb.length + b.length;
  }
  const cdb = Buffer.concat(cd); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); const n = Object.keys(files).length; end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, end]);
}
/** Our pet.json pack «Pebble»: a round shape (corners transparent) — idle 2, walk 4 (a strip), fall 1, held 2, click 2. */
function petPack() {
  const C = [[96, 140, 170], [110, 150, 180], [120, 160, 150], [100, 130, 190]];
  const strip = (() => { const w = 48, h = 48, n = 4; const raw = Buffer.alloc((w * n * 4 + 1) * h); const fr = Array.from({ length: n }, (_, i) => shape(w, h, i + 3, C[i % 4], true)); for (let y = 0; y < h; y++) for (let i = 0; i < n; i++) fr[i].copy(raw, y * (w * n * 4 + 1) + 1 + i * w * 4, y * w * 4, (y + 1) * w * 4); const ih = Buffer.alloc(13); ih.writeUInt32BE(w * n, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); })();
  return {
    'pet.json': JSON.stringify({ format: 'kurokawa-pet', version: 1, name: 'Pebble', credit: 'Made-up test maker', licence: 'Test fixture, free to use in tests.', facing: 'right',
      sheets: { walk: { file: 'walk.png', columns: 4, rows: 1 } },
      animations: { idle: { frames: ['idle_1.png', 'idle_2.png'], fps: 2 }, walk: { frames: ['walk:0', 'walk:1', 'walk:2', 'walk:3'], fps: 8, speed: 40 }, fall: { frames: ['fall.png'] }, held: { frames: ['held_1.png', 'held_2.png'], fps: 6 }, hop: { frames: ['click_1.png', 'click_2.png'], fps: 4, loop: false } },
      states: { idle: [{ animation: 'idle', weight: 2, duration: [2, 4] }], walk: [{ animation: 'walk', weight: 3, duration: [3, 6] }], fall: ['fall'], dragged: ['held'], click: [{ animation: 'hop', duration: 0.6 }] }, speech: ['Made-up line'] }, null, 1),
    'idle_1.png': png(48, 48, 1, C[0], true), 'idle_2.png': png(48, 48, 2, C[0], true), 'walk.png': strip, 'fall.png': png(48, 48, 7, [150, 110, 160], true),
    'held_1.png': png(48, 48, 8, [130, 120, 170], true), 'held_2.png': png(48, 48, 9, [130, 120, 170], true), 'click_1.png': png(48, 48, 10, [90, 160, 160], true), 'click_2.png': png(48, 48, 11, [90, 160, 160], true),
  };
}
/** A Shimeji-style pack «Blocky» (made-up): img/Blocky/shime1..21.png, conf/actions.xml, conf/behaviors.xml. */
function shimejiPack() {
  const out = {};
  for (let i = 1; i <= 21; i++) out[`img/Blocky/shime${i}.png`] = png(64, 64, i, [80 + (i * 5) % 60, 120, 150]);
  const pose = (n, vx = 0, d = 250) => `<Pose Image="/shime${n}.png" ImageAnchor="32,64" Velocity="${vx},0" Duration="${d}" />`;
  out['conf/actions.xml'] = `<?xml version="1.0" encoding="UTF-8"?>\n<Mascot xmlns="http://www.group-finity.com/Mascot"><ActionList>
<Action Name="Stand" Type="Stay" BorderType="Floor"><Animation>${pose(1)}</Animation></Action>
<Action Name="Walk" Type="Move" BorderType="Floor"><Animation>${pose(1, -2, 6)}${pose(2, -2, 6)}${pose(1, -2, 6)}${pose(3, -2, 6)}</Animation></Action>
<Action Name="Sit" Type="Stay" BorderType="Floor"><Animation>${pose(11)}</Animation></Action>
<Action Name="Falling" Type="Embedded" Class="com.group_finity.mascot.action.Fall"><Animation>${pose(4)}</Animation></Action>
<Action Name="Pinched" Type="Embedded" Class="com.group_finity.mascot.action.Dragged"><Animation>${pose(5, 0, 5)}${pose(6, 0, 5)}</Animation></Action>
<Action Name="Teleport" Type="Embedded" Class="com.example.Teleport" />
</ActionList><ActionList>
<Action Name="StandUp" Type="Sequence"><ActionReference Name="Stand" Duration="\${100+Math.random()*100}" /></Action>
<Action Name="SitDown" Type="Sequence"><ActionReference Name="Sit" Duration="\${250}" /></Action>
<Action Name="WalkAlong" Type="Sequence"><ActionReference Name="Walk" /></Action>
</ActionList></Mascot>`;
  out['conf/behaviors.xml'] = `<?xml version="1.0" encoding="UTF-8"?>\n<Mascot xmlns="http://www.group-finity.com/Mascot"><BehaviorList>
<Behavior Name="Fall" Frequency="0" /><Behavior Name="ChaseMouse" Frequency="5" />
<Condition Condition="#{mascot.environment.floor.isOn(mascot.anchor) || mascot.environment.activeIE.topBorder.isOn(mascot.anchor)}">
<Behavior Name="StandUp" Frequency="200" /><Behavior Name="SitDown" Frequency="100" /><Behavior Name="WalkAlong" Frequency="150" />
<Behavior Name="Odd" Action="Stand" Frequency="10" Condition="#{java.lang.Runtime.getRuntime()}" />
</Condition></BehaviorList></Mascot>`;
  out['readme.txt'] = 'Blocky: a made-up test pack of plain shapes.';
  return out;
}
/** A folder of frames in another engine's layout «Hopper»: walk_1..4, idle-01..02, sitting/01..02, a fall strip, notes. */
function framesPack() {
  const out = {}; const col = [120, 140, 170];
  for (let i = 1; i <= 4; i++) out[`Hopper/walk_${i}.png`] = png(40, 56, i, col);
  for (let i = 1; i <= 2; i++) out[`Hopper/idle-0${i}.png`] = png(40, 56, 10 + i, [110, 150, 150]);
  for (let i = 1; i <= 2; i++) out[`Hopper/sitting/0${i}.png`] = png(40, 56, 20 + i, [140, 130, 160]);
  out['Hopper/fall_strip.png'] = (() => { const fr = [png(40, 40, 31, col)]; return fr[0]; })();
  out['Hopper/notes.txt'] = 'made-up';
  out['Hopper/tool.exe'] = 'MZ-not-a-program';
  return out;
}
function writeDir(dir, files) { for (const [n, b] of Object.entries(files)) { const p = path.join(dir, n); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); } return dir; }
module.exports = { shape, png, pngHeader, gif, zip, petPack, shimejiPack, framesPack, writeDir };
