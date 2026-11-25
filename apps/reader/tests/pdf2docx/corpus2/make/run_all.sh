#!/bin/sh
# Regenerates every PDF in ../pdf and ../manifest.json (by hand, on a machine with the programs listed in README.md).
set -e
H=$(cd "$(dirname "$0")" && pwd); export NODE_PATH=${NODE_PATH:-$(npm root -g)}
cd "$H"
python3 mksource.py; python3 mkfigure.py; python3 gen_docx.py; ./gen_lo.sh
python3 gen_html.py; node gen_chrome.cjs; ./gen_wk.sh || true
./gen_tex.sh || true
python3 gen_reportlab.py; node gen_pdflib.cjs
./gen_scan.sh
python3 gen_manifest.py
