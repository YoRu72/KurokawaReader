7-Zip for the Tauri shell's archives (stage P7), bundled as resources/7zip/ (tauri.conf.json "bundle.resources")
and looked up at run time as 7zip/<win|mac|linux>/<arch>/7za[.exe] — the layout of the npm package 7zip-bin, which
the Electron build ships (desktop/package.json's dependencies; desktop/archive.cjs runs it). CI installs that package
alone (the version desktop/package.json names, without install scripts) and copies this system's 7za and 7zip-bin's
licence files here; the binaries are not committed. This file keeps the folder (and so the build) there when none
was copied: the archives that need 7-Zip (7z, rar, encrypted zips, split volumes, tar.gz/xz/bz2) then answer
«7z missing», and the ZIP and tar ones, which the app reads itself, still work.

7za is 7-Zip's standalone console program (https://www.7-zip.org/), GNU LGPL; 7zip-bin is MIT.
