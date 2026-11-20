// UI hunt: opens every main view (and the common sheets) at phone 412x915 and PC 1280x800, in English and Arabic, and
// looks for the small layout faults the owner keeps finding by hand: page overflow, clipped text, a hint glued to its
// label, controls touching, small touch targets, unequal buttons in a row, native checkboxes / spinners, banned
// colours (yellow / amber / gold / orange), Eastern digits, LTR-pinned titles in RTL.
// Run: NODE_PATH=$(npm root -g) node tests/uihunt.cjs [en|ar] [--only <view>] [--list]   (KT_SHOTS=<dir>: a shot per view)
// A fault left on purpose goes in ALLOW below with its reason. Made-up data only (no real sites).
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const LANGS = args.includes('ar') ? ['ar'] : args.includes('en') ? ['en'] : ['en', 'ar'];
const oi = args.indexOf('--only'); const ONLY = oi >= 0 ? args[oi + 1] : '';
const DIST = path.resolve(__dirname, '../dist'); const PORT = 5493;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f)); });

const SETTINGS = ['general', 'connection', 'downloads', 'addons', 'apps', 'updates', 'about', 'episodes', 'sublangs', 'privacy', 'backup', 'archives', 'video', 'player', 'playerprefs', 'sounds', 'antivirus', 'models', 'storage'];
const VIEWS = [
  ['downloads', '#/'], ['search', '#/search'], ['addons', '#/addons'], ['anime', '#/anime'], ['subs', '#/subs'], ['tv', '#/tv'], ['videos', '#/videos'],
  ['files', '#/files'], ['screen', '#/screen'], ['battery', '#/battery'], ['add', '#/add'],
  ...SETTINGS.map((s) => ['settings-' + s, '#/settings/' + s]),
  ['fab-menu', '#/', async (p) => { await p.click('.fab, .rail-fab'); await p.waitForSelector('.fab-menu', { timeout: 4000 }); }],
];

// kind|view|selector-ish key  -> reason. A key is `${kind} ${view} ${what}` prefix-matched (view without the device).
const ALLOW = [
  // ['glued settings-about .x', 'reason'],
];
const allowed = (key) => ALLOW.some(([k]) => key.startsWith(k));

/** Runs in the page: returns a list of { kind, what } faults. */
function hunt({ phone, rtl }) {
  const out = []; const vw = document.documentElement.clientWidth; const vh = innerHeight;
  const desc = (e) => { let s = e.tagName.toLowerCase(); if (e.id) s += '#' + e.id; const c = [...e.classList].slice(0, 2).join('.'); if (c) s += '.' + c; const tx = (e.textContent || '').trim().replace(/\s+/g, " ").slice(0, 70); if (e.tagName === 'INPUT') s += `[${e.type}]<${e.parentElement ? e.parentElement.tagName.toLowerCase() + '.' + [...e.parentElement.classList].join('.') : ''}`; return s + (tx ? ` «${tx}»` : ''); };
  const vis = (e) => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false; for (let a = e; a; a = a.parentElement) { if (a.hidden || getComputedStyle(a).display === 'none') return false; } return true; };
  const add = (kind, e, extra) => out.push({ kind, what: desc(e) + (extra ? ' ' + extra : '') });
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1 || document.body.scrollWidth > root.clientWidth + 1) out.push({ kind: 'overflow', what: `page ${Math.max(root.scrollWidth, document.body.scrollWidth)} > ${root.clientWidth}` });
  const all = [...document.body.querySelectorAll('*')].filter(vis);
  // Clipped on purpose (scrollers, sliders, marquees) is not a fault: look at the scroll ancestors.
  const inScroller = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a); if (/(auto|scroll)/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1) return true; if (cs.overflowX === 'hidden' && a.getBoundingClientRect().width < e.getBoundingClientRect().width - 1) return false; } return false; };
  for (const e of all) {
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    if (cs.position !== 'fixed' && !inScroller(e) && (r.right > vw + 2 || r.left < -2) && !e.closest('.scrim, .sheet-scrim, [aria-hidden=true], svg, .marquee')) add('stick-out', e, `${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
    // text clipped without an ellipsis
    if (['BUTTON', 'LABEL', 'SPAN', 'A', 'H1', 'H2', 'H3', 'SMALL', 'DIV'].includes(e.tagName) && !e.children.length && (e.textContent || '').trim() && /(hidden|clip)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && !e.closest('.mid, .files-name')) add('clipped', e, `${e.scrollWidth}>${e.clientWidth}`);
    // colours
    for (const prop of ['color', 'backgroundColor', 'borderTopColor']) {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(cs[prop] || ''); if (!m) continue; if (m[4] !== undefined && +m[4] < 0.3) continue;
      const rr = +m[1] / 255, g = +m[2] / 255, b = +m[3] / 255; const mx = Math.max(rr, g, b), mn = Math.min(rr, g, b), d = mx - mn; if (!d) continue;
      let hh = mx === rr ? ((g - b) / d) % 6 : mx === g ? (b - rr) / d + 2 : (rr - g) / d + 4; hh = (hh * 60 + 360) % 360; const l = (mx + mn) / 2; const s = d / (1 - Math.abs(2 * l - 1));
      if (hh >= 25 && hh <= 65 && s > 0.4 && l > 0.12 && l < 0.92 && (prop !== 'borderTopColor' || parseFloat(cs.borderTopWidth) > 0)) add('colour', e, `${prop} ${cs[prop]}`);
    }
    // native checkbox / select / number spinners visible
    if (e.tagName === 'INPUT' && e.type === 'checkbox' && cs.appearance !== 'none' && cs.webkitAppearance !== 'none' && !e.closest('.sr-only')) add('native-checkbox', e);
    if (e.tagName === 'INPUT' && e.type === 'number' && cs.appearance !== 'textfield' && cs.webkitAppearance !== 'textfield') add('native-spinner', e);
    // Eastern digits / pinned LTR titles
    if (!e.children.length && /[٠-٩۰-۹]/.test(e.textContent || '')) add('eastern-digits', e);
    if (rtl && /^(H1|H2|H3)$/.test(e.tagName) && cs.direction === 'ltr' && /[؀-ۿ]/.test(e.textContent || '')) add('ltr-title-in-rtl', e);
  }
  // glued: a label-ish text node/element directly followed by an inline small/span hint with no space
  for (const sm of all.filter((x) => (x.tagName === 'SMALL' || x.classList.contains('hint') || x.classList.contains('sub')) && x.parentElement)) {
    const prev = sm.previousSibling; if (!prev) continue; if (getComputedStyle(sm).display !== 'inline') continue;
    const pt = prev.nodeType === 3 ? prev.textContent : prev.textContent || ''; if (!pt.trim()) continue; if (/\s$/.test(pt) && prev.nodeType === 3) continue;
    const pr = prev.nodeType === 1 ? getComputedStyle(prev).display : 'inline'; if (pr !== 'inline') continue;
    // inline both and no break: they sit on one line
    const a = document.createRange(); a.selectNodeContents(prev); const ar = a.getBoundingClientRect(); const sr = sm.getBoundingClientRect(); if (Math.abs(ar.bottom - sr.bottom) < 6 || (sr.top < ar.bottom - 2)) add('glued', sm, `after «${pt.trim().slice(0, 20)}»`);
  }
  // controls
  const ctl = all.filter((e) => /^(BUTTON|A|SELECT|INPUT|TEXTAREA)$/.test(e.tagName) && !(e.tagName === 'INPUT' && e.type === 'hidden') && !e.closest('svg') && !(e.tagName === 'INPUT' && e.type === 'checkbox' && getComputedStyle(e).opacity === '0'));
  if (phone) for (const e of ctl) { if (e.classList.contains('dc-dot') || (e.tagName === 'INPUT' && e.type === 'checkbox' && e.closest('label'))) continue; if (e.tagName === 'A' && !e.classList.length && e.closest('p, small, li:not(.row)')) continue; const r = e.getBoundingClientRect(); if ((r.height < 40 || r.width < 40) && !(e.tagName === 'A' && e.closest('p, small'))) add('small-target', e, `${Math.round(r.width)}x${Math.round(r.height)}`); }
  const rows = new Map(); for (const e of ctl) { if (e.tagName === 'INPUT' && e.type === 'checkbox') continue; const p = e.parentElement; if (!p) continue; (rows.get(p) || rows.set(p, []).get(p)).push(e); }
  for (const [p, es] of rows) {
    const bs = es.map((e) => ({ e, r: e.getBoundingClientRect() }));
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i].r, b = bs[j].r; if (Math.abs(a.top - b.top) > 8 && Math.abs(a.bottom - b.bottom) > 8) continue; // not the same line
      const gap = Math.max(b.left - a.right, a.left - b.right); const ov = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const icons = bs[i].e.classList.contains('icon-btn') && bs[j].e.classList.contains('icon-btn'); if (ov > 4 && gap < (icons ? 1 : 4)) add("touching", bs[j].e, `in ${p.tagName.toLowerCase()}.${[...p.classList].join(".")} with ${desc(bs[i].e)} gap ${Math.round(gap)}`);
    }
    const btns = es.filter((e) => e.tagName === 'BUTTON' && e.textContent.trim() && !e.closest('.chips, .chip-row, .folder-chips, .settings-tabs, [role=tablist], .seg, .bottom-nav, .nav-rail'));
    if (btns.length >= 2 && btns.length === es.length && /actions|btns|row|buttons/.test(p.className + ' ')) {
      const rs = btns.map((e) => e.getBoundingClientRect()); const sameLine = rs.every((r) => Math.abs(r.top - rs[0].top) < 8);
      if (sameLine) { const w = rs.map((r) => Math.round(r.width)); if (Math.max(...w) - Math.min(...w) > 3) add('unequal-buttons', p, w.join('/')); }
    }
  }
  return out;
}

(async () => {
  if (args.includes('--list')) { console.log(VIEWS.map((v) => v[0]).join(' ')); process.exit(0); }
  await new Promise((r) => server.listen(PORT, r));
  const b = await chromium.launch(); let fails = 0; let allowedN = 0; const summary = {};
  for (const lang of LANGS) for (const dev of ['phone', 'pc']) {
    // (The phone page shows every settings card at once; the computer shows one section at a time.)
    const VIEWS_HERE = VIEWS.filter(([n]) => !n.startsWith('settings-') || dev === 'pc').map((v) => (v[0] === 'settings-general' || dev === 'pc' ? v : v)); if (dev === 'phone') VIEWS_HERE.push(['settings', '#/settings/general']);
    const phone = dev === 'phone';
    const ctx = await b.newContext(phone ? { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, locale: lang } : { viewport: { width: 1280, height: 800 }, locale: lang });
    await ctx.route((u) => !/^https?:\/\/localhost[:/]/.test(u.href), (r) => r.abort()); // offline: nothing leaves the machine
    const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`http://localhost:${PORT}/`); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); }, lang); await p.reload(); await p.waitForSelector('.downloads-view, .view', { timeout: 15000 }); await p.waitForTimeout(400);
    for (const [name, hash, act] of VIEWS_HERE) {
      if (ONLY && name !== ONLY) continue;
      if (!phone && name === 'battery') { /* PC has it too */ }
      try {
        await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(700);
        if (act) await act(p); await p.waitForTimeout(250);
        // Open every folded card of a settings view so its rows are measured too.
        if (name.startsWith('settings-')) await p.evaluate(() => document.querySelectorAll('.settings-view .card.folded, .settings-view .card:not(.open)').forEach((c) => c.querySelector('.card-title, h3')?.click()));
        await p.waitForTimeout(150);
        const faults = await p.evaluate(hunt, { phone, rtl: lang === 'ar' });
        const seen = new Set();
        for (const f of faults) {
          const key = `${f.kind} ${name} ${f.what.replace(/ «.*$/, '')}`; const line = `${lang} ${dev} ${name}: ${f.kind}: ${f.what}`;
          if (seen.has(line)) continue; seen.add(line);
          if (allowed(`${f.kind} ${name} ${f.what.split(' ')[0]}`) || allowed(`${f.kind} ${name}`)) { allowedN++; continue; }
          console.log('FAULT ' + line); fails++; summary[f.kind] = (summary[f.kind] || 0) + 1;
        }
        if (process.env.KT_SHOTS) await p.screenshot({ path: path.join(process.env.KT_SHOTS, `hunt-${name}-${dev}-${lang}.png`) });
      } catch (e) { console.log(`ERR   ${lang} ${dev} ${name}: ${String(e.message).split('\n')[0]}`); fails++; }
    }
    await ctx.close();
  }
  console.log(fails ? `${fails} FAULTS ${JSON.stringify(summary)} (allowed ${allowedN})` : `all passed (allowed ${allowedN})`);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
