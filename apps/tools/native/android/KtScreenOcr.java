package app.kurokawa.tools;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions;
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions;
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Text read from a picture of the screen: Google's on-device text recognition, through Google Play services
 * (its models are fetched by the phone once, not carried in the app). The script follows the language read
 * from: Latin, Japanese, Chinese, Korean or Devanagari. Each block keeps the colours around it, so the
 * translation can be drawn on the same background.
 */
final class KtScreenOcr {
    private static final Map<String, TextRecognizer> made = new HashMap<>();
    static String scriptOf(String lang) {
        if (lang == null) return "latin";
        if (lang.startsWith("ja")) return "ja"; if (lang.startsWith("zh")) return "zh"; if (lang.startsWith("ko")) return "ko";
        if (lang.equals("hi") || lang.equals("mr") || lang.equals("ne") || lang.equals("sa")) return "dev";
        return "latin";
    }
    private static synchronized TextRecognizer of(String script) {
        TextRecognizer r = made.get(script); if (r != null) return r;
        switch (script) {
            case "ja": r = TextRecognition.getClient(new JapaneseTextRecognizerOptions.Builder().build()); break;
            case "zh": r = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build()); break;
            case "ko": r = TextRecognition.getClient(new KoreanTextRecognizerOptions.Builder().build()); break;
            case "dev": r = TextRecognition.getClient(new DevanagariTextRecognizerOptions.Builder().build()); break;
            default: r = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        }
        made.put(script, r); return r;
    }
    /** The text blocks in `b` (inside `area` when given), lines joined as the script writes them. */
    static List<KtScreenA11y.Block> read(Bitmap b, Rect area, String sourceLang) throws Exception {
        String script = scriptOf(sourceLang); Bitmap img = b; int ox = 0, oy = 0;
        if (area != null) { Rect a = new Rect(area); if (!a.intersect(0, 0, b.getWidth(), b.getHeight())) return new ArrayList<>(); img = Bitmap.createBitmap(b, a.left, a.top, a.width(), a.height()); ox = a.left; oy = a.top; }
        Text t = Tasks.await(of(script).process(InputImage.fromBitmap(img, 0)), 25, TimeUnit.SECONDS);
        boolean cjk = script.equals("ja") || script.equals("zh");
        List<KtScreenA11y.Block> out = new ArrayList<>();
        for (Text.TextBlock tb : t.getTextBlocks()) {
            Rect r = tb.getBoundingBox(); if (r == null) continue; r.offset(ox, oy);
            StringBuilder s = new StringBuilder(); for (Text.Line l : tb.getLines()) { if (s.length() > 0 && !cjk) s.append(' '); s.append(l.getText()); }
            String text = s.toString().trim(); if (text.isEmpty() || !KtTranslate.hasLetters(text)) continue;
            KtScreenA11y.Block k = new KtScreenA11y.Block(r, text); colours(b, r, k); out.add(k);
        }
        return out;
    }
    /** The background around a block (its edges' most common colour) and a text colour that reads on it. */
    static void colours(Bitmap b, Rect r, KtScreenA11y.Block k) {
        try {
            Map<Integer, Integer> count = new HashMap<>(); int best = 0, bestN = -1;
            int x0 = Math.max(0, r.left - 2), x1 = Math.min(b.getWidth() - 1, r.right + 2), y0 = Math.max(0, r.top - 2), y1 = Math.min(b.getHeight() - 1, r.bottom + 2);
            int step = Math.max(1, (x1 - x0) / 24);
            for (int x = x0; x <= x1; x += step) for (int y : new int[] { y0, y1 }) { int c = b.getPixel(x, y) & 0xF0F0F0; int n = count.containsKey(c) ? count.get(c) + 1 : 1; count.put(c, n); if (n > bestN) { bestN = n; best = c; } }
            int stepY = Math.max(1, (y1 - y0) / 12);
            for (int y = y0; y <= y1; y += stepY) for (int x : new int[] { x0, x1 }) { int c = b.getPixel(x, y) & 0xF0F0F0; int n = count.containsKey(c) ? count.get(c) + 1 : 1; count.put(c, n); if (n > bestN) { bestN = n; best = c; } }
            k.bg = 0xFF000000 | best | 0x080808;
            double lum = 0.299 * Color.red(k.bg) + 0.587 * Color.green(k.bg) + 0.114 * Color.blue(k.bg);
            k.fg = lum > 140 ? 0xFF111111 : 0xFFFFFFFF;
            // (The words taken off the picture behind them, for the translation to sit on — a balloon stays a balloon, a
            // sky stays a sky; not for huge blocks, where the box of one colour does.)
            int pad = 4, px0 = Math.max(0, r.left - pad), py0 = Math.max(0, r.top - pad), px1 = Math.min(b.getWidth(), r.right + pad), py1 = Math.min(b.getHeight(), r.bottom + pad);
            int pw = px1 - px0, ph = py1 - py0;
            if (pw > 8 && ph > 8 && (long) pw * ph < 600_000L && px0 == r.left - pad && py0 == r.top - pad) {
                int[] pix = new int[pw * ph]; b.getPixels(pix, 0, pw, px0, py0, pw, ph);
                k.patch = KtInpaint.clean(pix, pw, ph); k.pw = pw; k.ph = ph; k.pad = pad;
                int avg = KtInpaint.average(k.patch); double l2 = 0.299 * Color.red(avg) + 0.587 * Color.green(avg) + 0.114 * Color.blue(avg);
                k.fg = l2 > 140 ? 0xFF111111 : 0xFFFFFFFF;
            }
        } catch (Throwable ignored) {}
    }
}
