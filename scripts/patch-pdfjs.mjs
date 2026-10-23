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
    const krGlyphs = new WeakMap(); // item → glyphs in drawing order with their extents (until the batch is sent)
    let krPending = []; // harakat drawn apart from their run, waiting for its letters
    /** Place the pending marks on the letters now in this batch; at the end (or once stale) report the rest as pieces. */
    function krResolveMarks(final) {
      if (!krPending.length) return;
      const keep = [];
      for (const m of krPending) {
        if (krAttachMark(m.mark, m.x, m.y)) continue;
        if (final || ++m.age > 3) { m.item.transform[4] = m.x; textContent.items.push(m.item); } else keep.push(m);
      }
      krPending = keep;
    }
    /** Put a haraka drawn at x right after the glyph under it, in an item of this batch; false when no item fits. */
    function krAttachMark(mark, x, y) {
      // The run whose line the mark belongs to: marks sit just above their baseline (kasra just below),
      // so the best fit is the smallest distance from the mark to a point a third of a line above the baseline.
      let best = null, bestD = Infinity;
      for (let k = textContent.items.length - 1; k >= 0; k--) {
        const it = textContent.items[k]; const g = krGlyphs.get(it);
        if (!g || it.dir !== "rtl") continue;
        const h = it.height || 10, base = it.transform[5];
        if (y < base - h * 0.6 || y > base + h * 1.2) continue;
        const hit = g.gx.find(([, a, b]) => x >= a - 0.5 && x <= b + 0.5);
        if (!hit) continue;
        const d = Math.abs(y - (base + h * 0.33));
        if (d < bestD) { bestD = d; best = { it, g, hit }; }
      }
      if (!best) return false;
      const { it, g, hit } = best;
      const visual = g.visual.join("");
      // Only when the item is exactly its drawing order turned round (pure right-to-left) can positions be mapped.
      if (it.str !== [...visual].reverse().join("")) return false;
      const startChar = g.visual.slice(0, hit[0]).join("").length;
      const glyphStr = g.visual[hit[0]] || "";
      const glyphLen = glyphStr.length;
      if (!glyphLen) return false;
      const chars = [...it.str];
      // The glyph's characters in reading order run from ls to ls + glyphLen; one glyph can carry two letters
      // (a ligature such as "نى"): the mark's place across the glyph, right to left, picks the letter.
      const ls = chars.length - startChar - glyphLen;
      const letters = [];
      for (let k = ls; k < ls + glyphLen; k++) if (!krMark.test(chars[k])) letters.push(k);
      let at = ls + glyphLen;
      if (letters.length > 1) {
        const f = Math.min(0.999, Math.max(0, (hit[2] - x) / Math.max(0.01, hit[2] - hit[1])));
        at = letters[Math.floor(f * letters.length)] + 1;
      }
      while (at < chars.length && krMark.test(chars[at])) at++;
      chars.splice(at, 0, mark);
      it.str = chars.join("");
      // The glyph map follows the change (the mark is part of that glyph now).
      g.visual[hit[0]] = mark + g.visual[hit[0]];
      return true;
    }
    let krPageAT = false; // this page uses /ActualText spans: real spaces are then marked where they are drawn
    const krMark = /^[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/;
    // Fill colour and text render mode, carried on the (cloned per q/Q) text state.
    function krSetFill(rgb) {
      const hex = rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round((+v || 0) * 255))).toString(16).padStart(2, "0")).join("");
      if ((textState.krFill || "000000") !== hex) flushTextContentItem();
      textState.krFill = hex;
    }
    function krStrokeEm() {
      if (textState.krTr !== 2) return 0;
      const size = Math.abs(textState.fontSize) * Math.hypot(textState.textMatrix[0], textState.textMatrix[1]) || 1;
      return (textState.krLW ?? 1) / size;
    }
    function krCmyk(c, m, y, k) { return [1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)]; }
    function krAtBegin(props) {
      if (krAT) { krAT.depth++; return; }
      const v = props instanceof Dict ? props.get("ActualText") : null;
      if (typeof v !== "string") return;
      krAT = { str: stringToPDFString(v), depth: 1, minX: Infinity, maxX: -Infinity, anchor: null, first: null, fontName: null, color: textState.krFill || null, bold: textState.krTr === 2, strokeEm: 0 };
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
        hasEOL: false,
        color: at.color,
        fakeBold: at.bold,
        strokeEm: at.strokeEm
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
          if (krAT.bold && !krAT.strokeEm) krAT.strokeEm = krStrokeEm();
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
        // A haraka drawn away from the run it would join (Word draws marks after the text, jumping back to their
        // letter): report it as its own piece at its place, so readers can put it back on that letter.
        if (!font.vertical && krMark.test(glyph.unicode || "") && textContentItem.initialized && textContentItem.krMinX !== undefined) {
          const mtr = getCurrentTextTransform();
          const mx = mtr[4];
          const em = Math.hypot(mtr[0], mtr[1]);
          const tol = em * 0.15;
          if (mx < textContentItem.krMinX - tol || mx > textContentItem.krMaxX + tol) {
            flushTextContentItem();
            const t0 = getCurrentTextTransform();
            // Where the mark shows: its origin plus the centre of its outline (when the font tells).
            const gc = krGlyphCentre(font, originalCharCode);
            const cx = gc === null ? null : mx;
            // Word draws a line's harakat before its letters: hold the mark until the letters are in.
            krPending.push({ mark: glyph.unicode, x: cx ?? mx, y: t0[5], age: 0, item: { str: glyph.unicode, dir: "rtl", width: 0, height: Math.hypot(t0[2], t0[3]), transform: t0, fontName: textState.loadedName, hasEOL: false, color: textState.krFill || null, krMark: true } });
            continue;
          }
        }
        let charSpacing = baseCharSpacing + (i + 1 === ii ? extraSpacing : 0);`, 'glyph loop');

  // 2d) marks are placed before a batch leaves, and the last ones at the end; batches hold more items
  src = replaceOnce(src, `      if (batch && length < TEXT_CHUNK_BATCH_SIZE) {
        return;
      }
      sink.enqueue(textContent, length);`, `      if (batch && length < TEXT_CHUNK_BATCH_SIZE) {
        return;
      }
      krResolveMarks(false);
      sink.enqueue(textContent, textContent.items.length);`, 'enqueue marks');
  src = replaceOnce(src, `      if (stop) {
        next(deferred);
        return;
      }
      flushTextContentItem();
      enqueueChunk();
      resolve();`, `      if (stop) {
        next(deferred);
        return;
      }
      flushTextContentItem();
      krResolveMarks(true);
      enqueueChunk();
      resolve();`, 'final marks');
  src = replaceOnce(src, 'const TEXT_CHUNK_BATCH_SIZE = 10;', 'const TEXT_CHUNK_BATCH_SIZE = 200;', 'batch size');

  // 2c) each item remembers the horizontal extent of its glyphs (for the haraka check above)
  src = replaceOnce(src, `        const textChunk = ensureTextContentItem();
        if (category.isZeroWidthDiacritic) {
          scaledDim = 0;
        }`, `        const textChunk = ensureTextContentItem();
        {
          const gtr = getCurrentTextTransform();
          const gx = gtr[4];
          // In page space: glyph units → em (font matrix) → page (full transform, page scale included).
          const gw = Math.abs(glyph.width * textState.fontMatrix[0] * Math.hypot(gtr[0], gtr[1]) * textState.textHScale);
          if (textChunk.krMinX === undefined) { textChunk.krMinX = gx; textChunk.krMaxX = gx; }
          textChunk.krMinX = Math.min(textChunk.krMinX, gx); textChunk.krMaxX = Math.max(textChunk.krMaxX, gx + gw);
          (textChunk.krGX ||= []).push([textChunk.str.length, Math.min(gx, gx + gw), Math.max(gx, gx + gw)]);
        }
        if (category.isZeroWidthDiacritic) {
          scaledDim = 0;
        }`, 'glyph extent');
  src = replaceOnce(src, `      textContent.items.push(runBidiTransform(textContentItem));
      textContentItem.initialized = false;`, `      const krItem = runBidiTransform(textContentItem);
      textContent.items.push(krItem);
      if (textContentItem.krGX) krGlyphs.set(krItem, { visual: textContentItem.str.slice(), gx: textContentItem.krGX });
      textContentItem.initialized = false;
      textContentItem.krMinX = textContentItem.krMaxX = undefined;
      textContentItem.krGX = null;`, 'extent reset');

  // 2a) every text item says its fill colour and whether it is drawn bold by stroking (render mode 2)
  src = replaceOnce(src, `      textContentItem.hasEOL = false;
      textContentItem.initialized = true;`, `      textContentItem.hasEOL = false;
      textContentItem.krColor = textState.krFill || null;
      textContentItem.krBold = textState.krTr === 2;
      textContentItem.krStrokeEm = krStrokeEm();
      textContentItem.krRepaired = !!textState.font?.krToUnicodeRepaired;
      textContentItem.initialized = true;`, 'item init');
  src = replaceOnce(src, `      const bidiResult = bidi(text, -1, textChunk.vertical);
      return {
        str: bidiResult.str,`, `      const bidiResult = bidi(text, -1, textChunk.vertical);
      let krStr = bidiResult.str;
      // Glyphs from a rebuilt map are the drawn (mirrored) brackets; in right-to-left text turn them back.
      if (textChunk.krRepaired && bidiResult.dir === "rtl") krStr = krStr.replace(/[()[\\]{}«»]/g, (c) => ({ "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "«": "»", "»": "«" })[c]);
      // A haraka drawn on its own is joined to its letter again (no space before it, not after punctuation).
      krStr = krStr.replace(/\\s+(?=[\\u064b-\\u065f\\u0670])/g, "").replace(/([\\u060c\\u061b\\u061f.,:;!])([\\u064b-\\u065f\\u0670]+)/g, "$2$1");
      return {
        str: krStr,`, 'bidi str');
  src = replaceOnce(src, `        fontName: textChunk.fontName,
        hasEOL: textChunk.hasEOL
      };
    }`, `        fontName: textChunk.fontName,
        hasEOL: textChunk.hasEOL,
        color: textChunk.krColor,
        fakeBold: textChunk.krBold,
        strokeEm: textChunk.krStrokeEm
      };
    }`, 'bidi item');

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
              markedContentData.level++;`, `          case OPS.setFillGray:
            krSetFill([args[0], args[0], args[0]]);
            break;
          case OPS.setFillRGBColor:
            krSetFill(args);
            break;
          case OPS.setFillCMYKColor:
            krSetFill(krCmyk(args[0], args[1], args[2], args[3]));
            break;
          case OPS.setFillColor:
          case OPS.setFillColorN: {
            const nums = args.filter((v) => typeof v === "number");
            if (nums.length === 1) krSetFill([nums[0], nums[0], nums[0]]);
            else if (nums.length === 3) krSetFill(nums);
            else if (nums.length === 4) krSetFill(krCmyk(nums[0], nums[1], nums[2], nums[3]));
            break;
          }
          case OPS.setFillColorSpace:
            krSetFill([0, 0, 0]);
            break;
          case OPS.setLineWidth:
            if ((textState.krLW ?? 1) !== args[0] && textState.krTr === 2) flushTextContentItem();
            textState.krLW = args[0];
            break;
          case OPS.setTextRenderingMode:
            if ((textState.krTr || 0) !== args[0]) flushTextContentItem();
            textState.krTr = args[0];
            break;
          case OPS.beginMarkedContent:
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

  // 4) rebuild a broken /ToUnicode from the embedded font (see scripts/pdfjs-font-unicode.js)
  const fontUnicode = await fs.readFile(new URL('./pdfjs-font-unicode.js', import.meta.url), 'utf8');
  src = replaceOnce(src, 'class Font {\n', fontUnicode + '\nclass Font {\n', 'class Font');
  src = replaceOnce(src, `        case "OpenType":
        case "TrueType":
        case "CIDFontType2":
          this.mimetype = "font/opentype";
          data = this.checkAndRepair(name, file, properties);`, `        case "OpenType":
        case "TrueType":
        case "CIDFontType2":
          this.mimetype = "font/opentype";
          try { krRaw = file.getBytes(); file.reset(); } catch { krRaw = null; }
          data = this.checkAndRepair(name, file, properties);`, 'font case');
  src = replaceOnce(src, `    amendFallbackToUnicode(properties);
    this.data = data;`, `    amendFallbackToUnicode(properties);
    if (krRaw) krRepairToUnicode(this, krRaw, properties);
    this.data = data;`, 'font amend');
  src = replaceOnce(src, `    [type, subtype] = getFontFileType(file, properties);`, `    [type, subtype] = getFontFileType(file, properties);
    let krRaw = null;`, 'font raw decl');

  // 5) the untouched font program travels with the font (only when extra properties are asked for:
  //    PDF → DOCX embeds the PDF's own fonts in the document).
  src = replaceOnce(src, `    if (krRaw) krRepairToUnicode(this, krRaw, properties);`, `    if (krRaw) krRepairToUnicode(this, krRaw, properties);
    if (krRaw && this.fontExtraProperties) this.krRaw = krRaw;
    this.krNoToUnicode = !properties.hasIncludedToUnicodeMap;
    if (krRaw && properties.composite && !(properties.cidToGidMap && properties.cidToGidMap.length)) this.krRawAll = krRaw;`, 'font raw keep');
  src = replaceOnce(src, `const EXPORT_DATA_EXTRA_PROPERTIES = ["cMap",`, `const EXPORT_DATA_EXTRA_PROPERTIES = ["krRaw", "krToUnicodeRepaired", "krNoToUnicode", "cMap",`, 'export extra');

  const out = await esbuild.transform(src, { minify: true, format: 'esm', target: 'es2020', legalComments: 'inline' });
  await fs.writeFile(outFile, out.code);
}

/** esbuild plugin for the main pdf.js bundle: a canvas marked `krNoText` gets every page element but text
 *  (PDF → DOCX lays the page's graphics behind real, editable text). */
export const pdfjsMainPlugin = {
  name: 'kr-pdfjs-main',
  setup(build) {
    build.onLoad({ filter: /pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.mjs$/ }, async (args) => {
      let src = await fs.readFile(args.path, 'utf8');
      src = replaceOnce(src, '  showText(opIdx, glyphs) {\n', '  showText(opIdx, glyphs) {\n    if (this.ctx?.canvas?.krNoText && !this.ctx.canvas.krKeepFonts?.has(this.current.font?.loadedName)) return undefined;\n', 'showText');
      src = replaceOnce(src, '  showType3Text(opIdx, glyphs) {\n', '  showType3Text(opIdx, glyphs) {\n    if (this.ctx?.canvas?.krNoText) return undefined;\n', 'showType3Text');
      return { contents: src, loader: 'js' };
    });
  },
};
