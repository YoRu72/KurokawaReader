// Where a task's file is on the disk: its folder, then the file's path — which for a torrent of several files the
// engines (libtorrent, aria2) already begin with the torrent's own folder; older tasks without it get it added.
// None for a folder Android gives by its own address (content:).
import type { Task } from './types';

export function localPathOf(x: Task, index: number): string | undefined {
  const f = x.files.find((g) => g.index === index); if (!f || !x.dir || x.dir.startsWith('content:')) return undefined;
  const sep = x.dir.includes('\\') && !x.dir.includes('/') ? '\\' : '/';
  const rel = f.path.replace(/^[\\/]+/, '');
  const inFolder = x.kind === 'torrent' && x.files.length > 1 && !(rel.startsWith(`${x.name}/`) || rel.startsWith(`${x.name}\\`));
  return `${x.dir.replace(/[\\/]+$/, '')}${sep}${inFolder ? `${x.name}${sep}` : ''}${rel}`;
}
