#!/bin/sh
# wkhtmltopdf from the same HTML (header/footer by its own flags; links and outline are its defaults).
W=${CORPUS_WORK:-/tmp/corpus2-work}; H=$(cd "$(dirname "$0")" && pwd)
wkhtmltopdf -q --page-size A4 -T 22mm -B 20mm -L 20mm -R 20mm --header-center "Tidewater Survey - Working Draft" --header-font-size 8 --footer-center "Lanternfield Harbour Board - Page [page]" --footer-font-size 8 "$W/source.html" "$H/../pdf/wkhtmltopdf.pdf"
