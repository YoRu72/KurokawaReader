#!/bin/sh
# LibreOffice Writer exports: from the python-docx .docx and from a .fodt LibreOffice itself saved from it;
# tagged on / off, and PDF/A-2b once. Needs: soffice, python3 gen_docx.py already run.
set -e
W=${CORPUS_WORK:-/tmp/corpus2-work}; H=$(cd "$(dirname "$0")" && pwd); OUT="$H/../pdf"; PROF="-env:UserInstallation=file://$W/lo-profile"
cd "$W"; mkdir -p lo
exp() { # <input> <outname> <json options>
  rm -rf lo/x; mkdir lo/x
  soffice "$PROF" --headless --convert-to "pdf:writer_pdf_Export:$3" --outdir lo/x "$1" >/dev/null 2>&1
  mv lo/x/$(basename "${1%.*}").pdf "$OUT/$2.pdf"
}
T='{"UseTaggedPDF":{"type":"boolean","value":"true"}}'
U='{"UseTaggedPDF":{"type":"boolean","value":"false"}}'
A='{"SelectPdfVersion":{"type":"long","value":"2"},"UseTaggedPDF":{"type":"boolean","value":"true"}}'
exp source.docx lo-docx-tagged "$T"
exp source.docx lo-docx-untagged "$U"
exp source.docx lo-docx-pdfa "$A"
soffice "$PROF" --headless --convert-to fodt --outdir "$W" source.docx >/dev/null 2>&1
exp source.fodt lo-odt-tagged "$T"
exp source.fodt lo-odt-untagged "$U"
# "printed again": the LibreOffice PDF opened in LibreOffice Draw (its PDF import) and exported again
rm -rf lo/x; mkdir lo/x; cp "$OUT/lo-docx-untagged.pdf" lo/x/redo.pdf
soffice "$PROF" --headless --infilter="draw_pdf_import" --convert-to pdf:draw_pdf_Export --outdir lo/y lo/x/redo.pdf >/dev/null 2>&1 && mv lo/y/redo.pdf "$OUT/chain-lo-draw.pdf" || echo "draw re-export failed"
