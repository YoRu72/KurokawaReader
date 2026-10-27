import Foundation
import Capacitor
import UIKit
import Photos
import UniformTypeIdentifiers

/// iOS counterpart of the Android KurokawaPlugin:
///  - pickTree / listTree / readDocument: scan a folder chosen in the Files picker
///  - saveToGallery: save a snapshot PNG into Photos, in an album named after the folder setting
///  - copyImage: put a PNG on the pasteboard
///  - httpRequest: a request from native code (no CORS), with the clearance a site's check left
///  - openWebView / browserFetch / browserReset / browserForget: the app's own browser (KrBrowser.swift), for
///    the sites that answer only a browser
///  - printToPdf: a page of HTML printed to a PDF by the system (KrPrint.swift)
@objc(KurokawaPlugin)
public class KurokawaPlugin: CAPPlugin, UIDocumentPickerDelegate {
    private var pickCall: CAPPluginCall?
    private var trees: [String: URL] = [:]

    // MARK: folder picking

    @objc func pickTree(_ call: CAPPluginCall) {
        pickCall = call
        DispatchQueue.main.async {
            let picker: UIDocumentPickerViewController
            if #available(iOS 14.0, *) {
                picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
            } else {
                picker = UIDocumentPickerViewController(documentTypes: ["public.folder"], in: .open)
            }
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall else { return }
        pickCall = nil
        guard let url = urls.first else { call.reject("cancelled"); return }
        trees[url.absoluteString] = url
        if let data = try? url.bookmarkData() { UserDefaults.standard.set(data, forKey: "kr.tree." + url.absoluteString) }
        call.resolve(["uri": url.absoluteString, "name": url.lastPathComponent])
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.reject("cancelled")
        pickCall = nil
    }

    private func treeURL(_ s: String) -> URL? {
        if let u = trees[s] { return u }
        if let data = UserDefaults.standard.data(forKey: "kr.tree." + s) {
            var stale = false
            if let u = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) { trees[s] = u; return u }
        }
        return URL(string: s)
    }

    @objc func listTree(_ call: CAPPluginCall) {
        guard let treeStr = call.getString("uri"), let tree = treeURL(treeStr) else { call.reject("uri required"); return }
        let exts = (call.getArray("exts", String.self) ?? []).map { $0.lowercased() }
        let scoped = tree.startAccessingSecurityScopedResource()
        defer { if scoped { tree.stopAccessingSecurityScopedResource() } }
        var out: [[String: Any]] = []
        var truncated = false
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .nameKey]
        if let en = FileManager.default.enumerator(at: tree, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) {
            for case let url as URL in en {
                if out.count >= 5000 { truncated = true; break }
                guard let vals = try? url.resourceValues(forKeys: Set(keys)), vals.isDirectory != true else { continue }
                let ext = url.pathExtension.lowercased()
                if !exts.isEmpty && !exts.contains(ext) { continue }
                let rel = url.path.hasPrefix(tree.path) ? String(url.path.dropFirst(tree.path.count + 1)) : url.lastPathComponent
                out.append([
                    "uri": url.absoluteString, "tree": treeStr, "name": url.lastPathComponent, "path": rel, "mime": "",
                    "size": vals.fileSize ?? 0,
                    "modified": Int((vals.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000),
                ])
            }
        }
        call.resolve(["files": out, "truncated": truncated])
    }

    @objc func readDocument(_ call: CAPPluginCall) {
        guard let uriStr = call.getString("uri"), let url = URL(string: uriStr) else { call.reject("uri required"); return }
        let tree = call.getString("tree").flatMap { treeURL($0) }
        let scoped = tree?.startAccessingSecurityScopedResource() ?? url.startAccessingSecurityScopedResource()
        defer { if scoped { (tree ?? url).stopAccessingSecurityScopedResource() } }
        var coordError: NSError?
        var result: Data?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordError) { readURL in
            result = try? Data(contentsOf: readURL)
        }
        guard let data = result else { call.reject("read failed: \(coordError?.localizedDescription ?? "unknown")"); return }
        call.resolve(["data": data.base64EncodedString()])
    }

    // MARK: images

    @objc func saveToGallery(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64), let image = UIImage(data: data) else { call.reject("bad image"); return }
        let album = call.getString("folder") ?? "Screenshots"
        let save = {
            let coll = self.album(named: album)
            PHPhotoLibrary.shared().performChanges({
                let req = PHAssetChangeRequest.creationRequestForAsset(from: image)
                if let coll = coll, let placeholder = req.placeholderForCreatedAsset,
                   let addReq = PHAssetCollectionChangeRequest(for: coll) {
                    addReq.addAssets([placeholder] as NSArray)
                }
            }) { ok, err in
                if ok { call.resolve(["path": "Photos/\(album)"]) } else { call.reject("Save failed: \(err?.localizedDescription ?? "")") }
            }
        }
        if #available(iOS 14.0, *) {
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                if status == .authorized || status == .limited { save() } else { call.reject("Photos access denied") }
            }
        } else {
            PHPhotoLibrary.requestAuthorization { status in
                if status == .authorized { save() } else { call.reject("Photos access denied") }
            }
        }
    }

    /// Finds (or, on the first call, creates) the album; creation happens in its own change block.
    private func album(named name: String) -> PHAssetCollection? {
        let opts = PHFetchOptions()
        opts.predicate = NSPredicate(format: "title = %@", name)
        if let c = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: opts).firstObject { return c }
        var placeholder: PHObjectPlaceholder?
        try? PHPhotoLibrary.shared().performChangesAndWait {
            placeholder = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: name).placeholderForCreatedAssetCollection
        }
        guard let id = placeholder?.localIdentifier else { return nil }
        return PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil).firstObject
    }

    @objc func copyImage(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64), let image = UIImage(data: data) else { call.reject("bad image"); return }
        DispatchQueue.main.async { UIPasteboard.general.image = image; call.resolve() }
    }

    // MARK: the app's own browser (sites behind Cloudflare and the like)

    private lazy var browser: KrBrowser = KrBrowser(plugin: self)
    @objc func openWebView(_ call: CAPPluginCall) { browser.check(call) }
    @objc func browserFetch(_ call: CAPPluginCall) { browser.fetch(call) }
    @objc func browserReset(_ call: CAPPluginCall) { browser.reset(call) }
    @objc func browserForget(_ call: CAPPluginCall) { browser.forget(call) }

    // MARK: printing a page to a PDF (real text, not pictures of pages)

    @objc func printToPdf(_ call: CAPPluginCall) { KrPrint.run(call, host: bridge?.viewController?.view) }

    /// HTTP request from native code (no CORS): the sync back-ends and the sources. The shared cookie store goes
    /// with it (a check's clearance is copied there once passed); its answer's text in the charset it names.
    @objc func httpRequest(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else { call.reject("url required"); return }
        var req = URLRequest(url: url)
        req.httpMethod = call.getString("method") ?? "GET"
        req.timeoutInterval = 60
        if let headers = call.getObject("headers") { for (k, v) in headers { if let s = v as? String { req.setValue(s, forHTTPHeaderField: k) } } }
        if let body = call.getString("body") { req.httpBody = (call.getBool("bodyBase64") ?? false) ? Data(base64Encoded: body) : body.data(using: .utf8) }
        let binary = call.getBool("binary") ?? false
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err = err { call.reject("Request failed: \(err.localizedDescription)"); return }
            let http = resp as? HTTPURLResponse
            var hs: [String: Any] = [:]
            http?.allHeaderFields.forEach { k, v in hs[String(describing: k).lowercased()] = String(describing: v) }
            let d = data ?? Data()
            let text = binary ? d.base64EncodedString() : KrBrowser.text(d, contentType: hs["content-type"] as? String)
            call.resolve(["status": http?.statusCode ?? 0, "body": text, "headers": hs, "url": resp?.url?.absoluteString ?? urlStr])
        }.resume()
    }

    @objc func setBrightness(_ call: CAPPluginCall) {
        let v = call.getDouble("value") ?? -1
        DispatchQueue.main.async {
            if v >= 0 { UIScreen.main.brightness = CGFloat(max(0.01, min(1.0, v))) }
            call.resolve()
        }
    }

    @objc func getBrightness(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["value": Double(UIScreen.main.brightness)]) }
    }

    @objc func deviceInfo(_ call: CAPPluginCall) {
        call.resolve(["platform": "ios", "version": UIDevice.current.systemVersion, "model": UIDevice.current.model])
    }
}
