## Installing

### Android
1. Download the APK that matches your phone — `arm64-v8a` fits almost every phone made since 2016; `armeabi-v7a` is for older 32‑bit devices; `universal` works everywhere but is larger.
2. Open the file. If Android asks, allow installing from this source (Settings → Apps → Special access → Install unknown apps).
3. After installing, EPUB/PDF/DOCX/… files offer **قارئ كروكاوا** in the "Open with" sheet (WhatsApp, Files, browsers).
4. Every release is signed with the same key (`native/android/kurokawa.keystore`, or the `ANDROID_KEYSTORE_*` secrets when set), so a newer APK installs over the old one and keeps your library. Builds before 0.6.1 used throw-away keys: uninstall those once first.
5. *Scan the whole device* asks for **All files access** on Android 11+; you can decline and pick a folder instead.

### Windows
Run `KurokawaReader-<version>-win-x64.exe` to install (it registers the file types so double-clicking an EPUB or PDF opens the reader), or use the portable `.exe` with no installation. SmartScreen may warn because the build is not code‑signed — choose *More info → Run anyway*.

### iOS (IPA via AltStore or SideStore)
The IPA is unsigned; you sign it with your own Apple ID on your own device.

1. Install **AltServer** on your PC or Mac from altstore.io and use it to put **AltStore** on your iPhone/iPad (the AltStore site walks you through this once).
2. Download `KurokawaReader-<version>-ios-unsigned.ipa` on the device (or AirDrop / send it to yourself).
3. Connect your iOS device to the computer running AltServer (USB or the same Wi‑Fi after the first pairing).
4. Open **AltStore** on the device → **My Apps** tab → tap **+** in the top‑left corner.
5. Pick the downloaded KurokawaReader IPA and sign in with your Apple ID when asked. AltStore signs and installs it.
6. With a free Apple ID the app must be refreshed every 7 days — AltStore does this in the background while AltServer is reachable. **SideStore** works the same way without needing the computer after setup.

#### Other iOS methods
- **Sideloadly** — install Sideloadly on your PC or Mac, connect the device by USB or Wi‑Fi, drag the KurokawaReader IPA into the IPA slot, enter your Apple ID and click **Start**. Same 7‑day limit with a free Apple ID.
- **TrollStore** (if your iOS version supports it) — open the downloaded IPA in TrollStore and tap **Install**. Permanent signing, no computer needed afterwards.
- From inside the app, *Settings → App updates* can hand a new release straight to AltStore or SideStore.

### Web
Unzip `KurokawaReader-web.zip` onto any static host served over HTTPS and open it; the browser offers to install it as an app, and it works offline afterwards.
