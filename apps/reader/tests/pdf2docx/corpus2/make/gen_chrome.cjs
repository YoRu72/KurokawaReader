// node gen_chrome.cjs: Chromium print-to-PDF (Playwright's page.pdf, with header/footer template, tagged on and off)
// and Chrome's own command line (--print-to-pdf, no header/footer).  Needs: playwright (global), google-chrome.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs'); const { execFileSync } = require('child_process');
const W = process.env.CORPUS_WORK || '/tmp/corpus2-work'; const OUT = path.join(__dirname, '../pdf');
const src = JSON.parse(fs.readFileSync(path.join(__dirname, '../source.json'), 'utf8')).meta;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); await p.goto('file://' + path.join(W, 'source.html'));
  const hf = { displayHeaderFooter: true, headerTemplate: `<div style="font-size:9px;width:100%;text-align:center">${src.header}</div>`, footerTemplate: `<div style="font-size:9px;width:100%;text-align:center">${src.footer} - Page <span class="pageNumber"></span></div>`, format: 'A4', margin: { top: '24mm', bottom: '22mm', left: '20mm', right: '20mm' }, printBackground: true };
  await p.pdf({ ...hf, tagged: true, outline: true, path: path.join(OUT, 'chrome-pw-tagged.pdf') });
  await p.pdf({ ...hf, tagged: false, outline: false, path: path.join(OUT, 'chrome-pw-untagged.pdf') });
  await b.close();
  try { execFileSync('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', '--print-to-pdf=' + path.join(OUT, 'chrome-cli.pdf'), 'file://' + path.join(W, 'source.html')], { stdio: 'ignore', timeout: 90000 }); } catch (e) { console.log('chrome cli failed', e.message.slice(0, 100)); }
})();
