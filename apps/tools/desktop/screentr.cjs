// The screen translator on a computer (the «Translate on screen» add-on): keyboard shortcuts that work in any app,
// an icon in the tray so it keeps working with the window closed, and starting with the computer when chosen.
// A shortcut freezes the screen under the mouse; a region is drawn on it (or all of it is taken), its text read
// by the system's own OCR — Windows OCR, macOS Vision, Tesseract on Linux — or by an AI model that sees the
// picture, then translated and drawn over the words. «Auto» watches a region (a game's dialogue, a video's
// subtitles) and shows its translation in a small window beneath it, every few seconds; the clipboard's text is
// translated in a small window by the mouse. The translating is the page's (src/screen/translate.ts).
'use strict';
const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, desktopCapturer, ipcMain, clipboard, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

const DEFAULT_KEYS = { region: 'Alt+Shift+T', full: 'Alt+Shift+F', repeat: 'Alt+Shift+R', auto: 'Alt+Shift+A', clipboard: 'Alt+Shift+C' };
let cfg = {}; let tray = null; let ctx = null; let overlay = null; let caption = null; let popup = null; let job = null; let lastRegion = null; let autoTimer = null; let autoBusy = false; let lastAutoText = '';
const registered = {};

const cfgPath = () => path.join(app.getPath('userData'), 'screen.json');
function load() { try { cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { cfg = {}; } try { const r = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'screen-region.json'), 'utf8')); if (r && r.width > 4) lastRegion = r; } catch { /* none */ } }
const pc = () => cfg.pc || {};
const label = (k, d) => (cfg.labels && cfg.labels[k]) || d;

/** Set up from main.cjs: what to call for the main window. */
function init(c) {
  ctx = c; load();
  ipcMain.handle('kt:screenConfig', (_e, o) => { cfg = o && o.config ? o.config : {}; try { fs.writeFileSync(cfgPath(), JSON.stringify(cfg)); } catch { /* ignore */ } if (o && o.clearFixed) { lastRegion = null; try { fs.rmSync(path.join(app.getPath('userData'), 'screen-region.json'), { force: true }); } catch { /* none */ } } apply(); return status(); });
  ipcMain.handle('kt:screenStatus', () => status());
  ipcMain.handle('kt:screenAction', (_e, a) => { void act(String(a)); return true; });
  ipcMain.handle('kt:screenJob', () => job && { mode: job.mode, image: job.image, width: job.width, height: job.height, scale: job.scale, text: job.text, cfg });
  ipcMain.handle('kt:screenRegion', async (_e, r) => regionChosen(r));
  ipcMain.handle('kt:screenClose', () => { closeOverlay(); closePopup(); return true; });
  ipcMain.handle('kt:screenOcrLangs', () => ocrLangs());
  ipcMain.handle('kt:screenCaption', (_e, o) => { if (caption && !caption.isDestroyed() && o && o.height) { const b = caption.getBounds(); caption.setBounds({ ...b, height: Math.max(40, Math.min(400, Math.round(o.height))) }); } return true; });
  apply();
  if (process.argv.includes('--hidden') && pc().tray) setTimeout(() => ctx.hideMain(), 50);
}
function enabled() { return !!cfg.pcOn; }
/** Shortcuts, tray and start-with-the-computer as the settings say. */
function apply() {
  for (const k of Object.keys(registered)) { try { globalShortcut.unregister(registered[k]); } catch { /* not ours */ } delete registered[k]; }
  if (enabled()) {
    const keys = { ...DEFAULT_KEYS, ...(pc().keys || {}) };
    for (const [k, acc] of Object.entries(keys)) { if (!acc) continue; try { if (globalShortcut.register(acc, () => void act(k))) registered[k] = acc; } catch { /* a bad or taken shortcut: told on the page */ } }
  }
  if (enabled() && pc().tray) makeTray(); else if (tray) { tray.destroy(); tray = null; }
  try { if (process.platform !== 'linux') app.setLoginItemSettings({ openAtLogin: enabled() && !!pc().startup, args: ['--hidden'] }); } catch { /* not allowed */ }
  if (!enabled()) stopAuto();
}
function status() {
  const keys = { ...DEFAULT_KEYS, ...(pc().keys || {}) }; const keyState = {};
  for (const [k, acc] of Object.entries(keys)) keyState[k] = { acc, ok: !!registered[k] };
  return { platform: process.platform, on: enabled(), keys: keyState, tray: !!tray, auto: !!autoTimer, region: lastRegion, ocr: ocrKind() };
}
function makeTray() {
  if (tray) { tray.setContextMenu(trayMenu()); return; }
  let img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')); if (!img.isEmpty()) img = img.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
  tray = new Tray(img); tray.setToolTip('Kurokawa Tools — ' + label('bubble', 'Screen translator'));
  tray.setContextMenu(trayMenu()); tray.on('click', () => ctx.showMain());
}
function trayMenu() {
  const keys = { ...DEFAULT_KEYS, ...(pc().keys || {}) };
  return Menu.buildFromTemplate([
    { label: label('region', 'Translate a region'), accelerator: keys.region, click: () => void act('region') },
    { label: label('translateScreen', 'Translate the screen'), accelerator: keys.full, click: () => void act('full') },
    { label: label('fixed', 'Translate the last region again'), accelerator: keys.repeat, enabled: !!lastRegion, click: () => void act('repeat') },
    { label: autoTimer ? label('autoOff', 'Stop auto translation') : label('autoOn', 'Auto translate the last region'), accelerator: keys.auto, enabled: !!lastRegion || !!autoTimer, click: () => void act('auto') },
    { label: label('clipboard', 'Translate the clipboard'), accelerator: keys.clipboard, click: () => void act('clipboard') },
    { type: 'separator' },
    { label: label('openApp', 'Open the app'), click: () => ctx.showMain('/screen') },
    { label: label('quit', 'Quit'), click: () => { ctx.quit(); } },
  ]);
}

/* ---------- what a shortcut does ---------- */
async function act(what) {
  try {
    if (what === 'clipboard') return showPopup(clipboard.readText());
    if (what === 'auto') return autoTimer ? stopAuto() : startAuto();
    const shot = await capture(); if (!shot) return;
    if (what === 'repeat' && lastRegion && lastRegion.display === shot.display.id) { job = { mode: 'result', ...shot, region: lastRegion }; return openOverlay(shot, { auto: true }); }
    job = { mode: what === 'full' ? 'full' : 'region', ...shot };
    openOverlay(shot);
  } catch (e) { console.error('[screen]', e); }
}
/** The display under the mouse, as a picture at its full resolution. */
async function capture() {
  const pt = screen.getCursorScreenPoint(); const d = screen.getDisplayNearestPoint(pt);
  const w = Math.round(d.size.width * d.scaleFactor), h = Math.round(d.size.height * d.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
  const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0]; if (!src) return null;
  const img = src.thumbnail; const sz = img.getSize();
  return { display: d, nimg: img, image: img.toDataURL(), width: sz.width, height: sz.height, scale: sz.width / d.size.width };
}
function openOverlay(shot, o = {}) {
  closeOverlay(); const b = shot.display.bounds;
  overlay = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, transparent: false, backgroundColor: '#000000', alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, fullscreenable: false, show: false, hasShadow: false, enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  overlay.setAlwaysOnTop(true, 'screen-saver'); overlay.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  overlay.loadURL('app://kurokawa/index.html#/overlay' + (o.auto ? '?go=1' : ''));
  overlay.once('ready-to-show', () => { overlay.setBounds(b); overlay.show(); overlay.focus(); });
  overlay.on('blur', () => { if (pc().closeOnBlur !== false && overlay && job && job.mode !== 'region') closeOverlay(); });
  overlay.on('closed', () => { overlay = null; });
}
function closeOverlay() { if (overlay && !overlay.isDestroyed()) overlay.close(); overlay = null; }
/** A region drawn on the frozen screen (in its CSS pixels): kept for «again» and «auto», its text read. */
async function regionChosen(r) {
  if (!job) return { blocks: [] };
  const s = job.scale; const rect = r && r.width > 3 ? { x: Math.round(r.x * s), y: Math.round(r.y * s), width: Math.round(r.width * s), height: Math.round(r.height * s) } : { x: 0, y: 0, width: job.width, height: job.height };
  if (r && r.width > 3) { lastRegion = { ...r, display: job.display.id }; try { fs.writeFileSync(path.join(app.getPath('userData'), 'screen-region.json'), JSON.stringify(lastRegion)); } catch { /* ignore */ } if (tray) tray.setContextMenu(trayMenu()); }
  if ((cfg.read === 'ai' || pc().ocr === 'ai')) { const crop = job.nimg.crop(rect); return { ai: crop.toDataURL(), offset: { x: rect.x / s, y: rect.y / s }, scale: s }; }
  const crop = job.nimg.crop(rect); const blocks = await ocr(crop.toPNG(), cfg.source || 'auto');
  return { blocks: blocks.map((b) => ({ text: b.text, x: (rect.x + b.x) / s, y: (rect.y + b.y) / s, width: b.width / s, height: b.height / s })) };
}

/* ---------- auto: a region watched, its translation beneath it ---------- */
function startAuto() {
  if (!lastRegion) { void act('region'); return; }
  const d = screen.getAllDisplays().find((x) => x.id === lastRegion.display) || screen.getPrimaryDisplay();
  const below = lastRegion.y + lastRegion.height + 160 < d.bounds.height;
  caption = new BrowserWindow({ x: Math.round(d.bounds.x + lastRegion.x), y: Math.round(d.bounds.y + (below ? lastRegion.y + lastRegion.height + 6 : Math.max(0, lastRegion.y - 126))), width: Math.max(260, Math.round(lastRegion.width)), height: 120, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  caption.setAlwaysOnTop(true, 'screen-saver'); caption.setIgnoreMouseEvents(true); caption.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  caption.loadURL('app://kurokawa/index.html#/overlay?caption=1');
  caption.on('closed', () => { caption = null; stopAuto(); });
  lastAutoText = ''; const every = Math.max(1, Number(cfg.interval) || 2) * 1000;
  autoTimer = setInterval(() => void autoTick(), every); void autoTick();
  if (tray) tray.setContextMenu(trayMenu());
  const mins = Number(cfg.autoStop); if (mins > 0) setTimeout(() => stopAuto(), mins * 60000);
}
function stopAuto() { if (autoTimer) clearInterval(autoTimer); autoTimer = null; if (caption && !caption.isDestroyed()) caption.close(); caption = null; if (tray) tray.setContextMenu(trayMenu()); }
async function autoTick() {
  if (autoBusy || !caption || !lastRegion) return; autoBusy = true;
  try {
    const shot = await capture(); if (!shot) return; const s = shot.scale; const r = lastRegion;
    const crop = shot.nimg.crop({ x: Math.round(r.x * s), y: Math.round(r.y * s), width: Math.round(r.width * s), height: Math.round(r.height * s) });
    const blocks = await ocr(crop.toPNG(), cfg.source || 'auto'); const text = blocks.map((b) => b.text).join('\n').trim();
    if (text && text !== lastAutoText && caption && !caption.isDestroyed()) { lastAutoText = text; caption.webContents.send('kt:screenCaption', { text }); }
  } catch (e) { console.error('[screen auto]', e); } finally { autoBusy = false; }
}

/* ---------- the clipboard's text, by the mouse ---------- */
function showPopup(text) {
  closePopup(); if (!text || !text.trim()) return;
  const pt = screen.getCursorScreenPoint(); const d = screen.getDisplayNearestPoint(pt); const w = 420, h = 220;
  const x = Math.min(d.workArea.x + d.workArea.width - w, Math.max(d.workArea.x, pt.x + 12)), y = Math.min(d.workArea.y + d.workArea.height - h, Math.max(d.workArea.y, pt.y + 12));
  job = { mode: 'text', text: text.slice(0, 5000) };
  popup = new BrowserWindow({ x, y, width: w, height: h, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: true, backgroundColor: '#1e1f22', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  popup.setAlwaysOnTop(true, 'floating'); popup.loadURL('app://kurokawa/index.html#/overlay?text=1');
  popup.on('blur', () => closePopup()); popup.on('closed', () => { popup = null; });
}
function closePopup() { if (popup && !popup.isDestroyed()) popup.close(); popup = null; }

/* ---------- OCR: the system's own ---------- */
function ocrKind() { if (pc().ocr === 'ai') return 'ai'; if (process.platform === 'win32') return 'windows'; if (process.platform === 'darwin') return 'vision'; return hasTesseract() ? 'tesseract' : 'none'; }
let tess = null; function hasTesseract() { if (tess !== null) return tess; try { require('node:child_process').execFileSync('tesseract', ['--version'], { stdio: 'ignore', timeout: 4000 }); tess = true; } catch { tess = false; } return tess; }
const run = (cmd, args, o = {}) => new Promise((ok, bad) => execFile(cmd, args, { timeout: 60000, maxBuffer: 32 << 20, windowsHide: true, ...o }, (e, out, err) => (e ? bad(new Error(String(err || e.message).slice(0, 400))) : ok(String(out)))));
function tmpPng(buf) { const f = path.join(os.tmpdir(), `kt-ocr-${process.pid}-${Date.now()}.png`); fs.writeFileSync(f, buf); return f; }
/** Lines of text with their boxes (in the picture's pixels). */
async function ocr(png, lang) {
  const kind = ocrKind(); const f = tmpPng(png);
  try {
    if (kind === 'windows') return parseLines(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', winScript(), '-path', f, '-lang', winLang(lang)]));
    if (kind === 'vision') { const img = nativeImage.createFromBuffer(png); const sz = img.getSize(); return parseLines(await run('osascript', ['-l', 'JavaScript', macScript(), f, macLang(lang)])).map((b) => ({ text: b.text, x: b.x * sz.width, y: (1 - b.y - b.height) * sz.height, width: b.width * sz.width, height: b.height * sz.height })); }
    if (kind === 'tesseract') return tsvLines(await run('tesseract', [f, 'stdout', '-l', tessLang(lang), 'tsv']));
    throw new Error('ocr-missing');
  } finally { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
function parseLines(out) { const m = /[[{]/.exec(out); const i = m ? m.index : -1; if (i < 0) return []; try { const v = JSON.parse(out.slice(i)); return (Array.isArray(v) ? v : [v]).filter((b) => b && b.text && String(b.text).trim()); } catch { return []; } }
function tsvLines(out) {
  const lines = new Map();
  for (const row of out.split('\n').slice(1)) { const c = row.split('\t'); if (c.length < 12 || c[0] !== '5' || !c[11].trim() || Number(c[10]) < 30) continue; const k = `${c[2]}-${c[3]}-${c[4]}`; const x = +c[6], y = +c[7], w = +c[8], h = +c[9]; const l = lines.get(k); if (!l) lines.set(k, { text: c[11], x, y, width: w, height: h }); else { const r = Math.max(l.x + l.width, x + w), b = Math.max(l.y + l.height, y + h); l.x = Math.min(l.x, x); l.y = Math.min(l.y, y); l.width = r - l.x; l.height = b - l.y; l.text += ' ' + c[11]; } }
  return [...lines.values()];
}
const tessLang = (l) => ({ ja: 'jpn', 'zh-CN': 'chi_sim', zh: 'chi_sim', 'zh-TW': 'chi_tra', ko: 'kor', ar: 'ara', fr: 'fra', de: 'deu', es: 'spa', ru: 'rus', pt: 'por', it: 'ita', tr: 'tur' }[l] || 'eng');
const winLang = (l) => (!l || l === 'auto' ? '' : l === 'zh-CN' || l === 'zh' ? 'zh-Hans' : l === 'zh-TW' ? 'zh-Hant' : l);
const macLang = (l) => (!l || l === 'auto' ? '' : l === 'zh-CN' || l === 'zh' ? 'zh-Hans' : l === 'zh-TW' ? 'zh-Hant' : l === 'ja' ? 'ja-JP' : l === 'ko' ? 'ko-KR' : l);
async function ocrLangs() {
  if (ocrKind() === 'windows') { try { return { kind: 'windows', langs: parseLines(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', winScript(), '-list'])).map((x) => x.text) }; } catch (e) { return { kind: 'windows', error: String(e.message) }; } }
  if (ocrKind() === 'tesseract') { try { return { kind: 'tesseract', langs: (await run('tesseract', ['--list-langs'])).split('\n').slice(1).filter(Boolean) }; } catch (e) { return { kind: 'tesseract', error: String(e.message) }; } }
  return { kind: ocrKind() };
}
function script(name, body) { const f = path.join(app.getPath('userData'), name); try { if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== body) fs.writeFileSync(f, body); } catch { /* ignore */ } return f; }
// (Windows 10/11's own OCR — Windows.Media.Ocr — through Windows PowerShell; a language's OCR is there when its
// language pack is: Settings → Time & language → Language.)
function winScript() { return script('kt-ocr.ps1', `param([string]$path = '', [string]$lang = '', [switch]$list)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
if ($list) { $o = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { @{ text = $_.LanguageTag } }); ConvertTo-Json -InputObject $o -Compress; exit 0 }
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = $null
if ($lang -ne '') { try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($lang)) } catch { $engine = $null } }
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$cjk = $lang -match '^(ja|zh|ko)'
$out = @(foreach ($line in $result.Lines) {
  $x1 = 1e9; $y1 = 1e9; $x2 = 0; $y2 = 0
  foreach ($w in $line.Words) { $r = $w.BoundingRect; if ($r.X -lt $x1) { $x1 = $r.X }; if ($r.Y -lt $y1) { $y1 = $r.Y }; if ($r.X + $r.Width -gt $x2) { $x2 = $r.X + $r.Width }; if ($r.Y + $r.Height -gt $y2) { $y2 = $r.Y + $r.Height } }
  $text = if ($cjk) { ($line.Words | ForEach-Object { $_.Text }) -join '' } else { $line.Text }
  @{ text = $text; x = $x1; y = $y1; width = $x2 - $x1; height = $y2 - $y1 }
})
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -InputObject $out -Compress
`); }
// (macOS's Vision text recognition, from JavaScript for Automation: boxes come back as fractions of the picture,
// measured from its bottom-left corner.)
function macScript() { return script('kt-ocr.js', `ObjC.import('Vision'); ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const req = $.VNRecognizeTextRequest.alloc.init; req.recognitionLevel = 0; req.usesLanguageCorrection = true;
  if (argv[1]) req.recognitionLanguages = $([argv[1]]);
  const h = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  h.performRequestsError($([req]), null);
  const out = []; const res = req.results; const n = res ? res.count : 0;
  for (let i = 0; i < n; i++) { const o = res.objectAtIndex(i); const c = o.topCandidates(1); if (!c.count) continue; const b = o.boundingBox; out.push({ text: c.objectAtIndex(0).string.js, x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height }); }
  return JSON.stringify(out);
}`); }

function stopAll() { stopAuto(); closeOverlay(); closePopup(); try { globalShortcut.unregisterAll(); } catch { /* ignore */ } if (tray) { tray.destroy(); tray = null; } }
/** Whether closing the main window should leave the app running in the tray. */
function keepInTray() { return enabled() && !!pc().tray && !!tray; }
module.exports = { init, stopAll, keepInTray, ocr, tsvLines, parseLines, DEFAULT_KEYS };
