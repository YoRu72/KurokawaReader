package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

/**
 * A web view's print job written to a PDF file, with no print dialog: the print framework's layout and write
 * callbacks can only be made from this package (their constructors are not part of the SDK), so this one class
 * lives here. Used by app.kurokawa.reader.KrPrint.
 */
public final class KrPdfPrint {
    public interface Done { void ok(); void fail(String why); }

    private KrPdfPrint() {}

    public static void write(final PrintDocumentAdapter adapter, PrintAttributes attrs, final ParcelFileDescriptor out, final Done done) {
        final CancellationSignal cancel = new CancellationSignal();
        adapter.onStart();
        adapter.onLayout(null, attrs, cancel, new PrintDocumentAdapter.LayoutResultCallback() {
            @Override public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                adapter.onWrite(new PageRange[] { PageRange.ALL_PAGES }, out, cancel, new PrintDocumentAdapter.WriteResultCallback() {
                    @Override public void onWriteFinished(PageRange[] pages) { adapter.onFinish(); done.ok(); }
                    @Override public void onWriteFailed(CharSequence error) { adapter.onFinish(); done.fail(String.valueOf(error)); }
                    @Override public void onWriteCancelled() { adapter.onFinish(); done.fail("cancelled"); }
                });
            }
            @Override public void onLayoutFailed(CharSequence error) { adapter.onFinish(); done.fail(String.valueOf(error)); }
            @Override public void onLayoutCancelled() { adapter.onFinish(); done.fail("cancelled"); }
        }, null);
    }
}
