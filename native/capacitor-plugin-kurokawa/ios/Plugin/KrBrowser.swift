import Foundation
import Capacitor
import UIKit
import WebKit

/// The app's own browser, for the sites that answer only a browser (the iOS side of native/android/KrBrowser.java
/// and desktop/main.cjs). A site behind Cloudflare (or DDoS-Guard and the like) may turn the app's plain requests
/// away; a web view of the app's — WebKit, with the app's cookies and the same identity as its requests — does the
/// work instead:
///  - check: the site opened to pass its check: out of sight first (the JavaScript checks pass by themselves),
///    else in a screen the reader acts in ("confirm you are human"), which closes by itself once the site shows a
///    page of its own; the clearance is then given to the app's own requests too;
///  - fetch: a request made by a page of the site itself — a view opened on the site once and kept out of sight
///    for a few minutes, each request that page's own fetch;
///  - reset / forget: the site's view closed; its clearance (or every cookie of it) cleared.
/// Everything here runs on the main thread.
final class KrBrowser: NSObject {
    /// The page as "readyState␁origin␁check␁refused␁title" — the same script as on Android and the desktop.
    static let stateJS = #"""
    (function(){try{var t=document.title||'',b=document.body?(document.body.innerText||'').slice(0,700):'';var bl=/used Cloudflare to restrict access|Sorry, you have been blocked|You are unable to access|has banned you|banned your IP|Error 10(06|07|08|09|10|12|20)\b/i.test(t+' '+b);var ch=!bl&&(/Just a moment|Attention Required|Verifying you are human|Verify you are human|Checking your browser|Checking if the site connection is secure|Please wait|DDoS-Guard|One moment|لحظة|Один момент/i.test(t)||!!document.querySelector('#challenge-form,#challenge-running,#challenge-stage,#cf-challenge-running,.cf-browser-verification,#cf-please-wait,#turnstile-wrapper,[name="cf-turnstile-response"],#ddg-captcha,.ddg-captcha,#sucuri_cloudproxy_js'));return [document.readyState,location.origin,ch?1:0,bl?1:0,t.slice(0,140)].join('\u0001');}catch(e){return 'error';}})()
    """#

    /// The request a lane's page makes for the app: the body of an async function of `o`; its answer as base64
    /// with its status, headers and address.
    static let fetchJS = #"""
    const h = {};
    for (const k of Object.keys(o.headers || {})) { if (!/^(user-agent|referer|cookie|cookie2|accept-encoding|host|origin|connection|content-length|keep-alive|te|trailer|transfer-encoding|upgrade|via|sec-.*|proxy-.*)$/i.test(k)) h[k] = o.headers[k]; }
    const init = { method: o.method || 'GET', headers: h, credentials: 'include', cache: 'no-store', redirect: 'follow' };
    if (o.body != null) { if (o.bodyBase64) { const s = atob(o.body); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); init.body = a; } else { init.body = o.body; } }
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), o.timeout || 90000); init.signal = ctl.signal;
    try {
      const r = await fetch(o.url, init);
      const hs = {}; r.headers.forEach((v, n) => { hs[n.toLowerCase()] = v; });
      const u8 = new Uint8Array(await r.arrayBuffer()); let s = '';
      for (let j = 0; j < u8.length; j += 8192) s += String.fromCharCode.apply(null, u8.subarray(j, j + 8192));
      return { status: r.status, headers: hs, b64: btoa(s), url: r.url || o.url };
    } finally { clearTimeout(tm); }
    """#

    private weak var plugin: CAPPlugin?
    private var lanes: [String: Lane] = [:]
    private var checks: [KrCheck] = []
    private var sweeper: Timer?

    init(plugin: CAPPlugin) {
        self.plugin = plugin
        super.init()
    }

    /* ---------- pieces ---------- */

    final class Lane {
        let origin: String
        var web: WKWebView?
        var watch: KrLoadWatch?
        var ready = false
        var opening = false
        var used = Date()
        var busy = 0
        var title = ""
        var waiting: [(Lane?, String?, String) -> Void] = []
        init(origin: String) { self.origin = origin }
    }

    static func originOf(_ s: String) -> String? {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = u.host?.lowercased() else { return nil }
        if let port = u.port, !(scheme == "http" && port == 80), !(scheme == "https" && port == 443) { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }

    static func parse(_ v: Any?) -> [String]? {
        guard let s = v as? String else { return nil }
        let p = s.components(separatedBy: "\u{1}")
        return p.count >= 5 ? p : nil
    }

    static func isClear(_ st: [String]?, _ origin: String) -> Bool {
        guard let st = st else { return false }
        return st[1] == origin && st[0] != "loading" && st[2] == "0" && st[3] == "0"
    }

    /// The site an origin belongs to, for a check: its host without "www." (a site sending example.com to
    /// www.example.com, or http to https, has still been passed).
    static func siteOf(_ origin: String) -> String {
        var h = origin.lowercased()
        if let r = h.range(of: "://") { h = String(h[r.upperBound...]) }
        if let c = h.lastIndex(of: ":"), h[h.index(after: c)...].allSatisfy({ $0.isNumber }) { h = String(h[..<c]) }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    static func isClearFor(_ st: [String]?, _ origin: String) -> Bool {
        guard let st = st else { return false }
        return st[1].hasPrefix("http") && siteOf(st[1]) == siteOf(origin) && st[0] != "loading" && st[2] == "0" && st[3] == "0"
    }

    /// A page shown without a check, but on another site than the one asked for.
    static func movedAway(_ st: [String]?, _ origin: String) -> Bool {
        guard let st = st else { return false }
        return st[1].hasPrefix("http") && st[1] != origin && st[0] != "loading" && st[2] == "0" && st[3] == "0"
    }

    static func isCheckCookie(_ name: String) -> Bool {
        return name == "cf_clearance" || name.hasPrefix("__cf") || name.hasPrefix("cf_chl") || name.hasPrefix("__ddg")
    }

    /// Text in the charset its header names (else UTF-8, else Latin-1).
    static func text(_ d: Data, contentType: String?) -> String {
        var enc = String.Encoding.utf8
        if let ct = contentType, let r = ct.range(of: "charset=", options: .caseInsensitive) {
            let name = ct[r.upperBound...].split(whereSeparator: { $0 == ";" || $0 == " " || $0 == "," }).first.map { String($0).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")) } ?? ""
            let cf = CFStringConvertIANACharSetNameToEncoding(name as CFString)
            if cf != kCFStringEncodingInvalidId { enc = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(cf)) }
        }
        return String(data: d, encoding: enc) ?? String(data: d, encoding: .utf8) ?? String(data: d, encoding: .isoLatin1) ?? ""
    }

    /// What a lane answers when the site will not let it through: a check for the reader to pass, or a refusal.
    static func refusal(_ url: String, blocked: Bool, title: String, binary: Bool) -> [String: Any] {
        let t = title.isEmpty ? (blocked ? "Access denied" : "Just a moment...") : title.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        let html = "<html><head><title>\(t)</title></head><body></body></html>"
        var hs: [String: Any] = ["content-type": "text/html; charset=utf-8"]
        if blocked { hs["x-kr-lane"] = "blocked" } else { hs["cf-mitigated"] = "challenge"; hs["x-kr-lane"] = "challenge" }
        return ["status": 403, "headers": hs, "url": url, "via": "browser", "body": binary ? Data(html.utf8).base64EncodedString() : html]
    }

    private func window() -> UIWindow? {
        if let w = plugin?.bridge?.viewController?.view.window { return w }
        return UIApplication.shared.windows.first(where: { $0.isKeyWindow }) ?? UIApplication.shared.windows.first
    }

    /// A web view with the app's identity: the shared cookie store (and so the clearance a check leaves).
    private func makeView() -> WKWebView {
        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = WKWebsiteDataStore.default()
        return WKWebView(frame: window()?.bounds ?? UIScreen.main.bounds, configuration: conf)
    }

    /// A view kept out of sight: the window's full size (a check reads it), behind the app's own screen.
    private func hide(_ web: WKWebView) {
        guard let win = window() else { return }
        web.frame = win.bounds
        web.isUserInteractionEnabled = false
        web.accessibilityElementsHidden = true
        win.insertSubview(web, at: 0)
    }

    /// The clearance a check left in the web views' store, given to the app's own requests (URLSession) as well.
    private func syncCookies(_ origin: String, then: @escaping () -> Void) {
        guard let host = URL(string: origin)?.host?.lowercased() else { then(); return }
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            for c in cookies {
                let d = c.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
                if host == d || host.hasSuffix("." + d) { HTTPCookieStorage.shared.setCookie(c) }
            }
            then()
        }
    }

    /// The site's cookies removed: its clearance only, or all of them. Says how many.
    private func clearCookies(_ url: String, all: Bool, then: @escaping (Int) -> Void) {
        guard let u = URL(string: url), let host = u.host?.lowercased() else { then(0); return }
        if let cs = HTTPCookieStorage.shared.cookies(for: u) {
            for c in cs where all || KrBrowser.isCheckCookie(c.name) { HTTPCookieStorage.shared.deleteCookie(c) }
        }
        let store = WKWebsiteDataStore.default().httpCookieStore
        store.getAllCookies { cookies in
            let mine = cookies.filter { c in
                let d = c.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
                return (host == d || host.hasSuffix("." + d)) && (all || KrBrowser.isCheckCookie(c.name))
            }
            if mine.isEmpty { then(0); return }
            let group = DispatchGroup()
            for c in mine { group.enter(); store.delete(c) { group.leave() } }
            group.notify(queue: .main) { then(mine.count) }
        }
    }

    /* ---------- check: a site's check passed, out of sight or by the reader ---------- */

    /// {url, hidden?, timeout?, fresh?, stay?, message?, done?, reload?} → {passed, blocked, title} (`stay`: the
    /// screen stays until the reader closes it — the site opened for them to use).
    func check(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        guard let origin = KrBrowser.originOf(url), let target = URL(string: url) else { call.reject("No url"); return }
        let hidden = call.getBool("hidden") ?? false
        let timeout = Double(call.getInt("timeout") ?? (hidden ? 15000 : 300000)) / 1000
        let fresh = call.getBool("fresh") ?? false
        let stay = !hidden && (call.getBool("stay") ?? false)
        let message = call.getString("message") ?? ""
        let doneLabel = call.getString("done") ?? "Done"
        let reloadLabel = call.getString("reload") ?? "Reload"
        DispatchQueue.main.async {
            let start: () -> Void = {
                let web = self.makeView()
                let check = KrCheck(web: web, origin: origin, hidden: hidden, timeout: timeout)
                check.stay = stay
                self.checks.append(check)
                check.onDone = { [weak self, weak check] passed, blocked, title in
                    if let me = self, let c = check { me.checks.removeAll(where: { $0 === c }) }
                    let answer: [String: Any] = ["passed": passed, "blocked": blocked, "title": title]
                    // (The clearance is in the app's own cookie store before the request is made again.)
                    if passed, let me = self { me.syncCookies(origin) { call.resolve(answer) } } else { call.resolve(answer) }
                }
                if hidden {
                    self.hide(web)
                } else {
                    var top = self.plugin?.bridge?.viewController
                    while let shown = top?.presentedViewController { top = shown }
                    let screen = KrCheckController(check: check, message: message.isEmpty ? url : message, done: doneLabel, reload: reloadLabel)
                    let nav = UINavigationController(rootViewController: screen)
                    nav.modalPresentationStyle = .fullScreen
                    check.screen = nav
                    top?.present(nav, animated: true, completion: nil)
                }
                check.begin(target)
            }
            if fresh { self.clearCookies(url, all: false) { _ in start() } } else { start() }
        }
    }

    /* ---------- fetch: requests made by a page of the site ---------- */

    /// {url, method?, headers?, body?, bodyBase64?, binary?, timeout?, page?, openTimeout?} → {status, headers,
    /// body, url, via} (see the Android side: a check for the reader answers as a check would, a refusal with
    /// x-kr-lane: blocked; refused outright only when the site could not be reached at all).
    func fetch(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        guard let origin = KrBrowser.originOf(url) else { call.reject("Bad address"); return }
        guard #available(iOS 14.0, *) else { call.reject("The app's browser needs iOS 14"); return }
        let page = call.getString("page") ?? (origin + "/")
        let openTimeout = Double(call.getInt("openTimeout") ?? 20000) / 1000
        let timeout = call.getInt("timeout") ?? 90000
        let binary = call.getBool("binary") ?? false
        var o: [String: Any] = ["url": url, "method": call.getString("method") ?? "GET", "bodyBase64": call.getBool("bodyBase64") ?? false, "timeout": timeout]
        var headers: [String: Any] = [:]
        if let given = call.getObject("headers") { for (k, v) in given { if let s = v as? String { headers[k] = s } } }
        o["headers"] = headers
        if let body = call.getString("body") { o["body"] = body }
        DispatchQueue.main.async {
            self.open(origin: origin, page: page, timeout: openTimeout) { lane, why, title in
                guard let lane = lane, let web = lane.web else {
                    if let why = why, why.hasPrefix("error:") { call.reject("Browser could not open the site: " + String(why.dropFirst(6))); return }
                    call.resolve(KrBrowser.refusal(url, blocked: why == "blocked", title: title, binary: binary))
                    return
                }
                lane.busy += 1
                lane.used = Date()
                // (Answered once: by the page, or by the time allowed running out — a page replaced mid-request
                // would otherwise answer only when its promise is collected.)
                var answered = false
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeout + 15000)) {
                    if answered { return }
                    answered = true
                    lane.busy -= 1
                    lane.used = Date()
                    call.reject("Browser request timed out")
                }
                web.callAsyncJavaScript(KrBrowser.fetchJS, arguments: ["o": o], in: nil, in: .page) { result in
                    if answered { return }
                    answered = true
                    lane.busy -= 1
                    lane.used = Date()
                    switch result {
                    case .failure(let err):
                        call.reject("Browser request failed: \(err.localizedDescription)")
                    case .success(let value):
                        guard let d = value as? [String: Any] else { call.reject("Browser request failed: no answer"); return }
                        let status = (d["status"] as? NSNumber)?.intValue ?? 0
                        let hs = d["headers"] as? [String: Any] ?? [:]
                        let b64 = d["b64"] as? String ?? ""
                        let finalUrl = d["url"] as? String ?? url
                        let body = binary ? b64 : KrBrowser.text(Data(base64Encoded: b64) ?? Data(), contentType: hs["content-type"] as? String)
                        call.resolve(["status": status, "headers": hs, "body": body, "url": finalUrl, "via": "browser"])
                    }
                }
            }
        }
    }

    /// {url} → the site's view set aside (the next request opens it again, with the cookies as they are now).
    func reset(_ call: CAPPluginCall) {
        let origin = KrBrowser.originOf(call.getString("url") ?? "")
        DispatchQueue.main.async {
            if let o = origin, let l = self.lanes[o] { self.retire(l) }
            call.resolve()
        }
    }

    /// {url, all?} → {cleared}: the site's clearance (or every cookie of it) cleared, its view closed.
    func forget(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        let all = call.getBool("all") ?? false
        let origin = KrBrowser.originOf(url)
        DispatchQueue.main.async {
            if let o = origin, let l = self.lanes[o] { self.retire(l) }
            if origin == nil { call.resolve(["cleared": 0]); return }
            self.clearCookies(url, all: all) { n in call.resolve(["cleared": n]) }
        }
    }

    /// The site's view, ready (its page loaded, no check on it), else why not: "challenge" (a check that did not
    /// pass by itself in time), "blocked" (a refusal), "error:…" (the page did not load).
    private func open(origin: String, page: String, timeout: TimeInterval, done: @escaping (Lane?, String?, String) -> Void) {
        if let had = lanes[origin] {
            if had.ready && had.web != nil { had.used = Date(); done(had, nil, ""); return }
            if had.opening { had.waiting.append(done); return }
        }
        guard let target = URL(string: page) else { done(nil, "error:bad address", ""); return }
        let lane = Lane(origin: origin)
        lane.opening = true
        lane.waiting.append(done)
        lanes[origin] = lane
        let web = makeView()
        lane.web = web
        let watch = KrLoadWatch { [weak self, weak lane] why in
            guard let me = self, let l = lane else { return }
            // (Its page's process gone — iOS ends them in the background: the next request opens the site afresh.)
            if why == "gone" { if l.opening { me.settle(l, why: "error:the page stopped", title: "") } else { me.close(l) }; return }
            me.settle(l, why: why, title: "")
        }
        lane.watch = watch
        web.navigationDelegate = watch
        hide(web)
        web.load(URLRequest(url: target))
        let start = Date()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.poll(lane, start: start, timeout: timeout) }
        sweep()
    }

    /// (Asked every half second whether or not the last question was answered — a page replaced mid-question, as
    /// a check reloads, never answers it — and given up at the time allowed.)
    private func poll(_ lane: Lane, start: Date, timeout: TimeInterval) {
        guard lane.opening, let web = lane.web else { return }
        if Date().timeIntervalSince(start) > timeout { settle(lane, why: "challenge", title: lane.title); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.poll(lane, start: start, timeout: timeout) }
        web.evaluateJavaScript(KrBrowser.stateJS) { [weak self] v, _ in
            guard let me = self, lane.opening else { return }
            let st = KrBrowser.parse(v)
            if let s = st { lane.title = s[4] }
            if KrBrowser.isClear(st, lane.origin) { me.settle(lane, why: nil, title: lane.title); return }
            if let s = st, s[3] == "1" { me.settle(lane, why: "blocked", title: s[4]); return }
            if let s = st, KrBrowser.movedAway(st, lane.origin) { me.settle(lane, why: "error:the site sends its pages to " + s[1], title: "") }
        }
    }

    private func settle(_ lane: Lane, why: String?, title: String) {
        guard lane.opening else { return }
        lane.opening = false
        let ws = lane.waiting
        lane.waiting = []
        if why == nil {
            lane.ready = true
            lane.used = Date()
            for w in ws { w(lane, nil, title) }
            return
        }
        close(lane)
        for w in ws { w(nil, why, title) }
    }

    /// A view set aside: new requests open the site afresh; the requests under way in it finish first, then it is
    /// closed (after a minute at the most). One still opening goes on.
    private func retire(_ lane: Lane, tries: Int = 0) {
        if lane.opening { return }
        if lanes[lane.origin] === lane { lanes[lane.origin] = nil }
        if lane.busy == 0 || tries >= 30 { close(lane); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.retire(lane, tries: tries + 1) }
    }

    private func close(_ lane: Lane) {
        if lanes[lane.origin] === lane { lanes[lane.origin] = nil }
        lane.ready = false
        // (Requests waiting for it to open are told, not left waiting.)
        if lane.opening {
            lane.opening = false
            let ws = lane.waiting
            lane.waiting = []
            for w in ws { w(nil, "error:closed", "") }
        }
        if let web = lane.web {
            web.stopLoading()
            web.navigationDelegate = nil
            web.removeFromSuperview()
        }
        lane.web = nil
        lane.watch = nil
    }

    /// Views unused for a few minutes closed, once a minute while any is open.
    private func sweep() {
        if sweeper != nil { return }
        sweeper = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] timer in
            guard let me = self else { timer.invalidate(); return }
            for l in Array(me.lanes.values) where !l.opening && l.busy == 0 && Date().timeIntervalSince(l.used) > 240 { me.close(l) }
            if me.lanes.isEmpty { timer.invalidate(); me.sweeper = nil }
        }
    }
}

/// A lane's page not loading at all (no network, no such site) — a navigation replaced by another (a check
/// redirecting to the page) is not a failure — or its process ended ("gone").
final class KrLoadWatch: NSObject, WKNavigationDelegate {
    private let failed: (String) -> Void
    init(failed: @escaping (String) -> Void) {
        self.failed = failed
        super.init()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { report(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { report(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failed("gone") }
    private func report(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }
        failed("error:" + e.localizedDescription)
    }
}

/// One check: the page watched until the site shows a page of its own, a refusal, the reader closing it, or the
/// time given running out.
final class KrCheck: NSObject {
    let web: WKWebView
    let origin: String
    let hidden: Bool
    let timeout: TimeInterval
    /// The site opened for the reader to use: closed only by them.
    var stay = false
    var onDone: ((Bool, Bool, String) -> Void)?
    weak var screen: UIViewController?
    private var finished = false
    private var passed = false
    private var blocked = false
    private var title = ""
    private var started = Date()

    init(web: WKWebView, origin: String, hidden: Bool, timeout: TimeInterval) {
        self.web = web
        self.origin = origin
        self.hidden = hidden
        self.timeout = timeout
        super.init()
    }

    func begin(_ url: URL) {
        started = Date()
        web.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.poll() }
    }

    /// (Asked every 600 ms whether or not the last question was answered, and given up at the time allowed — a
    /// screen that stays is closed by the reader only.)
    private func poll() {
        if finished { return }
        if !stay && Date().timeIntervalSince(started) > timeout { finish(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.poll() }
        web.evaluateJavaScript(KrBrowser.stateJS) { [weak self] v, _ in
            guard let me = self, !me.finished else { return }
            let st = KrBrowser.parse(v)
            if let s = st { me.title = s[4]; me.blocked = s[3] == "1" }
            if KrBrowser.isClearFor(st, me.origin) {
                me.passed = true
                me.blocked = false
                if !me.stay { DispatchQueue.main.asyncAfter(deadline: .now() + (me.hidden ? 0 : 0.9)) { [weak me] in me?.finish() } }
                return
            }
            if me.blocked && me.hidden { me.finish() }
        }
    }

    /// The reader closed the screen: looked at once more first (a check passed a moment before counts).
    func closeByReader() {
        if finished { return }
        web.evaluateJavaScript(KrBrowser.stateJS) { [weak self] v, _ in
            guard let me = self else { return }
            if KrBrowser.isClearFor(KrBrowser.parse(v), me.origin) { me.passed = true }
            me.finish()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.finish() }
    }

    func finish() {
        if finished { return }
        finished = true
        web.stopLoading()
        if hidden { web.removeFromSuperview() }
        if let s = screen { s.dismiss(animated: true, completion: nil) }
        onDone?(passed, blocked, title)
        onDone = nil
    }
}

/// The screen a check is passed in: the site's page under a bar with the line for the reader, "Reload" and
/// "Close".
final class KrCheckController: UIViewController {
    private let check: KrCheck
    private let message: String
    private let doneLabel: String
    private let reloadLabel: String

    init(check: KrCheck, message: String, done: String, reload: String) {
        self.check = check
        self.message = message
        self.doneLabel = done
        self.reloadLabel = reload
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func loadView() { view = check.web }

    override func viewDidLoad() {
        super.viewDidLoad()
        let label = UILabel(frame: CGRect(x: 0, y: 0, width: 260, height: 44))
        label.text = message
        label.numberOfLines = 2
        label.textAlignment = .center
        label.font = UIFont.preferredFont(forTextStyle: .footnote)
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.7
        navigationItem.titleView = label
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: doneLabel, style: .done, target: self, action: #selector(closeTapped))
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: reloadLabel, style: .plain, target: self, action: #selector(reloadTapped))
    }

    @objc private func closeTapped() { check.closeByReader() }
    @objc private func reloadTapped() { check.web.reload() }
}
