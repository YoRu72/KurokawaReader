package app.kurokawa.tools;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Another app asks for a file (ACTION_GET_CONTENT, ACTION_PICK) and picks «Kurokawa Tools»: this invisible activity
 * stays in that app's task to carry the answer back, while the app's own Files page opens as a picker (MainActivity,
 * kurokawatools://pick → #/pick). The page asks what was requested (KtPlugin.pickRequest) and answers with the files
 * chosen (pickDone) or none (pickCancel): content:// links through the app's FileProvider (its documents provider for
 * a file outside the phone's main storage), readable by the caller (FLAG_GRANT_READ_URI_PERMISSION; ClipData for
 * several), or RESULT_CANCELED. Then the app steps back and the caller comes to the front.
 * (ACTION_OPEN_DOCUMENT and ACTION_CREATE_DOCUMENT are Android's own picker's alone; the app is in it already as a
 * documents provider, «Save» included.)
 */
public class KtPickActivity extends Activity {
    static volatile KtPickActivity current;
    /** What the caller asked for, for the page: {action, multiple, mimes[], caller}. */
    static volatile String request;
    /** This request's own mark: an answer meant for an earlier one (its page left late) is not taken for this one. */
    final String id = Long.toString(System.nanoTime(), 36);

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        KtPickActivity before = current; if (before != null && before != this) { try { before.answer(null); } catch (Throwable ignored) {} }
        current = this;
        Intent in = getIntent(); JSONObject r = new JSONObject();
        try {
            r.put("id", id);
            r.put("action", in == null || in.getAction() == null ? "" : in.getAction());
            r.put("multiple", in != null && in.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
            JSONArray mimes = new JSONArray();
            String[] extra = in == null ? null : in.getStringArrayExtra(Intent.EXTRA_MIME_TYPES);
            if (extra != null) for (String m : extra) if (m != null && !m.isEmpty()) mimes.put(m);
            if (mimes.length() == 0 && in != null && in.getType() != null) mimes.put(in.getType());
            r.put("mimes", mimes);
            String caller = getCallingPackage(); String label = "";
            if (caller != null) { try { PackageManager pm = getPackageManager(); label = String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(caller, 0))); } catch (Throwable ignored) { label = caller; } }
            r.put("caller", label);
        } catch (Exception ignored) {}
        request = r.toString();
        try {
            Intent go = new Intent(this, MainActivity.class).setAction(Intent.ACTION_VIEW).setData(Uri.parse("kurokawatools://pick")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(go);
        } catch (Throwable e) { answer(null); }
    }

    /** The answer: the files chosen, or null (cancelled). */
    void answer(List<File> files) {
        List<Uri> us = new ArrayList<>();
        if (files != null) for (File f : files) { Uri u = uriFor(f); if (u != null) us.add(u); }
        if (us.isEmpty()) { setResult(RESULT_CANCELED); finish(); return; }
        Intent r = new Intent();
        String type = null; try { type = getContentResolver().getType(us.get(0)); } catch (Throwable ignored) {}
        if (type != null) r.setDataAndType(us.get(0), type); else r.setData(us.get(0));
        ClipData clip = ClipData.newRawUri("", us.get(0));
        for (int i = 1; i < us.size(); i++) clip.addItem(new ClipData.Item(us.get(i)));
        r.setClipData(clip);
        r.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        setResult(RESULT_OK, r); finish();
    }
    private Uri uriFor(File f) {
        if (f == null || !f.isFile()) return null;
        try { return androidx.core.content.FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", f); } catch (Throwable ignored) {}
        try { return android.provider.DocumentsContract.buildDocumentUri(KtDocumentsProvider.AUTHORITY, f.getAbsolutePath()); } catch (Throwable ignored) {}
        return null;
    }

    @Override protected void onDestroy() {
        if (current == this) { current = null; request = null; }
        super.onDestroy();
    }
}
