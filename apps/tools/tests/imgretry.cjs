// A picture the web view cannot load is asked once more through the app's request path (the phone's plugin here),
// and shown from what it gave; a second failure is left alone.
const { chromium } = require('playwright'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
(async () => {
  const esbuild = require(require.resolve('esbuild', { paths: [path.join(__dirname, '..'), path.join(__dirname, '..', '..', '..')] }));
  const out = path.join(os.tmpdir(), `imgr-${process.pid}.js`);
  await esbuild.build({ stdin: { contents: "import { startImgRetry } from './src/ui/imgRetry'; startImgRetry();", resolveDir: path.join(__dirname, '..'), loader: 'ts' }, bundle: true, outfile: out, format: 'iife', logLevel: 'silent' });
  const br = await chromium.launch(); const p = await br.newPage(); const errors = []; const check = (w, ok) => { console.log(ok ? 'ok  ' : 'FAIL', w); if (!ok) errors.push(w); };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAKQkDAbqUgCYAAAAASUVORK5CYII=';
  await p.route('https://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title>' }));
  await p.route('https://s4.anilist.co/**', (r) => r.abort('connectionreset'));
  await p.goto('https://app.test/');
  await p.evaluate((b64) => { window.__asked = []; window.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: { KurokawaTools: { httpRequest: async (o) => { window.__asked.push(o.url); if (o.url.includes('gone')) return { status: 404, url: o.url, headers: {}, body: '' }; return { status: 200, url: o.url, headers: { 'content-type': 'image/png' }, body: b64 }; } } } }; }, png);
  await p.addScriptTag({ content: fs.readFileSync(out, 'utf8') });
  await p.evaluate(() => { for (const n of ['a.png', 'gone.png']) { const i = document.createElement('img'); i.id = n.split('.')[0]; i.onerror = () => i.dataset.removed = '1'; i.src = 'https://s4.anilist.co/file/' + n; document.body.append(i); } });
  await p.waitForFunction(() => document.getElementById('a').naturalWidth === 2, null, { timeout: 8000 }).catch(() => undefined);
  check('the picture shown from the app\'s request', await p.evaluate(() => document.getElementById('a').naturalWidth === 2 && document.getElementById('a').src.startsWith('blob:')));
  await p.waitForTimeout(800);
  check('a picture gone for good is left to its own handler', await p.evaluate(() => document.getElementById('gone').dataset.removed === '1' || document.getElementById('gone').dataset.ktRetried === '1'));
  check('asked once each', await p.evaluate(() => window.__asked.length === 2));
  console.log(errors.length ? 'errors' : 'all passed'); await br.close(); fs.rmSync(out, { force: true }); process.exit(errors.length ? 1 : 0);
})();
