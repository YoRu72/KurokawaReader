package app.kurokawa.tools;

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
public final class KtArchive {
    private static final String TAG = "KtArchive";
    public interface Progress { void on(long done, long total, String file); boolean stopped(); }

    /* ---------- what kind ---------- */
    /** The charset of zip entry names that are not marked UTF-8: null means «guess» (UTF-8 when the bytes are valid UTF-8, else the system's). */
    public static volatile String nameCharset;
    static java.nio.charset.Charset legacyCharset(byte[] b, int off, int len) {
        if (nameCharset != null && !nameCharset.isEmpty() && !nameCharset.equals("auto")) { try { return java.nio.charset.Charset.forName(nameCharset); } catch (Exception ignored) {} }
        boolean ascii = true; for (int i = off; i < off + len; i++) if ((b[i] & 0x80) != 0) { ascii = false; break; }
        if (ascii) return StandardCharsets.US_ASCII;
        try { StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b, off, len)); return StandardCharsets.UTF_8; } catch (Exception ignored) {}
        String lang = java.util.Locale.getDefault().getLanguage();
        try { return java.nio.charset.Charset.forName(lang.equals("ar") ? "windows-1256" : lang.equals("ja") ? "Shift_JIS" : lang.equals("ko") ? "EUC-KR" : lang.equals("zh") ? "GBK" : lang.equals("ru") || lang.equals("uk") ? "windows-1251" : "IBM437"); } catch (Exception e) { return StandardCharsets.ISO_8859_1; }
    }
    /** A zip made in volumes by zip4j/WinZip style («x.z01», «x.z02»…, «x.zip» last) — read through zip4j. */
    static boolean splitZip(File f) { String n = f.getName(); if (!n.toLowerCase(java.util.Locale.ROOT).endsWith(".zip")) return false; return new File(f.getParentFile(), n.substring(0, n.length() - 4) + ".z01").isFile(); }
    /** The archive's bytes, every volume of a split one joined. */
    static InputStream rawStream(File f) throws IOException {
        java.util.List<File> vols = volumesOf(f); if (vols == null) return new BufferedInputStream(new FileInputStream(f), 1 << 16);
        return new BufferedInputStream(java.nio.channels.Channels.newInputStream(org.apache.commons.compress.utils.MultiReadOnlySeekableByteChannel.forFiles(vols.toArray(new File[0]))), 1 << 16);
    }
    /** The volumes of a split archive («x.7z.001», «x.tar.xz.002»…), in order, when `f` is one of them; else null. */
    static java.util.List<File> volumesOf(File f) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(.*\\.(?:zip|7z|tar|tar\\.gz|tgz|tar\\.xz|txz|tar\\.bz2|tbz2))\\.(\\d{3})$", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(f.getName()); if (!m.matches()) return null;
        java.util.List<File> out = new java.util.ArrayList<>(); File dir = f.getParentFile() == null ? new File(".") : f.getParentFile();
        for (int i = 1; ; i++) { File v = new File(dir, m.group(1) + "." + String.format(java.util.Locale.US, "%03d", i)); if (!v.isFile()) break; out.add(v); }
        return out.size() > 1 ? out : null;
    }
    /** Random access over an archive: one file, or the volumes of a split one («x.zip.001», «.002»…) as one stream.
     *  Cutting it back (`setLength`) truncates the volume the cut lands in and removes the ones after it — so an
     *  in-place extraction frees volumes one by one, HatchZip's way. */
    static final class Rnd implements java.io.Closeable {
        final List<File> files = new ArrayList<>(); final List<RandomAccessFile> rs = new ArrayList<>(); final List<Long> starts = new ArrayList<>(); long pos = 0; long len = 0;
        static Rnd open(File f, String mode) throws IOException { Rnd r = new Rnd(); List<File> vols = volumesOf(f); if (vols == null) vols = Collections.singletonList(f); for (File v : vols) r.add(v, mode); return r; }
        static Rnd of(RandomAccessFile raf) throws IOException { Rnd r = new Rnd(); r.files.add(null); r.rs.add(raf); r.starts.add(0L); r.len = raf.length(); return r; }
        private void add(File v, String mode) throws IOException { RandomAccessFile raf = new RandomAccessFile(v, mode); files.add(v); rs.add(raf); starts.add(len); len += raf.length(); }
        long length() { return len; }
        void seek(long p) { pos = p; }
        long getFilePointer() { return pos; }
        int read(byte[] b, int off, int n) throws IOException {
            if (pos >= len) return -1; int i = rs.size() - 1; while (i > 0 && starts.get(i) > pos) i--;
            RandomAccessFile raf = rs.get(i); long in = pos - starts.get(i); raf.seek(in); long room = (i + 1 < starts.size() ? starts.get(i + 1) : len) - pos; int k = raf.read(b, off, (int) Math.min(n, room)); if (k > 0) pos += k; return k;
        }
        void readFully(byte[] b) throws IOException { readFully(b, 0, b.length); }
        void readFully(byte[] b, int off, int n) throws IOException { int at = 0; while (at < n) { int k = read(b, off + at, n - at); if (k < 0) throw new java.io.EOFException(); at += k; } }
        /** Cut back to `newLen`: the volume holding that byte truncated, the ones after it deleted. */
        void setLength(long newLen) throws IOException {
            for (int i = rs.size() - 1; i >= 0; i--) {
                long st = starts.get(i);
                if (st >= newLen && i > 0) { rs.get(i).close(); File v = files.get(i); if (v != null && !v.delete()) Log.w(TAG, "could not delete " + v); rs.remove(i); files.remove(i); starts.remove(i); }
                else { rs.get(i).setLength(newLen - st); break; }
            }
            len = Math.min(len, newLen);
        }
        /** Written at the position (appends go into the last volume). */
        void write(byte[] b) throws IOException { write(b, 0, b.length); }
        void write(byte[] b, int off, int n) throws IOException { int i = rs.size() - 1; while (i > 0 && starts.get(i) > pos) i--; RandomAccessFile raf = rs.get(i); raf.seek(pos - starts.get(i)); raf.write(b, off, n); pos += n; len = Math.max(len, pos); }
        void sync() throws IOException { for (RandomAccessFile raf : rs) raf.getFD().sync(); }
        private org.apache.commons.compress.archivers.zip.ZipFile cc;
        /** commons-compress's view of the same archive (for the methods our own reader lacks); opened once, closed with this. */
        org.apache.commons.compress.archivers.zip.ZipFile cc() throws IOException {
            if (cc != null) return cc; List<File> fs = new ArrayList<>(); for (File f : files) if (f != null) fs.add(f); if (fs.isEmpty()) throw new IOException("noFile");
            java.nio.channels.SeekableByteChannel ch = fs.size() == 1 ? java.nio.channels.FileChannel.open(fs.get(0).toPath(), java.nio.file.StandardOpenOption.READ) : org.apache.commons.compress.utils.MultiReadOnlySeekableByteChannel.forFiles(fs.toArray(new File[0]));
            cc = org.apache.commons.compress.archivers.zip.ZipFile.builder().setSeekableByteChannel(ch).setCharset(nameCharset != null && !nameCharset.isEmpty() && !nameCharset.equals("auto") ? nameCharset : "UTF-8").get(); return cc;
        }
        boolean volumes() { return rs.size() > 1 || (files.size() == 1 && files.get(0) != null && volumesOf(files.get(0)) != null); }
        @Override public void close() throws IOException { if (cc != null) try { cc.close(); } catch (IOException ignored) {} for (RandomAccessFile raf : rs) raf.close(); }
    }
    /** A 7z opened — every volume of a split one joined — with its password when one is given. */
    static SevenZFile open7z(File f, char[] pw) throws IOException {
        java.util.List<File> vols = volumesOf(f);
        if (vols == null) return pw != null && pw.length > 0 ? new SevenZFile(f, pw) : new SevenZFile(f);
        java.nio.channels.SeekableByteChannel ch = org.apache.commons.compress.utils.MultiReadOnlySeekableByteChannel.forFiles(vols.toArray(new File[0]));
        return pw != null && pw.length > 0 ? new SevenZFile(ch, f.getName(), pw) : new SevenZFile(ch, f.getName());
    }
    public static String formatOf(File f) throws IOException {
        if (volumesOf(f) != null) { f = volumesOf(f).get(0); }
        if (splitZip(f)) return "zip";
        byte[] b = new byte[8];
        try (Rnd r = Rnd.open(f, "r")) { r.readFully(b, 0, (int) Math.min(8, r.length())); }
        String n = f.getName().toLowerCase().replaceAll("\\.\\d{3}$", "");
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
    public static final class ZipItem { public String name; public int method; public long csize, usize, crc, offset; public boolean dir, encrypted; public byte[] raw; }
    public static final class ZipIndex { public final List<ZipItem> items = new ArrayList<>(); public long cdStart, length; }

    static long u32(ByteBuffer b, int at) { return b.getInt(at) & 0xffffffffL; }
    static int u16(ByteBuffer b, int at) { return b.getShort(at) & 0xffff; }

    public static ZipIndex readZip(Rnd r) throws IOException {
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
            boolean utf8 = (flags & 0x800) != 0; it.name = new String(cd, p + 46, nl, utf8 ? StandardCharsets.UTF_8 : legacyCharset(cd, p + 46, nl));
            it.encrypted = (flags & 1) != 0;
            // ZIP64 extra field: the 0xffffffff values in order usize, csize, offset.
            int xp = p + 46 + nl, xe = xp + xl;
            while (xp + 4 <= xe) { int id = u16(c, xp), sz = u16(c, xp + 2); if (id == 1) { int q = xp + 4; if (it.usize == 0xffffffffL) { it.usize = c.getLong(q); q += 8; } if (it.csize == 0xffffffffL) { it.csize = c.getLong(q); q += 8; } if (it.offset == 0xffffffffL) { it.offset = c.getLong(q); } } xp += 4 + sz; }
            it.dir = it.name.endsWith("/") || (it.usize == 0 && it.name.endsWith("\\"));
            it.name = it.name.replace('\\', '/');
            it.raw = java.util.Arrays.copyOfRange(cd, p, p + 46 + nl + xl + cl);
            if (!it.name.isEmpty()) ix.items.add(it);
            p += 46 + nl + xl + cl;
        }
        return ix;
    }
    /** Where an entry's data begins (past its local header, whose name/extra lengths may differ from the directory's). */
    static long dataStart(Rnd r, ZipItem it) throws IOException {
        byte[] h = new byte[30]; r.seek(it.offset); r.readFully(h);
        ByteBuffer b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN); if (b.getInt(0) != 0x04034b50) throw new IOException("badLocalHeader " + it.name);
        return it.offset + 30 + u16(b, 26) + u16(b, 28);
    }
    static boolean unsafe(String name) { return name.startsWith("/") || name.contains("../") || name.equals("..") || name.contains(":") && name.indexOf(':') < 3 && name.length() > 1 && Character.isLetter(name.charAt(0)) && name.charAt(1) == ':'; }

    /* ---------- listing ---------- */
    public static JSONObject list(File f, String password) throws Exception {
        JSONArray arr = new JSONArray(); long total = 0; boolean enc = false; String fmt;
        if (hasJournal(f) && isTar(f)) {
            fmt = "tar"; try (Rnd r = Rnd.open(f, "r")) { for (TarItem it : scanTar(r)) { arr.put(item(it.name, it.size, 0, it.type == '5')); total += it.size; } }
        } else if (hasJournal(f)) {
            // Half extracted in place: the directory lives in the tail file; what is left starts below the journal's mark.
            fmt = "zip"; long committed = new JSONObject(new String(readFile(new File(f.getPath() + ".kurokawa-unzip")), StandardCharsets.UTF_8)).getLong("committed");
            try (RandomAccessFile t = new RandomAccessFile(new File(f.getPath() + ".kurokawa-tail"), "r")) { for (ZipItem it : readZip(Rnd.of(t)).items) if (it.offset < committed) { arr.put(item(it.name, it.usize, it.csize, it.dir)); total += it.usize; } }
        } else if ((fmt = formatOf(f)).equals("zip") && splitZip(f)) {
            net.lingala.zip4j.ZipFile z = zip4j(f, password); for (net.lingala.zip4j.model.FileHeader h : z.getFileHeaders()) { arr.put(item(h.getFileName().replace('\\', '/'), h.getUncompressedSize(), h.getCompressedSize(), h.isDirectory())); total += h.getUncompressedSize(); enc |= h.isEncrypted(); }
        } else if (fmt.equals("zip")) {
            try (Rnd r = Rnd.open(f, "r")) { for (ZipItem it : readZip(r).items) { arr.put(item(it.name, it.usize, it.csize, it.dir)); total += it.usize; enc |= it.encrypted; } }
        } else if (fmt.equals("7z")) {
            try (SevenZFile z = open7z(f, password == null ? null : password.toCharArray())) { SevenZArchiveEntry e; while ((e = z.getNextEntry()) != null) { arr.put(item(e.getName(), e.getSize(), 0, e.isDirectory())); total += e.getSize(); } }
        } else if (fmt.equals("rar")) {
            try (com.github.junrar.Archive a = password != null && !password.isEmpty() ? new com.github.junrar.Archive(f, password) : new com.github.junrar.Archive(f)) { for (com.github.junrar.rarfile.FileHeader h : a.getFileHeaders()) { arr.put(item(h.getFileName().replace('\\', '/'), h.getFullUnpackSize(), h.getFullPackSize(), h.isDirectory())); total += h.getFullUnpackSize(); enc |= h.isEncrypted(); } }
        } else if (fmt.startsWith("tar")) {
            try (TarArchiveInputStream t = new TarArchiveInputStream(decompressor(fmt, rawStream(f)))) { ArchiveEntry e; while ((e = t.getNextEntry()) != null) { arr.put(item(e.getName(), e.getSize(), 0, e.isDirectory())); total += e.getSize(); } }
        } else { String inner = f.getName().replaceAll("\\.(gz|xz|bz2)$", ""); arr.put(item(inner, -1, f.length(), false)); }
        long largest = 0; java.util.Set<String> seen = new java.util.HashSet<>(); String dup = null, bad = null;
        for (int i = 0; i < arr.length(); i++) { JSONObject e = arr.getJSONObject(i); if (!e.getBoolean("dir")) largest = Math.max(largest, e.optLong("size")); String n = e.getString("path"); if (unsafe(n) && bad == null) bad = n; if (!e.getBoolean("dir") && !seen.add(n.toLowerCase(java.util.Locale.ROOT)) && dup == null) dup = n; }
        JSONObject o = new JSONObject(); o.put("format", fmt); o.put("entries", arr); o.put("total", total); o.put("encrypted", enc);
        boolean linked = hardLinked(f); String overlap = fmt.equals("zip") && !splitZip(f) ? overlapping(f) : null;
        o.put("inPlaceOk", ((fmt.equals("zip") && !enc && !splitZip(f) && overlap == null) || fmt.equals("tar")) && !linked);
        if (linked) o.put("hardLinked", true); if (overlap != null) o.put("overlap", overlap);
        if (splitZip(f) || volumesOf(f) != null) o.put("volumes", volumesOf(f) != null ? volumesOf(f).size() : countZipVolumes(f)); o.put("largest", largest);
        File dir = f.getAbsoluteFile().getParentFile(); if (dir != null) o.put("free", dir.getUsableSpace());
        if (bad != null) o.put("unsafe", bad); if (dup != null) o.put("duplicate", dup);
        File sfv = sfvOf(f); if (sfv != null) o.put("sfv", sfv.getName());
        return o;
    }
    static int countZipVolumes(File f) { String n = f.getName(); n = n.substring(0, n.length() - 4); int i = 1; while (new File(f.getParentFile(), n + String.format(java.util.Locale.US, ".z%02d", i)).isFile()) i++; return i; }
    static net.lingala.zip4j.ZipFile zip4j(File f, String password) {
        net.lingala.zip4j.ZipFile z = password != null && !password.isEmpty() ? new net.lingala.zip4j.ZipFile(f, password.toCharArray()) : new net.lingala.zip4j.ZipFile(f);
        if (nameCharset != null && !nameCharset.isEmpty() && !nameCharset.equals("auto")) { try { z.setCharset(java.nio.charset.Charset.forName(nameCharset)); } catch (Exception ignored) {} }
        return z;
    }
    /** Two entries sharing bytes (one's data running into the next's header): a crafted archive, refused in place. */
    static String overlapping(File f) {
        try (Rnd r = Rnd.open(f, "r")) {
            List<ZipItem> items = new ArrayList<>(readZip(r).items); Collections.sort(items, (a, b) -> Long.compare(a.offset, b.offset));
            for (int i = 1; i < items.size(); i++) { ZipItem p = items.get(i - 1), q = items.get(i); if (q.offset < p.offset + 30 + p.csize) return q.name; }
        } catch (Exception e) { return null; }
        return null;
    }
    /** Whether the archive (any volume) has another hard link: cutting it would cut the other name too. */
    static boolean hardLinked(File f) {
        List<File> vols = volumesOf(f); if (vols == null) vols = Collections.singletonList(f);
        for (File v : vols) { try { Object st = Class.forName("android.system.Os").getMethod("stat", String.class).invoke(null, v.getAbsolutePath()); long n = ((Number) st.getClass().getField("st_nlink").get(st)).longValue(); if (n > 1) return true; } catch (Throwable ignored) { /* not Android: no way to know */ } }
        return false;
    }
    static JSONObject item(String name, long size, long csize, boolean dir) throws Exception { JSONObject o = new JSONObject(); o.put("path", name); o.put("size", size); if (csize > 0) o.put("compressed", csize); o.put("dir", dir); return o; }
    static InputStream decompressor(String fmt, InputStream in) throws IOException {
        if (fmt.endsWith(".gz") || fmt.equals("gz")) return new GzipCompressorInputStream(in, true);
        if (fmt.endsWith(".xz") || fmt.equals("xz")) return new XZCompressorInputStream(in, true);
        if (fmt.endsWith(".bz2") || fmt.equals("bz2")) return new BZip2CompressorInputStream(in, true);
        return in;
    }

    /* ---------- extracting ---------- */
    public static final class Options { public boolean inPlace, deleteAfter, verifyFirst; public String replace = "replace"; public String password; public long keepFree = 64L << 20; /** Only these entries (and what is under these folders); null: all. */ public java.util.Set<String> only; }
    static boolean wanted(Options o, String name) { if (o.only == null) return true; String n = name.replace('\\', '/'); for (String w : o.only) { if (n.equals(w) || (w.endsWith("/") && n.startsWith(w))) return true; } return false; }

    /** Extracts into `dest`; returns the number of files written. */
    public static int extract(File f, File dest, Options o, Progress pr) throws Exception {
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("cannotCreate " + dest);
        if (hasJournal(f)) return isTar(f) ? extractTarInPlace(f, dest, o, pr) : extractZipInPlace(f, dest, o, pr);
        String fmt = formatOf(f);
        // HatchZip's rules before anything is touched: a hostile archive is refused, an .sfv beside it checked,
        // and with «verify first» every file's checksum read before the archive is cut.
        JSONObject info = list(f, o.password); if (info.has("unsafe")) throw new IOException("unsafePath " + info.getString("unsafe")); if (info.has("duplicate") && o.inPlace) throw new IOException("duplicateEntry " + info.getString("duplicate"));
        if (o.inPlace && info.has("overlap")) throw new IOException("overlapping " + info.getString("overlap")); if (o.inPlace && info.optBoolean("hardLinked")) throw new IOException("hardLinked");
        File sfv = sfvOf(f); if (sfv != null) { JSONObject chk = checkSfv(sfv, pr); if (chk.getJSONArray("bad").length() > 0) throw new IOException("sfvMismatch " + chk.getJSONArray("bad").join(", ").replace("\"", "")); }
        if (o.verifyFirst && o.inPlace && fmt.equals("zip")) { JSONObject tr = test(f, o.password, pr); if (tr.getJSONArray("bad").length() > 0) throw new IOException("damaged " + tr.getJSONArray("bad").join(", ").replace("\"", "")); }
        if (o.inPlace && fmt.equals("tar")) return extractTarInPlace(f, dest, o, pr);
        int n;
        if (fmt.equals("zip")) {
            boolean enc = splitZip(f); if (!enc) try (Rnd r = Rnd.open(f, "r")) { for (ZipItem it : readZip(r).items) enc |= it.encrypted; }
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
        if (!wanted(o, name)) return null;
        File out = new File(dest, name); File parent = out.getParentFile(); if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannotCreate " + parent);
        if (!out.getCanonicalPath().startsWith(dest.getCanonicalPath() + File.separator)) throw new IOException("unsafePath " + name);
        if (out.exists()) { if ("skip".equals(o.replace)) return null; if ("both".equals(o.replace)) { String base = out.getName(), ext = ""; int dot = base.lastIndexOf('.'); if (dot > 0) { ext = base.substring(dot); base = base.substring(0, dot); } for (int i = 2; ; i++) { File alt = new File(out.getParentFile(), base + " (" + i + ")" + ext); if (!alt.exists()) return alt; } } }
        return out;
    }
    static long writeAll(InputStream in, File out, long crcWant, Progress pr, long tick) throws IOException {
        File part = new File(out.getPath() + ".part"); CRC32 crc = new CRC32(); long n = 0; byte[] buf = new byte[1 << 16];
        try (OutputStream os = new BufferedOutputStream(new FileOutputStream(part), 1 << 16)) { int r; while ((r = in.read(buf)) > 0) { if (pr.stopped()) throw new IOException("stopped"); os.write(buf, 0, r); crc.update(buf, 0, r); n += r; } }
        catch (IOException e) { part.delete(); throw e; }
        if (crcWant >= 0 && crc.getValue() != crcWant) { part.delete(); throw new IOException("crcMismatch " + out.getName()); }
        if (out.exists() && !out.delete()) throw new IOException("cannotReplace " + out);
        if (!part.renameTo(out)) throw new IOException("cannotRename " + out);
        return n;
    }
    static int extractZip(File f, File dest, Options o, Progress pr) throws Exception {
        int n = 0; long done = 0;
        try (Rnd r = Rnd.open(f, "r")) {
            ZipIndex ix = readZip(r); long total = 0; for (ZipItem it : ix.items) total += it.usize;
            for (ZipItem it : ix.items) {
                if (pr.stopped()) throw new IOException("stopped");
                if (it.dir) { if (o.only != null) continue; File d = new File(dest, it.name); if (unsafe(it.name)) throw new IOException("unsafePath"); d.mkdirs(); continue; }
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
    static InputStream entryStream(Rnd r, ZipItem it) throws IOException {
        long start = dataStart(r, it); InputStream raw = new RangeStream(r, start, it.csize);
        if (it.method == 0) return raw; if (it.method == 8) return new InflaterInputStream(raw, new Inflater(true), 1 << 16);
        // (bzip2, Deflate64, LZMA and XZ entries, as 7-Zip writes them: commons-compress reads those over the same bytes.)
        if (it.method == 12 || it.method == 9 || it.method == 14 || it.method == 95) { org.apache.commons.compress.archivers.zip.ZipFile z = r.cc(); org.apache.commons.compress.archivers.zip.ZipArchiveEntry e = z.getEntry(it.name); if (e == null) throw new IOException("missing " + it.name); if (!z.canReadEntryData(e)) throw new IOException("unsupportedMethod " + it.method + " " + it.name); return z.getInputStream(e); }
        throw new IOException("unsupportedMethod " + it.method + " " + it.name);
    }
    static final class RangeStream extends InputStream {
        final Rnd r; long pos; final long start, end; final byte[] one = new byte[1];
        RangeStream(Rnd r, long start, long len) { this.r = r; this.start = start; this.pos = start; this.end = start + len; }
        @Override public int read() throws IOException { return read(one, 0, 1) == 1 ? one[0] & 0xff : -1; }
        @Override public int read(byte[] b, int off, int len) throws IOException { if (pos >= end) return -1; r.seek(pos); int n = r.read(b, off, (int) Math.min(len, end - pos)); if (n > 0) pos += n; return n; }
    }

    /* ---------- one entry, opened without extracting ---------- */
    /** An entry's bytes and size. A plain zip is reached by random access (an entry stored uncompressed can even be
     *  seeked: `seekable`); anything else is walked to the entry and streamed. Nothing is written to the disk. */
    public static final class Opened implements java.io.Closeable {
        public final InputStream in; public final long size; public final boolean seekable; private final java.io.Closeable owner;
        Opened(InputStream in, long size, boolean seekable, java.io.Closeable owner) { this.in = in; this.size = size; this.seekable = seekable; this.owner = owner; }
        /** Skips to `at` (a seekable entry jumps; the others read past). */
        public void seekTo(long at) throws IOException { if (seekable) ((RangeStream) in).pos = ((RangeStream) in).start + at; else { long left = at; byte[] b = new byte[1 << 16]; while (left > 0) { int n = in.read(b, 0, (int) Math.min(b.length, left)); if (n <= 0) break; left -= n; } } }
        @Override public void close() throws IOException { try { in.close(); } finally { if (owner != null) owner.close(); } }
    }
    public static Opened open(File f, String password, String entry) throws Exception {
        String fmt = formatOf(f); entry = entry.replace('\\', '/');
        if (fmt.equals("zip") && !splitZip(f)) {
            Rnd r = Rnd.open(f, "r"); boolean ok = false;
            try {
                for (ZipItem it : readZip(r).items) {
                    if (it.dir || !it.name.equals(entry)) continue;
                    if (it.encrypted) break;
                    InputStream in = entryStream(r, it); ok = true; return new Opened(in, it.usize, it.method == 0, r);
                }
            } finally { if (!ok) r.close(); }
        }
        // Walked: the streams are handed over one by one; ours is kept and the rest of the walk stopped by a pipe.
        final java.io.PipedInputStream pin = new java.io.PipedInputStream(1 << 18); final java.io.PipedOutputStream pout = new java.io.PipedOutputStream(pin);
        final long[] size = { -1 }; final Exception[] err = { null }; final java.util.concurrent.CountDownLatch found = new java.util.concurrent.CountDownLatch(1); final String want = entry;
        Thread t = new Thread(() -> {
            try {
                walk(f, password, (n, sz, in) -> {
                    if (!n.replace('\\', '/').equals(want)) return true;
                    size[0] = sz; found.countDown(); byte[] b = new byte[1 << 16]; int k; try { while ((k = in.read(b)) > 0) pout.write(b, 0, k); } catch (IOException e) { /* the reader went away */ } return false;
                });
                if (size[0] < 0) err[0] = new java.io.FileNotFoundException(want);
            } catch (Exception e) { err[0] = e; }
            finally { found.countDown(); try { pout.close(); } catch (IOException ignored) {} }
        }, "kt-arc-open"); t.setDaemon(true); t.start();
        found.await(); if (err[0] != null) throw err[0];
        return new Opened(pin, size[0], false, null);
    }
    /* ---------- walking an archive: each file as a stream, in the archive's own order ---------- */
    public interface Visitor { /** False stops the walk. The stream need not be read, and is closed after. */ boolean entry(String name, long size, InputStream in) throws Exception; }
    /** Every file of a ZIP (encrypted too), 7z, RAR or tar, one stream at a time and nothing written to the disk
     *  (what the app installer streams from). A wrong or missing password: IOException("password"). */
    public static void walk(File f, String password, Visitor v) throws Exception {
        String fmt = formatOf(f); char[] pw = password == null || password.isEmpty() ? null : password.toCharArray();
        try {
            if (fmt.equals("zip")) {
                try (Rnd r = Rnd.open(f, "r")) {
                    ZipIndex ix = readZip(r); boolean enc = false; for (ZipItem it : ix.items) enc |= it.encrypted;
                    if (!enc) { for (ZipItem it : ix.items) { if (it.dir) continue; try (InputStream in = entryStream(r, it)) { if (!v.entry(it.name, it.usize, in)) return; } } return; }
                }
                if (pw == null) throw new IOException("password");
                try (net.lingala.zip4j.ZipFile z = new net.lingala.zip4j.ZipFile(f, pw)) {
                    for (net.lingala.zip4j.model.FileHeader h : z.getFileHeaders()) { if (h.isDirectory()) continue; try (InputStream in = z.getInputStream(h)) { if (!v.entry(h.getFileName(), h.getUncompressedSize(), in)) return; } }
                }
            } else if (fmt.equals("7z")) {
                try (SevenZFile z = open7z(f, pw)) {
                    SevenZArchiveEntry e; while ((e = z.getNextEntry()) != null) { if (e.isDirectory() || !e.hasStream()) continue; if (!v.entry(e.getName(), e.getSize(), z.getInputStream(e))) return; }
                }
            } else if (fmt.equals("rar")) {
                try (com.github.junrar.Archive a = pw != null ? new com.github.junrar.Archive(f, password) : new com.github.junrar.Archive(f)) {
                    for (com.github.junrar.rarfile.FileHeader h : a.getFileHeaders()) { if (h.isDirectory()) continue; try (InputStream in = a.getInputStream(h)) { if (!v.entry(h.getFileName().replace('\\', '/'), h.getFullUnpackSize(), in)) return; } }
                }
            } else if (fmt.startsWith("tar")) {
                try (TarArchiveInputStream t = new TarArchiveInputStream(decompressor(fmt, new BufferedInputStream(new FileInputStream(f), 1 << 16)))) {
                    ArchiveEntry e; while ((e = t.getNextEntry()) != null) { if (e.isDirectory()) continue; InputStream keep = new java.io.FilterInputStream(t) { @Override public void close() {} }; if (!v.entry(e.getName(), e.getSize(), keep)) return; }
                }
            } else throw new IOException("notArchive");
        } catch (Exception e) {
            String m = String.valueOf(e.getMessage()).toLowerCase(java.util.Locale.ROOT);
            if (e instanceof net.lingala.zip4j.exception.ZipException && m.contains("password") || m.contains("password") || e.getClass().getName().contains("Password") || e.getClass().getName().contains("Crypt")) throw new IOException("password");
            throw e;
        }
    }

    /* ---------- in place: last entry first, the archive cut back after every committed batch ---------- */
    public static long BATCH_BYTES = 512L << 20; public static int BATCH_COUNT = 64;  // (tests shrink these)
    static int extractZipInPlace(File f, File dest, Options o, Progress pr) throws Exception {
        File journal = new File(f.getPath() + ".kurokawa-unzip"), tail = new File(f.getPath() + ".kurokawa-tail");
        int n = 0;
        try (Rnd r = Rnd.open(f, "rw")) {
            ZipIndex ix; long committed;
            if (journal.exists() && tail.exists()) {
                // Continue: the directory comes from the tail file, the archive is what the journal says is left.
                JSONObject j = new JSONObject(new String(readFile(journal), StandardCharsets.UTF_8)); committed = j.getLong("committed");
                if (r.length() > committed) r.setLength(committed);
                try (RandomAccessFile t = new RandomAccessFile(tail, "r")) { ix = readZip(Rnd.of(t)); }
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
                long free = dest.getUsableSpace() - o.keepFree; long used = 0; int end = i; List<File> written = new ArrayList<>();
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
                r.setLength(committed); r.sync();
                i = end;
            }
            pr.on(total, total, "");
        }
        deleteVolumes(f);
        tail.delete(); journal.delete();
        return n;
    }
    static byte[] readFile(File f) throws IOException { try (Rnd r = Rnd.open(f, "r")) { byte[] b = new byte[(int) r.length()]; r.readFully(b); return b; } }
    static void writeAtomic(File f, byte[] data) throws IOException { File tmp = new File(f.getPath() + ".tmp"); try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(data); o.getFD().sync(); } if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new IOException("journal"); } }
    /** Is there a half-done in-place extraction of this archive to continue? */
    public static boolean hasJournal(File f) { return new File(f.getPath() + ".kurokawa-unzip").exists(); }

    /* ---------- HatchZip: test, restore, .sfv, tar in place ---------- */
    /** Every file read and its checksum compared, nothing written: the names that failed. */
    public static JSONObject test(File f, String password, Progress pr) throws Exception {
        JSONArray bad = new JSONArray(); int files = 0; String fmt = formatOf(f); long done = 0, total = 0;
        if (fmt.equals("zip") && !isEncryptedZip(f)) {
            try (Rnd r = Rnd.open(f, "r")) {
                ZipIndex ix = readZip(r); for (ZipItem it : ix.items) total += it.usize; byte[] buf = new byte[1 << 16];
                for (ZipItem it : ix.items) {
                    if (it.dir) continue; if (pr.stopped()) throw new IOException("stopped"); pr.on(done, total, it.name);
                    CRC32 c = new CRC32(); try (InputStream in = entryStream(r, it)) { int n; while ((n = in.read(buf)) > 0) { c.update(buf, 0, n); done += n; } if (c.getValue() != it.crc) bad.put(it.name); } catch (IOException e) { if ("stopped".equals(e.getMessage())) throw e; bad.put(it.name); }
                    files++;
                }
            }
        } else {
            // The libraries check what the format carries (7z and rar CRCs, zip4j's); a tar can only be read in full.
            File sink = new File(f.getParentFile(), ".kurokawa-test-" + System.nanoTime()); Options o = new Options(); o.password = password;
            try { files = extract(f, sink, o, pr); } catch (IOException e) { if ("stopped".equals(e.getMessage())) throw e; bad.put(e.getMessage()); } finally { deleteTree(sink); }
        }
        pr.on(total, total, ""); JSONObject out = new JSONObject(); out.put("ok", bad.length() == 0); out.put("files", files); out.put("bad", bad); return out;
    }
    static boolean isEncryptedZip(File f) throws IOException { try (Rnd r = Rnd.open(f, "r")) { for (ZipItem it : readZip(r).items) if (it.encrypted) return true; } return false; }
    static void deleteTree(File d) { File[] k = d.listFiles(); if (k != null) for (File x : k) deleteTree(x); d.delete(); }

    /** Giving up an extraction in place: what is left of the archive becomes a normal ZIP again (its remaining
     *  entries' directory records written after them, then the end records); the extracted files stay. */
    public static int restore(File f) throws Exception {
        File journal = new File(f.getPath() + ".kurokawa-unzip"), tail = new File(f.getPath() + ".kurokawa-tail");
        if (!journal.exists()) throw new IOException("nothingToRestore");
        if (isTar(f)) { journal.delete(); return -1; }   // a cut tar is a valid tar already
        long committed = new JSONObject(new String(readFile(journal), StandardCharsets.UTF_8)).getLong("committed");
        List<ZipItem> left = new ArrayList<>(); try (RandomAccessFile t = new RandomAccessFile(tail, "r")) { for (ZipItem it : readZip(Rnd.of(t)).items) if (it.offset < committed) left.add(it); }
        Collections.sort(left, (a, b) -> Long.compare(a.offset, b.offset));
        try (Rnd r = Rnd.open(f, "rw")) {
            if (r.length() > committed) r.setLength(committed);
            r.seek(committed); long cdStart = committed; long cdSize = 0;
            for (ZipItem it : left) { r.write(it.raw); cdSize += it.raw.length; }
            long cdEnd = cdStart + cdSize; boolean z64 = left.size() >= 0xffff || cdStart >= 0xffffffffL || cdSize >= 0xffffffffL;
            ByteBuffer b = ByteBuffer.allocate(56 + 20 + 22).order(ByteOrder.LITTLE_ENDIAN);
            if (z64) { b.putInt(0x06064b50).putLong(44).putShort((short) 45).putShort((short) 45).putInt(0).putInt(0).putLong(left.size()).putLong(left.size()).putLong(cdSize).putLong(cdStart); b.putInt(0x07064b50).putInt(0).putLong(cdEnd).putInt(1); }
            b.putInt(0x06054b50).putShort((short) 0).putShort((short) 0).putShort((short) Math.min(left.size(), 0xffff)).putShort((short) Math.min(left.size(), 0xffff)).putInt((int) Math.min(cdSize, 0xffffffffL)).putInt((int) Math.min(cdStart, 0xffffffffL)).putShort((short) 0);
            r.write(b.array(), 0, b.position()); r.sync();
        }
        journal.delete(); tail.delete(); return left.size();
    }

    /** The .sfv beside an archive (named after it, or after its stem). */
    static File sfvOf(File f) { File dir = f.getAbsoluteFile().getParentFile(); if (dir == null) return null; String n = f.getName(); for (String c : new String[]{ n + ".sfv", n.replaceAll("\\.(zip|7z|rar|tar)(\\.\\d{3})?$", "") + ".sfv", n.replaceAll("\\.part\\d+\\.rar$|\\.\\d{3}$", "") + ".sfv" }) { File s = new File(dir, c); if (s.isFile()) return s; } return null; }
    /** Every file an .sfv names, its CRC-32 compared: the ones missing or different. */
    public static JSONObject checkSfv(File sfv, Progress pr) throws Exception {
        JSONArray bad = new JSONArray(); int n = 0; byte[] buf = new byte[1 << 16];
        for (String line : new String(readFile(sfv), StandardCharsets.ISO_8859_1).split("\r?\n")) {
            line = line.trim(); if (line.isEmpty() || line.startsWith(";")) continue;
            int sp = line.lastIndexOf(' '); if (sp < 0) continue; String name = line.substring(0, sp).trim(); long want; try { want = Long.parseLong(line.substring(sp + 1).trim(), 16); } catch (NumberFormatException e) { continue; }
            File x = new File(sfv.getParentFile(), name); n++; if (!x.isFile()) { bad.put(name); continue; }
            CRC32 c = new CRC32(); long done = 0, total = x.length(); try (InputStream in = new BufferedInputStream(new FileInputStream(x), 1 << 16)) { int k; while ((k = in.read(buf)) > 0) { if (pr.stopped()) throw new IOException("stopped"); c.update(buf, 0, k); done += k; if ((done & 0x3ffffff) < k) pr.on(done, total, name); } }
            if (c.getValue() != want) bad.put(name);
        }
        JSONObject o = new JSONObject(); o.put("files", n); o.put("bad", bad); return o;
    }

    /* tar in place: headers scanned (GNU long names, pax paths), the last entry first, the file cut back to the
     * first header of each entry once it is written; resuming is a fresh scan of what is left. */
    static boolean isTar(File f) { String n = f.getName().toLowerCase(java.util.Locale.ROOT); return n.endsWith(".tar"); }
    static final class TarItem { String name; long head, data, size; char type; }
    static List<TarItem> scanTar(Rnd r) throws IOException {
        List<TarItem> out = new ArrayList<>(); long pos = 0, len = r.length(); byte[] h = new byte[512]; String longName = null; long groupStart = -1;
        while (pos + 512 <= len) {
            r.seek(pos); r.readFully(h); boolean zero = true; for (byte b : h) if (b != 0) { zero = false; break; } if (zero) break;
            if (groupStart < 0) groupStart = pos;
            String name = cstr(h, 0, 100); long size = octal(h, 124, 12); char type = (char) (h[156] == 0 ? '0' : h[156]);
            String magic = cstr(h, 257, 6); if (magic.startsWith("ustar")) { String pre = cstr(h, 345, 155); if (!pre.isEmpty()) name = pre + "/" + name; }
            long data = pos + 512; long next = data + ((size + 511) / 512) * 512;
            if (type == 'L') { byte[] b = new byte[(int) size]; r.seek(data); r.readFully(b); longName = new String(b, StandardCharsets.UTF_8).replace("\0", ""); pos = next; continue; }
            if (type == 'x') { byte[] b = new byte[(int) size]; r.seek(data); r.readFully(b); for (String rec : new String(b, StandardCharsets.UTF_8).split("\n")) { int eq = rec.indexOf(" path="); if (eq > 0) longName = rec.substring(eq + 6); } pos = next; continue; }
            if (type == 'g') { pos = next; continue; }
            TarItem it = new TarItem(); it.name = longName != null ? longName : name; it.head = groupStart; it.data = data; it.size = size; it.type = type; out.add(it);
            longName = null; groupStart = -1; pos = next;
        }
        return out;
    }
    static String cstr(byte[] b, int off, int len) { int e = off; while (e < off + len && b[e] != 0) e++; return new String(b, off, e - off, StandardCharsets.UTF_8); }
    static long octal(byte[] b, int off, int len) { if ((b[off] & 0x80) != 0) { long v = 0; for (int i = off + 1; i < off + len; i++) v = (v << 8) | (b[i] & 0xff); return v; } String s = cstr(b, off, len).trim(); return s.isEmpty() ? 0 : Long.parseLong(s, 8); }
    static int extractTarInPlace(File f, File dest, Options o, Progress pr) throws Exception {
        File journal = new File(f.getPath() + ".kurokawa-unzip"); int n = 0;
        try (Rnd r = Rnd.open(f, "rw")) {
            if (journal.exists()) { long c = new JSONObject(new String(readFile(journal), StandardCharsets.UTF_8)).getLong("committed"); if (r.length() > c) r.setLength(c); }
            else { JSONObject j = new JSONObject(); j.put("version", 1); j.put("format", "tar"); j.put("committed", r.length()); j.put("output", dest.getPath()); writeAtomic(journal, j.toString().getBytes(StandardCharsets.UTF_8)); }
            List<TarItem> items = scanTar(r); long total = 0; for (TarItem it : items) total += it.size; long done = 0;
            for (TarItem it : items) if (unsafe(it.name)) throw new IOException("unsafePath " + it.name);
            List<String> links = new ArrayList<>();
            for (int i = items.size() - 1; i >= 0; i--) {
                TarItem it = items.get(i); if (pr.stopped()) throw new IOException("stopped");
                if (it.type == '5') new File(dest, it.name).mkdirs();
                else if (it.type == '0' || it.type == '7') {
                    if (it.size > dest.getUsableSpace() - o.keepFree) throw new IOException("noSpace");
                    File out = target(dest, it.name, o);
                    if (out != null) { pr.on(done, total, it.name); try (InputStream in = new RangeStream(r, it.data, it.size)) { writeAll(in, out, -1, pr, total); } try (FileOutputStream fo = new FileOutputStream(out, true)) { fo.getFD().sync(); } catch (IOException ignored) {} n++; }
                } else if (it.type == '2' || it.type == '1') links.add(it.name);   // (links are not made: nothing is written through one)
                done += it.size;
                JSONObject j = new JSONObject(); j.put("version", 1); j.put("format", "tar"); j.put("committed", it.head); j.put("output", dest.getPath()); writeAtomic(journal, j.toString().getBytes(StandardCharsets.UTF_8));
                r.setLength(it.head); r.sync();
            }
            pr.on(total, total, "");
        }
        deleteVolumes(f); journal.delete();
        return n;
    }
    /** The archive removed — every volume of a split one. */
    static void deleteVolumes(File f) { List<File> vols = volumesOf(f); if (vols == null) vols = Collections.singletonList(f); for (File v : vols) if (v.exists() && !v.delete()) Log.w(TAG, "could not delete " + v); }

    /* ---------- the other formats ---------- */
    static int extract7z(File f, File dest, Options o, Progress pr) throws Exception {
        int n = 0; long done = 0, total = 0;
        try (SevenZFile z = open7z(f, o.password == null ? null : o.password.toCharArray())) {
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
        try (TarArchiveInputStream t = new TarArchiveInputStream(decompressor(fmt, rawStream(f)))) {
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
        net.lingala.zip4j.ZipFile z = zip4j(f, o.password);
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
    /** What to make: the format (zip, 7z, tar, tar.gz, tar.xz), how hard to squeeze (0–9), a password (zip: AES-256 through zip4j; the others have none), the sources deleted after. */
    public static final class MakeOptions { public String format = "zip"; public int level = 6; public String password; public boolean deleteAfter; public String comment; /** Volumes of this many MiB (0: one file). Zip: WinZip-style .z01…; others: .001, .002… */ public int splitMb; }
    /** An archive of files and folders in the format asked; what gains nothing by squeezing is stored in a zip. */
    public static int create(File out, List<File> inputs, MakeOptions o, Progress pr) throws IOException {
        List<File[]> files = new ArrayList<>(); long total = 0;
        for (File in : inputs) { if (in.isDirectory()) { collect(in, in.getName() + "/", files); } else files.add(new File[]{ in, new File(in.getName()) }); }
        for (File[] p : files) total += p[0].length();
        File part = new File(out.getPath() + ".part"); long done = 0; int n = 0; byte[] buf = new byte[1 << 16]; String fmt = o.format == null ? "zip" : o.format;
        if (fmt.equals("zip") && o.splitMb > 0) {
            // Volumes: zip4j writes «name.z01», «name.z02»… and «name.zip» last, in one go.
            if (out.exists() && !out.delete()) throw new IOException("cannotReplace");
            String stem = out.getName().replaceAll("(?i)\\.zip$", ""); for (int i = 1; i < 1000; i++) { File v = new File(out.getParentFile(), stem + String.format(java.util.Locale.US, ".z%02d", i)); if (!v.delete() && v.exists()) throw new IOException("cannotReplace"); }
            try (net.lingala.zip4j.ZipFile z = o.password != null && !o.password.isEmpty() ? new net.lingala.zip4j.ZipFile(out, o.password.toCharArray()) : new net.lingala.zip4j.ZipFile(out)) {
                net.lingala.zip4j.model.ZipParameters zp = new net.lingala.zip4j.model.ZipParameters();
                if (o.password != null && !o.password.isEmpty()) { zp.setEncryptFiles(true); zp.setEncryptionMethod(net.lingala.zip4j.model.enums.EncryptionMethod.AES); zp.setAesKeyStrength(net.lingala.zip4j.model.enums.AesKeyStrength.KEY_STRENGTH_256); }
                if (o.level == 0) zp.setCompressionMethod(net.lingala.zip4j.model.enums.CompressionMethod.STORE); else zp.setCompressionLevel(o.level <= 2 ? net.lingala.zip4j.model.enums.CompressionLevel.FASTEST : o.level <= 4 ? net.lingala.zip4j.model.enums.CompressionLevel.FAST : o.level <= 6 ? net.lingala.zip4j.model.enums.CompressionLevel.NORMAL : o.level <= 8 ? net.lingala.zip4j.model.enums.CompressionLevel.MAXIMUM : net.lingala.zip4j.model.enums.CompressionLevel.ULTRA);
                net.lingala.zip4j.progress.ProgressMonitor pm = z.getProgressMonitor(); z.setRunInThread(true);
                // zip4j splits only while creating, so everything is handed over at once; names are taken relative to the inputs' folder, so folders keep their shape.
                File base = inputs.get(0).getAbsoluteFile().getParentFile(); zp.setDefaultFolderPath(base.getPath());
                List<File> all = new ArrayList<>(); for (File[] q : files) all.add(q[0]);
                z.createSplitZipFile(all, zp, true, Math.max(64L << 10, (long) o.splitMb << 20));
                while (pm.getState() == net.lingala.zip4j.progress.ProgressMonitor.State.BUSY) { if (pr.stopped()) { pm.setCancelAllTasks(true); throw new IOException("stopped"); } pr.on(Math.min(total, total * pm.getPercentDone() / 100), total, String.valueOf(pm.getFileName())); try { Thread.sleep(150); } catch (InterruptedException e) { throw new IOException("stopped"); } }
                if (pm.getResult() == net.lingala.zip4j.progress.ProgressMonitor.Result.ERROR) throw new IOException(pm.getException() != null ? String.valueOf(pm.getException().getMessage()) : "zipFailed");
                if (o.comment != null && !o.comment.isEmpty()) z.setComment(o.comment);
                n = files.size();
            }
            if (o.deleteAfter) for (File in : inputs) deleteTree(in);
            pr.on(total, total, ""); return n;
        }
        if (fmt.equals("zip") && o.password != null && !o.password.isEmpty()) {
            // (zip4j: AES-256, the level asked; one file at a time so the progress is told.)
            try (net.lingala.zip4j.ZipFile z = new net.lingala.zip4j.ZipFile(part, o.password.toCharArray())) {
                for (File[] p : files) {
                    if (pr.stopped()) throw new IOException("stopped");
                    String name = p[1].getPath().replace('\\', '/'); pr.on(done, total, name);
                    net.lingala.zip4j.model.ZipParameters zp = new net.lingala.zip4j.model.ZipParameters(); zp.setFileNameInZip(name); zp.setEncryptFiles(true); zp.setEncryptionMethod(net.lingala.zip4j.model.enums.EncryptionMethod.AES); zp.setAesKeyStrength(net.lingala.zip4j.model.enums.AesKeyStrength.KEY_STRENGTH_256);
                    if (stored(name) || o.level == 0) zp.setCompressionMethod(net.lingala.zip4j.model.enums.CompressionMethod.STORE); else { zp.setCompressionMethod(net.lingala.zip4j.model.enums.CompressionMethod.DEFLATE); zp.setCompressionLevel(o.level <= 2 ? net.lingala.zip4j.model.enums.CompressionLevel.FASTEST : o.level <= 4 ? net.lingala.zip4j.model.enums.CompressionLevel.FAST : o.level <= 6 ? net.lingala.zip4j.model.enums.CompressionLevel.NORMAL : o.level <= 8 ? net.lingala.zip4j.model.enums.CompressionLevel.MAXIMUM : net.lingala.zip4j.model.enums.CompressionLevel.ULTRA); }
                    z.addFile(p[0], zp); done += p[0].length(); n++;
                }
                if (o.comment != null && !o.comment.isEmpty()) z.setComment(o.comment);
            }
        } else if (fmt.equals("zip")) {
            try (ZipOutputStream z = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(part), 1 << 16))) {
                z.setLevel(Math.max(0, Math.min(9, o.level))); if (o.comment != null && !o.comment.isEmpty()) z.setComment(o.comment);
                for (File[] p : files) {
                    if (pr.stopped()) throw new IOException("stopped");
                    String name = p[1].getPath().replace('\\', '/'); ZipEntry e = new ZipEntry(name); e.setTime(p[0].lastModified());
                    if (stored(name) || o.level == 0) { e.setMethod(ZipEntry.STORED); e.setSize(p[0].length()); e.setCompressedSize(p[0].length()); CRC32 c = new CRC32(); try (InputStream in = new FileInputStream(p[0])) { int r; while ((r = in.read(buf)) > 0) c.update(buf, 0, r); } e.setCrc(c.getValue()); }
                    z.putNextEntry(e); pr.on(done, total, name);
                    try (InputStream in = new BufferedInputStream(new FileInputStream(p[0]), 1 << 16)) { int r; while ((r = in.read(buf)) > 0) { z.write(buf, 0, r); done += r; } }
                    z.closeEntry(); n++;
                }
            }
        } else if (fmt.equals("7z")) {
            try (org.apache.commons.compress.archivers.sevenz.SevenZOutputFile z = new org.apache.commons.compress.archivers.sevenz.SevenZOutputFile(part)) {
                z.setContentMethods(Collections.singletonList(new org.apache.commons.compress.archivers.sevenz.SevenZMethodConfiguration(org.apache.commons.compress.archivers.sevenz.SevenZMethod.LZMA2, new org.tukaani.xz.LZMA2Options(Math.max(0, Math.min(9, o.level))))));
                for (File[] p : files) {
                    if (pr.stopped()) throw new IOException("stopped");
                    String name = p[1].getPath().replace('\\', '/'); SevenZArchiveEntry e = z.createArchiveEntry(p[0], name); z.putArchiveEntry(e); pr.on(done, total, name);
                    try (InputStream in = new BufferedInputStream(new FileInputStream(p[0]), 1 << 16)) { int r; while ((r = in.read(buf)) > 0) { z.write(buf, 0, r); done += r; } }
                    z.closeArchiveEntry(); n++;
                }
            }
        } else {
            OutputStream raw = new BufferedOutputStream(new FileOutputStream(part), 1 << 16);
            OutputStream comp = fmt.equals("tar.gz") ? new org.apache.commons.compress.compressors.gzip.GzipCompressorOutputStream(raw) : fmt.equals("tar.xz") ? new org.apache.commons.compress.compressors.xz.XZCompressorOutputStream(raw, Math.max(0, Math.min(9, o.level))) : raw;
            try (org.apache.commons.compress.archivers.tar.TarArchiveOutputStream t = new org.apache.commons.compress.archivers.tar.TarArchiveOutputStream(comp)) {
                t.setLongFileMode(org.apache.commons.compress.archivers.tar.TarArchiveOutputStream.LONGFILE_POSIX); t.setBigNumberMode(org.apache.commons.compress.archivers.tar.TarArchiveOutputStream.BIGNUMBER_POSIX);
                for (File[] p : files) {
                    if (pr.stopped()) throw new IOException("stopped");
                    String name = p[1].getPath().replace('\\', '/'); org.apache.commons.compress.archivers.tar.TarArchiveEntry e = new org.apache.commons.compress.archivers.tar.TarArchiveEntry(p[0], name); t.putArchiveEntry(e); pr.on(done, total, name);
                    try (InputStream in = new BufferedInputStream(new FileInputStream(p[0]), 1 << 16)) { int r; while ((r = in.read(buf)) > 0) { t.write(buf, 0, r); done += r; } }
                    t.closeArchiveEntry(); n++;
                }
            }
        }
        if (o.splitMb > 0) {
            // Volumes «name.7z.001», «.002»… (what 7-Zip and ZArchiver make and read); the one-piece file is cut up and removed.
            long each = Math.max(64L << 10, (long) o.splitMb << 20); byte[] b = new byte[1 << 16];
            try (InputStream in = new BufferedInputStream(new FileInputStream(part), 1 << 16)) {
                for (int v = 1; ; v++) {
                    File vol = new File(out.getPath() + String.format(java.util.Locale.US, ".%03d", v)); long wrote = 0; int r = -1;
                    try (OutputStream os = new BufferedOutputStream(new FileOutputStream(vol), 1 << 16)) { while (wrote < each && (r = in.read(b, 0, (int) Math.min(b.length, each - wrote))) > 0) { os.write(b, 0, r); wrote += r; } }
                    if (pr.stopped()) throw new IOException("stopped");
                    if (wrote == 0 && v > 1) { vol.delete(); break; }
                    if (r <= 0 && wrote < each) break;
                }
            }
            part.delete();
            if (o.deleteAfter) for (File in : inputs) deleteTree(in);
            pr.on(total, total, ""); return n;
        }
        if (out.exists() && !out.delete()) throw new IOException("cannotReplace"); if (!part.renameTo(out)) throw new IOException("cannotRename");
        if (o.deleteAfter) for (File in : inputs) deleteTree(in);
        pr.on(total, total, ""); return n;
    }
    static void collect(File dir, String prefix, List<File[]> out) { File[] kids = dir.listFiles(); if (kids == null) return; for (File k : kids) { if (k.isDirectory()) collect(k, prefix + k.getName() + "/", out); else out.add(new File[]{ k, new File(prefix + k.getName()) }); } }
    static boolean stored(String name) { return name.matches("(?i).*\\.(png|jpe?g|gif|webp|avif|mp4|mkv|webm|mp3|m4a|ogg|opus|flac|zip|7z|rar|gz|xz|bz2|apk|woff2?)$"); }
}
