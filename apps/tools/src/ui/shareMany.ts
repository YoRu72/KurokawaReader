// Several files shared at once (the system's share sheet with all of them).
import { ktPlugin } from '../native';
type Plug = { shareFiles?(o: { paths: string[]; title?: string }): Promise<void>; shareFile?(o: { path: string; title: string }): Promise<void> };
export async function shareFiles(paths: string[]): Promise<void> {
  const p = ktPlugin() as unknown as Plug | null; if (!p) return;
  if (p.shareFiles) { await p.shareFiles({ paths }); return; }
  for (const x of paths.slice(0, 1)) await p.shareFile?.({ path: x, title: x.split('/').pop() ?? x });
}
