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
];
const EXTS = ['epub', 'pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'html', 'htm', 'fb2', 'odt', 'cbz', 'csv'];

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
  manifest = manifest.replace('<application', '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n    <application');
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

// ABI splits + signing config read from environment variables set by CI.
const gradlePath = path.join(app, 'build.gradle');
let gradle = await fs.readFile(gradlePath, 'utf8');
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
