// Kurokawa in other apps' lists (Android): what another app handed in through one of the «Open with» / «Share»
// entries (native/android/openwith.json → KtOpenActivity → #/open?kind=…), opened in Kurokawa's own screens — an
// archive as a folder with its extraction one tap away, archives shared straight into the extraction sheet, a folder,
// a picture (with its folder's other pictures when it is a file here), a text in the editor, or any file in a small
// «What do you want to do with this file?» sheet. Back where it began hands back to the calling app. Also here: the
// switches of every entry (Settings → Files → «Show Kurokawa in other apps», phones only), Files' own app chooser
// («Just once» / «Always») and the list of the defaults chosen.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, formatBytes } from '../i18n';
import { ktPlugin } from '../native';
import { navigate, previousPath } from '../router';
import type { Entry } from './files';
import { ENTRIES, isOn, parseOpen, stepFor, parentOf, extOf, loadDefaults, setDefault, chooserList, type OpenItem, type OpenRequest, type OwEntry, type AppChoice, type OwnWay, type DefaultApp } from './openWithLogic';

type Listener = { remove(): void };
export type OwPlug = {
  openRequest?(): Promise<{ request: string | null }>; openDone?(o: { id: string; back: boolean }): Promise<void>;
  openFetch?(o: { uri: string; jobId: string; dir?: string }): Promise<{ path: string; size: number }>; openFetchCancel?(o: { jobId: string }): Promise<void>;
  uriRead?(o: { uri?: string; path?: string; max: number; offset?: number }): Promise<{ b64: string; size: number; whole: boolean }>; uriWrite?(o: { uri?: string; path?: string; b64: string }): Promise<unknown>;
  contentUrl?(o: { uri: string }): Promise<{ url: string }>; openWithStates?(o: { names: string[] }): Promise<{ states: Record<string, number> }>; openWithSet?(o: { name: string; state: 'on' | 'off' | 'default' }): Promise<void>;
  appsFor?(o: { path: string; mime: string }): Promise<{ apps: AppChoice[] }>; openIn?(o: { path: string; mime: string; pkg: string; cls: string }): Promise<void>;
  filesList?(o: { path: string }): Promise<{ exists: boolean; entries: Entry[] }>; hashFile?(o: { path: string }): Promise<{ md5: string; sha1: string; sha256: string }>;
  shareFile?(o: { path: string; title: string }): Promise<void>; pickDir?(): Promise<{ dir: string } | null>;
  addListener?(ev: string, fn: (o: { jobId: string; done: number; total: number }) => void): Promise<Listener>;
};
const plug = (): OwPlug | null => ktPlugin() as unknown as OwPlug | null;
const DOWNLOADS = '/storage/emulated/0/Download';
const entryOf = (it: OpenItem, path = it.path ?? it.uri): Entry => ({ name: it.name, path, dir: it.dir, size: Math.max(0, it.size), mtime: 0, ext: extOf(it.name) });

/** A link that is not a file here, copied (to the app's cache, or into `dir`) with its progress and Cancel; null when cancelled or unreadable. */
export async function fetchLocal(it: OpenItem, dir?: string): Promise<string | null> {
  if (it.path && !dir) return it.path;
  const p = plug(); if (!p?.openFetch) return null;
  const jobId = `of-${Date.now().toString(36)}`; let cancelled = false;
  const sh = openSheet(dir ? t('owCopyTo') : t('owCopying'), t('cancel'), { onClose: () => { if (!done) { cancelled = true; void p.openFetchCancel?.({ jobId }); } } }); let done = false;
  const bar = h('div', { class: 'task-bar' }, h('i')); const line = h('p', { class: 'src', dir: 'auto' }, it.name);
  sh.body.append(...(dir ? [] : [h('p', { class: 'hint' }, t('owCopyWhy'))]), line, bar);
  const sub = await p.addListener?.('openProgress', (ev) => { if (ev.jobId !== jobId) return; const pct = ev.total > 0 ? Math.min(100, Math.round((ev.done / ev.total) * 100)) : 0; (bar.firstChild as HTMLElement).style.width = `${pct}%`; line.textContent = `${it.name} · ${formatBytes(ev.done)}${ev.total > 0 ? ' / ' + formatBytes(ev.total) : ''}`; }).catch(() => null);
  try { const r = await p.openFetch({ uri: it.path ? `file://${it.path}` : it.uri, jobId, ...(dir ? { dir } : {}) }); done = true; sh.close(); return r.path; }
  catch (e) { done = true; sh.close(); if (!cancelled) toast(t('owUnreadable'), 'error', 4000); void e; return null; }
  finally { sub?.remove(); }
}

/** The page for what another app handed in. */
export function openWithView(route: { kind: string; id: string }): HTMLElement & { dispose?: () => void } {
  const host = h('div', { class: 'openwith-host', style: { display: 'contents' } }, h('div', { class: 'center' }, h('div', { class: 'spinner' }))) as HTMLElement & { dispose?: () => void };
  const p = plug(); let req: OpenRequest | null = null; let left = false; let gone = false; let pane: (HTMLElement & { dispose?: () => void }) | null = null;
  /** Done, once: the invisible activity in the calling app's task ends; `back`: that app comes to the front. */
  const leave = (back: boolean) => {
    if (left) return; left = true; void p?.openDone?.({ id: req?.id ?? route.id, back }).catch(() => undefined);
    if (back && !gone) { if (previousPath()) history.back(); else navigate('/files', true); }
  };
  const banner = () => h('div', { class: 'ow-banner', role: 'note' }, icon('external'), h('span', { class: 'grow', dir: 'auto' }, req?.caller ? t('owFrom', { app: req.caller }) : t('owFromApp')),
    h('button', { type: 'button', class: 'btn text small', onclick: () => leave(true) }, t('owHandBack')));
  const calm = (text: string) => {
    host.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'body' }, banner(), h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('file')), h('p', null, text),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal', onclick: () => void start() }, icon('refresh'), t('retry')), h('button', { type: 'button', class: 'btn primary', onclick: () => leave(true) }, t('close')))))));
  };
  const showPane = async (path: string, extra?: HTMLElement) => {
    const { filesPane } = await import('./files'); if (gone) return;
    pane?.dispose?.(); pane = filesPane({ p: path }, { handedIn: { start: path, leave: () => leave(true) } });
    host.replaceChildren(h('div', { class: 'ow-wrap' }, banner(), extra ?? null), pane);
  };
  const start = async () => {
    host.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
    const got = p?.openRequest ? await p.openRequest().catch(() => null) : null; if (gone) return;
    req = parseOpen(got?.request ?? null);
    if (!req) { host.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'body' }, h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('folder')), h('p', null, t('owNoRequest')), h('button', { type: 'button', class: 'btn tonal', onclick: () => { left = true; navigate('/files', true); } }, t('close')))))); return; }
    const step = stepFor(req); const r = req;
    switch (step.to) {
      case 'error': calm(step.why === 'nothing' ? t('owNothing') : step.why === 'notHere' ? t('owNotHere') : t('owUnreadable')); return;
      case 'folder': await showPane(step.path); return;
      case 'downloads': await showPane(DOWNLOADS); return;
      case 'archive': {
        const local = await fetchLocal(step.item); if (gone) return; if (!local) { calm(t('owUnreadable')); return; }
        const { arcPath } = await import('./filesArc'); const { extractSheet } = await import('./extract');
        const ex = h('button', { type: 'button', class: 'btn tonal small', onclick: () => void extractSheet(local, step.item.path ? {} : { dest: DOWNLOADS }) }, icon('archive'), t('owExtract'));
        await showPane(arcPath(local), ex); return;
      }
      case 'extract': {
        const locals: string[] = []; for (const it of step.items) { const l = await fetchLocal(it); if (gone) return; if (l) locals.push(l); }
        if (!locals.length) { calm(t('owUnreadable')); return; }
        const allHere = step.items.every((x) => x.path);
        await showPane(allHere ? parentOf(locals[0]) : DOWNLOADS);
        const { extractMany } = await import('./extract'); void extractMany(locals, { ...(allHere ? {} : { dest: DOWNLOADS }), onClose: () => leave(true) }); return;
      }
      case 'viewer': {
        const it = step.item; if (it.path) await showPane(parentOf(it.path)); else host.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'body' }, banner())));
        const fm = await import('./filesMore'); const { localFileUrl } = await import('../player/files');
        let items: Entry[] = [entryOf(it)]; let urlOf = async (_: string) => (await p?.contentUrl?.({ uri: it.uri }).catch(() => null))?.url ?? null;
        if (it.path) {
          const listed = await p?.filesList?.({ path: parentOf(it.path) }).catch(() => null);
          const pics = (listed?.entries ?? []).filter((e) => !e.dir && /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
          items = pics.some((e) => e.path === it.path) ? pics : [entryOf(it)]; urlOf = localFileUrl;
        }
        await fm.imageViewer(items, Math.max(0, items.findIndex((e) => e.path === (it.path ?? it.uri))), urlOf, () => undefined, { readOnly: true, onClose: () => leave(true) }); return;
      }
      case 'editor': {
        const it = step.item; if (it.path) await showPane(parentOf(it.path)); else host.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'body' }, banner())));
        await openText(it, r, () => leave(true)); return;
      }
      case 'any': {
        const it = step.item; if (it.path) await showPane(parentOf(it.path)); else host.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'body' }, banner())));
        anyFileSheet(it, r, { leave, showFolder: () => { /* the pane behind is that folder already */ }, openArchive: async () => { const l = await fetchLocal(it); if (!l) return; const { arcPath } = await import('./filesArc'); await showPane(arcPath(l)); } });
      }
    }
  };
  void start();
  // (Left another way — another tab —: the calling app is not kept waiting behind an invisible layer.)
  host.dispose = () => { gone = true; pane?.dispose?.(); if (!left) { left = true; void p?.openDone?.({ id: req?.id ?? route.id, back: false }).catch(() => undefined); } };
  return host;
}

/** The text editor on a handed-in file: through its path when it is a file here, else through the link (written back
 *  only when the other app allowed changes). */
async function openText(it: OpenItem, req: OpenRequest, onClose: () => void, readOnly = false): Promise<void> {
  const fm = await import('./filesMore'); const p = plug(); const { fromB64, toB64 } = await import('./textCodec');
  const io: import('./filesMore').EditorIo = it.path ? { ...(fm.fileIo(it.path) ?? { read: async () => ({ bytes: new Uint8Array(), size: 0, whole: true }) }) } : {
    read: async (o) => { const r = await p!.uriRead!({ uri: it.uri, max: o?.max ?? 5_000_000, offset: o?.offset }); return { bytes: fromB64(r.b64), size: r.size, whole: r.whole }; },
    ...(req.writable ? { write: async (b: Uint8Array) => { await p!.uriWrite!({ uri: it.uri, b64: toB64(b) }); } } : {}),
  };
  if (readOnly) delete io.write;
  await fm.editorSheet(entryOf(it), () => undefined, io, onClose);
}

/** «What do you want to do with this file?» — any file handed in («Open with Kurokawa Files»). */
export function anyFileSheet(it: OpenItem, req: OpenRequest, o: { leave: (back: boolean) => void; showFolder: () => void; openArchive: () => Promise<void> }): void {
  let handed = false; const p = plug();
  const sh = openSheet(t('owAnyTitle'), t('close'), { onClose: () => { if (!handed) o.leave(true); } }); sh.el.classList.add('ow-any');
  const go = (fn: () => void) => () => { handed = true; sh.close(); fn(); };
  const row = (ic: string, label: string, hint?: string) => h('button', { type: 'button', class: 'dest-row ow-row' }, h('span', { class: 'files-drawer-ic' }, icon(ic)), h('span', { class: 'grow files-main' }, h('span', { class: 'name' }, label), hint ? h('small', { class: 'src' }, hint) : null));
  const bind = (b: HTMLElement, fn: () => void) => { b.addEventListener('click', fn); return b; };
  const head = h('div', { class: 'ow-file' }, h('span', { class: 'ow-file-ic' }, icon('file')), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, it.name), h('small', { class: 'src' }, [it.size >= 0 ? formatBytes(it.size) : '', it.mime || '', req.caller ? t('owFrom', { app: req.caller }) : ''].filter(Boolean).join(' · '))));
  const looksArc = /\.(zip|cbz|7z|rar|tar|tgz|txz|tbz2|gz|xz|bz2|001|z01)$/i.test(it.name);
  sh.body.append(head,
    ...(it.path ? [bind(row('folder', t('filesShowInFolder')), go(() => o.showFolder()))] : []),
    bind(row('copy', t('owCopyTo')), () => void (async () => { const d = await p?.pickDir?.().catch(() => null); if (!d?.dir) return; const to = await fetchLocal(it, d.dir); if (to) toast(t('owCopied', { dir: d.dir }), 'info', 3500); })()),
    ...(looksArc ? [bind(row('archive', t('filesOpenAsArchive')), go(() => { void o.openArchive(); }))] : []),
    bind(row('type', t('owViewAsText')), go(() => void openText(it, req, () => o.leave(true), !req.writable))),
    bind(row('info', t('properties')), () => propertiesSheet(it, req)),
    ...(p?.shareFile ? [bind(row('share', t('share')), () => void (async () => { const l = await fetchLocal(it); if (l) await p.shareFile!({ path: l, title: it.name }); })())] : []));
}

/** A handed-in file's properties: name, size, type, where it is, its checksum (computed on demand). */
function propertiesSheet(it: OpenItem, req: OpenRequest): void {
  const p = plug(); const sh = openSheet(t('properties'), t('close'), { stack: true });
  const line = (k: string, v: string) => h('div', { class: 'files-prop' }, h('small', { class: 'src' }, k), h('span', { dir: 'auto' }, v));
  const sums = h('div', { class: 'files-prop' }, h('small', { class: 'src' }, t('filesChecksums')), h('button', { type: 'button', class: 'btn small tonal', onclick: async () => {
    sums.replaceChildren(h('small', { class: 'src' }, t('filesChecksums')), h('span', null, '…'));
    try {
      let r: Record<string, string>;
      if (it.path && p?.hashFile) r = await p.hashFile({ path: it.path }) as unknown as Record<string, string>;
      else { const l = await fetchLocal(it); if (!l || !p?.hashFile) throw new Error(t('owUnreadable')); r = await p.hashFile({ path: l }) as unknown as Record<string, string>; }
      sums.replaceChildren(h('small', { class: 'src' }, t('filesChecksums')), ...['md5', 'sha1', 'sha256'].filter((k) => r[k]).map((k) => h('div', { class: 'files-sum' }, h('small', { class: 'src' }, k.toUpperCase()), h('code', { dir: 'ltr' }, r[k]))));
    } catch (e) { sums.append(h('span', null, String((e as Error).message ?? e))); }
  } }, icon('shield'), t('filesCompute')));
  sh.body.append(line(t('owName'), it.name), line(t('fileSize'), it.size >= 0 ? formatBytes(it.size) : '—'), line(t('filesKind'), it.mime || '—'), line(t('owWhere'), it.path ?? (req.caller ? t('owFrom', { app: req.caller }) : t('owFromApp'))), sums);
}

/* ---------- Settings → Files → «Show Kurokawa in other apps» (phones only) ---------- */
const HINT: Record<string, string> = { archive: 'owHintArchive', archiveShare: 'owHintArchiveShare', folder: 'owHintFolder', image: 'owHintImage', text: 'owHintText', any: 'owHintAny', browse: 'owHintBrowse', save: 'owHintSave', pick: 'owHintPick', installer: 'owHintInstaller', player: 'owHintPlayer' };
const LABEL: Record<string, string> = { archive: 'owLabelArchive', archiveShare: 'owLabelArchiveShare', folder: 'owLabelFolder', image: 'owLabelImage', text: 'owLabelText', any: 'owLabelAny', browse: 'owLabelBrowse', save: 'owLabelSave', pick: 'owLabelPick', installer: 'owLabelInstaller', player: 'owLabelPlayer' };
export const entryLabel = (e: OwEntry): string => t(LABEL[e.id] as 'owLabelArchive');
/** Whether this device can show the switches: Android only (a computer has no such lists). */
export const canSwitchEntries = (): boolean => !!plug()?.openWithSet && !!plug()?.openWithStates;

export async function otherAppsSheet(): Promise<void> {
  const p = plug(); if (!p?.openWithSet || !p.openWithStates) return;
  const sh = openSheet(t('owSettingsRow'), t('close')); sh.el.classList.add('ow-settings');
  const list = h('div', { class: 'ow-list' }); sh.body.append(h('p', { class: 'hint' }, t('owSettingsHint')), list, h('p', { class: 'hint ow-note' }, t('owAndroidDelay')));
  const draw = async () => {
    const st = (await p.openWithStates!({ names: ENTRIES.map((e) => e.alias) }).catch(() => ({ states: {} as Record<string, number> }))).states;
    list.replaceChildren(...ENTRIES.map((e) => {
      const input = h('input', { type: 'checkbox', checked: isOn(e, st[e.alias]), 'data-alias': e.alias, onchange: async (ev: Event) => { const on = (ev.target as HTMLInputElement).checked; try { await p.openWithSet!({ name: e.alias, state: on === e.on ? 'default' : on ? 'on' : 'off' }); } catch (err) { (ev.target as HTMLInputElement).checked = !on; toast(String((err as Error).message ?? err), 'error'); } } }) as HTMLInputElement;
      return h('label', { class: 'row switch-row ow-switch' }, h('span', null, entryLabel(e), h('small', { class: 'src' }, t(HINT[e.id] as 'owHintArchive'))), input);
    }));
  };
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: async () => { for (const e of ENTRIES) await p.openWithSet!({ name: e.alias, state: 'default' }).catch(() => undefined); await draw(); toast(t('owResetDone')); } }, icon('undo'), t('owResetDefaults')));
  await draw();
}

/* ---------- Files' own chooser: «Open with…», «Just once» / «Always» ---------- */
const WAY: Record<OwnWay, string> = { player: 'owWayPlayer', viewer: 'owWayViewer', editor: 'owWayEditor', archive: 'owWayArchive', installer: 'owWayInstaller', system: 'owWaySystem' };
const WAY_ICON: Record<OwnWay, string> = { player: 'play', viewer: 'images', editor: 'type', archive: 'archive', installer: 'apps', system: 'external' };
export const wayLabel = (w: OwnWay): string => t(WAY[w] as 'owWayPlayer');
export const defaultFor = (name: string): DefaultApp | null => loadDefaults(localStorage)[extOf(name)] ?? null;
export const forgetDefault = (ext: string): void => { setDefault(localStorage, ext, null); };

/** The chooser for a file of Files: Kurokawa's ways first, then the phone's apps that open it; a row chosen, then
 *  «Just once» or «Always» (kept for the extension). Resolves with the choice, or null when closed. */
export function chooseOpener(e: { name: string; path: string }, mime: string, pc: boolean): Promise<DefaultApp | null> {
  return new Promise((resolve) => {
    let picked: DefaultApp | null = null; let answered = false;
    const sh = openSheet(t('owOpenWithTitle', { name: e.name }), t('close'), { onClose: () => { if (!answered) resolve(null); } }); sh.el.classList.add('ow-chooser');
    const list = h('div', { class: 'ow-apps', role: 'listbox' }, h('div', { class: 'center' }, h('div', { class: 'spinner small' })));
    const once = h('button', { type: 'button', class: 'btn tonal', disabled: true, onclick: () => finish(false) }, t('owJustOnce')) as HTMLButtonElement;
    const always = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => finish(true) }, t('owAlways')) as HTMLButtonElement;
    const finish = (keep: boolean) => { if (!picked) return; answered = true; const ext = extOf(e.name); if (keep && ext) { setDefault(localStorage, ext, picked); toast(t('owAlwaysSet', { ext, app: 'own' in picked ? wayLabel(picked.own) : picked.app.label })); } sh.close(); resolve(picked); };
    sh.body.append(list); sh.actions.append(once, always);
    void (async () => {
      const p = plug(); const apps = !pc && p?.appsFor ? (await p.appsFor({ path: e.path, mime }).catch(() => ({ apps: [] as AppChoice[] }))).apps : [];
      const rows = chooserList(e.name, apps, pc);
      list.replaceChildren(...rows.map((r) => {
        const b = h('button', { type: 'button', class: 'dest-row ow-app', role: 'option', 'aria-selected': 'false', onclick: () => { picked = r; list.querySelectorAll('.ow-app').forEach((x) => x.setAttribute('aria-selected', String(x === b))); once.disabled = always.disabled = false; } },
          'own' in r ? h('span', { class: 'ow-app-ic own' }, icon(WAY_ICON[r.own])) : r.app.icon ? h('img', { class: 'ow-app-ic', src: r.app.icon, alt: '' }) : h('span', { class: 'ow-app-ic' }, icon('apps')),
          h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, 'own' in r ? wayLabel(r.own) : r.app.label), 'own' in r && r.own !== 'system' ? h('small', { class: 'src' }, t('owKurokawa')) : null));
        return b;
      }), ...(!pc && !apps.length ? [h('p', { class: 'hint' }, t('owNoApps'))] : []));
    })();
  });
}

/** Settings → Files → «Default apps»: each extension's choice, removable. */
export function defaultAppsSheet(): void {
  const sh = openSheet(t('owDefaultApps'), t('close')); sh.el.classList.add('ow-defaults'); const list = h('div', { class: 'ow-list' });
  const draw = () => {
    const all = Object.entries(loadDefaults(localStorage)).sort(([a], [b]) => a.localeCompare(b));
    list.replaceChildren(...(all.length ? all.map(([ext, d]) => h('div', { class: 'row ow-default' }, h('span', { class: 'ow-ext', dir: 'ltr' }, `.${ext}`), h('span', { class: 'grow', dir: 'auto' }, 'own' in d ? wayLabel(d.own) : d.app.label),
      h('button', { type: 'button', class: 'btn text small', onclick: () => { forgetDefault(ext); draw(); } }, t('remove')))) : [h('p', { class: 'empty small' }, t('owNoDefaults'))]));
  };
  sh.body.append(h('p', { class: 'hint' }, t('owDefaultAppsHint')), list); draw();
}
