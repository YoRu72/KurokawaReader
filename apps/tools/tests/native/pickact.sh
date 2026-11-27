#!/bin/sh
# KtPickActivity (another app's «pick a file»: the request read for the page, the answer carried back) type-checked
# against small stubs of the Android classes it uses (no Android SDK here: the stubs say only what the code calls, so a
# wrong name or type fails), then driven: the request's JSON (a PICK naming only a media collection carries its «data»),
# a second request cancelling the first, the activity brought back without an answer cancelling, a refused file not
# dropped. Needs javac and org.json (jsonjar.sh). Run by tests/openwith.cjs.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); J=$(sh "$HERE/jsonjar.sh")
mkdir -p "$D/src/android/app" "$D/src/android/content/pm" "$D/src/android/net" "$D/src/android/os" "$D/src/android/provider" "$D/src/androidx/core/content" "$D/src/app/kurokawa/tools"
w() { cat > "$D/src/$1"; }
w android/content/Context.java <<'J'
package android.content; public abstract class Context { public abstract ContentResolver getContentResolver(); public abstract String getPackageName(); public abstract android.content.pm.PackageManager getPackageManager(); public void startActivity(Intent i) { android.app.Activity.started++; } }
J
w android/content/ContentResolver.java <<'J'
package android.content; public class ContentResolver { public String getType(android.net.Uri u) { return "image/jpeg"; } }
J
w android/content/ComponentName.java <<'J'
package android.content; public final class ComponentName { public ComponentName(Context c, Class<?> k) {} }
J
w android/content/ClipData.java <<'J'
package android.content; public class ClipData { public final java.util.List<android.net.Uri> items = new java.util.ArrayList<>(); public static ClipData newRawUri(CharSequence l, android.net.Uri u) { ClipData c = new ClipData(); c.items.add(u); return c; } public void addItem(Item i) { items.add(i.u); } public static class Item { final android.net.Uri u; public Item(android.net.Uri u) { this.u = u; } } }
J
w android/content/Intent.java <<'J'
package android.content; public class Intent {
 public static final String ACTION_VIEW = "android.intent.action.VIEW", EXTRA_ALLOW_MULTIPLE = "android.intent.extra.ALLOW_MULTIPLE", EXTRA_MIME_TYPES = "android.intent.extra.MIME_TYPES";
 public static final int FLAG_GRANT_READ_URI_PERMISSION = 1, FLAG_ACTIVITY_NEW_TASK = 0x10000000;
 public String action, type, data; public boolean multiple; public String[] mimes; public int flags; public ClipData clip; public android.net.Uri uri;
 public Intent() {} public Intent(Context c, Class<?> k) {}
 public String getAction() { return action; } public String getType() { return type; } public String getDataString() { return data; } public boolean getBooleanExtra(String n, boolean d) { return EXTRA_ALLOW_MULTIPLE.equals(n) ? multiple : d; } public String[] getStringArrayExtra(String n) { return EXTRA_MIME_TYPES.equals(n) ? mimes : null; }
 public Intent setAction(String a) { action = a; return this; } public Intent setData(android.net.Uri u) { uri = u; return this; } public Intent setDataAndType(android.net.Uri u, String t) { uri = u; type = t; return this; } public Intent addFlags(int f) { flags |= f; return this; } public void setClipData(ClipData c) { clip = c; } }
J
w android/content/pm/ApplicationInfo.java <<'J'
package android.content.pm; public class ApplicationInfo {}
J
w android/content/pm/PackageManager.java <<'J'
package android.content.pm; public class PackageManager { public static final int COMPONENT_ENABLED_STATE_DISABLED = 2; public static class NameNotFoundException extends Exception {} public CharSequence getApplicationLabel(ApplicationInfo i) { return "Photo Frame"; } public ApplicationInfo getApplicationInfo(String p, int f) throws NameNotFoundException { return new ApplicationInfo(); } public int getComponentEnabledSetting(android.content.ComponentName c) { return COMPONENT_ENABLED_STATE_DISABLED; } }
J
w android/net/Uri.java <<'J'
package android.net; public class Uri { final String s; Uri(String s) { this.s = s; } public static Uri parse(String s) { return new Uri(s); } public String toString() { return s; } }
J
w android/os/Bundle.java <<'J'
package android.os; public final class Bundle {}
J
w android/provider/DocumentsContract.java <<'J'
package android.provider; public final class DocumentsContract { public static android.net.Uri buildDocumentUri(String a, String id) { return android.net.Uri.parse("content://" + a + "/document/" + id); } }
J
w androidx/core/content/FileProvider.java <<'J'
package androidx.core.content; public class FileProvider { public static android.net.Uri getUriForFile(android.content.Context c, String a, java.io.File f) { if (f.getPath().startsWith("/outside")) throw new IllegalArgumentException("not configured"); return android.net.Uri.parse("content://" + a + f.getPath()); } }
J
w android/app/Activity.java <<'J'
package android.app; public abstract class Activity extends android.content.Context {
 public static int started = 0; public static final int RESULT_OK = -1, RESULT_CANCELED = 0; public android.content.Intent in; public int result = 99; public android.content.Intent resultData; public boolean finished;
 protected void onCreate(android.os.Bundle b) {} protected void onStop() {} protected void onRestart() {} protected void onDestroy() {}
 public android.content.Intent getIntent() { return in; } public String getCallingPackage() { return "made.up.frame"; } public void setResult(int r) { result = r; } public void setResult(int r, android.content.Intent d) { result = r; resultData = d; } public void finish() { finished = true; } public boolean isFinishing() { return finished; }
 public android.content.ContentResolver getContentResolver() { return new android.content.ContentResolver(); } public String getPackageName() { return "app.kurokawa.tools"; } public android.content.pm.PackageManager getPackageManager() { return new android.content.pm.PackageManager(); } }
J
w app/kurokawa/tools/MainActivity.java <<'J'
package app.kurokawa.tools; public class MainActivity extends android.app.Activity {}
J
w app/kurokawa/tools/KtDocumentsProvider.java <<'J'
package app.kurokawa.tools; public class KtDocumentsProvider { static final String AUTHORITY = "app.kurokawa.tools.documents"; }
J
w app/kurokawa/tools/PaT.java <<'J'
package app.kurokawa.tools;
public class PaT {
 static int bad = 0; static void ok(String n, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + n); if (!c) bad++; }
 static KtPickActivity make(android.content.Intent i) { KtPickActivity a = new KtPickActivity(); a.in = i; a.onCreate(null); return a; }
 public static void main(String[] x) throws Exception {
  android.content.Intent p = new android.content.Intent(); p.action = "android.intent.action.PICK"; p.data = "content://media/external/images/media";
  KtPickActivity a = make(p); org.json.JSONObject r = new org.json.JSONObject(KtPickActivity.request);
  ok("a PICK naming a collection: its data carried for the page, no type, the asking app named", "content://media/external/images/media".equals(r.optString("data")) && r.getJSONArray("mimes").length() == 0 && "Photo Frame".equals(r.optString("caller")) && android.app.Activity.started == 1);
  android.content.Intent g = new android.content.Intent(); g.action = "android.intent.action.GET_CONTENT"; g.multiple = true; g.mimes = new String[] { "image/*", "video/*" };
  KtPickActivity b = make(g); r = new org.json.JSONObject(KtPickActivity.request);
  ok("a second request: the first answered «none» and finished, the second the one open", a.finished && a.result == android.app.Activity.RESULT_CANCELED && KtPickActivity.current == b && r.getBoolean("multiple") && r.getJSONArray("mimes").length() == 2);
  b.onStop(); b.onRestart();
  ok("brought back without an answer (the asking app gone back to): cancelled, not left over it", b.finished && b.result == android.app.Activity.RESULT_CANCELED);
  KtPickActivity c = make(g); c.onStop();
  java.io.File f = java.io.File.createTempFile("kt-pick", ".jpg"); f.deleteOnExit(); java.io.File out = new java.io.File("/outside/none.jpg");
  java.util.List<Integer> ref = c.answer(java.util.Arrays.asList(f, out));
  ok("a file no link can be given to: returned, nothing handed, still open", ref.size() == 1 && ref.get(0) == 1 && !c.finished);
  ref = c.answer(java.util.Arrays.asList(f));
  ok("handed: read-only grant, the link, finished with OK", ref.isEmpty() && c.finished && c.result == android.app.Activity.RESULT_OK && (c.resultData.flags & 1) == 1 && c.resultData.clip.items.size() == 1);
  c.onRestart(); ok("brought back after answering: the answer kept", c.result == android.app.Activity.RESULT_OK);
  System.out.println(bad == 0 ? "all passed" : "errors"); if (bad > 0) System.exit(1);
 } }
J
cp "$HERE/../../native/android/KtPickActivity.java" "$D/src/app/kurokawa/tools/"
cd "$D"; javac -nowarn -cp "$J" -d out $(find src -name '*.java')
java -cp "out:$J" app.kurokawa.tools.PaT
