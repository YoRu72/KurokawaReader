// node tests/chapterhealth.cjs: a chapter that is a site's check page or nothing is told apart from a chapter.
const esbuild = require('esbuild');
const code = esbuild.buildSync({ entryPoints: ['src/sources/chapterhealth.ts'], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text;
const m = { exports: {} }; new Function('module', 'exports', code)(m, m.exports); const { badChapter } = m.exports;
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
ok('a Cloudflare page', badChapter('<h1>Just a moment...</h1><p>Checking your browser before accessing novelbin.me.</p>') === 'check');
ok('"Verify you are human"', badChapter('<p>Verify you are human by completing the action below.</p>') === 'check');
ok('nothing', badChapter('<p> </p><div></div>') === 'empty' && badChapter('') === 'empty');
ok('a picture alone is a chapter', badChapter('<p><img src="a.jpg"></p>') === null);
ok('a short chapter', badChapter('<p>Author\'s note: no chapter this week, sorry!</p>') === null);
ok('a long chapter that says "access denied" in its story', badChapter('<p>' + 'The gate said access denied, and he laughed. '.repeat(30) + '</p>') === null);
ok('an Arabic chapter', badChapter('<p>قال الراوي: وكان ذلك في أول الليل.</p>') === null);
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
