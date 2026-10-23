// Builds the pdf.js worker with one addition: text extraction honours /ActualText.
//
// PDFs written by LibreOffice (and others) draw Arabic with harakat as separate glyphs — a mark,
// then its letter — each moved into place, and wrap every such cluster in a marked-content span
// whose /ActualText holds the real text in reading order ("بِ"). pdf.js ignores /ActualText, so
// the text layer (copy, search, PDF → DOCX) came out as scrambled letters and marks. Here each
// span becomes one text item carrying its /ActualText, placed over the glyphs it stands for —
// what Acrobat does. Patched as text so a pdfjs-dist update fails loudly if the code moved.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);

function replaceOnce(src, find, repl, label) {
  const i = src.indexOf(find);
  if (i < 0 || src.indexOf(find, i + 1) >= 0) throw new Error(`patch-pdfjs: anchor "${label}" not found exactly once — pdfjs-dist changed; update scripts/patch-pdfjs.mjs`);
  return src.slice(0, i) + repl + src.slice(i + find.length);
}

export async function buildPdfWorker(outFile) {
  let src = await fs.readFile(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'), 'utf8');

  // 1) state + helpers, declared next to the text item being built
  src = replaceOnce(src, '    const textContentItem = {', `    let krAT = null; // the /ActualText span being collected
    let krPageAT = false; // this page uses /ActualText spans: real spaces are then marked where they are drawn
    const krMark = /^[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/;
    function krAtBegin(props) {
      if (krAT) { krAT.depth++; return; }
      const v = props instanceof Dict ? props.get("ActualText") : null;
      if (typeof v !== "string") return;
      krAT = { str: stringToPDFString(v), depth: 1, minX: Infinity, maxX: -Infinity, anchor: null, first: null, fontName: null };
      krPageAT = true;
    }
    function krAtEnd() {
      if (!krAT) return false;
      if (--krAT.depth > 0) return true;
      const at = krAT; krAT = null;
      const a = at.anchor || at.first;
      if (!a || !at.str) return true;
      resetLastChars();
      const str = at.str.replace(/[\\u0000-\\u001f]/g, "");
      if (!str) return true;
      textContent.items.push({
        str,
        dir: /[\\u0590-\\u08ff\\ufb1d-\\ufdff\\ufe70-\\ufeff]/.test(str) ? "rtl" : "ltr",
        width: Math.max(0, at.maxX - at.minX),
        height: Math.hypot(a[2], a[3]),
        transform: [a[0], a[1], a[2], a[3], at.minX === Infinity ? a[4] : at.minX, a[5]],
        fontName: at.fontName,
        hasEOL: false
      });
      return true;
    }
    const textContentItem = {`, 'textContentItem');

  // 2) glyphs inside a span are measured and placed, not emitted one by one
  src = replaceOnce(src, `        if (category.isInvisibleFormatMark) {
          continue;
        }
        let charSpacing = baseCharSpacing + (i + 1 === ii ? extraSpacing : 0);`, `        if (category.isInvisibleFormatMark) {
          continue;
        }
        if (krAT && !font.vertical) {
          let cs = baseCharSpacing + (i + 1 === ii ? extraSpacing : 0);
          if (originalCharCode === 0x20) cs += textState.wordSpacing;
          const sd = glyph.width * scale; // a letter carrying its mark ("بِ") still has its full width
          ensureTextContentItem(); // registers the font style for the text layer
          textContentItem.initialized = false;
          krAT.fontName = textState.loadedName;
          const t0 = getCurrentTextTransform();
          textState.translateTextMatrix(sd * textState.textHScale, 0);
          const t1 = getCurrentTextTransform();
          if (cs) textState.translateTextMatrix(cs * textState.textHScale, 0);
          krAT.first ||= t0;
          krAT.minX = Math.min(krAT.minX, t0[4], t1[4]);
          krAT.maxX = Math.max(krAT.maxX, t0[4], t1[4]);
          // The base letter, not a mark drawn above or below it, gives the line's baseline.
          if (!krAT.anchor && glyph.width > 0 && !krMark.test(glyph.unicode || "")) krAT.anchor = t0;
          continue;
        }
        if (krPageAT && !keepWhiteSpace && category.isWhitespace && !font.vertical) {
          // A space drawn between /ActualText clusters: keep it where it is (U+2009 tells the reader
          // it is a real word break, unlike the gap-filling spaces pdf.js invents).
          let cs = baseCharSpacing + (i + 1 === ii ? extraSpacing : 0);
          if (originalCharCode === 0x20) cs += textState.wordSpacing;
          const t0 = getCurrentTextTransform();
          textState.translateTextMatrix((glyph.width * scale + cs) * textState.textHScale, 0);
          const t1 = getCurrentTextTransform();
          flushTextContentItem();
          resetLastChars();
          textContent.items.push({ str: "\u2009", dir: "ltr", width: Math.max(0.01, t1[4] - t0[4]), height: Math.hypot(t0[2], t0[3]), transform: t0, fontName: textState.loadedName, hasEOL: false });
          continue;
        }
        let charSpacing = baseCharSpacing + (i + 1 === ii ? extraSpacing : 0);`, 'glyph loop');

  // 2b) One glyph that stands for several Arabic letters (a ligature such as "في", or a letter with
  // its mark) carries them in reading order; the whole run is later reversed from drawing order
  // to reading order, which would turn the ligature round ("يف"). Pre-reverse it so it comes out right.
  src = replaceOnce(src, `        if (!intersector) {
          textChunk.str.push(glyphUnicode);
        }`, `        if (!intersector) {
          textChunk.str.push(glyphUnicode.length > 1 && /^[\\u0600-\\u06ff\\u0750-\\u077f\\ufb50-\\ufdff\\ufe70-\\ufeff]+$/.test(glyphUnicode) ? [...glyphUnicode].reverse().join("") : glyphUnicode);
        }`, 'glyph push');

  // 3) marked content begin/end in getTextContent
  src = replaceOnce(src, `          case OPS.beginMarkedContent:
            flushTextContentItem();
            if (includeMarkedContent) {
              markedContentData.level++;`, `          case OPS.beginMarkedContent:
            flushTextContentItem();
            if (krAT) krAT.depth++;
            if (includeMarkedContent) {
              markedContentData.level++;`, 'BMC');
  src = replaceOnce(src, `          case OPS.beginMarkedContentProps:
            flushTextContentItem();
            if (includeMarkedContent) {
              markedContentData.level++;
              const mcid`, `          case OPS.beginMarkedContentProps:
            flushTextContentItem();
            krAtBegin(args[1]);
            if (includeMarkedContent) {
              markedContentData.level++;
              const mcid`, 'BDC');
  src = replaceOnce(src, `          case OPS.endMarkedContent:
            flushTextContentItem();
            if (includeMarkedContent) {
              if (markedContentData.level === 0) {`, `          case OPS.endMarkedContent:
            flushTextContentItem();
            krAtEnd();
            if (includeMarkedContent) {
              if (markedContentData.level === 0) {`, 'EMC');

  const out = await esbuild.transform(src, { minify: true, format: 'esm', target: 'es2020', legalComments: 'inline' });
  await fs.writeFile(outFile, out.code);
}
