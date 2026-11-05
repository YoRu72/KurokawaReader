// The Files add-on's network storages: saved connections (FTP/FTPS, SFTP, SMB, WebDAV) shown as storages, a
// connection wizard, the server's host key or certificate accepted by its fingerprint, a scan of the LAN for
// servers, and transfers as jobs (down into a folder, up from the device). Paths are `remote://<id>/<path>`.
import { h, icon, toast, openSheet, pickButton } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { ktPlugin } from '../native';

export interface Conn { id: string; kind: 'ftp' | 'ftps' | 'sftp' | 'smb' | 'webdav'; name: string; host: string; port?: number; path?: string; user?: string; domain?: string; share?: string; hasPass?: boolean; hasKey?: boolean; trust?: string }
type REntry = { name: string; dir: boolean; size: number; mtime: number };
type RPlug = {
  remoteConnections(): Promise<{ list: Conn[] }>; remoteSave(c: Partial<Conn> & { pass?: string; key?: string }): Promise<{ id: string }>; remoteRemove(o: { id: string }): Promise<void>; remoteTrust(o: { id: string; fingerprint: string }): Promise<void>;
  remoteTest(o: { id: string; path?: string }): Promise<{ entries: REntry[] }>; remoteList(o: { id: string; path: string }): Promise<{ entries: REntry[] }>; remoteMkdir(o: { id: string; path: string }): Promise<void>;
  remoteDelete(o: { id: string; paths: string[]; dirs: string[] }): Promise<void>; remoteRename(o: { id: string; path: string; to: string }): Promise<void>; remoteFetch(o: { id: string; path: string; jobId?: string }): Promise<{ path: string; size: number }>;
  remoteJob(o: { id?: string; op: 'down' | 'up'; conn: string; paths: string[]; dest: string; deleteAfter?: boolean }): Promise<{ id: string }>; remoteCancel(o: { id: string }): Promise<void>; remoteScan(): Promise<{ hosts: { ip: string; ports: number[]; name?: string }[]; mine: string }>; remoteScanStop(): Promise<void>;
};
export const rplug = (): RPlug | null => { const p = ktPlugin() as unknown as RPlug | null; return p?.remoteConnections ? p : null; };

export const isRemote = (p: string): boolean => p.startsWith('remote://');
/** `remote://<id>/<path>` taken apart. */
export const parseRemote = (p: string): { id: string; path: string } => { const m = /^remote:\/\/([^/]+)(\/.*)?$/.exec(p); return { id: m?.[1] ?? '', path: m?.[2] || '/' }; };
export const remotePath = (id: string, path: string): string => `remote://${id}${path.startsWith('/') ? path : '/' + path}`.replace(/\/+$/, '') || `remote://${id}`;
const KIND_LABEL: Record<Conn['kind'], string> = { ftp: 'FTP', ftps: 'FTPS', sftp: 'SFTP', smb: 'SMB', webdav: 'WebDAV' };
const PORTS: Record<Conn['kind'], number> = { ftp: 21, ftps: 21, sftp: 22, smb: 445, webdav: 443 };

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
const friendly = (m: string): string => (m === 'login' ? t('remoteLoginFailed') : m === 'noConnection' ? t('remoteGone') : m === 'sharesUnlisted' ? t('remoteSharesUnlisted') : m);

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
  const kindBtn = pickButton(t('remoteKind'), (Object.keys(KIND_LABEL) as Conn['kind'][]).map((k): [string, string] => [k, KIND_LABEL[k]]), kind, (v) => { const was = PORTS[kind]; kind = v as Conn['kind']; if (Number(port.value) === was) port.value = String(PORTS[kind]); layout(); }, t('close'));
  const field = (label: string, el: HTMLElement, hint?: string) => h('label', { class: 'field' }, h('span', null, label), el, hint ? h('small', { class: 'src' }, hint) : null);
  const rowDomain = field(t('remoteDomain'), domain); const rowShare = field(t('remoteShare'), share, t('remoteShareWhy')); const rowKey = field(t('remoteKey'), key, t('remoteKeyWhy')); const rowPath = field(t('remoteStartPath'), path); const rowPort = field(t('remotePort'), port);
  const layout = () => { rowDomain.hidden = kind !== 'smb'; rowShare.hidden = kind !== 'smb'; rowKey.hidden = kind !== 'sftp'; rowPort.hidden = kind === 'webdav'; };
  layout();
  sh.body.append(h('div', { class: 'chip-row files-filters' }, kindBtn), field(t('remoteName'), name), field(kind === 'webdav' ? 'URL' : t('remoteHost'), host, t('remoteHostHint')), rowPort, rowPath, field(t('remoteUser'), user), field(t('password'), pass, t('remotePassWhy')), rowDomain, rowShare, rowKey);
  const save = async (test: boolean) => {
    if (!host.value.trim()) { toast(t('remoteHostNeeded'), 'error'); host.focus(); return; }
    const c = { id: existing?.id ?? '', kind, name: name.value.trim() || `${KIND_LABEL[kind]} · ${host.value.trim()}`, host: host.value.trim(), port: Number(port.value) || PORTS[kind], path: path.value.trim() || '/', user: user.value.trim(), pass: pass.value, domain: domain.value.trim(), share: share.value.trim(), key: key.value.trim() };
    const busy = h('div', { class: 'center' }, h('div', { class: 'spinner small' })); sh.actions.replaceChildren(busy);
    try {
      const r = await p.remoteSave(c); forget();
      if (test) { await withTrust(r.id, () => p.remoteTest({ id: r.id, path: c.path })); toast(t('remoteConnected')); }
      sh.close(); done();
    } catch (e) { toast(friendly(String((e as Error).message ?? e)), 'error', 6000); buttons(); if (!existing) { /* kept anyway, so the reader can fix it */ } }
  };
  const buttons = () => sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void save(false) }, t('save')), h('button', { type: 'button', class: 'btn primary', onclick: () => void save(true) }, icon('check'), t('remoteTestAndSave')));
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
    ...(c.trust ? [row('shield', t('remoteForgetTrust'), () => void p.remoteTrust({ id: c.id, fingerprint: '' }).then(() => { forget(); done(); }))] : []),
    row('trash', t('delete'), () => void p.remoteRemove({ id: c.id }).then(() => { forget(); done(); toast(t('done')); }))));
}
export const kindIcon = (k: Conn['kind']): string => (k === 'smb' ? 'storage' : k === 'webdav' ? 'cloud' : 'globe');
export const kindLabel = (k: Conn['kind']): string => KIND_LABEL[k];
/** The bar's text for a remote root. */
export const describe = (c: Conn): string => `${KIND_LABEL[c.kind]} · ${c.host}`;
export const remoteDeleteOrToast = async (paths: string[], dirs: string[]): Promise<void> => { const p = rplug(); if (!p) return; const { id } = parseRemote(paths[0]); await withTrust(id, () => p.remoteDelete({ id, paths: paths.map((x) => parseRemote(x).path), dirs: dirs.map((x) => parseRemote(x).path) })); };
