// After the hand-over (stage P9; desktop-tauri/PORTING.md «Downloads: one owner»): the downloads both versions of the
// app on a computer share run in ONE of them. When the other one holds them, this one says so plainly — a resume
// refused («kt-owner:held»), or the other taking them back while this one ran them — and offers «Take them back»,
// asked first. The shells' side: desktop/ownerlock.cjs (the Electron bridge build), src-tauri/src/ownerlock.rs.
// Nothing here runs on a phone, the web, or an Electron build whose switch is off (owner() answers null there).
import { h, icon, openSheet, toast } from './dom';
import { t } from '../i18n';
import { getEngine } from '../engine';

type OwnerInfo = { held: boolean; status?: string; by?: string | null; since?: number | null; count?: number; ok?: boolean } | null;
type OwnerApi = { owner?(): Promise<OwnerInfo>; takeDownloads?(): Promise<OwnerInfo>; onOwner?(cb: (o: OwnerInfo) => void): () => void };
const api = (): OwnerApi | undefined => (window as unknown as { kurokawaHandover?: OwnerApi }).kurokawaHandover;

/** Whether an error is the shells' «another program runs this download». */
export const isOwnerHeld = (e: unknown): boolean => /kt-owner:held/.test(String((e as Error)?.message ?? e));

let open = false;
/** The sheet: who runs them, how many, «Take them back» (asked first); `retry` is resumed once taken back. */
export async function ownerSheet(retry?: string): Promise<void> {
  const a = api(); if (!a?.owner || open) return;
  const info = await a.owner().catch(() => null); if (!info) return;
  open = true;
  const s = openSheet(t('ownerHeldTitle'), t('close'), { onClose: () => { open = false; } });
  s.el.dataset.owner = 'held';
  const who = info.by === 'tauri' ? t('ownerWhoNew') : t('ownerWhoOld');
  s.body.append(h('p', null, t('ownerHeldBody', { who, n: String(info.count ?? 0) })));
  const take = h('button', { type: 'button', class: 'btn primary', 'data-act': 'owner-take', onclick: () => void ask() }, icon('download'), t('ownerTakeBack'));
  s.actions.prepend(take);
  const ask = async (): Promise<void> => {
    const q = openSheet(t('ownerTakeAsk'), t('cancel'), { stack: true });
    q.el.dataset.owner = 'ask';
    q.body.append(h('p', null, t('ownerTakeAskBody')));
    q.actions.prepend(h('button', { type: 'button', class: 'btn primary', 'data-act': 'owner-take-yes', onclick: async () => {
      q.close();
      const r = await a.takeDownloads?.().catch(() => null);
      if (r && r.ok) {
        toast(t('ownerTaken')); s.close();
        if (retry) await getEngine().resume(retry).catch(() => undefined);
      } else toast(t('ownerTakeFailed'), 'error', 6000);
    } }, icon('download'), t('ownerTakeBack')));
  };
}

/** At the start: told when the other program holds them now, or takes them back later. */
export function startOwnerWatch(): void {
  const a = api(); if (!a?.owner) return;
  const say = (o: OwnerInfo, words: string) => { if (o && o.held) toast(words, 'info', 9000, { label: t('ownerTakeBack'), run: () => void ownerSheet() }); };
  void a.owner().then((o) => say(o, t('ownerHeldShort'))).catch(() => undefined);
  a.onOwner?.((o) => say(o, t('ownerYielded')));
}
