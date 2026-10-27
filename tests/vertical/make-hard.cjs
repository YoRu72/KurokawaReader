// node tests/vertical/make-hard.cjs: harder vertical pages — ruby (furigana) beside the columns, a horizontal title over vertical text, two
// paragraphs of different sizes, punctuation and long vowel marks, and a Mongolian column.
const { chromium } = require('playwright'); const path = require('path');
const docs = {
  'ja-ruby': `<html lang="ja"><style>body{writing-mode:vertical-rl;font-family:'Noto Serif CJK JP';font-size:16pt;line-height:2;margin:0}h1{writing-mode:horizontal-tb;font-size:20pt;margin:0 0 12pt}rt{font-size:8pt}</style><body><h1>横書きの見出し</h1>
<p><ruby>吾輩<rt>わがはい</rt></ruby>は<ruby>猫<rt>ねこ</rt></ruby>である。<ruby>名前<rt>なまえ</rt></ruby>はまだ無い。</p>
<p style="font-size:12pt">どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。「ふーん」と言った。</p>
<p>ー長音記号、々繰り返し、〜波ダッシュ。終わり。</p></body></html>`,
  'mn-vertical': `<html lang="mn"><style>body{writing-mode:vertical-lr;font-family:'Noto Sans Mongolian';font-size:18pt;line-height:2;margin:0}</style><body><p>ᠮᠣᠩᠭᠣᠯ ᠪᠢᠴᠢᠭ᠌ ᠪᠣᠯ ᠮᠣᠩᠭᠣᠯ ᠬᠡᠯᠡ ᠶᠢ ᠲᠡᠮᠳᠡᠭᠯᠡᠬᠦ ᠪᠢᠴᠢᠭ ᠦᠰᠦᠭ ᠶᠤᠮ᠃</p><p>ᠡᠨᠡ ᠪᠣᠯ ᠬᠣᠶᠠᠳᠤᠭᠠᠷ ᠥᠭᠦᠯᠡᠪᠦᠷᠢ᠃</p></body></html>`,
};
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  for (const [n, html] of Object.entries(docs)) { await p.setContent(html); await p.waitForTimeout(300); await p.pdf({ path: path.join(__dirname, n + '.pdf'), format: 'A5', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } }); }
  await b.close();
})();
