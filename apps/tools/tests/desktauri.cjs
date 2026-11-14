// Stage P6 on the page (src/downloads/power.ts) against a fake Tauri bridge: at start the page sends desktopPrefs with
// the interface's words for the tray's menu and a Mac's menu bar (labels, in the chosen language), and a hotkey the
// shell refused (hotkeyErrors { mode: 'key' | 'taken' | 'none' }) is said plainly in a toast in that language; the
// Electron-shaped bridge (no answer) shows nothing. Usage: node tests/desktauri.cjs [en|ar|ja|ko|zh]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, async () => {
  const br = await chromium.launch(); let fails = 0;
  for (const answer of [true, false]) {
    const p = await br.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(([lang, answer]) => {
      localStorage.setItem('kr.lang', lang);
      localStorage.setItem('kt.settings', JSON.stringify({ power: { tray: true, hotkeys: { clip: 'CommandOrControl+Shift+V', video: 'AltGr+V' } } }));
      window.__prefs = [];
      window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [], onTasks: (cb) => { setTimeout(() => cb([]), 20); return () => {}; },
        desktopPrefs: async (o) => { window.__prefs.push(JSON.parse(JSON.stringify(o))); return answer ? { ...o, labels: undefined, hotkeyErrors: { video: 'key', clip: 'taken' } } : undefined; } },
      { get: (t, k) => (k in t ? t[k] : k === 'then' || k === 'can' ? undefined : undefined) });
    }, [lang, answer]);
    await p.goto(`http://127.0.0.1:${web.address().port}/`);
    await p.waitForFunction(() => window.__prefs.length > 0, null, { timeout: 15000 });
    await p.waitForTimeout(700);
    const sent = await p.evaluate(() => window.__prefs[0]);
    const toasts = await p.$$eval('.toast, [class*="toast"]', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
    const L = sent.labels || {};
    const okLabels = typeof L.quit === 'string' && L.quit && typeof L.app === 'string' && L.app && Object.keys(L).length >= 20 && (lang !== 'ar' || /[؀-ۿ]/.test(L.quit));
    const okSent = sent.tray === true && sent.hotkeys.clip === 'CommandOrControl+Shift+V';
    const okToasts = answer ? toasts.some((t) => t.includes('AltGr+V')) && toasts.some((t) => t.includes('CommandOrControl+Shift+V')) && (lang === 'en' ? toasts.some((t) => /another program holds it/.test(t)) : true) : !toasts.some((t) => t.includes('AltGr+V'));
    if (answer) await p.screenshot({ path: path.join(__dirname, `shot-desktauri-${lang}.png`) });
    console.log(answer ? 'tauri:' : 'electron:', JSON.stringify({ labels: okLabels, sent: okSent, toasts: okToasts, shown: toasts.filter((t) => /V/.test(t)) }));
    if (!(okLabels && okSent && okToasts) || errors.length) { fails++; if (errors.length) console.log('errors', errors); }
    await p.close();
  }
  console.log(fails ? 'FAILED' : 'all passed');
  await br.close(); web.close(); process.exit(fails ? 1 : 0);
});
