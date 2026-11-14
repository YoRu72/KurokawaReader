// The hybrid's Electron half (desktop-tauri/PORTING.md «Closed by the hybrid»): desktop/handover.cjs exportCookies —
// what the bridge build hands the Rust build of the in-app browser's sign-ins — on made-up cookies in a temp folder:
// only those that outlive the session and have not expired, the file this user's only (POSIX 0600), a note naming the
// hand-over with the file's size and SHA-256 (what cookiecarry.rs checks), nothing written into the marker; dropCookies
// wipes both. And that the Electron build is unchanged while RUST_SWITCH is false: the export is called only inside
// rustSwitch (which runs only with it true), and wiped again there when nothing is installed. Plain node.
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto'); const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
const H = require(path.join(ROOT, 'desktop', 'handover.cjs'));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-hybrid-cookies-'));
  fs.writeFileSync(path.join(dir, 'marker.json'), JSON.stringify({ app: 'KurokawaTools', kind: 'handover', id: 'made-up-id', files: [] }));
  const now = Date.now() / 1000;
  const made = [
    { name: 'sid', value: 'made-up-1', domain: '.example.org', hostOnly: false, path: '/', secure: true, httpOnly: true, session: false, expirationDate: now + 86400, sameSite: 'lax' },
    { name: 'pref', value: 'made-up-2', domain: 'www.example.org', hostOnly: true, path: '/a', secure: false, httpOnly: false, session: false, expirationDate: now + 3600, sameSite: 'unspecified' },
    { name: 'tmp', value: 'made-up-3', domain: 'example.org', hostOnly: true, path: '/', session: true },
    { name: 'old', value: 'made-up-4', domain: 'example.org', hostOnly: true, path: '/', session: false, expirationDate: now - 5 },
    { name: 'soon', value: 'made-up-5', domain: 'example.org', hostOnly: true, path: '/', session: false, expirationDate: now + 30 },
    { name: '', value: 'x', domain: 'example.org', session: false, expirationDate: now + 999 },
  ];
  const r = await H.exportCookies(dir, 'made-up-id', made);
  assert.deepEqual(r, { count: 2 }, 'only the lasting ones');
  const file = path.join(dir, H.COOKIE_FILE); const notePath = path.join(dir, H.COOKIE_NOTE);
  const body = fs.readFileSync(file); const list = JSON.parse(body.toString('utf8'));
  assert.deepEqual(list.map((c) => c.name), ['sid', 'pref']);
  assert.deepEqual(Object.keys(list[0]).sort(), ['domain', 'expirationDate', 'hostOnly', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value'].sort(), 'the shape cookiecarry.rs reads');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'this user only');
  const note = JSON.parse(fs.readFileSync(notePath, 'utf8'));
  assert.equal(note.kind, 'browser-cookies'); assert.equal(note.id, 'made-up-id'); assert.equal(note.count, 2);
  assert.equal(note.size, body.length); assert.equal(note.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'marker.json'), 'utf8')).files.length, 0, 'not in the marker\'s list');
  // (A second export replaces the first; a drop wipes both.)
  assert.deepEqual(await H.exportCookies(dir, 'made-up-id', made.slice(1, 2)), { count: 1 });
  assert.equal(await H.dropCookies(dir), true);
  assert.ok(!fs.existsSync(file) && !fs.existsSync(notePath), 'wiped');
  assert.equal(await H.dropCookies(dir), true, 'nothing to wipe is fine');
  fs.rmSync(dir, { recursive: true, force: true });
  // (Never taken: wiped by the bridge build after 14 days, kept before.)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-hybrid-tidy-')); const hd = path.join(root, H.DIR); fs.mkdirSync(hd);
  fs.writeFileSync(path.join(hd, H.MARKER), JSON.stringify({ app: 'KurokawaTools', kind: 'handover', id: 'made-up-id', createdAt: Date.now(), files: [] }));
  await H.exportCookies(hd, 'made-up-id', made);
  assert.equal(await H.tidyCookies(root), false); assert.ok(fs.existsSync(path.join(hd, H.COOKIE_FILE)), 'a fresh one kept');
  assert.equal(await H.tidyCookies(root, Date.now() + 15 * 86400000), true); assert.ok(!fs.existsSync(path.join(hd, H.COOKIE_FILE)), 'an old one wiped');
  fs.rmSync(root, { recursive: true, force: true });

  // (The Electron build unchanged while the switch is off.)
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  assert.ok(/^const RUST_SWITCH = false;$/m.test(main), 'RUST_SWITCH stays false');
  const sw = main.indexOf('async function rustSwitch('); const end = main.indexOf('\n}\n', sw);
  const calls = [...main.matchAll(/Handover\.(exportCookies|dropCookies)\(/g)].map((m) => m.index);
  assert.ok(/if \(RUST_SWITCH\) void Handover\.tidyCookies\(/.test(main), 'the tidy only behind RUST_SWITCH');
  assert.ok(calls.length === 2 && calls.every((i) => i > sw && i < end), 'the export and its wipe only inside rustSwitch');
  assert.ok(/if \(RUST_SWITCH\) \{ const r = await rustSwitch\(e\)/.test(main), 'rustSwitch runs only with the switch on');
  // (The ffmpeg pack's digest of the program itself, for the adoption — packadopt.rs.)
  assert.ok(/unpackedSha256: crypto\.createHash\('sha256'\)\.update\(raw\)/.test(fs.readFileSync(path.join(ROOT, 'desktop', 'ffmpeg-pack.cjs'), 'utf8')), 'ffmpeg-pack.cjs gives unpackedSha256');
  console.log('hybridcookies: ok — 2 of 6 made-up cookies exported (session, expired, ending soon, nameless left out), 0600, the note\'s size and SHA-256, wiped; the export only behind RUST_SWITCH; the pack\'s program digest');
})().catch((e) => { console.error(e); process.exit(1); });
