// Files handed to another phone or computer over Wi-Fi (REX Player's web share): the app serves them at an
// address shown as a QR code and as text; the other device opens it in its browser and downloads. Stopped from
// the same sheet, or when the app is closed.
import { h, icon, openSheet, toast } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { ktPlugin } from '../native';
import type { Task } from '../engine/types';

type Api = { shareWifi(o: { paths: string[]; names: string[] }): Promise<{ url: string | null; files: number }>; shareWifiStop(): Promise<void>; shareWifiStatus(): Promise<{ running: boolean; url: string | null; sent: number; hits: number }> };
const api = (): Api | null => { const d = window.kurokawaTools as unknown as Partial<Api> | undefined; if (d?.shareWifi) return d as Api; const p = ktPlugin() as unknown as Partial<Api> | null; return p?.shareWifi ? (p as Api) : null; };
export const canShareWifi = (): boolean => !!api();

/** The finished files of these tasks, as paths the server reads. */
export function filesOf(tasks: Task[]): { paths: string[]; names: string[] } {
  const paths: string[] = []; const names: string[] = [];
  for (const x of tasks) {
    if (x.state !== 'done' || !x.dir || x.dir.startsWith('content:')) continue; const dir = x.dir.replace(/[\\/]$/, '');
    const picked = x.files.filter((f) => f.priority > 0); const list = picked.length ? picked : x.files;
    if (!list.length) { paths.push(`${dir}/${x.name}`); names.push(x.name); continue; }
    for (const f of list) { const p = x.kind === 'torrent' && x.files.length > 1 ? `${dir}/${x.name}/${f.path}` : `${dir}/${f.path || x.name}`; paths.push(p.replace(/\/+/g, '/')); names.push(f.path.split(/[\\/]/).pop() || x.name); }
  }
  return { paths, names };
}

/** The share started for these files and its sheet: the code, the address, what was taken so far, Stop. */
export async function shareWifiSheet(tasks: Task[]): Promise<void> {
  const a = api(); if (!a) { toast(t('wifiShareUnavailable'), 'error'); return; }
  const { paths, names } = filesOf(tasks); if (!paths.length) { toast(t('wifiShareNothing'), 'error'); return; }
  const sh = openSheet(t('wifiShare'), t('close')); const body = h('div', { class: 'center' }, h('div', { class: 'spinner' })); sh.body.append(h('p', { class: 'hint' }, t('wifiShareHint')), body);
  let timer = 0; const stop = async () => { clearInterval(timer); await a.shareWifiStop().catch(() => undefined); };
  try {
    const r = await a.shareWifi({ paths, names });
    if (!r.url) { body.replaceChildren(h('p', { class: 'hint' }, t('wifiShareNoNetwork'))); return; }
    const { qrSvg } = await import('../ui/qr'); const qr = h('div', { class: 'qr-box' }); qr.innerHTML = qrSvg(r.url, 220);
    const addr = h('code', { class: 'sel', dir: 'ltr' }, r.url); const stat = h('p', { class: 'src' });
    body.replaceChildren(qr, h('div', { class: 'kt-url' }, icon('link'), addr, h('button', { type: 'button', class: 'kt-copy', 'aria-label': t('copyLink'), onclick: () => void navigator.clipboard?.writeText(r.url!).then(() => toast(t('copied'))) }, icon('copy'))), h('p', { class: 'src' }, t('wifiShareFiles', { n: localDigits(r.files) })), stat);
    timer = window.setInterval(async () => { const s = await a.shareWifiStatus().catch(() => null); if (!s) return; stat.textContent = t('wifiShareStats', { hits: localDigits(s.hits), sent: formatBytes(s.sent) }); if (!s.running) clearInterval(timer); }, 1500);
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { void stop(); sh.close(); } }, icon('close'), t('wifiShareStop')));
    const mo = new MutationObserver(() => { if (!sh.el.isConnected) { mo.disconnect(); void stop(); } }); mo.observe(document.body, { childList: true });
  } catch (e) { body.replaceChildren(h('p', { class: 'hint' }, String((e as Error).message ?? e))); }
}
