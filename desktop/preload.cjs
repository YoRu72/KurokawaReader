const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kurokawaDesktop', {
  onOpenFile(cb) { ipcRenderer.on('kr:open-file', (_e, payload) => cb(payload)); ipcRenderer.invoke('kr:ready'); },
  platform: process.platform,
  installUpdate(url) { return ipcRenderer.invoke('kr:install-update', url); },
  onUpdateProgress(cb) { ipcRenderer.on('kr:update-progress', (_e, p) => cb(p)); },
  isPortable() { return ipcRenderer.invoke('kr:is-portable'); },
});
