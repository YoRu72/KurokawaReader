# KurokawaReader · قارئ كوروكاوا

**An offline reader for everything readable — with Arabic typography at its heart.**

KurokawaReader opens EPUB, PDF, DOCX, XLSX/CSV, PPTX, TXT, Markdown, HTML, FB2, ODT, CBZ and images, keeps them in a local library, and lets you read **several books in one continuous scroll**. It is a progressive web app: install it once and it works with no connection at all. Nothing you import ever leaves your device.

<p align="center">
  <img src="docs/screenshots/reading-together.png" width="48%" alt="Two EPUBs opened together, English then Arabic" />
  <img src="docs/screenshots/library-arabic.png" width="48%" alt="The library with the Arabic interface" />
</p>

## Features

**Design** — Material 3 Expressive: tonal surfaces, a large flexible headline on the library, an extended FAB for import, a floating toolbar for the reading actions, connected button groups, thick-track sliders with the tall thin handle, switches, a morphing loading indicator and springy shape changes on press. The interface chrome follows the page: light reading themes get light chrome.

**Starter books** — two public-domain books are bundled so the library is never empty: **مقامات الحريري** (the complete fifty maqāmāt with preface and epilogue, text from the Shamela library, book 26585, with printed page numbers) and **Alice's Adventures in Wonderland** (Standard Ebooks edition with the Tenniel illustrations). *Add two books to start* on the empty library, or from Settings.

**Reading**
- Own EPUB engine — every chapter is flowed into one column, so the reader's typography, theme and tools apply everywhere. Internal links, footnotes, SVG images and publisher fonts work; publisher styles are off by default and can be switched on.
- **Read together**: select several books in the library and open them in one session. You scroll from the end of book 1 straight into book 2, with each book's images, table of contents and progress kept separately.
- Dark theme by default for EPUBs, plus Black, Sepia, Paper, Light and a **Custom** theme with your own page and text colours.
- **Background systems**: textures (paper, linen, parchment, dots) with a strength control; your own **background picture** with opacity and blur; **comfort filters** — a warmth (night) filter and page dimming; one-tap presets (Night, Candlelight, Manuscript, Daylight, E-ink).
- **Visual Options**: Latin font, Arabic font, size, line height, paragraph spacing, text width, margins, alignment, word/letter spacing, hyphenation, image dimming, publisher styles. Black-on-transparent line art is inverted automatically on dark pages.
- Table of contents (nested), bookmarks, highlights, in-book search (diacritic- and case-insensitive, with Arabic letter-form folding), reading progress, resume where you left off.
- Auto-scroll with a speed control, read-aloud (device voices), immersive mode, full screen, keyboard shortcuts.
- **Images** gallery: every picture from the open books, with a lightbox and "show in text".

**Selection tools** — select any text to get *Copy · Search · Define · Translate · Highlight · Speak*. The reader is offline; Define and Translate are the only features that use the network, and they say so when there is none.

**PDF**: lazily rendered pages with a selectable text layer, **page slider**, **go to page**, previous/next, zoom and fit-width, outline, full-text **page search** with hit highlighting, optional dark rendering of pages, bookmarks.

**Office & text**: DOCX (headings, lists, tables, images, footnotes), XLSX (sheets, dates, bold, formulas, chunked rows) and CSV, PPTX (titles, bullets, pictures, tables, speaker notes), TXT with legacy-encoding detection (windows‑1256 Arabic, windows‑1252), Markdown, HTML, FB2, ODT, CBZ comics and single images.

**Arabic**
- Interface in English or Arabic (right-to-left layout). The Arabic strings are written in sound, idiomatic Arabic rather than word-for-word translation.
- Fonts: **Lora** for Latin text and **Uthman TN1** for Arabic text; **Inter** and **Sultan** for the interface. Fonts fall through per glyph, so mixed-language books render each script in its own face, and each paragraph gets its own direction automatically.
- Arabic shaping is protected: letter-spacing is never applied to RTL text (it breaks joining and the lam-alef ligature), and `rlig`/`liga`/`calt`/`mark` features are forced on, so لا, الله and the marks render as the font designer intended.

## Formats

| Format | Notes |
| --- | --- |
| EPUB 2/3 | Own engine, nav/NCX TOC, cover, images, SVG, internal links, publisher CSS (optional) |
| PDF | pdf.js; slider, go-to, search, outline, text selection, dark pages |
| DOCX | Headings, lists, runs, tables, images, footnotes, RTL paragraphs |
| XLSX / CSV / TSV | Multiple sheets, shared strings, dates, bold, formula fallback |
| PPTX | Slide order, titles, bullets, pictures, tables, notes |
| TXT / MD / HTML | Encoding detection, Markdown via marked, sanitised HTML |
| FB2 / ODT | Sections, images, notes |
| CBZ / images | Page stack with gallery |

Not yet: MOBI/AZW3, CBR (RAR), legacy `.doc`/`.xls`/`.ppt` binaries, RTF.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173 with rebuild on change
npm run build    # production build in dist/ (includes the offline service worker)
npm run typecheck
```

Serve `dist/` from any static host over HTTPS (or localhost) and the app installs as a PWA. On Android, "Add to Home screen" gives you a standalone app with file handling for the supported types.

### Android / iOS wrapper

The app is plain static files, so it wraps cleanly with Capacitor if you want a store build:

```bash
npm i -D @capacitor/core @capacitor/cli @capacitor/android
npx cap init KurokawaReader com.kurokawa.reader --web-dir dist
npx cap add android
npm run build && npx cap sync && npx cap open android
```

## Project layout

```
public/            index.html, manifest, icons
scripts/build.mjs  esbuild bundle + static copy + generated service worker
src/
  formats/         epub.ts (own engine), pdf.ts, docx.ts, sheet.ts, pptx.ts, text.ts, misc.ts (fb2/odt/cbz/image)
  views/           library.ts, reader.ts (flow + PDF), gallery.ts, settings.ts
  ui/              selection toolbar, define/translate, options panel, side panel, DOM helpers
  i18n/            en.ts, ar.ts
  styles/          fonts.css, base.css, reader.css
tests/smoke.cjs    headless end-to-end run over generated fixtures (needs playwright)
scripts/make-fixtures.py  builds sample EPUB/PDF/DOCX/XLSX/PPTX/TXT/MD/CSV files
```

## Keyboard

`J`/`K` or arrows scroll · `Space` page down · `[` `]` previous / next book · `/` search · `B` bookmark · `G` images · `V` visual options · `C` contents · `A` auto-scroll · `F` full screen · `Esc` close. PDF: `←`/`→` pages, `+`/`−` zoom, `G` go to page.

## Licenses

Code: MIT. Fonts: Lora, Inter and Noto Naskh Arabic under the SIL Open Font License (see `LICENSES/`); Uthman TN1 (KFGQPC) and Sultan Medium are redistributed as supplied by the user — see `LICENSES/Sultan-NOTE.txt`. pdf.js is Apache‑2.0; JSZip, DOMPurify and marked are MIT/Apache.

---

## بالعربية

**قارئ كوروكاوا** قارئٌ يعمل دون شبكةٍ لكلِّ ما يُقرأ: كتب EPUB وملفات PDF ومستندات Word وجداول Excel وعروض PowerPoint والنصوص وغيرها، تُحفظ في مكتبةٍ على جهازك ولا تغادره.

- **التصميم** على نهج Material 3 Expressive: أسطحٌ درجيّة، وعنوانٌ كبير في المكتبة، وزرٌّ عائم للإضافة، وشريطُ أدواتٍ عائم في القارئ، ومنزلقاتٌ عريضة، وحركةٌ مرنة؛ وتتبع الواجهةُ لونَ الصفحة فتضيء مع المظاهر الفاتحة.
- **كتابان للبدء**: مقامات الحريري كاملةً (نصّ المكتبة الشاملة مع أرقام صفحات المطبوع) وأليس في بلاد العجائب بالإنجليزية.
- **الخلفيات وراحة العين**: ملامس (ورق، كتّان، رَقّ، نقاط)، وصورة خلفية من عندك مع الظهور والضبابية، ومرشِّح الدفء الليلي، وتعتيم الصفحة، وهيئات جاهزة (ليل، ضوء شمعة، مخطوط، نهار، حبر إلكتروني)، ومظهرٌ مخصَّص بلونَي صفحةٍ ونصٍّ من اختيارك.
- **القراءة معًا**: حدِّد كتبًا عدّة في المكتبة وافتحها في جلسةٍ واحدة؛ تمرّ من آخر الكتاب الأوّل إلى أوّل الثاني في تمريرٍ متّصل، ولكلِّ كتابٍ صورُه وفهرسُه وموضعُ قراءته.
- **المظهر الداكن** أصلٌ لكتب EPUB، ومعه الأسود والبُنّيّ والورقيّ والفاتح، و**خيارات العرض** للخطّ والحجم وتباعد الأسطر وعرض النص والهوامش والمحاذاة.
- **أدوات التحديد**: نسخ، بحث، المعنى، ترجمة، تمييز، نطق.
- **PDF**: شريط تمرير للصفحات، الانتقال إلى صفحة، البحث في الصفحات، الفهرس، تكبير وتصغير، عرض الصفحات داكنةً.
- **الخطوط**: Lora للنص اللاتيني، وعثمان طه للنص العربي، وInter وسلطان للواجهة؛ وتُضبط جهة كلِّ فقرةٍ تلقائيًّا.
- الواجهة العربية مكتوبةٌ بعربيةٍ فصيحةٍ سليمة، لا بالترجمة الحرفية.
