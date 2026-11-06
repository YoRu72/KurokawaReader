// The bridge the page sees as window.kurokawaTools (see src/engine/desktop.ts for its shape).
const { contextBridge, ipcRenderer } = require('electron');
const state = { available: false, reason: '', os: process.platform, arch: process.arch };
const ready = ipcRenderer.invoke('kt:state').then((s) => Object.assign(state, s)).catch(() => state);
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('kurokawaTools', {
  platform: 'desktop',
  get available() { return state.available; },
  get reason() { return state.reason; },
  get os() { return state.os; },
  ready: () => ready,
  add: (o) => call('kt:add', o), list: () => call('kt:list'), pause: (id) => call('kt:pause', id), resume: (id) => call('kt:resume', id), remove: (id, del) => call('kt:remove', id, del),
  setFiles: (id, p) => call('kt:setFiles', id, p), setUrl: (id, url) => call('kt:setUrl', id, url), move: (id, how) => call('kt:move', id, how), mini: (o) => call('kt:mini', o), siteWindow: (o) => call('kt:siteWindow', o), exists: (ps) => call('kt:exists', ps), setLimits: (l) => call('kt:setLimits', l), configure: (o) => call('kt:configure', o), torrentInfo: (s) => call('kt:torrentInfo', s),
  open: (id, i) => call('kt:open', id, i), rename: (o) => call('kt:rename', o), streamUrl: (o) => call('kt:streamUrl', o), appIcon: (o) => call('kt:appIcon', o), desktopPrefs: (o) => call('kt:desktopPrefs', o), saveText: (o) => call('kt:saveText', o), shareWifi: (o) => call('kt:shareWifi', o), shareWifiStop: () => call('kt:shareWifiStop'), shareWifiStatus: () => call('kt:shareWifiStatus'), audioUrl: () => call('kt:audioUrl'), fontDirs: () => call('kt:fontDirs'), fontIndex: (dirs) => call('kt:fontIndex', dirs), defaultDir: () => call('kt:defaultDir'), pickDir: () => call('kt:pickDir'), openExternal: (u) => call('kt:openExternal', u), registerMagnet: () => call('kt:registerMagnet'),
  http: (o) => call('kt:http', o), captureUrl: (o) => call('kt:captureUrl', o),
  videoInfo: (o) => call('kt:videoInfo', o), videoReady: () => call('kt:videoReady'), isVideoHost: (u) => call('kt:isVideoHost', u), videoVersion: () => call('kt:videoVersion'), videoRollback: () => call('kt:videoRollback'), galleryList: (o) => call('kt:galleryList', o), localApi: (o) => call('kt:localApi', o), galleryReady: () => call('kt:galleryReady'), videoBinary: (o) => call('kt:videoBinary', o), videoUpdate: () => call('kt:videoUpdate'),
  listDir: (p) => call('kt:listDir', p), deletePath: (p) => call('kt:deletePath', p), roots: () => call('kt:roots'),
  ffmpegAvailable: () => call('kt:ffmpegAvailable'), ffmpeg: (o) => call('kt:ffmpeg', o), ffmpegCancel: (id) => call('kt:ffmpegCancel', id), ffprobe: (p) => call('kt:ffprobe', p), writeTemp: (name, text) => call('kt:writeTemp', { name, text }), writeTempBytes: (o) => call('kt:writeTempBytes', o), siblings: (p) => call('kt:siblings', p), fileUrl: (p) => call('kt:fileUrl', p),
  avScan: (o) => call('kt:avScan', o), avAvailable: () => call('kt:avAvailable'),
  packStatus: () => call('kt:packStatus'), packInstall: (o) => call('kt:packInstall', o), packCancel: (n) => call('kt:packCancel', n), packRemove: (n) => call('kt:packRemove', n),
  onPackProgress: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('kt:packProgress', fn); return () => ipcRenderer.removeListener('kt:packProgress', fn); },
  onHotkeyAdd: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('kt:hotkeyAdd', fn); return () => ipcRenderer.removeListener('kt:hotkeyAdd', fn); }, onOpenTask: (cb) => { const fn = (_e, id) => cb(id); ipcRenderer.on('kt:openTask', fn); return () => ipcRenderer.removeListener('kt:openTask', fn); },
  onFfmpegProgress: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('kt:ffmpegProgress', fn); return () => ipcRenderer.removeListener('kt:ffmpegProgress', fn); },
  archiveList: (o) => call('kt:archiveList', o), archiveExtract: (o) => call('kt:archiveExtract', o), archiveCancel: (id) => call('kt:archiveCancel', id), archiveCreate: (o) => call('kt:archiveCreate', o), archiveTest: (o) => call('kt:archiveTest', o), openPath: (p) => call('kt:openPath', p), hashFile: (p) => call('kt:hashFile', p), setDoh: (o) => call('kt:setDoh', o), dohProbe: () => call('kt:dohProbe'), clipboardText: () => call('kt:clipboardText'), proxyUrl: (o) => call('kt:proxyUrl', o), archiveRestore: (o) => call('kt:archiveRestore', o), archiveFree: (o) => call('kt:archiveFree', o), archiveExisting: (o) => call('kt:archiveExisting', o), pickFile: (o) => call('kt:pickFile', o), pathInfo: (p) => call('kt:pathInfo', p),
  onArchiveProgress: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('kt:archiveProgress', fn); return () => ipcRenderer.removeListener('kt:archiveProgress', fn); },
  checkUpdate: (o) => call('kt:checkUpdate', o), installUpdate: (u) => call('kt:installUpdate', u), readFile: (p) => call('kt:readFile', p), writeText: (o) => call('kt:writeText', o), removeFile: (p) => call('kt:removeFile', p),
  onTasks: (cb) => { const fn = (_e, tasks) => cb(tasks); ipcRenderer.on('kt:tasks', fn); void call('kt:list').then(cb).catch(() => {}); return () => ipcRenderer.removeListener('kt:tasks', fn); },
  onBrowser: (cb) => { const fn = (_e, o) => cb(o); ipcRenderer.on('kt:browser', fn); return () => ipcRenderer.removeListener('kt:browser', fn); },
  browse: (o) => call('kt:browse', o),
  screenConfig: (o) => call('kt:screenConfig', o), screenStatus: () => call('kt:screenStatus'), screenAction: (a) => call('kt:screenAction', a), screenJob: () => call('kt:screenJob'),
  screenRegion: (r) => call('kt:screenRegion', r), screenClose: () => call('kt:screenClose'), screenOcrLangs: () => call('kt:screenOcrLangs'), screenCaptionSize: (o) => call('kt:screenCaption', o),
  onScreenCaption: (cb) => { const fn = (_e, o) => cb(o); ipcRenderer.on('kt:screenCaption', fn); return () => ipcRenderer.removeListener('kt:screenCaption', fn); },
  onUpdateProgress: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('kt:update-progress', fn); return () => ipcRenderer.removeListener('kt:update-progress', fn); },
});
ipcRenderer.on('kt:open', (_e, u) => window.dispatchEvent(new CustomEvent('kt:open', { detail: u })));
