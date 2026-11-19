#!/bin/sh
# KtOpenActivity (others' «Open with» / «Share»: the files handed in, the page told) type-checked against small stubs
# of the Android classes it uses (no Android SDK here: the stubs say only what the code calls, so a wrong name or
# type fails), then its alias table (KINDS) run for a few class names. Needs javac and org.json (the jar apk.sh fetches).
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); LIB=${KT_JARS:-$HOME/.cache/kt-test-jars}; J=$(sh "$HERE/jsonjar.sh")
mkdir -p "$D/src/android/app" "$D/src/android/content/pm" "$D/src/android/net" "$D/src/android/os" "$D/src/app/kurokawa/tools"
cat > "$D/src/android/content/Context.java" <<'J'
package android.content; public abstract class Context { public abstract ContentResolver getContentResolver(); public abstract String getPackageName(); public abstract android.content.pm.PackageManager getPackageManager(); public void startActivity(Intent i) {} }
J
cat > "$D/src/android/content/ContentResolver.java" <<'J'
package android.content; public class ContentResolver { public void takePersistableUriPermission(android.net.Uri u, int f) {} }
J
cat > "$D/src/android/content/ComponentName.java" <<'J'
package android.content; public final class ComponentName { private final String c; public ComponentName(String p, String c) { this.c = c; } public String getClassName() { return c; } }
J
cat > "$D/src/android/content/ClipData.java" <<'J'
package android.content; public class ClipData { public int getItemCount() { return 0; } public Item getItemAt(int i) { return null; } public static class Item { public android.net.Uri getUri() { return null; } } }
J
cat > "$D/src/android/content/Intent.java" <<'J'
package android.content; public class Intent {
 public static final String ACTION_VIEW = "android.intent.action.VIEW", ACTION_SEND = "android.intent.action.SEND", ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE", ACTION_EDIT = "android.intent.action.EDIT", EXTRA_STREAM = "android.intent.extra.STREAM";
 public static final int FLAG_GRANT_READ_URI_PERMISSION = 1, FLAG_GRANT_WRITE_URI_PERMISSION = 2, FLAG_GRANT_PERSISTABLE_URI_PERMISSION = 64, FLAG_ACTIVITY_NEW_TASK = 0x10000000;
 public Intent() {} public Intent(Context c, Class<?> k) {} public String getAction() { return null; } public String getType() { return null; } public int getFlags() { return 0; } public ComponentName getComponent() { return null; } public android.net.Uri getData() { return null; } public ClipData getClipData() { return null; }
 public <T extends android.os.Parcelable> T getParcelableExtra(String n) { return null; } public <T extends android.os.Parcelable> java.util.ArrayList<T> getParcelableArrayListExtra(String n) { return null; }
 public Intent setAction(String a) { return this; } public Intent setData(android.net.Uri u) { return this; } public Intent addFlags(int f) { return this; } }
J
cat > "$D/src/android/content/pm/ApplicationInfo.java" <<'J'
package android.content.pm; public class ApplicationInfo {}
J
cat > "$D/src/android/content/pm/PackageManager.java" <<'J'
package android.content.pm; public abstract class PackageManager { public static class NameNotFoundException extends Exception {} public abstract CharSequence getApplicationLabel(ApplicationInfo i); public abstract ApplicationInfo getApplicationInfo(String p, int f) throws NameNotFoundException; }
J
cat > "$D/src/android/net/Uri.java" <<'J'
package android.net; public abstract class Uri implements android.os.Parcelable { public static Uri parse(String s) { return null; } public abstract String getScheme(); public abstract String getHost(); }
J
cat > "$D/src/android/os/Parcelable.java" <<'J'
package android.os; public interface Parcelable {}
J
cat > "$D/src/android/os/Bundle.java" <<'J'
package android.os; public final class Bundle {}
J
cat > "$D/src/android/os/Build.java" <<'J'
package android.os; public class Build { public static class VERSION { public static final int SDK_INT = 34; } }
J
cat > "$D/src/android/app/Activity.java" <<'J'
package android.app; public abstract class Activity extends android.content.Context { protected void onCreate(android.os.Bundle b) {} protected void onResume() {} protected void onDestroy() {} public android.content.Intent getIntent() { return null; } public String getCallingPackage() { return null; } public android.net.Uri getReferrer() { return null; } public void finish() {} public final void runOnUiThread(Runnable r) {} public boolean moveTaskToBack(boolean b) { return true; } public android.content.ContentResolver getContentResolver() { return null; } public String getPackageName() { return "app.kurokawa.tools"; } public android.content.pm.PackageManager getPackageManager() { return null; } }
J
cat > "$D/src/app/kurokawa/tools/MainActivity.java" <<'J'
package app.kurokawa.tools; public class MainActivity extends android.app.Activity {}
J
cat > "$D/src/app/kurokawa/tools/OwT.java" <<'J'
package app.kurokawa.tools; public class OwT { public static void main(String[] a) {
 String[][] want = { { "app.kurokawa.tools.KtArchive", "archive" }, { "KtArchiveShare", "archiveShare" }, { "app.kurokawa.tools.KtAnyFile", "any" }, { "app.kurokawa.tools.MainActivity", null }, { "app.kurokawa.tools.KtArchiveX", null }, { null, null } };
 int bad = 0; for (String[] w : want) { String got = KtOpenActivity.kindOf(w[0]); if (got == null ? w[1] != null : !got.equals(w[1])) { System.out.println("FAIL kindOf(" + w[0] + ") = " + got); bad++; } }
 StringBuilder sb = new StringBuilder(); for (String[] k : KtOpenActivity.KINDS) sb.append(k[0]).append('=').append(k[1]).append(';');
 System.out.println("KINDS " + sb); System.out.println(bad == 0 ? "all passed" : "errors"); if (bad > 0) System.exit(1); } }
J
cp "$HERE/../../native/android/KtOpenActivity.java" "$D/src/app/kurokawa/tools/"
cd "$D"; javac -nowarn -cp "$J" -d out $(find src -name '*.java')
java -cp "out:$J" app.kurokawa.tools.OwT
