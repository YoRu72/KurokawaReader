// A torrent up close (qBittorrent's and Flud's tabs, in one card): the swarm — seeds and peers connected and known —,
// the peers sending and receiving now, the trackers and how each answered, and what can be done: check the files
// again, ask every tracker and the DHT for peers now, and this download's own speed limits.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import type { Engine, TorrentDetail } from '../engine/types';

const rate = (b: number) => `${formatBytes(b)}/s`;
export function swarmCard(id: string, eng: Engine): { el: HTMLElement; dispose: () => void } | null {
  if (!eng.torrentDetail) return null;
  const head = h('div', { class: 'swarm-head' }); const peers = h('div', { class: 'swarm-list' }); const trackers = h('div', { class: 'swarm-list' });
  const limits = h('div', { class: 'swarm-limits' }); let limitsDrawn = false;
  const acts = h('div', { class: 'row-actions wrap' },
    eng.recheck ? h('button', { type: 'button', class: 'btn tonal small', onclick: () => void eng.recheck!(id).then(() => toast(t('swarmRechecking'))) }, icon('refresh'), t('swarmRecheck')) : null,
    eng.reannounce ? h('button', { type: 'button', class: 'btn tonal small', onclick: () => void eng.reannounce!(id).then(() => { toast(t('swarmAnnounced')); void tick(); }) }, icon('wifi'), t('swarmReannounce')) : null,
    eng.addTrackers ? h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const s = openSheet(t('trackersAdd'), t('cancel'), { stack: true }); const ta = h('textarea', { rows: 6, dir: 'ltr', placeholder: 'udp://tracker.example.org:6969/announce', autocapitalize: 'off', spellcheck: 'false' }) as HTMLTextAreaElement; s.body.append(h('p', { class: 'hint' }, t('trackersAddHint')), ta); s.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void eng.addTrackers!(id, ta.value.split(/\s+/).filter(Boolean)).then((n) => { toast(t('trackersAdded', { n: localDigits(String(n)) })); s.close(); void tick(); }).catch((e) => toast(String((e as Error).message ?? e), 'error')) }, icon('plus'), t('trackersAdd'))); } }, icon('plus'), t('trackersAdd')) : null);
  const peersBox = h('details', { class: 'swarm-sec' }, h('summary', null, t('swarmPeers')), peers);
  const trBox = h('details', { class: 'swarm-sec' }, h('summary', null, t('swarmTrackers')), trackers);
  const el = h('section', { class: 'card kt-swarm' }, h('h3', null, t('swarmTitle')), head, acts, limits, peersBox, trBox);
  const drawLimits = (d: TorrentDetail) => {
    if (limitsDrawn || !eng.setTaskLimits) return; limitsDrawn = true;
    const field = (label: string, v: number, key: 'down' | 'up') => h('label', { class: 'swarm-limit' }, h('span', null, label), h('input', { type: 'number', inputmode: 'numeric', min: '0', value: String(Math.round(v / 1024)), class: 'num-small', onchange: (e: Event) => { const kb = Math.max(0, Number((e.target as HTMLInputElement).value) || 0); cur[key] = kb * 1024; void eng.setTaskLimits!(id, cur.down, cur.up); } }), h('small', { class: 'src' }, 'KB/s'));
    const cur = { down: d.limitDown ?? 0, up: d.limitUp ?? 0 };
    limits.replaceChildren(h('small', { class: 'src' }, t('swarmLimitsHint')), h('div', { class: 'swarm-limit-row' }, field(t('downLimit'), cur.down, 'down'), field(t('upLimit'), cur.up, 'up')));
  };
  let alive = true; let timer = 0;
  const tick = async () => {
    if (!alive || !el.isConnected && timer) { return; }
    try {
      const d = await eng.torrentDetail!(id); if (!alive) return;
      head.replaceChildren(
        h('span', { class: 'chip small' }, icon('seed'), t('swarmSeeds', { n: localDigits(d.seeds ?? 0), of: localDigits(Math.max(d.seeds ?? 0, d.seedsInSwarm ?? 0)) })),
        h('span', { class: 'chip small' }, icon('user'), t('swarmPeersN', { n: localDigits(Math.max(0, (d.peersConnected ?? 0) - (d.seeds ?? 0))), of: localDigits(d.peersInSwarm ?? 0) })),
        h('span', { class: 'chip small' }, t('swarmRatio', { r: localDigits((d.ratio ?? 0).toFixed(2)) })));
      const ps = [...(d.peers ?? [])].sort((a, b) => b.down + b.up - (a.down + a.up));
      (peersBox.firstChild as HTMLElement).textContent = `${t('swarmPeers')} · ${localDigits(ps.length)}`;
      peers.replaceChildren(...(ps.length ? ps.slice(0, 40).map((p) => h('div', { class: 'swarm-row' }, h('span', { class: 'grow' }, h('span', { dir: 'ltr' }, p.ip), h('small', { class: 'src', dir: 'ltr' }, `${p.client || '?'}${p.utp ? ' · µTP' : ''} · ${localDigits(Math.round(p.progress * 100))}%`)), h('small', { class: 'src swarm-rate' }, `↓ ${rate(p.down)}`, h('br'), `↑ ${rate(p.up)}`))) : [h('p', { class: 'empty small' }, t('swarmNoPeers'))]));
      const trs = d.trackers ?? [];
      (trBox.firstChild as HTMLElement).textContent = `${t('swarmTrackers')} · ${localDigits(trs.filter((x) => x.state === 'working').length)}/${localDigits(trs.length)}`;
      trackers.replaceChildren(...trs.map((x) => h('div', { class: 'swarm-row tr-' + x.state }, h('span', { class: 'tr-dot' }), h('span', { class: 'grow' }, h('span', { dir: 'ltr', class: 'tr-url' }, x.url), x.message ? h('small', { class: 'src', dir: 'auto' }, x.message) : null), h('small', { class: 'src' }, t(`swarmTr_${x.state}` as 'swarmTr_working')))));
      drawLimits(d);
    } catch { /* gone, or not yet added */ }
    if (alive) timer = window.setTimeout(() => void tick(), 2000);
  };
  void tick();
  return { el, dispose: () => { alive = false; clearTimeout(timer); } };
}
