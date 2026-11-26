#!/bin/sh
# Rebuilds corpus3's PDFs from src/ where the programs exist (the test, tests/pdf2docxcorpus3.cjs, only reads pdf/*.pdf).
# Needs: python3 with python-docx and python-pptx, soffice (LibreOffice 24.2), Playwright's Chromium (global node module),
# wkhtmltopdf, pdflatex, xelatex (fonts: Carlito, Liberation, FreeSerif). Work files go to $CORPUS_WORK (default /tmp/corpus3-work).
#   kinds x programs: invoice (lo, chrome)  paper (pdflatex, lo)  arabic (lo, chrome, xelatex)  slides (lo, chrome)
#                     form (lo, wk)  book (xelatex, lo)
set -e
H=$(cd "$(dirname "$0")" && pwd); W=${CORPUS_WORK:-/tmp/corpus3-work}; OUT="$H/pdf"; mkdir -p "$W" "$OUT"
cd "$H/src" && python3 -B content.py && python3 -B gen.py
rm -rf src/__pycache__; cp "$H"/src/*.* "$W"/; cd "$W"
# LibreOffice Writer / Impress (tagged PDF, as its default export)
for k in invoice paper arabic form book slides; do
  f=$k.docx; [ $k = slides ] && f=slides.pptx
  soffice -env:UserInstallation=file://$W/lo-profile --headless --convert-to pdf --outdir "$W/lo" "$W/$f" >/dev/null 2>&1
  cp "$W/lo/$k.pdf" "$OUT/$k-lo.pdf"
done
# Chromium (Playwright's page.pdf; the invoice's small print as the page footer)
NODE_PATH=$(npm root -g) node -e '
const { chromium } = require("playwright"); const W = process.argv[1], OUT = process.argv[2], H = process.argv[3];
(async () => { const b = await chromium.launch(); const p = await b.newPage();
  const foot = JSON.parse(require("fs").readFileSync(H + "/truth/invoice.json", "utf8")).meta.footer;
  for (const k of ["invoice", "arabic", "slides"]) {
    await p.goto("file://" + W + "/" + k + ".html"); await p.waitForTimeout(300);
    const o = { path: OUT + "/" + k + "-chrome.pdf", printBackground: true, preferCSSPageSize: true, tagged: true };
    if (k === "invoice") Object.assign(o, { displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: `<div style="font-size:7.5pt;width:100%;margin:0 20mm;font-family:Carlito">${foot}</div>` });
    await p.pdf(o); }
  await b.close(); })();' "$W" "$OUT" "$H"
# wkhtmltopdf (the form)
wkhtmltopdf -q --page-size A4 -T 20mm -B 20mm -L 20mm -R 20mm "$W/form.html" "$OUT/form-wk.pdf" || true
# pdfLaTeX (the paper), XeLaTeX (the Arabic page, the book): two runs each so references settle
pdflatex -interaction=nonstopmode paper.tex >/dev/null 2>&1 || true; pdflatex -interaction=nonstopmode paper.tex >/dev/null 2>&1; cp paper.pdf "$OUT/paper-pdflatex.pdf"
xelatex -interaction=nonstopmode arabic.tex >/dev/null 2>&1; cp arabic.pdf "$OUT/arabic-xelatex.pdf"
xelatex -interaction=nonstopmode book.tex >/dev/null 2>&1 || true; xelatex -interaction=nonstopmode book.tex >/dev/null 2>&1; cp book.pdf "$OUT/book-xelatex.pdf"
ls -la "$OUT"
