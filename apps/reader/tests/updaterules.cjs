// node tests/updaterules.cjs: the smart update checks (src/sources/updates.ts wantsCheck, ext/source.ts
// cadenceOf) — a novel's release rhythm read from its chapters' dates, and which novels an automatic check asks.
const { chromium } = require('playwright'); const esbuild = require('esbuild');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const code = esbuild.buildSync({ stdin: { contents: "export { wantsCheck } from './src/sources/updates'; export { cadenceOf } from './src/sources/ext/source';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'U', write: false, platform: 'browser', logLevel: 'error' }).outputFiles[0].text;
  const b = await chromium.launch(); const p = await b.newPage();
  await p.route('http://kr.test/', (r) => r.fulfill({ body: '<p>', contentType: 'text/html' })); await p.goto('http://kr.test/'); await p.addScriptTag({ content: code });
  const r = await p.evaluate(() => {
    const D = 86400000, now = Date.UTC(2026, 9, 29);
    const weekly = Array.from({ length: 10 }, (_, i) => ({ name: `Chapter ${i + 1}`, path: `/c${i}`, released: new Date(now - (10 - i) * 7 * D).toISOString() }));
    const cad = U.cadenceOf(weekly);
    const all = { wifiOnly: false, onlyOngoing: false, autoFetch: false, skipUnread: false, skipNotStarted: false, smart: false };
    const book = (o) => ({ id: 'b', title: 't', format: 'webnovel', fileName: '', size: 0, addedAt: 0, bookmarks: [], highlights: [], chapters: 10, ...o, remote: { source: 'ext:x', id: 'p', chapterCount: 10, ...(o.remote || {}) } });
    return {
      every: cad.every / D, last: cad.lastAt,
      none: U.cadenceOf([{ name: 'a', path: 'a' }]).every,
      smartSoon: U.wantsCheck(book({ remote: { every: 7 * D, lastAt: now - 1 * D, checkedAt: now - D } }), { ...all, smart: true }, now),
      smartDue: U.wantsCheck(book({ remote: { every: 7 * D, lastAt: now - 6 * D, checkedAt: now - D } }), { ...all, smart: true }, now),
      smartOff: U.wantsCheck(book({ remote: { every: 7 * D, lastAt: now - 1 * D, checkedAt: now - D } }), all, now),
      unread: U.wantsCheck(book({ progress: { bookId: 'b', toc: 4, pct: 0.4 } }), { ...all, skipUnread: true }, now),
      caughtUp: U.wantsCheck(book({ progress: { bookId: 'b', toc: 10, pct: 1 } }), { ...all, skipUnread: true }, now),
      notStarted: U.wantsCheck(book({}), { ...all, skipNotStarted: true }, now),
      finished: U.wantsCheck(book({ remote: { finished: true } }), { ...all, onlyOngoing: true }, now),
    };
  });
  ok('a weekly novel: its rhythm read as seven days from its chapters\' dates', Math.round(r.every) === 7 && r.last > 0, r);
  ok('… none without dates', r.none === undefined, r);
  ok('smart: not asked a day after its chapter, asked when the next is near; every time when off', r.smartSoon === false && r.smartDue === true && r.smartOff === true, r);
  ok('chapters still to read skipped; caught up asked', r.unread === false && r.caughtUp === true, r);
  ok('not started skipped; finished skipped when only ongoing', r.notStarted === false && r.finished === false, r);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
