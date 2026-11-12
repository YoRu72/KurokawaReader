// node tests/booksettings.cjs: a book with settings of its own (src/settings.ts) — what is changed while it is open
// goes to the book only when it is about how that book is read; the AI service and its key, sync, updates, the
// library's look stay the app's (a key typed with a book open was once kept in that book's overrides alone, and
// lost to every other book). Such settings found in a book's overrides are taken out of them (moved to the app's
// settings when the app has none of its own), without their values ever being printed.
const esbuild = require('esbuild');
const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
// (Left in a book's overrides by an older version: a key typed with the book open, the sync service, a font size.)
store['kr.bookVisual'] = JSON.stringify({ old: { fontSize: 23, aiKey: 'OLD-BOOK-SECRET', syncProvider: 'webdav' }, other: { aiModel: 'm-book', fontSize: 17 } });
store['kr.visual'] = JSON.stringify({ aiModel: 'm-global' });
const load = () => { const code = esbuild.buildSync({ entryPoints: ['src/settings.ts'], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text; const m = { exports: {} }; new Function('module', 'exports', 'require', code)(m, m.exports, require); return m.exports; };
const S = load();
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const bookV = () => JSON.parse(store['kr.bookVisual'] ?? '{}'); const glob = () => JSON.parse(store['kr.visual'] ?? '{}');
S.setActiveBook('b1'); S.setBookScoped(true);
S.updateSettings({ fontSize: 30, aiKey: 'NEW-SECRET', aiProvider: 'openai', syncAuto: true });
ok('a font size changed with the book open: the book\'s alone', bookV().b1.fontSize === 30 && glob().fontSize !== 30);
ok('the AI key typed with the book open: the app\'s, not the book\'s', !('aiKey' in bookV().b1) && glob().aiKey === 'NEW-SECRET');
ok('… and so the AI service and sync', !('aiProvider' in bookV().b1) && !('syncAuto' in bookV().b1) && glob().aiProvider === 'openai' && glob().syncAuto === true);
S.setActiveBook('b2'); ok('another book sees the key', S.getSettings().aiKey === 'NEW-SECRET' && S.getSettings().fontSize !== 30);
S.setActiveBook('old');
ok('an older book\'s overrides: the app-wide settings taken out of them, its font size kept', bookV().old && !('aiKey' in bookV().old) && !('syncProvider' in bookV().old) && bookV().old.fontSize === 23);
ok('… one the app did not have moved to the app (not lost), one it had left as the app\'s', glob().syncProvider === 'webdav' && glob().aiModel === 'm-global' && !('aiModel' in (bookV().other ?? {})) && bookV().other.fontSize === 17);
S.setBookSettings('restored', { lineHeight: 2, aiKey: 'X', anilistClientId: 'c' });
ok('a book\'s settings put back from a backup keep only what a book may have', bookV().restored.lineHeight === 2 && !('aiKey' in bookV().restored) && !('anilistClientId' in bookV().restored));
S.setActiveBook('b1'); S.resetSettings();
ok('«Reset» in a book\'s reading options: the book\'s settings back to the factory\'s, the AI key and sync kept', S.getSettings().aiKey === 'NEW-SECRET' && glob().syncAuto === true && bookV().b1.fontSize !== 30);
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
