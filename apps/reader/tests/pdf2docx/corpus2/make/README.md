# Generators for the corpus2 PDFs

Run by hand with `make/run_all.sh` (from anywhere). The test (`tests/pdf2docxcorpus.cjs`) needs NONE of these programs,
only the committed `../pdf/*.pdf`, `../manifest.json`, `../source.json` and `../floors.json`.

One made-up source document (`../source.json`, built by `mksource.py`; its figure is `figure.png` from `mkfigure.py`) is
rendered by every program through its natural route. Intermediate files go to `$CORPUS_WORK` (default `/tmp/corpus2-work`).

| script | program(s) needed | output |
| --- | --- | --- |
| `gen_docx.py` + `gen_lo.sh` | python-docx, soffice (LibreOffice 24.2) | `lo-docx-*` (tagged, untagged, PDF/A-2b), `lo-odt-*` (via a .fodt), `chain-lo-draw` |
| `gen_html.py` + `gen_chrome.cjs` | Playwright (global), google-chrome | `chrome-pw-tagged/untagged`, `chrome-cli` |
| `gen_wk.sh` | wkhtmltopdf | `wkhtmltopdf` (unpatched Qt: no header/footer) |
| `gen_tex.py` + `gen_tex.sh` | pdflatex, xelatex, lualatex | `pdflatex`, `xelatex`; **lualatex fails here**: `luaotfload-main.lua` is missing |
| `gen_reportlab.py` | python reportlab | `reportlab` |
| `gen_pdflib.cjs` | pdf-lib (global node module) | `pdflib` |
| `gen_scan.sh` + `wrap_scan.py` | pdftoppm, reportlab, tesseract (eng, ara, jpn, chi_sim), qpdf | `scan-image`, `scan-ocr`, `qpdf-linearized`, `qpdf-objstm`, `qpdf-encrypted` |
| `gen_manifest.py` | pdfinfo, pdffonts, pdftotext, version commands | `../manifest.json` |

Not carried, by tool (the manifest marks these features `absent` so they are not scored): Arabic by pdf-lib, ReportLab and
pdfLaTeX (no shaping/bidi package installed: `bidi.sty`, `polyglossia` needs it; `arabxetex` unused); Japanese/Chinese by pdf-lib
and pdfLaTeX (no `xeCJK`, `CJKutf8`, `luatexja`); footnotes by pdf-lib; running header/footer by wkhtmltopdf here and Chrome's
CLI; everything but text by the OCR PDF. Chromium's own "print again" from its PDF viewer is not scriptable, so the re-printed
chain is LibreOffice Draw importing and exporting a PDF.
