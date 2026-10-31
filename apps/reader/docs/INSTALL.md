## Installing

### Android
1. Download the APK that matches your phone — `arm64-v8a` fits almost every phone made since 2016; `armeabi-v7a` is for older 32‑bit devices; `universal` works everywhere but is larger.
2. Open the file. If Android asks, allow installing from this source (Settings → Apps → Special access → Install unknown apps).
3. Updates install over the previous version and keep your library; the app offers them itself (*Settings → App updates*).

### Updates on Windows and Linux
The installed app updates itself from *Settings → App updates*: it downloads only the parts of the new version that changed (a few MB rather than the whole program) and installs them when you restart. The portable EXE and the macOS app download the full file instead.

### macOS
Open the `.dmg` and drag KurokawaReader to Applications. The build is not notarized, so the first launch needs **right-click → Open** (or *System Settings → Privacy & Security → Open Anyway*).

### Linux
`chmod +x KurokawaReader-<version>-linux-x64.AppImage` and run it; file associations are registered on first launch if you accept the prompt.

### Windows
Run `KurokawaReader-<version>-win-x64.exe` to install (it registers the file types so double-clicking an EPUB or PDF opens the reader), or use the portable `.exe` with no installation. SmartScreen may warn because the build is not code‑signed — choose *More info → Run anyway*.

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
