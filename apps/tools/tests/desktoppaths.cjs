// node tests/desktoppaths.cjs: Windows paths in the desktop shell (desktop/paths.cjs, and the Task mapping of desktop/aria2.cjs
// through it): aria2 reports "C:/…" while the folder keeps its "\"; the page wants files[].path relative to dir with "/".
const os = require('os'); const path = require('path'); const fs = require('fs');
const { nativePath, relPath } = require('../desktop/paths.cjs');
const { Aria2Engine } = require('../desktop/aria2.cjs');
let fails = 0; const eq = (n, a, b) => { const c = a === b; console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : `  got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)); if (!c) fails++; };
const W = 'win32';
const rel = (f, d) => relPath(f, d, W), nat = (p) => nativePath(p, W);
// nativePath
eq('native: forward slashes', nat('C:/Users/me/Downloads/Kurokawa/Show/e1.mkv'), 'C:\\Users\\me\\Downloads\\Kurokawa\\Show\\e1.mkv');
eq('native: mixed (renamed)', nat('C:/Users/me/dl\\new name.mkv'), 'C:\\Users\\me\\dl\\new name.mkv');
eq('native: drive letter case kept (lower)', nat('c:/dl/x'), 'c:\\dl\\x');
eq('native: drive letter case kept (upper)', nat('D:/dl/x'), 'D:\\dl\\x');
eq('native: \\\\?\\ prefix', nat('\\\\?\\C:\\dl\\x.mkv'), 'C:\\dl\\x.mkv');
eq('native: \\\\?\\UNC\\ prefix', nat('\\\\?\\UNC\\s\\x'), '\\\\s\\x');
eq('native: //?/ prefix', nat('//?/C:/dl/x'), 'C:\\dl\\x');
eq('native: UNC backslashes kept', nat('\\\\server\\share\\a\\b.mkv'), '\\\\server\\share\\a\\b.mkv');
eq('native: UNC forward slashes', nat('//server/share/a/b.mkv'), '\\\\server\\share\\a\\b.mkv');
eq('native: doubled separators collapsed', nat('C:\\dl\\\\Show//e1.mkv'), 'C:\\dl\\Show\\e1.mkv');
eq('native: empty', nat(''), '');
// relPath on Windows
eq('rel: forward-slash file, backslash dir', rel('C:/Users/me/Downloads/Kurokawa/Show/e1.mkv', 'C:\\Users\\me\\Downloads\\Kurokawa'), 'Show/e1.mkv');
eq('rel: single file', rel('C:/dl/file.zip', 'C:\\dl'), 'file.zip');
eq('rel: both backslash', rel('C:\\dl\\Show\\e1.mkv', 'C:\\dl'), 'Show/e1.mkv');
eq('rel: mixed / renamed', rel('C:/Users/me/dl\\new.mkv', 'C:\\Users\\me\\dl'), 'new.mkv');
eq('rel: trailing separator on dir', rel('C:/dl/Show/e1.mkv', 'C:\\dl\\'), 'Show/e1.mkv');
eq('rel: trailing forward slash on dir', rel('C:/dl/Show/e1.mkv', 'C:/dl/'), 'Show/e1.mkv');
eq('rel: case-insensitive prefix', rel('c:/USERS/me/dl/x.mkv', 'C:\\Users\\Me\\DL'), 'x.mkv');
eq('rel: sibling sharing a prefix is outside', rel('C:/dl2/x.mkv', 'C:\\dl'), 'C:\\dl2\\x.mkv');
eq('rel: file outside dir keeps full native path', rel('D:/other/x.mkv', 'C:\\dl'), 'D:\\other\\x.mkv');
eq('rel: multi-file torrent', rel('C:/dl/Show/e1.mkv', 'C:\\dl'), 'Show/e1.mkv');
eq('rel: multi-file torrent, nested', rel('C:/dl/Show/S1/e2.mkv', 'C:\\dl'), 'Show/S1/e2.mkv');
eq('rel: UNC backslash dir, forward file', rel('//server/share/dl/x.mkv', '\\\\server\\share\\dl'), 'x.mkv');
eq('rel: UNC both', rel('\\\\server\\share\\dl\\a\\x.mkv', '\\\\server\\share\\dl'), 'a/x.mkv');
eq('rel: \\\\?\\ file against plain dir', rel('\\\\?\\C:\\dl\\Show\\e1.mkv', 'C:\\dl'), 'Show/e1.mkv');
eq('rel: \\\\?\\UNC\\ file against UNC dir', rel('\\\\?\\UNC\\s\\x\\a.mkv', '\\\\s\\x'), 'a.mkv');
eq('rel: drive root dir', rel('C:/x.mkv', 'C:\\'), 'x.mkv');
eq('rel: empty file', rel('', 'C:\\dl'), '');
// other platforms: unchanged
for (const P of ['linux', 'darwin']) {
  eq(`${P}: native unchanged`, nativePath('C:/a\\b//c', P), 'C:/a\\b//c');
  eq(`${P}: native unchanged (prefix)`, nativePath('\\\\?\\C:\\x', P), '\\\\?\\C:\\x');
  eq(`${P}: relative as before`, relPath('/dl/Show/e1.mkv', '/dl', P), 'Show/e1.mkv');
  eq(`${P}: single file`, relPath('/dl/file.zip', '/dl', P), 'file.zip');
  eq(`${P}: outside kept`, relPath('/other/x.mkv', '/dl', P), '/other/x.mkv');
  eq(`${P}: file name with a backslash left alone`, relPath('/dl/a\\b.mkv', '/dl', P), 'a\\b.mkv');
  eq(`${P}: backslash name in a folder`, relPath('/dl/Show/a\\b.mkv', '/dl', P), 'Show/a\\b.mkv');
  eq(`${P}: backslash path not treated as dir`, relPath('/dl/x', 'C:\\dl', P), '/dl/x');
}
// the real Task mapping (Aria2Engine.task, a fake aria2 status; no Electron, no aria2)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktpaths-'));
const eng = (platform) => new Aria2Engine({ userData: tmp, resources: tmp, defaultDir: path.join(tmp, 'dl'), platform });
const st = (dir, files, extra) => ({ gid: 'g1', status: 'complete', totalLength: '10', completedLength: '10', downloadSpeed: '0', uploadSpeed: '0', connections: '0', dir, files: files.map((p, i) => ({ index: String(i + 1), path: p, length: '5', completedLength: '5', selected: 'true', uris: [] })), ...extra });
{
  const e = eng(W);
  const t = e.task(st('C:\\Users\\me\\Downloads\\Kurokawa', ['C:/Users/me/Downloads/Kurokawa/Show/e1.mkv', 'C:/Users/me/Downloads/Kurokawa/Show/e2.mkv'], { bittorrent: { info: { name: 'Show' } }, infoHash: 'abc' }));
  eq('task(win): dir native', t.dir, 'C:\\Users\\me\\Downloads\\Kurokawa');
  eq('task(win): files[0].path', t.files[0].path, 'Show/e1.mkv'); eq('task(win): files[1].path', t.files[1].path, 'Show/e2.mkv');
  const r = eng(W); r.keep.g1 = { renamed: 'C:/Users/me/dl\\new name.mkv' };
  const t2 = r.task(st('C:\\Users\\me\\dl\\', ['C:/Users/me/dl/old.mkv'], {}));
  eq('task(win): renamed file relative', t2.files[0].path, 'new name.mkv'); eq('task(win): trailing separator on dir dropped', t2.dir, 'C:\\Users\\me\\dl');
  const t3 = eng(W).task(st('\\\\?\\UNC\\s\\x', ['//s/x/a/b.mkv'], {}));
  eq('task(win): UNC dir without prefix', t3.dir, '\\\\s\\x'); eq('task(win): UNC file relative', t3.files[0].path, 'a/b.mkv');
  const t4 = eng(W).task(st('C:\\dl', ['C:/dl2/x.mkv'], {})); eq('task(win): sibling folder kept whole', t4.files[0].path, 'C:\\dl2\\x.mkv');
  eq('task(win): fileOf-style np of a forward path', e.np('C:/dl/a.mkv'), 'C:\\dl\\a.mkv');
  const l = eng('linux').task(st('/home/me/dl', ['/home/me/dl/Show/e1.mkv'], {})); eq('task(linux): unchanged', l.files[0].path + '|' + l.dir, 'Show/e1.mkv|/home/me/dl');
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
