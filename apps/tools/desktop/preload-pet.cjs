// The bridge of a pet's own window (src/pets/desktop.ts): nothing but the pet's channel. The main window's preload
// (preload.cjs) is never loaded there, so a pet window cannot reach downloads, files, the network or any other channel.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kurokawaTools', {
  platform: 'desktop',
  os: process.platform,
  ready: () => Promise.resolve({}),
  pet: (o) => ipcRenderer.invoke('kt:pet', o),
});
