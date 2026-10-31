// The cloud: what the debrid service is fetching for us (with its progress), what it already holds (every
// torrent on the account, each fetchable from here), and the account itself.
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits, countFiles } from '../i18n';
import { debridServices, type Debrid, type DebridTorrent } from '../debrid';
import { pendingTransfers, latestOf, cancelTransfer, onTransfersChange, poll, type Transfer } from '../debrid/transfers';
import { getEngine } from '../engine';
import { getSettings } from '../settings';

export async function cloudSheet(): Promise<void> {
  const sh = openSheet(t('cloud'), t('close'));
  const svcs = await debridServices();
  if (!svcs.length) { sh.body.append(h('p', { class: 'hint' }, t('debridNoService'))); return; }
  const box = h('div', { class: 'cloud-box' }); sh.body.append(box);
  const row = (name: string, line: string, pct: number | null, actions: HTMLElement[]) => h('div', { class: 'task-card cloud-row' }, h('span', { class: 'task-kind' }, icon('cloud')), h('span', { class: 'task-text' }, h('span', { class: 'task-name', dir: 'auto' }, name), h('span', { class: 'task-line' }, line), pct === null ? null : h('span', { class: 'task-bar' }, h('i', { style: { width: `${pct}%` } }))), h('span', { class: 'task-actions' }, ...actions));
  const draw = async () => {
    box.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' })));
    const parts: HTMLElement[] = [];
    for (const s of svcs) {
      const acct = await s.account().catch((e) => ({ user: String((e as Error).message), premium: false, expires: undefined as string | undefined }));
      parts.push(h('h4', null, `${s.name} · ${acct.user}${acct.premium ? '' : ` · ${t('debridNotPremium')}`}${acct.expires ? ` · ${t('debridUntil', { d: new Date(acct.expires).toLocaleDateString() })}` : ''}`));
      const mine = pendingTransfers().filter((x) => x.service === s.id);
      for (const tr of mine) { const info = latestOf(tr.id); parts.push(row(info?.name || tr.name, info ? `${stateOf(info)}${info.speed ? ` · ${formatBytes(info.speed)}/s` : ''}${info.seeders !== undefined ? ` · ↑${localDigits(info.seeders)}` : ''}` : t('debridWaiting'), info?.progress ?? 0, [iconButton('close', t('cancel'), () => void cancelTransfer(tr, true).then(draw))])); }
      const all = await s.torrents().catch(() => [] as DebridTorrent[]);
      const rest = all.filter((x) => !mine.some((m) => m.id === x.id));
      if (rest.length) parts.push(h('p', { class: 'src' }, t('debridOnAccount', { n: rest.length })));
      for (const x of rest.slice(0, 40)) parts.push(row(x.name, `${stateOf(x)} · ${x.size ? formatBytes(x.size) : ''}${x.files.length ? ` · ${countFiles(x.files.length)}` : ''}`, x.status === 'ready' ? null : x.progress, [
        ...(x.status === 'ready' ? [iconButton('download', t('download'), () => void fetchFrom(s, x))] : []), iconButton('trash', t('remove'), async () => { if (!confirm(t('debridDeleteConfirm', { name: x.name }))) return; await s.remove(x.id).catch((e) => toast(String((e as Error).message), 'error')); void draw(); })]));
    }
    box.replaceChildren(...parts);
  };
  const off = onTransfersChange(() => void draw()); sh.el.addEventListener('remove', off);
  void draw(); void poll();
}
const stateOf = (x: DebridTorrent): string => t(x.status === 'ready' ? 'debridStateReady' : x.status === 'downloading' ? 'debridStateFetching' : x.status === 'queued' ? 'debridStateQueued' : x.status === 'error' ? 'stateFailed' : 'stateQueued') + (x.status === 'downloading' ? ` ${localDigits(x.progress)}%` : '');
async function fetchFrom(s: Debrid, x: DebridTorrent): Promise<void> {
  try {
    const full = x.files.length ? x : await s.torrent(x.id); const eng = getEngine(); const base = getSettings().downloadDir;
    const dir = full.files.length > 1 && base && !base.startsWith('content:') ? `${base.replace(/[\\/]$/, '')}/${full.name.replace(/[\\/:*?"<>|]+/g, ' ').trim()}` : base || undefined;
    let n = 0; for (const f of full.files) { if (!f.link) continue; const l = await s.unrestrict(f.link); await eng.add({ source: { url: l.url }, name: f.name.split('/').pop() || l.name, dir, meta: { debrid: s.id, hash: full.hash } }); n++; }
    toast(t('debridReady', { name: full.name, n: countFiles(n) }));
  } catch (e) { toast(String((e as Error).message ?? e), 'error', 5000); }
}
