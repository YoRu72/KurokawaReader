// node tests/pdftext/punct.cjs [dir]: Arabic lines with the punctuation that went wrong when copied — brackets
// and quotes named by their mirrored glyph, * / @ ; a Latin phrase inside an Arabic paragraph with an Arabic
// word after it, a number with a slash — printed to PDF by Chromium in three fonts, then copied from the
// built reader and compared with the lines as written. Also ruby and Mongolian columns (see vertical/make.cjs).
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const dir = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'kr-punct')); fs.mkdirSync(dir, { recursive: true });
const lines = [
  'قَالَ الشَّيْخُ (رَحِمَهُ اللهُ): "الْعِلْمُ نُورٌ"؛ وَهَذَا * مِثَالٌ / آخَرُ @ هُنَا.',
  'الْمَسْأَلَةُ (١٢) فِي الْبَابِ (الثَّانِي) مِنْ كِتَابِ «الْأُمِّ».',
  'see (note 3) and "quoted" text; a/b * c @ d — then عربي (مُعَرَّب) again.',
  'وَقَوْلُهُ: (وَمَا أَرْسَلْنَاكَ إِلَّا رَحْمَةً) [الأنبياء: ١٠٧] يَدُلُّ عَلَى ذَلِكَ.',
  'الْجُزْءُ ١/٢ ، وَالنِّسْبَةُ ٥٠٪ ؛ وَالْبَرِيدُ: user@example.com ، وَالتَّعْبِيرُ: (أ) ثُمَّ (ب).',
];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  for (const font of ['Noto Naskh Arabic', 'Amiri', 'Scheherazade New']) {
    const html = `<html lang="ar" dir="rtl"><meta charset="utf-8"><style>body{font-family:'${font}', 'Noto Naskh Arabic';font-size:16pt;line-height:2;margin:40px} p{margin:0 0 8px}</style><body>${lines.map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('')}</body></html>`;
    await p.setContent(html); await p.waitForTimeout(300);
    await p.pdf({ path: path.join(dir, `${font.replace(/\s+/g, '').toLowerCase()}.pdf`), format: 'A4' });
  }
  await b.close();
  let bad = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.pdf'))) {
    const got = execFileSync('node', [path.join(__dirname, 'copy.cjs'), path.join(dir, f), '1'], { encoding: 'utf8' }).trim().split('\n').slice(0, lines.length);
    lines.forEach((want, i) => { if (got[i] !== want) { bad++; console.log(`FAIL ${f} line ${i + 1}\n  got:  ${got[i]}\n  want: ${want}`); } });
    console.log(`${f}: ${lines.length - lines.filter((want, i) => got[i] !== want).length}/${lines.length} lines as written`);
  }
  process.exit(bad ? 1 : 0);
})();
