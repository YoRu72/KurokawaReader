aria2c for the Tauri shell, bundled as resources/aria2/ (tauri.conf.json "bundle.resources") and looked up at run
time as aria2/<win|linux|mac>-<arch>/aria2c[.exe] (then aria2/<plat>/, then the PATH) — the layout of
../desktop/aria2.cjs. CI fills it with ../desktop/fetch-aria2.mjs and copies ../desktop/aria2/* here; the binaries
are not committed. This file keeps the folder (and so the build) there when no aria2c was fetched.
