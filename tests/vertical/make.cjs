// node tests/vertical/make.cjs: vertical Japanese, Chinese and Korean test PDFs (and a mixed-script one), printed by Chromium.
const { chromium } = require('playwright');
const docs = {
  'ja-vertical': `<html lang="ja"><style>body{writing-mode:vertical-rl;font-family:'Noto Serif CJK JP';font-size:16pt;line-height:1.8;margin:0}h1{font-size:22pt}.tcy{text-combine-upright:all}</style><body>
<h1>吾輩は猫である</h1>
<p>吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。</p>
<p>吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。この書生というのは時々我々を捕えて煮て食うという話である。</p>
<p>「明治<span class="tcy">38</span>年」に発表された。第一章は<span class="tcy">10</span>頁ほど。</p></body></html>`,
  'zh-vertical': `<html lang="zh-Hant"><style>body{writing-mode:vertical-rl;font-family:'Noto Serif CJK TC';font-size:16pt;line-height:1.9;margin:0}</style><body>
<h2>桃花源記</h2><p>晉太元中，武陵人捕魚為業。緣溪行，忘路之遠近。忽逢桃花林，夾岸數百步，中無雜樹，芳草鮮美，落英繽紛。漁人甚異之。復前行，欲窮其林。</p>
<p>林盡水源，便得一山，山有小口，彷彿若有光。便捨船，從口入。初極狹，纔通人。復行數十步，豁然開朗。</p></body></html>`,
  'ko-vertical': `<html lang="ko"><style>body{writing-mode:vertical-rl;font-family:'Noto Serif CJK KR';font-size:16pt;line-height:1.9;margin:0}</style><body>
<h2>세로쓰기</h2><p>세로쓰기로 적은 한국어 문장입니다. 이 글은 위에서 아래로, 오른쪽에서 왼쪽으로 읽습니다.</p></body></html>`,
  'mixed-scripts': `<html><style>body{font-family:'Noto Sans','Noto Sans Hebrew','Noto Sans Thai','Noto Sans Devanagari',sans-serif;font-size:14pt;margin:0}</style><body>
<p dir="rtl" lang="he">שלום עולם. זהו משפט בעברית עם מספר 2026 ומילה English בתוכו.</p>
<p lang="th">ภาษาไทยเขียนติดกันโดยไม่มีการเว้นวรรคระหว่างคำ สวัสดีครับ</p>
<p lang="hi">हिन्दी देवनागरी लिपि में लिखी जाती है। नमस्ते दुनिया।</p>
<p lang="el">Ελληνικά: Καλημέρα κόσμε. Русский: Привет, мир.</p></body></html>`,
};
(async () => { const b = await chromium.launch(); const p = await b.newPage();
  for (const [n, html] of Object.entries(docs)) { await p.setContent(html); await p.waitForTimeout(300); await p.pdf({ path: n + '.pdf', format: 'A5', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } }); }
  await b.close(); })();
