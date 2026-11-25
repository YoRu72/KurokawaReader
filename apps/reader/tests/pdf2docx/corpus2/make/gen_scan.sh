#!/bin/sh
# Image-only "scan" (the LibreOffice tagged PDF rasterised at 200 dpi, grey JPEG, re-wrapped with ImageMagick/reportlab)
# and the same pages through tesseract's pdf output (invisible text over the scan), plus qpdf rewrites.
set -e
W=${CORPUS_WORK:-/tmp/corpus2-work}; H=$(cd "$(dirname "$0")" && pwd); OUT="$H/../pdf"; mkdir -p "$W/scan"; cd "$W/scan"; rm -f *
pdftoppm -r 200 -mono -tiff -tiffcompression ccittfax4 "$OUT/lo-docx-untagged.pdf" pg
ls pg-*.tif > list.txt
python3 "$H/wrap_scan.py" "$W/scan" "$OUT/scan-image.pdf"
tesseract list.txt ocr -l eng+ara+jpn+chi_sim pdf >/dev/null 2>&1 && cp ocr.pdf "$OUT/scan-ocr.pdf" || echo "tesseract pdf failed"
# qpdf rewrites
qpdf --linearize "$OUT/lo-docx-tagged.pdf" "$OUT/qpdf-linearized.pdf"
qpdf --object-streams=generate --compress-streams=y "$OUT/chrome-pw-tagged.pdf" "$OUT/qpdf-objstm.pdf"
qpdf --encrypt "" owner-pass-123 256 -- "$OUT/reportlab.pdf" "$OUT/qpdf-encrypted.pdf"
