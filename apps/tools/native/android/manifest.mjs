// The app's AndroidManifest.xml, patched (called by overlay.mjs after `npx cap add android`; a pure function so
// tests/openwith.cjs can run it on a fixture): permissions, services, the hand-written intent filters (magnets,
// .torrent files, links shared, the installer, the player, «Save to device», the picker) and the activity-aliases of
// «Open with» written from openwith.json — each with its own switch in Settings → Files.
import { readFileSync } from 'node:fs';
import { A11Y_SERVICE } from './a11y.mjs';

/** The «Open with» table (openwith.json). */
export const OPEN_WITH = JSON.parse(readFileSync(new URL('./openwith.json', import.meta.url), 'utf8'));

/** Path patterns for these extensions, as the manifest writes them (`\\.` is a dot to aapt and to Android's glob):
 *  lower and upper case, the name with up to three more dots before the extension (Android's `.*` stops at the first
 *  dot it can, so «[Group] Show.S01.E03.zip» needs the longer forms — ZArchiver's ladder, four steps here). */
export function pathPatterns(exts) {
  const dot = '\\\\.'; const out = [];
  for (const e of exts) for (const x of [...new Set([e.toLowerCase(), e.toUpperCase()])]) for (let n = 0; n < 4; n++) out.push(`.*${(dot + '.*').repeat(n)}${dot}${x}`);
  return out;
}
const CAT = (c) => `        <category android:name="android.intent.category.${c}" />`;
/** One entry of the table as an activity-alias of KtOpenActivity (the invisible activity that stays in the calling
 *  app's task and hands the files to the page). Off ones are written android:enabled="false": the switch in
 *  Settings → Files turns them on (PackageManager.setComponentEnabledSetting). */
export function aliasXml(e, target = OPEN_WITH.target) {
  const filters = e.filters.map((f) => {
    const lines = [`      <intent-filter android:label="@string/${e.res}">`, ...f.actions.map((a) => `        <action android:name="${a}" />`), CAT('DEFAULT')];
    for (const s of f.schemes ?? []) lines.push(`        <data android:scheme="${s}" />`);
    if (f.host) lines.push(`        <data android:host="${f.host}" />`);
    for (const m of f.mimes ?? []) lines.push(`        <data android:mimeType="${m}" />`);
    for (const p of f.exts ? pathPatterns(f.exts) : []) lines.push(`        <data android:pathPattern="${p}" />`);
    return [...lines, '      </intent-filter>'].join('\n');
  });
  return [`    <activity-alias android:name=".${e.alias}" android:targetActivity="${target}" android:enabled="${e.on ? 'true' : 'false'}" android:exported="true" android:label="@string/${e.res}" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round">`, ...filters, '    </activity-alias>'].join('\n');
}
/** The «Open with» part of the manifest: the target activity and every generated alias, between two marks. */
export function openWithXml(table = OPEN_WITH) {
  return ['    <!-- open-with:start (written from native/android/openwith.json) -->',
    `    <activity android:name="${table.target}" android:exported="true" android:theme="@android:style/Theme.Translucent.NoTitleBar" android:excludeFromRecents="true" android:noHistory="false" android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize" />`,
    ...table.entries.filter((e) => e.generated).map((e) => aliasXml(e, table.target)),
    '    <!-- open-with:end -->'].join('\n');
}
/** What the manifest's components claim, read back: for each, its name and its filters' actions, MIME types,
 *  schemes, hosts and path patterns. */
export function readFilters(xml) {
  const out = [];
  for (const m of xml.matchAll(/<(activity-alias|activity|service|receiver)(?=[\s>])([^>]*?)(?<!\/)>([\s\S]*?)<\/\1>/g)) {
    const name = /android:name="([^"]+)"/.exec(m[2])?.[1] ?? '?'; const enabled = !/android:enabled="false"/.test(m[2]);
    for (const f of m[3].matchAll(/<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g)) {
      const attr = (a) => [...f[1].matchAll(new RegExp(`android:${a}="([^"]*)"`, 'g'))].map((x) => x[1]);
      const actions = [...f[1].matchAll(/<action android:name="([^"]+)"/g)].map((x) => x[1]);
      out.push({ tag: m[1], component: name, enabled, actions, mimes: attr('mimeType'), schemes: attr('scheme'), hosts: attr('host'), patterns: attr('pathPattern') });
    }
  }
  return out;
}
/** The build's own check: no path pattern without a host in its filter (Android would ignore it and match every
 *  file of that type), and no two activities claiming the same action + type + pattern (each would show twice in
 *  the same list, and one could never be told apart). Services (quick-settings tiles) are not «Open with» entries. */
export function checkFilters(xml) {
  const faults = []; const seen = new Map();
  for (const f of readFilters(xml)) {
    if (f.tag !== 'activity' && f.tag !== 'activity-alias') continue;
    if (f.patterns.length && !f.hosts.length) faults.push(`${f.component}: pathPattern without android:host`);
    for (const a of f.actions.filter((x) => x !== 'android.intent.action.MAIN')) for (const m of f.mimes.length ? f.mimes : ['']) for (const p of f.patterns.length ? f.patterns : ['']) {
      const k = `${a}|${m}|${p}`; const who = seen.get(k);
      if (who && who !== f.component) faults.push(`${f.component} and ${who} both claim ${a} ${m || '(no type)'} ${p}`.trim()); else seen.set(k, f.component);
    }
  }
  return faults;
}

export function patchManifest(manifest, { a11y = false } = {}) {
if (!manifest.includes('xmlns:tools')) manifest = manifest.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
if (!manifest.includes('FOREGROUND_SERVICE_DATA_SYNC')) {
  manifest = manifest.replace('<application', `<uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
    <uses-permission android:name="android.permission.SET_WALLPAPER" />
    <uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
    <uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
    <application`);
  manifest = manifest.replace('</application>', `    <service android:name=".KtService" android:exported="false" android:foregroundServiceType="dataSync|specialUse"><property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="Downloads and torrents the user started, kept going while the app is in the background" /></service>
    <activity android:name=".KtAuthActivity" android:exported="false" android:configChanges="orientation|screenSize|keyboardHidden" />
    <activity android:name=".KtBrowserActivity" android:exported="false" android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize" android:windowSoftInputMode="adjustResize" />
    <!-- Kurokawa Tools in every app's file picker (Open / Save), and «Save to device» in every app's share sheet -->
    <provider android:name=".KtDocumentsProvider" android:authorities="app.kurokawa.tools.documents" android:exported="true" android:grantUriPermissions="true" android:permission="android.permission.MANAGE_DOCUMENTS">
      <intent-filter><action android:name="android.content.action.DOCUMENTS_PROVIDER" /></intent-filter>
    </provider>
    <activity-alias android:name=".KtSave" android:targetActivity=".MainActivity" android:exported="true" android:label="@string/kt_save" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round">
      <intent-filter android:label="@string/kt_save">
        <action android:name="android.intent.action.SEND" />
        <action android:name="android.intent.action.SEND_MULTIPLE" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="*/*" />
      </intent-filter>
    </activity-alias>
    </application>`);
}
if (!manifest.includes('android:scheme="magnet"')) {
  manifest = manifest.replace(/(<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>)/, `$1
      <!-- Magnet links, .torrent files, and links shared to the app -->
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="magnet" />
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:mimeType="application/x-bittorrent" />
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="content" />
        <data android:scheme="file" />
        <data android:host="*" />
        <data android:mimeType="application/octet-stream" />
${pathPatterns(['torrent']).map((p) => `        <data android:pathPattern="${p}" />`).join('\n')}
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.SEND" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="text/plain" />
        <data android:mimeType="application/x-bittorrent" />
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="kurokawatools" />
      </intent-filter>
      <!-- An anime's page on AniList or MyAnimeList: offered to open in the app (the show's page) -->
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" />
        <data android:host="anilist.co" android:pathPrefix="/anime/" />
        <data android:host="myanimelist.net" android:pathPrefix="/anime/" />
      </intent-filter>
`);
}
// --- the screen translator (the «Translate on screen» add-on): appearing over other apps, reading the screen's text
// (accessibility service) or a picture of it (screen capture), its foreground service and quick-settings tile ---
if (!manifest.includes('KtScreenService')) {
  manifest = manifest.replace('<application', `<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" tools:ignore="ScopedStorage" />
    <application`);
  manifest = manifest.replace('</application>', `    <service android:name=".KtScreenService" android:exported="false" android:foregroundServiceType="specialUse|mediaProjection"><property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="A floating translator bubble the user opened over other apps" /></service>
${a11y ? A11Y_SERVICE : ''}    <service android:name=".KtDownloadsTile" android:exported="true" android:label="@string/kt_downloads_tile" android:icon="@android:drawable/stat_sys_download" android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
      <intent-filter><action android:name="android.service.quicksettings.action.QS_TILE" /></intent-filter>
    </service>
    <receiver android:name=".KtService$Actions" android:exported="false" />
    <provider android:name="rikka.shizuku.ShizukuProvider" android:authorities="app.kurokawa.tools.shizuku" android:multiprocess="false" android:enabled="true" android:exported="true" android:permission="android.permission.INTERACT_ACROSS_USERS_FULL" />
    <service android:name=".KtFolderShare$Fg" android:exported="false" android:foregroundServiceType="specialUse"><property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="Folder shared on the local network" /></service>
    <service android:name=".KtFolderShare$TileSvc" android:exported="true" android:label="@string/kt_share_tile" android:icon="@android:drawable/stat_sys_upload" android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
      <intent-filter><action android:name="android.service.quicksettings.action.QS_TILE" /></intent-filter>
    </service>
    <service android:name=".KtScreenTile" android:exported="true" android:label="@string/kt_screen_tile" android:icon="@android:drawable/ic_menu_view" android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
      <intent-filter><action android:name="android.service.quicksettings.action.QS_TILE" /></intent-filter>
      <meta-data android:name="android.service.quicksettings.TOGGLEABLE_TILE" android:value="true" />
    </service>
    <activity-alias android:name=".KtInstaller" android:targetActivity=".MainActivity" android:exported="true" android:label="@string/kt_installer" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round">
      <intent-filter android:label="@string/kt_installer">
        <action android:name="android.intent.action.VIEW" />
        <action android:name="android.intent.action.INSTALL_PACKAGE" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:scheme="content" />
        <data android:scheme="file" />
        <data android:mimeType="application/vnd.android.package-archive" />
      </intent-filter>
      <intent-filter android:label="@string/kt_installer">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:scheme="content" />
        <data android:scheme="file" />
        <data android:mimeType="application/octet-stream" />
        <data android:mimeType="application/zip" />
        <data android:host="*" />
        <data android:pathPattern=".*\\\\.apks" />
        <data android:pathPattern=".*\\\\.xapk" />
        <data android:pathPattern=".*\\\\.apkm" />
      </intent-filter>
    </activity-alias>
    <!-- «Kurokawa Player»: videos and sound opened with the app from a file manager, a browser or another app
         (MX Player's extras honoured: position, title, subs, headers; the position handed back when it closes). -->
    <activity-alias android:name=".KtPlayer" android:targetActivity=".MainActivity" android:exported="true" android:label="@string/kt_player" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round">
      <intent-filter android:label="@string/kt_player">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="content" />
        <data android:scheme="file" />
        <data android:scheme="http" />
        <data android:scheme="https" />
        <data android:scheme="rtsp" />
        <data android:mimeType="video/*" />
        <data android:mimeType="audio/*" />
        <data android:mimeType="application/vnd.apple.mpegurl" />
        <data android:mimeType="application/x-mpegurl" />
        <data android:mimeType="application/mp4" />
      </intent-filter>
    </activity-alias>
    <activity android:name=".KtScreenLaunch" android:exported="true" android:enabled="false" android:label="@string/kt_screen_tile" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round" android:theme="@android:style/Theme.Translucent.NoTitleBar" android:excludeFromRecents="true" android:noHistory="true" android:taskAffinity="app.kurokawa.tools.screen" android:launchMode="singleInstance">
      <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
    </activity>
    <!-- «Kurokawa Tools» as a file picker for other apps (Open / Attach a file): GET_CONTENT and PICK, one file or
         several; the answer carried back by this invisible activity in the caller's task. -->
    <activity android:name=".KtPickActivity" android:exported="true" android:label="@string/kt_pick" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round" android:theme="@android:style/Theme.Translucent.NoTitleBar" android:excludeFromRecents="true" android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize">
      <intent-filter android:label="@string/kt_pick">
        <action android:name="android.intent.action.GET_CONTENT" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.OPENABLE" />
        <data android:mimeType="*/*" />
      </intent-filter>
      <intent-filter android:label="@string/kt_pick">
        <action android:name="android.intent.action.GET_CONTENT" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="*/*" />
      </intent-filter>
      <intent-filter android:label="@string/kt_pick">
        <action android:name="android.intent.action.PICK" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="*/*" />
      </intent-filter>
    </activity>
    <activity android:name=".KtScreenCapture$Consent" android:exported="false" android:theme="@android:style/Theme.Translucent.NoTitleBar" android:excludeFromRecents="true" android:taskAffinity="app.kurokawa.tools.capture" android:launchMode="singleInstance" />
    </application>`);
}
manifest = manifest.replace(/android:launchMode="[^"]*"/, 'android:launchMode="singleTask"');
if (!manifest.includes('android:launchMode')) manifest = manifest.replace('<activity', '<activity\n      android:launchMode="singleTask"');
// (The player's floating window: the main activity may shrink into picture in picture.)
if (!manifest.includes('android:supportsPictureInPicture')) manifest = manifest.replace('<activity', '<activity\n      android:supportsPictureInPicture="true"');
if (!manifest.includes('android:usesCleartextTraffic')) manifest = manifest.replace('<application', '<application android:usesCleartextTraffic="true"');
if (!manifest.includes('android:requestLegacyExternalStorage')) manifest = manifest.replace('<application', '<application android:requestLegacyExternalStorage="true"');
// (The other Kurokawa app is looked for by its package name: Android 11+ must be told.)
if (!manifest.includes('app.kurokawa.reader')) manifest = manifest.replace('</manifest>', `  <queries>\n    <package android:name="app.kurokawa.reader" />\n    <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="https" /></intent>\n  </queries>\n</manifest>`);
  // «Open with»: the aliases of openwith.json, and Android 11's package visibility for the app chooser of Files
  // («Always open .mkv with…»: the apps that open a type, asked with queryIntentActivities).
  if (!manifest.includes('open-with:start')) manifest = manifest.replace('</application>', `${openWithXml()}\n    </application>`);
  if (!manifest.includes('<data android:mimeType="*/*" /></intent>')) manifest = manifest.replace('  </queries>', '    <intent><action android:name="android.intent.action.VIEW" /><data android:mimeType="*/*" /></intent>\n  </queries>');
  const faults = checkFilters(manifest);
  if (faults.length) throw new Error(`AndroidManifest.xml: ${faults.join('; ')}`);
  return manifest;
}
