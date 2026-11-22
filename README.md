# Kurokawa apps

Two calm, offline-first apps that share one look (Material 3 Expressive), one AniList link and one [add-on repository](repo/). Sources and add-ons are only what you add yourself.

| App | What it does | Get it |
|---|---|---|
| **[Kurokawa Reader](apps/reader/)** | Reads EPUB, PDF, Word, Excel, PowerPoint, text, comics and more, offline, in one library with folders, tags and pins. Reading options and themes, PDF tools, a converter, read-aloud, sync and backup. Android · iOS · Windows · Linux · macOS · web. | [Download page](https://yoru72.github.io/KurokawaReader/releases/) · [Releases `v*`](../../releases) · [Web app](https://yoru72.github.io/KurokawaReader/) |
| **[Kurokawa Tools](apps/tools/)** | Downloads over HTTP, magnets and torrents; a file browser and file picker; archives; a video player that saves frames and clips, with subtitles kept or burnt in; a battery monitor for wireless devices; a system monitor; themes and animated backgrounds. | Releases `tools-v*` (pre-releases) |

```bash
cd apps/reader && npm install && npm run build     # the reader → apps/reader/dist
cd apps/tools  && npm install && npm run build     # the tools  → apps/tools/dist
```

Each app has its own release workflow (`.github/workflows/release*.yml`), its own version (`apps/<app>/package.json`) and its own notes (`apps/<app>/docs/notes/`).

## Licence

Kurokawa Reader and the shared code are under the MIT License (`LICENSE`). Kurokawa Tools (`apps/tools`) is under GPL-3.0-or-later (`apps/tools/LICENSE`, credits in `apps/tools/NOTICE.md`).
