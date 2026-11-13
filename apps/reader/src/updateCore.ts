// The release feed both Kurokawa apps update from (the same file in each app): the repository's releases whose
// tag has the app's prefix (v… for the reader, tools-v… for Tools) — newest first, never another app's —; when
// GitHub's API cannot be reached (its hourly limit, a network that blocks it), the releases' Atom feed instead,
// with each file's address made from the names the release workflow gives them. Also: the notes of every version
// since the one running, and a file's SHA-256 as GitHub states it, to check a download against.
export interface RelAsset { name: string; url: string; size: number; digest?: string }
export interface Rel { tag: string; version: string; url: string; notes: string; publishedAt?: string; prerelease: boolean; assets: RelAsset[]; fromFeed?: boolean }
export interface Fetched { status: number; body: string }
export type FetchText = (url: string, accept?: string) => Promise<Fetched>;

/** Two versions compared as SemVer does: the numbers first (as many parts as given), then a pre-release
 *  («-beta.2») before the release itself, its parts compared as numbers where both are numbers, else as text; build
 *  metadata («+…») left out. Negative when `a` is older. */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string) => { const s = v.trim().replace(/^v/i, '').split('+')[0]; const i = s.indexOf('-'); return { core: (i < 0 ? s : s.slice(0, i)).split('.').map((x) => Number(x) || 0), pre: i < 0 ? [] : s.slice(i + 1).split('.').filter(Boolean) }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length, 3); i++) { const d = (x.core[i] ?? 0) - (y.core[i] ?? 0); if (d) return d; }
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]; if (p === undefined) return -1; if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { const d = Number(p) - Number(q); if (d) return d; } else if (pn !== qn) return pn ? -1 : 1; else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
const isOurs = (tag: string, prefix: string) => tag.startsWith(prefix) && /^\d+\.\d+/.test(tag.slice(prefix.length));

type Raw = { tag_name: string; html_url: string; body?: string; published_at?: string; prerelease?: boolean; draft?: boolean; assets: { name: string; browser_download_url: string; size: number; digest?: string | null }[] };
/** The app's releases, newest first. `prereleases`: whether pre-releases count (the beta channel; Tools'
 *  releases are all pre-releases). `appName` names the files when the feed has to stand in for the API. */
export async function listReleases(o: { repo: string; prefix: string; appName: string; prereleases: boolean; fetchText: FetchText }): Promise<Rel[]> {
  let apiError: unknown = null;
  try {
    const r = await o.fetchText(`https://api.github.com/repos/${o.repo}/releases?per_page=60`, 'application/vnd.github+json');
    if (r.status === 200) {
      const raw = JSON.parse(r.body) as Raw[];
      return raw.filter((x) => !x.draft && isOurs(x.tag_name, o.prefix) && (o.prereleases || !x.prerelease))
        .map((j) => ({ tag: j.tag_name, version: j.tag_name.slice(o.prefix.length), url: j.html_url, notes: j.body ?? '', publishedAt: j.published_at, prerelease: !!j.prerelease, assets: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest ?? undefined })) }))
        .sort((a, b) => cmpVersion(b.version, a.version));
    }
    apiError = new Error(r.status === 403 || r.status === 429 ? 'rate' : `HTTP ${r.status}`);
  } catch (e) { apiError = e; }
  // The Atom feed: tags, dates and notes (no files, no pre-release mark — so on the stable channel only versions
  // without a «-» suffix are taken).
  try {
    const r = await o.fetchText(`https://github.com/${o.repo}/releases.atom`, 'application/atom+xml');
    if (r.status !== 200) throw apiError ?? new Error(`HTTP ${r.status}`);
    const out: Rel[] = [];
    for (const m of r.body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const e = m[1]; const link = /<link[^>]*href="([^"]+)"/.exec(e)?.[1] ?? ''; const tag = decodeURIComponent(link.split('/releases/tag/')[1] ?? '');
      if (!isOurs(tag, o.prefix)) continue; const version = tag.slice(o.prefix.length);
      if (!o.prereleases && /-/.test(version)) continue;
      const html = unescapeXml(/<content[^>]*>([\s\S]*?)<\/content>/.exec(e)?.[1] ?? '');
      out.push({ tag, version, url: link, notes: htmlToNotes(html), publishedAt: /<updated>([^<]+)<\/updated>/.exec(e)?.[1], prerelease: false, assets: conventionalAssets(o.repo, o.appName, tag, version), fromFeed: true });
    }
    return out.sort((a, b) => cmpVersion(b.version, a.version));
  } catch (e) { throw apiError ?? e; }
}
/** The files a release has, by the names the release workflow gives them (sizes unknown). */
export function conventionalAssets(repo: string, app: string, tag: string, v: string): RelAsset[] {
  const names = ['arm64-v8a.apk', 'armeabi-v7a.apk', 'x86_64.apk', 'universal.apk', 'win-x64.exe', 'win-x64-portable.exe', 'mac-universal.dmg', 'linux-x86_64.AppImage', 'ios-unsigned.ipa', ...(app === 'KurokawaReader' ? RUST_TAILS : [])].map((x) => `${app}-${v}-${x}`).concat(`${app}-web.zip`);
  return names.map((name) => ({ name, url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`, size: 0 }));
}
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** Rendered notes (the feed's HTML) back to the Markdown lines the apps read: headings and bullets. */
export function htmlToNotes(html: string): string {
  return html.replace(/<h(\d)[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, x: string) => `\n${'#'.repeat(Number(n))} ${x}\n`).replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, x: string) => `\n- ${x.replace(/\n/g, ' ')}`)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}
/** The releases after `current`, newest first (what an update brings, version by version). */
export const newerThan = (list: Rel[], current: string): Rel[] => list.filter((r) => cmpVersion(r.version, current) > 0);
/** The «What's new» bullets of a release's notes (the files table and the install guide left out). */
export function whatsNew(md: string): string[] {
  const section = /##\s*What['’]s new\s*([\s\S]*?)(?:\n##\s|$)/i.exec(md)?.[1] ?? md;
  return section.split('\n').map((l) => l.trim()).filter((l) => /^[-*•]\s/.test(l)).map((l) => l.replace(/^[-*•]\s*/, '').replace(/\*\*/g, '').replace(/`/g, '')).slice(0, 40);
}
/** The file's SHA-256 as GitHub states it, when it does. */
export const sha256Of = (a: RelAsset): string | undefined => (a.digest && /^sha256:[0-9a-f]{64}$/i.test(a.digest) ? a.digest.slice(7).toLowerCase() : undefined);

/** The version this build last ran as, and whether it has changed since (an update just installed). */
export function versionChange(key: string, now: string): string | null {
  let before: string | null = null; try { before = localStorage.getItem(key); localStorage.setItem(key, now); } catch { /* no storage */ }
  return before && before !== now && cmpVersion(now, before) > 0 ? before : null;
}

/* ---------- the Rust (Tauri) build's files (stage R6b) ---------- */
// The release files of the Reader's Tauri build, by the names the release workflow gives them — the same as
// desktop-tauri/src-tauri/src/updatelogic.rs (asset_name) and desktop/rustswitch.cjs (tests/updatenames.cjs keeps
// the three equal): KurokawaReader-<v>-windows-x64-setup.exe, …-windows-x64-portable.zip, …-macos-universal.DMG,
// …-linux-x64.appimage, …-linux-x64.deb, and the checksums …-SHA256SUMS.txt. None of them matches the patterns every
// Electron copy's page picks its file by (updates.ts suitableAsset: /win-x64.*\.exe$/, the first /\.dmg$/, the first
// /\.AppImage$/ — case-sensitive, and frozen in the copies out there), so an Electron copy never takes one and skips
// the hand-over, whatever order a release lists its files in. (The case of «.DMG» and «.appimage» changes nothing for
// macOS or Linux, which go by the extension whatever its case.)
export const RUST_TAILS = ['windows-x64-setup.exe', 'windows-x64-portable.zip', 'macos-universal.DMG', 'linux-x64.appimage', 'linux-x64.deb', 'SHA256SUMS.txt'];
/** The kinds of copy the Tauri build tells the page (window.__KR_BOOT__.kind: src-tauri/src/update.rs). */
export type RustKind = 'nsis' | 'portable' | 'appimage' | 'deb' | 'app' | 'bare';
/** The release file that updates a copy of the Tauri build of this kind (Node's OS and arch names). */
export function rustAsset(assets: RelAsset[], os: string, arch: string, kind: RustKind | string): RelAsset | undefined {
  const a = arch === 'arm64' || arch === 'aarch64' ? 'arm64' : 'x64';
  const tail = os === 'win32' ? (kind === 'portable' ? `-windows-${a}-portable.zip` : `-windows-${a}-setup.exe`)
    : os === 'darwin' ? '-macos-universal.DMG'
    : kind === 'deb' ? `-linux-${a}.deb` : `-linux-${a}.appimage`;
  return assets.find((x) => x.name.startsWith('KurokawaReader-') && x.name.endsWith(tail))
    ?? (os === 'darwin' ? assets.find((x) => x.name.startsWith('KurokawaReader-') && x.name.endsWith(`-macos-${a}.DMG`)) : undefined);
}
