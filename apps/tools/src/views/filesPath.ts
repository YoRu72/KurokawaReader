// A path's letters made plain, the same for the phone's storage and a computer's (no imports: tests load it alone).

/** A storage path (one starting at «/», a drive «C:/» or a share «//host/name»; a computer's «\» read as «/») with
 *  «.» and «..» resolved by the letters alone — never above the root, the drive or the share —, single slashes, and no
 *  trailing one but the root's own («/», «C:/»). Anything else (a link, an archive's inside, a name) comes back as it was. */
export function resolvePath(p: string): string {
  const v = /^[A-Za-z]:\\|^\\\\/.test(p) ? p.replace(/\\/g, '/') : p;
  let head: string; let rest: string;
  const drive = /^([A-Za-z]:)(\/|$)/.exec(v);
  if (drive) { head = `${drive[1]}/`; rest = v.slice(drive[1].length); }
  else if (/^\/\/[^/]/.test(v)) { const m = /^\/\/([^/]+)(?:\/([^/]*))?/.exec(v) as RegExpExecArray; head = m[2] ? `//${m[1]}/${m[2]}/` : `//${m[1]}/`; rest = v.slice(m[0].length); }
  else if (v.startsWith('/')) { head = '/'; rest = v; }
  else return p;
  const out: string[] = [];
  for (const s of rest.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
  if (!out.length) return head.startsWith('//') ? head.replace(/\/$/, '') : head;
  return head + out.join('/');
}
/** The folder a path lies in — a drive's root keeps its slash («C:/», never the drive-relative «C:»). */
export function dirOfPath(p: string): string { const d = p.replace(/\/+$/, '').replace(/\/[^/]*$/, ''); return /^[A-Za-z]:$/.test(d) ? `${d}/` : d || '/'; }
/** `dest` is one of `paths` or lies inside one — a folder pasted into itself (whole names compared after «.» and «..»
 *  are resolved, letter case aside: the phone's storage ignores it; /a/b and /a/bc are strangers; a computer's «\\» is a «/»). */
export const intoItself = (paths: string[], dest: string): boolean => { const norm = (x: string) => resolvePath(x.replace(/\\/g, '/')).replace(/\/+$/, '').toLowerCase() + '/'; const d = norm(dest); return paths.some((p) => d.startsWith(norm(p))); };
