package app.kurokawa.tools;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * The screen translator's translators, in plain Java (tested off Android: tests/native/screen.sh): Google
 * Translate (no key), DeepL (the user's key, Free or Pro), and an AI model the way the Reader speaks to one —
 * OpenAI-style (OpenAI, OpenRouter, local servers, most custom APIs), Anthropic or Gemini — with the user's
 * own instructions. What was translated is remembered (a screen read again costs nothing), and many lines go
 * in one request where the service allows it.
 */
final class KtTranslate {
    interface Opener { HttpURLConnection open(URL u) throws IOException; }
    static volatile Opener opener = (u) -> (HttpURLConnection) u.openConnection();

    /** What to translate with. */
    static final class Config {
        String engine = "google";          // google | deepl | ai
        String source = "auto", target = "ar";
        String deeplKey = "";
        String style = "openai", base = "", key = "", model = "", prompt = ""; Map<String, String> headers = new LinkedHashMap<>();
        // (Addresses, changed only by the tests.)
        String googleBase = "https://translate.googleapis.com", deeplBase = "";
        int timeoutMs = 30000;
        String id() { return engine + "|" + source + "|" + target + "|" + (engine.equals("ai") ? style + base + model + prompt.hashCode() : ""); }

        static Config from(Map<String, Object> o) {
            Config c = new Config(); if (o == null) return c;
            c.engine = KtJson.str(o.get("engine"), c.engine); c.source = KtJson.str(o.get("source"), c.source); c.target = KtJson.str(o.get("target"), c.target);
            c.deeplKey = KtJson.str(o.get("deeplKey"), ""); Map<String, Object> ai = KtJson.obj(o.get("ai"));
            c.style = KtJson.str(ai.get("style"), "openai"); c.base = KtJson.str(ai.get("base"), "").replaceAll("/+$", ""); c.key = KtJson.str(ai.get("key"), ""); c.model = KtJson.str(ai.get("model"), ""); c.prompt = KtJson.str(ai.get("prompt"), "");
            for (Map.Entry<String, Object> e : KtJson.obj(ai.get("headers")).entrySet()) c.headers.put(e.getKey(), String.valueOf(e.getValue()));
            if (o.get("googleBase") instanceof String) c.googleBase = (String) o.get("googleBase"); if (o.get("deeplBase") instanceof String) c.deeplBase = (String) o.get("deeplBase");
            return c;
        }
    }

    private static final int CACHE = 3000;
    private static final Map<String, String> cache = new LinkedHashMap<String, String>(256, 0.75f, true) { @Override protected boolean removeEldestEntry(Map.Entry<String, String> e) { return size() > CACHE; } };
    private static final ExecutorService pool = Executors.newFixedThreadPool(4, (r) -> { Thread t = new Thread(r, "kt-translate"); t.setDaemon(true); return t; });
    static void forget() { synchronized (cache) { cache.clear(); } }

    /** The translations of `texts`, in order (empty lines and lines with no letters come back as they are). */
    static List<String> translate(List<String> texts, Config c) throws Exception {
        String[] out = new String[texts.size()]; List<Integer> todo = new ArrayList<>(); List<String> ask = new ArrayList<>();
        Map<String, Integer> firstOf = new LinkedHashMap<>();
        for (int k = 0; k < texts.size(); k++) {
            String t = texts.get(k) == null ? "" : texts.get(k);
            if (!hasLetters(t)) { out[k] = t; continue; }
            String hit; synchronized (cache) { hit = cache.get(c.id() + "\u0000" + t); }
            if (hit != null) { out[k] = hit; continue; }
            todo.add(k); if (!firstOf.containsKey(t)) { firstOf.put(t, ask.size()); ask.add(t); }
        }
        if (!ask.isEmpty()) {
            List<String> got;
            switch (c.engine) { case "deepl": got = deepl(ask, c); break; case "ai": got = ai(ask, c); break; default: got = google(ask, c); }
            synchronized (cache) { for (int k = 0; k < ask.size(); k++) cache.put(c.id() + "\u0000" + ask.get(k), got.get(k)); }
            for (int k : todo) out[k] = got.get(firstOf.get(texts.get(k)));
        }
        List<String> l = new ArrayList<>(); for (String s : out) l.add(s); return l;
    }
    static boolean hasLetters(String s) { for (int k = 0; k < s.length(); k++) if (Character.isLetter(s.charAt(k))) return true; return false; }

    /* ---------- Google Translate (the free address its own pages use): one request a line, four at a time ---------- */
    static List<String> google(List<String> texts, Config c) throws Exception {
        List<Future<String>> fs = new ArrayList<>();
        for (String t : texts) fs.add(pool.submit(() -> googleOne(t, c)));
        List<String> out = new ArrayList<>(); for (Future<String> f : fs) out.add(f.get()); return out;
    }
    static String googleOne(String text, Config c) throws IOException {
        String url = c.googleBase + "/translate_a/single?client=gtx&dt=t&sl=" + enc(googleCode(c.source)) + "&tl=" + enc(googleCode(c.target)) + "&q=" + enc(text);
        String body = request("GET", url, null, null, c.timeoutMs);
        StringBuilder b = new StringBuilder(); for (Object seg : KtJson.arr(KtJson.at(KtJson.parse(body), "0"))) { Object t = KtJson.arr(seg).isEmpty() ? null : KtJson.arr(seg).get(0); if (t instanceof String) b.append(t); }
        return b.toString();
    }
    static String googleCode(String l) { if (l == null || l.isEmpty()) return "auto"; if (l.equals("zh")) return "zh-CN"; if (l.equals("he")) return "iw"; return l; }

    /* ---------- DeepL: all the lines in one request ---------- */
    static List<String> deepl(List<String> texts, Config c) throws Exception {
        if (c.deeplKey.trim().isEmpty()) throw new IOException("deeplKey");
        String base = !c.deeplBase.isEmpty() ? c.deeplBase : c.deeplKey.trim().endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
        List<String> out = new ArrayList<>();
        for (int from = 0; from < texts.size(); from += 50) {
            List<Object> part = new ArrayList<>(texts.subList(from, Math.min(texts.size(), from + 50)));
            Map<String, Object> req = KtJson.map("text", part, "target_lang", deeplCode(c.target, true)); if (c.source != null && !c.source.isEmpty() && !"auto".equals(c.source)) req.put("source_lang", deeplCode(c.source, false));
            Map<String, String> h = new LinkedHashMap<>(); h.put("Authorization", "DeepL-Auth-Key " + c.deeplKey.trim()); h.put("Content-Type", "application/json");
            Object j = KtJson.parse(request("POST", base + "/v2/translate", h, KtJson.write(req), c.timeoutMs));
            List<Object> tr = KtJson.arr(KtJson.obj(j).get("translations")); if (tr.size() != part.size()) throw new IOException("DeepL: " + tr.size() + "/" + part.size());
            for (Object x : tr) out.add(KtJson.str(KtJson.obj(x).get("text"), ""));
        }
        return out;
    }
    static String deeplCode(String l, boolean target) {
        String u = l.toUpperCase(java.util.Locale.ROOT);
        if (!target) return u.replaceAll("-.*", "");
        if (u.equals("EN")) return "EN-US"; if (u.equals("PT")) return "PT-BR"; if (u.equals("ZH") || u.equals("ZH-CN")) return "ZH-HANS"; if (u.equals("ZH-TW")) return "ZH-HANT";
        return u;
    }

    /* ---------- an AI model: the lines as a JSON array, the translations back as one ---------- */
    static final String AI_RULES = "You translate the text of a phone's screen. You get a JSON array of strings; return ONLY a JSON array with exactly as many strings, each the translation of the string at the same place, in the same order. Keep numbers, names and symbols; do not merge, split, explain or add anything.";
    static List<String> ai(List<String> texts, Config c) throws Exception {
        try { return aiOnce(texts, c); }
        catch (BadShape e) {
            // (An answer that did not hold one translation a line: asked again in halves, down to single lines.)
            if (texts.size() == 1) throw new IOException("bad translation format");
            int h = texts.size() / 2; List<String> out = new ArrayList<>(ai(texts.subList(0, h), c)); out.addAll(ai(texts.subList(h, texts.size()), c)); return out;
        }
    }
    static final class BadShape extends IOException { BadShape() { super("shape"); } }
    static List<String> aiOnce(List<String> texts, Config c) throws Exception {
        String system = (c.prompt.trim().isEmpty() ? "Translate into the language whose code is «" + c.target + "»: natural, accurate and idiomatic, faithful to the meaning and tone." : c.prompt.trim()) + "\n\n" + AI_RULES + " Target language: " + c.target + ".";
        String user = KtJson.write(new ArrayList<Object>(texts));
        String reply = chat(system, user, c);
        return parseArray(reply, texts.size());
    }
    static List<String> parseArray(String raw, int n) throws BadShape {
        String t = raw.trim().replaceAll("^```(?:json)?\\s*", "").replaceAll("```\\s*$", "");
        int a = t.indexOf('['), b = t.lastIndexOf(']'); if (a >= 0 && b > a) t = t.substring(a, b + 1);
        try { List<Object> l = KtJson.arr(KtJson.parse(t)); if (l.size() == n) { List<String> out = new ArrayList<>(); for (Object x : l) out.add(x == null ? "" : String.valueOf(x)); return out; } }
        catch (RuntimeException ignored) {}
        if (n == 1) { List<String> one = new ArrayList<>(); one.add(raw.trim()); return one; }
        throw new BadShape();
    }
    static String chat(String system, String user, Config c) throws IOException {
        Map<String, String> h = new LinkedHashMap<>(); h.put("Content-Type", "application/json"); h.putAll(c.headers);
        if ("gemini".equals(c.style)) {
            String base = c.base.isEmpty() ? "https://generativelanguage.googleapis.com/v1beta" : c.base;
            Map<String, Object> body = KtJson.map("systemInstruction", KtJson.map("parts", KtJson.list(KtJson.map("text", system))), "contents", KtJson.list(KtJson.map("role", "user", "parts", KtJson.list(KtJson.map("text", user)))), "generationConfig", KtJson.map("temperature", 0.2, "responseMimeType", "application/json"));
            Object j = KtJson.parse(request("POST", base + "/models/" + enc(c.model.isEmpty() ? "gemini-3.5-flash" : c.model) + ":generateContent" + (c.key.isEmpty() ? "" : "?key=" + enc(c.key)), h, KtJson.write(body), c.timeoutMs));
            StringBuilder b = new StringBuilder(); for (Object p : KtJson.arr(KtJson.at(j, "candidates.0.content.parts"))) b.append(KtJson.str(KtJson.obj(p).get("text"), "")); return b.toString();
        }
        if ("anthropic".equals(c.style)) {
            String base = c.base.isEmpty() ? "https://api.anthropic.com/v1" : c.base;
            h.put("x-api-key", c.key); h.put("anthropic-version", "2023-06-01");
            Map<String, Object> body = KtJson.map("model", c.model.isEmpty() ? "claude-haiku-4-5" : c.model, "max_tokens", 8192, "temperature", 0.2, "system", system, "messages", KtJson.list(KtJson.map("role", "user", "content", user)));
            Object j = KtJson.parse(request("POST", base + "/messages", h, KtJson.write(body), c.timeoutMs));
            StringBuilder b = new StringBuilder(); for (Object p : KtJson.arr(KtJson.obj(j).get("content"))) if ("text".equals(KtJson.obj(p).get("type"))) b.append(KtJson.str(KtJson.obj(p).get("text"), "")); return b.toString();
        }
        String base = c.base.isEmpty() ? "https://api.openai.com/v1" : c.base;
        if (!c.key.isEmpty()) h.put("Authorization", "Bearer " + c.key);
        Map<String, Object> body = KtJson.map("model", c.model.isEmpty() ? "gpt-4o-mini" : c.model, "temperature", 0.2, "messages", KtJson.list(KtJson.map("role", "system", "content", system), KtJson.map("role", "user", "content", user)));
        Object j = KtJson.parse(request("POST", base + "/chat/completions", h, KtJson.write(body), c.timeoutMs));
        Object content = KtJson.at(j, "choices.0.message.content");
        if (content instanceof List) { StringBuilder b = new StringBuilder(); for (Object p : (List<?>) content) b.append(KtJson.str(KtJson.obj(p).get("text"), "")); return b.toString(); }
        return KtJson.str(content, "");
    }

    /* ---------- the requests ---------- */
    static final class HttpError extends IOException { final int code; HttpError(int code, String body) { super("HTTP " + code + (body == null || body.isEmpty() ? "" : ": " + body.substring(0, Math.min(200, body.length())))); this.code = code; } }
    static String request(String method, String url, Map<String, String> headers, String body, int timeoutMs) throws IOException {
        for (int attempt = 0; ; attempt++) {
            HttpURLConnection c = opener.open(new URL(url));
            try {
                c.setRequestMethod(method); c.setConnectTimeout(Math.min(15000, timeoutMs)); c.setReadTimeout(timeoutMs);
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) KurokawaTools");
                if (headers != null) for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
                if (body != null) { c.setDoOutput(true); byte[] b = body.getBytes(StandardCharsets.UTF_8); c.setFixedLengthStreamingMode(b.length); try (OutputStream o = c.getOutputStream()) { o.write(b); } }
                int code = c.getResponseCode();
                String text = read(code >= 400 ? c.getErrorStream() : c.getInputStream());
                if (code == 429 || code >= 500) { if (attempt < 3) { try { Thread.sleep(800L << attempt); } catch (InterruptedException e) { throw new IOException("stopped"); } continue; } }
                if (code >= 300) throw new HttpError(code, text);
                return text;
            } finally { c.disconnect(); }
        }
    }
    private static String read(InputStream in) throws IOException { if (in == null) return ""; try (InputStream i = in) { ByteArrayOutputStream o = new ByteArrayOutputStream(); byte[] b = new byte[16384]; int n; while ((n = i.read(b)) > 0) o.write(b, 0, n); return new String(o.toByteArray(), StandardCharsets.UTF_8); } }
    static String enc(String s) { try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; } }
}
