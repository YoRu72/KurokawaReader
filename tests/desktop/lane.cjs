// The desktop's own browser (desktop/main.cjs), its state machine run against a stand-in for Electron: a site's
// page clear at once, after a check, never answering, refusing; a request through it; a check out of sight that
// times out, a window the reader closes, one that stays; a site set aside while busy; the app's hidden windows
// closed with the app. Every handler must answer — none may hang. node tests/desktop/lane.cjs
const Module = require('module'); const { EventEmitter } = require('events'); const path = require('path');

// The page each window shows, by its address: how its state reads over time, what its requests answer.
const sites = {};
const site = (origin, s) => { sites[origin] = { reads: 0, ...s }; };
const wins = [];
class FakeWindow extends EventEmitter {
  constructor(opts) {
    super(); this.opts = opts; this.destroyed = false; this.url = '';
    const w = this;
    this.webContents = Object.assign(new EventEmitter(), {
      mainFrame: { executeJavaScript: (code) => w.exec(code) },
      executeJavaScript: () => new Promise(() => {}),   // (webContents' own waits for the page to stop loading: never here)
      isLoading: () => false, send() {}, setBackgroundThrottling() {},
    });
    wins.push(this);
  }
  exec(code) {
    const s = sites[new URL(this.url || 'about:blank').origin] ?? {};
    if (code.includes('readyState')) {
      s.reads = (s.reads ?? 0) + 1;
      const st = typeof s.state === 'function' ? s.state(s.reads, this) : s.state;
      if (st === 'hang') return new Promise(() => {});
      return Promise.resolve(st);
    }
    if (code.startsWith('(async (o) =>')) {
      const o = JSON.parse(code.slice(code.indexOf('})(') + 3, -1));
      if (s.fetch === 'hang') return new Promise(() => {});
      return Promise.resolve({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, b64: Buffer.from(`answer to ${o.url}`).toString('base64'), url: o.url });
    }
    return Promise.resolve(null);
  }
  loadURL(u) { this.url = u; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  close() { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', ev); if (!ev.prevented) this.destroy(); }
  setMenuBarVisibility() {} on(...a) { return super.on(...a); }
  getNormalBounds() { return {}; } isMaximized() { return false; } isMinimized() { return false; } focus() {} restore() {} show() {}
}
const handlers = {};
const cookies = [{ name: 'cf_clearance', value: 'x' }, { name: '__cf_bm', value: 'y' }, { name: 'session', value: 'z' }];
const any = () => {};
const fakeElectron = {
  app: { userAgentFallback: 'Mozilla/5.0 Chrome/130 Electron/33.0.0 KurokawaReader/0.46.0', on: any, whenReady: () => new Promise(() => {}), requestSingleInstanceLock: () => true, setAsDefaultProtocolClient: any, setAppUserModelId: any, getPath: () => '/tmp', quit: any, getVersion: () => '0.46.0', commandLine: { appendSwitch: any } },
  BrowserWindow: Object.assign(FakeWindow, { getAllWindows: () => wins.filter((w) => !w.destroyed), fromWebContents: () => null }),
  protocol: { registerSchemesAsPrivileged: any, handle: any },
  net: { fetch: () => Promise.reject(new Error('no network here')) },
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: any },
  session: { defaultSession: { cookies: { get: async () => cookies.slice(), remove: async (_u, name) => { const i = cookies.findIndex((c) => c.name === name); if (i >= 0) cookies.splice(i, 1); } }, setPermissionRequestHandler: any, setPermissionCheckHandler: any } },
  shell: {}, Menu: { setApplicationMenu: any, buildFromTemplate: () => ({}) }, clipboard: {}, nativeImage: {}, Notification: function () {},
};
const load = Module._load;
Module._load = function (request, ...rest) { if (request === 'electron') return fakeElectron; return load.call(this, request, ...rest); };
require(path.join(__dirname, '../../desktop/main.cjs'));

const ok = (name, cond, extra) => console.log((cond ? 'ok  ' : 'FAIL'), name, cond || extra === undefined ? '' : JSON.stringify(extra));
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('HUNG'), ms))]);
const state = (origin, { loading = false, check = false, blocked = false, title = 'Page' } = {}) => [loading ? 'loading' : 'complete', origin, check ? 1 : 0, blocked ? 1 : 0, title].join('\u0001');

(async () => {
  const fetchVia = (url, o = {}) => handlers['kr:browser-fetch']({}, { url, method: 'GET', headers: {}, openTimeout: 1500, timeout: 2000, ...o });
  // 1. A site clear at once: a request answered through its page.
  site('https://a.test', { state: state('https://a.test') });
  const r1 = await within(fetchVia('https://a.test/x?y=1'), 8000);
  ok('a clear site: the request answered by its page', r1 !== 'HUNG' && r1.status === 200 && r1.body === 'answer to https://a.test/x?y=1' && r1.via === 'browser', r1);
  const r1b = await within(fetchVia('https://a.test/z', { binary: true }), 8000);
  ok('… the same window again, a binary answer as base64', r1b.body === Buffer.from('answer to https://a.test/z').toString('base64') && wins.filter((w) => !w.destroyed && w.url.startsWith('https://a.test')).length === 1, r1b);
  // 2. A check that passes by itself after a few reads.
  site('https://b.test', { state: (n) => state('https://b.test', { check: n < 3, title: n < 3 ? 'Just a moment...' : 'B' }) });
  const r2 = await within(fetchVia('https://b.test/'), 8000);
  ok('a check passing by itself: then the request', r2 !== 'HUNG' && r2.status === 200, r2);
  // 3. A page that never answers its state: the time allowed, kept — a check for the reader, not a hang.
  site('https://c.test', { state: 'hang' });
  const t3 = Date.now(); const r3 = await within(fetchVia('https://c.test/'), 12000);
  ok('a page that never answers: given up in the time allowed (a check for the reader), not hung', r3 !== 'HUNG' && r3.status === 403 && r3.headers['x-kr-lane'] === 'challenge' && Date.now() - t3 < 9000, r3 === 'HUNG' ? 'HUNG' : r3);
  const r3b = await within(fetchVia('https://c.test/again'), 12000);
  ok('… and the next request is not left waiting on it either', r3b !== 'HUNG' && r3b.status === 403, r3b === 'HUNG' ? 'HUNG' : r3b);
  // 4. A refusal: said as such.
  site('https://d.test', { state: state('https://d.test', { blocked: true, title: 'Attention Required! | Cloudflare' }) });
  const r4 = await within(fetchVia('https://d.test/'), 8000);
  ok('a refusal: answered as one, with its title', r4.status === 403 && r4.headers['x-kr-lane'] === 'blocked' && /Attention Required/.test(r4.body), r4);
  // 5. A page that moves to another site: the request goes the plain way (an error), at once.
  site('https://e.test', { state: state('https://elsewhere.test') });
  const r5 = await within(fetchVia('https://e.test/').then(() => 'answered', (e) => `error: ${e.message}`), 8000);
  ok('a page sent to another site: an error at once (the app goes the plain way)', /^error: Browser could not open the site: the site sends its pages to https:\/\/elsewhere\.test/.test(r5), r5);
  // 6. A request whose page never answers it: rejected in the time allowed.
  site('https://f.test', { state: state('https://f.test'), fetch: 'hang' });
  const r6 = await within(fetchVia('https://f.test/', { timeout: 500 }).then(() => 'answered', (e) => `error: ${e.message}`), 20000);
  ok('a request never answered: rejected in the time allowed', /timed out/.test(r6), r6);
  // 7. Checks: out of sight, timing out; the reader closing a window; a window that stays; www. and https.
  site('https://g.test', { state: 'hang' });
  const c1 = await within(handlers['kr:open-webview']({}, { url: 'https://g.test/', hidden: true, timeout: 1000 }), 8000);
  ok('a check out of sight that never answers: done in its time, not passed', c1 !== 'HUNG' && c1.passed === false, c1);
  site('https://h.test', { state: (n) => state('https://h.test', { check: true, title: 'Just a moment...' }) });
  const c2p = handlers['kr:open-webview']({}, { url: 'https://h.test/', timeout: 60000, message: 'Confirm you’re human on h.test' });
  await new Promise((r) => setTimeout(r, 300));
  const w2 = wins[wins.length - 1];
  ok('the check window titled with the line for the reader', w2.opts.title === 'Confirm you’re human on h.test' && w2.opts.show === true);
  sites['https://h.test'].state = 'hang'; w2.close();
  const c2 = await within(c2p, 5000);
  ok('closed by the reader while its page does not answer: done all the same', c2 !== 'HUNG' && c2.passed === false && w2.destroyed, c2);
  site('https://www.i.test', { state: state('https://www.i.test', { title: 'I' }) });
  const c3 = await within(handlers['kr:open-webview']({}, { url: 'https://www.i.test/', timeout: 60000 }), 6000);
  ok('a check passed: the window closes by itself', c3 !== 'HUNG' && c3.passed === true, c3);
  site('http://j.test', { state: state('https://www.j.test') });
  const c3b = await within(handlers['kr:open-webview']({}, { url: 'http://j.test/', timeout: 60000 }), 6000);
  ok('… the site sending to www. and https counts as passed', c3b !== 'HUNG' && c3b.passed === true, c3b);
  site('https://k.test', { state: state('https://k.test') });
  const c4p = handlers['kr:open-webview']({}, { url: 'https://k.test/', timeout: 1000, stay: true });
  const early = await within(c4p, 2500);
  ok('a window that stays: still open after its time and after the page was clear', early === 'HUNG');
  const w4 = wins.filter((w) => w.url === 'https://k.test/').pop(); w4.close();
  const c4 = await within(c4p, 4000);
  ok('… closed by the reader, it reports the site passed', c4 !== 'HUNG' && c4.passed === true, c4);
  // 8. Set aside while a request is under way: the request finishes, the window then closes.
  site('https://l.test', { state: state('https://l.test') });
  await fetchVia('https://l.test/first');
  sites['https://l.test'].fetch = 'hang';
  const slow = fetchVia('https://l.test/slow', { timeout: 2500 }).catch((e) => e.message);
  await new Promise((r) => setTimeout(r, 200));
  const lw = wins.filter((w) => w.url.startsWith('https://l.test') && !w.destroyed).pop();
  await handlers['kr:browser-reset']({}, 'https://l.test/');
  ok('set aside while busy: its window kept for the request under way', !lw.destroyed);
  sites['https://l.test'].fetch = undefined;
  const fresh = await within(fetchVia('https://l.test/next'), 8000);
  ok('… a new request opens the site afresh in another window', fresh.status === 200 && wins.filter((w) => w.url.startsWith('https://l.test') && !w.destroyed).length === 2, fresh);
  await slow; await new Promise((r) => setTimeout(r, 2500));
  ok('… the old one closed once its request was done', lw.destroyed);
  // 9. The site's clearance forgotten: only the check's cookies.
  const f = await handlers['kr:browser-forget']({}, 'https://a.test/', false);
  ok('the clearance forgotten, other cookies kept', f.cleared === 2 && cookies.map((c) => c.name).join() === 'session', { f, cookies });
  // 10. The app's window closed: every hidden window of its own goes too.
  const hid = handlers['kr:open-webview']({}, { url: 'https://g.test/', hidden: true, timeout: 60000 });
  await new Promise((r) => setTimeout(r, 200));
  const mainWin = new FakeWindow({});   // (createWindow is not run here: its 'closed' handler is what is checked below)
  const src = require('fs').readFileSync(path.join(__dirname, '../../desktop/main.cjs'), 'utf8');
  ok('the main window\'s close takes the hidden windows with it', /win\.on\('closed', \(\) => \{ win = null; closeHelpers\(\); \}\)/.test(src));
  void mainWin; void hid;
  console.log('done');
  process.exit(0);
})().catch((e) => { console.log('FAIL threw', e && e.stack || e); process.exit(1); });
