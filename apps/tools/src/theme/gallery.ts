// The theme gallery: a card per theme with its dark and light miniatures drawn from its own tokens, the one in use
// marked, a download button on those whose pictures are fetched on demand (progress, then usable), remove to free
// the room, and «Add themes» for those in the repository's list. Shared by the Kurokawa apps: the app hands in its
// words, icons and storage (`GalleryDeps`); styles are in glass.css's companion block, gallery.css.
import { THEMES, DEFAULT_THEME, themeById, previewOf, modesOf, registerTheme, type ThemeDef, type Mode, type DarkTone, type Preview } from './themes';
import { deferred } from './history';
import { APP_THEME } from './app';
import { loadIndex, installPack, removePack, installed, pictureUrls, PackError, forgetIndex, type PackIO, type Installed, type IndexEntry } from './packs';

export interface GalleryDeps {
  t(key: string, vars?: Record<string, string | number>): string;
  icon(name: string): SVGElement;
  formatBytes(n: number): string;
  io: PackIO;
  current(): { theme: string; mode: Mode; darkTone: DarkTone };
  choose(id: string): void;
  sheet(title: string): { body: HTMLElement; close(): void };
  toast(msg: string, kind?: 'info' | 'error', action?: { label: string; run: () => void }, ms?: number): void;
  /** The reader's own themes (theme/editor.ts): customise any theme, a saved one's menu, a file imported. */
  mine?: { customise(id: string): void; menu(id: string): void; importTheme(): void };
  /** Pictures of the reader's own themes (by asset name), for their miniatures. */
  mineLoader?(id: string): Promise<Record<string, string>>;
}

type Kid = Node | string | null | undefined | false;
export function el(tag: string, attrs: Record<string, unknown> | null, ...kids: Kid[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v); else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v as Record<string, string>)) e.style.setProperty(p, x); else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
export const themeName = (d: ThemeDef, t: GalleryDeps['t']): string => (d.nameKey ? t(d.nameKey) : d.name ?? d.id);

/** A miniature of the app in a theme: its ground and background, a glass bar, two cards, the bottom bar. */
export function miniature(p: Preview, picture?: string): HTMLElement {
  const layers = [p.veil && picture ? p.veil : '', picture ? `url("${picture}")` : '', p.bg !== 'none' ? p.bg : ''].filter(Boolean).join(', ');
  const line = (w: number, c: string) => el('i', { class: 'tg-line', style: { width: `${w}%`, background: c } });
  return el('div', { class: 'tg-mini', 'data-mode': p.mode, style: { ...p.vars, 'background-color': p.ground, 'background-image': layers || 'none', '--tg-pane': p.pane, '--tg-card': p.card, '--tg-edge': p.edge } },
    el('div', { class: 'tg-bar' }, line(46, p.text)),
    el('div', { class: 'tg-c' }, line(70, p.text), line(52, p.dim), el('i', { class: 'tg-chip' })),
    el('div', { class: 'tg-c' }, line(58, p.text), line(40, p.dim)),
    el('div', { class: 'tg-nav' }, el('i', { class: 'tg-pill' }), el('i', { class: 'tg-dot', style: { background: p.dim } }), el('i', { class: 'tg-dot', style: { background: p.dim } })));
}

export function themeGallery(d: GalleryDeps): HTMLElement {
  const grid = el('div', { class: 'tg-grid', role: 'radiogroup', 'aria-label': d.t('themeGallery') });
  const busy = new Map<string, { done: number; total: number }>();
  const errors = new Map<string, PackError>();
  let have: Record<string, Installed> = {};
  let index: IndexEntry[] | null = null; let indexState: 'loading' | 'ok' | 'offline' = 'loading';

  const sizeOf = (def: ThemeDef) => index?.find((x) => x.id === (def.pack?.id ?? def.id))?.size ?? def.pack?.size ?? 0;
  const needsPack = (def: ThemeDef) => !!def.pack && !have[def.pack.id];
  const errText = (e: PackError, def: ThemeDef) => e.kind === 'checksum' ? d.t('themeErrChecksum') : e.kind === 'storage' ? d.t('themeErrStorage', { size: d.formatBytes(sizeOf(def)) }) : e.kind === 'missing' ? d.t('themeErrMissing') : e.kind === 'format' ? d.t('themeErrFormat') : d.t('themeErrOffline');

  async function fetchIt(def: ThemeDef, andUse: boolean): Promise<void> {
    const id = def.pack?.id ?? def.id; if (busy.has(id)) return;
    errors.delete(id); busy.set(id, { done: 0, total: sizeOf(def) }); draw();
    try {
      await installPack(d.io, id, (done, total) => { busy.set(id, { done, total }); paintProgress(id); });
      have = await installed(d.io); busy.delete(id);
      d.toast(d.t('themeInstalled', { name: themeName(def, d.t) }));
      if (andUse) d.choose(def.id);
    } catch (e) {
      busy.delete(id); errors.set(id, e instanceof PackError ? e : new PackError('offline', String(e)));
    }
    draw();
  }
  const removing = new Set<string>();
  async function remove(def: ThemeDef): Promise<void> {
    const id = def.pack?.id ?? def.id; const size = have[id]?.size ?? 0; if (removing.has(id)) return;
    // (Really removed only when the snackbar's Undo is over; the theme in use then stays, on its drawn background.)
    removing.add(id); draw();
    const job = deferred(async () => { removing.delete(id); await removePack(d.io, id); have = await installed(d.io); if (d.current().theme === def.id) d.choose(def.id); draw(); }, 6000);
    d.toast(d.t('themeRemoved', { name: themeName(def, d.t), size: d.formatBytes(size) }), 'info', { label: d.t('undo'), run: () => { job.undo(); removing.delete(id); draw(); } }, 6000);
  }
  function paintProgress(id: string): void {
    const p = busy.get(id); if (!p) return;
    grid.querySelectorAll<HTMLElement>(`[data-pack="${CSS.escape(id)}"] .tg-progress > i`).forEach((bar) => { bar.style.width = `${p.total ? Math.min(100, (p.done / p.total) * 100) : 8}%`; });
    grid.querySelectorAll<HTMLElement>(`[data-pack="${CSS.escape(id)}"] .tg-state`).forEach((s) => { s.textContent = d.t('themeDownloading', { done: d.formatBytes(p.done), size: d.formatBytes(p.total) }); });
  }

  function card(def: ThemeDef, pics: Record<string, string>): HTMLElement {
    const cur = d.current(); const on = cur.theme === def.id; const packId = def.pack?.id;
    const need = needsPack(def); const prog = packId ? busy.get(packId) : undefined; const err = packId ? errors.get(packId) : undefined;
    const modes = modesOf(def);
    const minis = modes.map((m) => { const p = previewOf(def, m, cur.darkTone); return miniature(p, p.picture ? pics[p.picture] : undefined); });
    const name = themeName(def, d.t);
    const state = def.custom ? d.t('editorFrom', { base: themeName(themeById(def.base), d.t) }) : packId && removing.has(packId) ? d.t('themeRemoving') : prog ? d.t('themeDownloading', { done: d.formatBytes(prog.done), size: d.formatBytes(prog.total || sizeOf(def)) })
      : err ? errText(err, def)
      : need ? d.t('themeNeedsDownload', { size: d.formatBytes(sizeOf(def)) })
      : packId ? d.t('themeOnDevice', { size: d.formatBytes(have[packId]?.size ?? sizeOf(def)) })
      : modes.length === 1 ? d.t(modes[0] === 'dark' ? 'themeDarkOnly' : 'themeLightOnly') : d.t('themeBuiltIn');
    const pick = el('button', {
      type: 'button', class: 'tg-pick', role: 'radio', 'aria-checked': String(on), 'aria-label': name,
      'aria-describedby': `tg-s-${def.id}`,
      onclick: () => { if (prog) return; if (need) { void fetchIt(def, true); return; } d.choose(def.id); },
    },
    el('div', { class: 'tg-pair', 'data-n': String(minis.length) }, ...minis),
    on ? el('span', { class: 'tg-check', 'aria-hidden': 'true' }, d.icon('check')) : null,
    el('span', { class: 'tg-meta' }, el('b', { class: 'tg-name' }, name, APP_THEME.mainTag && def.classic && def.id === DEFAULT_THEME ? el('span', { class: 'tg-tag' }, d.t('themeDefaultTag')) : null), def.by ? el('small', { class: 'tg-by' }, d.t('themeBy', { who: def.by })) : null,
      el('small', { class: 'tg-state' + (err ? ' err' : ''), id: `tg-s-${def.id}`, role: err ? 'alert' : undefined }, state)));
    const act = prog ? el('span', { class: 'tg-progress', role: 'progressbar', 'aria-label': d.t('themeDownloadingShort') }, el('i', { style: { width: `${prog.total ? Math.min(100, (prog.done / prog.total) * 100) : 8}%` } }))
      : need ? el('button', { type: 'button', class: 'tg-act tg-dl' + (err ? ' retry' : ''), title: err ? d.t('themeRetry') : d.t('themeDownload', { size: d.formatBytes(sizeOf(def)) }), 'aria-label': `${err ? d.t('themeRetry') : d.t('themeDownload', { size: d.formatBytes(sizeOf(def)) })} — ${name}`, onclick: () => void fetchIt(def, false) }, d.icon(err ? 'refresh' : 'download'))
      : packId && removing.has(packId) ? null
      : packId ? el('button', { type: 'button', class: 'tg-act tg-rm', title: d.t('themeRemove'), 'aria-label': `${d.t('themeRemove')} — ${name}`, onclick: () => void remove(def) }, d.icon('trash'))
      : null;
    // (Customise: a pencil on every theme — the main theme's, where the app allows it, makes a copy of it among My
    //  themes, elsewhere it has none —; a saved theme's ⋮ holds its own actions.)
    const edit = !d.mine || (def.classic && !APP_THEME.mainCopyable) ? null : def.custom
      ? el('button', { type: 'button', class: 'tg-edit tg-more', title: d.t('myMore'), 'aria-label': `${d.t('myMore')} — ${name}`, onclick: () => d.mine!.menu(def.id) }, d.icon('more'))
      : el('button', { type: 'button', class: 'tg-edit', title: d.t('editorCustomise'), 'aria-label': `${d.t('editorCustomise')} — ${name}`, onclick: () => d.mine!.customise(def.id) }, d.icon('pencil'));
    return el('div', { class: 'tg-card' + (on ? ' on' : '') + (need ? ' needs' : '') + (prog ? ' busy' : '') + (err ? ' failed' : '') + (def.custom ? ' mine' : ''), 'data-theme': def.id, 'data-pack': def.custom ? undefined : packId }, pick, edit, act);
  }
  const addTile = () => el('button', { type: 'button', class: 'tg-card tg-add', onclick: () => void addSheet() }, el('span', { class: 'tg-add-ic' }, d.icon('plus')), el('span', { class: 'tg-meta' }, el('b', { class: 'tg-name' }, d.t('themeAdd')), el('small', { class: 'tg-state' }, d.t('themeAddHint'))));

  async function addSheet(): Promise<void> {
    const s = d.sheet(d.t('themeAddTitle'));
    const list = el('div', { class: 'tg-addlist' }, el('p', { class: 'hint' }, d.t('themeAddLoading')));
    s.body.append(list);
    const paint = async (fresh: boolean) => {
      try { forgetIndex(); const ix = await loadIndex(d.io, fresh); index = ix.themes; indexState = 'ok'; }
      catch (e) {
        indexState = 'offline';
        list.replaceChildren(el('p', { class: 'hint tg-empty' }, (e as PackError).kind === 'missing' ? d.t('themeIndexMissing') : d.t('themeIndexOffline')),
          el('button', { type: 'button', class: 'btn tonal small', onclick: () => void paint(true) }, d.icon('refresh'), d.t('themeRetry')));
        draw(); return;
      }
      have = await installed(d.io);
      const rows = index!.map((e) => {
        const known = THEMES.find((x) => (x.pack?.id ?? x.id) === e.id);
        const here = !!have[e.id];
        return el('div', { class: 'tg-addrow' }, el('div', { class: 'grow' }, el('b', null, known ? themeName(known, d.t) : e.name), el('small', { class: 'src' }, [e.by ? d.t('themeBy', { who: e.by }) : '', d.formatBytes(e.size)].filter(Boolean).join(' · '))),
          here ? el('span', { class: 'tg-here' }, d.icon('check'), d.t('themeHere'))
            : el('button', { type: 'button', class: 'btn tonal small', onclick: async (ev: Event) => {
              const b = ev.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = d.t('themeDownloadingShort');
              try { await installPack(d.io, e.id); have = await installed(d.io); const def = have[e.id]?.def as ThemeDef | undefined; if (def) registerTheme(def); d.toast(d.t('themeInstalled', { name: known ? themeName(known, d.t) : e.name })); void paint(false); draw(); }
              catch (er) { b.disabled = false; b.replaceChildren(d.icon('refresh'), d.t('themeRetry')); d.toast(errText(er instanceof PackError ? er : new PackError('offline', String(er)), known ?? { id: e.id, pack: { id: e.id, size: e.size, assets: {} } }), 'error'); }
            } }, d.icon('download'), d.t('themeGet', { size: d.formatBytes(e.size) })));
      });
      list.replaceChildren(...(rows.length ? rows : [el('p', { class: 'hint tg-empty' }, d.t('themeAddEmpty'))]));
      draw();
    };
    void paint(false);
  }

  let drawing = 0;
  async function draw(): Promise<void> {
    const my = ++drawing;
    const pics: Record<string, string> = {};
    for (const def of THEMES) if (def.pack && have[def.pack.id]) Object.assign(pics, await pictureUrls(d.io, def.pack.id));
    if (my !== drawing) return;
    const mineDefs = THEMES.filter((x) => x.custom && x.id !== 'my-preview');
    for (const def of mineDefs) if (d.mine) { const ex = await d.mineLoader?.(def.id); if (ex) Object.assign(pics, ex); }
    if (my !== drawing) return;
    grid.replaceChildren(...THEMES.filter((x) => !x.custom).map((def) => card(def, pics)), addTile(),
      ...(d.mine ? [el('h4', { class: 'tg-section' }, d.t('myThemes')),
        ...(mineDefs.length ? mineDefs.map((def) => card(def, pics)) : [el('p', { class: 'tg-mine-empty hint' }, d.t('myThemesEmpty'))]),
        el('div', { class: 'tg-mine-actions' },
          el('button', { type: 'button', class: 'btn tonal small', onclick: () => d.mine!.customise(d.current().theme) }, d.icon('pencil'), d.t('editorCustomiseCurrent')),
          el('button', { type: 'button', class: 'btn text small', onclick: () => d.mine!.importTheme() }, d.icon('download'), d.t('myImport')))] : []));
    grid.dataset.index = indexState;
  }
  void (async () => {
    have = await installed(d.io);
    for (const rec of Object.values(have)) if (rec.def) registerTheme(rec.def as ThemeDef);
    await draw();
    try { index = (await loadIndex(d.io)).themes; indexState = 'ok'; } catch { indexState = 'offline'; }
    void draw();
  })();
  (grid as HTMLElement & { redraw?: () => void }).redraw = () => void draw();
  return grid;
}
