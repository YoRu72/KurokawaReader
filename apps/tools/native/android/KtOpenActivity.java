package app.kurokawa.tools;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Another app opens or shares files with one of Kurokawa's own entries in its «Open with» / «Share» list (the
 * activity-aliases written from openwith.json: KtArchive, KtArchiveShare, KtFolder, KtImage, KtText, KtAnyFile,
 * KtBrowse). This invisible activity stays in that app's task, holding the read (and, for «Edit», write) grant Android
 * gave with the files, while the app's page opens at kurokawatools://open?kind=…&id=… (#/open?kind=…), as the picker
 * does (KtPickActivity). The page asks what came (KtPlugin.openRequest), reads the files through it, and says when it
 * is done (KtPlugin.openDone): this activity ends, and — when the person did not go further into the app — the app
 * steps back so the calling app is in front again. A grant Android offers to keep (persistable) is kept.
 */
public class KtOpenActivity extends Activity {
    /** Each alias and the page's kind for it: openwith.json's twin (tests/openwith.cjs checks that they agree). */
    static final String[][] KINDS = { { "KtArchive", "archive" }, { "KtArchiveShare", "archiveShare" }, { "KtFolder", "folder" }, { "KtImage", "image" }, { "KtText", "text" }, { "KtAnyFile", "any" }, { "KtBrowse", "browse" } };
    static volatile KtOpenActivity current;
    /** What came, for the page: {id, kind, action, caller, writable, mime, uris[]}. */
    static volatile String request;
    /** This request's own mark: an answer meant for an earlier one is not taken for this one. */
    final String id = Long.toString(System.nanoTime(), 36);
    final List<Uri> uris = new ArrayList<>();

    /** The page's kind for an alias's class name (null for any other component). */
    static String kindOf(String cls) {
        if (cls == null) return null;
        for (String[] k : KINDS) if (cls.equals(k[0]) || cls.endsWith("." + k[0])) return k[1];
        return null;
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        KtOpenActivity before = current; if (before != null && before != this) { try { before.finish(); } catch (Throwable ignored) {} }
        current = this;
        Intent in = getIntent(); JSONObject r = new JSONObject();
        String kind = in == null || in.getComponent() == null ? null : kindOf(in.getComponent().getClassName());
        try {
            if (in != null) {
                if (in.getData() != null) uris.add(in.getData());
                if (Intent.ACTION_SEND_MULTIPLE.equals(in.getAction())) { ArrayList<Uri> l = in.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (l != null) for (Uri u : l) if (u != null && !uris.contains(u)) uris.add(u); }
                else if (Intent.ACTION_SEND.equals(in.getAction())) { Uri u = in.getParcelableExtra(Intent.EXTRA_STREAM); if (u != null && !uris.contains(u)) uris.add(u); }
                ClipData clip = in.getClipData();
                if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) { Uri u = clip.getItemAt(i).getUri(); if (u != null && !uris.contains(u)) uris.add(u); }
                // (A grant Android offers to keep beyond this visit is kept: a folder or a file opened again later.)
                int flags = in.getFlags();
                if ((flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0) for (Uri u : uris) {
                    if (!"content".equals(u.getScheme())) continue;
                    try { getContentResolver().takePersistableUriPermission(u, flags & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION)); } catch (Throwable ignored) {}
                }
                r.put("writable", (flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0 || Intent.ACTION_EDIT.equals(in.getAction()));
                r.put("action", in.getAction() == null ? "" : in.getAction());
                r.put("mime", in.getType() == null ? "" : in.getType());
            }
            r.put("id", id); r.put("kind", kind == null ? "any" : kind);
            JSONArray a = new JSONArray(); for (Uri u : uris) a.put(u.toString()); r.put("uris", a);
            String caller = getCallingPackage(); String label = "";
            if (caller == null && android.os.Build.VERSION.SDK_INT >= 22) { Uri ref = getReferrer(); if (ref != null && "android-app".equals(ref.getScheme())) caller = ref.getHost(); }
            if (caller != null && !caller.equals(getPackageName())) { try { PackageManager pm = getPackageManager(); label = String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(caller, 0))); } catch (Throwable ignored) { label = caller; } }
            r.put("caller", label);
        } catch (Exception ignored) {}
        request = r.toString();
        try {
            Uri go = Uri.parse("kurokawatools://open?kind=" + (kind == null ? "any" : kind) + "&id=" + id);
            startActivity(new Intent(this, MainActivity.class).setAction(Intent.ACTION_VIEW).setData(go).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Throwable e) { finish(); }
    }

    /** Shown again — the person went back to the calling app by another way (Recents, its icon) while the page still
     *  had the files —: this invisible layer steps aside at once, so it never stands over that app's screen. */
    private boolean resumedOnce = false;
    @Override protected void onResume() { super.onResume(); if (resumedOnce) finish(); resumedOnce = true; }

    @Override protected void onDestroy() {
        if (current == this) { current = null; request = null; }
        super.onDestroy();
    }
}
