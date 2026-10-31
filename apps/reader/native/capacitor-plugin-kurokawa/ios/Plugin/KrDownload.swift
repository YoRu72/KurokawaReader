import Foundation
import Capacitor
import UIKit

/// A file fetched to the cache by URLSession, its progress reported as it comes (downloadProgress events:
/// {id, got, total, speed, pct}), the app asked to stay awake for it when it goes behind the lock screen. The iOS
/// counterpart of downloadFile / cancelDownload / deleteDownload in KurokawaPlugin.java.
///   downloadFile {id, url, name, headers?, persist?} → {path: file://…, size}
///   cancelDownload {id}
final class KrDownload: NSObject, URLSessionDownloadDelegate {
    private static var running: [String: KrDownload] = [:]
    private static let lock = NSLock()

    private let call: CAPPluginCall
    private let id: String
    private let dest: URL
    private let emit: (String, [String: Any]) -> Void
    private var session: URLSession!
    private var task: URLSessionDownloadTask?
    private var background = UIBackgroundTaskIdentifier.invalid
    private var lastAt = Date(), lastGot: Int64 = 0, speed: Double = 0

    private init(call: CAPPluginCall, id: String, dest: URL, emit: @escaping (String, [String: Any]) -> Void) {
        self.call = call; self.id = id; self.dest = dest; self.emit = emit
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = HTTPCookieStorage.shared
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 3600
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    static func start(_ call: CAPPluginCall, emit: @escaping (String, [String: Any]) -> Void) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else { call.reject("url required"); return }
        let id = call.getString("id") ?? UUID().uuidString
        let name = (call.getString("name") ?? "download.bin").replacingOccurrences(of: "/", with: "_")
        let persist = call.getBool("persist") ?? false
        let base = FileManager.default.urls(for: persist ? .applicationSupportDirectory : .cachesDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent(persist ? "downloads" : "kr-update", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let d = KrDownload(call: call, id: id, dest: dir.appendingPathComponent(name), emit: emit)
        lock.lock(); running[id] = d; lock.unlock()
        var req = URLRequest(url: url)
        if let headers = call.getObject("headers") { for (k, v) in headers { if let s = v as? String { req.setValue(s, forHTTPHeaderField: k) } } }
        if req.value(forHTTPHeaderField: "User-Agent") == nil { req.setValue(KrDownload.userAgent, forHTTPHeaderField: "User-Agent") }
        d.background = UIApplication.shared.beginBackgroundTask(withName: "kr-download") { [weak d] in d?.finish(nil, "the system ended the download") }
        d.task = d.session.downloadTask(with: req)
        d.task?.resume()
    }

    static func cancel(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        lock.lock(); let d = running[id]; lock.unlock()
        d?.task?.cancel()
        d?.finish(nil, "cancelled")
        call.resolve()
    }

    /// The web view's identity, so a site sees the same visitor as the app's pages.
    static var userAgent: String = {
        let v = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? ""
        return "Mozilla/5.0 (iPhone; CPU iPhone OS \(UIDevice.current.systemVersion.replacingOccurrences(of: ".", with: "_")) like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(UIDevice.current.systemVersion) Mobile/15E148 Safari/604.1 KurokawaReader/\(v)"
    }()

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let now = Date(); let dt = now.timeIntervalSince(lastAt)
        if dt < 0.3 { return }
        speed = speed * 0.5 + 0.5 * Double(totalBytesWritten - lastGot) / dt
        lastAt = now; lastGot = totalBytesWritten
        let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : -1
        emit("downloadProgress", ["id": id, "got": totalBytesWritten, "total": total, "speed": speed, "pct": total > 0 ? Int(totalBytesWritten * 100 / total) : 0])
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        if let r = downloadTask.response as? HTTPURLResponse, r.statusCode >= 400 { finish(nil, "HTTP \(r.statusCode)"); return }
        do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: location, to: dest)
            let size = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int64) ?? 0
            emit("downloadProgress", ["id": id, "got": size, "total": size, "speed": 0, "pct": 100])
            finish(dest, nil, size: size)
        } catch { finish(nil, error.localizedDescription) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error { finish(nil, (error as NSError).code == NSURLErrorCancelled ? "cancelled" : error.localizedDescription) }
    }

    private var done = false
    private func finish(_ file: URL?, _ why: String?, size: Int64 = 0) {
        KrDownload.lock.lock()
        if done { KrDownload.lock.unlock(); return }
        done = true
        KrDownload.running.removeValue(forKey: id)
        KrDownload.lock.unlock()
        session.finishTasksAndInvalidate()
        if background != .invalid { UIApplication.shared.endBackgroundTask(background); background = .invalid }
        if let file = file { call.resolve(["path": file.absoluteString, "size": size]) }
        else { call.reject("Download failed: \(why ?? "failed")") }
    }
}
