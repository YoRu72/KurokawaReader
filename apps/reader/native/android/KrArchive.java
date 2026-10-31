package app.kurokawa.reader;

import android.util.Log;

import org.apache.commons.compress.archivers.ArchiveEntry;
import org.apache.commons.compress.archivers.ArchiveInputStream;
import org.apache.commons.compress.archivers.sevenz.SevenZArchiveEntry;
import org.apache.commons.compress.archivers.sevenz.SevenZFile;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream;
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.Inflater;
import java.util.zip.InflaterInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Archives: what is inside, taking it out, making one. ZIP is read by the app's own parser so it can also be
 * extracted <b>in place</b> the HatchZip way — entries taken from the archive's end backwards, the archive
 * truncated after each committed batch, so the disk needs room for the output only, with a journal beside the
 * archive that lets a killed extraction continue. 7z, tar (.gz/.xz/.bz2) and rar go through their libraries;
 * encrypted zips through zip4j.
 */
public final class KrArchive {
    private static final String TAG = "KrArchive";
    public interface Progress { void on(long done, long total, String file); boolean stopped(); }

    /* ---------- what kind ---------- */
    public static String formatOf(File f) throws IOException {
        byte[] b = new byte[8];
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) { r.readFully(b, 0, (int) Math.min(8, r.length())); }
        String n = f.getName().toLowerCase();
        if (b[0] == 'P' && b[1] == 'K') return "zip";
        if (b[0] == '7' && b[1] == 'z' && (b[2] & 0xff) == 0xBC && (b[3] & 0xff) == 0xAF) return "7z";
        if (b[0] == 'R' && b[1] == 'a' && b[2] == 'r' && b[3] == '!') return "rar";
        if ((b[0] & 0xff) == 0x1f && (b[1] & 0xff) == 0x8b) return n.endsWith(".tar.gz") || n.endsWith(".tgz") ? "tar.gz" : "gz";
        if ((b[0] & 0xff) == 0xFD && b[1] == '7' && b[2] == 'z' && b[3] == 'X' && b[4] == 'Z') return n.endsWith(".tar.xz") || n.endsWith(".txz") ? "tar.xz" : "xz";
        if (b[0] == 'B' && b[1] == 'Z' && b[2] == 'h') return n.endsWith(".tar.bz2") || n.endsWith(".tbz2") ? "tar.bz2" : "bz2";
        if (n.endsWith(".tar")) return "tar";
        throw new IOException("notArchive");
    }

    /* ---------- the ZIP parser (central directory) ---------- */
    public static final class ZipItem { public String name; public int method; public long csize, usize, crc, offset; public boolean dir, encrypted; }
    public static final class ZipIndex { public final List<ZipItem> items = new ArrayList<>(); public long cdStart, length; }

    static long u32(ByteBuffer b, int at) { return b.getInt(at) & 0xffffffffL; }
    static int u16(ByteBuffer b, int at) { return b.getShort(at) & 0xffff; }

    public static ZipIndex readZip(RandomAccessFile r) throws IOException {
        long len = r.length(); int tail = (int) Math.min(len, 65557L + 22); byte[] buf = new byte[tail];
        r.seek(len - tail); r.readFully(buf);
        ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
        int eocd = -1; for (int i = tail - 22; i >= 0; i--) if (bb.getInt(i) == 0x06054b50) { eocd = i; break; }
        if (eocd < 0) throw new IOException("notZip");
        long count = u16(bb, eocd + 10), cdSize = u32(bb, eocd + 12), cdOff = u32(bb, eocd + 16);
        // ZIP64: the locator sits 20 bytes before the EOCD.
        if ((count == 0xffff || cdOff == 0xffffffffL || cdSize == 0xffffffffL) && eocd >= 20 && bb.getInt(eocd - 20) == 0x07064b50) {
            long z64 = bb.getLong(eocd - 12); byte[] z = new byte[56]; r.seek(z64); r.readFully(z);
            ByteBuffer zb = ByteBuffer.wrap(z).order(ByteOrder.LITTLE_ENDIAN); if (zb.getInt(0) != 0x06064b50) throw new IOException("badZip64");
            count = zb.getLong(32); cdSize = zb.getLong(40); cdOff = zb.getLong(48);
        }
        ZipIndex ix = new ZipIndex(); ix.cdStart = cdOff; ix.length = len;
        byte[] cd = new byte[(int) cdSize]; r.seek(cdOff); r.readFully(cd);
        ByteBuffer c = ByteBuffer.wrap(cd).order(ByteOrder.LITTLE_ENDIAN); int p = 0;
        for (long i = 0; i < count && p + 46 <= cd.length; i++) {
            if (c.getInt(p) != 0x02014b50) throw new IOException("badCentralDirectory");
            ZipItem it = new ZipItem();
            int flags = u16(c, p + 8); it.method = u16(c, p + 10); it.crc = u32(c, p + 16); it.csize = u32(c, p + 20); it.usize = u32(c, p + 24);
            int nl = u16(c, p + 28), xl = u16(c, p + 30), cl = u16(c, p + 32); it.offset = u32(c, p + 42);
            boolean utf8 = (flags & 0x800) != 0; it.name = new String(cd, p + 46, nl, utf8 ? StandardCharsets.UTF_8 : StandardCharsets.ISO_8859_1);
            it.encrypted = (flags & 1) != 0;
            // ZIP64 extra field: the 0xffffffff values in order usize, csize, offset.
            int xp = p + 46 + nl, xe = xp + xl;
            while (xp + 4 <= xe) { int id = u16(c, xp), sz = u16(c, xp + 2); if (id == 1) { int q = xp + 4; if (it.usize == 0xffffffffL) { it.usize = c.getLong(q); q += 8; } if (it.csize == 0xffffffffL) { it.csize = c.getLong(q); q += 8; } if (it.offset == 0xffffffffL) { it.offset = c.getLong(q); } } xp += 4 + sz; }
            it.dir = it.name.endsWith("/") || (it.usize == 0 && it.name.endsWith("\\"));
            it.name = it.name.replace('\\', '/');
            if (!it.name.isEmpty()) ix.items.add(it);
            p += 46 + nl + xl + cl;
        }
        return ix;
    }
    /** Where an entry's data begins (past its local header, whose name/extra lengths may differ from the directory's). */
    static long dataStart(RandomAccessFile r, ZipItem it) throws IOException {
        byte[] h = new byte[30]; r.seek(it.offset); r.readFully(h);
        ByteBuffer b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN); if (b.getInt(0) != 0x04034b50) throw new IOException("badLocalHeader " + it.name);
        return it.offset + 30 + u16(b, 26) + u16(b, 28);
    }
    static boolean unsafe(String name) { return name.startsWith("/") || name.contains("../") || name.equals("..") || name.contains(":") && name.indexOf(':') < 3 && name.length() > 1 && Character.isLetter(name.charAt(0)) && name.charAt(1) == ':'; }

    /* ---------- listing ---------- */
    public static JSONObject list(File f, String password) throws Exception {
        JSONArray arr = new JSONArray(); long total = 0; boolean enc = false; String fmt;
        if (hasJournal(f)) {
            // Half extracted in place: the directory lives in the tail file; what is left starts below the journal's mark.
            fmt = "zip"; long committed = new JSONObject(new String(readFile(new File(f.getPath() + ".kurokawa-unzip")), StandardCharsets.UTF_8)).getLong("committed");
            try (RandomAccessFile t = new RandomAccessFile(new File(f.getPath() + ".kurokawa-tail"), "r")) { for (ZipItem it : readZip(t).items) if (it.offset < committed) { arr.put(item(it.name, it.usize, it.csize, it.dir)); total += it.usize; } }
        } else if ((fmt = formatOf(f)).equals("zip")) {
            try (RandomAccessFile r = new RandomAccessFile(f, "r")) { for (ZipItem it : readZip(r).items) { arr.put(item(it.name, it.usize, it.csize, it.dir)); total += it.usize; enc |= it.encrypted; } }
        } else if (fmt.equals("7z")) {
            try (SevenZFile z = password != null && !password.isEmpty() ? new SevenZFile(f, password.toCharArray()) : new SevenZFile(f)) { SevenZArchiveEntry e; while ((e = z.getNextEntry()) != null) { arr.put(item(e.getName(), e.getSize(), 0, e.isDirectory())); total += e.getSize(); } }
        } else if (fmt.equals("rar")) {
            try (com.github.junrar.Archive a = password != null && !password.isEmpty() ? new com.github.junrar.Archive(f, password) : new com.github.junrar.Archive(f)) { for (com.github.junrar.rarfile.FileHeader h : a.getFileHeaders()) { arr.put(item(h.getFileName().replace('\\', '/'), h.getFullUnpackSize(), h.getFullPackSize(), h.isDirectory())); total += h.getFullUnpackSize(); enc |= h.isEncrypted(); } }
        } else if (fmt.startsWith("tar")) {
            try (TarArchiveInputStream t = new TarArchiveInputStream(decompressor(fmt, new BufferedInputStream(new FileInputStream(f), 1 << 16)))) { ArchiveEntry e; while ((e = t.getNextEntry()) != null) { arr.put(item(e.getName(), e.getSize(), 0, e.isDirectory())); total += e.getSize(); } }
        } else { String inner = f.getName().replaceAll("\\.(gz|xz|bz2)$", ""); arr.put(item(inner, -1, f.length(), false)); }
        JSONObject o = new JSONObject(); o.put("format", fmt); o.put("entries", arr); o.put("total", total); o.put("encrypted", enc); o.put("inPlaceOk", fmt.equals("zip") && !enc); return o;
    }
    static JSONObject item(String name, long size, long csize, boolean dir) throws Exception { JSONObject o = new JSONObject(); o.put("path", name); o.put("size", size); if (csize > 0) o.put("compressed", csize); o.put("dir", dir); return o; }
    static InputStream decompressor(String fmt, InputStream in) throws IOException {
        if (fmt.endsWith(".gz") || fmt.equals("gz")) return new GzipCompressorInputStream(in, true);
        if (fmt.endsWith(".xz") || fmt.equals("xz")) return new XZCompressorInputStream(in, true);
        if (fmt.endsWith(".bz2") || fmt.equals("bz2")) return new BZip2CompressorInputStream(in, true);
        return in;
    }

    /* ---------- extracting ---------- */
    public static final class Options { public boolean inPlace, deleteAfter; public String replace = "replace"; public String password; }

    /** Extracts into `dest`; returns the number of files written. */
    public static int extract(File f, File dest, Options o, Progress pr) throws Exception {
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("cannotCreate " + dest);
        if (hasJournal(f)) return extractZipInPlace(f, dest, o, pr);
        String fmt = formatOf(f);
        int n;
        if (fmt.equals("zip")) {
            boolean enc; try (RandomAccessFile r = new RandomAccessFile(f, "r")) { enc = false; for (ZipItem it : readZip(r).items) enc |= it.encrypted; }
            if (enc) n = extractZip4j(f, dest, o, pr); else n = o.inPlace ? extractZipInPlace(f, dest, o, pr) : extractZip(f, dest, o, pr);
        } else if (fmt.equals("7z")) n = extract7z(f, dest, o, pr);
        else if (fmt.equals("rar")) n = extractRar(f, dest, o, pr);
        else if (fmt.startsWith("tar")) n = extractTar(f, dest, fmt, o, pr);
        else { File out = target(dest, f.getName().replaceAll("\\.(gz|xz|bz2)$", ""), o); if (out != null) { try (InputStream in = decompressor(fmt, new BufferedInputStream(new FileInputStream(f), 1 << 16))) { writeAll(in, out, -1, pr, f.length()); } n = 1; } else n = 0; }
        if (o.deleteAfter && !o.inPlace && !pr.stopped()) { if (!f.delete()) Log.w(TAG, "could not delete " + f); }
        return n;
    }
    /** The file to write for an entry: null when it is to be skipped (exists and replace=skip); `name (2).ext` for keep-both. */
    static File target(File dest, String name, Options o) throws IOException {
        if (unsafe(name)) throw new IOException("unsafePath " + name);
        File out = new File(dest, name); File parent = out.getParentFile(); if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannotCreate " + parent);
        if (!out.getCanonicalPath().startsWith(dest.getCanonicalPath() + File.separator)) throw new IOException("unsafePath " + name);
        if (out.exists()) { if ("skip".equals(o.replace)) return null; if ("both".equals(o.replace)) { String base = out.getName(), ext = ""; int dot = base.lastIndexOf('.'); if (dot > 0) { ext = base.substring(dot); base = base.substring(0, dot); } for (int i = 2; ; i++) { File alt = new File(out.getParentFile(), base + " (" + i + ")" + ext); if (!alt.exists()) return alt; } } }
        return out;
    }
    static long writeAll(InputStream in, File out, long crcWant, Progress pr, long tick) throws IOException {
        File part = new File(out.getPath() + ".part"); CRC32 crc = new CRC32(); long n = 0; byte[] buf = new byte[1 << 16];
        try (OutputStream os = new BufferedOutputStream(new FileOutputStream(part), 1 << 16)) { int r; while ((r = in.read(buf)) > 0) { if (pr.stopped()) throw new IOException("stopped"); os.write(buf, 0, r); crc.update(buf, 0, r); n += r; } }
        if (crcWant >= 0 && crc.getValue() != crcWant) { part.delete(); throw new IOException("crcMismatch " + out.getName()); }
        if (out.exists() && !out.delete()) throw new IOException("cannotReplace " + out);
        if (!part.renameTo(out)) throw new IOException("cannotRename " + out);
        return n;
    }
    static int extractZip(File f, File dest, Options o, Progress pr) throws Exception {
        int n = 0; long done = 0;
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            ZipIndex ix = readZip(r); long total = 0; for (ZipItem it : ix.items) total += it.usize;
            for (ZipItem it : ix.items) {
                if (pr.stopped()) throw new IOException("stopped");
                if (it.dir) { File d = new File(dest, it.name); if (unsafe(it.name)) throw new IOException("unsafePath"); d.mkdirs(); continue; }
                File out = target(dest, it.name, o); if (out == null) { done += it.usize; continue; }
                pr.on(done, total, it.name);
                try (InputStream in = entryStream(r, it)) { writeAll(in, out, it.crc, pr, total); }
                done += it.usize; n++;
            }
            pr.on(total, total, "");
        }
        return n;
    }
    /** The decoded bytes of one entry (stored or deflated), read through a window over the file. */
    static InputStream entryStream(RandomAccessFile r, ZipItem it) throws IOException {
        long start = dataStart(r, it); InputStream raw = new RangeStream(r, start, it.csize);
        if (it.method == 0) return raw; if (it.method == 8) return new InflaterInputStream(raw, new Inflater(true), 1 << 16);
        throw new IOException("unsupportedMethod " + it.method + " " + it.name);
    }
    static final class RangeStream extends InputStream {
        final RandomAccessFile r; long pos; final long end; final byte[] one = new byte[1];
        RangeStream(RandomAccessFile r, long start, long len) { this.r = r; this.pos = start; this.end = start + len; }
        @Override public int read() throws IOException { return read(one, 0, 1) == 1 ? one[0] & 0xff : -1; }
        @Override public int read(byte[] b, int off, int len) throws IOException { if (pos >= end) return -1; r.seek(pos); int n = r.read(b, off, (int) Math.min(len, end - pos)); if (n > 0) pos += n; return n; }
    }

    /* ---------- in place: last entry first, the archive cut back after every committed batch ---------- */
    public static long BATCH_BYTES = 512L << 20; public static int BATCH_COUNT = 64;  // (tests shrink these)
    static int extractZipInPlace(File f, File dest, Options o, Progress pr) throws Exception {
        File journal = new File(f.getPath() + ".kurokawa-unzip"), tail = new File(f.getPath() + ".kurokawa-tail");
        int n = 0;
        try (RandomAccessFile r = new RandomAccessFile(f, "rw")) {
            ZipIndex ix; long committed;
            if (journal.exists() && tail.exists()) {
                // Continue: the directory comes from the tail file, the archive is what the journal says is left.
                JSONObject j = new JSONObject(new String(readFile(journal), StandardCharsets.UTF_8)); committed = j.getLong("committed");
                if (r.length() > committed) r.setLength(committed);
                try (RandomAccessFile t = new RandomAccessFile(tail, "r")) { ix = readZip(t); }
                List<ZipItem> left = new ArrayList<>(); for (ZipItem it : ix.items) if (it.offset < committed) left.add(it); ix.items.clear(); ix.items.addAll(left);
            } else {
                ix = readZip(r); committed = ix.length;
                // The tail (central directory + end record) saved first: it is cut away with the last batch.
                byte[] cd = new byte[(int) (ix.length - ix.cdStart)]; r.seek(ix.cdStart); r.readFully(cd);
                // (A standalone copy of the directory needs its offsets to stay valid: the tail file is the directory
                // preceded by zeros up to cdStart, written sparse so it costs almost nothing.)
                try (RandomAccessFile t = new RandomAccessFile(tail, "rw")) { t.setLength(0); t.seek(ix.cdStart); t.write(cd); }
                JSONObject j = new JSONObject(); j.put("version", 1); j.put("committed", committed); j.put("output", dest.getPath()); j.put("length", ix.length); writeAtomic(journal, j.toString().getBytes(StandardCharsets.UTF_8));
            }
            List<ZipItem> items = new ArrayList<>(ix.items); Collections.sort(items, (a, b) -> Long.compare(b.offset, a.offset));
            long total = 0; for (ZipItem it : items) total += it.usize; long done = 0;
            int i = 0;
            while (i < items.size()) {
                if (pr.stopped()) throw new IOException("stopped");
                // One batch: up to 64 entries or 512 MB of output, never more than the free space allows.
                long free = dest.getUsableSpace() - (64L << 20); long used = 0; int end = i; List<File> written = new ArrayList<>();
                while (end < items.size() && end - i < BATCH_COUNT && (end == i || used + items.get(end).usize <= Math.min(free, BATCH_BYTES))) { used += items.get(end).usize; end++; }
                if (items.get(i).usize > free) throw new IOException("noSpace");
                for (int k = i; k < end; k++) {
                    ZipItem it = items.get(k);
                    if (it.dir) { if (unsafe(it.name)) throw new IOException("unsafePath"); new File(dest, it.name).mkdirs(); continue; }
                    File out = target(dest, it.name, o); if (out == null) { done += it.usize; continue; }
                    pr.on(done, total, it.name);
                    try (InputStream in = entryStream(r, it)) { writeAll(in, out, it.crc, pr, total); }
                    written.add(out); done += it.usize; n++;
                }
                // Commit: the files flushed, the journal moved, then the archive cut back to the batch's first byte.
                for (File w : written) try (FileOutputStream fo = new FileOutputStream(w, true)) { fo.getFD().sync(); } catch (IOException ignored) {}
                committed = items.get(end - 1).offset;
                JSONObject j = new JSONObject(); j.put("version", 1); j.put("committed", committed); j.put("output", dest.getPath()); j.put("length", ix.length); writeAtomic(journal, j.toString().getBytes(StandardCharsets.UTF_8));
                r.setLength(committed); r.getFD().sync();
                i = end;
            }
            pr.on(total, total, "");
        }
        if (!f.delete()) Log.w(TAG, "could not delete " + f);
        tail.delete(); journal.delete();
        return n;
    }
    static byte[] readFile(File f) throws IOException { try (RandomAccessFile r = new RandomAccessFile(f, "r")) { byte[] b = new byte[(int) r.length()]; r.readFully(b); return b; } }
    static void writeAtomic(File f, byte[] data) throws IOException { File tmp = new File(f.getPath() + ".tmp"); try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(data); o.getFD().sync(); } if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new IOException("journal"); } }
    /** Is there a half-done in-place extraction of this archive to continue? */
    public static boolean hasJournal(File f) { return new File(f.getPath() + ".kurokawa-unzip").exists(); }

    /* ---------- the other formats ---------- */
    static int extract7z(File f, File dest, Options o, Progress pr) throws Exception {
        int n = 0; long done = 0, total = 0;
        try (SevenZFile z = o.password != null && !o.password.isEmpty() ? new SevenZFile(f, o.password.toCharArray()) : new SevenZFile(f)) {
            for (SevenZArchiveEntry e : z.getEntries()) total += e.getSize();
            SevenZArchiveEntry e;
            while ((e = z.getNextEntry()) != null) {
                if (pr.stopped()) throw new IOException("stopped");
                if (e.isDirectory()) { if (unsafe(e.getName())) throw new IOException("unsafePath"); new File(dest, e.getName()).mkdirs(); continue; }
                File out = target(dest, e.getName(), o); if (out == null) { done += e.getSize(); continue; }
                pr.on(done, total, e.getName());
                final SevenZFile zz = z; InputStream in = new InputStream() { @Override public int read() throws IOException { return zz.read(); } @Override public int read(byte[] b, int off, int len) throws IOException { return zz.read(b, off, len); } };
                writeAll(in, out, -1, pr, total); done += e.getSize(); n++;
            }
        }
        pr.on(total, total, ""); return n;
    }
    static int extractRar(File f, File dest, Options o, Progress pr) throws Exception {
        int n = 0; long done = 0, total = 0;
        try (com.github.junrar.Archive a = o.password != null && !o.password.isEmpty() ? new com.github.junrar.Archive(f, o.password) : new com.github.junrar.Archive(f)) {
            for (com.github.junrar.rarfile.FileHeader h : a.getFileHeaders()) total += h.getFullUnpackSize();
            for (com.github.junrar.rarfile.FileHeader h : a.getFileHeaders()) {
                if (pr.stopped()) throw new IOException("stopped");
                String name = h.getFileName().replace('\\', '/');
                if (h.isDirectory()) { if (unsafe(name)) throw new IOException("unsafePath"); new File(dest, name).mkdirs(); continue; }
                File out = target(dest, name, o); if (out == null) { done += h.getFullUnpackSize(); continue; }
                pr.on(done, total, name);
                File part = new File(out.getPath() + ".part");
                try (OutputStream os = new BufferedOutputStream(new FileOutputStream(part), 1 << 16)) { a.extractFile(h, os); }
                if (out.exists() && !out.delete()) throw new IOException("cannotReplace"); if (!part.renameTo(out)) throw new IOException("cannotRename");
                done += h.getFullUnpackSize(); n++;
            }
        }
        pr.on(total, total, ""); return n;
    }
    static int extractTar(File f, File dest, String fmt, Options o, Progress pr) throws Exception {
        int n = 0; long done = 0, total = f.length() * (fmt.equals("tar") ? 1 : 3);
        try (TarArchiveInputStream t = new TarArchiveInputStream(decompressor(fmt, new BufferedInputStream(new FileInputStream(f), 1 << 16)))) {
            ArchiveEntry e;
            while ((e = t.getNextEntry()) != null) {
                if (pr.stopped()) throw new IOException("stopped");
                if (e.isDirectory()) { if (unsafe(e.getName())) throw new IOException("unsafePath"); new File(dest, e.getName()).mkdirs(); continue; }
                if (!((org.apache.commons.compress.archivers.tar.TarArchiveEntry) e).isFile()) continue;
                File out = target(dest, e.getName(), o); if (out == null) { done += e.getSize(); continue; }
                pr.on(Math.min(done, total), total, e.getName());
                final TarArchiveInputStream tt = t; InputStream in = new InputStream() { @Override public int read() throws IOException { return tt.read(); } @Override public int read(byte[] b, int off, int len) throws IOException { return tt.read(b, off, len); } };
                writeAll(in, out, -1, pr, total); done += e.getSize(); n++;
            }
        }
        pr.on(total, total, ""); return n;
    }
    static int extractZip4j(File f, File dest, Options o, Progress pr) throws Exception {
        net.lingala.zip4j.ZipFile z = new net.lingala.zip4j.ZipFile(f); if (o.password != null && !o.password.isEmpty()) z.setPassword(o.password.toCharArray());
        if (z.isEncrypted() && (o.password == null || o.password.isEmpty())) throw new IOException("passwordNeeded");
        List<net.lingala.zip4j.model.FileHeader> hs = z.getFileHeaders(); long total = 0; for (net.lingala.zip4j.model.FileHeader h : hs) total += h.getUncompressedSize(); long done = 0; int n = 0;
        for (net.lingala.zip4j.model.FileHeader h : hs) {
            if (pr.stopped()) throw new IOException("stopped");
            if (h.isDirectory()) { if (unsafe(h.getFileName())) throw new IOException("unsafePath"); new File(dest, h.getFileName()).mkdirs(); continue; }
            File out = target(dest, h.getFileName(), o); if (out == null) { done += h.getUncompressedSize(); continue; }
            pr.on(done, total, h.getFileName());
            try (InputStream in = z.getInputStream(h)) { writeAll(in, out, h.getCrc(), pr, total); } catch (net.lingala.zip4j.exception.ZipException ex) { if (String.valueOf(ex.getMessage()).toLowerCase().contains("password")) throw new IOException("wrongPassword"); throw ex; }
            done += h.getUncompressedSize(); n++;
        }
        pr.on(total, total, ""); return n;
    }

    /* ---------- making a zip ---------- */
    /** A zip of files and folders; what gains nothing by squeezing (pictures, video, archives) is stored. */
    public static int createZip(File out, List<File> inputs, Progress pr) throws IOException {
        List<File[]> files = new ArrayList<>(); long total = 0;
        for (File in : inputs) { if (in.isDirectory()) { collect(in, in.getName() + "/", files); } else files.add(new File[]{ in, new File(in.getName()) }); }
        for (File[] p : files) total += p[0].length();
        File part = new File(out.getPath() + ".part"); long done = 0; int n = 0; byte[] buf = new byte[1 << 16];
        try (ZipOutputStream z = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(part), 1 << 16))) {
            for (File[] p : files) {
                if (pr.stopped()) throw new IOException("stopped");
                String name = p[1].getPath().replace('\\', '/'); ZipEntry e = new ZipEntry(name); e.setTime(p[0].lastModified());
                if (stored(name)) { e.setMethod(ZipEntry.STORED); e.setSize(p[0].length()); e.setCompressedSize(p[0].length()); CRC32 c = new CRC32(); try (InputStream in = new FileInputStream(p[0])) { int r; while ((r = in.read(buf)) > 0) c.update(buf, 0, r); } e.setCrc(c.getValue()); }
                z.putNextEntry(e); pr.on(done, total, name);
                try (InputStream in = new BufferedInputStream(new FileInputStream(p[0]), 1 << 16)) { int r; while ((r = in.read(buf)) > 0) { z.write(buf, 0, r); done += r; } }
                z.closeEntry(); n++;
            }
        }
        if (out.exists() && !out.delete()) throw new IOException("cannotReplace"); if (!part.renameTo(out)) throw new IOException("cannotRename");
        pr.on(total, total, ""); return n;
    }
    static void collect(File dir, String prefix, List<File[]> out) { File[] kids = dir.listFiles(); if (kids == null) return; for (File k : kids) { if (k.isDirectory()) collect(k, prefix + k.getName() + "/", out); else out.add(new File[]{ k, new File(prefix + k.getName()) }); } }
    static boolean stored(String name) { return name.matches("(?i).*\\.(png|jpe?g|gif|webp|avif|mp4|mkv|webm|mp3|m4a|ogg|opus|flac|zip|7z|rar|gz|xz|bz2|apk|woff2?)$"); }
}
