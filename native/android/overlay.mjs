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
  'font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/x-font-ttf', 'application/x-font-opentype', 'application/font-sfnt', 'application/vnd.ms-opentype', 'application/font-woff', 'application/zip', 'application/x-zip-compressed',
];
const EXTS = ['epub', 'pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'html', 'htm', 'fb2', 'odt', 'cbz', 'csv', 'ttf', 'otf', 'woff', 'woff2', 'zip'];

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
`;

const manifestPath = path.join(app, 'src/main/AndroidManifest.xml');
let manifest = await fs.readFile(manifestPath, 'utf8');
if (!manifest.includes('android.intent.action.VIEW')) {
  // Insert after the MAIN/LAUNCHER intent filter of the main activity.
  manifest = manifest.replace(/(<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>)/, `$1\n${intentFilters}`);
}
if (!manifest.includes('REQUEST_INSTALL_PACKAGES')) {
  manifest = manifest.replace('<application', `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
    <!-- Scanning the whole device for books: legacy read permission up to Android 12, "All files access" from Android 11. -->
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" tools:ignore="ScopedStorage" />
    <application`);
  if (!manifest.includes('xmlns:tools')) manifest = manifest.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
}
if (!manifest.includes('android.intent.action.PROCESS_TEXT')) {
  manifest = manifest.replace('</manifest>', `  <queries>\n    <intent>\n      <action android:name="android.intent.action.PROCESS_TEXT" />\n      <data android:mimeType="text/plain" />\n    </intent>\n  </queries>\n</manifest>`);
}
manifest = manifest.replace(/android:launchMode="[^"]*"/, 'android:launchMode="singleTask"');
if (!manifest.includes('android:launchMode')) manifest = manifest.replace('<activity', '<activity\n      android:launchMode="singleTask"');
await fs.writeFile(manifestPath, manifest);

// App name follows the system language: KurokawaReader by default, قارئ كروكاوا on Arabic devices.
const stringsPath = path.join(app, 'src/main/res/values/strings.xml');
let strings = await fs.readFile(stringsPath, 'utf8');
strings = strings.replace(/<string name="app_name">[^<]*<\/string>/, '<string name="app_name">KurokawaReader</string>')
  .replace(/<string name="title_activity_main">[^<]*<\/string>/, '<string name="title_activity_main">KurokawaReader</string>');
await fs.writeFile(stringsPath, strings);
await fs.mkdir(path.join(app, 'src/main/res/values-ar'), { recursive: true });
await fs.writeFile(path.join(app, 'src/main/res/values-ar/strings.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">قارئ كروكاوا</string>
    <string name="title_activity_main">قارئ كروكاوا</string>
</resources>
`);

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
