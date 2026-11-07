package app.kurokawa.tools;

import android.graphics.Typeface;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** The floating translator's lettering: each block's kind (as src/screen/lettering.ts decides it) and the font file the
 *  reader set for that kind. */
final class KtLetterFace {
    /** Each block's kind: the glossary first, then how it looks (as the page decides it). */
    static void kinds(List<KtScreenA11y.Block> blocks, List<KtLettering.Entry> g) {
        List<Integer> hs = new ArrayList<>(); for (KtScreenA11y.Block k : blocks) if (k.r.height() > 0) hs.add(k.r.height()); Collections.sort(hs);
        int median = hs.isEmpty() ? 0 : hs.get(hs.size() / 2);
        for (KtScreenA11y.Block k : blocks) {
            String kind = null;
            for (KtLettering.Entry e : g) if (!e.kind.isEmpty() && e.p.matcher(k.text).find()) { kind = e.kind; break; }
            if (kind == null) {
                String s = k.text.trim(); int letters = 0; for (int i = 0; i < s.length(); ) { int cp = s.codePointAt(i); if (Character.isLetter(cp)) letters++; i += Character.charCount(cp); }
                boolean hasBg = k.bg != 0; int r = (k.bg >> 16) & 255, gr = (k.bg >> 8) & 255, bl = k.bg & 255;
                double lum = (0.2126 * r + 0.7152 * gr + 0.0722 * bl) / 255; int mx = Math.max(r, Math.max(gr, bl)), mn = Math.min(r, Math.min(gr, bl)); double sat = mx == 0 ? 0 : (mx - mn) / (double) mx;
                boolean light = !hasBg || (lum > 0.82 && sat < 0.18);
                if (s.matches("(?s)^[(（〔［\\[].*[)）〕］\\]]$")) kind = "thought";
                else if (letters > 0 && letters <= 6 && median > 0 && k.r.height() > median * 1.7 && !light) kind = "sfx";
                else if (hasBg && (lum < 0.55 || sat > 0.25)) kind = "box";
                else kind = "dialogue";
            }
            k.kind = kind;
        }
    }
    private static final Map<String, Typeface> faces = new HashMap<>();
    /** The typeface set for a kind (its own, else the default one); null for the system's. */
    static Typeface face(Map<String, Object> cfg, String kind) {
        Map<String, Object> l = KtJson.obj(cfg == null ? null : cfg.get("letter")); Map<String, Object> f = KtJson.obj(l.get("fonts"));
        String id = !Boolean.FALSE.equals(l.get("kinds")) ? KtJson.str(f.get(kind == null ? "dialogue" : kind), "") : "";
        if (id.isEmpty()) id = KtJson.str(f.get("default"), ""); if (id.isEmpty()) return null;
        for (Object o : KtJson.arr(l.get("lib"))) {
            Map<String, Object> e = KtJson.obj(o); if (!id.equals(KtJson.str(e.get("id"), ""))) continue;
            String path = KtJson.str(e.get("path"), ""); if (path.isEmpty() || !new File(path).isFile()) return null;
            synchronized (faces) { Typeface t = faces.get(path); if (t == null) { try { t = Typeface.createFromFile(path); } catch (Throwable ex) { return null; } faces.put(path, t); } return t; }
        }
        return null;
    }
    static boolean centred(String kind) { return kind == null || "dialogue".equals(kind) || "thought".equals(kind) || "sfx".equals(kind); }
}
