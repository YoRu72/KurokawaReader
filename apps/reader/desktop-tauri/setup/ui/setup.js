// KurokawaReader Setup — the page of the setup program (../src-tauri: a frameless Tauri window that runs R6b's tested
// NSIS installer silently underneath with the choices made here).
//
// ── The page ⇄ Rust contract ───────────────────────────────────────────────────────────────────────────────────────
// Five calls (plus three for the window's own title bar). In the setup program they are Tauri commands (main.rs);
// in a plain browser — no window.__TAURI_INTERNALS__ — the FAKE below answers them, so the page can be run and tested
// anywhere (tests/setupui.cjs).
//
//   detect() → {
//     version:    '0.72.0'                       the version this setup installs
//     lang:       'en' | 'ar' | 'ja' | 'ko' | 'zh' | ''   Windows' display language ('' = unknown)
//     dark:       boolean                        Windows' app mode
//     defaultDir: 'C:\\Users\\…\\AppData\\Local\\KurokawaReader'
//     existing:   { kind: 'none' | 'rust' | 'electron', version?: '0.71.0', dir?: '…', desktop: boolean, old: 'keep' | 'replace' | '' }
//                 (`old`: the Electron copy's fate, found on its own — also beside an installed copy of this build)
//                 an installed copy: this build's (rust — updated where it is) or the Electron build (replaced; its
//                 library kept); `desktop`: whether it has a desktop shortcut now
//     inner:      boolean                        whether the NSIS installer is there (embedded) — false: install fails
//   }
//   browseFolder(current) → '…\\KurokawaReader' | null      a native folder dialog; the product's folder name added
//   install({ dir, desktop, assoc, runAfter, update }, onProgress) → result
//                 runs the NSIS installer silently (/S /KRDESK= /KRASSOC= /D=dir); onProgress(p) is called with each
//                 step as it really happens — p = { phase: 'extract' | 'install' | 'shortcuts' | 'done', pct: 0…100 } —
//                 and the promise ends with the last p, which also has { done: true, ok, code?, reason?, detail?, dir }.
//                 reason: 'code' | 'cancelled' | 'aborted' | 'extract' | 'missing' | 'start' | 'folder'
//   openApp()  → starts the installed KurokawaReader
//   openOld()  → starts the earlier (Electron) KurokawaReader, where it was kept beside this one (existing.old 'keep':
//                its library not handed over yet — it carries it over once opened and updated)
//   classic()  → starts the NSIS installer with its own one-page window, and closes the setup
//   close()    → closes the setup (while installing: the install still finishes, then the program ends)
//   window:    minimize(), drag() (a press on the title bar's free space), ready() (the page has painted: show the
//              window, where it was not shown already in its colour)
// Before the page runs, main.rs sets window.__SETUP_BOOT__ = { lang, dark, options, auto } (Windows' language and
// app mode; CI's --options and --auto switches).
// In Rust: setup_detect, setup_browse {current}, setup_install {options}, setup_progress (polled every 120 ms until
// done — no event permissions needed), setup_open_app, setup_classic, setup_close, setup_window {act}.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
'use strict';
(function () {
  const WORDS = window.SETUP_WORDS;
  const LANGS = window.SETUP_LANGS;
  const root = document.documentElement;
  const app = document.getElementById('app');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- The two implementations of the contract ----------
  function realApi(invoke) {
    return {
      detect: () => invoke('setup_detect'),
      browseFolder: (current) => invoke('setup_browse', { current }),
      install: async (options, onProgress) => {
        await invoke('setup_install', { options });
        for (;;) {
          const p = await invoke('setup_progress');
          onProgress(p);
          if (p && p.done) return p;
          await sleep(120);
        }
      },
      openApp: () => invoke('setup_open_app'),
      openOld: () => invoke('setup_open_old'),
      classic: () => invoke('setup_classic'),
      close: () => invoke('setup_close'),
      minimize: () => invoke('setup_window', { act: 'minimize' }),
      drag: () => invoke('setup_window', { act: 'drag' }),
      ready: () => invoke('setup_window', { act: 'show' }),
    };
  }

  /** The fake: window.__SETUP_FAKE__ (set before the page loads) or the address's ?query, e.g.
   *  ?lang=ar&dark=1&existing=rust&fail=aborted&hold=install:46 — every call recorded in window.__setupLog. */
  function fakeApi() {
    const q = new URLSearchParams(location.search);
    const c = Object.assign({}, window.__SETUP_FAKE__ || {});
    for (const [k, v] of q) if (!(k in c)) c[k] = v;
    const log = (window.__setupLog = window.__setupLog || []);
    let fails = c.fail ? Number(c.failTimes || 1) : 0;
    const existing = c.existing === 'rust' ? { kind: 'rust', version: c.from || '0.71.0', dir: 'C:\\Users\\Hana\\AppData\\Local\\KurokawaReader', desktop: c.desktop !== '0' && c.desktop !== false }
      : c.existing === 'electron' ? { kind: 'electron', version: c.from || '0.70.2', dir: 'C:\\Users\\Hana\\AppData\\Local\\Programs\\KurokawaReader', desktop: true, old: c.old || 'replace' }
        : { kind: 'none', desktop: false };
    const speed = Number(c.speed || 1);
    return {
      detect: async () => {
        log.push(['detect']);
        return {
          version: c.version || '0.72.0',
          lang: c.lang || '',
          dark: c.dark === undefined ? null : c.dark === true || c.dark === '1',
          defaultDir: 'C:\\Users\\Hana\\AppData\\Local\\KurokawaReader',
          existing,
          inner: c.inner !== '0',
        };
      },
      browseFolder: async (current) => { log.push(['browseFolder', current]); return c.browseTo === 'cancel' ? null : (c.browseTo || 'D:\\Apps\\KurokawaReader'); },
      install: async (options, onProgress) => {
        log.push(['install', JSON.parse(JSON.stringify(options))]);
        const hold = c.hold ? String(c.hold).split(':') : null;
        const steps = [['extract', 4], ['extract', 9], ['install', 18], ['install', 34], ['install', 46], ['install', 61], ['install', 77], ['shortcuts', 86], ['shortcuts', 94], ['done', 100]];
        const failNow = fails > 0; if (failNow) fails--;
        for (const [phase, pct] of steps) {
          if (failNow && pct > 50) {
            const r = { phase: 'install', pct, done: true, ok: false, reason: c.fail === true ? 'aborted' : String(c.fail), code: c.fail === 'code' ? 5 : c.fail === 'cancelled' ? 1 : 2, detail: c.fail === 'extract' ? 'disk full' : '', dir: options.dir };
            onProgress(r); return r;
          }
          const p = { phase, pct };
          onProgress(p);
          if (hold && hold[0] === phase && Number(hold[1]) === pct) await new Promise(() => {});
          await sleep((phase === 'install' ? 260 : 180) / speed);
        }
        const r = { phase: 'done', pct: 100, done: true, ok: true, code: 0, dir: options.dir };
        onProgress(r);
        return r;
      },
      openApp: async () => { log.push(['openApp']); },
      openOld: async () => { log.push(['openOld']); },
      classic: async () => { log.push(['classic']); },
      close: async () => { log.push(['close']); },
      minimize: async () => { log.push(['minimize']); },
      drag: async () => { log.push(['drag']); },
      ready: async () => { log.push(['ready']); },
    };
  }

  const tauri = window.__TAURI_INTERNALS__;
  const api = tauri && typeof tauri.invoke === 'function' ? realApi((cmd, args) => tauri.invoke(cmd, args || {})) : fakeApi();
  window.__setupApi = api;

  // ---------- State ----------
  const S = {
    view: 'welcome', // welcome | installing | done | failed
    lang: 'en',
    info: null,
    opts: { dir: '', desktop: true, assoc: true, runAfter: true },
    optsOpen: false,
    prog: { phase: 'extract', pct: 0 },
    result: null,
    opening: false,
    asking: false,
    menu: false,
  };
  const w = (k, vars) => {
    let s = (WORDS[S.lang] && WORDS[S.lang][k]) ?? WORDS.en[k] ?? k;
    if (vars) for (const [n, v] of Object.entries(vars)) s = s.split(`{${n}}`).join(String(v));
    return s;
  };
  const num = (n) => new Intl.NumberFormat(S.lang === 'ar' ? 'ar-EG' : S.lang, { style: 'percent', maximumFractionDigits: 0 }).format(n / 100);
  /** A version or path put in a sentence: kept left to right inside right-to-left words. */
  const iso = (s) => `\u2068${s}\u2069`;
  /** A path that wraps only after its backslashes. */
  const breakable = (p) => String(p || '').replace(/\\/g, '\\\u200b');
  /** A long path shortened in its middle: «C:\Users\Hana\…\KurokawaReader». */
  const shortPath = (p) => {
    const s = String(p || ''); if (s.length <= 44) return s;
    const parts = s.split('\\'); if (parts.length < 5) return s;
    return [...parts.slice(0, 3), '…', parts[parts.length - 1]].join('\\');
  };
  const kind = () => (S.info && S.info.existing && S.info.existing.kind) || 'none';
  const cmpVer = (a, b) => {
    const p = (v) => String(v || '').split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    const x = p(a), y = p(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const m = x[i] ?? 0, n = y[i] ?? 0;
      if (m === n) continue;
      if (typeof m === 'number' && typeof n === 'number') return m < n ? -1 : 1;
      return String(m) < String(n) ? -1 : 1;
    }
    return 0;
  };
  /** 'install' | 'update' | 'reinstall' | 'downgrade' */
  const mode = () => {
    const e = S.info && S.info.existing;
    if (!e || e.kind === 'none') return 'install';
    // (An Electron copy whose library was not handed over yet stays beside this one: a new install, not an update.)
    if (e.kind === 'electron') return e.old === 'keep' ? 'install' : 'update';
    const c = cmpVer(e.version, S.info.version);
    return c < 0 ? 'update' : c === 0 ? 'reinstall' : 'downgrade';
  };

  // ---------- Building the window ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z"/>',
    check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
    bang: '<path d="M12 6v7.5M12 17.6v.1"/>',
    chevron: '<path d="M6 9.5l6 6 6-6"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
    library: '<path d="M4 5.5C6.5 4.5 9 4.6 12 6.4v13c-3-1.8-5.5-1.9-8-.9z"/><path d="M20 5.5c-2.5-1-5-.9-8 .9v13c3-1.8 5.5-1.9 8-.9z"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L13 18a2.1 2.1 0 0 1-3-3l6.5-6.5M14.5 6.5L17 4"/>',
  };
  // (The «data kept» tile's picture: the app's own, from its words.js — window.SETUP_APP.keptIcon, an SVG path in the
  // 24×24 box —, else the library's.)
  ICONS.kept = (window.SETUP_APP && window.SETUP_APP.keptIcon) || ICONS.library;
  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    s.innerHTML = ICONS[name]; return s;
  }
  function glyph(d) {
    const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = d; return s;
  }
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  }
  const t = (key, tag = 'span', attrs) => h(tag, Object.assign({ 'data-w': key }, attrs || {}));

  // The title bar.
  const langCur = h('span', { class: 'lang-cur' });
  const langBtn = h('button', { type: 'button', class: 'lang-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', id: 'lang-btn' }, icon('globe'), langCur);
  const langMenu = h('ul', { class: 'lang-menu', role: 'listbox', hidden: true, id: 'lang-menu', tabindex: '-1' });
  for (const l of LANGS) langMenu.append(h('li', { role: 'option', 'data-lang': l, lang: l, dir: l === 'ar' ? 'rtl' : 'ltr', id: `lang-${l}` }, h('span', null, WORDS[l].langName), icon('check')));
  const bMin = h('button', { type: 'button', class: 'wb wb-min' }, glyph('<path d="M2 6.5h8"/>'));
  const bClose = h('button', { type: 'button', class: 'wb wb-close' }, glyph('<path d="M2.25 2.25l7.5 7.5M9.75 2.25l-7.5 7.5"/>'));
  const barTitle = h('div', { class: 'bar-title' }, h('img', { src: 'icon.svg', alt: '' }), t('winTitle'));
  const bar = h('header', { class: 'bar' }, barTitle, h('div', { class: 'bar-end' }, langBtn, bMin, bClose), langMenu);

  // The hero.
  const verChip = h('span', { class: 'chip ltr' });
  const hero = h('section', { class: 'hero', 'aria-hidden': 'true' },
    h('div', { class: 'badge' }, h('div', { class: 'blob' }), h('img', { src: 'icon.svg', alt: '' }), h('span', { class: 'mark ok' }, icon('check')), h('span', { class: 'mark bad' }, icon('bang'))),
    h('h1', { class: 'name' }, 'KurokawaReader'), t('tagline', 'p', { class: 'tag' }), verChip);

  // Welcome.
  const wTitle = h('h2', { class: 'title', id: 'title-welcome' });
  const lead = t('lead', 'p', { class: 'lead' });
  const tileLine = h('p', { class: 'tile-line' });
  const tile = h('div', { class: 'tile', hidden: true }, h('span', { class: 'tile-ic' }, icon('kept')), h('div', null, t('kept', 'b'), tileLine));
  // (What will happen, at a glance — the folder and the options on; a press opens the options.)
  const sumPath = h('span', { class: 'sum-path ltr' });
  const sumChips = h('span', { class: 'sum-chips' });
  const summary = h('button', { type: 'button', class: 'summary', id: 'summary', 'aria-controls': 'opts' }, h('span', { class: 'sum-ic' }, icon('folder')), h('span', { class: 'sum-text' }, sumPath, sumChips));
  const collapse = h('div', { class: 'collapse' }, h('div', null, lead, tile, summary));
  const pathOut = h('output', { class: 'path ltr', id: 'path', 'aria-labelledby': 'folder-label path' });
  const browseBtn = h('button', { type: 'button', class: 'browse' }, t('browse'));
  const inPlace = t('inPlace', 'p', { class: 'inplace', hidden: true });
  const sw = (key, sub, id) => {
    const input = h('input', { type: 'checkbox', role: 'switch', id });
    const row = h('label', { class: 'sw-row', for: id }, h('span', { class: 'sw-text' }, t(key, 'b'), sub ? t(sub, 'small') : null), h('span', { class: 'switch' }, input, h('i')));
    return { row, input };
  };
  const swDesk = sw('desktop', null, 'opt-desktop');
  const swAssoc = sw('assoc', 'assocSub', 'opt-assoc');
  const swRun = sw('runAfter', null, 'opt-run');
  const optsBox = h('div', { class: 'opts', id: 'opts', role: 'group', 'aria-labelledby': 'opt-btn' },
    h('div', null, h('div', { class: 'opts-in' },
      t('folder', 'div', { class: 'field-label', id: 'folder-label' }),
      h('div', { class: 'folder' }, icon('folder'), pathOut, browseBtn),
      inPlace, swDesk.row, swAssoc.row, swRun.row)));
  const optBtn = h('button', { type: 'button', class: 'btn text', id: 'opt-btn', 'aria-expanded': 'false', 'aria-controls': 'opts' }, icon('chevron'), t('options'));
  const goLabel = h('span');
  const goIcon = h('span', { style: 'display:contents' });
  const goBtn = h('button', { type: 'button', class: 'btn primary big go', id: 'go' }, goIcon, goLabel);
  const vWelcome = h('div', { class: 'view v-welcome' }, wTitle, collapse, optsBox, h('div', { class: 'actions' }, optBtn, goBtn));

  // Installing.
  const iTitle = h('h2', { class: 'title', id: 'title-installing', tabindex: '-1' });
  const nowLine = h('p', { class: 'now', 'aria-live': 'polite' });
  const waveI = h('i');
  const wave = h('div', { class: 'wave', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, waveI);
  const pct = h('span', { class: 'pct', 'aria-hidden': 'true' });
  const PHASES = ['extract', 'install', 'shortcuts', 'done'];
  const stepEls = PHASES.map((p) => h('li', { 'data-phase': p }, h('span', { class: 'dot' }, icon('check')), t({ extract: 'stExtract', install: 'stInstall', shortcuts: 'stShortcuts', done: 'stDone' }[p])));
  const vInstalling = h('div', { class: 'view v-installing' }, iTitle, nowLine, h('div', { class: 'meter' }, wave, pct), h('ol', { class: 'steps' }, ...stepEls));

  // Done.
  const dLead = h('p', { class: 'lead', 'aria-live': 'polite' });
  const dWhere = h('p', { class: 'where ltr' });
  const openBtn = h('button', { type: 'button', class: 'btn primary big', id: 'open' }, icon('open'), t('open'));
  const closeBtn = h('button', { type: 'button', class: 'btn outlined', id: 'close-done' }, t('close'));
  // (The earlier KurokawaReader kept beside this one — its library not handed over yet —: what to do, and a button.)
  const dOld = h('p', { class: 'lead old-note', id: 'old-note', hidden: true });
  const oldBtn = h('button', { type: 'button', class: 'btn outlined', id: 'open-old', hidden: true }, t('openOld'));
  const vDone = h('div', { class: 'view v-done' }, t('doneTitle', 'h2', { class: 'title', id: 'title-done' }), dLead, dWhere, dOld, h('div', { class: 'grow' }), h('div', { class: 'actions' }, closeBtn, oldBtn, openBtn));

  // Failed.
  const reason = h('p', { class: 'reason', role: 'alert' });
  const classicBtn = h('button', { type: 'button', class: 'btn text', id: 'classic' }, t('classic'));
  const retryBtn = h('button', { type: 'button', class: 'btn primary big', id: 'retry' }, icon('refresh'), t('retry'));
  const vFailed = h('div', { class: 'view v-failed' }, t('failTitle', 'h2', { class: 'title', id: 'title-failed' }), reason, h('div', { class: 'grow' }), h('div', { class: 'actions' }, classicBtn, retryBtn));

  const panel = h('section', { class: 'panel' }, vWelcome, vInstalling, vDone, vFailed);
  const stage = h('main', { class: 'stage' }, hero, panel);

  // The question on closing while installing.
  const scrim = h('div', { class: 'scrim', hidden: true });
  const stayBtn = h('button', { type: 'button', class: 'btn primary', id: 'stay' }, t('stay'));
  const leaveBtn = h('button', { type: 'button', class: 'btn outlined', id: 'leave' }, t('leave'));
  const confirm = h('div', { class: 'confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'stay-t', 'aria-describedby': 'stay-b', hidden: true },
    t('stayTitle', 'h3', { id: 'stay-t' }), t('stayBody', 'p', { id: 'stay-b' }), h('div', { class: 'actions' }, leaveBtn, stayBtn));

  app.append(bar, stage, scrim, confirm);

  // ---------- Painting ----------
  function paintWords() {
    root.lang = S.lang;
    root.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
    document.title = w('winTitle');
    for (const el of document.querySelectorAll('[data-w]')) el.textContent = w(el.getAttribute('data-w'));
    langCur.textContent = WORDS[S.lang].langName;
    langBtn.setAttribute('aria-label', `${w('language')}: ${WORDS[S.lang].langName}`);
    langMenu.setAttribute('aria-label', w('language'));
    for (const li of langMenu.children) li.setAttribute('aria-selected', String(li.getAttribute('data-lang') === S.lang));
    bMin.setAttribute('aria-label', w('minimize')); bMin.title = w('minimize');
    bClose.setAttribute('aria-label', w('close')); bClose.title = w('close');
    wave.setAttribute('aria-label', w('progressLabel'));
  }

  function paint() {
    paintWords();
    app.setAttribute('data-view', S.view);
    app.classList.toggle('opts-open', S.optsOpen);
    const info = S.info;
    const m = mode();
    const e = info && info.existing;
    if (info) verChip.textContent = `v${info.version}`;
    // Welcome.
    wTitle.textContent = w(m === 'install' ? 'readyInstall' : m === 'reinstall' ? 'readyReinstall' : 'readyUpdate');
    goLabel.textContent = w(m === 'install' ? 'install' : m === 'update' ? 'update' : m === 'reinstall' ? 'reinstall' : 'install');
    goIcon.replaceChildren(icon(m === 'install' ? 'download' : 'refresh'));
    tile.hidden = !e || e.kind === 'none';
    if (e && e.kind !== 'none') {
      const line = e.kind === 'electron' ? w(e.old === 'keep' ? 'electronKeepLine' : 'electronLine')
        : m === 'update' ? w('updateLine', { from: iso(e.version), to: iso(info.version) })
          : m === 'reinstall' ? w('sameLine', { v: iso(e.version) })
            : w('newerLine', { from: iso(e.version), to: iso(info.version) });
      tileLine.textContent = `${line} ${w('keptSub')}`;
    }
    // (A copy of this build is updated where it is: its folder shown, not chosen.)
    const locked = !!e && e.kind === 'rust';
    pathOut.textContent = breakable(S.opts.dir); pathOut.title = S.opts.dir;
    sumPath.textContent = shortPath(S.opts.dir); summary.title = S.opts.dir;
    sumChips.replaceChildren(...[['desktop', 'desktop'], ['assoc', 'assoc'], ['runAfter', 'runAfter']].filter(([k]) => S.opts[k]).map(([, key]) => h('span', { class: 'mini' }, icon('check'), w(key === 'assoc' ? 'assocShort' : key))));
    summary.setAttribute('aria-label', `${w('folder')}: ${S.opts.dir}. ${w('options')}`);
    browseBtn.disabled = locked; inPlace.hidden = !locked;
    swDesk.input.checked = S.opts.desktop; swAssoc.input.checked = S.opts.assoc; swRun.input.checked = S.opts.runAfter;
    optBtn.setAttribute('aria-expanded', String(S.optsOpen));
    optsBox.classList.toggle('shown', S.optsOpen);
    // Installing.
    iTitle.textContent = w(m === 'install' ? 'installing' : 'updating');
    paintProgress();
    // Done.
    if (S.result) {
      dLead.textContent = S.opening ? w('opening') : m === 'install' ? w('nowDone') : w('doneUpdated', { v: iso(info.version) });
      dWhere.textContent = S.result.dir || S.opts.dir;
      const keep = !!e && e.old === 'keep';
      dOld.hidden = !keep; oldBtn.hidden = !keep; if (keep) dOld.textContent = w('oldKeepDone');
      reason.textContent = failText(S.result);
    }
    // The question.
    scrim.hidden = !S.asking; confirm.hidden = !S.asking;
  }

  function paintProgress() {
    const p = S.prog;
    const at = Math.max(0, PHASES.indexOf(p.phase));
    const v = Math.max(0, Math.min(100, Math.round(p.pct || 0)));
    wave.style.setProperty('--p', `${v}%`);
    wave.classList.toggle('full', v >= 100);
    wave.setAttribute('aria-valuenow', String(v));
    wave.setAttribute('aria-valuetext', `${num(v)} — ${w({ extract: 'nowExtract', install: 'nowInstall', shortcuts: 'nowShortcuts', done: 'nowDone' }[p.phase] || 'nowExtract')}`);
    pct.textContent = num(v);
    nowLine.textContent = w({ extract: 'nowExtract', install: 'nowInstall', shortcuts: 'nowShortcuts', done: 'nowDone' }[p.phase] || 'nowExtract');
    stepEls.forEach((li, i) => {
      const past = i < at || (p.phase === 'done' && i === at);
      li.classList.toggle('past', past);
      li.classList.toggle('now-step', i === at && !past);
      if (i === at && !past) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }

  function failText(r) {
    if (!r || r.ok) return '';
    switch (r.reason) {
      case 'cancelled': return w('whyCancelled');
      case 'aborted': return w('whyAborted');
      case 'extract': return w('whyExtract', { why: r.detail || '—' });
      case 'missing': return w('whyMissing');
      case 'start': return w('whyStart', { why: r.detail || '—' });
      case 'folder': return w('whyFolder');
      default: return w('whyCode', { code: r.code ?? '?' });
    }
  }

  // ---------- Actions ----------
  const focusFirst = () => {
    const el = S.view === 'welcome' ? goBtn : S.view === 'done' ? openBtn : S.view === 'failed' ? retryBtn : null;
    if (el) requestAnimationFrame(() => el.focus());
    else requestAnimationFrame(() => iTitle.focus());
  };
  function go(view) { S.view = view; paint(); focusFirst(); }

  let running = false;
  async function install() {
    if (running || !S.info) return;
    running = true; S.result = null; S.opening = false; S.optsOpen = false;
    S.prog = { phase: 'extract', pct: 0 };
    go('installing');
    const options = { dir: S.opts.dir, desktop: S.opts.desktop, assoc: S.opts.assoc, runAfter: S.opts.runAfter, update: mode() !== 'install' };
    let r;
    try {
      r = await api.install(options, (p) => {
        if (!p) return;
        // (Never backwards: a later poll can only move it on.)
        const at = PHASES.indexOf(p.phase), was = PHASES.indexOf(S.prog.phase);
        if (at > was || (at === was && (p.pct || 0) >= (S.prog.pct || 0))) S.prog = { phase: p.phase, pct: p.pct || 0 };
        paintProgress();
      });
    } catch (err) {
      r = { done: true, ok: false, reason: 'start', detail: String((err && err.message) || err) };
    }
    S.result = r;
    running = false;
    if (S.asking) { S.asking = false; }
    if (r && r.ok) {
      S.prog = { phase: 'done', pct: 100 }; paintProgress();
      await sleep(420);
      if (S.opts.runAfter) {
        S.opening = true; go('done');
        try { await api.openApp(); } catch { /* the button stays */ }
        await sleep(1400);
        if (leaving) return;
        // (The earlier copy kept — its library not handed over —: the window stays, so its note and button are read.)
        const e = S.info && S.info.existing;
        if (e && e.old === 'keep') { S.opening = false; paint(); return; }
        void api.close();
      } else go('done');
    } else go('failed');
  }
  let leaving = false;

  function askClose() {
    if (running) { S.asking = true; paint(); requestAnimationFrame(() => stayBtn.focus()); return; }
    leaving = true; void api.close();
  }

  // Title bar.
  bMin.addEventListener('click', () => void api.minimize());
  bClose.addEventListener('click', askClose);
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button, [role="listbox"]')) return;
    e.preventDefault(); void api.drag();
  });
  // Language menu.
  let menuAt = 0;
  const openMenu = (focus) => {
    S.menu = true; langMenu.hidden = false; langBtn.setAttribute('aria-expanded', 'true');
    menuAt = Math.max(0, LANGS.indexOf(S.lang)); markMenu(); if (focus) langMenu.focus();
  };
  const closeMenu = (back) => { S.menu = false; langMenu.hidden = true; langBtn.setAttribute('aria-expanded', 'false'); if (back) langBtn.focus(); };
  const markMenu = () => { [...langMenu.children].forEach((li, i) => li.classList.toggle('active', i === menuAt)); langMenu.setAttribute('aria-activedescendant', `lang-${LANGS[menuAt]}`); };
  const pickLang = (l) => { S.lang = l; try { localStorage.setItem('kr.setup.lang', l); } catch { /* none */ } closeMenu(true); paint(); };
  langBtn.addEventListener('click', () => (S.menu ? closeMenu(false) : openMenu(true)));
  langMenu.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) pickLang(li.getAttribute('data-lang')); });
  langMenu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { menuAt = (menuAt + 1) % LANGS.length; markMenu(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { menuAt = (menuAt + LANGS.length - 1) % LANGS.length; markMenu(); e.preventDefault(); }
    else if (e.key === 'Home') { menuAt = 0; markMenu(); e.preventDefault(); }
    else if (e.key === 'End') { menuAt = LANGS.length - 1; markMenu(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { pickLang(LANGS[menuAt]); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(e.key === 'Escape'); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } }
  });
  document.addEventListener('mousedown', (e) => { if (S.menu && !langMenu.contains(e.target) && !langBtn.contains(e.target)) closeMenu(false); });

  // Welcome.
  optBtn.addEventListener('click', () => { S.optsOpen = !S.optsOpen; paint(); });
  summary.addEventListener('click', () => { S.optsOpen = true; paint(); requestAnimationFrame(() => (browseBtn.disabled ? swDesk.input : browseBtn).focus()); });
  goBtn.addEventListener('click', () => void install());
  browseBtn.addEventListener('click', async () => {
    const p = await api.browseFolder(S.opts.dir).catch(() => null);
    if (p) { S.opts.dir = p; paint(); }
  });
  swDesk.input.addEventListener('change', () => { S.opts.desktop = swDesk.input.checked; });
  swAssoc.input.addEventListener('change', () => { S.opts.assoc = swAssoc.input.checked; });
  swRun.input.addEventListener('change', () => { S.opts.runAfter = swRun.input.checked; });
  // (A switch also answers Enter, as a checkbox does not by itself.)
  for (const s of [swDesk, swAssoc, swRun]) s.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); s.input.click(); } });
  // Done, failed, the question.
  openBtn.addEventListener('click', async () => { await api.openApp().catch(() => undefined); leaving = true; void api.close(); });
  oldBtn.addEventListener('click', async () => { if (api.openOld) await api.openOld().catch(() => undefined); leaving = true; void api.close(); });
  closeBtn.addEventListener('click', () => { leaving = true; void api.close(); });
  retryBtn.addEventListener('click', () => void install());
  classicBtn.addEventListener('click', () => void api.classic());
  stayBtn.addEventListener('click', () => { S.asking = false; paint(); });
  leaveBtn.addEventListener('click', () => { S.asking = false; paint(); leaving = true; void api.close(); });
  scrim.addEventListener('mousedown', () => { S.asking = false; paint(); });

  // Keyboard: Enter installs (where Enter means nothing else), Esc closes (asks while installing); focus kept inside
  // the question while it is open.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.menu) { closeMenu(true); e.preventDefault(); return; }
      if (S.asking) { S.asking = false; paint(); e.preventDefault(); return; }
      e.preventDefault(); askClose(); return;
    }
    if (e.key === 'Enter' && S.view === 'welcome' && !S.asking && !S.menu) {
      const a = document.activeElement;
      if (!a || a === document.body || a === goBtn || !a.closest('button, input, [role="listbox"]')) { e.preventDefault(); void install(); }
    }
    if (e.key === 'Tab' && S.asking) {
      const f = [leaveBtn, stayBtn]; const i = f.indexOf(document.activeElement);
      e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
    }
  });

  // Windows' look, live (the WebView follows Windows' app mode).
  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (!forcedTheme) root.setAttribute('data-theme', mq.matches ? 'dark' : 'light'); });
  let forcedTheme = false;

  // ---------- Start ----------
  const boot = window.__SETUP_BOOT__ || {};
  const pickStartLang = (sys) => {
    let kept = null; try { kept = localStorage.getItem('kr.setup.lang'); } catch { /* none */ }
    for (const c of [kept, sys, ...(navigator.languages || [navigator.language])]) {
      const l = String(c || '').toLowerCase().slice(0, 2);
      if (LANGS.includes(l)) return l;
    }
    return 'en';
  };
  S.lang = pickStartLang(boot.lang);
  paintWords();
  (async () => {
    let info;
    try { info = await api.detect(); } catch (err) { info = { version: '?', lang: '', dark: null, defaultDir: '', existing: { kind: 'none', desktop: false }, inner: false }; }
    S.info = info;
    if (typeof info.dark === 'boolean') { forcedTheme = !!window.__SETUP_FAKE__ && window.__SETUP_FAKE__.dark !== undefined; root.setAttribute('data-theme', info.dark ? 'dark' : 'light'); }
    if (!boot.lang && info.lang) S.lang = pickStartLang(info.lang);
    const e = info.existing || { kind: 'none' };
    S.opts.dir = e.kind === 'rust' && e.dir ? e.dir : info.defaultDir;
    S.opts.desktop = e.kind === 'none' ? true : !!e.desktop;
    if ((window.__SETUP_FAKE__ && window.__SETUP_FAKE__.optionsOpen) || boot.options) S.optsOpen = true;
    paint();
    // (CI's end-to-end run, main.rs --auto: installed at once with the choices given, the app not opened.)
    if (boot.auto && typeof boot.auto === 'object') {
      S.opts.desktop = boot.auto.desktop !== false; S.opts.assoc = boot.auto.assoc !== false; S.opts.runAfter = false;
      setTimeout(() => void install(), 900);
    }
    // (Shown once painted — where the window was not already shown in its colour.)
    requestAnimationFrame(() => requestAnimationFrame(() => void api.ready()));
  })();
})();
