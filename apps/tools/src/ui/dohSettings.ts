// DNS over HTTPS in Settings (0.21 P9), the same on the phone and on a computer as far as each shell allows: the
// choice (off, «automatic» — the quickest healthy resolver first —, one resolver pinned first, or the user's own
// address, checked), the opt-in fall-back to the system's DNS with what it costs, each resolver's health (on demand:
// «Check now»; the shells also check by themselves at most every half hour, only while names are being asked), and
// what goes through DoH on this device — honestly, a «no» where the shell cannot. Loaded only with Settings' privacy
// card; no timer of its own.
import { h, icon, toast, pickButton } from './dom';
import { t, localDigits } from '../i18n';
import { ktPlugin, nativePlatform } from '../native';
import { getSettings, updateSettings } from '../settings';
import { DOH_PROVIDERS, dohLabel, dohChoice, validateDohUrl } from '../dohProviders';
import { reasonText } from './dohLine';

export type DohHealth = { id: string; label?: string; url?: string; filters?: string; ok?: boolean | null; ms?: number | null; at?: number | null; reason?: string };
export type DohState = { on: boolean; allowSystem: boolean; order: string[]; providers: DohHealth[]; custom?: { ok: boolean; ms: number; at: number; reason?: string } | null; lastProbe?: number | null; queries?: number; fails?: number; system?: number; ok?: boolean; resolver?: string; ms?: number; why?: string };
export type DohUsed = { on: boolean; hosts: Record<string, { via: string; at: number }> };
type Api = { set(o: { provider: string; allowSystem: boolean; split?: string }): Promise<unknown>; status(probe: boolean): Promise<DohState | null>; used(hosts: string[]): Promise<DohUsed | null> };

type Plug = { setDoh?(o: object): Promise<unknown>; dohStatus?(o: { probe?: boolean }): Promise<DohState & { probe?: { ok: boolean; resolver?: string; ms?: number; why?: string } }>; dohUsed?(o: { hosts: string[] }): Promise<DohUsed> };
type Desk = { setDoh?(o: object): Promise<unknown>; dohProbe?(): Promise<DohState>; dohStatus?(): Promise<DohState>; dohUsed?(o: { hosts: string[] }): Promise<DohUsed>; shell?: unknown };

/** Which shell: the phone, Electron or Tauri (each covers different traffic). */
export function dohShell(): 'android' | 'electron' | 'tauri' | 'web' {
  if (nativePlatform() === 'android') return 'android';
  const d = window.kurokawaTools as unknown as Desk | undefined; if (!d) return 'web';
  return d.shell === 'electron' ? 'electron' : 'tauri';
}

/** The shell's DoH calls (null on the web, where there is none). */
export function dohApi(): Api | null {
  const d = window.kurokawaTools as unknown as Desk | undefined;
  if (d?.setDoh) return {
    set: (o) => d.setDoh!({ provider: o.provider, allowSystem: o.allowSystem }),
    status: async (probe) => (probe ? (d.dohProbe ? await d.dohProbe() : null) : d.dohStatus ? await d.dohStatus() : null),
    used: async (hosts) => (d.dohUsed ? await d.dohUsed({ hosts }) : null),
  };
  const p = ktPlugin() as unknown as Plug | null;
  if (p?.setDoh) return {
    set: (o) => p.setDoh!(o),
    status: async (probe) => { if (!p.dohStatus) return null; const s = await p.dohStatus({ probe }); return s.probe ? { ...s, ok: s.probe.ok, resolver: s.probe.resolver, ms: s.probe.ms, why: s.probe.why } : s; },
    used: async (hosts) => (p.dohUsed ? await p.dohUsed({ hosts }) : null),
  };
  return null;
}

/** The choice put in force (and the hello-split choice on the phone). */
export function applyDoh(): Promise<unknown> { const s = getSettings(); const a = dohApi(); return a ? a.set({ provider: s.doh, allowSystem: !!s.dohSystem, ...(nativePlatform() === 'android' ? { split: s.dohSplit ?? 'auto' } : {}) }) : Promise.resolve(); }

const ago = (at: number): string => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? t('secondsAgo', { n: localDigits(s) }) : s < 3600 ? t('minutesAgo', { n: localDigits(Math.floor(s / 60)) }) : t('hoursAgo', { n: localDigits(Math.floor(s / 3600)) }); };
const filterText = (f?: string): string => (f && f !== 'none' ? t(('dohFilter_' + f) as 'dohFilter_ads') : '');

/** The rows of the DoH part of the privacy card. `row`, `toggle` are Settings' own; `rerender` draws the page again. */
export function dohSection(o: { row: (label: string, control: Node, hint?: string) => HTMLElement; toggle: (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => HTMLElement; rerender: () => void }): HTMLElement[] {
  const s = getSettings(); const api = dohApi(); const custom = /:\/\//.test(s.doh); const shell = dohShell();
  const set = (patch: Partial<ReturnType<typeof getSettings>>, say?: string) => { updateSettings(patch); void applyDoh().then(() => { if (say) toast(say); }).catch((er) => toast(String((er as Error).message ?? er), 'error')); };
  // (The choice: off, automatic, a resolver pinned first, or one's own address.)
  const opts: [string, string, string?][] = [['off', t('dohOff')], ['auto', t('dohAuto'), t('dohAutoSub')], ...DOH_PROVIDERS.map((p): [string, string, string?] => [p.id, p.label, filterText(p.filters) || undefined]), ['custom', t('dohCustom')]];
  const cur = custom ? 'custom' : dohChoice(s.doh);
  const err = h('p', { class: 'hint doh-err', role: 'alert', hidden: true });
  const field = h('input', { type: 'url', dir: 'ltr', class: 'doh-url', placeholder: 'https://…/dns-query', 'aria-label': t('dohCustom'), value: custom ? s.doh : '',
    onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); const why = validateDohUrl(v); err.hidden = why === 'ok'; if (why !== 'ok') { err.textContent = t(('dohBad_' + why) as 'dohBad_notHttps'); return; } set({ doh: v }, t('dohOn', { name: v })); } }) as HTMLInputElement;
  const fieldWrap = h('div', { class: 'doh-custom', hidden: !custom }, field, err, h('p', { class: 'hint' }, t('dohCustomHint')));
  const picker = pickButton(t('dohTitle'), opts as [string, string, string?][], cur, (v) => { if (v === 'custom') { fieldWrap.hidden = false; field.focus(); return; } set({ doh: v }, v === 'off' ? t('dohOff') : t('dohOn', { name: v === 'auto' ? t('dohAuto') : dohLabel(v) })); o.rerender(); }, t('close'));
  const modeHint = s.doh === 'off' ? t('dohHint') : dohChoice(s.doh) === 'auto' ? t('dohAutoHint') : custom ? t('dohCustomFirstHint') : t('dohPinnedHint', { name: dohLabel(s.doh) });
  const out: HTMLElement[] = [o.row(t('dohTitle'), picker, modeHint), fieldWrap];
  if (s.doh === 'off' || !api) return out;
  // (The system's DNS when every resolver failed: the user's choice, off by default, its cost said plainly.)
  out.push(o.toggle(t('dohSystemTitle'), !!s.dohSystem, (v) => set({ dohSystem: v }), t('dohSystemHint')));
  // (Each resolver's health, on demand.)
  const list = h('div', { class: 'doh-health-list' }); const foot = h('small', { class: 'src doh-health-foot' });
  const check = h('button', { type: 'button', class: 'btn tonal small', onclick: () => void paint(true) }, icon('refresh'), t('dohCheckNow')) as HTMLButtonElement;
  const box = h('div', { class: 'doh-health', 'data-state': 'idle' }, h('div', { class: 'doh-health-head' }, h('b', null, t('dohHealthTitle')), check), list, foot);
  const rowOf = (id: string, label: string, hl: DohHealth | null, first: boolean) => {
    const state = !hl || hl.ok == null ? 'none' : hl.ok ? 'ok' : 'fail';
    const right = state === 'ok' ? t('dohHealthOk', { ms: localDigits(Math.max(0, Math.round(hl!.ms ?? 0))) }) : state === 'fail' ? t('dohHealthFail', { why: reasonText(hl!.reason) }) : t('dohHealthNone');
    const f = filterText(DOH_PROVIDERS.find((p) => p.id === id)?.filters);
    return h('div', { class: `doh-hrow h-${state}`, 'data-id': id }, h('span', { class: 'doh-dot', 'aria-hidden': 'true' }), h('span', { class: 'grow' }, h('span', { dir: 'auto' }, label), first ? h('span', { class: 'doh-first' }, t('dohAskedFirst')) : null, f ? h('small', { class: 'src' }, f) : null), h('small', { class: 'doh-hstate', dir: 'auto' }, right));
  };
  const paint = async (probe: boolean) => {
    check.disabled = true; box.dataset.state = probe ? 'checking' : 'idle'; if (probe) foot.textContent = t('dohChecking');
    try {
      const st = await api.status(probe); if (!st || !box.isConnected && !probe) return;
      const byId = new Map((st.providers ?? []).map((p) => [p.id, p]));
      const order = st.order?.length ? st.order : DOH_PROVIDERS.map((p) => p.id);
      list.replaceChildren(...order.map((id, i) => (id === 'custom' ? rowOf('custom', t('dohCustomName'), st.custom ? { id: 'custom', ...st.custom } : null, i === 0) : rowOf(id, dohLabel(id), byId.get(id) ?? null, i === 0))));
      const counts = [st.queries != null ? `${t('dohQueries')}: ${localDigits(st.queries)}` : '', st.fails ? `${t('dohFailed')}: ${localDigits(st.fails)}` : '', st.system ? `${t('dohSystemCount')}: ${localDigits(st.system)}` : ''].filter(Boolean).join(' · ');
      foot.textContent = [st.lastProbe ? t('dohLastCheck', { when: ago(st.lastProbe) }) : t('dohNeverChecked'), counts].filter(Boolean).join(' · ');
      if (probe) { box.dataset.state = st.ok ? 'ok' : 'failed'; toast(st.ok ? t('dohProbeOk', { resolver: dohLabel(st.resolver ?? ''), ms: localDigits(st.ms ?? 0) }) : t('dohProbeFailed', { error: reasonText(st.why) }), st.ok ? undefined : 'error'); }
    } catch (e) { foot.textContent = reasonText(String((e as Error).message ?? e)); box.dataset.state = 'failed'; }
    finally { check.disabled = false; if (box.dataset.state === 'checking') box.dataset.state = 'idle'; }
  };
  void paint(false);
  out.push(box);
  // (What goes through DoH here — and what does not, said plainly.)
  // (A resolver on this device cannot be given to Electron's Chromium: its own requests use the public resolvers then.)
  const Y = 'yes', E = 'engine', S = 'system', D = 'yesDrop', P = /^http:\/\//i.test(s.doh) ? 'public' : 'yes';
  const cover: [string, string][] = shell === 'android'
    ? [['app', Y], ['downloads', Y], ['streams', Y], ['trUdp', D], ['trHttp', E], ['webviews', Y], ['cloud', S]]
    : shell === 'electron'
      ? [['app', P], ['downloads', Y], ['trHttp', Y], ['trUdpMagnet', D], ['trUdpFile', E], ['webviews', P], ['videoTools', S], ['ftp', S]]
      : [['app', Y], ['downloads', Y], ['trHttp', Y], ['trUdpMagnet', D], ['trUdpFile', E], ['webviews', S], ['videoTools', S], ['ftp', S]];
  out.push(h('details', { class: 'doh-cover' }, h('summary', null, t('dohCoverTitle')), h('ul', { class: 'doh-cover-list' }, ...cover.map(([k, v]) => h('li', { class: `c-${v}` }, h('span', { class: 'doh-dot', 'aria-hidden': 'true' }), h('span', { class: 'grow' }, t(('dohCover_' + k) as 'dohCover_app')), h('small', { class: 'src' }, t(('dohCoverIs_' + v) as 'dohCoverIs_yes'))))), h('p', { class: 'hint' }, t('dohCoverHint'))));
  return out;
}
