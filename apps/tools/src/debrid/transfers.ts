// Cloud transfers: a torrent or hoster link handed to the debrid service, watched until the service has it,
// then every file fetched as a plain HTTP download (eight connections, at the service's speed). What is
// pending is kept in settings so a restart picks it up; the watcher polls while anything is pending.
import { getEngine } from '../engine';
import { safeDecode } from '../downloads/probe';
import type { TaskSource, Task } from '../engine/types';
import { getSettings, updateSettings } from '../settings';
import { debridServices, type Debrid, type DebridTorrent } from './index';
import { toast } from '../ui/dom';
import { t, countFiles } from '../i18n';

export interface Transfer { service: string; id: string; name: string; dir?: string; meta?: Task['meta']; added: number; hash?: string }
const pending = (): Transfer[] => (getSettings().debridTransfers ?? []) as Transfer[];
const keep = (l: Transfer[]) => updateSettings({ debridTransfers: l });
const listeners = new Set<() => void>();
export const onTransfersChange = (fn: () => void): (() => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = () => listeners.forEach((f) => f());

const HOSTER = /^https?:\/\//i;
/** A source handed to the preferred service; a hoster link is unrestricted at once, a torrent watched. */
export async function sendToDebrid(source: TaskSource, o: { name?: string; dir?: string; meta?: Task['meta'] } = {}, svc?: Debrid): Promise<{ kind: 'direct' | 'cloud'; name: string }> {
  const s = svc ?? (await debridServices())[0]; if (!s) throw new Error(t('debridNoService'));
  if (source.url && HOSTER.test(source.url)) {
    const l = await s.unrestrict(source.url);
    await getEngine().add({ source: { url: l.url, headers: source.headers }, name: o.name ?? l.name, dir: o.dir, meta: { ...o.meta, debrid: s.id } });
    return { kind: 'direct', name: o.name ?? l.name };
  }
  let id: string;
  if (source.magnet) id = await s.addMagnet(source.magnet);
  else if (source.torrent) { if (!s.addTorrent) throw new Error(t('debridNoTorrentFile', { service: s.name })); id = await s.addTorrent(source.torrent); }
  else throw new Error('source');
  const hash = source.magnet ? /btih:([a-z0-9]{32,40})/i.exec(source.magnet)?.[1]?.toLowerCase() : undefined;
  const name = o.name ?? ((source.magnet ? safeDecode(/dn=([^&]+)/.exec(source.magnet)?.[1] ?? '').replace(/\+/g, ' ') : '') || hash || 'torrent');
  keep([...pending(), { service: s.id, id, name, dir: o.dir, meta: o.meta, added: Date.now(), hash }]); changed(); start();
  // Cached already? One look now saves the first wait.
  void poll();
  return { kind: 'cloud', name };
}

let timer = 0; let polling = false;
export function start(): void { if (timer || !pending().length) return; timer = window.setInterval(() => void poll(), 12000); }
function stop(): void { if (timer) { window.clearInterval(timer); timer = 0; } }
export async function poll(): Promise<void> {
  if (polling) return; polling = true;
  try {
    const list = pending(); if (!list.length) { stop(); return; }
    const svcs = await debridServices();
    for (const tr of list) {
      const s = svcs.find((x) => x.id === tr.service); if (!s) continue;
      let info: DebridTorrent; try { info = await s.torrent(tr.id); } catch (e) { if (/gone|not found|404/i.test(String((e as Error).message))) { drop(tr); toast(t('debridGone', { name: tr.name }), 'error'); } continue; }
      latest.set(tr.id, info); changed();
      if (info.status === 'ready') { try { await fetchAll(s, info, tr); drop(tr); toast(t('debridReady', { name: info.name || tr.name, n: countFiles(info.files.length) })); } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); } }
      else if (info.status === 'error') { drop(tr); toast(t('debridFailed', { name: tr.name, error: info.error ?? '' }), 'error', 5000); }
    }
    if (!pending().length) stop();
  } finally { polling = false; }
}
const latest = new Map<string, DebridTorrent>();
export const latestOf = (id: string): DebridTorrent | undefined => latest.get(id);
export const pendingTransfers = pending;
function drop(tr: Transfer): void { keep(pending().filter((x) => !(x.id === tr.id && x.service === tr.service))); latest.delete(tr.id); changed(); }
export async function cancelTransfer(tr: Transfer, deleteRemote: boolean): Promise<void> { if (deleteRemote) { const s = (await debridServices()).find((x) => x.id === tr.service); await s?.remove(tr.id).catch(() => undefined); } drop(tr); }
/** Every file of a ready transfer, unrestricted and queued as HTTP downloads, into a folder named after it when there are several. */
async function fetchAll(s: Debrid, info: DebridTorrent, tr: Transfer): Promise<void> {
  const eng = getEngine(); const many = info.files.length > 1;
  const base = tr.dir ?? getSettings().downloadDir; const dir = many && base && !base.startsWith('content:') ? `${base.replace(/[\\/]$/, '')}/${(info.name || tr.name).replace(/[\\/:*?"<>|]+/g, ' ').trim()}` : base || undefined;
  for (const f of info.files) {
    if (!f.link) continue;
    const l = await s.unrestrict(f.link);
    await eng.add({ source: { url: l.url }, name: f.name.split('/').pop() || l.name, dir, meta: { ...tr.meta, debrid: s.id, hash: info.hash } });
  }
}
// Pending transfers from before this start are watched again.
if (typeof window !== 'undefined') setTimeout(() => { if (pending().length && getSettings().addons.includes('debrid')) { start(); void poll(); } }, 1500);
