// Files handed to the system's share sheet (another app, a chat, Nearby Share) — one, or several at once.
import { ktPlugin } from '../native';
type Plug = { shareFiles?(o: { paths: string[]; title?: string }): Promise<void>; shareFile?(o: { path: string; title: string }): Promise<void> };
/** Whether this device has a share sheet the app can hand files to (a phone). */
export const canShareFiles = (): boolean => { const p = ktPlugin() as unknown as Plug | null; return !!(p?.shareFiles || p?.shareFile); };
export async function shareFiles(paths: string[]): Promise<void> {
  const p = ktPlugin() as unknown as Plug | null; if (!p) return;
  if (p.shareFiles) { await p.shareFiles({ paths }); return; }
  for (const x of paths.slice(0, 1)) await p.shareFile?.({ path: x, title: x.split('/').pop() ?? x });
}
