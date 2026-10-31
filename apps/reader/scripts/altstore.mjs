// The AltStore / SideStore source for KurokawaReader, printed as JSON. Added once in AltStore or SideStore
// («Sources» → «+» → the URL), the app appears in their catalogue and every later release shows up as an
// update there — no computer, no re-downloading by hand. Earlier versions are carried over from the source
// already published, so the history stays.
//
//   node scripts/altstore.mjs <version> <owner/repo> <site url> <folder with the ipa>
import fs from 'node:fs';
import path from 'node:path';

const [version, repo, site, ipaDir] = process.argv.slice(2);
if (!version || !repo || !site) { console.error('usage: altstore.mjs <version> <owner/repo> <site url> [ipa dir]'); process.exit(1); }
const owner = repo.split('/')[0];

const ipaName = `KurokawaReader-${version}-ios-unsigned.ipa`;
let size = 0;
try { size = fs.statSync(path.join(ipaDir ?? '', ipaName)).size; } catch { /* unknown size: AltStore still installs */ }

let previous = [];
try {
  const r = await fetch(`${site}/altstore.json`, { signal: AbortSignal.timeout(10000) });
  if (r.ok) previous = ((await r.json()).apps?.[0]?.versions ?? []).filter((v) => v.version !== version);
} catch { /* first time, or offline */ }

const description = 'An offline reader for EPUB, PDF, DOCX, XLSX, PPTX, TXT, comics and audiobooks, with Arabic typography at its heart: a library with folders, tags and smart shelves, a reader with themes, fonts and book formatting, PDF tools and a document scanner, highlights, notes, reviews, AniList tracking, Anki decks, cloud sync — free and open source.';

const current = {
  version,
  date: new Date().toISOString(),
  localizedDescription: `KurokawaReader ${version} — see the release notes on GitHub.`,
  downloadURL: `https://github.com/${repo}/releases/download/v${version}/${ipaName}`,
  size,
  minOSVersion: '14.0',
};

const source = {
  name: 'KurokawaReader',
  identifier: 'app.kurokawa.reader.source',
  subtitle: 'A reader for anything that can be read.',
  description: 'The official source for KurokawaReader. Add it once; updates arrive here.',
  iconURL: `${site}/icons/icon-512.png`,
  headerURL: `${site}/icons/icon-512.png`,
  website: `https://github.com/${repo}`,
  tintColor: '#C9A86A',
  featuredApps: ['app.kurokawa.reader'],
  apps: [{
    name: 'KurokawaReader',
    bundleIdentifier: 'app.kurokawa.reader',
    developerName: owner,
    subtitle: 'EPUB · PDF · DOCX · comics · audiobooks — offline, with Arabic at heart',
    localizedDescription: description,
    iconURL: `${site}/icons/icon-512.png`,
    tintColor: '#C9A86A',
    category: 'utilities',
    screenshots: [],
    versions: [current, ...previous].slice(0, 20),
    appPermissions: { entitlements: [], privacy: { NSCameraUsageDescription: 'The document scanner photographs pages.', NSPhotoLibraryUsageDescription: 'Pictures are scanned into documents and covers are chosen from the library.' } },
  }],
  news: [{
    title: `KurokawaReader ${version}`,
    identifier: `release-${version}`,
    caption: 'A new release is out.',
    date: current.date,
    tintColor: '#C9A86A',
    url: `https://github.com/${repo}/releases/tag/v${version}`,
    appID: 'app.kurokawa.reader',
    notify: true,
  }],
};

process.stdout.write(JSON.stringify(source, null, 2) + '\n');
