# Legacy Arabic fonts (3B2 / Advent)

Some Arabic PDFs (typeset with 3B2 and the "Advent" fonts: Adv_Lots_*, Adv.Fan*, Adv.QAM*, Advzy* Quran word
fonts, and the same fonts renamed FontNNN) file each letter shape under a Latin code and carry no usable
/ToUnicode, so every reader copies Latin garbage from them. The reader recognises their glyphs by outline:
`scripts/pdfjs-legacy-glyphs.js` maps an FNV-1a hash of each glyph's Type 2 charstring to its text.

To add fonts from another book:
1. `PDF=book.pdf python3 hashes.py` — glyph hashes and extents per font → `hashes.json`.
2. `PDF=book.pdf python3 grid.py <first page> <last page>` — one image per font with every glyph and its name.
3. Label the glyphs in `labels.py` (by scheme: fonts that share a layout share a table).
4. `python3 gen.py /tmp/t.js`, then put the generated map at the top of `scripts/pdfjs-legacy-glyphs.js`.
5. Check with `node tests/pdftext/copy.cjs <file.pdf> <page>` (what Copy gives for a whole page).

Notes: one stroke glyph can serve as fatha and (drawn lower) kasra — the worker turns a fatha drawn well below
the letter's baseline into a kasra. Kashida pieces read as tatweel; wasla marks read as nothing.
