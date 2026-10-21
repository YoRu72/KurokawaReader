# قارئ كروكاوا · KurokawaReader

**A reader for everything readable** — EPUB, PDF, Word, Excel, PowerPoint, text, Markdown, HTML, FictionBook, OpenDocument, comics and images, in one offline library.

**Downloads:** Android · Windows · macOS · Linux · iOS (AltStore / SideStore / Sideloadly / TrollStore) → [Releases](../../releases) · [install notes](docs/INSTALL.md)

<p align="center">
  <img src="docs/screenshots/library-m3.png" width="48%" alt="Library" />
  <img src="docs/screenshots/manuscript-preset.png" width="48%" alt="Reading" />
</p>

- **Library** — import, drag in, open from other apps, or scan the device; folders, filters, search, continue-reading card.
- **Reading** — chapters or continuous, several books in one flow, bookmarks, highlights with numbered notes, PDF pinned notes, a notes page across all books, search, furigana, read-aloud, gestures, rebindable shortcuts, immersive mode.
- **Look** — presets, 27 themes, custom colours with a wheel picker, textures and background pictures, your own fonts.
- **Tools** — snapshots of selected text, translation (built-in, device apps, or AI chapter translation with your own key), AI voices, export pages as PNG.
- **Sync & backup** — progress and notes synced through your Dropbox / WebDAV / a Drive folder; portable backups (JSON or ZIP with books) that restore on any platform.
- **Updates** — checked at launch; downloaded and installed in-app on every platform.

Starter books: **مقامات الحريري** and **Alice's Adventures in Wonderland**.

```bash
npm install && npm run build   # web → dist/
npm run android:prepare        # Android project · npm run ios:prepare for Xcode
cd desktop && npm install && npm run dist:win   # desktop builds (win / mac / linux)
```
Every push to `main` builds all platforms and publishes a release.
