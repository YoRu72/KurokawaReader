// DNS over HTTPS in Settings and the details pages (0.21 P9), on the phone (the plugin faked) and on a computer
// (Electron's and Tauri's bridges faked): the choice, the user's own address checked, the system-DNS switch with its
// explanation, each resolver's health with «Check now», what goes through DoH on that device (different per shell; the
// phone's hello-split row on the phone only), a download's one quiet line and a torrent's trackers. `node
// tests/dohui.cjs [en|ar]`; KT_SHOTS=<dir> keeps the pictures.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const LANG = process.argv[2] === 'ar' ? 'ar' : 'en'; const SHOTS = process.env.KT_SHOTS || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const AR = LANG === 'ar'; const W = (en, ar) => (AR ? ar : en);

// (The status every shell hands back: the table's resolvers in order, three checked.)
const STATUS = `(() => { const ids = ['cloudflare','google','quad9','adguard','adguard-unfiltered','dnssb','controld','wikimedia','dns4eu']; const now = Date.now();
  const h = { cloudflare: { ok: true, ms: 21, at: now - 90000 }, quad9: { ok: true, ms: 48, at: now - 90000 }, google: { ok: false, ms: 6000, at: now - 90000, reason: 'timeout' } };
  return { on: true, allowSystem: !!window.__allow, order: ['cloudflare','quad9','adguard','adguard-unfiltered','dnssb','controld','wikimedia','dns4eu','google'], providers: ids.map((id) => ({ id, label: id, ok: h[id] ? h[id].ok : null, ms: h[id] ? h[id].ms : null, at: h[id] ? h[id].at : null, reason: (h[id] && h[id].reason) || '' })), lastProbe: now - 90000, queries: 42, fails: 1, system: 0 }; })()`;

(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port; const base = `http://127.0.0.1:${port}/`;
  const br = await chromium.launch(); const errors = []; const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', `${LANG}: ${what}`, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const shot = async (el, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await el.screenshot({ path: path.join(SHOTS, `p9-${name}-${LANG}.png`) }); };
  const settings = (o) => JSON.stringify({ addons: [], doh: 'auto', dohSystem: false, ...o });

  // ---------- the phone ----------
  {
    const ctx = await br.newContext({ viewport: { width: 360, height: SHOTS ? 2600 : 800 }, deviceScaleFactor: 2 }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(0, 3).join(' | ')));
    await ctx.route(/raw\.githubusercontent\.com|api\.github\.com/, (r) => r.fulfill({ status: 404 }));
    await p.addInitScript(([lang, st, status]) => {
      localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', st); window.__calls = []; const listeners = {};
      const task = { id: 't1', kind: 'http', name: 'Episode 01.mkv', source: { url: 'https://files.test/ep01.mkv' }, dir: '/sdcard/Download', state: 'downloading', done: 4e8, total: 1e9, downSpeed: 3e6, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native' };
      const tor = { id: 't2', kind: 'torrent', name: 'Show S01', source: { magnet: 'magnet:?xt=urn:btih:' + 'c'.repeat(40) }, dir: '/sdcard/Download', state: 'downloading', done: 3e8, total: 1.2e9, downSpeed: 2e6, upSpeed: 1e5, peers: 12, seeds: 4, files: [], addedAt: Date.now(), engine: 'native' };
      const api = {
        addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return Promise.resolve({ remove() {} }); },
        list: async () => ({ tasks: [task, tor] }),
        setDoh: async (o) => { window.__calls.push(['setDoh', o]); if ('allowSystem' in o) window.__allow = o.allowSystem; return { provider: o.provider }; },
        dohStatus: async (o) => { window.__calls.push(['dohStatus', o]); const s = eval(status); return o && o.probe ? { ...s, probe: { ok: true, resolver: 'cloudflare', ms: 21 } } : { ...s, state: 'ok', log: [], hits: 3, unblocked: 0, lastResolver: '1.1.1.1', lastMs: 21, lastAt: Date.now(), lastError: '', cached: 5, resolvers: [] }; },
        dohUsed: async (o) => { window.__calls.push(['dohUsed', o]); return { on: true, hosts: Object.fromEntries((o.hosts || []).map((h) => [h, { via: 'doh:cloudflare:23', at: Date.now() }])) }; },
        torrentDetail: async () => ({ seeds: 4, peersConnected: 9, seedsInSwarm: 50, peersInSwarm: 20, ratio: 0.1, peers: [], trackers: [
          { url: 'udp://203.0.113.7:1337/announce', name: 'udp://tracker.test:1337/announce', dns: 'doh:cloudflare:19', tier: 0, state: 'working', message: '', fails: 0 },
          { url: 'https://web.test/announce', dns: 'engine', tier: 1, state: 'waiting', message: '', fails: 0 },
          { url: 'udp://gone.test:80/announce', dns: 'dropped', tier: 0, state: 'waiting', message: '', fails: 0 }] }),
      };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
    }, [LANG, settings({}), STATUS]);
    await p.goto(base + '#/settings'); await p.waitForSelector('#privacy'); await p.waitForTimeout(400);
    if (await p.$('#privacy.collapsed')) { await p.click('#privacy h3'); await p.waitForTimeout(200); }
    await p.locator('#privacy').scrollIntoViewIfNeeded(); await p.waitForSelector('#privacy .doh-hrow'); await p.waitForTimeout(300);
    const rows = await p.$$eval('#privacy .doh-hrow', (e) => e.map((r) => ({ id: r.dataset.id, cls: r.className, txt: r.innerText.replace(/\s+/g, ' ') })));
    check('every resolver listed with its health, in the order asked', rows.length === 9 && rows[0].id === 'cloudflare' && rows[8].id === 'google', rows.map((r) => r.id));
    check('healthy: its time; failing: the reason in words (not the raw «timeout»); the rest not checked', /h-ok/.test(rows[0].cls) && /21|٢١/.test(rows[0].txt) && /h-fail/.test(rows[8].cls) && /no answer in time|لم يأتِ الجواب/.test(rows[8].txt) && !/timeout/.test(rows[8].txt) && /h-none/.test(rows[2].cls), [rows[0], rows[8]]);
    check('the first marked «asked first»', !!(await p.$('#privacy .doh-hrow[data-id="cloudflare"] .doh-first')));
    check('a filter said (Quad9 blocks malware)', /malware|البرمجيات الخبيثة/.test(rows[1].txt), rows[1]);
    const sw = p.locator('#privacy .switch-row', { hasText: W('system’s DNS', 'DNS النظام') });
    check('the system-DNS switch, off by default, explained', (await sw.count()) === 1 && !(await sw.locator('input').isChecked()) && /privacy|safer|الأسلم/.test(await sw.innerText()));
    check('the phone\'s hello-split row is here', /Split the TLS hello|TLS/.test(await p.$eval('#privacy', (e) => e.innerText)));
    const cover = await p.$$eval('#privacy .doh-cover-list li', (e) => e.map((x) => x.className)); check('what goes through DoH on the phone: seven lines — HTTP trackers the engine\'s own, cloud accounts the system\'s, UDP trackers left out when unanswered', cover.length === 7 && cover.includes('c-engine') && cover.includes('c-system') && cover.includes('c-yesDrop') && !cover.includes('c-hidden'), cover);
    await shot(p.locator('#privacy'), 'phone-settings');
    // Check now.
    await p.locator('#privacy .doh-health-head button').click(); await p.waitForTimeout(400);
    check('«Check now» asks the phone to probe', await p.evaluate(() => window.__calls.some(([k, o]) => k === 'dohStatus' && o && o.probe)));
    // The switch: put in force with the choice.
    await sw.locator('input').click(); await p.waitForTimeout(300);
    check('the switch: setDoh with allowSystem, and kept', await p.evaluate(() => window.__calls.some(([k, o]) => k === 'setDoh' && o.allowSystem === true && o.provider === 'auto')) && await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).dohSystem === true));
    // The user's own address, checked.
    await p.locator('#privacy .doh-rows > .row').first().locator('button').first().click(); await p.waitForTimeout(200);
    await p.locator('.sheet .dest-row, .sheet label, .sheet button', { hasText: W('Another resolver', 'محلِّل آخر') }).first().click(); await p.waitForTimeout(200);
    await p.fill('#privacy .doh-url', 'http://dns.example/dns-query'); await p.locator('#privacy .doh-url').dispatchEvent('change'); await p.waitForTimeout(150);
    check('a plain-http address refused, with the reason', await p.$eval('#privacy .doh-err', (e) => !e.hidden && /https:\/\//.test(e.textContent)));
    await shot(p.locator('#privacy .doh-custom'), 'phone-custom-error');
    await p.fill('#privacy .doh-url', 'https://dns.example/dns-query'); await p.locator('#privacy .doh-url').dispatchEvent('change'); await p.waitForTimeout(400);
    check('a sound address put in force', await p.evaluate(() => window.__calls.some(([k, o]) => k === 'setDoh' && o.provider === 'https://dns.example/dns-query')));
    // A download's details: one quiet line.
    await p.goto(base + '#/task/t1'); await p.waitForSelector('.doh-line:not([hidden])', { timeout: 4000 }).catch(() => undefined);
    const line = await p.$eval('.doh-line', (e) => (e.hidden ? '' : e.textContent)).catch(() => '');
    check('the download\'s line: which resolver answered', /Cloudflare/.test(line) && /DoH/.test(line) && /23|٢٣/.test(line), line);
    await shot(p.locator('.kt-hero'), 'phone-task-line');
    // A torrent's trackers: the tracker's own name and what found it.
    await p.goto(base + '#/task/t2'); await p.waitForSelector('.kt-swarm', { timeout: 4000 }).catch(() => undefined); await p.waitForTimeout(600);
    await p.evaluate(() => { const d = document.querySelector('.kt-swarm details.swarm-sec:last-of-type') || [...document.querySelectorAll('.kt-swarm details')].pop(); if (d) d.open = true; }); await p.waitForTimeout(2300);
    const tr = await p.$eval('.kt-swarm', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '');
    check('trackers: the name kept, the resolver said, the engine\'s own said, an unanswered one said left out', /left out|تُرك/.test(tr) && /tracker\.test/.test(tr) && /Cloudflare/.test(tr) && /engine|المحرّك|محرّك/.test(tr) && !/203\.0\.113\.7/.test(tr), tr.slice(0, 300));
    await shot(p.locator('.kt-swarm'), 'phone-trackers');
    await ctx.close();
  }

  // ---------- a computer: Electron, then Tauri ----------
  for (const shell of ['electron', 'tauri']) {
    const ctx = await br.newContext({ viewport: { width: 1280, height: SHOTS ? 1900 : 800 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(0, 3).join(' | ')));
    await ctx.route(/raw\.githubusercontent\.com|api\.github\.com/, (r) => r.fulfill({ status: 404 }));
    await p.addInitScript(([lang, st, status, sh]) => {
      localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.settings', st); window.__calls = [];
      const api = { platform: 'desktop', available: true, os: 'win32', ...(sh === 'electron' ? { shell: 'electron' } : {}), list: async () => [{ id: 'g1', kind: 'http', name: 'Episode 01.mkv', source: { url: 'https://files.test/ep01.mkv' }, dir: 'C:\\D', state: 'downloading', done: 4e8, total: 1e9, downSpeed: 3e6, upSpeed: 0, files: [], addedAt: Date.now() }, { id: 'g2', kind: 'http', name: 'Notes.pdf', source: { url: 'https://self.test/notes.pdf' }, dir: 'C:\\D', state: 'failed', error: 'SSL/TLS handshake failure: unable to get local issuer certificate (1)', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now() }, { id: 'g3', kind: 'http', name: 'Ads.zip', source: { url: 'https://ads.test/a.zip' }, dir: 'C:\\D', state: 'failed', error: 'DNS over HTTPS: ads.test is blocked by adguard', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now() }],
        onTasks: (fn) => { setTimeout(() => api.list().then(fn), 30); return () => {}; },
        setDoh: async (o) => { window.__calls.push(['setDoh', o]); window.__allow = o.allowSystem; return o; }, dohStatus: async () => eval(status), dohProbe: async () => { window.__calls.push(['dohProbe']); return { ...eval(status), ok: true, resolver: 'cloudflare', ms: 21 }; },
        dohUsed: async (o) => ({ on: true, hosts: Object.fromEntries((o.hosts || []).map((h) => [h, { via: 'system', at: Date.now() }])) }) };
      window.kurokawaTools = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
    }, [LANG, settings({ doh: 'quad9' }), STATUS, shell]);
    await p.goto(base + '#/settings/privacy'); await p.waitForSelector('#privacy .doh-hrow', { timeout: 6000 }).catch(() => undefined); await p.waitForTimeout(400);
    const txt = await p.$eval('#privacy', (e) => e.innerText).catch(() => '');
    check(`${shell}: the health list and the switch`, (await p.$$('#privacy .doh-hrow')).length === 9 && /system’s DNS|DNS النظام/.test(txt));
    check(`${shell}: pinned — the hint names it`, /Quad9/.test(txt));
    check(`${shell}: no phone-only rows (hello split, the live feed)`, !/Split the TLS hello|قسّم|تقسيم/.test(txt) && !(await p.$('#privacy .doh-card')));
    await p.click('#privacy .doh-cover summary'); await p.waitForTimeout(150);
    const cover = await p.$$eval('#privacy .doh-cover-list li', (e) => e.map((x) => x.className));
    check(`${shell}: what goes through DoH here (${cover.join(' ')})`, cover.length === 8 && (shell === 'electron' ? cover.filter((c) => c === 'c-system').length === 2 : cover.filter((c) => c === 'c-system').length === 3), cover);
    await shot(p.locator('#privacy'), `pc-${shell}-settings`);
    await p.locator('#privacy .doh-health-head button').click(); await p.waitForTimeout(300);
    check(`${shell}: «Check now» probes`, await p.evaluate(() => window.__calls.some(([k]) => k === 'dohProbe')));
    await p.goto(base + '#/task/g1'); await p.waitForSelector('.doh-line:not([hidden])', { timeout: 4000 }).catch(() => undefined);
    if (process.env.KT_DEBUG) { await p.screenshot({ path: process.env.KT_DEBUG + `/dbg-${shell}.png` }); console.log(await p.evaluate(() => document.body.innerText.slice(0, 300))); }
    const line = await p.$eval('.doh-line', (e) => (e.hidden ? '' : e.textContent)).catch(() => '');
    check(`${shell}: the download's line says when the system's DNS was used`, /system|النظام/.test(line), line);
    if (shell === 'electron') await shot(p.locator('.kt-hero'), 'pc-task-line-system');
    // A certificate failure: the plain words, why it cannot be skipped for one download, and the browser as the way out.
    await p.goto(base + '#/task/g2'); await p.waitForSelector('.task-error', { timeout: 4000 }).catch(() => undefined);
    const err = await p.$eval('.task-error', (e) => e.innerText).catch(() => '');
    check(`${shell}: a certificate failure in plain words, no way round it but the browser`, /certificate could not be verified|تعذّر التحقّق من شهادة/.test(err) && /cannot skip|لا يقدر/.test(err) && !!(await p.$('[data-act="cert-browser"]')) && !(await p.$('[data-act="ignore-cert"]')) && !/SSL\/TLS handshake/.test(err), err);
    if (shell === 'electron') await shot(p.locator('.task-error'), 'pc-cert-error');
    await p.goto(base + '#/task/g3'); await p.waitForSelector('.task-error', { timeout: 4000 }).catch(() => undefined);
    const blk = await p.$eval('.task-error', (e) => e.innerText).catch(() => '');
    check(`${shell}: blocked by the chosen resolver — said with its name, no raw text`, /AdGuard/.test(blk) && /blocked|يحجبه/.test(blk) && !/DNS over HTTPS: ads\.test/.test(blk), blk);
    await ctx.close();
  }
  await br.close(); web.close();
  const bad = errors.length; if (bad) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
