// The app's own icon, of the user's choosing (a picture cropped in the app): kept in the app's data folder, set on
// every window and the taskbar now and at each start, the Dock's on a Mac, and on Windows the desktop, Start-menu
// and pinned taskbar shortcuts made to show it (an .ico written beside it — Windows wants one for a shortcut).
// The same file is in Kurokawa Tools and KurokawaReader: a change to one goes to both.
const { app, BrowserWindow, nativeImage, shell } = require('electron');
const fs = require('node:fs'); const path = require('node:path');

const file = () => path.join(app.getPath('userData'), 'custom-icon.png');
const icoFile = () => path.join(app.getPath('userData'), 'custom-icon.ico');
let fallback = null;

/** An .ico holding one 256×256 PNG (Windows Vista and later read PNG inside an .ico). */
function ico(png256) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(0, 6); head.writeUInt8(0, 7); head.writeUInt8(0, 8); head.writeUInt8(0, 9);
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png256.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png256]);
}
/** The shortcuts the installer made (desktop, Start menu, pinned on the taskbar), pointed at the icon given (or the program's own). */
function shortcuts(iconPath) {
  if (process.platform !== 'win32') return;
  const name = `${app.getName()}.lnk`; const ad = app.getPath('appData');
  const places = [path.join(app.getPath('desktop'), name), path.join(ad, 'Microsoft', 'Windows', 'Start Menu', 'Programs', name), path.join(ad, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', name)];
  for (const p of places) { try { if (!fs.existsSync(p)) continue; shell.writeShortcutLink(p, 'update', { icon: iconPath || process.execPath, iconIndex: 0 }); } catch { /* not ours to change */ } }
}
function image() { try { if (fs.existsSync(file())) { const im = nativeImage.createFromPath(file()); if (!im.isEmpty()) return im; } } catch { /* the default */ } return null; }

/** Called with the app's default icon path once; sets the chosen icon (if any) on the window given and the Dock. */
function apply(win, defaultIconPath) {
  if (defaultIconPath) fallback = defaultIconPath;
  const im = image() || (fallback ? nativeImage.createFromPath(fallback) : null); if (!im) return;
  try { if (win && !win.isDestroyed()) win.setIcon(im); } catch { /* a closed window */ }
  try { if (process.platform === 'darwin' && app.dock) app.dock.setIcon(im); } catch { /* no Dock */ }
}
/** The icon chosen (a PNG data URL), or null to go back to the app's own. */
function set(dataUrl) {
  if (!dataUrl) { for (const f of [file(), icoFile()]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } } shortcuts(null); }
  else {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl)); if (!m) throw new Error('not a PNG');
    const buf = Buffer.from(m[1], 'base64'); if (buf.length > 4 << 20) throw new Error('too large');
    fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), buf);
    if (process.platform === 'win32') { const png256 = nativeImage.createFromBuffer(buf).resize({ width: 256, height: 256, quality: 'best' }).toPNG(); fs.writeFileSync(icoFile(), ico(png256)); shortcuts(icoFile()); }
  }
  for (const w of BrowserWindow.getAllWindows()) apply(w);
  if (!dataUrl) { try { if (process.platform === 'darwin' && app.dock && fallback) app.dock.setIcon(nativeImage.createFromPath(fallback)); } catch { /* no Dock */ } }
  return true;
}
/** The chosen icon as a data URL (for the app's settings to show), or null. */
function current() { try { return fs.existsSync(file()) ? `data:image/png;base64,${fs.readFileSync(file()).toString('base64')}` : null; } catch { return null; } }
module.exports = { apply, set, current, ico };
