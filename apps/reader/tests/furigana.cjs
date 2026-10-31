// node tests/furigana.cjs: furigana over each run of kanji, okurigana outside (取[と]り扱[あつか]い), and the
// readings left out of what is copied, searched for and read aloud (src/furigana.ts, src/ui/selection.ts).
const { chromium } = require('playwright'); const esbuild = require('esbuild');
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  const bundle = (entry, name) => esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'iife', globalName: name, write: false, platform: 'browser', logLevel: 'error' }).outputFiles[0].text;
  const b = await chromium.launch(); const p = await b.newPage();
  await p.setContent('<div id=r></div>'); await p.addScriptTag({ content: bundle('src/furigana.ts', 'F') });
  const R = { '取り扱い': 'トリアツカイ', '食べる': 'タベル', '漢字': 'カンジ', 'お茶': 'オチャ', '引っ越し': 'ヒッコシ', '振り返る': 'フリカエル', '日本語': 'ニホンゴ' };
  const res = await p.evaluate((R) => {
    const tk = { tokenize: (t) => [{ surface_form: t, reading: R[t] }] };
    const out = {};
    for (const w of Object.keys(R)) { const d = document.createElement('div'); d.textContent = w; F.annotate(d, tk); out[w] = [...d.childNodes].map((n) => (n.nodeName === 'RUBY' ? `${n.firstChild.textContent}[${n.querySelector('rt').textContent}]` : n.textContent)).join(''); }
    return out;
  }, R);
  ok('each run of kanji its own reading, okurigana outside', res['取り扱い'] === '取[と]り扱[あつか]い' && res['振り返る'] === '振[ふ]り返[かえ]る' && res['引っ越し'] === '引[ひ]っ越[こ]し');
  ok('a word of kanji one reading; kana around it outside', res['漢字'] === '漢字[かんじ]' && res['お茶'] === 'お茶[ちゃ]' && res['食べる'] === '食[た]べる' && res['日本語'] === '日本語[にほんご]');
  if (fails) console.log(JSON.stringify(res));
  // The text without its readings.
  await p.addScriptTag({ content: bundle('src/ui/rubytext.ts', 'S') });
  const plain = await p.evaluate(() => { const d = document.createElement('div'); d.innerHTML = '<ruby>漢字<rt>かんじ</rt></ruby>を<ruby>取<rt>と</rt></ruby>り<ruby>扱<rt>あつか</rt></ruby>う'; document.body.append(d); const r = document.createRange(); r.selectNodeContents(d); return { plain: S.plainText(d), sel: S.withoutReadings(r)}; });
  ok('the text without its readings: copied, read aloud', plain.plain === '漢字を取り扱う' && plain.sel === '漢字を取り扱う');
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
