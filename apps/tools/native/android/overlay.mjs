// Run after `npx cap add android`: the plugin and its engine copied in, libtorrent4j added, the manifest given its
// permissions, service, intent filters (magnets, .torrent files, links shared), the app's names per language,
// ABI splits and release signing (as the reader's overlay does).
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const app = path.join(root, 'android', 'app');
// (The accessibility service that reads the screen's text for the screen translator is declared only in the «-a11y»
// build (KT_A11Y=1, or `node native/android/a11y.mjs` on a prepared project): Google Play Protect blocks the install of
// an app from a file that declares one, so the ordinary build reads the screen as a picture instead.)
import { patchManifest } from './manifest.mjs';
const pkgDir = path.join(app, 'src/main/java/app/kurokawa/tools');
const LIBTORRENT4J = '2.1.0-39';

const NAMES = { ar: 'أدوات كروكاوا', ja: 'Kurokawa Tools', zh: 'Kurokawa Tools', ko: 'Kurokawa Tools' };

// --- manifest ---
const manifestPath = path.join(app, 'src/main/AndroidManifest.xml');
let manifest = await fs.readFile(manifestPath, 'utf8');
// (Permissions, services, intent filters and the «Open with» aliases: native/android/manifest.mjs.)
manifest = patchManifest(manifest, { a11y: process.env.KT_A11Y === '1' });
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
for (const f of ['KtDownloadsTile.java', 'KtShare.java', 'KtMpv.java', 'KtPlugin.java', 'KtEngine.java', 'KtService.java', 'KtStream.java', 'KrDownloader.java', 'KrDownloaderRs.java', 'KtDlRules.java', 'MainActivity.java', 'KtAuthActivity.java', 'KtArchive.java', 'KtVideo.java', 'KtApk.java', 'KrDoh.java', 'KrDohProxy.java', 'KtFiles.java', 'KtFileJobs.java', 'KtRemote.java', 'KtFolderShare.java', 'KtVault.java', 'KtVfs.java', 'KtCloud.java', 'KtHls.java', 'KtCookies.java', 'KtApps.java', 'KtDedupe.java', 'KtDub.java', 'KtDocumentsProvider.java', 'KtPacks.java', 'KtDohWeb.java', 'KtBrowserActivity.java', 'KtTombstone.java', 'KtApkPlan.java', 'KtJson.java', 'KtTranslate.java', 'KtLettering.java', 'KtLetterFace.java', 'KtInpaint.java', 'KtScreenService.java', 'KtScreenA11y.java', 'KtScreenCapture.java', 'KtScreenOcr.java', 'KtScreenTile.java', 'KtScreenLaunch.java', 'KtScreenMotion.java', 'KtScreenTrack.java', 'KtCore.java', /* (stage M4) */ 'KtScreenRs.java', 'KtHlsRs.java', /* (0.21 P8: KtStream's signed addresses) */ 'KtSign.java']) await fs.copyFile(path.join(root, 'native/android', f), path.join(pkgDir, f));
// (Stage M3, torrents: the streaming director's Java side, the Rust torrent library's door and the Rust torrent engine.)
for (const f of ['KtTorDirector.java', 'KtTorrentCore.java', 'KtTorrentRs.java', 'KtTorrentRsEngine.java']) await fs.copyFile(path.join(root, 'native/android', f), path.join(pkgDir, f));
// (Stage M5 of the Rust port: the file jobs' planner and executor, the network storages' rules.)
for (const f of ['KtFilePlan.java', 'KtFileExec.java', 'KtRemoteRules.java', /* (Tools 0.21 P5: the one name table, KtArchive's and the downloader's) */ 'KtNameSafe.java']) await fs.copyFile(path.join(root, 'native/android', f), path.join(pkgDir, f));
// (Other apps' «pick a file»: the invisible activity that carries the answer back; the picker is the Files page.)
for (const f of ['KtPickActivity.java', /* (others' «Open with» / «Share»: the same, for files handed in) */ 'KtOpenActivity.java']) await fs.copyFile(path.join(root, 'native/android', f), path.join(pkgDir, f));

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
    implementation "androidx.core:core:1.13.1"
    implementation "org.apache.commons:commons-compress:1.27.1"
    implementation "org.tukaani:xz:1.10"
    implementation "com.github.junrar:junrar:7.5.5"
    implementation "net.lingala.zip4j:zip4j:2.11.5"
    implementation "commons-net:commons-net:3.11.1"
    implementation "com.github.mwiede:jsch:0.2.21"
    implementation("com.hierynomus:smbj:0.13.0") { exclude group: "org.bouncycastle" }
    implementation("com.rapid7.client:dcerpc:0.12.1") { exclude group: "org.bouncycastle" }
    implementation "org.bouncycastle:bcprov-jdk18on:1.78.1"
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
    packagingOptions { jniLibs { pickFirsts += ['**/libc++_shared.so']; excludes += ['**/libpython.zip.so', '**/libffmpeg.zip.so']; useLegacyPackaging = true }
      resources { excludes += ['META-INF/versions/**', 'META-INF/LICENSE*', 'META-INF/NOTICE*', 'META-INF/DEPENDENCIES', 'META-INF/*.kotlin_module', 'META-INF/INDEX.LIST', 'META-INF/io.netty.versions.properties', 'org/bouncycastle/pqc/crypto/picnic/**']; pickFirsts += ['META-INF/MANIFEST.MF', 'module-info.class'] } }`);
}
// yt-dlp is not carried either (3 MB): youtubedl-android unpacks it from its raw resource «ytdlp» when it finds none,
// so a placeholder of the same name (an app's resource wins over a library's) stands in, and the real one comes with
// the Python pack — which yt-dlp needs to run anyway (KtVideo.init puts it in place, or fetches it).
await fs.mkdir(path.join(app, 'src/main/res/raw'), { recursive: true });
await fs.writeFile(path.join(app, 'src/main/res/raw/ytdlp'), '# placeholder: yt-dlp comes with the Python pack\n');
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
// R8 on (as the Reader's build has it): unused classes of the libraries dropped, the APK a good deal smaller; what is
// reached by name — the WebView bridge, the plugins, the native libraries' JNI classes, the libraries that look
// themselves up by reflection — is kept by the rules below. The Tools compile check builds the release, so a rule
// that strips too much shows there, not on release day.
if (!gradle.includes('minifyEnabled true')) gradle = gradle.replace(/minifyEnabled false/, 'minifyEnabled true\n            shrinkResources true');
if (!gradle.includes('proguard-kt.pro')) {
  await fs.writeFile(path.join(app, 'proguard-kt.pro'), [
    '-keep class app.kurokawa.tools.** { *; }', '-keep class com.getcapacitor.** { *; }', '-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }',
    '-keep class is.xyz.mpv.** { *; }', '-keep class org.libtorrent4j.** { *; }', '-keep class com.yausername.** { *; }', '-keep class com.hierynomus.** { *; }', '-keep class net.engio.mbassy.** { *; }', '-keep class com.rapid7.** { *; }', '-keep class com.jcraft.jsch.** { *; }', '-keep class rikka.shizuku.** { *; }', '-keep class moe.shizuku.** { *; }', '-keep class net.lingala.zip4j.** { *; }', '-keep class org.apache.commons.net.** { *; }',
    '-keep class androidx.security.crypto.** { *; }', '-keep class com.google.crypto.tink.** { *; }', '-keep class org.tukaani.xz.** { *; }',
    '-keepattributes Signature,InnerClasses,EnclosingMethod,*Annotation*',
    '-dontwarn org.apache.commons.compress.**', '-dontwarn org.tukaani.xz.**', '-dontwarn com.github.junrar.**', '-dontwarn org.brotli.**', '-dontwarn com.github.luben.zstd.**', '-dontwarn org.bouncycastle.**', '-dontwarn org.slf4j.**', '-dontwarn com.hierynomus.**', '-dontwarn net.engio.**', '-dontwarn com.rapid7.**', '-dontwarn rikka.**', '-dontwarn javax.naming.**', '-dontwarn java.beans.**', '-dontwarn org.ietf.jgss.**', '-dontwarn com.google.errorprone.**', '-dontwarn org.apache.commons.net.**', '-dontwarn com.google.crypto.tink.**', '-dontwarn com.sun.jna.**', '-dontwarn org.apache.logging.**', '-dontwarn org.newsclub.net.**', '-dontwarn java.awt.**', '-dontwarn javax.swing.**', '-dontwarn sun.misc.**',
  ].join('\n') + '\n');
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
