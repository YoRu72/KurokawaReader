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
    <service android:name=".KtScreenA11y" android:exported="false" android:label="@string/kt_screen_a11y_label" android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
      <intent-filter><action android:name="android.accessibilityservice.AccessibilityService" /></intent-filter>
      <meta-data android:name="android.accessibilityservice" android:resource="@xml/kt_screen_a11y" />
    </service>
    <service android:name=".KtDownloadsTile" android:exported="true" android:label="@string/kt_downloads_tile" android:icon="@android:drawable/stat_sys_download" android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
      <intent-filter><action android:name="android.service.quicksettings.action.QS_TILE" /></intent-filter>
    </service>
    <receiver android:name=".KtService$Actions" android:exported="false" />
    <provider android:name="rikka.shizuku.ShizukuProvider" android:authorities="${applicationId}.shizuku" android:multiprocess="false" android:enabled="true" android:exported="true" android:permission="android.permission.INTERACT_ACROSS_USERS_FULL" />
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
    <activity android:name=".KtScreenCapture$Consent" android:exported="false" android:theme="@android:style/Theme.Translucent.NoTitleBar" android:excludeFromRecents="true" android:taskAffinity="app.kurokawa.tools.capture" android:launchMode="singleInstance" />
    </application>`);
}
manifest = manifest.replace(/android:launchMode="[^"]*"/, 'android:launchMode="singleTask"');
if (!manifest.includes('android:launchMode')) manifest = manifest.replace('<activity', '<activity\n      android:launchMode="singleTask"');
if (!manifest.includes('android:usesCleartextTraffic')) manifest = manifest.replace('<application', '<application android:usesCleartextTraffic="true"');
if (!manifest.includes('android:requestLegacyExternalStorage')) manifest = manifest.replace('<application', '<application android:requestLegacyExternalStorage="true"');
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
for (const f of ['KtDownloadsTile.java', 'KtShare.java', 'KtMpv.java', 'KtPlugin.java', 'KtEngine.java', 'KtService.java', 'KtStream.java', 'KrDownloader.java', 'MainActivity.java', 'KtAuthActivity.java', 'KtArchive.java', 'KtVideo.java', 'KtApk.java', 'KrDoh.java', 'KrDohProxy.java', 'KtFiles.java', 'KtRemote.java', 'KtFolderShare.java', 'KtVault.java', 'KtVfs.java', 'KtDocumentsProvider.java', 'KtPacks.java', 'KtDohWeb.java', 'KtBrowserActivity.java', 'KtTombstone.java', 'KtApkPlan.java', 'KtJson.java', 'KtTranslate.java', 'KtScreenService.java', 'KtScreenA11y.java', 'KtScreenCapture.java', 'KtScreenOcr.java', 'KtScreenTile.java', 'KtScreenLaunch.java', 'KtScreenMotion.java']) await fs.copyFile(path.join(root, 'native/android', f), path.join(pkgDir, f));

// mpv's Java side (its native libraries come with the mpv pack): the class name its JNI code binds to.
{ const d = path.join(app, 'src/main/java/is/xyz/mpv'); await fs.mkdir(d, { recursive: true }); await fs.copyFile(path.join(root, 'native/android/mpv/MPVLib.java'), path.join(d, 'MPVLib.java')); }

// --- the launcher icon (its own, not the template's; drawn by native/icon/render.cjs): adaptive layers, the themed
// (monochrome) layer of Android 13, and the older launchers' icons ---
await fs.cp(path.join(root, 'native/android/res'), path.join(app, 'src/main/res'), { recursive: true, force: true });

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
    implementation "androidx.webkit:webkit:1.11.0"
    implementation "org.apache.commons:commons-compress:1.27.1"
    implementation "org.tukaani:xz:1.10"
    implementation "com.github.junrar:junrar:7.5.5"
    implementation "net.lingala.zip4j:zip4j:2.11.5"
    implementation "commons-net:commons-net:3.11.1"
    implementation "com.github.mwiede:jsch:0.2.21"
    implementation "com.hierynomus:smbj:0.13.0"
    implementation "com.rapid7.client:dcerpc:0.12.1"
    implementation "androidx.security:security-crypto:1.1.0-alpha06"
    implementation "dev.rikka.shizuku:api:13.1.5"
    implementation "dev.rikka.shizuku:provider:13.1.5"
    implementation "io.github.junkfood02.youtubedl-android:library:0.18.1"
    implementation "io.github.junkfood02.youtubedl-android:common:0.18.1"   // (its unzip, used for the packs; the library has it only at run time)
    implementation "io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1"`);
// One ffmpeg (yt-dlp's) for everything. Its libraries and Python's — 34 MB and 14 MB a device — are not in the
// APK: they are packs (KtPacks.java) downloaded when an add-on needs them, built from the same bundles by the
// release workflow. The small launchers stay (Android runs programs only from the APK's library folder).
if (!gradle.includes('libpython.zip.so')) gradle = gradle.replace(/android \{/, `android {
    packagingOptions { jniLibs { pickFirsts += ['**/libc++_shared.so']; excludes += ['**/libpython.zip.so', '**/libffmpeg.zip.so']; useLegacyPackaging = true } }`);
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
  await fs.writeFile(path.join(app, 'proguard-kt.pro'), '-keep class is.xyz.mpv.** { *; }\n-keep class org.libtorrent4j.swig.libtorrent_jni {*;}\n-keep class org.libtorrent4j.** { *; }\n-dontwarn org.apache.commons.compress.**\n-dontwarn org.tukaani.xz.**\n-dontwarn com.github.junrar.**\n-dontwarn org.brotli.**\n-dontwarn com.github.luben.zstd.**\n-dontwarn org.bouncycastle.**\n-dontwarn org.slf4j.**\n-dontwarn com.hierynomus.**\n-dontwarn net.engio.**\n-dontwarn com.rapid7.**\n-keep class com.hierynomus.** { *; }\n-keep class net.engio.mbassy.** { *; }\n-keep class com.jcraft.jsch.** { *; }\n-keep class rikka.shizuku.** { *; }\n-keep class moe.shizuku.** { *; }\n-dontwarn rikka.**\n-keep class com.yausername.** { *; }\n');
  gradle = gradle.replace(/proguardFiles getDefaultProguardFile\('proguard-android.txt'\), 'proguard-rules.pro'/, "proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro', 'proguard-kt.pro'");
}
// (The screen translator's OCR: Google's text recognition through Play services — its models are fetched by the
// phone, not carried in the APK: a few hundred KB instead of tens of MB.)
if (!gradle.includes('play-services-mlkit-text-recognition')) gradle = gradle.replace(/dependencies \{/, `dependencies {
    implementation "com.google.android.gms:play-services-mlkit-text-recognition:19.0.1"
    implementation "com.google.android.gms:play-services-mlkit-text-recognition-japanese:16.0.1"
    implementation "com.google.android.gms:play-services-mlkit-text-recognition-chinese:16.0.1"
    implementation "com.google.android.gms:play-services-mlkit-text-recognition-korean:16.0.1"
    implementation "com.google.android.gms:play-services-mlkit-text-recognition-devanagari:16.0.1"`);
await fs.writeFile(gradlePath, gradle);
// yt-dlp (Python inside the app) needs Android 7 (API 24) at least; Python and ffmpeg run as programs, so native
// libraries are extracted on install (useLegacyPackaging above).
const varsPath = path.join(app, '..', 'variables.gradle');
try { let v = await fs.readFile(varsPath, 'utf8'); v = v.replace(/minSdkVersion = \d+/, (m) => (parseInt(m.split('=')[1], 10) < 24 ? 'minSdkVersion = 24' : m)); await fs.writeFile(varsPath, v); } catch { /* no variables file */ }
console.log('Android overlay applied (Kurokawa Tools)');
