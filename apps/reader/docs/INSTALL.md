## Installing

### Android
1. Download the APK that matches your phone — `arm64-v8a` fits almost every phone made since 2016; `armeabi-v7a` is for older 32‑bit devices; `universal` works everywhere but is larger.
2. Open the file. If Android asks, allow installing from this source (Settings → Apps → Special access → Install unknown apps).
3. Updates install over the previous version and keep your library; the app offers them itself (*Settings → App updates*).

### Windows
Run `KurokawaReader-<version>-windows-x64.exe` (about 13 MB): one screen — **Install**, with *Options* for the folder, a desktop shortcut, opening EPUB, PDF and other books with KurokawaReader, and opening it when done. It installs for you only, in a few seconds, with no administrator prompt. `…-windows-x64-setup.exe` is the classic installer (silent installs: `/S`); `…-windows-x64-portable.zip` runs from any folder and never updates itself. SmartScreen may warn because the build is not code‑signed — choose *More info → Run anyway*.
**Coming from the previous KurokawaReader?** Update it from inside the app (*Settings → App updates*): it prepares your library, checks it, then installs the new app, which brings everything over on its first start. Nothing is deleted from your library. If you install the new app by hand while the previous one is still there, the previous one is kept beside it until you open it once and let it update.

### macOS
Open `KurokawaReader-<version>-macos-universal.DMG` and drag KurokawaReader to Applications. The build is not notarized, so the first launch needs **right-click → Open** (or *System Settings → Privacy & Security → Open Anyway*). Update the previous KurokawaReader from inside it first, so your library is prepared before it is replaced.

### Linux
`chmod +x KurokawaReader-<version>-linux-x64.appimage` and run it, or install `KurokawaReader-<version>-linux-x64.deb`.

### Updates
The app updates itself from *Settings → App updates*: it downloads the new version, checks it against the release's SHA-256, and installs it in place (Windows, AppImage) or opens it for you (macOS disk image, .deb). The portable zip is updated by hand.

### The previous build (old engine)
For two versions the release also carries the previous build (`…-win-x64.exe`, `…-mac-universal.dmg`, `…-linux-x86_64.AppImage`), for anyone who needs to go back. Its library stays in its own data folder.

### iOS
Apple only lets an app run if it is signed, so there are three routes; pick the one that fits your device. The app itself helps with all of them (*Settings → App updates*).

| Route | Signing | Updates | Needs |
|---|---|---|---|
| **Web app** (recommended for most) | none | automatic | Safari |
| **TrollStore** | permanent | one tap from the app | iOS 14.0–16.6.1 or 17.0 with TrollStore installed |
| **AltStore / SideStore** | 7 days (free Apple ID) · 1 year (developer account) | from their catalogue | AltServer on a computer (AltStore) or SideStore set up once |

**Web app — install once, no signing, updates itself.** Open **https://yoru72.github.io/KurokawaReader/** in Safari, tap *Share → Add to Home Screen*. It runs offline after that, keeps your library on the device, and picks up every release on its own. (Camera scanning and opening files from other apps work through the share sheet and file picker; a few native-only features — opening a file straight from WhatsApp, volume-key paging — stay with the native app.)

**TrollStore — permanent, no computer.** If your iOS version supports TrollStore, open the IPA link in it once (or tap *Install with TrollStore* inside the app when an update is offered). TrollStore signs it for good; nothing expires.

**AltStore / SideStore — your own Apple ID.**
1. Set up AltStore (altstore.io, needs AltServer on a PC/Mac) or SideStore (sidestore.io, works without a computer after the first setup).
2. Add the KurokawaReader source: in AltStore/SideStore go to *Sources → +* and paste
   `https://yoru72.github.io/KurokawaReader/altstore.json`
   — or tap *Add source* inside the app. KurokawaReader then appears in their catalogue and every new release shows up there as an update.
3. Install it from the source and sign in with your Apple ID when asked.
4. With a **free Apple ID** Apple limits every sideloaded app to 7 days; AltStore and SideStore re-sign in the background before it runs out (AltStore while AltServer is reachable, SideStore on its own). With a **paid developer account** ($99/year) the signature lasts a year. This limit is Apple's and no app can lift it — which is why the web app and TrollStore routes exist.

Other ways: **Sideloadly** (drag the IPA in, same 7-day rule) or any signing service you trust.

### Web
The hosted app at **https://yoru72.github.io/KurokawaReader/** installs from any browser (Chrome, Edge, Safari: *Install app* / *Add to Home Screen*) and updates itself. To self-host, unzip `KurokawaReader-web.zip` onto any static host served over HTTPS — it works from a sub-folder too.
