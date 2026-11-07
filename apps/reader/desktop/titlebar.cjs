// The window's own title bar, drawn by the app: the system's raw bar is hidden, its buttons (minimise, maximise,
// close) kept — on Windows and Linux drawn over the app's bar in its colours, on a Mac its three lights inset —, so
// the bar is the app's: its icon, its name, the colours of its theme. The page tells the colours when its theme
// changes. The same file is in Kurokawa Tools and KurokawaReader: a change to one goes to both.
const { ipcMain, BrowserWindow } = require('electron');

const HEIGHT = 38;
/** The window's options for a bar of the app's own. */
function options() {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } };
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#121314', symbolColor: '#e6e6e6', height: HEIGHT } };
}
/** The page's side: what the bar looks like where, and its colours set. */
function install() {
  ipcMain.handle('app:titleBar', (e, o) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return null;
    if (o && o.color && process.platform !== 'darwin') { try { w.setTitleBarOverlay({ color: String(o.color), symbolColor: String(o.symbol || '#e6e6e6'), height: HEIGHT }); } catch { /* an old system */ } }
    return { platform: process.platform, height: HEIGHT, maximized: w.isMaximized(), fullscreen: w.isFullScreen() };
  });
}
/** The page told when the window goes full screen (no bar then). */
function watch(win) {
  const tell = () => { try { win.webContents.send('app:titleBarState', { fullscreen: win.isFullScreen(), maximized: win.isMaximized() }); } catch { /* closed */ } };
  for (const ev of ['enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize']) win.on(ev, tell);
}
module.exports = { options, install, watch, HEIGHT };
