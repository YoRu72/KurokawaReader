// node tests/linkopen.cjs: a shared or pasted link opened in the source that has it (src/sources/linkopen.ts).
const { chromium } = require('playwright'); const esbuild = require('esbuild');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const code = esbuild.buildSync({ entryPoints: ['src/sources/linkopen.ts'], bundle: true, format: 'iife', globalName: 'L', write: false, platform: 'browser', logLevel: 'error' }).outputFiles[0].text;
  const b = await chromium.launch(); const p = await b.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message)); await p.route('http://kr.test/', (r) => r.fulfill({ body: '<p>', contentType: 'text/html' })); await p.goto('http://kr.test/'); await p.addScriptTag({ content: code });
  const r = await p.evaluate(async () => {
    const it = (id, site, kind) => ({ id, name: id, lang: 'en', site, version: '1', url: '', kind, runnable: true });
    const repos = [
      { key: 'r1', kind: 'lnreader', items: [it('novelbin', 'https://novelbin.me/', 'lnreader'), it('rr', 'https://www.royalroad.com', 'lnreader'), it('a', 'https://dup.com', 'lnreader')] },
      { key: 'r2', kind: 'mangayomi', items: [it('wtr', 'https://wtr-lab.com', 'mangayomi'), it('a2', 'https://dup.com/', 'lnreader')] },
    ];
    const T = (u) => L.targetOf(u, repos);
    return {
      link: L.linkIn('The Novel — Read it at https://novelbin.me/novel-book/the-novel/.'),
      none: L.linkIn('just some words'),
      nb: await T('https://novelbin.me/novel-book/the-novel/?ref=share'),
      rr: await T('https://royalroad.com/fiction/123/name'),
      my: await T('https://wtr-lab.com/en/serie-1/name?x=1'),
      top: await T('https://novelbin.me/'),
      dup: await T('https://dup.com/novel/x'),
      sh: await T('https://shamela.ws/book/1234/56'),
      sh1: await T('https://shamela.ws/book/1234'),
      ar: await T('https://archive.org/details/some_item/page/n5'),
      other: await T('https://novelbin.me.evil.com/novel/x'),
    };
  });
  ok('the link in shared text, its trailing dot left out', r.link === 'https://novelbin.me/novel-book/the-novel/', r.link);
  ok('no link in words', r.none === null, r.none);
  ok('LNReader: the path after the site, slashes and query off', r.nb.route === '/sources/ext:r1:novelbin/book/novel-book%2Fthe-novel', r.nb);
  ok('a site given with www. matches a link without', r.rr.route === '/sources/ext:r1:rr/book/fiction%2F123%2Fname', r.rr);
  ok('Mangayomi: the address\'s path with its query', r.my.route === '/sources/ext:r2:wtr/book/%2Fen%2Fserie-1%2Fname%3Fx%3D1', r.my);
  ok('the site\'s own front page opens the source', r.top.route === '/sources/ext:r1:novelbin', r.top);
  ok('two extensions for one site: the browser, no guess', r.dup.browser === 'https://dup.com/novel/x', r.dup);
  ok('Shamela book at its page', r.sh.route === '/sources/shamela/book/1234%2356' && r.sh1.route === '/sources/shamela/book/1234', [r.sh, r.sh1]);
  ok('Internet Archive item', r.ar.route === '/sources/archive/book/some_item', r.ar);
  ok('a look-alike host is not the site', r.other.browser, r.other);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
