# File managers studied: Solid Explorer 3.6.3 and ZArchiver 1.0.10

Inventories made from the apps' own resources (strings, menus, class and library names), read only. They are the
source of the Files add-on's task list (tasks #260–#279 in the session) and of what it adopts, batch by batch.

## Solid Explorer — the shape of a file manager
- Browsing: breadcrumbs with a dropdown, back/up history, a stack of open locations per panel, two panels in
  landscape with "send to the other panel", a drawer of storages (internal, SD, USB, root) + collections (Photos,
  Music, Videos, Documents, Archives, Applications, Downloads, Camera roll, Screenshots) + bookmarks; remember the
  last folder; show / hide root; SAF grants for SD; Android/data workaround; Shizuku; drag and drop; fast scroller;
  pull to refresh; double back to exit; FAB menu.
- Views: List / Grid / Gallery / Compact; sort by name, date, size, type (+ folders first); section headers by
  name/date/size/extension; "only this folder" view settings; pinch to resize; hidden files; folder sizes;
  thumbnails (images, video, music art, APK icons, PDF), animated thumbnails; app icons on app-data folders; free
  space on storages; drawer storages sorted by name / added / usage / my order.
- Selection and operations: select all / inverse; bottom contextual bar; copy, cut, paste, copy to…, move to…;
  clipboard with several sources; rename; batch rename (pattern variables: name, ext, size, date, time, numbering,
  find/replace); delete (permanent or to a recycle bin with restore / empty / timer); undo; new folder / file;
  symlinks; conflicts: keep both / replace / skip / merge; an operation queue with speed, time left, pause / resume /
  cancel per job, retry; resumable transfers; verify after transfer; sounds/vibration; hide folders; .nomedia.
- Open: open, open with, **open as** (Image / Music / Video / Document / Archive / Any), default associations;
  open the containing folder; share, send to, NFC, public link; **Save to…** as a share target; upload to cloud;
  home-screen shortcut; set as wallpaper; built-in image viewer, music player, video player (subtitles, speed,
  cast), text/code editor (find/replace, font, encoding); streaming server; install APKs; copy name / path.
- Archives: browse inside as folders; extract / extract to…; create (name, format zip/7z/tar+gz/bz2, level,
  password, remove sources); password-protected archives; compressed size in properties.
- Cloud / network: Drive, Dropbox, OneDrive, Box, pCloud, S3, MediaFire, SugarSync, WebDAV/ownCloud, FTP/FTPS,
  SFTP (keys), SMB1/2 with subnet scan; FTP server + WebFS (browser sharing) with Quick Settings tiles; Chromecast.
- Search: in the folder or the whole location, deep (recursive), suggestions/history, regex; **filters**: type
  (Any/Image/Music/Video/Document/Archive/APK), size (Empty, Tiny 0–10K, Small 10K–1M, Medium 1–10M, Big
  10–100M, Large 100M–1G, Huge >1G), date (Today, Yesterday, This/Previous week, This/Previous month, This/Previous
  year), "current folder only".
- Properties: size, location, type, modified, attributes; folder content by type + largest items; checksums
  (MD5/SHA1, compare); root attrs (chmod/chown); EXIF (camera, aperture, exposure, focal, GPS → map); media tags;
  APK name/version.
- Settings: themes (Material, White, Onyx, Light, Dark, Black), Material You, primary/accent colours, icon sets,
  colourful nav bar, quick config, clear cache, settings backup/restore (local + encrypted cloud), master password
  + biometrics for connections, AES-256 file/folder encryption, hidden folders.
- Storage analyzer: largest / duplicate / older files, screenshots, temp files, largest / least-used apps, treemap.
- Pickers: GET_CONTENT/PICK picker, directory picker, Save-to target, shortcut picker. (No DocumentsProvider.)

## ZArchiver — the archive engine
- Reads: 7z (7zAES), zip family (zipx, jar, apk, epub…), rar 1.4/4/5, egg (+ multi-volume), alz, tar (ustar, pax),
  cpio, deb, rpm, gz, bz2, xz, lzma, lz, Z, zst, lz4, iso/udf/img/dmg/vhd/wim/squashfs, cab, chm, arj, lzh, msi,
  sfx; magic-byte sniffing; multi-volume .001 / .z01 / .r00.
- Writes: 7z, zip, tar, gz, bz2, xz, zstd, lz4 and tar.* combinations; methods LZMA/LZMA2/Fast-LZMA2/PPMd/BZip2/
  ZSTD; levels Fastest…Ultra (separate defaults for 7z and zip; RAM-capped with override); solid mode and block
  size; dictionary; multithreading (core count); split volumes (preset or custom sizes); encryption ZipCrypto /
  AES-128/192/256 / AES-256 with names (7z header encryption); default encryption; saved passwords (labelled,
  encrypted at rest); password prompt mid-task with a notification in the background.
- Operations: extract here / to ./name / to…; compress… and "compress to name.fmt"; one archive per item; delete
  sources after; fixed output folder; edit archives in place (add, delete, rename, new file; edit a file and write
  it back); test; comment; preserve mtimes; charset for old zips; properties (type, count, size, ratio, solid);
  clear error classes (CRC, data, truncated, unknown format, method, password, disk, RAM).
- Android: APK info and install (split bundles too), app backup/restore, Android/data via SAF / root / Shizuku.
- File manager: cut/copy/paste/delete/rename/new file/folder/share; interactive paste; select by icon, multi-select,
  all/none/invert; drag and drop; two panes; search; sort name/type/date/size asc/desc; views compact/detailed/grid;
  hidden files; ".." entry; size/date columns; favourites with icons; roots (device, SD, USB, Download, Documents,
  Music, Archives, home); properties with MD5, permissions, symlink target, free space, EXIF/media/book metadata;
  .nomedia; chmod; **open as** with just once / always remembered per extension; text editor (syntax, line numbers,
  wrap, font); image viewer; thumbnails (images, video, album art, PDF, APK icons, **images inside archives**).
- **Why it loads fast**: a native engine (p7zip/unrar/unegg over JNI); listing starts asynchronously and entries are
  pushed to the UI one by one as they are read; an archive is opened once and kept open while browsing inside it;
  **direct open**: small files inside an archive are streamed through a pipe (a content provider) instead of being
  extracted first; .tar.gz handled in one pass by piping gzip into tar; a background service with a thread pool;
  multi-core codecs; extracting only the selection; thumbnails decoded lazily from streams.
- Operations model: typed tasks in a foreground service (one notification each) with percentage, file name and
  speed; cancel from dialog or notification (optional confirm); no pause/resume; a lock per archive/path; conflicts
  "overwrite?" with replace / skip / cancel / apply to all (or never ask); password callback; results: done, done
  with errors, cancelled; media scanner told of extracted files; guards against moving a folder into itself.
