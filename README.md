# قارئ كروكاوا · KurokawaReader

**A reader for everything readable.** EPUB, PDF, Word, Excel, PowerPoint, text, Markdown, HTML, FictionBook, OpenDocument, comics and images — one offline library, with Arabic typography treated as a first-class citizen.

**Downloads** — Android APK, Windows EXE, iOS IPA (AltStore / SideStore / Sideloadly / TrollStore): [Releases](../../releases) · [install notes](docs/INSTALL.md).

<p align="center">
  <img src="docs/screenshots/library-m3.png" width="48%" alt="Library" />
  <img src="docs/screenshots/manuscript-preset.png" width="48%" alt="Manuscript preset" />
</p>

## What it does

- **Library** — import files, drag them in, open them from other apps, or **scan the whole device** / a folder with type filters; folders, format and status filters, search, natural sort, a *continue reading* card.
- **Reading** — chapter-by-chapter or continuous; several books in one flow; contents, bookmarks, highlights with notes, search that ignores Arabic diacritics, read-aloud, auto-scroll, tap/volume-key/edge-swipe gestures, immersive mode, keep-screen-on.
- **Look** — 19 themes plus custom colours, textures, your own background picture, warmth and dimming; Lora / Uthman TN1 / your own fonts; size, spacing, width, alignment, hyphenation.
- **Selection tools** — copy, search, define, translate (built-in or any translator app), note, share, read aloud, and **text snapshots** that copy the page's look and save to *Pictures/Screenshots*, share or copy.
- **PDF** — instant open, Android's own renderer for non-embedded Arabic fonts, page slider, search, outline, thumbnails grid, save / share / copy page as PNG.
- **Interface** — Material 3 Expressive, light / dark / follow-the-page, accent colours, English and eloquent Arabic (RTL); the app name follows the system language.
- **Updates** — checks GitHub Releases and installs in-app on Android and Windows.

## Starter books

**مقامات الحريري** — the fifty *maqāmāt* of al-Ḥarīrī (Shamela edition, verses in paired hemistichs) and **Alice's Adventures in Wonderland** (Standard Ebooks, with Tenniel's illustrations).

## Run from source

```bash
npm install && npm run build          # dist/ with the offline service worker
npm run android:prepare               # then ./gradlew assembleRelease in android/
npm run ios:prepare                   # then open ios/App in Xcode
cd desktop && npm install && npm run dist:win
```

Every push to `main` builds all platforms and publishes release `v<package.json version>`.
