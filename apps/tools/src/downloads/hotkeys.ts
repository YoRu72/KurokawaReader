// The clipboard hotkeys (a computer): the main process reads the clipboard on the shortcut and hands the text here
// with its mode — video (the preferred quality), audio only, a file as it is, or the add sheet to look first — and
// the result is said plainly: added, nothing to add, already here.
import { getEngine } from '../engine';
import { parseSources } from '../engine';
import { toast } from '../ui/dom';
import { t } from '../i18n';
import { getSettings } from '../settings';
import { navigate } from '../router';
type Desk = { onHotkeyAdd?(cb: (p: { mode: string; text: string }) => void): () => void; onOpenTask?(cb: (id: string) => void): () => void };
export function startHotkeys(): void {
  const d = window.kurokawaTools as unknown as Desk | undefined; if (!d?.onHotkeyAdd) return;
  d.onOpenTask?.((id) => navigate(`/task/${id}`));
  d.onHotkeyAdd(async ({ mode, text }) => {
    const srcs = parseSources(text ?? ''); if (!srcs.length) { toast(t('hotkeyNothing'), 'error'); return; }
    if (mode === 'clip') { const { addSheet } = await import('../views/add'); addSheet(text); return; }
    const eng = getEngine(); const have = await eng.list().catch(() => []);
    let n = 0, dup = 0;
    for (const src of srcs) {
      if (have.some((x) => x.source.url && x.source.url === src.url && x.state !== 'failed')) { dup++; continue; }
      try {
        if ((mode === 'video' || mode === 'audio') && src.url) {
          const { videoEnabled } = await import('../video/ytdlp'); const { preferredFormat } = await import('../views/addVideo');
          if (videoEnabled()) { const s = getSettings(); const pf = mode === 'audio' ? { format: 'bestaudio/best', audioOnly: true, label: '' } : preferredFormat(); await eng.add({ source: src, dir: s.downloadDir || undefined, video: { ...pf, container: pf.audioOnly ? undefined : s.videoContainer, embedThumb: s.videoEmbedThumb, sponsorblock: s.videoSponsor } }); n++; continue; }
        }
        await eng.add({ source: src, dir: getSettings().downloadDir || undefined, connections: 8 }); n++;
      } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
    }
    if (n) toast(t('hotkeyAdded', { n: String(n), mode: mode === 'audio' ? t('videoAudioOnly') : mode === 'video' ? t('navVideos') : t('hotkeyFile') }));
    if (dup) toast(t('hotkeyDup', { n: String(dup) }), 'error');
  });
}
