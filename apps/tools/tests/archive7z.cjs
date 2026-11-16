// Making a 7z on a computer: desktop/archive.cjs create7z over the 7-Zip the app ships — here a stand-in program on the PATH
// (no real 7-Zip is needed; made-up files only) that records how it was called, writes the archive file it was told to, and prints
// progress the way 7-Zip does (-bsp1 -bb1). Checks the call (level, the password with header encryption, names not paths, «--»),
// the progress, the file put in place only when whole, Cancel, a failure, inputs from two folders.
// Run: node tests/archive7z.cjs
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert');
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 300))); if (!cond) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-7z-')); const bin = path.join(tmp, 'bin'); const note = path.join(tmp, 'note'); fs.mkdirSync(bin); fs.mkdirSync(note);
const fake = path.join(bin, process.platform === 'win32' ? '7z.cmd' : '7z');
fs.writeFileSync(fake, `#!/bin/sh
pwd > "${note}/cwd"; printf '%s\\n' "$@" > "${note}/args"
[ -n "$KT_FAKE_FAIL" ] && { echo "Cannot open the thing" >&2; exit 2; }
part=""; take=0; for a in "$@"; do if [ "$take" = 1 ]; then part="$a"; break; fi; [ "$a" = "--" ] && take=1; done
printf '\\r  0%%\\r 40%% + one.txt\\r 80%% + two dir/b.txt' ; printf '\\n+ one.txt\\n+ two dir/b.txt\\n'
[ -n "$KT_FAKE_SLOW" ] && exec sleep 5
echo "7z-bytes" > "$part"; exit 0
`, { mode: 0o755 });
process.env.PATH = bin + path.delimiter + process.env.PATH; delete process.env.KT_FAKE_FAIL; delete process.env.KT_FAKE_SLOW;
const A = require('../desktop/archive.cjs');
const work = path.join(tmp, 'work'); fs.mkdirSync(path.join(work, 'two dir'), { recursive: true }); fs.writeFileSync(path.join(work, 'one.txt'), 'x'); fs.writeFileSync(path.join(work, 'two dir', 'b.txt'), 'y'); fs.writeFileSync(path.join(work, '-dash.txt'), 'z');
const args = () => fs.readFileSync(path.join(note, 'args'), 'utf8').trim().split('\n'); const cwd = () => fs.readFileSync(path.join(note, 'cwd'), 'utf8').trim();
const pr = (log, stop = () => false) => ({ on: (d, t, f) => log.push([d, t, f]), stopped: stop });
(async () => {
  const out = path.join(work, 'pack.7z'); const log = [];
  const n = await A.create7z(out, [path.join(work, 'one.txt'), path.join(work, 'two dir')], { level: 5 }, pr(log));
  ok('the archive is in place, no «.part» beside it', fs.existsSync(out) && !fs.existsSync(out + '.kurokawa-part') && fs.readFileSync(out, 'utf8').startsWith('7z-bytes'));
  const a = args(); ok('call: add, 7z type, level 5, answer yes, progress, then «--», the part, the names', a.slice(0, 6).join(' ') === 'a -t7z -mx=5 -y -bsp1 -bb1' && a[6] === '--' && a[7] === out + '.kurokawa-part' && a.slice(8).join('|') === 'one.txt|two dir', a);
  ok('run from the inputs\' own folder: names, never absolute paths', fs.realpathSync(cwd()) === fs.realpathSync(work) && !a.slice(8).some((x) => path.isAbsolute(x)));
  ok('no password: no -p and no header encryption', !a.some((x) => /^-p/.test(x) || /^-mhe/.test(x)));
  ok('progress reported (40 %, 80 %) with the file name; the end at 100', log.some((x) => x[0] === 40 && x[2] === 'one.txt') && log.some((x) => x[0] === 80) && log[log.length - 1][0] === 100, log);
  ok('files counted from the «+» lines: 2', n === 2, n);
  // the password: contents and names both
  await A.create7z(out, [path.join(work, 'one.txt')], { level: 9, password: 'se cret' }, pr([]));
  const b = args(); ok('password: -p<pw> and -mhe=on (the names encrypted too) before «--»; level 9', b.includes('-pse cret') && b.includes('-mhe=on') && b.indexOf('-mhe=on') < b.indexOf('--') && b.includes('-mx=9'), b);
  for (const [lv, want] of [[0, '-mx=0'], [1, '-mx=1'], [undefined, '-mx=5'], [4, '-mx=5'], ['9', '-mx=9']]) { await A.create7z(out, [path.join(work, 'one.txt')], { level: lv }, pr([])); ok(`level ${lv}: ${want}`, args().includes(want), args()); }
  // a name that starts with «-» is a name, not a switch
  await A.create7z(out, [path.join(work, '-dash.txt')], {}, pr([])); const d = args(); ok('«-dash.txt» comes after «--»', d.indexOf('-dash.txt') > d.indexOf('--'), d);
  // two folders: refused before anything runs
  fs.writeFileSync(path.join(note, 'args'), 'untouched'); await assert.rejects(() => A.create7z(out, [path.join(work, 'one.txt'), path.join(tmp, 'other.txt')], {}, pr([])), /sevenZipOneFolder/); ok('inputs from two folders refused, 7-Zip not run', fs.readFileSync(path.join(note, 'args'), 'utf8') === 'untouched');
  await assert.rejects(() => A.create7z(out, [path.join(work, 'missing.txt')], {}, pr([])), /notFound/); ok('a missing input refused', true);
  // a failure: the error says why; nothing left
  const keep = fs.readFileSync(out); process.env.KT_FAKE_FAIL = '1';
  await assert.rejects(() => A.create7z(out, [path.join(work, 'one.txt')], {}, pr([])), /Cannot open the thing/); ok('7-Zip failing: its message is the error, the old archive untouched, no «.part»', Buffer.compare(fs.readFileSync(out), keep) === 0 && !fs.existsSync(out + '.kurokawa-part'));
  delete process.env.KT_FAKE_FAIL;
  // Cancel while it runs
  process.env.KT_FAKE_SLOW = '1'; let stop = false; setTimeout(() => { stop = true; }, 600); const t0 = Date.now();
  await assert.rejects(() => A.create7z(out, [path.join(work, 'one.txt')], {}, pr([], () => stop)), /stopped/); ok(`Cancel: stopped within ${Date.now() - t0} ms, nothing left`, Date.now() - t0 < 3000 && !fs.existsSync(out + '.kurokawa-part'));
  fs.rmSync(tmp, { recursive: true, force: true }); console.log(fails ? `\n${fails} failed` : '\nall ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e); process.exit(1); });
