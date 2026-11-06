// The installed apps as a place in the Files browser (Solid Explorer's way): `apps://` lists them — name, package,
// version, size, their icon — and `apps://<package>` is the app's folder: its base APK and split APKs (opened as
// archives, installed, shared), its data, obb and media folders when they are there (through the grant the
// system wants, or root), and the app's own doings: backed up to a folder as one .apk or an .apks bundle, launched,
// its settings page, uninstalled.
import { h, icon, openSheet, toast, pickSheet } from '../ui/dom';
import { t, formatBytes, localDigits, dateLocale } from '../i18n';
import { ktPlugin } from '../native';
import type { Entry } from './files';
import { db } from '../db';

export interface App { pkg: string; name: string; version: string; versionCode: number; size: number; system: boolean; installedAt: number; updatedAt: number; splits: number; enabled: boolean }
export interface AppDetail { pkg: string; name: string; version: string; apks: { name: string; path: string; size: number; mtime: number }[]; data: string; dataExists: boolean; dataReadable: boolean; obb: string; obbExists: boolean; obbReadable: boolean; media: string; mediaExists: boolean; nativeLibs: string; system: boolean; installedAt: number; updatedAt: number; installer: string }
type P = { appsList(o: { system?: boolean }): Promise<{ apps: App[] }>; appsIcon(o: { pkg: string }): Promise<{ url: string | null }>; appsDetail(o: { pkg: string }): Promise<AppDetail>; appsBackup(o: { pkg: string; dest: string }): Promise<{ path: string }>; appsAct(o: { pkg: string; what: 'launch' | 'info' | 'uninstall' }): Promise<void>; shareFile?(o: { path: string; title: string }): Promise<void> };
const pl = (): P | null => { const p = ktPlugin() as unknown as P | null; return p?.appsList ? p : null; };
export const appsAvailable = (): boolean => !!pl();
export const isApps = (p: string): boolean => p.startsWith('apps://');
export const appsPath = (pkg = ''): string => `apps://${pkg}`;
export const parseApps = (p: string): { pkg: string; rest: string } => { const m = /^apps:\/\/([^/]*)(?:\/(.*))?$/.exec(p); return { pkg: m?.[1] ?? '', rest: m?.[2] ?? '' }; };
let cache: { at: number; system: boolean; apps: App[] } | null = null; let showSystem = false;
export const setShowSystem = (v: boolean): void => { showSystem = v; cache = null; };
export const showingSystem = (): boolean => showSystem;
export async function apps(): Promise<App[]> {
  const p = pl(); if (!p) return []; if (cache && cache.system === showSystem && Date.now() - cache.at < 60e3) return cache.apps;
  const r = await p.appsList({ system: showSystem }); const list = (r.apps ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })); cache = { at: Date.now(), system: showSystem, apps: list }; return list;
}
const details = new Map<string, AppDetail>();
export async function detail(pkg: string): Promise<AppDetail> { const had = details.get(pkg); if (had) return had; const d = await pl()!.appsDetail({ pkg }); details.set(pkg, d); return d; }
/** An app's icon: the one chosen for it here (cropped from any picture), else its own. */
export const appIcon = async (pkg: string): Promise<string | null> => { const mine = await customAppIcon(pkg); if (mine) return mine; try { return (await pl()!.appsIcon({ pkg })).url; } catch { return null; } };
const ICON_KEY = (pkg: string) => `appicon:${pkg}`;
export const customAppIcon = (pkg: string): Promise<string | undefined> => db.getMeta<string>(ICON_KEY(pkg)).catch(() => undefined);
/** The icons of this app already on the page, drawn anew. */
const redrawIcon = async (pkg: string) => { const u = await appIcon(pkg); if (!u) return; document.querySelectorAll<HTMLElement>(`[data-thumb="${CSS.escape(appsPath(pkg))}"]`).forEach((el) => { el.replaceChildren(h('img', { src: u, alt: '', loading: 'lazy' })); el.classList.add('has-img'); }); };

/** The listing: the apps at the root (each a folder whose «size» is its APKs' and whose count is its split count), an app's files inside. */
export async function appsList(path: string): Promise<{ exists: boolean; entries: (Entry & { pkg?: string; sub?: string; special?: 'data' | 'obb' | 'media' })[] }> {
  const { pkg } = parseApps(path);
  if (!pkg) { const list = await apps(); return { exists: true, entries: list.map((a) => ({ name: a.name, path: appsPath(a.pkg), dir: true, size: a.size, mtime: a.updatedAt, count: a.splits ? a.splits + 1 : 1, pkg: a.pkg, sub: `${a.pkg} · ${a.version}` })) }; }
  const d = await detail(pkg); const out: (Entry & { pkg?: string; sub?: string; special?: 'data' | 'obb' | 'media' })[] = d.apks.map((f) => ({ name: f.name, path: f.path, dir: false, size: f.size, mtime: f.mtime, ext: 'apk', pkg }));
  if (d.dataExists) out.push({ name: t('appsDataFolder'), path: d.data, dir: true, size: 0, mtime: 0, special: 'data', pkg, sub: d.dataReadable ? d.data : t('appsNeedsGrant') });
  if (d.obbExists) out.push({ name: t('appsObbFolder'), path: d.obb, dir: true, size: 0, mtime: 0, special: 'obb', pkg, sub: d.obbReadable ? d.obb : t('appsNeedsGrant') });
  if (d.mediaExists) out.push({ name: t('appsMediaFolder'), path: d.media, dir: true, size: 0, mtime: 0, special: 'media', pkg, sub: d.media });
  return { exists: true, entries: out };
}
/** Where an app's data/obb folder is read from: as it is when readable, else the granted tree (saf://) that covers it, else root. */
export function resolveSpecial(e: { path: string; sub?: string }, trees: { id: number | string; uri: string; name: string }[], shell: string | null): string | null {
  if (e.sub && !e.sub.includes(t('appsNeedsGrant'))) return e.path;
  const rel = e.path.replace(/^\/storage\/emulated\/0\//, '');
  // (A granted tree's uri ends in «tree/primary:Android/data» — the folder it covers, under the phone's storage.)
  const covered = (uri: string): string | null => { const m = /\/tree\/([^/]+)$/.exec(uri); if (!m) return null; const id = decodeURIComponent(m[1]); const i = id.indexOf(':'); return i < 0 ? null : id.startsWith('primary') ? id.slice(i + 1) : null; };
  const tree = trees.map((tr) => ({ tr, at: covered(tr.uri) })).find((x) => x.at !== null && (rel === x.at || rel.startsWith(x.at + '/')));
  if (tree) return `saf://${tree.tr.id}/${rel.slice(tree.at!.length).replace(/^\//, '')}`.replace(/\/$/, '');
  if (shell) return `root://${e.path}`;
  return null;
}
/** The app's own sheet: backup, share its APK, open as archive, launch, settings, uninstall. */
export function appSheet(pkg: string, name: string, o: { go: (p: string) => void; pickDir: () => Promise<string | null>; defaultDir: string }): void {
  const sh = openSheet(name, t('close')); const p = pl()!;
  const row = (ic: string, label: string, fn: () => void, sub?: string) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow files-main' }, h('span', { class: 'name' }, label), sub ? h('small', { class: 'src' }, sub) : null));
  void Promise.all([detail(pkg), customAppIcon(pkg)]).then(([d, mine]) => { const hasCustom = !!mine;
    const head = h('p', { class: 'hint', dir: 'auto' }, `${pkg} · ${d.version} · ${d.installer && d.installer !== 'null' ? t('appsInstaller', { by: d.installer }) + ' · ' : ''}${t('appsUpdated', { d: new Date(d.updatedAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) })}`);
    sh.body.replaceChildren(head, h('div', { class: 'dest-list' },
      row('folder', t('appsOpenFolder'), () => o.go(appsPath(pkg)), localDigits(String(d.apks.length)) + ' APK'),
      row('archive', t('appsBrowseApk'), () => o.go(`arc://${encodeURIComponent(d.apks[0].path)}`)),
      row('download', t('appsBackup'), () => void pickSheet(t('appsBackupWhere'), [[o.defaultDir, t('appsBackupDefault'), 'download'], ['pick', t('changeFolder'), 'folder']], o.defaultDir, async (choice) => { const dest = choice === 'pick' ? await o.pickDir() : choice; if (!dest) return; const busy = toast(t('appsBackingUp', { name })); void busy; try { const r = await p.appsBackup({ pkg, dest }); toast(t('appsBackedUp', { path: r.path }), undefined, 6000); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }), d.apks.length > 1 ? t('appsBackupBundle') : t('appsBackupOne')),
      ...(p.shareFile ? [row('share', t('share'), () => void p.shareFile!({ path: d.apks[0].path, title: `${name}.apk` }))] : []),
      row('play', t('appsLaunch'), () => void p.appsAct({ pkg, what: 'launch' }).catch(() => toast(t('appsNotLaunchable'), 'error'))),
      row('images', t('appIconChange'), () => void import('../ui/iconCrop').then(async (m) => { const u = await m.pickIconImage(); if (!u) return; await db.setMeta(ICON_KEY(pkg), u); await redrawIcon(pkg); toast(t('appIconChanged')); }), t('appIconChangeHint')),
      ...(hasCustom ? [row('refresh', t('appIconReset'), () => void db.deleteMeta(ICON_KEY(pkg)).then(() => redrawIcon(pkg)))] : []),
      row('settings', t('appsInfo'), () => void p.appsAct({ pkg, what: 'info' })),
      row('trash', t('appsUninstall'), () => void p.appsAct({ pkg, what: 'uninstall' }))));
  }).catch((e) => sh.body.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))));
  sh.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
}
export const appsHeader = (): HTMLElement => h('label', { class: 'check-row files-apps-sys' }, h('input', { type: 'checkbox', checked: showSystem, onchange: (e: Event) => { setShowSystem((e.target as HTMLInputElement).checked); } }), h('span', null, t('appsShowSystem')));
export const byteSize = formatBytes;
