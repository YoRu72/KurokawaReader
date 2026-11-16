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
pwd > "${note}/cwd"; printf '%s\\n' "$@" > "${note}/args"; pwd >> "${note}/calls"
[ -n "$KT_FAKE_ECHO" ] && { echo "failed: $*" >&2; exit 2; }
[ -n "$KT_FAKE_X" ] && { printf '\\r 5'; sleep 0.2; printf '0%% - a.txt\\r100%%\\n- a.txt\\n'; exit 0; }
[ -n "$KT_FAKE_FAIL" ] && { echo "Cannot open the thing" >&2; exit 2; }
part=""; take=0; for a in "$@"; do if [ "$take" = 1 ]; then part="$a"; break; fi; [ "$a" = "--" ] && take=1; done
printf '\\r  0%%\\r 40%% + one.txt\\r 80%% + two dir/b.txt' ; printf '\\n+ one.txt\\n+ two dir/b.txt\\n'
[ -n "$KT_FAKE_SLOW" ] && exec sleep 5
echo "7z-bytes" >> "$part"; exit 0
`, { mode: 0o755 });
process.env.PATH = bin + path.delimiter + process.env.PATH; delete process.env.KT_FAKE_FAIL; delete process.env.KT_FAKE_SLOW; delete process.env.KT_FAKE_ECHO;
const A = require('../desktop/archive.cjs');
const work = path.join(tmp, 'work'); fs.mkdirSync(path.join(work, 'two dir'), { recursive: true }); fs.writeFileSync(path.join(work, 'one.txt'), 'x'); fs.writeFileSync(path.join(work, 'two dir', 'b.txt'), 'y'); fs.writeFileSync(path.join(work, '-dash.txt'), 'z');
const args = () => fs.readFileSync(path.join(note, 'args'), 'utf8').trim().split('\n'); const cwd = () => fs.readFileSync(path.join(note, 'cwd'), 'utf8').trim();
const pr = (log, stop = () => false) => ({ on: (d, t, f) => log.push([d, t, f]), stopped: stop });
(async () => {
  const out = path.join(work, 'pack.7z'); const log = [];
  const n = await A.create7z(out, [path.join(work, 'one.txt'), path.join(work, 'two dir')], { level: 5 }, pr(log));
  ok('the archive is in place, no «.part» beside it', fs.existsSync(out) && !fs.readdirSync(work).some((x) => x.startsWith('pack.7z.kurokawa')) && fs.readFileSync(out, 'utf8').startsWith('7z-bytes'));
  const a = args(); ok('call: add, 7z type, level 5, answer yes, no wildcards (-spd), progress, then «--», the part, the names', a.slice(0, 7).join(' ') === 'a -t7z -mx=5 -y -spd -bsp1 -bb1' && a[7] === '--' && a[8].startsWith(out + '.kurokawa-') && a[8].endsWith('/part.7z') && a.slice(9).join('|') === 'one.txt|two dir', a);
  ok('run from the inputs\' own folder: names, never absolute paths', fs.realpathSync(cwd()) === fs.realpathSync(work) && !a.slice(9).some((x) => path.isAbsolute(x)));
  ok('no password: no -p and no header encryption', !a.some((x) => /^-p/.test(x) || /^-mhe/.test(x)));
  ok('progress reported (40 %, 80 %) with the file name; the end at 100', log.some((x) => x[0] === 40 && x[2] === 'one.txt') && log.some((x) => x[0] === 80) && log[log.length - 1][0] === 100, log);
  ok('files counted from the «+» lines: 2', n === 2, n);
  // the password: contents and names both
  await A.create7z(out, [path.join(work, 'one.txt')], { level: 9, password: 'se cret', replace: true }, pr([]));
  const b = args(); ok('password: -p<pw> and -mhe=on (the names encrypted too) before «--»; level 9', b.includes('-pse cret') && b.includes('-mhe=on') && b.indexOf('-mhe=on') < b.indexOf('--') && b.includes('-mx=9'), b);
  for (const [lv, want] of [[0, '-mx=0'], [1, '-mx=1'], [undefined, '-mx=5'], [4, '-mx=5'], ['9', '-mx=9']]) { await A.create7z(out, [path.join(work, 'one.txt')], { level: lv, replace: true }, pr([])); ok(`level ${lv}: ${want}`, args().includes(want), args()); }
  // a name that starts with «-» is a name, not a switch
  await A.create7z(out, [path.join(work, '-dash.txt')], { replace: true }, pr([])); const d = args(); ok('«-dash.txt» comes after «--»', d.indexOf('-dash.txt') > d.indexOf('--'), d);
  // two folders: 7-Zip runs once in each, given the names there (relative, never absolute); one archive
  const other = path.join(tmp, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'o.txt'), 'o'); fs.writeFileSync(path.join(note, 'calls'), '');
  const out2 = path.join(work, 'two.7z'); const log2 = []; await A.create7z(out2, [path.join(work, 'one.txt'), path.join(other, 'o.txt')], {}, pr(log2));
  const calls = fs.readFileSync(path.join(note, 'calls'), 'utf8').trim().split('\n').map((x) => fs.realpathSync(x));
  ok('inputs from two folders: 7-Zip run once in each folder', calls.length === 2 && calls[0] === fs.realpathSync(work) && calls[1] === fs.realpathSync(other), calls);
  ok('… the second call gave its name relative to its own folder', args().slice(9).join('|') === 'o.txt', args());
  ok('… one archive, progress spans both runs and ends at 100', fs.existsSync(out2) && log2.some((x) => x[1] === 200) && log2[log2.length - 1][0] === 100, log2.slice(-2));
  fs.writeFileSync(path.join(note, 'args'), 'untouched'); fs.writeFileSync(path.join(other, 'one.txt'), 'dup');
  await assert.rejects(() => A.create7z(path.join(work, 'dup.7z'), [path.join(work, 'one.txt'), path.join(other, 'one.txt')], {}, pr([])), /sevenZipSameName/); ok('two inputs of one name from two folders refused, 7-Zip not run', fs.readFileSync(path.join(note, 'args'), 'utf8') === 'untouched');
  // names that look like switches, list files or wildcards are names: -spd, and everything after «--» verbatim
  const odd = ['@list.txt', '-dash.txt', 'star*.txt', 'q?.txt', '[x].txt']; for (const n of odd) fs.writeFileSync(path.join(work, n), 'z');
  await A.create7z(path.join(work, 'odd.7z'), odd.map((n) => path.join(work, n)), {}, pr([])); const od = args();
  ok('names «@», «-», «*», «?», «[ ]»: -spd before «--», the names verbatim after it', od.indexOf('-spd') > 0 && od.indexOf('-spd') < od.indexOf('--') && od.slice(od.indexOf('--') + 2).join('|') === odd.join('|'), od);
  // the output must not lie inside an input (it would be packed into itself)
  fs.writeFileSync(path.join(note, 'args'), 'untouched');
  await assert.rejects(() => A.create7z(path.join(work, 'two dir', 'x.7z'), [path.join(work, 'two dir')], {}, pr([])), /sevenZipOutInside/); await assert.rejects(() => A.create7z(path.join(work, 'one.txt'), [path.join(work, 'one.txt')], { replace: true }, pr([])), /sevenZipOutInside/);
  ok('an output inside an input (or the input itself) refused, 7-Zip not run', fs.readFileSync(path.join(note, 'args'), 'utf8') === 'untouched');
  // an existing archive is not replaced unless the caller says so
  const before = fs.readFileSync(out2); await assert.rejects(() => A.create7z(out2, [path.join(work, 'one.txt')], {}, pr([])), /sevenZipExists/); ok('an existing «.7z» is refused unless replace is set, and untouched', Buffer.compare(fs.readFileSync(out2), before) === 0 && fs.readFileSync(path.join(note, 'args'), 'utf8') === 'untouched');
  await A.create7z(out2, [path.join(work, 'one.txt')], { replace: true }, pr([])); ok('… with replace it is replaced', fs.readFileSync(out2, 'utf8') === '7z-bytes\n');
  await assert.rejects(() => A.create7z(out, [path.join(work, 'missing.txt')], {}, pr([])), /notFound/); ok('a missing input refused', true);
  // a failure: the error says why; nothing left
  const keep = fs.readFileSync(out); process.env.KT_FAKE_FAIL = '1';
  await assert.rejects(() => A.create7z(out, [path.join(work, 'one.txt')], { replace: true }, pr([])), /Cannot open the thing/); ok('7-Zip failing: its message is the error, the old archive untouched, no «.part»', Buffer.compare(fs.readFileSync(out), keep) === 0 && !fs.existsSync(out + '.kurokawa-part'));
  delete process.env.KT_FAKE_FAIL;
  // Cancel while it runs
  process.env.KT_FAKE_SLOW = '1'; let stop = false; setTimeout(() => { stop = true; }, 600); const t0 = Date.now();
  await assert.rejects(() => A.create7z(out, [path.join(work, 'one.txt')], { replace: true }, pr([], () => stop)), /stopped/); ok(`Cancel: stopped within ${Date.now() - t0} ms, nothing left`, Date.now() - t0 < 3000 && !fs.readdirSync(work).some((x) => x.startsWith('pack.7z.kurokawa')));
  delete process.env.KT_FAKE_SLOW;
  // the password never leaves in an error: 7-Zip printing its command line, and 7-Zip not found at all
  process.env.KT_FAKE_ECHO = '1'; let msg = ''; try { await A.create7z(out, [path.join(work, 'one.txt')], { password: 'hunter2-pw', replace: true }, pr([])); } catch (e) { msg = String(e && e.message); }
  ok('7-Zip echoing its arguments: the error text has no password (' + msg.slice(0, 60) + ')', msg && !msg.includes('hunter2-pw') && msg.includes('***'), msg); delete process.env.KT_FAKE_ECHO;
  fs.renameSync(fake, fake + '.off'); let err2 = null; try { await A.create7z(out, [path.join(work, 'one.txt')], { password: 'hunter2-pw', replace: true }, pr([])); } catch (e) { err2 = e; }
  fs.renameSync(fake + '.off', fake);
  ok('7-Zip missing: only «sevenZipMissing» comes out — no password, no spawn arguments on the error', err2 && err2.message === 'sevenZipMissing' && !JSON.stringify(Object.getOwnPropertyNames(err2).map((k) => String(err2[k]))).includes('hunter2-pw') && !('spawnargs' in err2), err2 && err2.message);
  ok('the scrub function takes it out of any text', A.scrub('x -phunter2-pw y hunter2-pw', 'hunter2-pw') === 'x -p*** y ***' && A.scrub('plain', 'hunter2-pw') === 'plain' && A.scrub('plain') === 'plain');
  // putting in place: one rename over the target (never remove-then-rename); a stage folder of this run's own; a stale one of a crashed run left alone
  const stale = path.join(work, 'pack.7z.kurokawa-part'); fs.writeFileSync(stale, 'stale'); const outR = path.join(work, 'r.7z'); fs.writeFileSync(outR, 'OLD');
  const realRm = fs.promises.rm; const rmSeen = []; fs.promises.rm = async (f, ...r) => { rmSeen.push(String(f)); return realRm.call(fs.promises, f, ...r); };
  await A.create7z(outR, [path.join(work, 'one.txt')], { replace: true }, pr([])); fs.promises.rm = realRm; const ra = args();
  ok('replace: the old archive was never removed before the new one came (no rm of the target)', !rmSeen.includes(outR) && fs.readFileSync(outR, 'utf8') === '7z-bytes\n', rmSeen);
  ok('the part is built in a folder made by this run beside the target (name with pid and random), not in a fixed «.kurokawa-part»', path.dirname(ra[8]).startsWith(outR + '.kurokawa-') && path.basename(ra[8]) === 'part.7z' && ra[8] !== stale && !fs.existsSync(path.dirname(ra[8])), ra[8]);
  ok('a stale part of a crashed run is not touched or written into', fs.readFileSync(stale, 'utf8') === 'stale'); fs.rmSync(stale);
  await A.create7z(outR, [path.join(work, 'one.txt')], { replace: true }, pr([])); const rb = args(); ok('two runs, two different stage folders', path.dirname(rb[8]) !== path.dirname(ra[8]));
  fs.writeFileSync(path.join(work, 'link-target'), 'T'); const lnk = path.join(work, 'sym.7z'); fs.symlinkSync(path.join(work, 'link-target'), lnk);
  await assert.rejects(() => A.create7z(lnk, [path.join(work, 'one.txt')], {}, pr([])), /sevenZipExists/); ok('a link at the target name is not followed (counts as taken); the link target untouched', fs.readFileSync(path.join(work, 'link-target'), 'utf8') === 'T'); fs.rmSync(lnk);
  // extracting and testing: the same line reader, a small tail only, and the password out of every message
  process.env.KT_FAKE_X = '1'; const xl = []; const xn = await A.extract7z(path.join(work, 'one.txt'), path.join(tmp, 'xo'), { password: 'hunter2-pw' }, pr(xl)); delete process.env.KT_FAKE_X;
  ok('extract: a progress line split between two reads is joined (50 % - a.txt), CR ends one, files counted', xl.some((x) => x[0] === 50 && x[2] === 'a.txt') && xn === 1, [xl, xn]);
  process.env.KT_FAKE_ECHO = '1'; let m2 = ''; try { await A.extract7z(path.join(work, 'one.txt'), path.join(tmp, 'xo'), { password: 'hunter2-pw' }, pr([])); } catch (e) { m2 = String(e && e.message); } delete process.env.KT_FAKE_ECHO;
  ok('extract: 7-Zip echoing its arguments: no password in the error', m2 && !m2.includes('hunter2-pw'), m2);
  fs.renameSync(fake, fake + '.off'); let m3 = null; try { await A.extract7z(path.join(work, 'one.txt'), path.join(tmp, 'xo'), { password: 'hunter2-pw' }, pr([])); } catch (e) { m3 = e; } let m4 = null; try { await A.test(path.join(work, 'x.7z'), 'hunter2-pw', pr([])); } catch (e) { m4 = e; } fs.renameSync(fake + '.off', fake);
  ok('extract with 7-Zip missing: only «sevenZipMissing»', m3 && m3.message === 'sevenZipMissing' && !String(m3.stack).includes('hunter2-pw'), m3 && m3.message);
  ok('test with 7-Zip missing (or any failure): the result carries no password', !JSON.stringify(m4 || {}).includes('hunter2-pw'));
  // progress parsing: a line split between two reads, carriage returns, backspaces; nothing but the unfinished part is kept
  const L = A.makeLines(); const got = [...L.feed('  5% 1 + a'), ...L.feed('.txt\r 10% 2 + b.txt\r'), ...L.feed(' 20%\b\b\b\b 30% 3 + c\n'), ...L.feed('tail')];
  ok('lines: a split line is joined; carriage return, newline and backspace all end a line', JSON.stringify(got) === JSON.stringify(['  5% 1 + a.txt', ' 10% 2 + b.txt', ' 20%', ' 30% 3 + c']) && L.finish() === 'tail', got);
  const L2 = A.makeLines(); L2.feed('x'.repeat(1000000)); ok('lines: a million characters without an end do not pile up', L2.finish().length <= 4096);
  ok('progress line: percent and name', JSON.stringify(A.seven7Progress(' 40% 1 + one.txt')) === '{"pct":40,"name":"one.txt"}' && A.seven7Progress('+ one.txt') === null && A.seven7Progress(' 7%').pct === 7);
  fs.rmSync(tmp, { recursive: true, force: true }); console.log(fails ? `\n${fails} failed` : '\nall ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e); process.exit(1); });
