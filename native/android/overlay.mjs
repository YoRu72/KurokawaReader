// Run after `npx cap add android`: adds the document intent filters (so the
// app appears in "Open with" for EPUB/PDF/DOCX/…), the Arabic app name, the
// PROCESS_TEXT plugin, ABI splits and release signing.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const app = path.join(root, 'android', 'app');
const pkgDir = path.join(app, 'src/main/java/app/kurokawa/reader');

const MIMES = [
  'application/epub+zip', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/x-fictionbook+xml', 'application/vnd.comicbook+zip', 'application/x-cbz',
  'text/plain', 'text/markdown', 'text/html', 'text/csv', 'text/comma-separated-values',
  'application/x-mobipocket-ebook', 'application/vnd.amazon.ebook', 'application/vnd.amazon.mobi8-ebook', 'application/x-mobi8-ebook', 'application/apkg', 'application/vnd.anki',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4b', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/flac', 'audio/x-flac', 'audio/wav',
  'font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/x-font-ttf', 'application/x-font-opentype', 'application/font-sfnt', 'application/vnd.ms-opentype', 'application/font-woff', 'application/zip', 'application/x-zip-compressed',
];
const EXTS = ['mobi', 'azw', 'azw3', 'prc', 'apkg', 'colpkg', 'mp3', 'm4a', 'm4b', 'flac', 'ogg', 'opus', 'epub', 'pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'html', 'htm', 'fb2', 'odt', 'cbz', 'csv', 'ttf', 'otf', 'woff', 'woff2', 'zip'];

const data = (attrs) => `        <data ${attrs} />`;
const intentFilters = `
      <!-- Open documents from other apps (file managers, WhatsApp, browsers…) -->
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
${MIMES.map((m) => data(`android:mimeType="${m}"`)).join('\n')}
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="content" />
        <data android:scheme="file" />
        <data android:mimeType="*/*" />
${EXTS.flatMap((e) => [data(`android:pathPattern=".*\\\\.${e}"`), data(`android:pathPattern=".*\\\\..*\\\\.${e}"`), data(`android:pathPattern=".*\\\\..*\\\\..*\\\\.${e}"`)]).join('\n')}
      </intent-filter>
      <!-- "Share to…" from other apps -->
      <intent-filter>
        <action android:name="android.intent.action.SEND" />
        <action android:name="android.intent.action.SEND_MULTIPLE" />
        <category android:name="android.intent.category.DEFAULT" />
${MIMES.map((m) => data(`android:mimeType="${m}"`)).join('\n')}
      </intent-filter>
`;

const manifestPath = path.join(app, 'src/main/AndroidManifest.xml');
let manifest = await fs.readFile(manifestPath, 'utf8');
if (!manifest.includes('android:scheme="kurokawareader"')) {
  manifest = manifest.replace(/(<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>)/, `$1
      <!-- OAuth redirects for cloud sync -->
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="kurokawareader" />
      </intent-filter>
`);
}
if (!manifest.includes('android:mimeType="application/pdf"')) {
  // Insert after the MAIN/LAUNCHER intent filter of the main activity.
  manifest = manifest.replace(/(<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>)/, `$1\n${intentFilters}`);
}
if (!manifest.includes('REQUEST_INSTALL_PACKAGES')) {
  manifest = manifest.replace('<application', `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
    <!-- Whole-device scanning uses the ordinary read permission on Android 10 and older; from Android 11,
         "All files access", which the reader grants in system settings only if they choose to. -->
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
    <application`);
  if (!manifest.includes('xmlns:tools')) manifest = manifest.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
}
// The scanner's own camera (the web view asks for it; Capacitor turns that into the permission prompt).
if (!manifest.includes('android.permission.CAMERA')) {
  manifest = manifest.replace('<application', `<uses-permission android:name="android.permission.CAMERA" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <application`);
}
// Text-to-speech engines must be visible to the app (Android 11+), or TextToSpeech finds none.
// Conversions go on behind other apps: a foreground service ("data sync") with a progress notification.
if (!manifest.includes('KrJobService')) {
  manifest = manifest.replace('<application', `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
    <application`);
  manifest = manifest.replace('</application>', `    <service android:name=".KrJobService" android:exported="false" android:foregroundServiceType="dataSync" />
    </application>`);
}
if (!manifest.includes('android.intent.action.TTS_SERVICE')) {
  if (manifest.includes('<queries>')) manifest = manifest.replace('<queries>', `<queries>\n    <intent>\n      <action android:name="android.intent.action.TTS_SERVICE" />\n    </intent>`);
  else manifest = manifest.replace('</manifest>', `  <queries>\n    <intent>\n      <action android:name="android.intent.action.TTS_SERVICE" />\n    </intent>\n  </queries>\n</manifest>`);
}
if (!manifest.includes('android.intent.action.PROCESS_TEXT')) {
  const q = `    <intent>\n      <action android:name="android.intent.action.PROCESS_TEXT" />\n      <data android:mimeType="text/plain" />\n    </intent>`;
  manifest = manifest.includes('<queries>') ? manifest.replace('<queries>', `<queries>\n${q}`) : manifest.replace('</manifest>', `  <queries>\n${q}\n  </queries>\n</manifest>`);
}
manifest = manifest.replace(/android:launchMode="[^"]*"/, 'android:launchMode="singleTask"');
if (!manifest.includes('android:launchMode')) manifest = manifest.replace('<activity', '<activity\n      android:launchMode="singleTask"');
// Launcher name the reader can choose: the MAIN/LAUNCHER filter moves off MainActivity onto
// activity-aliases — one that follows the system language, and one per supported language —
// and the plugin enables exactly one of them (setAppName).
if (!manifest.includes('android:name=".LauncherAuto"')) {
  manifest = manifest.replace(/\s*<intent-filter>\s*<action android:name="android.intent.action.MAIN" \/>\s*<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>/, '');
  const alias = (name, label, enabled) => `
        <activity-alias android:name=".${name}" android:targetActivity=".MainActivity" android:label="${label}" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round" android:exported="true" android:enabled="${enabled}">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>`;
  const aliases = [
    alias('LauncherAuto', '@string/app_name', 'true'),
    alias('LauncherEn', 'KurokawaReader', 'false'),
    alias('LauncherAr', '@string/app_name_ar', 'false'),
    alias('LauncherJa', '@string/app_name_ja', 'false'),
    alias('LauncherZh', '@string/app_name_zh', 'false'),
    alias('LauncherKo', '@string/app_name_ko', 'false'),
  ].join('');
  manifest = manifest.replace('</application>', `${aliases}\n    </application>`);
}
// "All files access" (Android 11+), asked for only when the reader chooses to find books on the whole device
// or in Download — the folder Android's picker refuses to hand out.
if (!manifest.includes('MANAGE_EXTERNAL_STORAGE')) manifest = manifest.replace('<application', `<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" tools:ignore="ScopedStorage" />\n    <application`);
if (!manifest.includes('xmlns:tools')) manifest = manifest.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
await fs.writeFile(manifestPath, manifest);

// App name follows the system language: KurokawaReader by default, قارئ كروكاوا on Arabic devices.
const stringsPath = path.join(app, 'src/main/res/values/strings.xml');
let strings = await fs.readFile(stringsPath, 'utf8');
const NAMES = { ar: 'قارئ كروكاوا', ja: '黒川リーダー', zh: '黑川阅读器', ko: '쿠로카와 리더' };
strings = strings.replace(/<string name="app_name">[^<]*<\/string>/, '<string name="app_name">KurokawaReader</string>')
  .replace(/<string name="title_activity_main">[^<]*<\/string>/, '<string name="title_activity_main">KurokawaReader</string>');
// Fixed-language names for the chosen-name launcher aliases (same in every locale).
for (const [code, name] of Object.entries(NAMES)) if (!strings.includes(`app_name_${code}`)) strings = strings.replace('</resources>', `    <string name="app_name_${code}">${name}</string>\n</resources>`);
await fs.writeFile(stringsPath, strings);
// Localised default name (the "follow the system" alias) per language.
for (const [code, name] of Object.entries(NAMES)) {
  await fs.mkdir(path.join(app, `src/main/res/values-${code}`), { recursive: true });
  await fs.writeFile(path.join(app, `src/main/res/values-${code}/strings.xml`), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${name}</string>\n    <string name="title_activity_main">${name}</string>\n</resources>\n`);
}

// FileProvider paths: the update APK lives in the cache directory.
const fpPath = path.join(app, 'src/main/res/xml/file_paths.xml');
try {
  let fp = await fs.readFile(fpPath, 'utf8');
  if (!fp.includes('cache-path')) fp = fp.replace('</paths>', '    <cache-path name="kr_cache" path="." />\n</paths>');
  await fs.writeFile(fpPath, fp);
} catch { /* Capacitor template always ships it */ }

// Plugin + MainActivity
await fs.mkdir(pkgDir, { recursive: true });
await fs.copyFile(path.join(root, 'native/android/KurokawaPlugin.java'), path.join(pkgDir, 'KurokawaPlugin.java'));
await fs.copyFile(path.join(root, 'native/android/MainActivity.java'), path.join(pkgDir, 'MainActivity.java'));
await fs.copyFile(path.join(root, 'native/android/KrWebView.java'), path.join(pkgDir, 'KrWebView.java'));
await fs.copyFile(path.join(root, 'native/android/KrJobService.java'), path.join(pkgDir, 'KrJobService.java'));
await fs.copyFile(path.join(root, 'native/android/KrBrowser.java'), path.join(pkgDir, 'KrBrowser.java'));
// Swap Capacitor's WebView for ours (suppresses the system selection menu). BridgeActivity
// inflates the library's bridge_layout_main; an app resource of the same name overrides it.
await fs.writeFile(path.join(app, 'src/main/res/layout/bridge_layout_main.xml'), `<?xml version="1.0" encoding="utf-8"?>
<androidx.coordinatorlayout.widget.CoordinatorLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    tools:context="com.getcapacitor.BridgeActivity">

    <app.kurokawa.reader.KrWebView
        android:id="@+id/webview"
        android:layout_width="fill_parent"
        android:layout_height="fill_parent" />

</androidx.coordinatorlayout.widget.CoordinatorLayout>
`);

// ABI splits + signing config read from environment variables set by CI.
const gradlePath = path.join(app, 'build.gradle');
let gradle = await fs.readFile(gradlePath, 'utf8');
// versionCode / versionName follow package.json so each release installs over the last.
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map((n) => parseInt(n, 10) || 0);
gradle = gradle.replace(/versionCode \d+/, `versionCode ${maj * 10000 + min * 100 + pat}`).replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);
if (!gradle.includes('splits {')) {
  gradle = gradle.replace(/android \{/, `android {
    splits {
        abi {
            enable true
            reset()
            include 'arm64-v8a', 'armeabi-v7a', 'x86_64'
            universalApk true
        }
    }
    signingConfigs {
        release {
            if (System.getenv("KR_KEYSTORE") != null) {
                storeFile file(System.getenv("KR_KEYSTORE"))
                storePassword System.getenv("KR_KEYSTORE_PASSWORD")
                keyAlias System.getenv("KR_KEY_ALIAS")
                keyPassword System.getenv("KR_KEY_PASSWORD")
            }
        }
    }`);
  gradle = gradle.replace(/buildTypes \{\s*release \{/, `buildTypes {
        release {
            signingConfig signingConfigs.release`);
}
await fs.writeFile(gradlePath, gradle);
console.log('Android overlay applied');
