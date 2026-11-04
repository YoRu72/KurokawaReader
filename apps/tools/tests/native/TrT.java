// The screen translator's translators against a local server: Google (one request a line, the pieces of a long
// line joined), DeepL (one request, Free/Pro codes), the three AI styles (OpenAI, Anthropic, Gemini: the lines as
// a JSON array, a bad answer asked again in halves), the cache (nothing asked twice), lines with no letters left
// as they are, a busy server (429) waited for, and the JSON reader/writer on awkward text. Run by screen.sh.
import com.sun.net.httpserver.*; import java.io.*; import java.net.*; import java.util.*; import java.util.concurrent.atomic.*;
public class TrT {
  static int fails = 0; static AtomicInteger hits = new AtomicInteger(); static AtomicInteger busy = new AtomicInteger(1); static volatile boolean badOnce = false;
  static void check(String what, boolean ok) { System.out.println((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; }
  static String body(HttpExchange ex) throws IOException { return new String(ex.getRequestBody().readAllBytes(), "UTF-8"); }
  static void send(HttpExchange ex, int code, String s) throws IOException { byte[] b = s.getBytes("UTF-8"); ex.getResponseHeaders().add("Content-Type", "application/json"); ex.sendResponseHeaders(code, b.length); try (OutputStream o = ex.getResponseBody()) { o.write(b); } }
  static String up(String s) { return "«" + s.toUpperCase() + "»"; }
  @SuppressWarnings("unchecked")
  public static void main(String[] a) throws Exception {
    HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 50); s.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
    s.createContext("/translate_a/single", ex -> { hits.incrementAndGet(); Map<String, String> q = new HashMap<>(); for (String kv : ex.getRequestURI().getRawQuery().split("&")) { int i = kv.indexOf('='); q.put(kv.substring(0, i), URLDecoder.decode(kv.substring(i + 1), "UTF-8")); }
      if (q.get("q").equals("busy") && busy.getAndDecrement() > 0) { send(ex, 429, "{}"); return; }
      // (As Google does: each line translated, the newlines kept; the answer in pieces.)
      StringBuilder tb = new StringBuilder(); for (String line : q.get("q").split("\n", -1)) { if (tb.length() > 0) tb.append('\n'); tb.append(up(line)).append('/').append(q.get("tl")); }
      String t = tb.toString(); int h = t.length() / 2; send(ex, 200, "[[[" + KtJson.write(t.substring(0, h)) + ",\"x\"],[" + KtJson.write(t.substring(h)) + ",\"y\"]],null,\"en\"]"); });
    s.createContext("/translate/auth", ex -> { hits.incrementAndGet(); send(ex, 200, "TOKEN1"); });
    s.createContext("/translate", ex -> { hits.incrementAndGet(); if (!"Bearer TOKEN1".equals(ex.getRequestHeaders().getFirst("Authorization"))) { send(ex, 401, "{}"); return; } String to = ex.getRequestURI().getRawQuery().replaceAll(".*to=([^&]+).*", "$1");
      List<Object> out = new ArrayList<>(); for (Object x : (List<Object>) KtJson.parse(body(ex))) out.add(KtJson.map("translations", KtJson.list(KtJson.map("text", "ms:" + up((String) KtJson.obj(x).get("Text")) + "/" + to)))); send(ex, 200, KtJson.write(out)); });
    s.createContext("/v2/translate", ex -> { hits.incrementAndGet(); Map<String, Object> req = (Map<String, Object>) KtJson.parse(body(ex)); String auth = ex.getRequestHeaders().getFirst("Authorization");
      if (!"DeepL-Auth-Key k1:fx".equals(auth)) { send(ex, 403, "{\"message\":\"bad key\"}"); return; }
      List<Object> out = new ArrayList<>(); for (Object x : (List<Object>) req.get("text")) out.add(KtJson.map("text", up((String) x) + "/" + req.get("target_lang"))); send(ex, 200, KtJson.write(KtJson.map("translations", out))); });
    s.createContext("/oa/chat/completions", ex -> { hits.incrementAndGet(); Map<String, Object> req = (Map<String, Object>) KtJson.parse(body(ex)); String user = (String) ((Map<String, Object>) ((List<Object>) req.get("messages")).get(1)).get("content");
      List<Object> in = (List<Object>) KtJson.parse(user); List<Object> out = new ArrayList<>(); for (Object x : in) out.add(up((String) x));
      if (badOnce && in.size() > 1) { badOnce = false; out.remove(0); }   // (one line short: asked again in halves)
      send(ex, 200, KtJson.write(KtJson.map("choices", KtJson.list(KtJson.map("message", KtJson.map("content", "```json\n" + KtJson.write(out) + "\n```")))))); });
    s.createContext("/an/messages", ex -> { hits.incrementAndGet(); Map<String, Object> req = (Map<String, Object>) KtJson.parse(body(ex)); String user = (String) ((Map<String, Object>) ((List<Object>) req.get("messages")).get(0)).get("content");
      List<Object> out = new ArrayList<>(); for (Object x : (List<Object>) KtJson.parse(user)) out.add(up((String) x)); send(ex, 200, KtJson.write(KtJson.map("content", KtJson.list(KtJson.map("type", "text", "text", KtJson.write(out)))))); });
    s.createContext("/ge/models", ex -> { hits.incrementAndGet(); Map<String, Object> req = (Map<String, Object>) KtJson.parse(body(ex)); String user = (String) KtJson.at(req, "contents.0.parts.0.text");
      List<Object> out = new ArrayList<>(); for (Object x : (List<Object>) KtJson.parse(user)) out.add(up((String) x)); send(ex, 200, KtJson.write(KtJson.map("candidates", KtJson.list(KtJson.map("content", KtJson.map("parts", KtJson.list(KtJson.map("text", KtJson.write(out))))))))); });
    s.start(); String base = "http://127.0.0.1:" + s.getAddress().getPort();
    KtTranslate.opener = (u) -> (HttpURLConnection) u.openConnection(Proxy.NO_PROXY);

    // JSON
    Object j = KtJson.parse("{\"a\":[1,2.5,true,null,\"q\\\"\\n\\u0628\"],\"b\":{}}");
    check("JSON read", KtJson.at(j, "a.4").equals("q\"\nب") && ((Number) KtJson.at(j, "a.1")).doubleValue() == 2.5 && KtJson.at(j, "a.3") == null);
    check("JSON written back the same", KtJson.write(KtJson.parse(KtJson.write(j))).equals(KtJson.write(j)));

    // Google
    KtTranslate.Config g = KtTranslate.Config.from(KtJson.map("engine", "google", "target", "ar", "googleBase", base));
    List<String> r = KtTranslate.translate(Arrays.asList("hello world", "", "123 !", "hello world", "good night"), g);
    check("Google: pieces joined, order kept " + r, r.get(0).equals("«HELLO WORLD»/ar") && r.get(4).equals("«GOOD NIGHT»/ar"));
    check("Google: empty and letterless lines left as they are", r.get(1).equals("") && r.get(2).equals("123 !"));
    check("Google: two lines, one request; a line twice asked once (" + hits.get() + ")", hits.get() == 1);
    int before = hits.get(); r = KtTranslate.translate(Arrays.asList("multi\nline", "plain"), g);
    check("Google: a line with a newline of its own asked alone " + r, hits.get() == before + 2 && r.get(1).equals("«PLAIN»/ar"));
    before = hits.get(); KtTranslate.translate(Arrays.asList("hello world", "good night"), g);
    check("cache: a screen read again asks nothing", hits.get() == before);
    check("Google: a busy server waited for", KtTranslate.translate(Arrays.asList("busy"), g).get(0).equals("«BUSY»/ar"));
    check("Google codes", KtTranslate.googleCode("zh").equals("zh-CN") && KtTranslate.googleCode("he").equals("iw") && KtTranslate.googleCode("").equals("auto"));

    // Microsoft, and the keyless engines standing in for each other
    KtTranslate.Config ms = KtTranslate.Config.from(KtJson.map("engine", "microsoft", "target", "ar", "microsoftBase", base, "microsoftAuth", base + "/translate/auth"));
    before = hits.get(); r = KtTranslate.translate(Arrays.asList("red", "blue"), ms);
    check("Microsoft: a token then one request " + r, r.equals(Arrays.asList("ms:«RED»/ar", "ms:«BLUE»/ar")) && hits.get() == before + 2);
    KtTranslate.Config gBroken = KtTranslate.Config.from(KtJson.map("engine", "google", "target", "fr", "googleBase", base + "/nowhere", "microsoftBase", base, "microsoftAuth", base + "/translate/auth"));
    r = KtTranslate.translate(Arrays.asList("green"), gBroken);
    check("Google refusing: Microsoft stands in " + r, r.get(0).equals("ms:«GREEN»/fr"));

    // DeepL
    KtTranslate.Config d = KtTranslate.Config.from(KtJson.map("engine", "deepl", "target", "en", "deeplKey", "k1:fx", "deeplBase", base));
    before = hits.get(); r = KtTranslate.translate(Arrays.asList("eins", "zwei", "drei"), d);
    check("DeepL: three lines, one request " + r, r.equals(Arrays.asList("«EINS»/EN-US", "«ZWEI»/EN-US", "«DREI»/EN-US")) && hits.get() == before + 1);
    try { KtTranslate.translate(Arrays.asList("x y"), KtTranslate.Config.from(KtJson.map("engine", "deepl", "deeplKey", "wrong", "deeplBase", base))); check("DeepL: a wrong key said", false); } catch (Exception e) { check("DeepL: a wrong key said (" + e.getMessage() + ")", e.getMessage().contains("403")); }
    check("DeepL codes", KtTranslate.deeplCode("zh", true).equals("ZH-HANS") && KtTranslate.deeplCode("pt", true).equals("PT-BR") && KtTranslate.deeplCode("ar", true).equals("AR") && KtTranslate.deeplCode("en-GB", false).equals("EN"));

    // AI, three styles
    for (String[] st : new String[][] { { "openai", "/oa" }, { "anthropic", "/an" }, { "gemini", "/ge" } }) {
      KtTranslate.Config c = KtTranslate.Config.from(KtJson.map("engine", "ai", "target", "ar", "ai", KtJson.map("style", st[0], "base", base + st[1], "key", "K", "model", "m-" + st[0])));
      r = KtTranslate.translate(Arrays.asList("one", "two \"quoted\"", "three\nlines"), c);
      check("AI " + st[0] + ": " + r, r.equals(Arrays.asList("«ONE»", "«TWO \"QUOTED\"»", "«THREE\nLINES»")));
    }
    badOnce = true; KtTranslate.forget();
    KtTranslate.Config c = KtTranslate.Config.from(KtJson.map("engine", "ai", "ai", KtJson.map("style", "openai", "base", base + "/oa")));
    r = KtTranslate.translate(Arrays.asList("a1", "b2", "c3", "d4"), c);
    check("AI: an answer a line short asked again in halves " + r, r.equals(Arrays.asList("«A1»", "«B2»", "«C3»", "«D4»")));
    check("AI: a single line answered in plain text kept", KtTranslate.parseArray("مرحبا", 1).get(0).equals("مرحبا"));
    s.stop(0); System.exit(fails == 0 ? 0 : 1);
  }
}
