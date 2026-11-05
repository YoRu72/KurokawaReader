// The Files add-on's network storages: saved connections (FTP/FTPS, SFTP, SMB, WebDAV) shown as storages, a
// connection wizard, the server's host key or certificate accepted by its fingerprint, a scan of the LAN for
// servers, and transfers as jobs (down into a folder, up from the device). Paths are `remote://<id>/<path>`.
import { h, icon, toast, openSheet, pickButton } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { ktPlugin } from '../native';

export interface Conn { id: string; kind: 'ftp' | 'ftps' | 'sftp' | 'smb' | 'webdav' | 'nextcloud' | 'gdrive' | 'dropbox' | 'onedrive'; name: string; host: string; port?: number; path?: string; user?: string; domain?: string; share?: string; clientId?: string; hasPass?: boolean; hasKey?: boolean; signedIn?: boolean; trust?: string }
type REntry = { name: string; dir: boolean; size: number; mtime: number };
type RPlug = {
  remoteConnections(): Promise<{ list: Conn[] }>; remoteSave(c: Partial<Conn> & { pass?: string; key?: string }): Promise<{ id: string }>; remoteRemove(o: { id: string }): Promise<void>; remoteTrust(o: { id: string; fingerprint: string }): Promise<void>;
  remoteTest(o: { id: string; path?: string }): Promise<{ entries: REntry[] }>; remoteList(o: { id: string; path: string }): Promise<{ entries: REntry[] }>; remoteMkdir(o: { id: string; path: string }): Promise<void>;
  remoteDelete(o: { id: string; paths: string[]; dirs: string[] }): Promise<void>; remoteRename(o: { id: string; path: string; to: string }): Promise<void>; remoteFetch(o: { id: string; path: string; jobId?: string }): Promise<{ path: string; size: number }>;
  remoteJob(o: { id?: string; op: 'down' | 'up'; conn: string; paths: string[]; dest: string; deleteAfter?: boolean }): Promise<{ id: string }>; remoteSignIn(o: { id: string }): Promise<void>; remoteNextcloud(o: { id: string }): Promise<void>; remoteCancel(o: { id: string }): Promise<void>; remoteScan(): Promise<{ hosts: { ip: string; ports: number[]; name?: string }[]; mine: string }>; remoteScanStop(): Promise<void>;
};
export const rplug = (): RPlug | null => { const p = ktPlugin() as unknown as RPlug | null; return p?.remoteConnections ? p : null; };

export const isRemote = (p: string): boolean => p.startsWith('remote://');
/** Any place that is not a plain path: a network storage, the root shell, or a granted tree. */
export const isVirtual = (p: string): boolean => /^(remote|root|saf|arc):\/\//.test(p);
const isArc = (p: string): boolean => p.startsWith('arc://');
type VfsPlug = { vfsRoots(): Promise<{ shell: 'root' | 'shizuku' | null; trees: { id: number; uri: string; name: string }[]; shizuku: boolean }>; vfsShizukuAsk(): Promise<{ asked: boolean }>; vfsList(o: { path: string }): Promise<{ entries: (REntry & { mode?: string; owner?: string; link?: string })[] }>; vfsFetch(o: { path: string; jobId?: string }): Promise<{ path: string; size: number }>; vfsMkdir(o: { path: string; name: string }): Promise<void>; vfsDelete(o: { paths: string[] }): Promise<void>; vfsRename(o: { path: string; name: string }): Promise<void>; vfsJob(o: { id?: string; op: 'down' | 'up'; paths: string[]; dest: string; deleteAfter?: boolean }): Promise<{ id: string }>; vfsRootOp(o: { what: string; path?: string; arg?: string }): Promise<{ out?: string; mounts?: { device: string; point: string; type: string; ro: boolean }[] }>; vfsGrant(o: { start?: string }): Promise<{ trees: { id: number; uri: string; name: string }[] }>; vfsForgetTree(o: { id: number }): Promise<void> };
export const vplug = (): VfsPlug | null => { const p = ktPlugin() as unknown as VfsPlug | null; return p?.vfsRoots ? p : null; };
export type VRoots = { shell: 'root' | 'shizuku' | null; trees: { id: number; uri: string; name: string }[]; shizuku: boolean };
export async function vfsRoots(): Promise<VRoots> { const p = vplug(); if (!p) return { shell: null, trees: [], shizuku: false }; try { const r = await p.vfsRoots(); return { shell: r?.shell ?? null, trees: Array.isArray(r?.trees) ? r.trees : [], shizuku: !!r?.shizuku }; } catch { return { shell: null, trees: [], shizuku: false }; } }
/* One face over the three: list, fetch into the cache, transfer jobs, folders, delete, rename. */
export const vfs = {
  async list(path: string) { if (isArc(path)) { const m = await import('./filesArc'); return m.arcList(path); } if (isRemote(path)) return listRemote(path); const p = vplug(); if (!p) return { exists: false, entries: [] }; const r = await p.vfsList({ path }); const base = path.replace(/\/+$/, ''); return { exists: true, entries: r.entries.map((e) => ({ ...e, path: `${base}/${e.name}`, ext: e.dir ? undefined : (e.name.split('.').pop() ?? '').toLowerCase() })) }; },
  async fetch(path: string, jobId: string) { if (isArc(path)) { const m = await import('./filesArc'); return { path: await m.arcFetch(path) }; } void jobId; if (isRemote(path)) { const { id, path: rp } = parseRemote(path); return withTrust(id, () => rplug()!.remoteFetch({ id, path: rp, jobId })); } return vplug()!.vfsFetch({ path, jobId }); },
  cancel(jobId: string) { return (rplug() ?? ({ remoteCancel: async () => undefined } as { remoteCancel(o: { id: string }): Promise<void> })).remoteCancel({ id: jobId }); },
  async job(id: string, op: 'down' | 'up', paths: string[], dest: string, deleteAfter: boolean) {
    if (isArc(op === 'down' ? paths[0] : dest)) { if (op === 'up') throw new Error('readOnly'); const m = await import('./filesArc'); const j = m.arcExtract(paths, dest); await j.done; return; }
    const v = isRemote(op === 'down' ? paths[0] : dest);
    if (v) { const cid = parseRemote(op === 'down' ? paths[0] : dest).id; return withTrust(cid, () => rplug()!.remoteJob({ id, op, conn: cid, paths: op === 'down' ? paths.map((p) => parseRemote(p).path) : paths, dest: op === 'down' ? dest : parseRemote(dest).path, deleteAfter })); }
    return vplug()!.vfsJob({ id, op, paths, dest, deleteAfter });
  },
  async mkdir(dir: string, name: string) { if (isArc(dir)) throw new Error('readOnly'); if (isRemote(dir)) { const { id, path } = parseRemote(dir); return withTrust(id, () => rplug()!.remoteMkdir({ id, path: `${path === '/' ? '' : path}/${name}` })); } return vplug()!.vfsMkdir({ path: dir, name }); },
  async delete(paths: string[], dirs: string[]) { if (isArc(paths[0])) throw new Error('readOnly'); if (isRemote(paths[0])) { const { id } = parseRemote(paths[0]); return withTrust(id, () => rplug()!.remoteDelete({ id, paths: paths.map((x) => parseRemote(x).path), dirs: dirs.map((x) => parseRemote(x).path) })); } return vplug()!.vfsDelete({ paths }); },
  async rename(path: string, name: string) { if (isArc(path)) throw new Error('readOnly'); if (isRemote(path)) { const { id, path: rp } = parseRemote(path); const parent = rp.replace(/\/[^/]*$/, ''); return withTrust(id, () => rplug()!.remoteRename({ id, path: rp, to: `${parent}/${name}` })); } return vplug()!.vfsRename({ path, name }); },
};
/** `remote://<id>/<path>` taken apart. */
export const parseRemote = (p: string): { id: string; path: string } => { const m = /^remote:\/\/([^/]+)(\/.*)?$/.exec(p); return { id: m?.[1] ?? '', path: m?.[2] || '/' }; };
export const remotePath = (id: string, path: string): string => `remote://${id}${path.startsWith('/') ? path : '/' + path}`.replace(/\/+$/, '') || `remote://${id}`;
const KIND_LABEL: Record<Conn['kind'], string> = { ftp: 'FTP', ftps: 'FTPS', sftp: 'SFTP', smb: 'SMB', webdav: 'WebDAV', nextcloud: 'Nextcloud / ownCloud', gdrive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'OneDrive' };
const PORTS: Record<Conn['kind'], number> = { ftp: 21, ftps: 21, sftp: 22, smb: 445, webdav: 443, nextcloud: 443, gdrive: 443, dropbox: 443, onedrive: 443 };
const CLOUD: Conn['kind'][] = ['gdrive', 'dropbox', 'onedrive'];
const CLIENT_HELP: Record<string, string> = { gdrive: 'https://console.cloud.google.com/apis/credentials', dropbox: 'https://www.dropbox.com/developers/apps', onedrive: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' };
const REDIRECT: Record<string, string> = { gdrive: 'http://127.0.0.1:8976/oauth', dropbox: 'http://localhost:8976/oauth', onedrive: 'http://localhost:8976/oauth' };

let cache: Conn[] | null = null;
export async function connections(): Promise<Conn[]> { const p = rplug(); if (!p) return []; if (cache) return cache; try { const r = await p.remoteConnections(); cache = Array.isArray(r?.list) ? r.list : []; } catch { cache = []; } return cache; }
export const forget = (): void => { cache = null; };

/** A listing, with the server's host key or certificate accepted by the reader when it is new. */
export async function listRemote(path: string): Promise<{ exists: boolean; entries: { name: string; path: string; dir: boolean; size: number; mtime: number; ext?: string }[] }> {
  const p = rplug(); if (!p) return { exists: false, entries: [] }; const { id, path: rp } = parseRemote(path);
  const r = await withTrust(id, () => p.remoteList({ id, path: rp }));
  return { exists: true, entries: r.entries.map((e) => ({ ...e, path: remotePath(id, rp === '/' ? `/${e.name}` : `${rp}/${e.name}`), ext: e.dir ? undefined : (e.name.split('.').pop() ?? '').toLowerCase() })) };
}
/** Runs `fn`; a «hostkey:…» or «cert:…» refusal is put to the reader, and on a yes the fingerprint is kept and `fn` run again. */
export async function withTrust<T>(id: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    const m = String((e as Error).message ?? e);
    const mm = /^(hostkey|cert):([0-9A-F:]+):?(.*)$/s.exec(m); if (!mm) throw new Error(friendly(m));
    const yes = await new Promise<boolean>((res) => {
      let yes = false; const sh = openSheet(t(mm[1] === 'cert' ? 'remoteCertTitle' : 'remoteHostKeyTitle'), t('cancel'), { onClose: () => res(yes) });
      sh.body.append(h('p', null, t(mm[1] === 'cert' ? 'remoteCertAsk' : 'remoteHostKeyAsk')), h('p', { class: 'hint', dir: 'ltr' }, mm[3] ? `${mm[3]}` : ''), h('pre', { class: 'remote-fp', dir: 'ltr' }, mm[2].replace(/(.{24})/g, '$1\n').trim()));
      sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { yes = true; sh.close(); } }, icon('check'), t('remoteTrustOnce')));
    });
    if (!yes) throw new Error(t('cancelled'));
    await rplug()!.remoteTrust({ id, fingerprint: mm[2] }); forget();
    return fn();
  }
}
const friendly = (m: string): string => (m === 'clientIdNeeded' ? t('remoteClientIdNeeded') : m === 'login' ? t('remoteLoginFailed') : m === 'noConnection' ? t('remoteGone') : m === 'sharesUnlisted' ? t('remoteSharesUnlisted') : m);

/* ---------- the wizard: a kind, the server, the account; tried before it is kept ---------- */
export function connectionSheet(existing: Conn | null, done: () => void): void {
  const p = rplug(); if (!p) return;
  const sh = openSheet(existing ? t('remoteEdit') : t('remoteAdd'), t('cancel'));
  let kind: Conn['kind'] = existing?.kind ?? 'sftp';
  const name = h('input', { type: 'text', value: existing?.name ?? '', dir: 'auto', placeholder: t('remoteNameHint') }) as HTMLInputElement;
  const host = h('input', { type: 'text', value: existing?.host ?? '', dir: 'ltr', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', placeholder: '192.168.1.10' }) as HTMLInputElement;
  const port = h('input', { type: 'number', value: String(existing?.port ?? PORTS[kind]), dir: 'ltr', min: '1', max: '65535' }) as HTMLInputElement;
  const path = h('input', { type: 'text', value: existing?.path ?? '/', dir: 'ltr', autocapitalize: 'off', placeholder: '/' }) as HTMLInputElement;
  const user = h('input', { type: 'text', value: existing?.user ?? '', dir: 'ltr', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', placeholder: t('remoteUserHint') }) as HTMLInputElement;
  const pass = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off', placeholder: existing?.hasPass ? t('remotePassKept') : '' }) as HTMLInputElement;
  const domain = h('input', { type: 'text', value: existing?.domain ?? '', dir: 'ltr', autocapitalize: 'off', placeholder: 'WORKGROUP' }) as HTMLInputElement;
  const share = h('input', { type: 'text', value: existing?.share ?? '', dir: 'ltr', autocapitalize: 'off', placeholder: t('remoteShareHint') }) as HTMLInputElement;
  const key = h('textarea', { rows: '4', dir: 'ltr', spellcheck: 'false', placeholder: existing?.hasKey ? t('remoteKeyKept') : '-----BEGIN OPENSSH PRIVATE KEY-----' }) as HTMLTextAreaElement;
  const clientId = h('input', { type: 'text', value: existing?.clientId ?? '', dir: 'ltr', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', placeholder: t('remoteClientIdHint') }) as HTMLInputElement;
  const clientSecret = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off', placeholder: t('remoteClientSecretHint') }) as HTMLInputElement;
  const helpLink = h('a', { class: 'src', target: '_blank', rel: 'noopener', dir: 'ltr' }, '');
  const kindBtn = pickButton(t('remoteKind'), (Object.keys(KIND_LABEL) as Conn['kind'][]).map((k): [string, string] => [k, KIND_LABEL[k]]), kind, (v) => { const was = PORTS[kind]; kind = v as Conn['kind']; if (Number(port.value) === was) port.value = String(PORTS[kind]); layout(); buttons(); }, t('close'));
  const field = (label: string, el: HTMLElement, hint?: string) => h('label', { class: 'field' }, h('span', null, label), el, hint ? h('small', { class: 'src' }, hint) : null);
  const rowDomain = field(t('remoteDomain'), domain); const rowShare = field(t('remoteShare'), share, t('remoteShareWhy')); const rowKey = field(t('remoteKey'), key, t('remoteKeyWhy')); const rowPath = field(t('remoteStartPath'), path); const rowPort = field(t('remotePort'), port);
  const rowHost = field(t('remoteHost'), host, t('remoteHostHint')); const rowUser = field(t('remoteUser'), user); const rowPass = field(t('password'), pass, t('remotePassWhy'));
  const rowClient = h('div', null, h('p', { class: 'hint' }, t('remoteCloudHint')), field(t('remoteClientId'), clientId), field(t('remoteClientSecret'), clientSecret, t('remoteClientSecretWhy')), h('p', { class: 'hint', dir: 'ltr' }, t('remoteRedirectHint'), ' ', h('code', { class: 'sel' }, REDIRECT[kind] ?? '')), helpLink);
  const layout = () => { const cloud = CLOUD.includes(kind); rowDomain.hidden = kind !== 'smb'; rowShare.hidden = kind !== 'smb'; rowKey.hidden = kind !== 'sftp'; rowPort.hidden = kind === 'webdav' || kind === 'nextcloud' || cloud; rowHost.hidden = cloud; rowUser.hidden = cloud || kind === 'nextcloud'; rowPass.hidden = cloud || kind === 'nextcloud'; rowPath.hidden = kind === 'nextcloud'; rowClient.hidden = !cloud; if (cloud) { helpLink.href = CLIENT_HELP[kind]; helpLink.textContent = t('remoteClientWhere'); (rowClient.querySelector('code') as HTMLElement).textContent = REDIRECT[kind]; } (rowHost.querySelector('span') as HTMLElement).textContent = kind === 'webdav' || kind === 'nextcloud' ? 'URL' : t('remoteHost'); };
  layout();
  sh.body.append(h('div', { class: 'chip-row files-filters' }, kindBtn), field(t('remoteName'), name), rowHost, rowPort, rowPath, rowUser, rowPass, rowDomain, rowShare, rowKey, rowClient);
  const save = async (test: boolean) => {
    const cloud = CLOUD.includes(kind);
    if (!cloud && !host.value.trim()) { toast(t('remoteHostNeeded'), 'error'); host.focus(); return; }
    if (cloud && !clientId.value.trim()) { toast(t('remoteClientIdNeeded'), 'error'); clientId.focus(); return; }
    const c = { id: existing?.id ?? '', kind, name: name.value.trim() || (cloud ? KIND_LABEL[kind] : `${KIND_LABEL[kind]} · ${host.value.trim()}`), host: cloud ? kind : host.value.trim(), port: Number(port.value) || PORTS[kind], path: path.value.trim() || '/', user: user.value.trim(), pass: pass.value, domain: domain.value.trim(), share: share.value.trim(), key: key.value.trim(), clientId: clientId.value.trim(), ...(clientSecret.value ? { clientSecret: clientSecret.value } : {}) };
    const busy = h('div', { class: 'center' }, h('div', { class: 'spinner small' })); sh.actions.replaceChildren(busy);
    try {
      const r = await p.remoteSave(c); forget();
      if (test && cloud) { await p.remoteSignIn({ id: r.id }); toast(t('remoteSignedIn')); }
      else if (test && kind === 'nextcloud') { await p.remoteNextcloud({ id: r.id }); toast(t('remoteSignedIn')); }
      else if (test) { await withTrust(r.id, () => p.remoteTest({ id: r.id, path: c.path })); toast(t('remoteConnected')); }
      sh.close(); done();
    } catch (e) { const m = String((e as Error).message ?? e); if (m !== 'cancelled') toast(friendly(m), 'error', 6000); buttons(); }
  };
  const buttons = () => sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void save(false) }, t('save')), h('button', { type: 'button', class: 'btn primary', onclick: () => void save(true) }, icon('check'), CLOUD.includes(kind) || kind === 'nextcloud' ? t('remoteSignInAndSave') : t('remoteTestAndSave')));
  buttons(); setTimeout(() => (existing ? host : name).focus(), 60);
}
/** The LAN searched for servers; one tapped becomes a new connection with its kind guessed from the port. */
export function scanSheet(done: () => void): void {
  const p = rplug(); if (!p) return; let gone = false; const sh = openSheet(t('remoteScan'), t('close'), { onClose: () => { gone = true; void p.remoteScanStop(); } }); const list = h('div', { class: 'dest-list' }); const status = h('p', { class: 'hint' }, t('remoteScanning'));
  sh.body.append(status, list);
  void p.remoteScan().then((r) => {
    if (gone) return; status.textContent = r.hosts.length ? t('remoteScanFound', { n: localDigits(r.hosts.length), mine: r.mine }) : t('remoteScanNone');
    list.replaceChildren(...r.hosts.flatMap((hst) => hst.ports.filter((x) => [445, 21, 22].includes(x)).map((port) => { const kind: Conn['kind'] = port === 445 ? 'smb' : port === 22 ? 'sftp' : 'ftp'; return h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); connectionSheet({ id: '', kind, name: hst.name ?? hst.ip, host: hst.ip, port } as Conn, done); } }, icon(kind === 'smb' ? 'storage' : 'globe'), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'ltr' }, hst.name ?? hst.ip), h('small', { class: 'src', dir: 'ltr' }, `${hst.ip} · ${KIND_LABEL[kind]} · ${port}`))); })));
  }, (e) => { status.textContent = String((e as Error).message ?? e); });
}
/** The kebab of a saved connection: edit, forget the trust, remove. */
export function connectionMenu(c: Conn, done: () => void): void {
  const p = rplug(); if (!p) return; const sh = openSheet(c.name, t('close'));
  const row = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
  sh.body.append(h('p', { class: 'hint', dir: 'ltr' }, `${KIND_LABEL[c.kind]} · ${c.host}${c.port ? ':' + c.port : ''}${c.path && c.path !== '/' ? c.path : ''}`), h('div', { class: 'dest-list' },
    row('pen', t('remoteEdit'), () => connectionSheet(c, done)),
    ...(CLOUD.includes(c.kind) ? [row('key', c.signedIn ? t('remoteSignInAgain') : t('remoteSignIn'), () => void p.remoteSignIn({ id: c.id }).then(() => { forget(); toast(t('remoteSignedIn')); done(); }, (e) => { if (String((e as Error).message) !== 'cancelled') toast(friendly(String((e as Error).message ?? e)), 'error', 6000); }))] : []),
    ...(c.kind === 'nextcloud' ? [row('key', t('remoteSignInAgain'), () => void p.remoteNextcloud({ id: c.id }).then(() => { forget(); toast(t('remoteSignedIn')); done(); }, (e) => { if (String((e as Error).message) !== 'cancelled') toast(friendly(String((e as Error).message ?? e)), 'error', 6000); }))] : []),
    ...(c.trust ? [row('shield', t('remoteForgetTrust'), () => void p.remoteTrust({ id: c.id, fingerprint: '' }).then(() => { forget(); done(); }))] : []),
    row('trash', t('delete'), () => void p.remoteRemove({ id: c.id }).then(() => { forget(); done(); toast(t('done')); }))));
}
export const kindIcon = (k: Conn['kind']): string => (k === 'smb' ? 'storage' : k === 'webdav' || k === 'nextcloud' || CLOUD.includes(k) ? 'cloud' : 'globe');
export const kindLabel = (k: Conn['kind']): string => KIND_LABEL[k];
/** The bar's text for a remote root. */
export const describe = (c: Conn): string => (CLOUD.includes(c.kind) ? `${KIND_LABEL[c.kind]}${c.signedIn ? '' : ' · ' + t('remoteNotSignedIn')}` : `${KIND_LABEL[c.kind]} · ${c.host}`);
export const remoteDeleteOrToast = async (paths: string[], dirs: string[]): Promise<void> => { const p = rplug(); if (!p) return; const { id } = parseRemote(paths[0]); await withTrust(id, () => p.remoteDelete({ id, paths: paths.map((x) => parseRemote(x).path), dirs: dirs.map((x) => parseRemote(x).path) })); };

/* ---------- this folder shared on the Wi‑Fi: a web page and an FTP server, with a QR for each ---------- */
type SharePlug = { folderShareStart(o: { path: string; writable: boolean; web: boolean; ftp: boolean; user: string; pass: string }): Promise<ShareStatus>; folderShareStop(): Promise<void>; folderShareStatus(): Promise<ShareStatus> };
type ShareStatus = { running: boolean; web: string | null; ftp: string | null; root: string | null; writable: boolean; sent: number; received: number; hits: number; ftpLogins: number; user: string };
const splug = (): SharePlug | null => { const p = ktPlugin() as unknown as SharePlug | null; return p?.folderShareStart ? p : null; };
export const canShareFolder = (): boolean => !!splug();
export async function folderShareSheet(path: string, name: string): Promise<void> {
  const p = splug(); if (!p) return; const sh = openSheet(t('fshareTitle'), t('close'));
  const { formatBytes } = await import('../i18n');
  let st: ShareStatus | null = null; try { st = await p.folderShareStatus(); } catch { /* none */ }
  const writable = h('input', { type: 'checkbox', checked: st?.writable ?? false }) as HTMLInputElement; const web = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement; const ftp = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const user = h('input', { type: 'text', value: st?.user ?? localStorage.getItem('kt.fshare.user') ?? '', dir: 'ltr', autocapitalize: 'off', autocomplete: 'off', placeholder: t('fshareUserHint') }) as HTMLInputElement;
  const pass = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off', placeholder: t('fsharePassHint') }) as HTMLInputElement;
  const form = h('div', null, h('p', { class: 'hint' }, t('fshareHint', { name })),
    h('label', { class: 'check-row' }, web, h('span', null, t('fshareWeb'))), h('label', { class: 'check-row' }, ftp, h('span', null, t('fshareFtp'))), h('label', { class: 'check-row' }, writable, h('span', null, t('fshareWritable'))),
    h('label', { class: 'field' }, h('span', null, t('remoteUser')), user), h('label', { class: 'field' }, h('span', null, t('password')), pass), h('p', { class: 'hint' }, t('fshareSecurity')));
  const live = h('div'); let timer = 0;
  const showLive = async (s: ShareStatus) => {
    const { qrSvg } = await import('../ui/qr'); const blocks: HTMLElement[] = [];
    for (const [label, url] of [[t('fshareWeb'), s.web], [t('fshareFtp'), s.ftp]] as [string, string | null][]) { if (!url) continue; const qr = h('div', { class: 'qr-box small' }); qr.innerHTML = qrSvg(url, 160); blocks.push(h('div', { class: 'fshare-block' }, h('b', null, label), qr, h('div', { class: 'kt-url' }, icon('link'), h('code', { class: 'sel', dir: 'ltr' }, url), h('button', { type: 'button', class: 'kt-copy', 'aria-label': t('copyLink'), onclick: () => void navigator.clipboard?.writeText(url).then(() => toast(t('copied'))) }, icon('copy'))))); }
    const stat = h('p', { class: 'src' });
    live.replaceChildren(h('p', { class: 'hint', dir: 'auto' }, s.root ?? ''), h('div', { class: 'fshare-blocks' }, ...blocks), stat, ...(s.user ? [h('p', { class: 'hint', dir: 'ltr' }, `FTP · ${s.user}`)] : []));
    const tick = async () => { const x = await p.folderShareStatus().catch(() => null); if (!x) return; stat.textContent = t('fshareStats', { hits: localDigits(x.hits + x.ftpLogins), sent: formatBytes(x.sent), got: formatBytes(x.received) }); if (!x.running) { clearInterval(timer); showForm(); } }; void tick(); clearInterval(timer); timer = window.setInterval(() => void tick(), 2000);
    sh.body.replaceChildren(live); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: async () => { clearInterval(timer); await p.folderShareStop().catch(() => undefined); showForm(); } }, icon('close'), t('wifiShareStop')));
  };
  const showForm = () => { sh.body.replaceChildren(form); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: async () => { if (!web.checked && !ftp.checked) { toast(t('fshareOneNeeded'), 'error'); return; } try { localStorage.setItem('kt.fshare.user', user.value.trim()); } catch { /* none */ } try { const s = await p.folderShareStart({ path, writable: writable.checked, web: web.checked, ftp: ftp.checked, user: user.value.trim(), pass: pass.value }); if (!s.web && !s.ftp) { toast(t('wifiShareNoNetwork'), 'error'); return; } void showLive(s); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, icon('wifi'), t('fshareStart'))); };
  if (st?.running) void showLive(st); else showForm();
  const mo = new MutationObserver(() => { if (!sh.el.isConnected) { mo.disconnect(); clearInterval(timer); } }); mo.observe(document.body, { childList: true });
}
