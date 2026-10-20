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
  ['Comic archive', ['public.zip-archive']], ['Image', ['public.image']],
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
`;
if (!plist.includes('CFBundleDocumentTypes')) plist = plist.replace(/<dict>\n/, `<dict>\n${docTypes}`);
plist = plist.replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleDisplayName</key>\n  <string>قارئ كروكاوا</string>');
if (!plist.includes('CFBundleDisplayName')) plist = plist.replace(/<dict>\n/, '<dict>\n  <key>CFBundleDisplayName</key>\n  <string>قارئ كروكاوا</string>\n');
await fs.writeFile(plistPath, plist);
console.log('iOS overlay applied');
