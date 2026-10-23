# PDF → DOCX fidelity checks

Regression tools for the layout-keeping PDF → Word converter (`src/pdf2docx.ts`).

1. `node scripts/build.mjs`
2. `node tests/pdf2docx/convert.cjs <file.pdf> <outdir>` — imports the PDF into the built app (headless Chromium),
   converts it to Word, saves `outdir/out.docx`, renders it with LibreOffice to `outdir/out.pdf`, and writes page
   images `a-N.png` (original) and `b-N.png` (converted). `PW=<password>` answers password prompts;
   `NOLO=1` skips the LibreOffice step (large books).
3. `node tests/pdf2docx/metrics.mjs <file.pdf> <outdir>/out.pdf` — matches text lines between the two and prints,
   per page, the baseline error (mean/max, points) and line-edge differences, plus the page counts.

Install the PDF's fonts locally before judging the result (LibreOffice otherwise substitutes wider fonts and
lines spill). LibreOffice is a development aid: Word is the reference renderer for right-to-left layout.
Target on the reference Arabic books: same page count, mean baseline error under 2 pt.
