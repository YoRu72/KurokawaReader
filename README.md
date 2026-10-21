# قارئ كروكاوا · KurokawaReader

**A reader for everything readable.** EPUB, PDF, Word, Excel, PowerPoint, text, Markdown, HTML, FictionBook, OpenDocument, comics and images.

**Downloads** — Android APK, Windows EXE, macOS DMG, Linux AppImage, iOS IPA (AltStore / SideStore / Sideloadly / TrollStore): [Releases](../../releases) · [install notes](docs/INSTALL.md).

<p align="center">
  <img src="docs/screenshots/library-m3.png" width="48%" alt="Library" />
  <img src="docs/screenshots/manuscript-preset.png" width="48%" alt="Manuscript preset" />
</p>

## What it does

- **Library** — import files, drag them in, open them from other apps, or **scan the whole device** / a folder with type filters (Android, iOS Files, desktop); folders, format and status filters, search, natural sort, a *continue reading* card.
<<<<<<< HEAD
- **Reading** — chapter-by-chapter or continuous; several books in one flow; contents, bookmarks, highlights with notes, search that ignores diacritics, read-aloud (speed and voice), auto-scroll, tap / volume-key / edge-swipe / pinch gestures, keyboard shortcuts, immersive mode, keep-screen-on.
- **Look** — 19 themes plus custom colours, textures, your own background picture, warmth and dimming; your own fonts; size, spacing, width, alignment, hyphenation.
=======
- **Reading** — chapter-by-chapter or continuous; several books in one flow; contents, bookmarks, highlights with notes, search that ignores diacritics, read-aloud (speed, voice, sleep timer), auto-scroll, tap / volume-key / edge-swipe / pinch gestures, keyboard shortcuts, immersive mode, keep-screen-on.
- **Look** — ten one-tap presets, 19 themes plus custom colours, textures, your own background picture, warmth and dimming; Lora / Uthman TN1 / your own fonts; size, spacing, width, alignment, hyphenation.
>>>>>>> bd47e82 (v0.10.0: system selection menu really suppressed (KrWebView now replaces Capacitor's bridge_layout_main WebView, plus a hide loop); copy image goes native-first on Android/iOS and through Electron's clipboard on desktop; new Maqāmāt cover (migrates existing libraries); folder-add card removed (chip suffices); five more reading presets; sleep timer)
- **Selection tools** — copy, search, define, translate (built-in or any translator app), note, share, read aloud, and **text snapshots** that copy the page's look and save to *Pictures/Screenshots*, share or copy.
- **PDF** — instant open, the system renderer on Android for non-embedded fonts, page slider, search, outline, thumbnails grid, save / share / copy page as PNG.
- **Interface** — Material 3 Expressive, light / dark / follow-the-page, accent colours, English and Arabic (RTL); the app name follows the system language.
- **Backup** — settings, folders, bookmarks, highlights and progress as a small JSON file, or a full ZIP with the books; restore merges into the library.
- **Updates** — checks GitHub Releases and installs in-app on Android, Windows, macOS and Linux.

## Starter books

**مقامات الحريري** — the fifty *maqāmāt* of al-Ḥarīrī — and **Alice's Adventures in Wonderland** (Standard Ebooks, with Tenniel's illustrations).

## Run from source

```bash
npm install && npm run build          # dist/ with the offline service worker
npm run android:prepare               # then ./gradlew assembleRelease in android/
npm run ios:prepare                   # then open ios/App in Xcode
cd desktop && npm install && npm run dist:win
```

Every push to `main` builds all platforms and publishes release `v<package.json version>`.
