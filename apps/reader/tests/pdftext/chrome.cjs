// node tests/pdftext/chrome.cjs <langs-dir> <outdir>: the same sentences (langs.json) set by Chromium's PDF writer
// (Skia: a different kind of font embedding and text positioning from LibreOffice's) — plain; in two columns;
// justified in a narrow column with hyphens; Japanese and Chinese also written vertically; Arabic also with
// footnote numbers raised, and in a bold web font. Each as lang-<xx>[-variant].pdf, with langs.json copied.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const [src, out] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const texts = JSON.parse(fs.readFileSync(path.join(src, 'langs.json'), 'utf8'));
const RTL = new Set(['ar', 'fa', 'ur']);
const FONT = { ar: "'Noto Naskh Arabic', 'DejaVu Sans'", fa: "'DejaVu Sans'", ur: "'DejaVu Sans'", ja: "'Noto Serif CJK JP'", zh: "'Noto Serif CJK SC'", ko: "'Noto Serif CJK KR'", hi: 'FreeSerif', th: 'Loma', vi: "'DejaVu Serif'" };
const html = (lang, lines, style, extra = '') => `<!doctype html><html lang="${lang}" dir="${RTL.has(lang) ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>body{font-family:${FONT[lang] || "'Liberation Serif'"};font-size:14pt;line-height:1.7;margin:40px}${style}</style></head><body>${extra}${lines.map((l) => `<p>${l}</p>`).join('')}</body></html>`;
(async () => {
  const b = await chromium.launch(); const page = await b.newPage();
  const variants = {};
  for (const [lang, lines] of Object.entries(texts)) {
    variants[lang] = html(lang, lines, '');
    variants[`${lang}-cols`] = html(lang, lines, 'body{column-count:2;column-gap:30px;font-size:12pt}');
    variants[`${lang}-narrow`] = html(lang, lines, 'p{width:220px;text-align:justify;hyphens:auto;-webkit-hyphens:auto}');
    if (lang === 'ja' || lang === 'zh') variants[`${lang}-vertical`] = html(lang, lines, 'body{writing-mode:vertical-rl;height:600px}');
    if (lang === 'ar') { variants['ar-notes'] = html(lang, lines.map((l, i) => l.replace(/[.،]/, (m) => `<sup>(${'١٢٣'[i]})</sup>${m}`)), 'sup{font-size:9pt}'); }
  }
  for (const [name, h] of Object.entries(variants)) {
    await page.setContent(h, { waitUntil: 'load' });
    await page.pdf({ path: path.join(out, `lang-${name}.pdf`), format: 'A4', printBackground: false });
  }
  fs.copyFileSync(path.join(src, 'langs.json'), path.join(out, 'langs.json'));
  console.log('made', Object.keys(variants).length);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
