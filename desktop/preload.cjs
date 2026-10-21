const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kurokawaDesktop', {
  onOpenFile(cb) { ipcRenderer.on('kr:open-file', (_e, payload) => cb(payload)); ipcRenderer.invoke('kr:ready'); },
  platform: process.platform,
  installUpdate(url) { return ipcRenderer.invoke('kr:install-update', url); },
  onUpdateProgress(cb) { ipcRenderer.on('kr:update-progress', (_e, p) => cb(p)); },
  isPortable() { return ipcRenderer.invoke('kr:is-portable'); },
  scanDevice(exts) { return ipcRenderer.invoke('kr:scan-device', exts); },
  readFile(p) { return ipcRenderer.invoke('kr:read-file', p); },
  copyImage(b64) { return ipcRenderer.invoke('kr:copy-image', b64); },
  onCommand(cb) { ipcRenderer.on('kr:command', (_e, c) => cb(c)); },
});
