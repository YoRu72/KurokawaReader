### Fixes
- **An update that cannot finish says why.** When the computer app's update stops — not enough free space, a file that does not match what the release says, a portable copy — the update sheet now says so in plain words instead of an error code, and the app keeps working as it was.

### Computer: a new, far smaller app
- **Windows: about 5 MB instead of 84 MB.** A new setup program with one screen: *Install*, and *Options* for the folder, a desktop shortcut, opening .torrent files and magnet links with Kurokawa Tools, and opening it when done. It installs for you only, in a few seconds, with no administrator prompt, shows real progress and says plainly what went wrong if something does. Also a portable zip and the classic installer.
- **macOS: about 4 MB instead of 168 MB. Linux: a .deb of about 9 MB**, or the AppImage.
- **The same app inside**: downloads and torrents with the same engine (aria2), streaming, the video tools, archives with the 7-Zip that comes with it, the Files page, the in-app browser, the Wi-Fi share and the local API, the tray, hotkeys and the mini window.
- **Its own title bar** and **your own app icon**, as before.
- **Updates** are downloaded, checked against the release before anything is installed, resumed if the connection breaks, and installed in place.
- A first screen at the first start: the language, the look, your data from the previous version, and opening torrents and magnet links with the app.

### What the update does to your data and downloads
- **Update from inside the app.** The update first gets your data ready — settings, your anime, TV and video lists, watch progress and subtitle choices, add-ons, history, sign-ins, your icon —, pauses your downloads cleanly and notes which were running, writes it all to a folder beside your data, checks every file, and only then installs the new app. If anything fails, nothing is installed, your downloads go on, and the app tells you why.
- **Your downloads go on where they stopped.** The new app takes them up at its first start, from the same folders: the ones that were running start again by themselves, the ones you had paused stay paused. Nothing is downloaded twice, and no file is moved.
- On its first start the new app offers to bring the rest over (*Bring it now*). It is copied, never moved: **nothing is deleted**, and you can free the space of the copy afterwards when you choose.
- If the free space on the disk cannot be read, the update tells you how much it needs and asks before going on.
- **You can say *Not now*.** The move is offered again a day later (a week if you check for updates weekly), or at once for a newer version.
- Installed the new app by hand while the previous one is still there? The previous one is kept beside it — with your downloads, and still opening your torrents and magnet links — until it has carried your data over: open it once and let it update. The new app's first screen says so.
- **Portable copy and macOS:** your data is made ready and your downloads are paused; open the new copy (download the new portable zip, or drag the new app to Applications) and it brings everything over.

### What is different
- **Sign-ins inside the app's browser and sign-in windows** are asked again once. AniList and your debrid service stay signed in.
- **yt-dlp, gallery-dl and the ffmpeg pack** are downloaded again the first time they are needed (once).
- **The window** opens at its usual size the first time.
- **Seeking far ahead in a torrent you are watching** waits until the download gets there; before, it jumped there at once.
- **Files are no longer renamed after download** when their name says nothing about them.
- **DNS over HTTPS** covers the app's own requests; pages shown inside it use the system's DNS.
- **YouTube in the video tools**: if neither deno nor node is installed, some formats may be missing.
- **The screen translator** — _(to be filled in: it must be ported before this release)_.
- **The previous build stays on the release page for two versions** (`…-win-x64.exe`, `…-mac-universal.dmg`, `…-linux-x86_64.AppImage`) for anyone who needs it. If the new macOS build is missing from a release, the previous build remains the Mac download and keeps updating as before.
