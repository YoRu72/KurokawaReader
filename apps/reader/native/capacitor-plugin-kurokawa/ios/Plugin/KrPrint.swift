import Foundation
import Capacitor
import UIKit
import WebKit

/// A page of HTML (a book laid out for paper, its pictures and fonts inside it) printed to a PDF as the system's
/// own print does it — real text and pictures, not pictures of pages: a web view of its own, out of sight behind
/// the app, its print formatter drawn page by page into a PDF. Anything that goes wrong is reported; the app then
/// makes the PDF its own way. (The Android counterpart is KrPrint.java.)
final class KrPrint: NSObject, WKNavigationDelegate {
    /// The prints under way, kept alive until they end.
    private static var running: [KrPrint] = []

    private let call: CAPPluginCall
    private let web: WKWebView
    private let paper: CGRect
    private let margin: CGFloat
    private var done = false

    private init(call: CAPPluginCall, width: CGFloat, height: CGFloat, margin: CGFloat) {
        self.call = call
        self.paper = CGRect(x: 0, y: 0, width: width, height: height)
        self.margin = margin
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptEnabled = false   // HTML and CSS only
        // (Laid out at the paper's width, in CSS pixels.)
        self.web = WKWebView(frame: CGRect(x: 0, y: 0, width: width / 72 * 96, height: height / 72 * 96), configuration: config)
        super.init()
    }

    /// {html, width, height, margin} in points → {data: base64 PDF}.
    static func run(_ call: CAPPluginCall, host: UIView?) {
        guard let html = call.getString("html"), !html.isEmpty else { call.reject("no html"); return }
        let w = CGFloat(call.getDouble("width") ?? 595.28), h = CGFloat(call.getDouble("height") ?? 841.89), m = CGFloat(call.getDouble("margin") ?? 45.35)
        DispatchQueue.main.async {
            let p = KrPrint(call: call, width: w, height: h, margin: m)
            running.append(p)
            p.web.navigationDelegate = p
            p.web.isUserInteractionEnabled = false
            p.web.alpha = 0.01
            // Out of sight, behind the app's own page.
            if let host = host { host.insertSubview(p.web, at: 0) }
            p.web.loadHTMLString(html, baseURL: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 180) { [weak p] in p?.finish(nil, "timed out") }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // (A moment for its fonts and pictures to be decoded.)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.render() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(nil, error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(nil, error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(nil, "the page's process ended") }

    private func render() {
        if done { return }
        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(web.viewPrintFormatter(), startingAtPageAt: 0)
        let printable = paper.insetBy(dx: margin, dy: margin)
        renderer.setValue(NSValue(cgRect: paper), forKey: "paperRect")
        renderer.setValue(NSValue(cgRect: printable), forKey: "printableRect")
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paper, nil)
        let pages = renderer.numberOfPages
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: pages))
        let bounds = UIGraphicsGetPDFContextBounds()
        for i in 0..<pages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: i, in: bounds)
        }
        UIGraphicsEndPDFContext()
        if pages == 0 || data.length < 64 { finish(nil, "empty"); return }
        finish(data as Data, nil)
    }

    private func finish(_ pdf: Data?, _ why: String?) {
        if done { return }
        done = true
        web.stopLoading()
        web.navigationDelegate = nil
        web.removeFromSuperview()
        KrPrint.running.removeAll { $0 === self }
        if let pdf = pdf { call.resolve(["data": pdf.base64EncodedString()]) } else { call.reject("print: \(why ?? "failed")") }
    }
}
