import Foundation
import Capacitor
import UIKit
import CoreGraphics

/// Pages of a PDF drawn by the system (CoreGraphics): the iOS counterpart of Android's PdfRenderer in
/// KurokawaPlugin.java, with the same calls — pdfOpen {path, keep?, sizes?} → {id, pageCount, pages?};
/// pdfRender {id?, page, width, quality?, format?, tileX/Y/W/H?, toFile?} → {path | data, width, height};
/// pdfClose {id?}. Faster than pdf.js on the page, and with the system's fonts for the ones a PDF does not embed.
/// The reader's document is id 0; the PDF tools open theirs with `keep` and get ids of their own.
final class KrPdf {
    private static var docs: [Int: CGPDFDocument] = [:]
    private static var seq = 0
    private static var renderSeq = 0
    private static let lock = NSLock()

    static func open(_ call: CAPPluginCall) {
        var path = call.getString("path") ?? ""
        if path.hasPrefix("file://") { path = String(path.dropFirst(7)) }
        guard !path.isEmpty, let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : URL(string: path), let doc = CGPDFDocument(url as CFURL) else { call.reject("Cannot open PDF"); return }
        if doc.isEncrypted && !doc.unlockWithPassword("") { call.reject("Cannot open PDF: encrypted"); return }
        let keep = call.getBool("keep") ?? false
        lock.lock()
        var id = 0
        if keep { seq += 1; id = seq }
        docs[id] = doc
        lock.unlock()
        var ret: [String: Any] = ["id": id, "pageCount": doc.numberOfPages]
        if call.getBool("sizes") ?? false {
            var sizes: [[Double]] = []
            for i in 1...max(1, min(doc.numberOfPages, 4000)) {
                guard let p = doc.page(at: i) else { continue }
                let box = p.getBoxRect(.cropBox)
                let turned = p.rotationAngle % 180 != 0
                sizes.append([Double(turned ? box.height : box.width), Double(turned ? box.width : box.height)])
            }
            ret["pages"] = sizes
        }
        call.resolve(ret)
    }

    static func render(_ call: CAPPluginCall) {
        let id = call.getInt("id") ?? 0
        let pageNo = call.getInt("page") ?? 1
        let width = call.getInt("width") ?? 1080
        let quality = CGFloat(call.getInt("quality") ?? 85) / 100
        let png = (call.getString("format") ?? "jpeg") == "png"
        let tileW = call.getInt("tileW") ?? 0, tileH = call.getInt("tileH") ?? 0
        let tileX = call.getInt("tileX") ?? 0, tileY = call.getInt("tileY") ?? 0
        let toFile = call.getBool("toFile") ?? false
        lock.lock(); let doc = docs[id]; lock.unlock()
        guard let doc = doc else { call.reject("No PDF open"); return }
        guard let page = doc.page(at: pageNo) else { call.reject("No such page"); return }
        let box = page.getBoxRect(.cropBox)
        let turned = page.rotationAngle % 180 != 0
        let pw = turned ? box.height : box.width, ph = turned ? box.width : box.height
        guard pw > 0, ph > 0 else { call.reject("Empty page"); return }
        let tiled = tileW > 0 && tileH > 0
        let w = tiled ? min(tileW, 4096) : max(64, min(width, 5000))
        let h = tiled ? min(tileH, 4096) : max(1, Int((Double(w) * Double(ph / pw)).rounded()))
        let k = CGFloat(width) / pw   // points → pixels at the page's whole width
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1; fmt.opaque = true
        let image = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: fmt).image { ctx in
            let c = ctx.cgContext
            c.setFillColor(UIColor.white.cgColor); c.fill(CGRect(x: 0, y: 0, width: w, height: h))
            // PDF space has its origin at the bottom left: flipped, then scaled, then the tile's corner moved to 0,0.
            c.translateBy(x: 0, y: CGFloat(h))
            c.scaleBy(x: 1, y: -1)
            // (A tile: the whole page is H pixels tall with y upward here, so its top-left corner (tileX, tileY,
            // counted downward) is moved to the tile's origin.)
            if tiled { let H = (CGFloat(width) * ph / pw).rounded(); c.translateBy(x: -CGFloat(tileX), y: H - CGFloat(h) - CGFloat(tileY)) }
            c.scaleBy(x: k, y: k)
            c.concatenate(page.getDrawingTransform(.cropBox, rect: CGRect(x: 0, y: 0, width: pw, height: ph), rotate: 0, preserveAspectRatio: true))
            c.interpolationQuality = .high
            c.drawPDFPage(page)
        }
        guard let data = png ? image.pngData() : image.jpegData(compressionQuality: quality) else { call.reject("Render failed"); return }
        var ret: [String: Any] = ["width": w, "height": h]
        if toFile {
            let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("kr-pdfr", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            lock.lock(); renderSeq += 1; let n = renderSeq % 12; lock.unlock()
            let f = dir.appendingPathComponent("r\(n).\(png ? "png" : "jpg")")
            do { try data.write(to: f, options: .atomic) } catch { call.reject("Render failed: \(error.localizedDescription)"); return }
            ret["path"] = f.path
        } else {
            ret["data"] = data.base64EncodedString()
        }
        call.resolve(ret)
    }

    static func close(_ call: CAPPluginCall) {
        let id = call.getInt("id") ?? 0
        lock.lock(); docs.removeValue(forKey: id); lock.unlock()
        call.resolve()
    }
}
