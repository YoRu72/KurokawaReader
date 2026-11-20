// A computer's Files page, loaded on first use (files.ts hands it a host): the DETAILS list (Name · Size · Type · Modified,
// sortable, resizable, hideable), the NAVIGATION PANE (quick access, favourites, recent folders, drives, a lazy folder tree),
// the ADDRESS BAR (crumbs with sub-folder menus, a text field, history), the STATUS BAR, and the keys and mouse of a file
// manager. The phone never loads it; grid and gallery stay files.ts's own.
import { h, icon, iconButton, toast } from '../ui/dom';
import { t, formatBytes, formatDate, localDigits, countItems } from '../i18n';
import { kindOfFile } from './taskFiles';
import { nameEl, prefs, savePrefs, type Entry, type SortSet } from './files';

export type PcRoot = { kind: string; path: string; name: string; readable: boolean; free?: number; total?: number };
export type PcHost = {
  root: HTMLElement; body: HTMLElement; listEl: HTMLElement; side?: 'a' | 'b'; dual: boolean; peer: () => { focusPc?: () => void } | null;
  at: () => string; go: (p: string, how?: 'push' | 'replace') => void; goUp: () => void; upOf: () => string | null; load: () => void; roots: () => PcRoot[];
  shown: () => Entry[]; entries: () => Entry[]; picked: Set<string>; setSel: (paths: string[]) => void;
  open: (e: Entry) => void; itemMenu: (e: Entry, ev: Event) => void; rowOf: (p: string) => HTMLElement | undefined; ensure: (p: string) => void; redraw: () => void;
  listDir: (p: string) => Promise<{ exists: boolean; entries: Entry[] }>; stat: (p: string) => Promise<{ exists: boolean; dir: boolean } | null>; rename: (dir: string, from: string, to: string) => Promise<void>; err: (m: string) => string;
  del: (paths: string[]) => void; forever: (paths: string[]) => void; paste: () => void; hasClip: () => boolean; newFolder: () => void; props: (e: Entry) => void;
  filterShut: () => boolean; setView: (v: 'list' | 'grid' | 'gallery') => void;
};
export type PcCtl = {
  details(): boolean; row(e: Entry, ic: HTMLElement): HTMLElement; header(): HTMLElement; sync(list: Entry[]): void; sel(): void; at(p: string): void;
  key(ev: KeyboardEvent): boolean; sortSet(): SortSet; adopt(): void; focus(): void; dispose(): void;
};

const LS = 'kt.files.pc'; const BOOKMARKS = 'kt.files.bookmarks'; const RECENT = 'kt.files.recent';
type Saved = { cols?: Record<string, number>; hide?: string[]; nav?: boolean; navW?: number };
const readSaved = (): Saved => { try { return JSON.parse(localStorage.getItem(LS) ?? '{}') as Saved; } catch { return {}; } };
const writeSaved = (s: Saved) => { try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* none */ } };
const COLS = ['size', 'type', 'mod'] as const; type Col = 'name' | (typeof COLS)[number];
const MINW: Record<string, number> = { size: 72, type: 96, mod: 132 }; const DEFW: Record<string, number> = { size: 96, type: 150, mod: 190 };
const SORT_OF: Record<Col, SortSet['sort']> = { name: 'name', size: 'size', type: 'type', mod: 'date' };
const LABEL: Record<Col, 'pcColName' | 'pcColSize' | 'pcColType' | 'pcColModified'> = { name: 'pcColName', size: 'pcColSize', type: 'pcColType', mod: 'pcColModified' };
const baseOf = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p;
const dirOf = (p: string): string => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
const rtl = (el: Element): boolean => getComputedStyle(el).direction === 'rtl';
const timeFmt = (): Intl.DateTimeFormat => { try { return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { timeStyle: 'short', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions); } catch { return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }); } };
let tf: Intl.DateTimeFormat | null = null;
const whenOf = (ms: number): string => (ms > 0 ? `${formatDate(ms)} ${(tf ??= timeFmt()).format(new Date(ms))}` : '');
const KIND_KEY: Record<string, 'pcTypeImage' | 'pcTypeAudio' | 'pcTypeVideo' | 'pcTypeDoc' | 'pcTypeArchive'> = { image: 'pcTypeImage', audio: 'pcTypeAudio', video: 'pcTypeVideo', doc: 'pcTypeDoc', ebook: 'pcTypeDoc', archive: 'pcTypeArchive' };
/** A short word for the kind of an item: «Folder», «ZIP archive», «MP4 video». */
export const typeWord = (e: Entry): string => {
  if (e.dir) return t('pcTypeFolder');
  const x = e.name.includes('.') ? (e.name.split('.').pop() ?? '').toUpperCase() : ''; if (!x) return t('pcTypeBare');
  const key = KIND_KEY[kindOfFile(e.name)] ?? (/^(APK|EXE|MSI|DMG|IPA|APPX)$/.test(x) ? 'pcTypeApp' : 'pcTypeFile'); return t(key, { x });
};

/* ---------- a small pop-up menu (the address bar's chevrons, the header's columns, the empty space) ---------- */
type MI = { label: string; ic?: string; run?: () => void; off?: boolean; on?: boolean; sub?: () => MI[]; sep?: boolean };
let openMenu: { shut: () => void } | null = null;
export function popMenu(at: { x: number; y: number } | HTMLElement, items: MI[]): void {
  openMenu?.shut(); const el = h('div', { class: 'pcx-menu', role: 'menu' }) as HTMLElement; document.body.append(el);
  const place = () => { const r = at instanceof HTMLElement ? at.getBoundingClientRect() : null; const x = r ? (rtl(at as HTMLElement) ? r.right - el.offsetWidth : r.left) : (at as { x: number }).x; const y = r ? r.bottom + 2 : (at as { y: number }).y; el.style.left = `${Math.max(4, Math.min(x, innerWidth - el.offsetWidth - 4))}px`; el.style.top = `${Math.max(4, Math.min(y, innerHeight - el.offsetHeight - 4))}px`; };
  const fill = (xs: MI[], back?: () => void): void => {
    el.replaceChildren(...(back ? [h('button', { type: 'button', role: 'menuitem', class: 'pcx-mi', onclick: back }, icon('chevronLeft'), h('span', { class: 'grow' }, ''))] : []), ...xs.map((x) => x.sep ? h('hr', null) : h('button', { type: 'button', role: 'menuitem', class: 'pcx-mi' + (x.on ? ' on' : ''), disabled: x.off ? true : undefined, onclick: () => { if (x.sub) { fill(x.sub(), () => fill(xs, back)); return; } shut(); x.run?.(); } },
      x.ic ? icon(x.ic) : h('span', { class: 'pcx-mi-ic' }), h('bdi', { class: 'grow', dir: 'auto' }, x.label), x.on ? icon('check') : x.sub ? icon('chevronRight') : null)));
    place(); (el.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
  };
  const onDown = (e: Event) => { if (!el.contains(e.target as Node)) shut(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shut(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; e.preventDefault(); e.stopPropagation();
    const bs = [...el.querySelectorAll('button:not(:disabled)')] as HTMLElement[]; const i = bs.indexOf(document.activeElement as HTMLElement); bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]?.focus();
  };
  const shut = () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); el.remove(); if (openMenu?.shut === shut) openMenu = null; };
  document.addEventListener('pointerdown', onDown, true); document.addEventListener('keydown', onKey, true); openMenu = { shut }; fill(items);
}

const taken = new WeakSet<KeyboardEvent>();
const HIST: Record<string, { hist: string[]; hi: number }> = {}; let moving = ''; let pendingSel = '';
const open = new Set<string>(); const kids = new Map<string, Entry[]>();
export function mount(host: PcHost): PcCtl {
  const { root, body, listEl } = host; const st = readSaved(); let dead = false;
  const sortKey = `${LS}.sort.${host.side ?? 'a'}`;
  let sortS: SortSet = (() => { try { const s = JSON.parse(localStorage.getItem(sortKey) ?? 'null') as SortSet | null; if (s && s.sort) return s; } catch { /* none */ } return { sort: prefs.sort, desc: prefs.desc, ff: prefs.foldersFirst !== false }; })();
  const saveSort = () => { try { localStorage.setItem(sortKey, JSON.stringify(sortS)); } catch { /* none */ } };
  const hasNav = host.side !== 'b'; let navOpen = st.nav !== false;
  const hide = new Set(st.hide ?? []); const widths = (): Record<string, number> => ({ ...DEFW, ...(st.cols ?? {}) });
  let wMain = 9999; const squeezed = (c: Col): boolean => (c === 'type' && wMain < 620) || (c === 'mod' && wMain < 430);
  const vis = (): Col[] => ['name', ...COLS.filter((c) => !hide.has(c) && !squeezed(c))];
  const paintCols = () => { const w = widths(); root.style.setProperty('--pcx-cols', vis().map((c) => (c === 'name' ? 'minmax(160px, 1fr)' : `${w[c]}px`)).join(' ')); };
  const details = (): boolean => prefs.view === 'list';

  // ---- the layout: the page's own parts move into one column; the navigation pane stands beside it
  const main = h('div', { class: 'pcx-main' }); main.append(...root.childNodes);
  const bar = h('div', { class: 'pcx-bar' }); const addr = h('div', { class: 'pcx-addr', dir: 'ltr' }); const errEl = h('p', { class: 'pcx-err', role: 'alert', hidden: true });
  const status = h('div', { class: 'pcx-status', role: 'status', 'aria-label': t('pcStatus') }); const stText = h('span', { class: 'pcx-st-text' }); const stCount = h('span', { class: 'pcx-st-count' });
  const nav = h('nav', { class: 'pcx-nav', 'aria-label': t('pcNavPane') }) as HTMLElement; const sep = h('div', { class: 'pcx-sep', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': t('pcNavResize') });
  root.append(...(hasNav ? [nav, sep] : []), main); root.classList.add('pcx'); if (!hasNav) root.classList.add('pcx-solo');
  const strip = main.querySelector('.files-strip'); strip?.before(bar, errEl); main.append(status);
  listEl.tabIndex = 0; listEl.setAttribute('role', 'grid'); listEl.setAttribute('aria-multiselectable', 'true');
  const topbar = main.querySelector('.topbar') as HTMLElement | null;
  const fitTop = () => { const h0 = topbar?.offsetHeight ?? 56; root.style.setProperty('--pcx-tb', `${h0}px`); root.style.setProperty('--pcx-bar', `${h0 + bar.offsetHeight}px`); };
  // (A narrow page — two panes side by side — drops Type, then Modified, rather than running out of its column.)
  const fitW = () => { const w = main.clientWidth; if (!w) return; const was = vis().join(); wMain = w; if (vis().join() !== was) { paintHead(); host.redraw(); } };
  let ro: ResizeObserver | null = null; if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => { fitTop(); fitW(); }); if (topbar) ro.observe(topbar); ro.observe(bar); ro.observe(main); } fitTop();
  const setNavW = (w: number, keep = true) => { const v = Math.max(180, Math.min(360, Math.round(w))); root.style.setProperty('--pcx-nav-w', `${v}px`); if (keep) { st.navW = v; writeSaved(st); } };
  setNavW(st.navW ?? 240, false);
  const paintNavOpen = () => { root.classList.toggle('pcx-nav-off', !navOpen || !hasNav); navBtn.setAttribute('aria-pressed', String(navOpen)); };
  const toggleNav = () => { navOpen = !navOpen; st.nav = navOpen; writeSaved(st); paintNavOpen(); };
  sep.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent; e.preventDefault(); const x0 = e.clientX; const w0 = nav.getBoundingClientRect().width; const dir = rtl(root) ? -1 : 1;
    const move = (m: PointerEvent) => setNavW(w0 + (m.clientX - x0) * dir, false);
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); setNavW(nav.getBoundingClientRect().width); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });
  sep.addEventListener('keydown', (ev) => { const e = ev as KeyboardEvent; if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const d = (e.key === 'ArrowRight' ? 1 : -1) * (rtl(root) ? -1 : 1) * 16; setNavW(nav.getBoundingClientRect().width + d); });

  // ---- history, the address bar
  // (A folder entered makes a new page — the router draws it afresh —, so what must outlive it, the history and the open tree, lives in the module.)
  const hs = (HIST[host.side ?? 'a'] ??= { hist: [], hi: -1 });
  const navBtn = iconButton('sidebar', t('pcNavPane'), toggleNav); navBtn.classList.add('pcx-navbtn'); navBtn.hidden = !hasNav; navBtn.setAttribute('aria-pressed', String(navOpen));
  const backB = iconButton('back', t('back'), () => step(-1)); const fwdB = iconButton('arrowRight', t('pcForward'), () => step(1)); fwdB.classList.add('pcx-fwd');
  const upB = iconButton('arrowUp', t('pcUp'), () => host.goUp()); const refresh = () => { kids.clear(); pending.clear(); host.load(); }; const refB = iconButton('refresh', t('refresh'), refresh);
  const step = (d: number) => { console.log('STEP', d, host.side, hs.hi, hs.hist.join('|')); const to = hs.hi + d; if (to < 0 || to >= hs.hist.length) return; hs.hi = to; moving = hs.hist[to]; host.go(moving, 'replace'); paintBar(); };
  const paintBar = () => { backB.disabled = hs.hi <= 0; fwdB.disabled = hs.hi >= hs.hist.length - 1; upB.disabled = !host.upOf(); };
  bar.append(navBtn, backB, fwdB, upB, addr, refB); paintNavOpen();
  const driveOf = (p: string): PcRoot | null => host.roots().filter((r) => r.readable !== false && (p === r.path || p.startsWith(r.path.replace(/\/+$/, '') + '/'))).sort((a, b) => a.path.length - b.path.length)[0] ?? null;
  const crumbsOf = (p: string): { label: string; path: string }[] => {
    const r = driveOf(p); const basePath = r ? r.path : p.startsWith('/') ? '/' : (/^[A-Za-z]:/.exec(p)?.[0] ?? p); const bp = basePath.replace(/\/+$/, '') || '/';
    const out = [{ label: bp === '/' ? '/' : baseOf(bp), path: bp === '/' ? '/' : basePath }]; let acc = bp === '/' ? '' : bp;
    for (const s of p.slice(bp === '/' ? 1 : bp.length).split('/').filter(Boolean)) { acc += `/${s}`; out.push({ label: s, path: acc }); } return out;
  };
  const subMenu = async (path: string, anchor: HTMLElement) => {
    let kids: Entry[] = []; try { kids = (await host.listDir(path)).entries.filter((e) => e.dir); } catch { /* none */ } if (dead) return;
    kids.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    popMenu(anchor, kids.length ? kids.slice(0, 200).map((k) => ({ label: k.name, ic: 'folder', run: () => host.go(k.path) })) : [{ label: t('pcNoSubs'), off: true }]);
  };
  const paintAddr = () => {
    const cs = crumbsOf(host.at()); const parts: HTMLElement[] = [];
    cs.forEach((c, i) => { parts.push(h('button', { type: 'button', class: 'pcx-crumb' + (i === cs.length - 1 ? ' last' : ''), title: c.path, onclick: () => host.go(c.path) }, h('bdi', null, c.label)));
      const chev = h('button', { type: 'button', class: 'pcx-chev', 'aria-haspopup': 'menu', 'aria-label': t('pcSubs', { x: c.label }), onclick: (ev: Event) => { ev.stopPropagation(); void subMenu(c.path, chev as HTMLElement); } }, icon('chevronRight')); parts.push(chev as HTMLElement); });
    parts.push(h('span', { class: 'pcx-fill' })); addr.replaceChildren(...parts); addr.classList.remove('editing');
  };
  const showErr = (on: boolean) => { errEl.hidden = !on; if (on) errEl.textContent = t('pcNoPath'); };
  const cleanPath = (s: string): string => { let v = s.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim(); if (/^[A-Za-z]:\\|\\\\/.test(v) || (v.includes('\\') && !v.includes('/'))) v = v.replace(/\\/g, '/'); return v.length > 1 ? v.replace(/\/+$/, '') || '/' : v; };
  const edit = () => {
    if (addr.classList.contains('editing')) { (addr.querySelector('input') as HTMLInputElement | null)?.select(); return; }
    const inp = h('input', { type: 'text', class: 'pcx-input', value: host.at(), dir: 'ltr', spellcheck: 'false', autocomplete: 'off', 'aria-label': t('pcAddress') }) as HTMLInputElement;
    addr.replaceChildren(inp); addr.classList.add('editing'); inp.focus(); inp.select(); let done = false;
    const leave = () => { if (done) return; done = true; showErr(false); paintAddr(); };
    inp.addEventListener('paste', (ev) => { const txt = ev.clipboardData?.getData('text'); if (txt === undefined || txt === null) return; ev.preventDefault(); inp.setRangeText(cleanPath(txt), 0, inp.value.length, 'end'); });
    inp.addEventListener('input', () => { inp.removeAttribute('aria-invalid'); showErr(false); });
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); leave(); (listEl as HTMLElement).focus(); return; }
      if (ev.key !== 'Enter') return; ev.preventDefault(); ev.stopPropagation(); void commit(cleanPath(inp.value), inp, () => { done = true; showErr(false); (listEl as HTMLElement).focus(); });
    });
    inp.addEventListener('blur', () => { window.setTimeout(() => { if (!dead && !done && addr.contains(inp)) leave(); }, 120); });
  };
  const commit = async (p: string, inp: HTMLInputElement, ok: () => void) => {
    if (!p) return; const bad = () => { inp.setAttribute('aria-invalid', 'true'); showErr(true); inp.focus(); };
    const s = await host.stat(p); if (dead) return;
    if (s && !s.exists) { bad(); return; }
    if (s?.exists && !s.dir) { ok(); pendingSel = p; host.go(dirOf(p)); return; }
    try { const r = await host.listDir(p); if (dead) return; if (r.exists !== false) { ok(); host.go(p); return; } } catch { /* nothing there */ }
    bad();
  };
  addr.addEventListener('click', (ev) => { const tg = ev.target as HTMLElement; if (tg === addr || tg.classList.contains('pcx-fill')) edit(); });

  // ---- the navigation pane: quick access, favourites, recent folders, drives, the folder tree of the current drive
  const pending = new Set<string>();
  const QUICK = ['home', 'desktop', 'downloads', 'documents']; const RI: Record<string, string> = { home: 'user', desktop: 'layout', downloads: 'download', documents: 'file' };
  const readList = (k: string): { name?: string; path: string }[] => { try { const v = JSON.parse(localStorage.getItem(k) ?? '[]') as unknown[]; return v.map((x) => (typeof x === 'string' ? { path: x } : (x as { name?: string; path: string }))).filter((x) => x && typeof x.path === 'string'); } catch { return []; } };
  const ensureKids = (p: string) => {
    if (kids.has(p) || pending.has(p) || dead) return; pending.add(p);
    void host.listDir(p).then((r) => { if (dead || !pending.has(p)) return; pending.delete(p); kids.set(p, r.entries.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))); paintNav(); }).catch(() => { pending.delete(p); kids.set(p, []); paintNav(); });
  };
  const toggleNode = (p: string) => { if (open.has(p)) { open.delete(p); pending.delete(p); } else { open.add(p); ensureKids(p); } paintNav(); };
  const reveal = (p: string) => { const dr = driveOf(p); if (!dr) return; const bp = dr.path.replace(/\/+$/, ''); let acc = bp; open.add(dr.path); ensureKids(dr.path);
    const segs = p.slice(bp.length).split('/').filter(Boolean); const last = segs.pop(); for (const s of segs) { acc += `/${s}`; open.add(acc); ensureKids(acc); } if (last) open.add(`${acc}/${last}`); };
  const item = (o: { p: string; label: string; ic: string; level?: number; twisty?: 'open' | 'shut' | 'none'; extra?: HTMLElement | null; parent?: string }): HTMLElement => {
    const cur = host.at() === o.p; const tw = o.twisty && o.twisty !== 'none' ? h('button', { type: 'button', class: 'nv-tw', tabindex: '-1', 'aria-label': o.twisty === 'open' ? t('pcNavFolders') : t('pcNavFolders'), onclick: (ev: Event) => { ev.stopPropagation(); toggleNode(o.p); } }, icon(o.twisty === 'open' ? 'chevronDown' : 'chevronRight')) : h('span', { class: 'nv-tw none' });
    const el = h('div', { class: 'nv-item' + (cur ? ' cur' : ''), role: 'treeitem', tabindex: cur ? '0' : '-1', 'data-p': o.p, 'data-parent': o.parent ?? '', 'aria-level': String(o.level ?? 1), 'aria-selected': String(cur), 'aria-expanded': o.twisty && o.twisty !== 'none' ? String(o.twisty === 'open') : undefined, style: `--lv:${(o.level ?? 1) - 1}`, onclick: () => host.go(o.p) },
      ...(o.level ? [tw] : []), icon(o.ic), h('span', { class: 'nv-l' }, h('bdi', { dir: 'auto' }, o.label), o.extra ?? null)) as HTMLElement; return el;
  };
  const paintNav = () => {
    if (!hasNav || dead) return; const keepTop = nav.scrollTop; const act = document.activeElement as HTMLElement | null; const hadFocus = act && nav.contains(act) ? act.dataset.p : null; const at = host.at(); const roots = host.roots();
    const sec = (title: string, xs: HTMLElement[]): HTMLElement[] => (xs.length ? [h('div', { class: 'nv-h', role: 'presentation' }, title), ...xs] : []);
    const quick = QUICK.flatMap((k) => roots.filter((r) => r.kind === k)).map((r) => item({ p: r.path, label: r.name, ic: RI[r.kind] ?? 'folder' }));
    const favs = readList(BOOKMARKS).map((b) => item({ p: b.path, label: b.name || baseOf(b.path), ic: 'bookmark' }));
    const recent = readList(RECENT).slice(0, 6).map((b) => item({ p: b.path, label: baseOf(b.path), ic: 'history' }));
    const drives = roots.filter((r) => !QUICK.includes(r.kind) && !/^(remote|saf|root|phone|app)$/.test(r.kind) && !r.path.includes('://')).map((r) => {
      const used = r.total && r.free !== undefined ? Math.max(0, Math.min(100, Math.round(((r.total - r.free) / r.total) * 100))) : null;
      return item({ p: r.path, label: r.name, ic: 'storage', extra: used === null ? null : h('span', { class: 'nv-disk' }, h('span', { class: 'nv-bar' }, h('i', { style: `width:${used}%` })), h('small', { class: 'src' }, t('pcNavFree', { x: formatBytes(r.free ?? 0) }))) });
    });
    const dr = driveOf(at); const tree: HTMLElement[] = [];
    if (dr) { const walk = (p: string, name: string, lvl: number, parent: string) => { const isOpen = open.has(p); tree.push(item({ p, label: name, ic: lvl === 1 ? 'storage' : 'folder', level: lvl, twisty: isOpen ? 'open' : 'shut', parent })); if (isOpen && !kids.has(p) && p !== at) ensureKids(p); if (isOpen) for (const k of kids.get(p) ?? []) walk(k.path, k.name, lvl + 1, p); };
      const nm = dr.path.replace(/\/+$/, '') ? baseOf(dr.path) : '/'; walk(dr.path, nm, 1, ''); }
    nav.replaceChildren(h('div', { class: 'nv-scroll', role: 'tree', 'aria-label': t('pcNavPane') }, ...sec(t('pcNavQuick'), quick), ...sec(t('pcNavFav'), favs), ...sec(t('pcNavRecent'), recent), ...sec(t('pcNavDrives'), drives), ...sec(t('pcNavFolders'), tree)));
    nav.scrollTop = keepTop; if (hadFocus !== null && hadFocus !== undefined) (nav.querySelector(`.nv-item[data-p="${CSS.escape(hadFocus)}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
    if (!nav.querySelector('.nv-item[tabindex="0"]')) (nav.querySelector('.nv-item') as HTMLElement | null)?.setAttribute('tabindex', '0');
  };
  nav.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent; const it = (e.target as HTMLElement).closest('.nv-item') as HTMLElement | null; if (!it) return; const all = [...nav.querySelectorAll('.nv-item')] as HTMLElement[]; const i = all.indexOf(it); const p = it.dataset.p ?? '';
    const focus = (x?: HTMLElement) => { if (!x) return; for (const a of all) a.tabIndex = -1; x.tabIndex = 0; x.focus(); };
    if (e.key === 'ArrowDown') { e.preventDefault(); focus(all[i + 1]); } else if (e.key === 'ArrowUp') { e.preventDefault(); focus(all[i - 1]); }
    else if (e.key === 'Home') { e.preventDefault(); focus(all[0]); } else if (e.key === 'End') { e.preventDefault(); focus(all[all.length - 1]); }
    else if (e.key === (rtl(root) ? 'ArrowLeft' : 'ArrowRight')) { e.preventDefault(); const ex = it.getAttribute('aria-expanded'); if (ex === 'false') toggleNode(p); else if (ex === 'true') focus(all[i + 1]); }
    else if (e.key === (rtl(root) ? 'ArrowRight' : 'ArrowLeft')) { e.preventDefault(); const ex = it.getAttribute('aria-expanded'); if (ex === 'true') toggleNode(p); else if (it.dataset.parent) focus(all.find((x) => x.dataset.p === it.dataset.parent)); }
    else if (e.key === 'Enter') { e.preventDefault(); host.go(p); }
  });

  // ---- the header row (sort, resize, show or hide columns)
  const hdr = h('div', { class: 'pcx-head', role: 'row' }) as HTMLElement;
  const setSort = (c: Col) => { const s = SORT_OF[c]; sortS = sortS.sort === s ? { ...sortS, desc: !sortS.desc } : { ...sortS, sort: s, desc: false }; saveSort(); if (host.side !== 'b') { prefs.sort = sortS.sort; prefs.desc = sortS.desc; savePrefs(); } paintHead(); host.redraw(); };
  const paintHead = () => {
    paintCols(); const w = widths();
    hdr.replaceChildren(...vis().map((c) => { const on = sortS.sort === SORT_OF[c];
      const cell = h('div', { class: `pcx-hc pcx-h-${c}`, role: 'columnheader', 'aria-sort': on ? (sortS.desc ? 'descending' : 'ascending') : 'none' },
        h('button', { type: 'button', class: 'pcx-hb', 'data-col': c, onclick: () => setSort(c) }, h('span', { class: 'grow' }, t(LABEL[c])), on ? icon(sortS.desc ? 'arrowDown' : 'arrowUp') : null),
        c === 'name' ? null : h('span', { class: 'pcx-grip', role: 'separator', 'aria-label': t('pcResizeCol'), 'data-col': c, onpointerdown: (ev: Event) => grip(ev as PointerEvent, c, w[c]) })); return cell; }));
  };
  const grip = (e: PointerEvent, c: Col, w0: number) => {
    e.preventDefault(); e.stopPropagation(); const x0 = e.clientX; const dir = rtl(root) ? -1 : 1; st.cols = { ...(st.cols ?? {}) };
    const move = (m: PointerEvent) => { st.cols![c] = Math.max(MINW[c], Math.min(480, Math.round(w0 + (x0 - m.clientX) * dir))); paintCols(); };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); writeSaved(st); paintHead(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  };
  hdr.addEventListener('contextmenu', (ev) => { ev.preventDefault(); popMenu({ x: ev.clientX, y: ev.clientY }, [...COLS.map((c) => ({ label: t(LABEL[c]), on: !hide.has(c), run: () => { if (hide.has(c)) hide.delete(c); else hide.add(c); st.hide = [...hide]; writeSaved(st); paintHead(); host.redraw(); } }))]); });
  paintHead();

  // ---- a row
  let cur = ''; let anchor = '';
  const range = (a: string, b: string): string[] => { const l = host.shown(); const i = l.findIndex((x) => x.path === a); const j = l.findIndex((x) => x.path === b); if (i < 0 || j < 0) return [b]; return l.slice(Math.min(i, j), Math.max(i, j) + 1).map((x) => x.path); };
  const pick = (e: Entry, ev: MouseEvent) => {
    if (ev.shiftKey && (anchor || cur)) host.setSel(range(anchor || cur, e.path));
    else if (ev.ctrlKey || ev.metaKey) { const s = new Set(host.picked); if (s.has(e.path)) s.delete(e.path); else s.add(e.path); host.setSel([...s]); anchor = e.path; }
    else { host.setSel([e.path]); anchor = e.path; } cur = e.path;
  };
  const rowFor = (e: Entry, ic: HTMLElement): HTMLElement => {
    const c = vis(); ic.classList.remove('thumb'); ic.removeAttribute('data-thumb');
    const el = h('div', { class: 'files-row d-row' + (host.picked.has(e.path) ? ' picked' : '') + (e.hidden ? ' hidden-file' : ''), role: 'row', tabindex: '-1', 'aria-selected': String(host.picked.has(e.path)), 'data-p': e.path,
      onclick: (ev: Event) => pick(e, ev as MouseEvent), ondblclick: (ev: Event) => { ev.preventDefault(); host.open(e); }, oncontextmenu: (ev: Event) => { ev.preventDefault(); if (!host.picked.has(e.path)) { host.setSel([e.path]); anchor = cur = e.path; } host.itemMenu(e, ev); } },
      h('span', { class: 'd-name', role: 'gridcell' }, ic, nameEl(e.name, e.dir)),
      ...c.slice(1).map((k) => h('span', { class: `d-${k}`, role: 'gridcell' }, k === 'size' ? (!e.dir && e.size >= 0 ? formatBytes(e.size) : '') : k === 'type' ? typeWord(e) : whenOf(e.mtime)))) as HTMLElement;
    if (host.dual) { el.draggable = true; el.addEventListener('dragstart', (ev) => { const ps = host.picked.has(e.path) ? [...host.picked] : [e.path]; ev.dataTransfer?.setData('text/kt-paths', JSON.stringify(ps)); ev.dataTransfer?.setData('text/plain', ps.join('\n')); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copyMove'; }); }
    return el;
  };

  // ---- the status bar
  const views: ['list' | 'grid' | 'gallery', string, string][] = [['list', 'pcViewDetails', 'list'], ['grid', 'fmGrid', 'grid'], ['gallery', 'fmGallery', 'images']];
  const viewSw = h('div', { class: 'pcx-views segmented', role: 'group', 'aria-label': t('fmView') });
  const paintViews = () => viewSw.replaceChildren(...views.map(([v, key, ic]) => h('button', { type: 'button', 'aria-pressed': String(prefs.view === v), 'data-v': v, title: t(key as 'fmGrid'), 'aria-label': t(key as 'fmGrid'), onclick: () => host.setView(v) }, icon(ic))));
  status.append(stCount, stText, viewSw); paintViews();
  let lastN = 0;
  const paintSel = () => {
    const n = host.picked.size; stCount.textContent = countItems(lastN); if (!n) { stText.textContent = ''; return; }
    const by = new Map(host.entries().map((e) => [e.path, e])); let files = 0, bytes = 0, dirs = 0; for (const p of host.picked) { const e = by.get(p); if (!e) continue; if (e.dir) dirs++; else { files++; bytes += Math.max(0, e.size); } }
    stText.textContent = !files ? t('pcSelected', { n: localDigits(n) }) : t(dirs ? 'pcSelectedMore' : 'pcSelectedSize', { n: localDigits(n), size: formatBytes(bytes) });
  };

  // ---- inline rename
  const renameInline = (e: Entry) => {
    const el = host.rowOf(e.path); const cell = el?.querySelector('.d-name') as HTMLElement | null; const nm = cell?.querySelector('.files-name') as HTMLElement | null; if (!el || !cell || !nm) return;
    const inp = h('input', { type: 'text', class: 'pcx-rename', value: e.name, dir: 'auto', spellcheck: 'false', 'aria-label': t('rename') }) as HTMLInputElement; nm.hidden = true; cell.append(inp); inp.focus();
    const dot = e.dir ? -1 : e.name.lastIndexOf('.'); inp.setSelectionRange(0, dot > 0 ? dot : e.name.length); let done = false;
    const end = (go: boolean) => { if (done) return; done = true; const v = inp.value.trim(); inp.remove(); nm.hidden = false; if (!go || !v || v === e.name) { (el as HTMLElement).focus(); return; }
      void host.rename(dirOf(e.path), e.name, v).then(() => { pendingSel = `${dirOf(e.path) === '/' ? '' : dirOf(e.path)}/${v}`; host.load(); }, (er) => { toast(host.err(String((er as Error)?.message ?? er)), 'error'); }); };
    inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); end(true); } else if (ev.key === 'Escape') { ev.preventDefault(); end(false); } });
    inp.addEventListener('blur', () => end(true)); inp.addEventListener('dblclick', (ev) => ev.stopPropagation()); inp.addEventListener('click', (ev) => ev.stopPropagation());
  };

  // ---- the empty space: a folder menu; a rubber band
  const here = (): Entry => ({ name: baseOf(host.at()), path: host.at(), dir: true, size: 0, mtime: 0 } as Entry);
  const emptyMenu = (x: number, y: number) => {
    const sortItems = (): MI[] => (['name', 'size', 'type', 'mod'] as Col[]).map((c) => ({ label: t(LABEL[c]), ic: sortS.sort === SORT_OF[c] ? (sortS.desc ? 'arrowDown' : 'arrowUp') : undefined, on: false, run: () => setSort(c) }));
    popMenu({ x, y }, [{ label: t('newFolder'), ic: 'folderPlus', run: () => host.newFolder() }, { label: t('filesPaste'), ic: 'paste', off: !host.hasClip(), run: () => host.paste() }, { sep: true, label: '' },
      { label: t('sortBy'), ic: 'sort', sub: sortItems }, { label: t('fmView'), ic: 'grid', sub: () => views.map(([v, key]) => ({ label: t(key as 'fmGrid'), on: prefs.view === v, run: () => host.setView(v) })) },
      { label: t('refresh'), ic: 'refresh', run: () => host.load() }, { label: t('properties'), ic: 'info', run: () => host.props(here()) }]);
  };
  const empty = (tg: EventTarget | null): boolean => { const el = tg as HTMLElement | null; return !!el && !el.closest('.files-row, .pcx-head, .pcx-status, .files-fab, .files-clipbar, .files-job, .files-state, .files-section, .files-subres, .topbar, .pcx-bar, .files-strip, .files-search') && (el === body || el === listEl || body.contains(el) || el.classList.contains('files-chunk')); };
  const onCtx = (ev: MouseEvent) => { if (!empty(ev.target)) return; ev.preventDefault(); host.setSel([]); emptyMenu(ev.clientX, ev.clientY); };
  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0 || !details() || !empty(ev.target)) return; const base = ev.ctrlKey || ev.metaKey || ev.shiftKey ? new Set(host.picked) : new Set<string>(); const x0 = ev.clientX, y0 = ev.clientY; let band: HTMLElement | null = null;
    if (!base.size) host.setSel([]); (listEl as HTMLElement).focus({ preventScroll: true });
    const move = (m: PointerEvent) => {
      if (!band) { if (Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return; band = h('div', { class: 'pcx-band' }) as HTMLElement; document.body.append(band); }
      const l = Math.min(x0, m.clientX), r = Math.max(x0, m.clientX), tp = Math.min(y0, m.clientY), bt = Math.max(y0, m.clientY); Object.assign(band.style, { left: `${l}px`, top: `${tp}px`, width: `${r - l}px`, height: `${bt - tp}px` });
      const hit = new Set(base); for (const row of listEl.querySelectorAll('.d-row')) { const b = row.getBoundingClientRect(); if (b.right >= l && b.left <= r && b.bottom >= tp && b.top <= bt) hit.add((row as HTMLElement).dataset.p ?? ''); }
      hit.delete(''); host.setSel([...hit]);
    };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); band?.remove(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  };
  const onMouse = (ev: MouseEvent) => { if (ev.button === 3) { ev.preventDefault(); step(-1); } else if (ev.button === 4) { ev.preventDefault(); step(1); } };
  body.addEventListener('contextmenu', onCtx); body.addEventListener('pointerdown', onDown); root.addEventListener('mouseup', onMouse); root.addEventListener('auxclick', (ev) => { if (ev.button === 3 || ev.button === 4) ev.preventDefault(); });

  // ---- the keys
  let buf = ''; let bufAt = 0;
  const moveTo = (i: number, extend: boolean) => {
    const l = host.shown(); if (!l.length) return; const j = Math.max(0, Math.min(l.length - 1, i)); const p = l[j].path;
    if (extend) host.setSel(range(anchor || cur || p, p)); else { host.setSel([p]); anchor = p; } cur = p; host.ensure(p);
  };
  const curIdx = (): number => { const l = host.shown(); const k = cur || [...host.picked].pop() || ''; return l.findIndex((x) => x.path === k); };
  const oneEntry = (): Entry | undefined => (host.picked.size === 1 ? host.entries().find((e) => e.path === [...host.picked][0]) : undefined);
  const key = (ev: KeyboardEvent): boolean => {
    if (taken.has(ev) && (ev.key === 'F6' || ev.key === 'Tab')) return false; // (the other pane's page took it first: focus moves once)
    const k = ev.key; const mod = ev.ctrlKey || ev.metaKey; const lk = k.toLowerCase(); const yes = (f: () => void): boolean => { ev.preventDefault(); if (k === 'F6' || k === 'Tab') taken.add(ev); f(); return true; };
    if (ev.altKey && !mod) { if (k === 'ArrowLeft') return yes(() => step(-1)); if (k === 'ArrowRight') return yes(() => step(1)); if (k === 'Enter') { const o = oneEntry() ?? here(); return yes(() => host.props(o)); } if (lk === 'd') return yes(edit); }
    if ((mod && !ev.shiftKey && !ev.altKey && lk === 'l') || k === 'F4') return yes(edit);
    if (mod && !ev.shiftKey && !ev.altKey && lk === 'b') return yes(toggleNav);
    if (mod && ev.shiftKey && lk === 'n') return yes(() => host.newFolder());
    if (k === 'F5' && !mod) return yes(refresh);
    if (k === 'F6') return yes(() => { const p = host.peer(); if (p?.focusPc) p.focusPc(); else edit(); });
    if (k === 'Tab' && !ev.shiftKey && !mod && host.dual && host.peer()?.focusPc) return yes(() => host.peer()!.focusPc!());
    if (k === 'Delete' && ev.shiftKey && host.picked.size) return yes(() => host.forever([...host.picked]));
    if (k === 'F2' && host.picked.size === 1) { const o = oneEntry(); if (o && details() && host.rowOf(o.path)) return yes(() => renameInline(o)); }
    if (k === 'Escape' && host.filterShut()) return yes(() => undefined);
    if (!details() || ev.altKey || (mod && !ev.shiftKey && lk === 'a')) return false;
    if (k === 'Enter' && !mod) { const o = oneEntry(); if (o) return yes(() => host.open(o)); return false; }
    const ix = curIdx(); const page = Math.max(1, Math.floor(innerHeight / 32) - 3);
    if (k === 'ArrowDown') return yes(() => moveTo(ix < 0 ? 0 : ix + 1, ev.shiftKey)); if (k === 'ArrowUp') return yes(() => moveTo(ix < 0 ? 0 : ix - 1, ev.shiftKey));
    if (k === 'Home') return yes(() => moveTo(0, ev.shiftKey)); if (k === 'End') return yes(() => moveTo(1e9, ev.shiftKey));
    if (k === 'PageDown') return yes(() => moveTo(ix + page, ev.shiftKey)); if (k === 'PageUp') return yes(() => moveTo(ix - page, ev.shiftKey));
    if (k.length === 1 && !mod && !ev.altKey && k !== ' ') {
      const now = Date.now(); buf = now - bufAt > 1000 ? k : buf + k; bufAt = now; const q = buf.toLowerCase();
      const l = host.shown(); const from = buf.length === 1 && ix >= 0 ? ix + 1 : 0; const order = [...l.slice(from), ...l.slice(0, from)]; const f = order.find((x) => x.name.toLowerCase().startsWith(q));
      if (f) return yes(() => moveTo(l.indexOf(f), false)); return false;
    }
    return false;
  };

  let lastList: Entry[] = [];
  const ctl: PcCtl = {
    details, row: rowFor, header: () => hdr,
    sync(list) {
      lastList = list; lastN = list.length; root.classList.toggle('pcx-details', details()); paintViews(); paintCols(); stCount.textContent = countItems(lastN); paintSel();
      const here0 = host.at(); const ents = host.entries(); if (ents.length || here0) kids.set(here0, ents.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
      if (pendingSel && list.some((x) => x.path === pendingSel)) { const p = pendingSel; pendingSel = ''; host.setSel([p]); cur = anchor = p; host.ensure(p); }
      paintNav();
    },
    sel() { paintSel(); for (const r of listEl.querySelectorAll('.d-row')) r.setAttribute('aria-selected', String(host.picked.has((r as HTMLElement).dataset.p ?? ''))); },
    at(p) { if (!p) return; if (moving && moving === p) moving = ''; else if (hs.hist[hs.hi] !== p) { hs.hist = hs.hist.slice(0, hs.hi + 1); hs.hist.push(p); hs.hi = hs.hist.length - 1; if (hs.hist.length > 100) { hs.hist.shift(); hs.hi--; } } reveal(p); paintAddr(); paintBar(); paintNav(); showErr(false); void lastList; },
    key, sortSet: () => sortS, adopt() { sortS = { sort: prefs.sort, desc: prefs.desc, ff: prefs.foldersFirst !== false }; saveSort(); paintHead(); },
    focus() { (listEl as HTMLElement).focus(); },
    dispose() { dead = true; ro?.disconnect(); openMenu?.shut(); body.removeEventListener('contextmenu', onCtx); body.removeEventListener('pointerdown', onDown); root.removeEventListener('mouseup', onMouse); pending.clear(); },
  };
  return ctl;
}
