// Run after `npx cap add android`: the plugin and its engine copied in, libtorrent4j added, the manifest given its
// permissions, service, intent filters (magnets, .torrent files, links shared), the app's names per language,
// ABI splits and release signing (as the reader's overlay does).
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const app = path.join(root, 'android', 'app');
const pkgDir = path.join(app, 'src/main/java/app/kurokawa/tools');
const LIBTORRENT4J = '2.1.0-39';

const NAMES = { ar: 'أدوات كروكاوا', ja: 'Kurokawa Tools', zh: 'Kurokawa Tools', ko: 'Kurokawa Tools' };

// --- manifest ---
const manifestPath = path.join(app, 'src/main/AndroidManifest.xml');
let manifest = await fs.readFile(manifestPath, 'utf8');
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
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
    <uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
    <application`);
  manifest = manifest.replace('</application>', `    <service android:name=".KtService" android:exported="false" android:foregroundServiceType="dataSync" />
    <activity android:name=".KtAuthActivity" android:exported="false" android:configChanges="orientation|screenSize|keyboardHidden" />
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
        <data android:mimeType="application/octet-stream" />
        <data android:pathPattern=".*\\\\.torrent" />
        <data android:pathPattern=".*\\\\..*\\\\.torrent" />
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
`);
}
manifest = manifest.replace(/android:launchMode="[^"]*"/, 'android:launchMode="singleTask"');
if (!manifest.includes('android:launchMode')) manifest = manifest.replace('<activity', '<activity\n      android:launchMode="singleTask"');
if (!manifest.includes('android:usesCleartextTraffic')) manifest = manifest.replace('<application', '<application android:usesCleartextTraffic="true"');
// (The other Kurokawa app is looked for by its package name: Android 11+ must be told.)
if (!manifest.includes('app.kurokawa.reader')) manifest = manifest.replace('</manifest>', `  <queries>\n    <package android:name="app.kurokawa.reader" />\n    <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="https" /></intent>\n  </queries>\n</manifest>`);
await fs.writeFile(manifestPath, manifest);

// --- names ---
const stringsPath = path.join(app, 'src/main/res/values/strings.xml');
let strings = await fs.readFile(stringsPath, 'utf8');
strings = strings.replace(/<string name="app_name">[^<]*<\/string>/, '<string name="app_name">Kurokawa Tools</string>').replace(/<string name="title_activity_main">[^<]*<\/string>/, '<string name="title_activity_main">Kurokawa Tools</string>');
await fs.writeFile(stringsPath, strings);
for (const [code, name] of Object.entries(NAMES)) {
  await fs.mkdir(path.join(app, `src/main/res/values-${code}`), { recursive: true });
  await fs.writeFile(path.join(app, `src/main/res/values-${code}/strings.xml`), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${name}</string>\n    <string name="title_activity_main">${name}</string>\n</resources>\n`);
}
// FileProvider paths: the cache (fetched APKs) and the external files dir (downloads).
const fpPath = path.join(app, 'src/main/res/xml/file_paths.xml');
try {
  let fp = await fs.readFile(fpPath, 'utf8');
  if (!fp.includes('kt_cache')) fp = fp.replace('</paths>', '    <cache-path name="kt_cache" path="." />\n    <external-files-path name="kt_files" path="." />\n    <files-path name="kt_int" path="." />\n    <external-path name="kt_ext" path="." />\n</paths>');
  await fs.writeFile(fpPath, fp);
} catch { /* the template ships it */ }

// --- code ---
await fs.mkdir(pkgDir, { recursive: true });
for (const f of ['KtPlugin.java', 'KtEngine.java', 'KtService.java', 'KtStream.java', 'KrDownloader.java', 'MainActivity.java', 'KtAuthActivity.java', 'KtArchive.java', 'KtVideo.java', 'KtApk.java']) await fs.copyFile(path.join(root, 'native/android', f), path.join(pkgDir, f));

// --- gradle: libtorrent4j, ABI splits, signing, version ---
const gradlePath = path.join(app, 'build.gradle');
let gradle = await fs.readFile(gradlePath, 'utf8');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map((n) => parseInt(n, 10) || 0);
gradle = gradle.replace(/versionCode \d+/, `versionCode ${maj * 10000 + min * 100 + pat}`).replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);
if (!gradle.includes('libtorrent4j')) {
  gradle = gradle.replace(/dependencies \{/, `dependencies {
    implementation "org.libtorrent4j:libtorrent4j:${LIBTORRENT4J}"
    implementation "org.libtorrent4j:libtorrent4j-android-arm64:${LIBTORRENT4J}"
    implementation "org.libtorrent4j:libtorrent4j-android-arm:${LIBTORRENT4J}"
    implementation "org.libtorrent4j:libtorrent4j-android-x86_64:${LIBTORRENT4J}"
    implementation "androidx.documentfile:documentfile:1.0.1"
    implementation "org.apache.commons:commons-compress:1.27.1"
    implementation "org.tukaani:xz:1.10"
    implementation "com.github.junrar:junrar:7.5.5"
    implementation "net.lingala.zip4j:zip4j:2.11.5"
    implementation "dev.ffmpegkit-maintained:ffmpeg-kit-full:8.1.9"
    implementation "io.github.junkfood02.youtubedl-android:library:0.18.1"
    implementation "io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1"`);
// Two libraries ship libc++_shared.so (libtorrent4j and ffmpeg-kit): one copy is kept.
if (!gradle.includes("pickFirst '**/libc++_shared.so'")) gradle = gradle.replace(/android \{/, `android {
    packagingOptions { jniLibs { pickFirsts += ['**/libc++_shared.so']; useLegacyPackaging = true } }`);
}
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
// (libtorrent's JNI class must keep its name through R8.)
if (!gradle.includes('proguard-kt.pro')) {
  await fs.writeFile(path.join(app, 'proguard-kt.pro'), '-keep class org.libtorrent4j.swig.libtorrent_jni {*;}\n-keep class org.libtorrent4j.** { *; }\n-dontwarn org.apache.commons.compress.**\n-dontwarn org.tukaani.xz.**\n-dontwarn com.github.junrar.**\n-dontwarn org.brotli.**\n-dontwarn com.github.luben.zstd.**\n-keep class com.yausername.** { *; }\n-keep class com.arthenica.ffmpegkit.** { *; }\n');
  gradle = gradle.replace(/proguardFiles getDefaultProguardFile\('proguard-android.txt'\), 'proguard-rules.pro'/, "proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro', 'proguard-kt.pro'");
}
await fs.writeFile(gradlePath, gradle);
// yt-dlp (Python inside the app) and ffmpeg-kit both need Android 7 (API 24) at least; their Python and ffmpeg run
// as files, so native libraries are extracted on install (useLegacyPackaging above).
const varsPath = path.join(app, '..', 'variables.gradle');
try { let v = await fs.readFile(varsPath, 'utf8'); v = v.replace(/minSdkVersion = \d+/, (m) => (parseInt(m.split('=')[1], 10) < 24 ? 'minSdkVersion = 24' : m)); await fs.writeFile(varsPath, v); } catch { /* no variables file */ }
console.log('Android overlay applied (Kurokawa Tools)');
