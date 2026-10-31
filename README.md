# Kurokawa apps

[العربية](README.ar.md)

Two apps that share one look (Material 3 Expressive), one set of languages (العربية · English · 日本語 · 한국어 · 中文), one AniList link, and one [add-on repository](repo/).

| App | What it is | Get it |
|---|---|---|
| **[KurokawaReader](apps/reader/)** · قارئ كروكاوا | An offline reader for EPUB, PDF, Word, Excel, PowerPoint, text, comics and more — with sources (the Internet Archive, Shamela, web folders, LNReader and Mangayomi extensions), a converter, cloud sync and read-aloud. | [Releases `v*`](../../releases) · [Web app](https://yoru72.github.io/KurokawaReader/) |
| **[Kurokawa Tools](apps/tools/)** · أدوات كروكاوا | Downloads and streaming: HTTP, magnets and torrents (aria2c and a torrent engine of its own), debrid services, torrent search and anime add-ons, subtitles from many sites at once, archives, and a video player. | Releases `tools-v*` (in progress) |

```bash
cd apps/reader && npm install && npm run build     # the reader → apps/reader/dist
cd apps/tools  && npm install && npm run build     # the tools  → apps/tools/dist
```

Each app has its own release workflow (`.github/workflows/release*.yml`), its own version (`apps/<app>/package.json`) and its own notes (`apps/<app>/docs/notes/`).
