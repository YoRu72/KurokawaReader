// Run after `npx cap add ios`: declares the document types the app can open
// (so it shows in the iOS share/open sheet) and sets the display name.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const plistPath = path.join(root, 'ios/App/App/Info.plist');
let plist = await fs.readFile(plistPath, 'utf8');

const types = [
  ['EPUB', ['org.idpf.epub-container']], ['PDF', ['com.adobe.pdf']], ['Word document', ['org.openxmlformats.wordprocessingml.document']],
  ['Excel workbook', ['org.openxmlformats.spreadsheetml.sheet']], ['PowerPoint', ['org.openxmlformats.presentationml.presentation']],
  ['Text', ['public.plain-text', 'net.daringfireball.markdown', 'public.html', 'public.comma-separated-values-text']],
  ['Comic archive', ['public.zip-archive']], ['Image', ['public.image']], ['Font', ['public.font', 'public.truetype-ttf-font', 'public.opentype-font']],
  ['Audio', ['public.audio', 'public.mp3', 'public.mpeg-4-audio', 'com.apple.m4a-audio', 'com.apple.protected-mpeg-4-audio']], ['Kindle book', ['public.data']],
];
const docTypes = `  <key>CFBundleDocumentTypes</key>
  <array>
${types.map(([name, utis]) => `    <dict>
      <key>CFBundleTypeName</key><string>${name}</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array>${utis.map((u) => `<string>${u}</string>`).join('')}</array>
    </dict>`).join('\n')}
  </array>
  <key>LSSupportsOpeningDocumentsInPlace</key><true/>
  <key>UIFileSharingEnabled</key><true/>
  <key>UISupportsDocumentBrowser</key><false/>
  <key>CFBundleURLTypes</key>
  <array><dict><key>CFBundleURLName</key><string>app.kurokawa.reader</string><key>CFBundleURLSchemes</key><array><string>kurokawareader</string></array></dict></array>
  <key>NSPhotoLibraryAddUsageDescription</key><string>Saves text snapshots and PDF pages to your Photos.</string>
`;
if (!plist.includes('CFBundleDocumentTypes')) plist = plist.replace(/<dict>\n/, `<dict>\n${docTypes}`);
plist = plist.replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleDisplayName</key>\n  <string>KurokawaReader</string>');
if (!plist.includes('CFBundleDisplayName')) plist = plist.replace(/<dict>\n/, '<dict>\n  <key>CFBundleDisplayName</key>\n  <string>KurokawaReader</string>\n');
if (!plist.includes('UIViewControllerBasedStatusBarAppearance')) plist = plist.replace(/<dict>\n/, '<dict>\n  <key>UIViewControllerBasedStatusBarAppearance</key><true/>\n  <key>UIStatusBarHidden</key><false/>\n');
await fs.writeFile(plistPath, plist);
// Localised display names (iOS picks the one matching the device language).
const NAMES = { ar: 'قارئ كروكاوا', ja: '黒川リーダー', 'zh-Hans': '黑川阅读器', ko: '쿠로카와 리더' };
for (const [code, name] of Object.entries(NAMES)) {
  const dir = path.join(root, `ios/App/App/${code}.lproj`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'InfoPlist.strings'), `CFBundleDisplayName = "${name}";\nCFBundleName = "${name}";\n`);
}
console.log('iOS overlay applied');
