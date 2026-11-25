# PDFs from programs this machine does not have

Put PDFs made by Word, InDesign, Google Docs, Acrobat (or anything else) in this folder. `tests/pdf2docxcorpus.cjs` converts
and scores each one too.

- A PDF alone is scored on what needs no truth: converts at all, the DOCX opens (LibreOffice, when installed), seconds per
  page, header/footer and page-number pollution (page-number-like lines in the body), hyperlinks that are real, real Word
  lists, a heading style used at all, bidi marks on Arabic paragraphs, and whether text came out at all.
- With a small truth file next to it, `name.truth.json`, the text and structure checks run as well:
  `{ "text": "the document's plain text in reading order", "headings": [{"text": "...", "level": 1}], "links": [{"text": "...", "href": "..."}],
     "listItems": [{"text": "...", "kind": "bullet|number", "level": 0}], "footnotes": ["..."], "tableCells": [["..."]], "rtl": ["an Arabic paragraph"] }`
  (every key is optional; a missing key skips that measure).

Owner files are not part of `floors.json`; their table is printed and saved under the test's output folder, never failing the test.
Keep each file small (a few hundred KB) so the repository stays light.
