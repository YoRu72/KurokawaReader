package app.kurokawa.tools;

import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.graphics.Point;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;

/**
 * Kurokawa Tools in every app's file picker (Open, Save, "Attach") — as Solid Explorer and ZArchiver appear there:
 * a documents provider over the app's own folder and, when the app may read everything (All files access), the
 * phone's storage and its cards. Browsing, opening, saving, new folders, renaming, deleting, moving, searching, and
 * pictures' thumbnails — the system's picker does the rest.
 */
public class KtDocumentsProvider extends DocumentsProvider {
    static final String AUTHORITY = "app.kurokawa.tools.documents";
    private static final String[] ROOT_COLS = { Root.COLUMN_ROOT_ID, Root.COLUMN_FLAGS, Root.COLUMN_ICON, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_AVAILABLE_BYTES, Root.COLUMN_MIME_TYPES };
    private static final String[] DOC_COLS = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_MIME_TYPE, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS, Document.COLUMN_SIZE };

    /** The roots: id → folder. */
    private List<File[]> roots() {
        List<File[]> out = new ArrayList<>();
        File app = KtEngine.defaultDirOf(getContext()); out.add(new File[] { app });
        boolean all = Build.VERSION.SDK_INT >= 30 ? Environment.isExternalStorageManager() : getContext().checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_GRANTED;
        if (all) {
            File ext = Environment.getExternalStorageDirectory(); if (ext != null) out.add(new File[] { ext });
            for (File f : getContext().getExternalFilesDirs(null)) { if (f == null) continue; String p = f.getAbsolutePath(); int i = p.indexOf("/Android/"); if (i <= 0) continue; File vol = new File(p.substring(0, i)); if (ext != null && vol.getAbsolutePath().equals(ext.getAbsolutePath())) continue; out.add(new File[] { vol }); }
        }
        return out;
    }
    @Override public boolean onCreate() { return true; }

    @Override public Cursor queryRoots(String[] projection) {
        MatrixCursor c = new MatrixCursor(projection != null ? projection : ROOT_COLS);
        List<File[]> rs = roots(); boolean ar = Locale.getDefault().getLanguage().equals("ar");
        for (int i = 0; i < rs.size(); i++) {
            File d = rs.get(i)[0]; String id = "r" + i;
            MatrixCursor.RowBuilder r = c.newRow();
            r.add(Root.COLUMN_ROOT_ID, id); r.add(Root.COLUMN_DOCUMENT_ID, docId(d)); r.add(Root.COLUMN_ICON, getContext().getApplicationInfo().icon);
            r.add(Root.COLUMN_TITLE, i == 0 ? (ar ? "أدوات كوروكاوا" : "Kurokawa Tools") : (ar ? "أدوات كوروكاوا · " : "Kurokawa Tools · ") + (i == 1 ? (ar ? "الهاتف" : "Phone") : d.getName()));
            r.add(Root.COLUMN_SUMMARY, i == 0 ? (ar ? "التنزيلات" : "Downloads") : d.getAbsolutePath());
            r.add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE | Root.FLAG_SUPPORTS_SEARCH | Root.FLAG_SUPPORTS_IS_CHILD | Root.FLAG_LOCAL_ONLY);
            r.add(Root.COLUMN_AVAILABLE_BYTES, d.getUsableSpace()); r.add(Root.COLUMN_MIME_TYPES, "*/*");
        }
        return c;
    }
    private static String docId(File f) { return f.getAbsolutePath(); }
    private File fileOf(String id) throws FileNotFoundException {
        File f = new File(id); String p;
        try { p = f.getCanonicalPath(); } catch (IOException e) { throw new FileNotFoundException(id); }
        boolean inside = false; for (File[] r : roots()) { try { String rp = r[0].getCanonicalPath(); if (p.equals(rp) || p.startsWith(rp + "/")) inside = true; } catch (IOException ignored) {} }
        if (!inside) throw new FileNotFoundException("outside: " + id);
        return f;
    }
    private void row(MatrixCursor c, File f) {
        MatrixCursor.RowBuilder r = c.newRow(); boolean d = f.isDirectory();
        int flags = 0;
        if (f.canWrite()) { flags |= Document.FLAG_SUPPORTS_DELETE | Document.FLAG_SUPPORTS_RENAME | Document.FLAG_SUPPORTS_MOVE; if (d) flags |= Document.FLAG_DIR_SUPPORTS_CREATE; else flags |= Document.FLAG_SUPPORTS_WRITE; }
        String mime = d ? Document.MIME_TYPE_DIR : KtFiles.mimeOf(f.getName());
        if (!d && (mime.startsWith("image/") || mime.startsWith("video/") || f.getName().toLowerCase(Locale.ROOT).endsWith(".apk"))) flags |= Document.FLAG_SUPPORTS_THUMBNAIL;
        r.add(Document.COLUMN_DOCUMENT_ID, docId(f)); r.add(Document.COLUMN_MIME_TYPE, mime); r.add(Document.COLUMN_DISPLAY_NAME, f.getName()); r.add(Document.COLUMN_LAST_MODIFIED, f.lastModified()); r.add(Document.COLUMN_FLAGS, flags); r.add(Document.COLUMN_SIZE, d ? null : f.length());
    }
    @Override public Cursor queryDocument(String id, String[] projection) throws FileNotFoundException { MatrixCursor c = new MatrixCursor(projection != null ? projection : DOC_COLS); row(c, fileOf(id)); return c; }
    @Override public Cursor queryChildDocuments(String parentId, String[] projection, String sortOrder) throws FileNotFoundException {
        MatrixCursor c = new MatrixCursor(projection != null ? projection : DOC_COLS); File d = fileOf(parentId); File[] k = d.listFiles();
        if (k != null) { java.util.Arrays.sort(k, (a, b) -> a.isDirectory() != b.isDirectory() ? (a.isDirectory() ? -1 : 1) : a.getName().compareToIgnoreCase(b.getName())); for (File f : k) if (!f.getName().startsWith(".")) row(c, f); }
        return c;
    }
    @Override public Cursor querySearchDocuments(String rootId, String query, String[] projection) throws FileNotFoundException {
        MatrixCursor c = new MatrixCursor(projection != null ? projection : DOC_COLS);
        int i; try { i = Integer.parseInt(rootId.substring(1)); } catch (Exception e) { return c; }
        List<File[]> rs = roots(); if (i >= rs.size()) return c;
        LinkedList<File> q = new LinkedList<>(); q.add(rs.get(i)[0]); String needle = query.toLowerCase(Locale.ROOT); int n = 0, seen = 0;
        while (!q.isEmpty() && n < 200 && seen < 50000) { File d = q.removeFirst(); File[] k = d.listFiles(); if (k == null) continue; for (File f : k) { seen++; if (f.getName().startsWith(".")) continue; if (f.getName().toLowerCase(Locale.ROOT).contains(needle)) { row(c, f); n++; } if (f.isDirectory() && !f.getName().equals("Android")) q.add(f); } }
        return c;
    }
    @Override public boolean isChildDocument(String parentId, String id) { return id.startsWith(parentId.endsWith("/") ? parentId : parentId + "/"); }
    @Override public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal) throws FileNotFoundException {
        return ParcelFileDescriptor.open(fileOf(id), ParcelFileDescriptor.parseMode(mode));
    }
    @Override public AssetFileDescriptor openDocumentThumbnail(String id, Point size, CancellationSignal signal) throws FileNotFoundException {
        File f = fileOf(id); String data = KtFiles.thumb(getContext(), f, Math.max(96, Math.min(512, Math.max(size.x, size.y))));
        if (data == null) throw new FileNotFoundException("no thumbnail");
        try {
            byte[] bytes = android.util.Base64.decode(data.substring(data.indexOf(',') + 1), android.util.Base64.DEFAULT);
            File tmp = File.createTempFile("kt-thumb", ".img", getContext().getCacheDir()); try (java.io.FileOutputStream o = new java.io.FileOutputStream(tmp)) { o.write(bytes); }
            ParcelFileDescriptor pfd = ParcelFileDescriptor.open(tmp, ParcelFileDescriptor.MODE_READ_ONLY); tmp.delete();
            return new AssetFileDescriptor(pfd, 0, bytes.length);
        } catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
    }
    @Override public String createDocument(String parentId, String mime, String name) throws FileNotFoundException {
        File d = fileOf(parentId); File f = new File(d, name.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]+", " ").trim()); if (f.exists()) f = KtFiles.keepBoth(f);
        try { if (Document.MIME_TYPE_DIR.equals(mime)) { if (!f.mkdirs()) throw new IOException("mkdir"); } else if (!f.createNewFile()) throw new IOException("create"); } catch (IOException e) { throw new FileNotFoundException("cannot create " + name); }
        notifyChange(d); return docId(f);
    }
    @Override public void deleteDocument(String id) throws FileNotFoundException { File f = fileOf(id); deleteTree(f); if (f.exists()) throw new FileNotFoundException("cannot delete"); notifyChange(f.getParentFile()); }
    private static void deleteTree(File f) { if (f.isDirectory()) { File[] k = f.listFiles(); if (k != null) for (File c : k) deleteTree(c); } f.delete(); }
    @Override public String renameDocument(String id, String name) throws FileNotFoundException {
        File f = fileOf(id); File to = new File(f.getParentFile(), name.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]+", " ").trim()); if (to.exists() || !f.renameTo(to)) throw new FileNotFoundException("cannot rename"); notifyChange(f.getParentFile()); return docId(to);
    }
    @Override public String moveDocument(String id, String sourceParentId, String targetParentId) throws FileNotFoundException {
        File f = fileOf(id); File dest = fileOf(targetParentId); File to = new File(dest, f.getName()); if (to.exists() || !f.renameTo(to)) throw new FileNotFoundException("cannot move"); notifyChange(dest); notifyChange(f.getParentFile()); return docId(to);
    }
    @Override public String getDocumentType(String id) throws FileNotFoundException { File f = fileOf(id); return f.isDirectory() ? Document.MIME_TYPE_DIR : KtFiles.mimeOf(f.getName()); }
    private void notifyChange(File dir) { if (dir == null) return; try { getContext().getContentResolver().notifyChange(android.provider.DocumentsContract.buildChildDocumentsUri(AUTHORITY, docId(dir)), null); } catch (Exception ignored) {} }
}
