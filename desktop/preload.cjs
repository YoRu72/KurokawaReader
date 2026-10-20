const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kurokawaDesktop', {
  onOpenFile(cb) { ipcRenderer.on('kr:open-file', (_e, payload) => cb(payload)); ipcRenderer.invoke('kr:ready'); },
  platform: process.platform,
});
