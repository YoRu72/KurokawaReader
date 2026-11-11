# PDF → DOCX fidelity checks

Regression tools for the layout-keeping PDF → Word converter (`src/pdf2docx.ts`).

1. `node scripts/build.mjs`
2. `node tests/pdf2docx/convert.cjs <file.pdf> <outdir>` — imports the PDF into the built app (headless Chromium),
   converts it to Word, saves `outdir/out.docx`, renders it with LibreOffice to `outdir/out.pdf`, and writes page
   images `a-N.png` (original) and `b-N.png` (converted). `PW=<password>` answers password prompts;
   `NOLO=1` skips the LibreOffice step (large books).
3. `node tests/pdf2docx/metrics.mjs <file.pdf> <outdir>/out.pdf` — matches text lines between the two and prints,
   per page, the baseline error (mean/max, points) and line-edge differences, plus the page counts.

Judge the result *without* the PDF's fonts installed — that is what a reader of the .docx has. The converter
embeds the PDF's own fonts; a subset font with no Unicode map (LibreOffice, many Arabic PDFs) is rebuilt first
(`src/fontfix.ts`: cmap, Arabic positional forms, ligatures in the PDF's priority, contextual variants, mark
positions). LibreOffice is a development aid: Word is the reference renderer for right-to-left layout.

`gsub-sim.py <font.ttf> <text>…` prints the glyphs a rebuilt font gives for a text (positional forms, rlig, calt),
to compare with the glyph codes the PDF used.

`corpus/` has the sources of the varied test PDFs: `mkdocx.py` (Word-style documents: report, two columns,
mixed Arabic/English table, CJK, landscape, tables with merged cells (gridSpan and vMerge, both directions) with coloured words and red harakat, pages filled to their last line — saved as .docx, then `soffice --convert-to pdf`), LaTeX
(`paper.tex` two-column with a formula, table and footnote; `t3.tex` Type 3 fonts; `xe.tex` XeLaTeX), and `mkdesign.py` (what Canva and Figma export: every glyph placed on its own, wide tracking, rotated text, overlapping layers, a background picture, a title drawn as outlines — `design.pdf`). LibreOffice does not turn rotated text boxes; Word does. Add
encrypted copies with `qpdf --encrypt`.
Target on the reference Arabic books: same page count, mean baseline error under 2 pt.

`node tests/pdf2docxrules.cjs` (CI-safe) converts `tests/pdf2docx/fixtures/merged.pdf`, `fullpage.pdf` (LibreOffice output of
the corpus's merged.docx and fullpage.docx) and a ruled table made with pdf-lib, and checks word/document.xml: spans and
vertical merges, each word's cell, run colours (coloured marks as runs of their own), a section per PDF page; with
`soffice` on the PATH it also checks the rendered page counts. `LINE=fit` with convert.cjs logs each line's width check
(PDF width, glyph advances, spaces) — lines wider than the page get narrower spaces.
