package app.kurokawa.reader;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.KrPdfPrint;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;

/**
 * A page of HTML (a book laid out for paper, its pictures and fonts inside it) printed to a PDF as the system's
 * own print does it — real text and pictures, not pictures of pages: a web view of its own, out of sight behind
 * the app, then its print job written to a file (KrPdfPrint) and handed back. Anything that goes wrong is
 * reported; the app then makes the PDF its own way.
 */
final class KrPrint {
    private KrPrint() {}
    private interface Fail { void at(String why); }

    /** Points (1/72 in) to thousandths of an inch, as the print framework measures. */
    private static int mils(double pt) { return (int) Math.round(pt / 72.0 * 1000.0); }

    static void run(final Activity act, final String html, final double wPt, final double hPt, final double marginPt, final PluginCall call) {
        final Handler ui = new Handler(Looper.getMainLooper());
        final WebView web = new WebView(act);
        final boolean[] done = { false };
        final File out = new File(act.getCacheDir(), "kr-print-" + System.nanoTime() + ".pdf");
        final Runnable dispose = () -> {
            try { web.stopLoading(); } catch (Throwable ignored) {}
            try { ViewGroup p = (ViewGroup) web.getParent(); if (p != null) p.removeView(web); } catch (Throwable ignored) {}
            try { web.destroy(); } catch (Throwable ignored) {}
        };
        final Fail fail = (why) -> ui.post(() -> {
            if (done[0]) return; done[0] = true; dispose.run(); out.delete(); call.reject("print: " + why);
        });
        ui.postDelayed(() -> fail.at("timed out"), 180_000);
        try {
            web.getSettings().setJavaScriptEnabled(false);   // HTML and CSS only
            web.getSettings().setAllowFileAccess(false);
            web.getSettings().setBlockNetworkLoads(true);    // everything it needs is inside it
            web.setFocusable(false);
            web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            web.setWebViewClient(new WebViewClient() {
                private boolean started = false;
                @Override public void onPageFinished(WebView view, String url) {
                    if (started || done[0]) return;
                    started = true;
                    // (A moment for its fonts and pictures to be decoded.)
                    ui.postDelayed(() -> {
                        if (done[0]) return;
                        try {
                            int m = mils(marginPt);
                            PrintAttributes attrs = new PrintAttributes.Builder()
                                .setMediaSize(new PrintAttributes.MediaSize("kr-paper", "Paper", mils(wPt), mils(hPt)))
                                .setResolution(new PrintAttributes.Resolution("kr-pdf", "PDF", 300, 300))
                                .setMinMargins(new PrintAttributes.Margins(m, m, m, m))
                                .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                                .build();
                            final ParcelFileDescriptor fd = ParcelFileDescriptor.open(out, ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE | ParcelFileDescriptor.MODE_READ_WRITE);
                            PrintDocumentAdapter adapter = web.createPrintDocumentAdapter("KurokawaReader");
                            KrPdfPrint.write(adapter, attrs, fd, new KrPdfPrint.Done() {
                                @Override public void ok() {
                                    try { fd.close(); } catch (Throwable ignored) {}
                                    // (Read and encoded off the main thread: a book's PDF is megabytes.)
                                    new Thread(() -> {
                                        try {
                                            byte[] bytes = new byte[(int) out.length()];
                                            try (InputStream in = new FileInputStream(out)) { int off = 0; while (off < bytes.length) { int n = in.read(bytes, off, bytes.length - off); if (n < 0) break; off += n; } }
                                            if (bytes.length < 64) { fail.at("empty"); return; }
                                            final String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                                            ui.post(() -> {
                                                if (done[0]) return; done[0] = true; dispose.run(); out.delete();
                                                JSObject r = new JSObject(); r.put("data", b64); call.resolve(r);
                                            });
                                        } catch (Throwable t) { fail.at(String.valueOf(t.getMessage())); }
                                    }).start();
                                }
                                @Override public void fail(String why) { try { fd.close(); } catch (Throwable ignored) {} fail.at(why); }
                            });
                        } catch (Throwable t) { fail.at(t.getClass().getSimpleName() + ": " + t.getMessage()); }
                    }, 700);
                }
            });
            // Laid out at the paper's width (in CSS pixels), out of sight behind the app.
            ViewGroup content = act.findViewById(android.R.id.content);
            float d = act.getResources().getDisplayMetrics().density;
            content.addView(web, 0, new ViewGroup.LayoutParams(Math.max(1, Math.round((float) (wPt / 72.0 * 96.0) * d)), ViewGroup.LayoutParams.MATCH_PARENT));
            web.loadDataWithBaseURL("https://localhost/", html, "text/html", "utf-8", null);
        } catch (Throwable t) { fail.at(t.getClass().getSimpleName() + ": " + t.getMessage()); }
    }
}
