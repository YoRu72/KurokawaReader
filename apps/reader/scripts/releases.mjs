// The releases page's data: GitHub's releases (`gh api --paginate --slurp …/releases`, or one per line)
// boiled down to what the page shows — the app, the version, the date, the notes («What's new» only), the files.
// Usage: node releases.mjs releases.json > site/releases/releases.json
import fs from 'node:fs';

const text = fs.readFileSync(process.argv[2], 'utf8');
// (Either one JSON array — `--slurp`'s array of pages included — or one release per line.)
let all; try { all = [JSON.parse(text)].flat(2); } catch { all = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); }
const out = [];
for (const r of all) {
  // (The reader's releases only: Kurokawa Tools stays a pre-release on GitHub, off this page; nor the decks' or packs'.)
  if (r.draft || !/^v\d/.test(r.tag_name)) continue;
  const tools = r.tag_name.startsWith('tools-');
  const version = r.tag_name.replace(/^tools-/, '').replace(/^v/, '');
  // («What's new» from the release's text: from its heading to the next second-level heading; a release without one
  // keeps its text before «Files».)
  const body = (r.body ?? '').replace(/\r/g, '');
  let notes = body;
  const at = body.search(/^## What's new\s*$/m);
  if (at >= 0) { notes = body.slice(at).replace(/^## What's new\s*\n/, ''); const end = notes.search(/^## /m); if (end >= 0) notes = notes.slice(0, end); }
  else { const end = body.search(/^## (Files|Installing)/m); if (end >= 0) notes = body.slice(0, end); notes = notes.replace(/^## .*(Kurokawa|v\d).*\n/m, ''); }
  out.push({
    app: tools ? 'tools' : 'reader', version, tag: r.tag_name, date: r.published_at ?? r.created_at, pre: !!r.prerelease,
    url: r.html_url, notes: notes.trim(),
    assets: (r.assets ?? []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url, n: a.download_count })),
  });
}
const num = (v) => v.split(/[.-]/).map((x) => +x || 0);
out.sort((a, b) => { const x = num(b.version), y = num(a.version); for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; });
process.stdout.write(JSON.stringify({ made: new Date().toISOString(), releases: out }));
