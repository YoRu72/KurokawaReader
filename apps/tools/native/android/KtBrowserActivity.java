package app.kurokawa.tools;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The app's browser: a page opened in a web view of the app's own (its cookies are the ones the app's downloads
 * send, so a site's check passed here holds for them), with DNS over HTTPS when it is on (see KtDohWeb). A file
 * the page starts downloading, or a magnet tapped, goes to the app's Add sheet with the page's cookies and
 * address; «Grab» collects what the page links to and the media it loaded (videos a player fetched by script
 * included) and hands them to the app to pick from.
 */
public class KtBrowserActivity extends Activity {
    public static final String EXTRA_URL = "url";
    /** Media the page asked for (a player's video, its playlist), seen as it loads. */
    private final Map<String, String> media = new LinkedHashMap<>();
    private WebView wv; private EditText bar; private ProgressBar prog;
    /** The DoH chip on the bar: grey off, amber while a name is being asked, green once the resolver answered (and
     *  this page's site came through it), red when the last ask failed. Tapped: the status and the last events. */
    private Button doh; private static volatile KtBrowserActivity shown; private String pageHost = "";
    private final java.util.ArrayDeque<String> dohLog = new java.util.ArrayDeque<>();
    static void dohEvent(String json) { KtBrowserActivity a = shown; if (a != null) a.h.post(() -> a.onDoh(json)); }
    private void onDoh(String json) {
        synchronized (dohLog) { dohLog.addLast(json); while (dohLog.size() > 30) dohLog.removeFirst(); }
        paintDoh(); if (dohSheet != null) fillDoh(false);
    }
    private void paintDoh() {
        if (doh == null) return;
        String st = KrDoh.on() ? KrDoh.state : "off"; boolean ar = ar(this);
        int c; String label;
        switch (st) {
            case "resolving": c = cWarn(); label = "DoH …"; break;
            case "ok": c = cGood(); label = "DoH ✓"; break;
            case "failed": c = cError(); label = "DoH ✕"; break;
            case "idle": c = cMuted(); label = "DoH"; break;
            default: c = dark() ? Color.rgb(110, 110, 116) : Color.rgb(160, 160, 166); label = ar ? "DoH ·" : "DoH ·";
        }
        doh.setTextColor(c); doh.setText(label);
        doh.setContentDescription(ar ? "حالة DNS عبر HTTPS" : "DNS over HTTPS status");
    }
    private static String human(long b) { if (b < 1024) return b + " B"; double v = b / 1024.0; String[] u = { "KB", "MB", "GB" }; int i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return String.format(java.util.Locale.US, v >= 100 ? "%.0f %s" : "%.1f %s", v, u[i]); }
    private static String ago(long at) { long s = Math.max(0, (System.currentTimeMillis() - at) / 1000); return s < 60 ? s + "s" : s < 3600 ? (s / 60) + "m" : (s / 3600) + "h"; }
    /* ---------- Material 3 bits: colours, pills, rows ---------- */
    private int cPrimary() { return dark() ? Color.rgb(208, 188, 255) : Color.rgb(103, 80, 164); }
    private int cOnSurface() { return dark() ? Color.rgb(230, 224, 233) : Color.rgb(29, 27, 32); }
    private int cMuted() { return dark() ? Color.rgb(202, 196, 208) : Color.rgb(73, 69, 79); }
    private int cSurface() { return dark() ? Color.rgb(20, 18, 24) : Color.rgb(254, 247, 255); }
    private int cContainer() { return dark() ? Color.rgb(43, 41, 48) : Color.rgb(236, 230, 240); }
    private int cContainerHigh() { return dark() ? Color.rgb(54, 52, 59) : Color.rgb(230, 224, 233); }
    private int cTonal() { return dark() ? Color.rgb(74, 68, 88) : Color.rgb(232, 222, 248); }
    private int cError() { return dark() ? Color.rgb(242, 184, 181) : Color.rgb(179, 38, 30); }
    private int cGood() { return dark() ? Color.rgb(129, 199, 132) : Color.rgb(46, 125, 50); }
    private int cWarn() { return dark() ? Color.rgb(255, 196, 92) : Color.rgb(176, 108, 0); }
    private android.graphics.drawable.GradientDrawable pill(int color, float radiusDp) { android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable(); g.setColor(color); g.setCornerRadius(dp(radiusDp)); return g; }
    private View dot(int color) { View v = new View(this); v.setBackground(pill(color, 6)); LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(10), dp(10)); lp.setMarginEnd(dp(10)); lp.gravity = Gravity.CENTER_VERTICAL; v.setLayoutParams(lp); return v; }
    private TextView text(String s, float sp, int color, boolean bold) { TextView t = new TextView(this); t.setText(s); t.setTextSize(sp); t.setTextColor(color); if (bold) t.setTypeface(Typeface.DEFAULT_BOLD); return t; }
    /** A row of a sheet: a coloured dot, a name, a detail in lighter type. */
    private LinearLayout row(int color, String name, String detail) {
        LinearLayout r = new LinearLayout(this); r.setOrientation(LinearLayout.HORIZONTAL); r.setGravity(Gravity.CENTER_VERTICAL); r.setPadding(dp(14), dp(10), dp(14), dp(10));
        r.addView(dot(color)); TextView n = text(name, 15, cOnSurface(), false); n.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)); r.addView(n);
        if (detail != null && !detail.isEmpty()) { TextView d = text(detail, 13, cMuted(), false); d.setTextDirection(View.TEXT_DIRECTION_LTR); d.setMaxLines(2); d.setEllipsize(android.text.TextUtils.TruncateAt.END); d.setMaxWidth(dp(190)); r.addView(d); }
        return r;
    }
    private Button chip(String label, boolean filled, View.OnClickListener on) {
        Button b = new Button(this, null, android.R.attr.borderlessButtonStyle); b.setText(label); b.setAllCaps(false); b.setTextSize(14); b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setBackground(pill(filled ? cPrimary() : cTonal(), 20)); b.setTextColor(filled ? (dark() ? Color.rgb(56, 30, 114) : Color.WHITE) : cOnSurface()); b.setPadding(dp(18), 0, dp(18), 0); b.setMinHeight(dp(40)); b.setMinimumHeight(dp(40)); b.setOnClickListener(on);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(40)); lp.setMarginEnd(dp(8)); b.setLayoutParams(lp); return b;
    }

    /** The DoH sheet: the state with its light, the page, the app's proxy, each resolver with how it last fared (the
     *  rows refilled live while a test runs), the last events — and Test, Turn on/off, Close. */
    private android.app.Dialog dohSheet; private LinearLayout dohRows;
    private void dohDialog() {
        boolean ar = ar(this);
        android.widget.ScrollView sv = new android.widget.ScrollView(this); sv.setBackground(pill(cSurface(), 28));
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(16), dp(10), dp(16), dp(12)); sv.addView(box);
        View handle = new View(this); handle.setBackground(pill(cContainerHigh(), 2)); LinearLayout.LayoutParams hl = new LinearLayout.LayoutParams(dp(32), dp(4)); hl.gravity = Gravity.CENTER_HORIZONTAL; hl.bottomMargin = dp(10); box.addView(handle, hl);
        TextView title = text("DNS over HTTPS", 20, cOnSurface(), true); box.addView(title);
        dohRows = new LinearLayout(this); dohRows.setOrientation(LinearLayout.VERTICAL); box.addView(dohRows);
        LinearLayout actions = new LinearLayout(this); actions.setOrientation(LinearLayout.HORIZONTAL); actions.setGravity(Gravity.END); actions.setPadding(0, dp(12), 0, 0);
        actions.addView(chip(KrDoh.on() ? (ar ? "أوقِف" : "Turn off") : (ar ? "شغِّل" : "Turn on"), false, v -> { String np = KrDoh.on() ? "off" : "auto"; KrDoh.provider = np; KrDoh.forget(); getSharedPreferences("kt", MODE_PRIVATE).edit().putString("doh", np).apply(); new Thread(KtPlugin::applyDohProxy, "kt-doh-apply").start(); paintDoh(); say(KrDoh.on() ? (ar ? "DoH مُفعَّل — يُختار أسرع مزوِّد يجيب" : "DoH on — the fastest resolver that answers is used") : (ar ? "DoH معطَّل" : "DoH off")); h.postDelayed(() -> { if (wv != null) wv.reload(); }, 900); if (dohSheet != null) dohSheet.dismiss(); }));
        actions.addView(chip(ar ? "اختبار" : "Test", true, v -> { fillDoh(true); new Thread(() -> { KrDoh.probe(); h.post(() -> { paintDoh(); fillDoh(false); }); }, "kt-doh-probe").start(); }));
        actions.addView(chip(ar ? "إغلاق" : "Close", false, v -> { if (dohSheet != null) dohSheet.dismiss(); }));
        box.addView(actions);
        fillDoh(false);
        android.app.Dialog d = new android.app.Dialog(this); d.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE); d.setContentView(sv);
        android.view.Window w = d.getWindow(); if (w != null) { w.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT)); w.setGravity(Gravity.BOTTOM); w.setLayout(android.view.WindowManager.LayoutParams.MATCH_PARENT, android.view.WindowManager.LayoutParams.WRAP_CONTENT); w.setDimAmount(0.45f); }
        d.setOnDismissListener((x) -> { dohSheet = null; dohRows = null; }); dohSheet = d; d.show();
    }
    private void fillDoh(boolean testing) {
        if (dohRows == null) return; boolean ar = ar(this); org.json.JSONObject st = KrDoh.status(); dohRows.removeAllViews();
        String state = st.optString("state", "off"); String prov = st.optString("provider", "off");
        int light = testing ? cWarn() : state.equals("ok") ? cGood() : state.equals("failed") ? cError() : state.equals("resolving") ? cWarn() : cMuted();
        String stateText = testing ? (ar ? "يختبر المزوِّدين…" : "Testing the resolvers…") : !KrDoh.on() ? (ar ? "معطَّل" : "Off") : state.equals("ok") ? (ar ? "يعمل" : "Working") + (st.optString("lastResolver").isEmpty() ? "" : " · " + st.optString("lastResolver") + (st.optString("lastShape").isEmpty() ? "" : " · " + st.optString("lastShape")) + (st.optLong("lastMs", -1) >= 0 ? " · " + st.optLong("lastMs") + " ms" : "")) : state.equals("failed") ? (ar ? "أخفق: " : "Failed: ") + st.optString("lastError") : state.equals("resolving") ? (ar ? "يستعلم…" : "Resolving…") : (ar ? "جاهز، لم يُسأل بعد" : "Ready, nothing asked yet");
        LinearLayout head = row(light, stateText, "off".equals(prov) ? "" : "auto".equals(prov) ? (ar ? "تلقائي" : "auto") : prov); head.setBackground(pill(cContainer(), 16)); LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT); hp.topMargin = dp(10); dohRows.addView(head, hp);
        if (!KrDoh.on()) { dohRows.addView(text(ar ? "تُسأل الأسماء عبر مزوِّدٍ مشفَّر، وتمرّ اتصالات هذا المتصفّح كلُّها بوكيل التطبيق، فتُفتح المواقع التي تحجبها الشبكة بالاسم." : "Names are asked of an encrypted resolver and every connection of this browser goes through the app's own proxy, so sites the network hides by name open all the same.", 13, cMuted(), false)); return; }
        // the page, the proxy
        if (!pageHost.isEmpty()) { boolean forced = KrDoh.isForced(pageHost); Boolean need = KrDoh.neededCached(pageHost); dohRows.addView(row(forced || Boolean.TRUE.equals(need) ? cGood() : Boolean.FALSE.equals(need) ? cMuted() : cWarn(), pageHost, forced ? (ar ? "عبر DoH — أُجبر" : "through DoH — forced") : Boolean.TRUE.equals(need) ? (ar ? "عبر DoH — الشبكة تحجبه" : "through DoH — hidden by the network") : Boolean.FALSE.equals(need) ? (ar ? "مباشرةً" : "direct") : (ar ? "لم يُفحَص بعد" : "not checked yet"))); }
        org.json.JSONObject px = KrDohProxy.status();
        dohRows.addView(row(px.optBoolean("running") ? cGood() : cError(), ar ? "وكيل التطبيق" : "App proxy", px.optBoolean("running") ? "127.0.0.1:" + px.optInt("port") + " · " + px.optLong("tunnels") + " · ↑" + human(px.optLong("up")) + " ↓" + human(px.optLong("down")) : (ar ? "لا يعمل" : "not running")));
        dohRows.addView(row(cMuted(), ar ? "تقسيم تحيّة TLS" : "Split TLS hello", st.optString("split", "auto")));
        // the resolvers
        TextView sub = text(ar ? "المزوِّدون" : "Resolvers", 12, cMuted(), true); sub.setPadding(dp(14), dp(10), dp(14), dp(2)); dohRows.addView(sub);
        org.json.JSONArray rs = st.optJSONArray("resolvers");
        if (rs != null) for (int i = 0; i < rs.length(); i++) { org.json.JSONObject r = rs.optJSONObject(i); if (r == null) continue; boolean asked = r.optLong("ms", -1) >= 0 || r.optBoolean("ok"); dohRows.addView(row(testing ? cWarn() : !asked ? cMuted() : r.optBoolean("ok") ? cGood() : cError(), r.optString("id"), testing ? "…" : !asked ? (ar ? "لم يُسأل" : "not asked") : r.optBoolean("ok") ? r.optString("shape") + " · " + r.optLong("ms") + " ms" : r.optString("error"))); }
        // the last events
        org.json.JSONArray log = st.optJSONArray("log");
        if (log != null && log.length() > 0) {
            TextView ev = text(ar ? "آخر الأحداث" : "Recent", 12, cMuted(), true); ev.setPadding(dp(14), dp(10), dp(14), dp(2)); dohRows.addView(ev);
            for (int i = log.length() - 1, n = 0; i >= 0 && n < 8; i--, n++) { org.json.JSONObject e = log.optJSONObject(i); if (e == null) continue; String k = e.optString("kind"); int c = k.equals("fail") ? cError() : k.equals("resolve") || k.equals("unblock") || k.equals("force") ? cGood() : cMuted(); dohRows.addView(row(c, k + (e.optString("host").isEmpty() ? "" : " · " + e.optString("host")), ago(e.optLong("at")) + (e.optString("ip").isEmpty() ? "" : " → " + e.optString("ip")) + (e.optLong("ms", -1) >= 0 ? " " + e.optLong("ms") + "ms" : "") + (e.optString("msg").isEmpty() || e.optString("msg").equals("ok") || e.optString("msg").equals("start") ? "" : " " + e.optString("msg")))); }
        }
    }
    /* The way to a download, kept with it: the pages and what was tapped on each (its words, its link, its kind), so
       a link that runs out (signed links: itch.io, cloud storage) can be got again by going the same way. */
    private final java.util.List<JSONObject> trail = new java.util.ArrayList<>();
    /** Replaying a way: the download it is for, the steps; told back as «relink». */
    private String startUrl; private int replayAt = 0; private String replayId; private JSONArray replay; private final android.os.Handler h = new android.os.Handler(android.os.Looper.getMainLooper());
    static final String TRAIL_JS = "(function(){if(window.__ktTrail)return;window.__ktTrail=1;document.addEventListener('click',function(e){var el=e.target&&e.target.closest?e.target.closest('a,button,input[type=submit],input[type=button],[role=button],[onclick]'):null;if(!el)return;var t=(el.innerText||el.value||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim().slice(0,80);var same=[].slice.call(document.querySelectorAll(el.tagName)).filter(function(x){return (x.innerText||x.value||x.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim().slice(0,80)===t;});try{KtTrail.step(JSON.stringify({url:location.href,text:t,tag:el.tagName.toLowerCase(),href:el.getAttribute('href')||'',id:el.id||'',cls:(el.className&&el.className.baseVal===undefined?el.className:'').slice(0,80),n:same.indexOf(el)}));}catch(x){}},true);})();";
    /** A replay's step on this page: the element found (by its id, its link, its words and kind, its place among
     *  the same) and tapped; tried for a few seconds while the page fills in. */
    static String replayJs(JSONArray steps, int after) {
        return "(function(S,A){if(window.__ktBusy)return 'busy';if(window.__ktDone>A)A=window.__ktDone;var path=function(u){try{var x=new URL(u,location.href);return x.host+x.pathname;}catch(e){return u;}};var here=path(location.href);var norm=function(s){return (s||'').replace(/\\s+/g,' ').trim().slice(0,80);};"
            + "var host=function(u){try{return new URL(u,location.href).host;}catch(e){return '';}};var C=[],i;for(i=A+1;i<S.length;i++)if(!S[i].start&&path(S[i].url)===here)C.push(i);"
            // (A page whose address changes every visit — a download page with its own key —: the steps on the same site next. Then any later
            // step at all: the start page redirected elsewhere — example.com to www.example.com —, or a page that was not recorded — a
            // page still loading its ads when it was tapped —: its button looked for here anyway.)
            + "for(i=A+1;i<S.length;i++)if(!S[i].start&&C.indexOf(i)<0&&host(S[i].url)===location.host)C.push(i);for(i=A+1;i<S.length;i++)if(!S[i].start&&C.indexOf(i)<0)C.push(i);if(!C.length)return 'nostep';var idx=C[0],tries=0;window.__ktBusy=1;"
            + "var find1=function(st){var el=null;if(st.id)el=document.getElementById(st.id);"
            + "if(!el&&st.href&&!/^javascript:|^#$/.test(st.href)){var hp=path(st.href);el=[].slice.call(document.querySelectorAll('a[href]')).filter(function(a){return path(a.getAttribute('href'))===hp;})[0]||null;}"
            + "if(!el&&st.text){var c=[].slice.call(document.querySelectorAll(st.tag||'*')).filter(function(x){return norm(x.innerText||x.value||x.getAttribute('aria-label'))===st.text;});el=c[Math.min(st.n>0?st.n:0,c.length-1)]||null;}return el;};"
            + "var find=function(){for(var k=0;k<C.length;k++){var el=find1(S[C[k]]);if(el){idx=C[k];return el;}}return null;};"
            + "var go=function(){var el=find();if(el){el.scrollIntoView({block:'center'});setTimeout(function(){window.__ktBusy=0;window.__ktDone=idx;try{KtTrail.replayed(idx);}catch(e){}el.click();},350);return;}if(++tries<16)setTimeout(go,500);else{window.__ktBusy=0;try{KtTrail.missing(idx);}catch(e){}}};setTimeout(go,700);return 'step '+idx;})(" + steps.toString() + "," + after + ")";
    }
    public class Trail {
        @android.webkit.JavascriptInterface public void step(String json) { try { JSONObject o = new JSONObject(json); synchronized (trail) { trail.add(o); while (trail.size() > 30) trail.remove(0); } } catch (Exception ignored) {} }
        @android.webkit.JavascriptInterface public void replayed(int i) { h.post(() -> { replayAt = Math.max(replayAt, i); say((ar(KtBrowserActivity.this) ? "الخطوة " : "Step ") + i); /* (a step that opens something on the same page — a dialog —: the next one looked for there too) */ h.postDelayed(() -> { if (replay != null && wv != null) wv.evaluateJavascript(replayJs(replay, replayAt), null); }, 1600); }); }
        @android.webkit.JavascriptInterface public void missing(int i) { h.post(() -> { say(ar(KtBrowserActivity.this) ? "لم يُعثر على الزرّ نفسه — أكمِل بيدك" : "The same button was not found — go on by hand"); }); }
    }
    private void say(String m) { try { Toast.makeText(this, m, Toast.LENGTH_SHORT).show(); } catch (Throwable ignored) {} }

    private int dp(float v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }
    private boolean dark() { return (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES; }
    private Button btn(String label, View.OnClickListener on) {
        Button b = new Button(this, null, android.R.attr.borderlessButtonStyle); b.setText(label); b.setAllCaps(false); b.setTextSize(15); b.setMinWidth(dp(44)); b.setMinimumWidth(dp(44)); b.setPadding(dp(8), 0, dp(8), 0);
        b.setTextColor(cOnSurface()); b.setOnClickListener(on); return b;
    }
    private static boolean ar(Activity a) { return "ar".equals(a.getResources().getConfiguration().getLocales().get(0).getLanguage()); }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        boolean ar = ar(this); adBlock = getSharedPreferences("kt", MODE_PRIVATE).getBoolean("adblock", true);
        int bg = cSurface();
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(bg);
        root.setFitsSystemWindows(true);
        LinearLayout top = new LinearLayout(this); top.setOrientation(LinearLayout.HORIZONTAL); top.setGravity(Gravity.CENTER_VERTICAL); top.setPadding(dp(6), dp(6), dp(6), dp(6));
        // (Material 3: the address in a pill of the surface's container colour, the buttons borderless and round.)
        bar = new EditText(this); bar.setSingleLine(true); bar.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI); bar.setImeOptions(EditorInfo.IME_ACTION_GO); bar.setTextSize(14);
        bar.setBackground(pill(cContainer(), 22)); bar.setPadding(dp(16), dp(9), dp(16), dp(9)); bar.setHintTextColor(cMuted());
        bar.setTextColor(cOnSurface()); bar.setHint(ar ? "عنوان أو بحث" : "Address or search"); bar.setSelectAllOnFocus(true); bar.setTextDirection(View.TEXT_DIRECTION_LTR);
        bar.setOnEditorActionListener((v, id, ev) -> { if (id == EditorInfo.IME_ACTION_GO || (ev != null && ev.getKeyCode() == KeyEvent.KEYCODE_ENTER)) { go(bar.getText().toString()); return true; } return false; });
        top.addView(btn("✕", v -> finish()));
        top.addView(btn("‹", v -> { if (wv.canGoBack()) wv.goBack(); }));
        top.addView(btn("›", v -> { if (wv.canGoForward()) wv.goForward(); }));
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f); bl.setMarginStart(dp(2)); bl.setMarginEnd(dp(2)); top.addView(bar, bl);
        top.addView(btn("↻", v -> wv.reload()));
        doh = btn("DoH", v -> dohDialog()); doh.setTextSize(12); doh.setTypeface(Typeface.DEFAULT_BOLD); top.addView(doh); paintDoh();
        Button grab = btn(ar ? "التقِط" : "Grab", v -> grab()); grab.setTypeface(Typeface.DEFAULT_BOLD); grab.setBackground(pill(cTonal(), 20)); grab.setTextColor(cOnSurface()); grab.setPadding(dp(14), 0, dp(14), 0); top.addView(grab, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(36)));
        top.addView(btn("⋮", v -> menu()));
        root.addView(top, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        prog = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); prog.setMax(100); prog.setIndeterminate(false);
        prog.setProgressTintList(android.content.res.ColorStateList.valueOf(cPrimary())); prog.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.TRANSPARENT));
        root.addView(prog, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(3)));
        wv = new WebView(this); wv.addJavascriptInterface(new Trail(), "KtTrail");
        root.addView(wv, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setLoadWithOverviewMode(true); s.setUseWideViewPort(true); s.setBuiltInZoomControls(true); s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true); s.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);
        // (A link held: opened, copied, or sent to the app as a download — a downloader's browser.)
        wv.setOnLongClickListener(v -> { WebView.HitTestResult hit = wv.getHitTestResult(); int ty = hit.getType(); if (ty != WebView.HitTestResult.SRC_ANCHOR_TYPE && ty != WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE && ty != WebView.HitTestResult.IMAGE_TYPE) return false; String link = hit.getExtra(); if (link == null || link.isEmpty()) return false; linkMenu(link, ty == WebView.HitTestResult.IMAGE_TYPE); return true; });
        wv.setWebChromeClient(new WebChromeClient() {
            private View full; private CustomViewCallback fullCb;
            @Override public void onShowCustomView(View view, CustomViewCallback cb) { if (full != null) { cb.onCustomViewHidden(); return; } full = view; fullCb = cb; ((android.view.ViewGroup) getWindow().getDecorView()).addView(full, new android.view.ViewGroup.LayoutParams(-1, -1)); getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY); setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR); }
            @Override public void onHideCustomView() { if (full == null) return; ((android.view.ViewGroup) getWindow().getDecorView()).removeView(full); full = null; getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE); setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED); if (fullCb != null) fullCb.onCustomViewHidden(); fullCb = null; }
            @Override public void onProgressChanged(WebView v, int p) { prog.setProgress(p); prog.setVisibility(p >= 100 ? View.INVISIBLE : View.VISIBLE);
            // (A page that never finishes loading — ads, trackers —: recorded, and its step replayed, once it is mostly there.)
            if (p >= 40) v.evaluateJavascript(TRAIL_JS, null); if (p >= 80 && replay != null) v.evaluateJavascript(replayJs(replay, replayAt), null); } });
        wv.setWebViewClient(new KtDohWeb() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                if (u.startsWith("magnet:")) { hand(u, null, null); return true; }
                if (!u.startsWith("http:") && !u.startsWith("https:")) return true;   // (other apps' links stay out)
                return false;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                // (Ads and trackers, and the pop-under scripts that come with download sites: answered with nothing.)
                if (adBlock && !r.isForMainFrame() && isAd(r.getUrl().getHost(), u)) { blocked++; return new WebResourceResponse("text/plain", "utf-8", 204, "No Content", java.util.Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0])); }
                String kind = mediaKind(u, r.getRequestHeaders());
                if (kind != null) synchronized (media) { if (media.size() < 400 && !media.containsKey(u)) media.put(u, kind); }
                return super.shouldInterceptRequest(v, r);
            }
            // (A page the network's own way could not reach — reset, timed out, the handshake refused, the name unknown —
            // while DoH is on: its site forced through the resolver, with the hello split, and the page asked again, once.)
            @Override public void onReceivedError(WebView v, WebResourceRequest r, android.webkit.WebResourceError e) {
                if (!r.isForMainFrame() || !KrDoh.on()) return;
                int code = e.getErrorCode(); String host = r.getUrl().getHost(); if (host == null) return;
                // (The web view could not reach the app's own proxy: it is let go of, and the page loaded the old way.)
                if (String.valueOf(e.getDescription()).contains("PROXY") && KrDohProxy.running()) { KtPlugin.dropProxy(String.valueOf(e.getDescription())); say(ar(KtBrowserActivity.this) ? "تعذّر الوصول إلى وكيل التطبيق — يُحمَّل بالطريقة القديمة" : "The app's proxy could not be reached — loading the old way"); h.postDelayed(() -> { if (wv != null) wv.loadUrl(r.getUrl().toString()); }, 300); return; }
                boolean netFail = code == ERROR_CONNECT || code == ERROR_TIMEOUT || code == ERROR_FAILED_SSL_HANDSHAKE || code == ERROR_HOST_LOOKUP || code == ERROR_IO || code == ERROR_UNKNOWN;
                if (!netFail || KrDoh.isForced(host)) return;
                KrDoh.force(host); paintDoh(); say(ar(KtBrowserActivity.this) ? "تعذّر الوصول مباشرةً — يُعاد عبر DoH" : "Unreachable directly — retrying through DoH");
                h.postDelayed(() -> { if (wv != null) wv.loadUrl(r.getUrl().toString()); }, 300);
            }
            // (A certificate that is not the site's on a site the network gives as it is: a filter's page in its place.
            // The site forced through the resolver and the split hello; the page asked again.)
            @Override public void onReceivedSslError(WebView v, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
                String host = null; try { host = android.net.Uri.parse(error.getUrl()).getHost(); } catch (Exception ignored) {}
                if (KrDoh.on() && host != null && !KrDoh.isForced(host)) { handler.cancel(); KrDoh.force(host); paintDoh(); say(ar(KtBrowserActivity.this) ? "شهادة غير شهادة الموقع — يُعاد عبر DoH" : "Not the site's certificate — retrying through DoH"); final String back = error.getUrl(); h.postDelayed(() -> { if (wv != null) wv.loadUrl(back); }, 300); return; }
                handler.cancel();
            }
            @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap icon) { if (!bar.hasFocus()) bar.setText(u); try { pageHost = android.net.Uri.parse(u).getHost(); if (pageHost == null) pageHost = ""; } catch (Exception e) { pageHost = ""; } paintDoh(); }
            // (Taps recorded as soon as the page shows, not only once it has finished loading: a page still loading its ads
            // was tapped through unrecorded, and its replay stopped on the first page.)
            @Override public void onPageCommitVisible(WebView v, String u) { v.evaluateJavascript(TRAIL_JS, null); }
            @Override public void onPageFinished(WebView v, String u) { if (!bar.hasFocus()) bar.setText(u); CookieManager.getInstance().flush(); v.evaluateJavascript(TRAIL_JS, null); if (replay != null) v.evaluateJavascript(replayJs(replay, replayAt), (r) -> { if ("\"nostep\"".equals(r)) say(ar(KtBrowserActivity.this) ? "لا خطوةَ تالية في هذه الصفحة — أكمِل بيدك" : "No next step on this page — go on by hand"); }); }
        });
        // A file the page downloads: to the app, with the page's cookies and address (the site expects them).
        wv.setDownloadListener((url, ua, cd, mime, len) -> hand(url, URLUtil.guessFileName(url, cd, mime), wv.getUrl()));
        String start = getIntent().getStringExtra(EXTRA_URL);
        // (A way to replay: its first page opened, each step tapped as its page comes; given up after two minutes.)
        try { String r = getIntent().getStringExtra("replay"); if (r != null) { JSONObject o = new JSONObject(r); replayId = o.optString("id"); replay = o.getJSONArray("trail"); if (replay.length() > 0) start = replay.getJSONObject(0).optString("url", start); say(ar ? "يُجلَب رابطٌ جديد بالطريق نفسه…" : "Getting a new link the same way…"); h.postDelayed(() -> { if (replay != null) { say(ar ? "لم يُجلَب رابطٌ جديد" : "No new link was got"); replayEvent(null); finish(); } }, 120000); } } catch (Exception ignored) { replay = null; }
        go(start == null || start.isEmpty() ? "https://duckduckgo.com/" : start);
    }

    private void go(String text) {
        String t = text == null ? "" : text.trim(); if (t.isEmpty()) return;
        String u = t.matches("(?i)^(https?|magnet):.*") ? t : t.matches("^[\\w.-]+\\.[a-z]{2,}(/.*)?$") ? "https://" + t : "https://duckduckgo.com/?q=" + android.net.Uri.encode(t);
        if (u.startsWith("magnet:")) { hand(u, null, null); return; }
        synchronized (trail) { trail.clear(); } startUrl = u;
        bar.clearFocus(); try { ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(bar.getWindowToken(), 0); } catch (Exception ignored) {}
        wv.loadUrl(u);
    }

    private static final java.util.regex.Pattern FILE_EXT = java.util.regex.Pattern.compile("(?i)^https?://[^#?]*\\.(m3u8|mpd|mp4|mkv|webm|m4v|mov|mp3|m4a|flac|ogg|opus|zip|7z|rar|apk|pdf|epub)(\\?.*)?$");
    private static final java.util.regex.Pattern AUDIO_EXT = java.util.regex.Pattern.compile("(?i)^https?://[^#?]*\\.(mp3|m4a|flac|ogg|opus|aac|wav)(\\?.*)?$");
    private static final java.util.regex.Pattern MANIFEST = java.util.regex.Pattern.compile("(?i)(\\.m3u8|\\.mpd|/manifest(\\.|/|\\?|$)|[?&](mime|type|format)=(video|audio|m3u8|hls|dash)|/videoplayback\\?|/hls/[^?]*master|/playlist\\.m3u)");
    private static final java.util.regex.Pattern SEGMENT = java.util.regex.Pattern.compile("(?i)(\\.(ts|m4s|aac|vtt|webvtt|key)(\\?|$)|[/_-](seg|segment|chunk|frag|fragment|init)[-_]?\\d*\\.(m4s|mp4|m4v|m4a|ts)(\\?|$)|[?&]range=\\d)");
    /** Whether a request is a medium (and which: «video», «music», or «» for a file): a file by its extension, a
     *  player's playlist or manifest by its address, or what a <video> or <audio> element asks for — the browser
     *  asks for those in ranges («Range: bytes=…»), which images and pages never are. The pieces of a stream
     *  (segments) are left out: its playlist stands for them. */
    static String mediaKind(String u, Map<String, String> headers) {
        if (!u.startsWith("http")) return null;
        if (SEGMENT.matcher(u).find() && !MANIFEST.matcher(u).find()) return null;
        if (AUDIO_EXT.matcher(u).matches()) return "music";
        if (FILE_EXT.matcher(u).matches()) return u.matches("(?i)^[^?#]*\\.(zip|7z|rar|apk|pdf|epub)(\\?.*)?$") ? "" : "video";
        if (MANIFEST.matcher(u).find()) return "video";
        String range = null, accept = null, dest = null;
        if (headers != null) for (Map.Entry<String, String> e : headers.entrySet()) { String k = e.getKey() == null ? "" : e.getKey().toLowerCase(java.util.Locale.ROOT); if (k.equals("range")) range = e.getValue(); else if (k.equals("accept")) accept = e.getValue(); else if (k.equals("sec-fetch-dest")) dest = e.getValue(); }
        if ("video".equals(dest)) return "video"; if ("audio".equals(dest)) return "music";
        if (accept != null && accept.matches("(?i).*\\b(video|audio)/.*")) return accept.toLowerCase(java.util.Locale.ROOT).contains("video") ? "video" : "music";
        if (range != null && range.startsWith("bytes=") && !u.matches("(?i)^[^?#]*\\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|json|woff2?|ttf|html?)(\\?.*)?$")) return "video";
        return null;
    }

    /** One link to the app's Add sheet (the browser closes; the page is there to come back to). */
    private void hand(String url, String name, String referer) {
        try {
            if (replay != null && !url.startsWith("magnet:")) { JSONObject o = new JSONObject(); o.put("url", url); if (referer != null) o.put("referer", referer); o.put("ua", wv.getSettings().getUserAgentString()); replayEvent(o); replay = null; finish(); return; }
            JSONObject o = new JSONObject(); o.put("kind", "download"); o.put("url", url); if (name != null) o.put("name", name); if (referer != null) o.put("referer", referer);
            o.put("ua", wv.getSettings().getUserAgentString());
            // (The steps since an address was last typed: the way from that page to this file, on any site and across
            // sites — a page, its download page, a mirror —, not the searches before it.)
            JSONArray tr = new JSONArray(); synchronized (trail) { for (JSONObject st : trail) tr.put(st); } if (tr.length() > 0) { JSONObject first = new JSONObject(); first.put("url", startUrl == null ? tr.getJSONObject(0).optString("url") : startUrl); first.put("start", true); JSONArray all = new JSONArray(); all.put(first); for (int k = 0; k < tr.length(); k++) all.put(tr.get(k)); o.put("trail", all); }
            KtPlugin.browserEvent(o);
            Toast.makeText(this, ar(this) ? "أُرسل إلى التطبيق" : "Sent to the app", Toast.LENGTH_SHORT).show();
            finish();
        } catch (Exception ignored) {}
    }

    /** A replay's end told to the app: the new link (null: none found). */
    private void replayEvent(JSONObject got) { try { JSONObject o = got != null ? got : new JSONObject(); o.put("kind", "relink"); o.put("id", replayId == null ? "" : replayId); o.put("ok", got != null); KtPlugin.browserEvent(o); } catch (Exception ignored) {} }

    /** The page's own reading of what it offers (native/grab.js, put here by native/embed-grab.mjs). */
    static final String GRAB_JS = "(function () {\nvar o = [], s = {};\nfunction add(u, t, k) {\nif (!u || typeof u !== 'string') return;\ntry { u = new URL(u.replace(/\\\\\\//g, '/').replace(/\\\\u0026/gi, '&').replace(/&amp;/g, '&'), location.href).href; } catch (x) { return; }\nif (s[u] || !/^(https?:|magnet:)/i.test(u)) return;\ns[u] = 1; o.push({ href: u, text: (t || '').trim().slice(0, 200), kind: k || '' });\n}\nvar media = /\\.(m3u8|mpd|mp4|mkv|webm|m4v|mov)(\\?|#|$)/i, audio = /\\.(mp3|m4a|flac|ogg|opus|aac|wav)(\\?|#|$)/i;\nvar title = document.title;\ndocument.querySelectorAll('video, audio').forEach(function (v) {\nvar k = v.tagName === 'AUDIO' ? 'music' : 'video', name = v.getAttribute('title') || v.getAttribute('aria-label') || title;\nif (v.currentSrc && !/^blob:/.test(v.currentSrc)) add(v.currentSrc, name, k);\nif (v.src && !/^blob:/.test(v.src)) add(v.src, name, k);\nv.querySelectorAll('source[src]').forEach(function (x) { add(x.src, name, k); });\n});\ndocument.querySelectorAll('a[href]').forEach(function (a) { add(a.href, a.textContent || a.title || a.getAttribute('download'), media.test(a.href) ? 'video' : audio.test(a.href) ? 'music' : 'a'); });\ndocument.querySelectorAll('source[src], img[src], iframe[src], track[src], embed[src], object[data]').forEach(function (e) { add(e.currentSrc || e.src || e.data, e.alt || e.title || '', e.tagName.toLowerCase()); });\ndocument.querySelectorAll('[data-src], [data-href], [data-url], [data-file], [data-video], [data-video-src], [data-hls], [data-mp4]').forEach(function (e) {\nvar d = e.dataset, u = d.video || d.videoSrc || d.hls || d.mp4 || d.src || d.href || d.url || d.file;\nadd(u, e.textContent || e.title, d.video || d.videoSrc || d.hls || d.mp4 || media.test(u || '') ? 'video' : 'data');\n});\ndocument.querySelectorAll('meta[property^=\"og:video\"], meta[name^=\"og:video\"], meta[property=\"og:audio\"], meta[name=\"twitter:player:stream\"], meta[itemprop=\"contentUrl\"], link[rel=\"video_src\"]').forEach(function (m) {\nvar u = m.getAttribute('content') || m.getAttribute('href') || '', p = (m.getAttribute('property') || m.getAttribute('name') || '');\nif (/:(type|width|height|duration|tag|release_date)$/.test(p) || !/^(https?:)?\\/\\//i.test(u)) return;\nadd(u, title, /audio/.test(p) ? 'music' : 'video');\n});\ndocument.querySelectorAll('script[type=\"application/ld+json\"]').forEach(function (sc) {\n(sc.textContent.match(/\"(contentUrl|embedUrl)\"\\s*:\\s*\"[^\"]+\"/g) || []).forEach(function (m) { add(m.replace(/^[^:]*:\\s*\"/, '').replace(/\"$/, ''), title, 'video'); });\n});\ntry {\nvar html = document.documentElement.innerHTML;\n(html.match(/https?:(?:\\\\?\\/){2}[^\"'\\s<>()\\\\]+(?:\\\\\\/[^\"'\\s<>()\\\\]+)*?\\.(?:m3u8|mpd|mp4|webm|mkv|m4v|mov|mp3|m4a|flac)(?:\\?[^\"'\\s<>()]*)?/gi) || []).slice(0, 300).forEach(function (u) { add(u, '', audio.test(u) ? 'music' : 'video'); });\n} catch (x) {}\ntry {\nperformance.getEntriesByType('resource').forEach(function (r) {\nif (media.test(r.name) || r.initiatorType === 'video' || /\\.m3u8|\\.mpd|\\/manifest|videoplayback/i.test(r.name)) { if (!/\\.(ts|m4s)(\\?|$)/i.test(r.name)) add(r.name, '', 'video'); }\nelse if (audio.test(r.name) || r.initiatorType === 'audio') add(r.name, '', 'music');\nelse if (/\\.(zip|7z|rar|apk|pdf|epub)(\\?|$)/i.test(r.name)) add(r.name, '', 'media');\n});\n} catch (x) {}\nreturn { url: location.href, title: title, links: o.slice(0, 3000) };\n})()";
    /** What the page links to and shows (after its scripts ran), and the media it loaded: to the app to pick from. */
    private void grab() {
        String js = "JSON.stringify(" + GRAB_JS + ")";
        wv.evaluateJavascript(js, (res) -> {
            try {
                JSONObject page = new JSONObject(new JSONArray("[" + res + "]").getString(0));
                JSONArray links = page.getJSONArray("links");
                synchronized (media) { for (Map.Entry<String, String> e : media.entrySet()) { JSONObject l = new JSONObject(); l.put("href", e.getKey()); l.put("text", ""); l.put("kind", e.getValue() == null || e.getValue().isEmpty() ? "media" : e.getValue()); links.put(l); } }
                JSONObject o = new JSONObject(); o.put("kind", "links"); o.put("url", page.optString("url")); o.put("title", page.optString("title")); o.put("links", links); o.put("ua", wv.getSettings().getUserAgentString());
                KtPlugin.browserEvent(o);
                finish();
            } catch (Exception e) { Toast.makeText(this, String.valueOf(e.getMessage()), Toast.LENGTH_SHORT).show(); }
        });
    }

    /** The browser's own menu: the page in the system's browser, its link copied or shared, the desktop site, find in page, the site's cookies cleared, DoH. */
    private boolean desktopSite = false; private boolean adBlock = true; private int blocked = 0;
    /** Hosts (and paths) that are ads, trackers or pop-under scripts — the usual on download sites. */
    private static final java.util.regex.Pattern AD_HOST = java.util.regex.Pattern.compile("(?i)(^|\\.)(doubleclick\\.net|googlesyndication\\.com|googleadservices\\.com|adservice\\.google\\.com|google-analytics\\.com|googletagmanager\\.com|googletagservices\\.com|adnxs\\.com|adsrvr\\.org|advertising\\.com|criteo\\.(com|net)|taboola\\.com|outbrain\\.com|popads\\.net|popcash\\.net|propellerads\\.com|propellerclick\\.com|adsterra\\.com|hilltopads\\.(net|com)|exoclick\\.com|exosrv\\.com|juicyads\\.com|trafficjunky\\.(net|com)|adcash\\.com|clickadu\\.com|onclickads\\.net|onclicka\\.com|pushwoosh\\.com|mgid\\.com|revcontent\\.com|zedo\\.com|yieldmanager\\.com|bidvertiser\\.com|adroll\\.com|scorecardresearch\\.com|quantserve\\.com|moatads\\.com|hotjar\\.com|mouseflow\\.com|yandex\\.ru/metrika|mc\\.yandex\\.ru|amazon-adsystem\\.com|media\\.net|adform\\.net|rubiconproject\\.com|pubmatic\\.com|openx\\.net|smartadserver\\.com|casalemedia\\.com|33across\\.com|bttrack\\.com|realsrv\\.com|tsyndicate\\.com|a-ads\\.com|coinzilla\\.(com|io)|cointraffic\\.io|ad-maven\\.com|admaven\\.com|clkmon\\.com|monetag\\.com|richads\\.com|galaksion\\.com|evadav\\.com|pushground\\.com|datadoghq\\.com|sentry\\.io|bugsnag\\.com)$");
    private static final java.util.regex.Pattern AD_PATH = java.util.regex.Pattern.compile("(?i)/(ads?|adv|advert[a-z]*|banners?|popunder|pop-?under|popup|sponsor[a-z]*|tracking|tracker|pixel|beacon)[/._-]|/(ad|ads|adsbygoogle|pagead|gpt|prebid|popunder|pop)\\.js(\\?|$)|[?&](utm_|fbclid=|gclid=)");
    static boolean isAd(String host, String url) { if (host == null) return false; if (AD_HOST.matcher(host).find()) return true; int q = url.indexOf("//"); String path = q >= 0 ? url.substring(url.indexOf('/', q + 2) < 0 ? url.length() : url.indexOf('/', q + 2)) : url; return AD_PATH.matcher(path).find() && !path.matches("(?i).*\\.(mp4|mkv|webm|m3u8|mpd|mp3|m4a|zip|rar|7z|apk|pdf|epub)(\\?.*)?$"); }
    /** A held link's menu: open it here, copy it, or send it to the app to download. */
    private void linkMenu(String link, boolean image) {
        boolean ar = ar(this);
        String[] items = { ar ? "افتح" : "Open", ar ? "نزِّل بالتطبيق" : "Download with the app", ar ? "انسخ الرابط" : "Copy link", ar ? "شارِك" : "Share" };
        new android.app.AlertDialog.Builder(this).setTitle(link.length() > 90 ? link.substring(0, 90) + "…" : link).setItems(items, (d, i) -> {
            switch (i) {
                case 0: wv.loadUrl(link); break;
                case 1: hand(link, image ? URLUtil.guessFileName(link, null, null) : null, wv.getUrl()); break;
                case 2: ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(android.content.ClipData.newPlainText("url", link)); say(ar ? "نُسِخ" : "Copied"); break;
                case 3: { Intent sh = new Intent(Intent.ACTION_SEND); sh.setType("text/plain"); sh.putExtra(Intent.EXTRA_TEXT, link); startActivity(Intent.createChooser(sh, null)); break; }
            }
        }).show();
    }
    private void menu() {
        boolean ar = ar(this);
        String[] items = { ar ? "افتح في متصفّح النظام" : "Open in system browser", ar ? "انسخ الرابط" : "Copy link", ar ? "شارِك الرابط" : "Share link", desktopSite ? (ar ? "موقع الهاتف" : "Mobile site") : (ar ? "موقع الحاسوب" : "Desktop site"), ar ? "ابحث في الصفحة" : "Find in page", ar ? "امسح كعكات هذا الموقع" : "Clear this site's cookies", ar ? "DNS عبر HTTPS…" : "DNS over HTTPS…", (adBlock ? (ar ? "أوقِف حجب الإعلانات" : "Ad blocking off") : (ar ? "شغِّل حجب الإعلانات" : "Ad blocking on")) + (blocked > 0 ? " (" + blocked + ")" : ""), ar ? "الصفحة الرئيسية" : "Home" };
        new android.app.AlertDialog.Builder(this).setItems(items, (d, i) -> {
            String u = wv.getUrl() == null ? "" : wv.getUrl();
            switch (i) {
                case 0: try { startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u))); } catch (Exception e) { say(String.valueOf(e.getMessage())); } break;
                case 1: ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(android.content.ClipData.newPlainText("url", u)); say(ar ? "نُسِخ" : "Copied"); break;
                case 2: { Intent sh = new Intent(Intent.ACTION_SEND); sh.setType("text/plain"); sh.putExtra(Intent.EXTRA_TEXT, u); startActivity(Intent.createChooser(sh, null)); break; }
                case 3: desktopSite = !desktopSite; { WebSettings st = wv.getSettings(); st.setUserAgentString(desktopSite ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" : null); st.setUseWideViewPort(true); st.setLoadWithOverviewMode(true); } wv.reload(); break;
                case 4: { EditText in = new EditText(this); in.setHint(ar ? "كلمة" : "Word"); new android.app.AlertDialog.Builder(this).setTitle(ar ? "ابحث في الصفحة" : "Find in page").setView(in).setPositiveButton(ar ? "ابحث" : "Find", (dd, ww) -> { wv.findAllAsync(in.getText().toString()); wv.setFindListener((active, count, done) -> { if (done) say(count == 0 ? (ar ? "لا شيء" : "Nothing") : (active + 1) + " / " + count); }); }).setNeutralButton(ar ? "التالي" : "Next", (dd, ww) -> wv.findNext(true)).setNegativeButton(ar ? "إغلاق" : "Close", (dd, ww) -> wv.clearMatches()).show(); break; }
                case 5: { String host = pageHost; CookieManager cm = CookieManager.getInstance(); String ck = cm.getCookie(u); if (ck != null) for (String part : ck.split(";")) { String name = part.trim().split("=")[0]; cm.setCookie(u, name + "=; Max-Age=0; path=/"); cm.setCookie(u, name + "=; Max-Age=0; path=/; domain=" + host); } cm.flush(); say(ar ? "مُسِحت" : "Cleared"); wv.reload(); break; }
                case 6: dohDialog(); break;
                case 7: adBlock = !adBlock; getSharedPreferences("kt", MODE_PRIVATE).edit().putBoolean("adblock", adBlock).apply(); say(adBlock ? (ar ? "حجب الإعلانات مُفعَّل" : "Ad blocking on") : (ar ? "حجب الإعلانات معطَّل" : "Ad blocking off")); wv.reload(); break;
                case 8: go("https://duckduckgo.com/"); break;
            }
        }).show();
    }
    @Override protected void onResume() { super.onResume(); shown = this; paintDoh(); }
    @Override protected void onPause() { super.onPause(); if (shown == this) shown = null; }
    @Override public void onBackPressed() { if (wv != null && wv.getWebChromeClient() != null && fullShown()) { wv.getWebChromeClient().onHideCustomView(); return; } if (wv != null && wv.canGoBack()) wv.goBack(); else super.onBackPressed(); }
    private boolean fullShown() { android.view.ViewGroup d = (android.view.ViewGroup) getWindow().getDecorView(); return d.getChildCount() > 1; }
    @Override protected void onDestroy() { if (wv != null) { wv.stopLoading(); wv.destroy(); } super.onDestroy(); }
}
