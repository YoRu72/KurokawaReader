// Kurokawa in other apps' «Open with» / «Share» lists, and Files' own app chooser (made-up data only).
// 1. The table (native/android/openwith.json): every entry's actions, types and path patterns; no pattern without a
//    host; the defaults (picture, text and catch-all off); English and Arabic labels, the same in the Android string
//    resources; the page's copy (views/openWithLogic.ts) and the Java twin (KtOpenActivity.KINDS) the same; the Java
//    type-checked against stubs (tests/native/openwith.sh) when javac is here.
// 2. The manifest written by native/android/manifest.mjs on a fixture (Capacitor's own): the aliases there, each
//    enabled as the table says; the .torrent filter given its host (no longer every octet-stream file); Android's
//    matching rules run over it for a few files; the build's check refusing a pattern without a host and a claim twice;
//    nothing else changed against the snapshot of the output before this work.
// 3. The plain logic: the request read, the way for each kind, MPEG-TS against TypeScript, the text codec, the
//    chooser's list and the defaults kept.
// 4. The page on the pretend phone (tests/filesphone-fixture.cjs): each kind handed in — an archive here and one that
//    is only a link, two archives shared, a folder, a folder not on the phone, a link nobody can read, a 6 GB file, an
//    Arabic subtitle in Windows-1256 edited and written back, a text the other app does not let us change —, Back
//    handing back to the caller; «.ts» TypeScript opened as text; the switches (phone, English and Arabic) and their
//    absence on a computer; the chooser «Just once» / «Always» and the defaults list.
// KT_SHOTS=<dir>: screenshots (360 px wide, twice the pixels). Run: NODE_PATH=$(npm root -g) node tests/openwith.cjs
const fs = require('node:fs'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'); const A = path.join(ROOT, 'native', 'android');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const load = (file) => { const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild')); const out = esbuild.buildSync({ entryPoints: [path.join(ROOT, file)], bundle: true, format: 'cjs', platform: 'node', write: false }); const m = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports); return m.exports; };

function table() {
  const T = JSON.parse(fs.readFileSync(path.join(A, 'openwith.json'), 'utf8')); const E = T.entries; const gen = E.filter((e) => e.generated);
  ok('seven aliases written from the table, four hand-written ones switchable', gen.map((e) => e.alias).join() === 'KtArchive,KtArchiveShare,KtFolder,KtImage,KtText,KtAnyFile,KtBrowse' && E.filter((e) => !e.generated).map((e) => e.alias).join() === 'KtSave,KtPickActivity,KtInstaller,KtPlayer');
  ok('defaults: picture, text and the catch-all off, the rest on', E.filter((e) => !e.on).map((e) => e.id).join() === 'image,text,any');
  ok('every filter with path patterns has android:host="*" and content/file', gen.every((e) => e.filters.every((f) => !f.exts || (f.host === '*' && JSON.stringify(f.schemes) === '["content","file"]'))));
  const arc = E.find((e) => e.id === 'archive'); const exts = arc.filters[1].exts;
  ok('archives: what archives.ts reads (zip, cbz, 7z, rar, tar, tgz, txz, tbz2, gz, xz, bz2, .001, .z01)', ['zip', 'cbz', '7z', 'rar', 'tar', 'tgz', 'txz', 'tbz2', 'gz', 'xz', 'bz2', '001', 'z01'].every((x) => exts.includes(x)));
  ok('the archive types by MIME too (a provider without a name)', ['application/zip', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-tar', 'application/gzip'].every((m) => arc.filters[0].mimes.includes(m)));
  ok('«Extract with Kurokawa»: SEND and SEND_MULTIPLE of archives only (never */*)', JSON.stringify(E.find((e) => e.id === 'archiveShare').filters[0].actions) === '["android.intent.action.SEND","android.intent.action.SEND_MULTIPLE"]' && !E.find((e) => e.id === 'archiveShare').filters[0].mimes.includes('*/*'));
  const text = E.find((e) => e.id === 'text');
  ok('text: VIEW and EDIT, subtitles and settings files by name', text.filters.every((f) => f.actions.includes('android.intent.action.EDIT')) && ['ass', 'ssa', 'srt', 'vtt', 'sub', 'lrc', 'md', 'log', 'ini', 'conf', 'cfg', 'yaml', 'toml', 'csv', 'nfo', 'm3u'].every((x) => text.filters[1].exts.includes(x)));
  ok('folder: resource/folder, inode/directory, vnd.android.document/directory and OpenIntents\' VIEW_DIRECTORY', ['resource/folder', 'inode/directory', 'vnd.android.document/directory'].every((m) => E.find((e) => e.id === 'folder').filters[0].mimes.includes(m)) && E.find((e) => e.id === 'folder').filters[1].actions[0] === 'org.openintents.action.VIEW_DIRECTORY');
  ok('browse: VIEW_DOWNLOADS and the storage roots', JSON.stringify(E.find((e) => e.id === 'browse').filters.map((f) => f.actions[0])) === '["android.intent.action.VIEW_DOWNLOADS","android.intent.action.VIEW"]');
  ok('every entry named in English and Arabic', E.every((e) => e.label.en && /[؀-ۿ]/.test(e.label.ar)));
  for (const [dir, lang] of [['values', 'en'], ['values-ar', 'ar']]) {
    const xml = fs.readFileSync(path.join(A, 'res', dir, 'kt_openwith.xml'), 'utf8');
    ok(`res/${dir}: each generated alias's name, as the table says`, gen.every((e) => xml.includes(`<string name="${e.res}">${e.label[lang]}</string>`)));
  }
  const L = load('src/views/openWithLogic.ts');
  ok('the page reads the same table', JSON.stringify(L.ENTRIES) === JSON.stringify(E) && JSON.stringify([...L.KINDS]) === JSON.stringify(gen.map((e) => e.id)));
  const java = fs.readFileSync(path.join(A, 'KtOpenActivity.java'), 'utf8'); const kinds = [...java.matchAll(/\{ "(Kt\w+)", "(\w+)" \}/g)].map((m) => `${m[1]}=${m[2]}`);
  ok('the Java twin (KtOpenActivity.KINDS) the same', JSON.stringify(kinds) === JSON.stringify(gen.map((e) => `${e.alias}=${e.id}`)), kinds);
  const main = fs.readFileSync(path.join(A, 'MainActivity.java'), 'utf8');
  ok('MainActivity: kurokawatools://open → #/open?…, and «.ts» read before it is called a video', /"open"\.equals\(d\.getHost\(\)\)/.test(main) && /#\/open\?/.test(main) && /return isMpegTs\(d\)/.test(main) && !/\|ts\|m2ts/.test(main));
  ok('MainActivity.looksMpegTs: the same packet test as the page\'s sniffTs', /b\[0\] == 0x47 && b\[188\] == 0x47/.test(main) && /b\[4\] == 0x47 && b\[196\] == 0x47/.test(main));
  const plugin = fs.readFileSync(path.join(A, 'KtPlugin.java'), 'utf8');
  ok('the plugin: request, fetch, done, bytes, switches, apps', ['openRequest', 'openFetch', 'openFetchCancel', 'openDone', 'uriRead', 'uriWrite', 'contentUrl', 'openWithStates', 'openWithSet', 'appsFor', 'openIn'].every((m) => new RegExp(`@PluginMethod public void ${m}\\(`).test(plugin)));
  ok('pickerStorage: the provider switched with DONT_KILL_APP, the state read back; the default applied once at load; no provider links handed out while it is off', /public void pickerStorage\(/.test(plugin) && /pickerProvider\(\), want \?/.test(plugin) && /applyPickerDefault\(\);/.test(plugin) && /applyDefaultNow\(sp\.getBoolean\("pickerDefault"/.test(plugin) && /if \(providerOn\(\)\) try \{ return android\.provider\.DocumentsContract\.buildDocumentUri\(KtDocumentsProvider\.AUTHORITY/.test(fs.readFileSync(path.join(A, 'KtPickActivity.java'), 'utf8')));
  ok('switches: DONT_KILL_APP, only Kt… names', /setComponentEnabledSetting\([^;]*DONT_KILL_APP\)/.test(plugin) && /matches\("Kt\[A-Za-z\]\+"\)/.test(plugin));
  ok('overlay copies KtOpenActivity.java', fs.readFileSync(path.join(A, 'overlay.mjs'), 'utf8').includes("'KtOpenActivity.java'"));
  let javac = false; try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); javac = true; } catch { /* none */ }
  if (javac) { try { const out = execFileSync('sh', [path.join(__dirname, 'native', 'openwith.sh')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); ok('KtOpenActivity compiles against the stubs and maps its aliases', /all passed/.test(out), out); } catch (e) { ok('KtOpenActivity compiles against the stubs', false, String(e.stdout || e.message)); } }
  else console.log('skip KtOpenActivity javac check (no javac)');
  return L;
}

/** Android's intent-filter matching, the parts that matter here (action, type with wildcards, scheme, host, path glob). */
function matches(f, intent) {
  if (!f.actions.includes(intent.action)) return false;
  const glob = (pat, s) => { const re = '^' + pat.replace(/\\\\\./g, '\u0001').replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '.' ? '.' : c === '*' ? '*' : '\\' + c)).replace(/\u0001/g, '\\.') + '$'; return new RegExp(re).test(s); };
  if (f.mimes.length) { if (!intent.mime) return false; const [t, s] = intent.mime.split('/'); if (!f.mimes.some((m) => { const [ft, fs] = m.split('/'); return (ft === '*' || ft === t) && (fs === '*' || fs === s); })) return false; } else if (intent.mime) return false;
  if (f.schemes.length) { if (!f.schemes.includes(intent.scheme)) return false; } else if (intent.scheme && !['content', 'file'].includes(intent.scheme)) return false;
  if (f.hosts.length) { if (!f.hosts.some((h) => h === '*' || h === intent.host)) return false; if (f.patterns.length && !f.patterns.some((p) => glob(p, intent.path))) return false; }
  return true;
}

async function manifest() {
  const M = await import(path.join(A, 'manifest.mjs'));
  const fixture = fs.readFileSync(path.join(__dirname, 'data', 'openwith', 'AndroidManifest.xml'), 'utf8');
  const before = fs.readFileSync(path.join(__dirname, 'data', 'openwith', 'manifest-before.xml'), 'utf8');
  const out = M.patchManifest(fixture); const F = M.readFilters(out);
  ok('patched again: nothing added twice', M.patchManifest(out) === out);
  ok('the check finds nothing wrong in the app\'s manifest', M.checkFilters(out).length === 0, M.checkFilters(out));
  const T = M.OPEN_WITH;
  for (const e of T.entries.filter((x) => x.generated)) {
    const tag = new RegExp(`<activity-alias android:name="\\.${e.alias}" android:targetActivity="\\.KtOpenActivity" android:enabled="${e.on}" android:exported="true" android:label="@string/${e.res}"`).test(out);
    ok(`${e.alias}: an alias of KtOpenActivity, enabled="${e.on}", labelled @string/${e.res}, ${e.filters.length} filter(s)`, tag && F.filter((f) => f.component === `.${e.alias}`).length === e.filters.length);
  }
  ok('KtOpenActivity declared once, translucent, out of Recents', (out.match(/<activity android:name="\.KtOpenActivity"/g) || []).length === 1 && /KtOpenActivity"[^>]*Theme\.Translucent\.NoTitleBar[^>]*excludeFromRecents="true"/.test(out));
  const tor = F.find((f) => f.component === '.MainActivity' && f.patterns.some((p) => /torrent/i.test(p)));
  ok('the .torrent filter: android:host="*" now, .torrent and .TORRENT up to four dots deep', !!tor && tor.hosts.includes('*') && tor.patterns.includes('.*\\\\.torrent') && tor.patterns.includes('.*\\\\..*\\\\..*\\\\..*\\\\.TORRENT'));
  ok('<queries>: VIEW of any type (the chooser\'s apps on Android 11+)', /<queries>[\s\S]*<intent><action android:name="android\.intent\.action\.VIEW" \/><data android:mimeType="\*\/\*" \/><\/intent>[\s\S]*<\/queries>/.test(out));
  // (0.21 P2, device battery on the phone: «Nearby devices» and the old BLUETOOTH up to Android 11 — the only ones added
  // since the snapshot; Bluetooth itself not required.)
  const BT = /\n {4}<uses-permission android:name="android\.permission\.BLUETOOTH" android:maxSdkVersion="30" \/>\n {4}<uses-permission android:name="android\.permission\.BLUETOOTH_CONNECT" \/>\n {4}<uses-feature android:name="android\.hardware\.bluetooth" android:required="false" \/>/;
  ok('device battery (P2): «Nearby devices» and the old Bluetooth permission (to Android 11), no scan, no location, Bluetooth not required', BT.test(out) && !/BLUETOOTH_SCAN|BLUETOOTH_ADMIN|ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION/.test(out));
  {
    // (A manifest that already names BLUETOOTH_CONNECT — a plugin's, say: the legacy line and the feature still added, once.)
    const pre = fixture.replace('<application', '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />\n    <application');
    const o2 = M.patchManifest(pre); const count = (re) => (o2.match(re) || []).length;
    ok('a manifest already naming BLUETOOTH_CONNECT: the legacy BLUETOOTH (to Android 11) added exactly once, CONNECT and the feature once', count(/<uses-permission android:name="android\.permission\.BLUETOOTH" android:maxSdkVersion="30" \/>/g) === 1 && count(/android\.permission\.BLUETOOTH"/g) === 1 && count(/android\.permission\.BLUETOOTH_CONNECT"/g) === 1 && count(/<uses-feature android:name="android\.hardware\.bluetooth"/g) === 1);
    ok('… and patched again: nothing added twice', M.patchManifest(o2) === o2);
  }
  ok('no permission asked anew (beyond those two)', (out.match(/<uses-permission /g) || []).length === (before.match(/<uses-permission /g) || []).length + 2);
  // (Android's matching over the result: who answers which file — disabled aliases left out.)
  const on = F.filter((f) => f.enabled);
  const who = (intent) => [...new Set(on.filter((f) => matches(f, intent)).map((f) => f.component.replace(/^\./, '')))].sort().join(',');
  const v = (mime, p, scheme = 'content') => ({ action: 'android.intent.action.VIEW', mime, scheme, host: 'com.example.files', path: p });
  ok('a subtitle called octet-stream: no longer taken by the .torrent filter', who(v('application/octet-stream', '/storage/Movies/[Grp] Show - 03.ass')) === '', who(v('application/octet-stream', '/storage/Movies/[Grp] Show - 03.ass')));
  ok('a .torrent called octet-stream: still the app\'s', who(v('application/octet-stream', '/d/Show.S01.1080p.torrent')).includes('MainActivity'));
  ok('«Show.S01.E03.zip» called octet-stream: Kurokawa Files · Open archive', who(v('application/octet-stream', '/d/Show.S01.E03.zip')) === 'KtArchive', who(v('application/octet-stream', '/d/Show.S01.E03.zip')));
  ok('an archive by MIME, no name in the link: Open archive', who(v('application/x-7z-compressed', '/document/42')) === 'KtArchive');
  ok('application/zip with .apks: the installer and Open archive both offer', who(v('application/zip', '/d/game.apks')) === 'KtArchive,KtInstaller', who(v('application/zip', '/d/game.apks')));
  ok('a picture: nobody from Kurokawa until «View with Kurokawa» is on', who(v('image/jpeg', '/d/a.jpg')) === '');
  ok('a folder (DocumentsUI\'s type): Open folder', who(v('vnd.android.document/directory', '/tree/primary%3ADownload')) === 'KtFolder');
  ok('«Open downloads»: Kurokawa Files', who({ action: 'android.intent.action.VIEW_DOWNLOADS' }) === 'KtBrowse');
  ok('two archives shared: Extract with Kurokawa and Save to device', who({ action: 'android.intent.action.SEND_MULTIPLE', mime: 'application/zip' }) === 'KtArchiveShare,KtSave');
  // (With the off ones turned on: what they would take.)
  const all = F; const whoAll = (intent) => [...new Set(all.filter((f) => matches(f, intent)).map((f) => f.component.replace(/^\./, '')))].sort().join(',');
  ok('turned on: a .srt called octet-stream → Edit with Kurokawa (and the catch-all)', whoAll(v('application/octet-stream', '/d/ep03.ar.srt')) === 'KtAnyFile,KtText', whoAll(v('application/octet-stream', '/d/ep03.ar.srt')));
  ok('turned on: a picture → View with Kurokawa (and the catch-all)', whoAll(v('image/png', '/d/a.png')) === 'KtAnyFile,KtImage');
  // (The build's own check.)
  ok('the check: a pattern without a host is refused', M.checkFilters('<activity-alias android:name=".X"><intent-filter><action android:name="android.intent.action.VIEW" /><data android:scheme="content" /><data android:pathPattern=".*\\\\.zip" /></intent-filter></activity-alias>').some((f) => /without android:host/.test(f)));
  ok('the check: two components claiming the same action + type + pattern are refused', M.checkFilters('<activity-alias android:name=".A"><intent-filter><action android:name="android.intent.action.VIEW" /><data android:mimeType="image/*" /></intent-filter></activity-alias><activity-alias android:name=".B"><intent-filter><action android:name="android.intent.action.VIEW" /><data android:mimeType="image/*" /></intent-filter></activity-alias>').some((f) => /both claim/.test(f)));
  let threw = false; try { M.patchManifest(fixture.replace('</application>', '<activity-alias android:name=".KtImageCopy" android:targetActivity=".MainActivity"><intent-filter><action android:name="android.intent.action.VIEW" /><data android:mimeType="image/*" /></intent-filter></activity-alias></application>')); } catch { threw = true; }
  ok('the build stops when a new filter claims what an alias claims', threw);
  // (Nothing else changed: the output with the intended additions taken out is the snapshot of the output before.)
  const stripped = out.replace(BT, '').replace(/\n[ \t]*<!-- open-with:start[\s\S]*?<!-- open-with:end -->/, '').replace(/\n {4}<intent><action android:name="android\.intent\.action\.VIEW" \/><data android:mimeType="\*\/\*" \/><\/intent>/, '')
    .replace(/(<data android:scheme="file" \/>\n)\s*<data android:host="\*" \/>\n(\s*<data android:mimeType="application\/octet-stream" \/>\n)((?:\s*<data android:pathPattern="[^"]*torrent" \/>\n)+)/i, (m, a, b) => `${a}${b}        <data android:pathPattern=".*\\\\.torrent" />\n        <data android:pathPattern=".*\\\\..*\\\\.torrent" />\n`);
  ok('nothing else in the manifest changed (snapshot of the output before)', stripped === before, (() => { const a = stripped.split('\n'), b = before.split('\n'); const i = a.findIndex((l, k) => l !== b[k]); return i < 0 ? 'lengths' : [i, a[i], b[i]]; })());
}

function logic(L) {
  const r = L.parseOpen(JSON.stringify({ id: 'r1', kind: 'archive', caller: ' Telegram ', writable: false, items: [{ uri: 'content://org.telegram/f/9', name: 'أرشيف/الحلقة ٣.zip', size: 1234, path: '/storage/emulated/0/Download/x.zip', readable: true }, { uri: 7 }] }));
  ok('a request read: kind, caller, items (a slash in a name made safe, a bad item dropped)', r.kind === 'archive' && r.caller === 'Telegram' && r.items.length === 1 && r.items[0].name === 'أرشيف_الحلقة ٣.zip' && r.items[0].path === '/storage/emulated/0/Download/x.zip');
  ok('an unknown kind is the catch-all; bad JSON nothing', L.parseOpen({ kind: 'weird', items: [] }).kind === 'any' && L.parseOpen('{') === null && L.parseOpen(null) === null);
  ok('a link without a name: its last part, decoded', L.nameOfUri('content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2F%D8%AF%D9%84%D9%8A%D9%84.txt') === 'دليل.txt');
  const it = (o) => ({ uri: 'content://x/1', name: 'a', size: 10, mime: '', dir: false, readable: true, ...o });
  const step = (kind, items) => L.stepFor({ id: '', kind, action: '', caller: '', writable: false, mime: '', items });
  ok('archive → archive; two shared → the extraction of both', step('archive', [it({ name: 'a.zip' })]).to === 'archive' && step('archiveShare', [it({ name: 'a.zip' }), it({ name: 'b.7z' })]).items.length === 2);
  ok('folder here → that folder; a file\'s folder; not on the phone → said so', step('folder', [it({ dir: true, path: '/s/D' })]).path === '/s/D' && step('folder', [it({ path: '/s/D/f.txt' })]).path === '/s/D' && step('folder', [it({ dir: true })]).why === 'notHere');
  ok('browse with nothing → Downloads; with a root → that folder', step('browse', []).to === 'downloads' && step('browse', [it({ dir: true, path: '/storage/emulated/0' })]).path === '/storage/emulated/0');
  ok('a link nobody can read → «unreadable»; nothing came → «nothing»', step('text', [it({ readable: false })]).why === 'unreadable' && step('any', []).why === 'nothing');
  ok('image → viewer, text → editor, any → the sheet', step('image', [it()]).to === 'viewer' && step('text', [it()]).to === 'editor' && step('any', [it()]).to === 'any');
  const ts = new Uint8Array(564); ts[0] = ts[188] = ts[376] = 0x47; const m2ts = new Uint8Array(600); m2ts[4] = m2ts[196] = m2ts[388] = 0x47;
  ok('«.ts»: MPEG-TS and M2TS packets are video; TypeScript is not', L.sniffTs(ts) && L.sniffTs(m2ts) && !L.sniffTs(new TextEncoder().encode('import { h } from "./dom";\nexport const x: number = 1;\n'.repeat(10))) && !L.sniffTs(new Uint8Array([0x47])));
  ok('own ways: the player for .mkv, the viewer for .jpg, the editor for .ass, archives as folders; a computer: no viewer/editor, its default app', L.ownWays('Show.MKV', false).join() === 'player' && L.ownWays('a.jpg', false).join() === 'viewer' && L.ownWays('a.ass', false).join() === 'editor' && L.ownWays('a.zip', false).join() === 'archive' && L.ownWays('a.jpg', true).join() === 'system' && L.ownWays('a.mkv', true).join() === 'player,system');
  const apps = [{ pkg: 'org.videolan.vlc', cls: 'V', label: 'VLC' }, { pkg: 'com.mxtech', cls: 'M', label: 'MX Player' }, { pkg: 'org.videolan.vlc', cls: 'V', label: 'VLC' }];
  const list = L.chooserList('ep.mkv', apps, false);
  ok('the chooser: Kurokawa first, then the apps by name, once each', list.length === 3 && list[0].own === 'player' && list[1].app.label === 'MX Player' && list[2].app.label === 'VLC');
  const store = { m: {}, getItem(k) { return this.m[k] ?? null; }, setItem(k, v) { this.m[k] = v; } };
  L.setDefault(store, 'mkv', { app: apps[0] }); L.setDefault(store, 'jpg', { own: 'viewer' });
  ok('«Always»: kept per extension; removed again', L.loadDefaults(store).mkv.app.pkg === 'org.videolan.vlc' && L.loadDefaults(store).jpg.own === 'viewer' && !('mkv' in L.setDefault(store, 'mkv', null)));
  store.m['kt.files.defaultApps'] = '{"x y":{"own":"player"},"pdf":{"app":{}},"txt":{"own":"editor"}}';
  ok('a spoilt store: only sound entries read', JSON.stringify(Object.keys(L.loadDefaults(store))) === '["txt"]');
  ok('the extension a choice is kept under', L.extOf('Show.S01.MKV') === 'mkv' && L.extOf('noext') === '' && L.extOf('a.tar.gz') === 'gz');
  const C = load('src/views/textCodec.ts'); const ar = 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,مرحبًا بكم في الحلقة الثالثة';
  ok('text codec: UTF-8, UTF-8 with BOM, UTF-16 LE/BE (with and without a mark), Windows-1256: each read and written back to the same bytes', [['utf-8', false], ['utf-8', true], ['utf-16le', true], ['utf-16le', false], ['utf-16be', true], ['windows-1256', false]].every(([cs, bom]) => { const b = C.encodeText(ar, cs, bom); const d = C.decodeText(b); return d.charset === cs && d.bom === bom && d.safe && d.text === ar && Buffer.compare(Buffer.from(C.encodeText(d.text, d.charset, d.bom)), Buffer.from(b)) === 0; }));
  ok('text codec: a binary file, a cut-off read: read-only', C.decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13])).why === 'binary' && C.decodeText(new TextEncoder().encode('abc'), false).safe === false);
  ok('text codec: a character Windows-1256 lacks → no bytes (nothing saved)', C.encodeText('日本', 'windows-1256') === null);
  ok('base64 both ways', Buffer.from(C.fromB64(C.toB64(new Uint8Array([0, 255, 1, 200])))).equals(Buffer.from([0, 255, 1, 200])));
  return C;
}

async function pages(C) {
  const { chromium } = require('playwright'); const F = require('./filesphone-fixture.cjs'); const { K } = F;
  const shots = process.env.KT_SHOTS; const shot = async (p, name) => { if (shots) await p.screenshot({ path: path.join(shots, name) }); };
  const server = await F.serve(); const port = server.address().port; const z = await F.zipListing(); const browser = await chromium.launch();
  const tsBytes = Buffer.from('import { h } from "../ui/dom";\nexport const answer: number = 42;\n').toString('base64');
  const mpeg = new Uint8Array(564); mpeg[0] = mpeg[188] = mpeg[376] = 0x47; const mpegB64 = Buffer.from(mpeg).toString('base64');
  const arText = 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,مرحبًا بكم في الحلقة الثالثة'; const ar1256 = Buffer.from(C.encodeText(arText, 'windows-1256')).toString('base64');
  /** A page on the pretend phone with the «Open with» side of the plugin pretended too. */
  const open = async (lang, req, o = {}) => {
    const { page: p, errors } = await F.open(browser, { lang, pc: false, z, width: 360, height: 780 });
    await p.addInitScript(({ req, K, tsBytes, mpegB64, ar1256 }) => {
      const kt = window.Capacitor.Plugins.KurokawaTools; window.__done = []; window.__sets = []; window.__states = {}; window.__opened = []; window.__writes = []; window.__fetched = [];
      kt.openRequest = async () => ({ request: req ? JSON.stringify(req) : null }); kt.openDone = async (x) => { window.__done.push(x); };
      kt.openFetch = async ({ uri, dir }) => { window.__fetched.push(uri); const name = decodeURIComponent(uri.split('/').pop()); const to = `${dir || K + '/.cache'}/${name}`; window.__put(to, false, 1234567); return { path: to, size: 1234567 }; };
      kt.uriRead = async ({ uri, path }) => { const k = path || uri; window.__reads = (window.__reads || 0) + 1; if (/app\.ts$/.test(k)) return { b64: tsBytes, size: 60, whole: true }; if (/clip\.ts$/.test(k)) return { b64: mpegB64, size: 5e8, whole: false }; return { b64: ar1256, size: 80, whole: true }; };
      kt.uriWrite = async (x) => { window.__writes.push(x); return { size: 1 }; };
      kt.archiveExisting = async () => ({ existing: [] }); kt.archiveFree = async () => ({ free: 3e10 });
      kt.openWithStates = async ({ names }) => ({ states: Object.fromEntries(names.map((n) => [n, window.__states[n] ?? 0])) });
      window.__pmOn = false; window.__pmFail = false; window.__pmCalls = [];
      kt.pickerStorage = async (o) => { window.__pmCalls.push(o); if (o.on !== undefined) { if (window.__pmFail) throw new Error('refused'); window.__pmOn = o.on; } return { on: window.__pmOn }; };
      kt.openWithSet = async ({ name, state }) => { window.__sets.push(`${name}:${state}`); window.__states[name] = state === 'on' ? 1 : state === 'off' ? 2 : 0; };
      const ic = (c) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="12" fill="${c}"/></svg>`)}`;
      kt.appsFor = async () => ({ apps: [{ pkg: 'com.example.pdfreader', cls: 'R', label: 'PDF Reader', icon: ic('#5b7fa6') }, { pkg: 'com.example.drive', cls: 'D', label: 'Drive', icon: ic('#4f8a6e') }] });
      kt.openIn = async (x) => { window.__opened.push(`${x.pkg}`); };
      kt.hashFile = async () => ({ md5: '0f343b0931126a20f133d67c2b018a3b', sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    }, { req, K, tsBytes, mpegB64, ar1256 });
    await p.goto(`http://localhost:${port}/#/`); await p.waitForTimeout(700);
    if (req) { await p.evaluate(() => { location.hash = '#/open?kind=x&id=r1&t=1'; }); await p.waitForTimeout(o.wait ?? 1500); }
    return { p, errors };
  };
  const item = (o) => ({ uri: 'content://com.example/x', size: 1234, mime: '', dir: false, readable: true, ...o });
  const done = (p) => p.evaluate(() => window.__done);

  // An archive here, from Telegram: opened as a folder, Extract one tap away; Back hands back.
  { const { p, errors } = await open('en', { id: 'r1', kind: 'archive', caller: 'Telegram', items: [item({ name: F.ZIP, path: `${K}/${F.ZIP}`, size: 1234567 })] });
    const banner = await p.textContent('.ow-banner').catch(() => '');
    ok('archive: «From Telegram» over the archive opened as a folder', /From Telegram/.test(banner) && !!(await p.$('.files-view .files-row:has(.files-name[title="Fonts"])')), banner);
    await shot(p, 'openwith-archive-opened.png');
    await p.click('.ow-wrap > .btn'); await p.waitForTimeout(800);
    ok('archive: Extract… opens the extraction sheet', !!(await p.$('.sheet')) && /HOREMAJO/i.test(await p.textContent('.sheet .sheet-head').catch(() => '')));
    await shot(p, 'openwith-extract-sheet.png');
    await p.evaluate(() => window.__back()); await p.waitForTimeout(400); await p.evaluate(() => window.__back()); await p.waitForTimeout(600);
    ok('archive: Back at the start hands back to Telegram (done, back)', JSON.stringify(await done(p)) === '[{"id":"r1","back":true}]', await done(p));
    ok('archive: no page errors', !errors.length, errors); await p.close(); }

  // An archive that is only a link (an Arabic name): copied first, then opened.
  { const { p } = await open('ar', { id: 'r2', kind: 'archive', caller: 'واتساب', items: [item({ uri: 'content://com.example.chat/أرشيف الحلقة ٣.zip', name: 'أرشيف الحلقة ٣.zip' })] });
    ok('archive link: fetched to the cache, then opened as a folder (Arabic name)', (await p.evaluate(() => window.__fetched)).length === 1 && (await p.evaluate(() => window.__calls)).some((c) => c === 'arcList:أرشيف الحلقة ٣.zip') && /واتساب/.test(await p.textContent('.ow-banner')));
    await p.close(); }

  // Two archives shared at once: straight into the extraction sheet of the first, the second queued.
  { const { p } = await open('en', { id: 'r3', kind: 'archiveShare', caller: 'Files by Google', items: [item({ name: F.ZIP, path: `${K}/${F.ZIP}` }), item({ name: 'Second.zip', path: `${K}/${F.ZIP}` })] });
    ok('two archives shared: the extraction sheet at once', !!(await p.$('.sheet')) && (await p.evaluate(() => window.__calls)).filter((c) => c.startsWith('arcList:')).length >= 1);
    await p.close(); }

  // A folder; a folder not on the phone; a link nobody can read.
  { const { p } = await open('en', { id: 'r4', kind: 'folder', caller: 'Solid Explorer', items: [item({ name: 'Sub', path: `${K}/Sub`, dir: true })] });
    ok('folder: Files at that folder', (await p.textContent('.files-title')) === 'Sub' && !!(await p.$('.files-row:has(.files-name[title="in.txt"])')));
    await p.click('.files-row:has(.files-name[title="Deeper"])'); await p.waitForTimeout(500); await p.evaluate(() => window.__back()); await p.waitForTimeout(500);
    ok('folder: deeper, then Back: up inside Kurokawa, not handed back yet', (await p.textContent('.files-title')) === 'Sub' && (await done(p)).length === 0);
    await p.evaluate(() => window.__back()); await p.waitForTimeout(500);
    ok('folder: Back at the start: handed back', (await done(p)).some((d) => d.back === true)); await p.close(); }
  { const { p } = await open('en', { id: 'r5', kind: 'folder', items: [item({ name: 'Camera', dir: true })] });
    ok('folder not on the phone: said calmly, with Try again and Close', /not on this phone/.test(await p.textContent('.empty')) && (await p.$$('.empty .btn')).length === 2); await p.close(); }
  { const { p } = await open('ar', { id: 'r6', kind: 'text', caller: 'Gmail', items: [item({ name: 'ملاحظات.txt', readable: false })] });
    ok('unreadable link: a calm explanation in Arabic', /تعذّرت قراءة/.test(await p.textContent('.empty')));
    await p.click('.empty .btn.primary'); await p.waitForTimeout(400);
    ok('unreadable: Close hands back', (await done(p)).some((d) => d.back === true)); await p.close(); }

  // A 6 GB file with the catch-all: the sheet at once (nothing read), properties with its size.
  { await (async () => {})(); const { p, errors } = await open('en', { id: 'r7', kind: 'any', caller: 'Chrome', items: [item({ name: 'Season 2 [BDRip 2160p] أغنية.mkv', path: `${K}/Season 2.mkv`, size: 6e9, mime: 'video/x-matroska' })] }, { wait: 900 });
    ok('a 6 GB file: the sheet shows within a second, nothing read', !!(await p.$('.ow-any')) && !(await p.evaluate(() => window.__reads)));
    const head = await p.textContent('.ow-file'); ok('the sheet: the name (Arabic in it), the size, the type, who sent it', /أغنية/.test(head) && /GB/.test(head) && /Chrome/.test(head), head);
    ok('the sheet: show in folder, copy to…, view as text, properties, share', (await p.$$('.ow-any .ow-row')).length === 5);
    await shot(p, 'openwith-anyfile-sheet.png');
    await p.click('.ow-any .ow-row:nth-of-type(4)'); await p.waitForTimeout(400);
    ok('properties: the size of 6 GB', /GB/.test(await p.textContent('.sheet:last-of-type')));
    ok('any: no page errors', !errors.length, errors); await p.close(); }

  // An Arabic subtitle in Windows-1256 handed in for editing: read, changed, written back in Windows-1256.
  { const { p, errors } = await open('ar', { id: 'r8', kind: 'text', caller: 'Aegisub', writable: true, items: [item({ name: 'ترجمة الحلقة ٣.ass', uri: 'content://com.example/sub/3' })] });
    const ta = await p.$('.files-editor textarea'); const val = ta ? await ta.inputValue() : '';
    ok('text: the editor, the Arabic read right, «Windows-1256» told', val === arText && /Windows-1256/.test(await p.textContent('.files-ed-status')), val);
    await shot(p, 'openwith-text-editor.png');
    await ta.fill(arText + '!'); await p.click('.files-editor .sheet-actions .btn.primary'); await p.waitForTimeout(500);
    const w = await p.evaluate(() => window.__writes);
    ok('text: written back to the link, in Windows-1256 still', w.length === 1 && w[0].uri === 'content://com.example/sub/3' && Buffer.from(w[0].b64, 'base64').equals(Buffer.from(C.encodeText(arText + '!', 'windows-1256'))));
    ok('text: no page errors', !errors.length, errors); await p.close(); }
  { const { p } = await open('en', { id: 'r9', kind: 'text', caller: 'Mail', writable: false, items: [item({ name: 'notes.srt' })] });
    ok('text the other app does not let us change: read-only, with a notice', await p.$eval('.files-editor textarea', (t) => t.readOnly) && /did not allow changes/.test(await p.textContent('.files-ed-notice'))); await p.close(); }

  // In Files: «.ts» TypeScript opens as text, MPEG-TS not.
  { const { p } = await open('en', null);
    await p.evaluate((K) => { window.__put(`${K}/app.ts`, false, 60); window.__put(`${K}/clip.ts`, false, 5e8); }, K);
    await p.evaluate(() => { location.hash = '#/files'; }); await p.waitForSelector('.files-row', { timeout: 15000 }); await p.waitForTimeout(500);
    await p.click('.files-row:has(.files-name[title="app.ts"])'); await p.waitForTimeout(700);
    ok('«app.ts» (TypeScript): the text editor', !!(await p.$('.files-editor')) && /export const answer/.test(await p.$eval('.files-editor textarea', (t) => t.value)));
    await p.evaluate(() => window.__back()); await p.waitForTimeout(400);
    await p.click('.files-row:has(.files-name[title="clip.ts"])'); await p.waitForTimeout(700);
    ok('«clip.ts» (MPEG-TS): not opened as text', !(await p.$('.files-editor')));
    await p.close(); }

  // The switches: phone, English and Arabic; reset; Files' own chooser and the defaults.
  for (const lang of ['en', 'ar']) {
    const { p, errors } = await open(lang, null);
    await p.evaluate((K) => window.__put(`${K}/book.pdf`, false, 2e6), K);
    await p.evaluate(() => { location.hash = '#/files'; }); await p.waitForSelector('.files-row', { timeout: 15000 }); await p.waitForTimeout(400);
    const settings = async () => { await p.click('.files-view .topbar-actions button:last-child'); await p.waitForTimeout(300); await p.click(`.sheet .dest-row:has-text("${lang === 'en' ? 'Files settings' : 'إعدادات الملفات'}")`); await p.waitForTimeout(500); };
    await settings();
    ok(`[${lang}] Files settings: «Show Kurokawa in other apps» and «Default apps»`, !!(await p.$('.ow-open-settings')) && !!(await p.$('.ow-open-defaults')));
    await p.click('.ow-open-settings'); await p.waitForTimeout(500);
    const rows = await p.$$eval('.ow-switch', (rs) => rs.map((r) => [r.querySelector('input').dataset.alias, r.querySelector('input').checked, r.querySelector('small').textContent]));
    ok(`[${lang}] eleven switches, each with a line; picture, text, catch-all off`, rows.length === 11 && rows.every((r) => r[2].length > 10) && rows.filter((r) => !r[1]).map((r) => r[0]).join() === 'KtImage,KtText,KtAnyFile', rows.map((r) => r.slice(0, 2)));
    await shot(p, lang === 'en' ? 'openwith-settings.png' : 'openwith-settings-ar.png');
    const chip = (id) => p.$eval(`.pm-chips [data-pm="${id}"]`, (b) => b.classList.contains('on') && b.getAttribute('aria-pressed') === 'true');
    ok(`[${lang}] file pickers: «its own browser» in force (read from the plugin), storage places off`, (await chip('own')) && !(await chip('storage')) && (await p.textContent('.pm-block .hint')).length > 40);
    await p.locator('.pm-block').scrollIntoViewIfNeeded(); await p.evaluate(() => document.querySelector('.pm-block').scrollIntoView({ block: 'center' })); await p.waitForTimeout(200);
    if (process.env.KT_SHOTS) await p.screenshot({ path: path.join(process.env.KT_SHOTS, `F3-setting-${lang}.png`) });
    if (lang === 'en') {
      await p.click('.pm-chips [data-pm="storage"]'); await p.waitForTimeout(250);
      ok('storage places chosen: applied through the plugin, the state shown is the one returned', JSON.stringify(await p.evaluate(() => window.__pmCalls)) === '[{},{"on":true}]' && (await chip('storage')) && !(await chip('own')) && await p.$eval('.pm-error', (e) => e.hidden));
      await p.evaluate(() => { window.__pmFail = true; }); await p.click('.pm-chips [data-pm="own"]'); await p.waitForTimeout(300);
      ok('a change refused: a calm line, and the state shown stays the real one (storage places)', !(await p.$eval('.pm-error', (e) => e.hidden)) && /could not be changed/.test(await p.textContent('.pm-error')) && (await chip('storage')));
      await p.evaluate(() => { window.__pmFail = false; }); await p.click('.pm-chips [data-pm="own"]'); await p.waitForTimeout(250);
      ok('then its own browser again, the line gone', (await chip('own')) && await p.$eval('.pm-error', (e) => e.hidden));
    }
    if (lang === 'en') {
      await p.click('.ow-switch:has(input[data-alias="KtImage"]) input'); await p.click('.ow-switch:has(input[data-alias="KtArchive"]) input'); await p.click('.ow-switch:has(input[data-alias="KtArchive"]) input'); await p.waitForTimeout(300);
      ok('switches: picture on, archive off and on again (back to as installed)', JSON.stringify(await p.evaluate(() => window.__sets)) === '["KtImage:on","KtArchive:off","KtArchive:default"]', await p.evaluate(() => window.__sets));
      await p.click('.ow-settings .sheet-actions .btn'); await p.waitForTimeout(500);
      const sets = await p.evaluate(() => window.__sets.slice(3));
      ok('Reset to defaults: every entry back to as installed, the picture off again', sets.length === 11 && sets.every((s) => s.endsWith(':default')) && !(await p.$eval('input[data-alias="KtImage"]', (i) => i.checked)));
      await p.evaluate(() => window.__back()); await p.waitForTimeout(400);
      // The chooser: a PDF has no Kurokawa way: the apps; Just once, then Always, then straight there.
      await p.click('.files-row:has(.files-name[title="book.pdf"])'); await p.waitForTimeout(600);
      ok('chooser: the phone\'s apps for a PDF, Just once and Always greyed until one is chosen', (await p.$$('.ow-chooser .ow-app')).length === 2 && await p.$eval('.ow-chooser .sheet-actions .btn.primary', (b) => b.disabled));
      await p.click('.ow-chooser .ow-app:nth-child(2)'); await p.waitForTimeout(200);
      await shot(p, 'openwith-default-app-chooser.png');
      await p.click('.ow-chooser .sheet-actions .btn.tonal'); await p.waitForTimeout(400);
      ok('Just once: opened in that app, nothing kept', JSON.stringify(await p.evaluate(() => window.__opened)) === '["com.example.pdfreader"]' && !(await p.evaluate(() => localStorage.getItem('kt.files.defaultApps'))));
      await p.click('.files-row:has(.files-name[title="book.pdf"])'); await p.waitForTimeout(600); await p.click('.ow-chooser .ow-app:nth-child(1)'); await p.click('.ow-chooser .sheet-actions .btn.primary'); await p.waitForTimeout(400);
      await p.click('.files-row:has(.files-name[title="book.pdf"])'); await p.waitForTimeout(600);
      ok('Always: kept for .pdf; the next PDF opens there with no chooser', JSON.stringify(await p.evaluate(() => window.__opened)) === '["com.example.pdfreader","com.example.drive","com.example.drive"]' && !(await p.$('.ow-chooser')));
      await settings(); await p.click('.ow-open-defaults'); await p.waitForTimeout(400);
      ok('Default apps: «.pdf → Drive» listed', /\.pdf/.test(await p.textContent('.ow-defaults')) && /Drive/.test(await p.textContent('.ow-defaults')));
      await shot(p, 'openwith-defaults-list.png');
      await p.click('.ow-default .btn'); await p.waitForTimeout(300);
      ok('Remove: the list empty, the choice forgotten', !!(await p.$('.ow-defaults .empty')) && (await p.evaluate(() => localStorage.getItem('kt.files.defaultApps'))) === '{}');
    }
    ok(`[${lang}] no page errors`, !errors.length, errors); await p.close();
  }

  // A computer (no phone plugin): the switches absent, the default apps there.
  { const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await page.addInitScript(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'archives'] })); window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', list: async () => [], onTasks: () => () => {}, listDir: async () => ({ entries: [{ name: 'a.txt', path: '/home/u/a.txt', dir: false, size: 3, mtime: 0 }], exists: true }), openPath: async () => undefined, homeDir: async () => '/home/u' }, { get: (t, k) => (k in t ? t[k] : k === 'then' || ['filesJob', 'onFilesJob', 'titleBar', 'filesRoots', 'filesStat', 'filesMkdir', 'filesRename'].includes(k) ? undefined : async () => undefined) }); });
    await page.route(/api\.github\.com/, (r) => r.fulfill({ json: [] }));
    await page.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent('/home/u')}`); await page.waitForTimeout(1500);
    await page.click('.files-view .topbar-actions button:last-child'); await page.waitForTimeout(300); await page.click('.sheet .dest-row:has-text("Files settings")'); await page.waitForTimeout(600);
    ok('computer: no file-pickers setting (phones only)', !(await page.$('.pm-block')));
    ok('computer: no «Show Kurokawa in other apps» (phones only); «Default apps» there', !(await page.$('.ow-open-settings')) && !!(await page.$('.ow-open-defaults')));
    ok('computer: no page errors', !errs.length, errs); await page.close(); }
  await browser.close(); server.close();
}

(async () => {
  const L = table(); await manifest(); const C = logic(L);
  if (process.argv.includes('--no-page')) console.log('skip pages'); else await pages(C);
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
