#!/bin/sh
# pdfLaTeX, XeLaTeX, LuaLaTeX from the .tex renderings (two runs each so references settle).
W=${CORPUS_WORK:-/tmp/corpus2-work}; H=$(cd "$(dirname "$0")" && pwd); cp "$H/figure.png" "$W/figure.png"
for e in pdflatex xelatex lualatex; do
  python3 "$H/gen_tex.py" $e && (cd "$W" && $e -interaction=nonstopmode -halt-on-error $e.tex >$e.log 2>&1; $e -interaction=nonstopmode $e.tex >$e.log 2>&1; tail -3 $e.log | head -2; cp $e.pdf "$H/../pdf/$e.pdf")
done
