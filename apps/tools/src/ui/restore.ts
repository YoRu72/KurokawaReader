// Android ending the page's renderer to free memory (native MainActivity.onRenderProcessGone) loads the page again at its
// start. Once, on that load only, the reader is brought back where he was: the same page and folder, its scroll, the
// Files clipboard (the folder's selection is not kept), the jobs still running shown again (views/files.ts), and one
// calm line says what happened. Every other start of the app opens as it always did.
import { ktPlugin } from '../native';
import { navigate } from '../router';
import { toast } from './dom';
import { placePill } from './pill';
import { t } from '../i18n';

/** `route`: the place the page was at (read before this load could write over it). */
export async function afterRendererLoss(route: string | null): Promise<void> {
  const p = ktPlugin() as unknown as { pageRestored?(): Promise<{ gone?: boolean }> } | null;
  let gone = false; try { gone = !!(await p?.pageRestored?.())?.gone; } catch { return; }
  if (!gone) return;
  // (The waiting jobs of the run that ended are that run's unfinished jobs at once — offered, never run by themselves.)
  try { const q = JSON.parse(localStorage.getItem('kt.files.queue') ?? 'null') as { beat?: number } | null; if (q && typeof q === 'object' && !Array.isArray(q)) localStorage.setItem('kt.files.queue', JSON.stringify({ ...q, beat: 0 })); } catch { /* none */ }
  let files: unknown = null; try { files = JSON.parse(localStorage.getItem('kt.resume.files') ?? 'null'); } catch { files = null; }
  (window as unknown as { __ktResumeFiles?: unknown }).__ktResumeFiles = files && typeof files === 'object' ? files : null;
  const to = route && /^#\/[^\s]{0,2000}$/.test(route) ? route.slice(1) : null;
  if (to && to !== (location.hash.replace(/^#/, '') || '/')) navigate(to, true);
  toast(t('pageRestored'), 'info', 6000);
  // (Its line wide enough to read in one or two lines, above the bars along the bottom — the clipboard's among them —, as they come.)
  const el = [...document.querySelectorAll<HTMLElement>('.toast')].pop(); if (!el) return; el.classList.add('restored-line');
  const place = () => placePill(el); place(); let n = 0; const tick = window.setInterval(() => { if (!el.isConnected || ++n > 30) { window.clearInterval(tick); return; } place(); }, 200);
}
