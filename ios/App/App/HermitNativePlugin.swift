import Capacitor
import Foundation
import Security
import UIKit
import UniformTypeIdentifiers
import WebKit

/**
 * What the web app needs from iOS that Capacitor's own plugins don't offer: file calls that fail with
 * POSIX codes (so the library and git code can treat them like Node's), access to a folder the user picks
 * (such as one in iCloud Drive), the keychain, PDF printing and background time.
 */
@objc(HermitNativePlugin)
public class HermitNativePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "HermitNativePlugin"
    public let jsName = "HermitNative"
    public let pluginMethods: [CAPPluginMethod] = [
        "readFile", "writeFile", "readdir", "stat", "mkdir", "rename", "unlink", "rmdir", "remove",
        "documentsPath", "supportPath", "pickFolder", "restoreFolder", "forgetFolder", "downloadFolder",
        "getSecret", "setSecret", "deleteSecret", "printPdf", "beginBackgroundTask", "endBackgroundTask"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private static let bookmarkKey = "libraryFolderBookmark"
    private static let keychainService = "com.hermitcrab.app"

    /** Files run off the bridge's queue, so a slow read from iCloud doesn't hold up other plugins. */
    private let files = DispatchQueue(label: "com.hermitcrab.files", qos: .userInitiated, attributes: .concurrent)
    /** The folder the user picked, while the app has access to it. */
    private var folder: URL?
    private var pickCall: CAPPluginCall?
    private var printJobs: [PdfJob] = []

    // MARK: - Errors

    private static let errnoNames: [Int32: String] = [
        ENOENT: "ENOENT", EEXIST: "EEXIST", ENOTDIR: "ENOTDIR", EISDIR: "EISDIR", ENOTEMPTY: "ENOTEMPTY",
        EACCES: "EACCES", EPERM: "EPERM", EBUSY: "EBUSY", EINVAL: "EINVAL", ENOSPC: "ENOSPC", EXDEV: "EXDEV"
    ]

    private struct FileError: Error {
        let code: String
        let message: String
    }

    private func posixError(_ number: Int32, _ path: String) -> FileError {
        let name = Self.errnoNames[number] ?? "EIO"
        return FileError(code: name, message: "\(name): \(String(cString: strerror(number))), '\(path)'")
    }

    /** Foundation's errors, as the POSIX codes they stand for. */
    private func fileError(_ error: Error, _ path: String) -> FileError {
        if let error = error as? FileError { return error }
        let ns = error as NSError
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSPOSIXErrorDomain {
            return posixError(Int32(underlying.code), path)
        }
        if ns.domain == NSPOSIXErrorDomain { return posixError(Int32(ns.code), path) }
        if ns.domain == NSCocoaErrorDomain {
            switch ns.code {
            case NSFileNoSuchFileError, NSFileReadNoSuchFileError: return posixError(ENOENT, path)
            case NSFileReadNoPermissionError, NSFileWriteNoPermissionError: return posixError(EACCES, path)
            case NSFileWriteFileExistsError: return posixError(EEXIST, path)
            case NSFileWriteOutOfSpaceError: return posixError(ENOSPC, path)
            default: break
            }
        }
        return FileError(code: "EIO", message: ns.localizedDescription)
    }

    /** Run file work off the bridge's queue and answer the call with its result or its error. */
    private func run(_ call: CAPPluginCall, _ path: String, _ work: @escaping () throws -> [String: Any]?) {
        files.async {
            do {
                if let result = try work() { call.resolve(result) } else { call.resolve() }
            } catch {
                let failure = self.fileError(error, path)
                call.reject(failure.message, failure.code)
            }
        }
    }

    private func check(_ result: Int32, _ path: String) throws {
        if result != 0 { throw posixError(errno, path) }
    }

    private func requirePath(_ call: CAPPluginCall, _ key: String = "path") -> String? {
        guard let path = call.getString(key), path.hasPrefix("/") else {
            call.reject("An absolute path is needed.", "EINVAL")
            return nil
        }
        return path
    }

    // MARK: - Files

    /** Whether a path is in the picked folder, where other apps (and iCloud) may be working too. */
    private func isShared(_ path: String) -> Bool {
        guard let folder = folder else { return false }
        return path == folder.path || path.hasPrefix(folder.path + "/")
    }

    /** Read or write through a file coordinator in the picked folder, which also downloads files from iCloud. */
    private func coordinate(_ url: URL, writing: Bool, _ work: (URL) throws -> Void) throws {
        guard isShared(url.path) else { return try work(url) }
        var coordinationError: NSError?
        var workError: Error?
        let coordinator = NSFileCoordinator()
        if writing {
            coordinator.coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { url in
                do { try work(url) } catch { workError = error }
            }
        } else {
            coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { url in
                do { try work(url) } catch { workError = error }
            }
        }
        if let error = workError ?? coordinationError { throw error }
    }

    private func entry(_ path: String, name: String) throws -> [String: Any] {
        var info = Darwin.stat()
        try check(lstat(path, &info), path)
        let kind = info.st_mode & S_IFMT
        let millis = { (t: timespec) in Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1_000_000 }
        return [
            "name": name,
            "type": kind == S_IFREG ? "file" : kind == S_IFDIR ? "directory" : "other",
            "size": Int(info.st_size),
            "mtime": millis(info.st_mtimespec),
            "ctime": millis(info.st_ctimespec)
        ]
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let path = requirePath(call) else { return }
        let utf8 = call.getString("encoding") == "utf8"
        run(call, path) {
            var data = Data()
            try self.coordinate(URL(fileURLWithPath: path), writing: false) { data = try Data(contentsOf: $0) }
            if !utf8 { return ["data": data.base64EncodedString()] }
            guard let text = String(data: data, encoding: .utf8) else {
                throw FileError(code: "EILSEQ", message: "'\(path)' isn't UTF-8 text.")
            }
            return ["data": text]
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        guard let path = requirePath(call), let raw = call.getString("data") else { return }
        let utf8 = call.getString("encoding") == "utf8"
        run(call, path) {
            guard let data = utf8 ? raw.data(using: .utf8) : Data(base64Encoded: raw) else {
                throw FileError(code: "EINVAL", message: "The data to write to '\(path)' can't be read.")
            }
            try self.coordinate(URL(fileURLWithPath: path), writing: true) { try data.write(to: $0, options: .atomic) }
            return nil
        }
    }

    @objc func readdir(_ call: CAPPluginCall) {
        guard let path = requirePath(call) else { return }
        run(call, path) {
            var info = Darwin.stat()
            try self.check(lstat(path, &info), path)
            if info.st_mode & S_IFMT != S_IFDIR { throw self.posixError(ENOTDIR, path) }
            let names = try FileManager.default.contentsOfDirectory(atPath: path)
            let entries: [[String: Any]] = names.compactMap { name in
                // Older iCloud Drive keeps files it hasn't downloaded as `.<name>.icloud` placeholders.
                if name.hasPrefix("."), name.hasSuffix(".icloud"), name.count > 8 {
                    let real = String(name.dropFirst().dropLast(7))
                    guard var placeholder = try? self.entry(path + "/" + name, name: real) else { return nil }
                    placeholder["type"] = "file"
                    return placeholder
                }
                return try? self.entry(path + "/" + name, name: name)
            }
            return ["entries": entries]
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        guard let path = requirePath(call) else { return }
        run(call, path) { try self.entry(path, name: (path as NSString).lastPathComponent) }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        guard let path = requirePath(call) else { return }
        let recursive = call.getBool("recursive", false)
        run(call, path) {
            if recursive {
                try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
            } else {
                try self.check(Darwin.mkdir(path, 0o755), path)
            }
            return nil
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        guard let from = requirePath(call, "from"), let to = requirePath(call, "to") else { return }
        run(call, from) {
            guard self.isShared(from) || self.isShared(to) else {
                try self.check(Darwin.rename(from, to), from)
                return nil
            }
            let source = URL(fileURLWithPath: from)
            let target = URL(fileURLWithPath: to)
            var coordinationError: NSError?
            var moveError: Error?
            NSFileCoordinator().coordinate(
                writingItemAt: source, options: .forMoving, writingItemAt: target, options: .forReplacing,
                error: &coordinationError
            ) { source, target in
                if Darwin.rename(source.path, target.path) != 0 { moveError = self.posixError(errno, from) }
            }
            if let error = moveError ?? coordinationError { throw error }
            return nil
        }
    }

    @objc func unlink(_ call: CAPPluginCall) {
        guard let path = requirePath(call) else { return }
        run(call, path) {
            try self.check(Darwin.unlink(path), path)
            return nil
        }
    }

    @objc func rmdir(_ call: CAPPluginCall) {
        guard let path = requirePath(call) else { return }
        run(call, path) {
            try self.check(Darwin.rmdir(path), path)
            return nil
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let path = requirePath(call) else { return }
        run(call, path) {
            var info = Darwin.stat()
            if lstat(path, &info) != 0 && errno == ENOENT { return nil }
            try self.coordinate(URL(fileURLWithPath: path), writing: true) { try FileManager.default.removeItem(at: $0) }
            return nil
        }
    }

    // MARK: - Library location

    @objc func documentsPath(_ call: CAPPluginCall) {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        call.resolve(["path": url.path])
    }

    @objc func supportPath(_ call: CAPPluginCall) {
        do {
            let url = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
            )
            call.resolve(["path": url.path])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func pickFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController, self.pickCall == nil else {
                call.reject("A folder is already being chosen.")
                return
            }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.pickCall = call
            presenter.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall else { return }
        pickCall = nil
        guard let url = urls.first, url.startAccessingSecurityScopedResource() else {
            call.reject("Hermit Crab can’t open that folder.")
            return
        }
        do {
            let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            UserDefaults.standard.set(bookmark, forKey: Self.bookmarkKey)
        } catch {
            url.stopAccessingSecurityScopedResource()
            call.reject("Hermit Crab can’t keep access to that folder: \(error.localizedDescription)")
            return
        }
        if let previous = folder, previous != url { previous.stopAccessingSecurityScopedResource() }
        folder = url
        call.resolve(["path": url.path])
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.resolve(["path": NSNull()])
        pickCall = nil
    }

    @objc func restoreFolder(_ call: CAPPluginCall) {
        guard let bookmark = UserDefaults.standard.data(forKey: Self.bookmarkKey) else {
            call.resolve(["path": NSNull()])
            return
        }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale),
              url.startAccessingSecurityScopedResource() else {
            call.resolve(["path": NSNull()])
            return
        }
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(fresh, forKey: Self.bookmarkKey)
        }
        if let previous = folder, previous != url { previous.stopAccessingSecurityScopedResource() }
        folder = url
        call.resolve(["path": url.path])
    }

    @objc func forgetFolder(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
        folder?.stopAccessingSecurityScopedResource()
        folder = nil
        call.resolve()
    }

    @objc func downloadFolder(_ call: CAPPluginCall) {
        guard let path = requirePath(call) else { return }
        call.resolve()
        DispatchQueue.global(qos: .utility).async {
            let keys: [URLResourceKey] = [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey]
            guard let items = FileManager.default.enumerator(at: URL(fileURLWithPath: path), includingPropertiesForKeys: keys) else {
                return
            }
            for case let url as URL in items {
                guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isUbiquitousItem == true,
                      values.ubiquitousItemDownloadingStatus != .current else { continue }
                try? FileManager.default.startDownloadingUbiquitousItem(at: url)
            }
        }
    }

    // MARK: - Keychain

    private func keychainQuery(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.keychainService, kSecAttrAccount as String: key]
    }

    @objc func getSecret(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("A key is needed.") }
        var query = keychainQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return call.resolve(["value": NSNull()]) }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            return call.reject("The keychain couldn’t be read (\(status)).")
        }
        call.resolve(["value": value])
    }

    @objc func setSecret(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else { return call.reject("A key and value are needed.") }
        let query = keychainQuery(key)
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = Data(value.utf8)
        // Readable after the first unlock, so a sync can finish while the phone is locked.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecSuccess { call.resolve() } else { call.reject("The keychain couldn’t be written (\(status)).") }
    }

    @objc func deleteSecret(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("A key is needed.") }
        SecItemDelete(keychainQuery(key) as CFDictionary)
        call.resolve()
    }

    // MARK: - PDF

    @objc func printPdf(_ call: CAPPluginCall) {
        guard let html = call.getString("html") else { return call.reject("Some HTML is needed.") }
        let margins = call.getObject("margins") ?? [:]
        let inch = { (key: String) in CGFloat((margins[key] as? Double) ?? 0.8) * 72 }
        let insets = UIEdgeInsets(top: inch("top"), left: inch("left"), bottom: inch("bottom"), right: inch("right"))
        let letter = call.getString("paper") == "letter" || Self.usesLetter
        let paper = letter ? CGSize(width: 612, height: 792) : CGSize(width: 595.28, height: 841.89)
        DispatchQueue.main.async {
            let job = PdfJob(paper: paper, margins: insets, host: self.bridge?.viewController?.view) { [weak self] job, result in
                self?.printJobs.removeAll { $0 === job }
                switch result {
                case .success(let path): call.resolve(["path": path])
                case .failure(let error): call.reject(error.localizedDescription)
                }
            }
            self.printJobs.append(job)
            job.start(html: html)
        }
    }

    /** Letter paper where it's the custom; A4 elsewhere. */
    private static var usesLetter: Bool {
        let region = Locale.current.region?.identifier ?? "US"
        return ["US", "CA", "MX", "PH", "CL", "CO", "VE", "PR", "GT", "CR", "PA", "SV", "DO"].contains(region)
    }

    // MARK: - Background time

    @objc func beginBackgroundTask(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var id = UIBackgroundTaskIdentifier.invalid
            id = UIApplication.shared.beginBackgroundTask(withName: "Save and sync") {
                UIApplication.shared.endBackgroundTask(id)
            }
            call.resolve(["id": id.rawValue])
        }
    }

    @objc func endBackgroundTask(_ call: CAPPluginCall) {
        let id = UIBackgroundTaskIdentifier(rawValue: call.getInt("id", UIBackgroundTaskIdentifier.invalid.rawValue))
        DispatchQueue.main.async {
            if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
            call.resolve()
        }
    }
}

/** Lays out an HTML page in a hidden web view and prints it, page by page, into a PDF file. */
private final class PdfJob: NSObject, WKNavigationDelegate {
    private let paper: CGSize
    private let margins: UIEdgeInsets
    private let webView: WKWebView
    private let done: (PdfJob, Result<String, Error>) -> Void

    init(paper: CGSize, margins: UIEdgeInsets, host: UIView?, done: @escaping (PdfJob, Result<String, Error>) -> Void) {
        self.paper = paper
        self.margins = margins
        self.done = done
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        // Out of sight, but in a window, so WebKit lays it out.
        webView = WKWebView(frame: CGRect(x: -10_000, y: 0, width: paper.width, height: paper.height), configuration: configuration)
        webView.isHidden = true
        host?.addSubview(webView)
        super.init()
        webView.navigationDelegate = self
    }

    func start(html: String) {
        webView.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Give fonts and layout a moment to settle.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.render() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    private func render() {
        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)
        let paperRect = CGRect(origin: .zero, size: paper)
        renderer.setValue(NSValue(cgRect: paperRect), forKey: "paperRect")
        renderer.setValue(NSValue(cgRect: paperRect.inset(by: margins)), forKey: "printableRect")

        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paperRect, nil)
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
        let bounds = UIGraphicsGetPDFContextBounds()
        for page in 0..<renderer.numberOfPages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: page, in: bounds)
        }
        UIGraphicsEndPDFContext()

        let file = FileManager.default.temporaryDirectory.appendingPathComponent("hermit-crab-\(UUID().uuidString).pdf")
        do {
            try data.write(to: file, options: .atomic)
            finish(.success(file.path))
        } catch {
            finish(.failure(error))
        }
    }

    private func finish(_ result: Result<String, Error>) {
        webView.navigationDelegate = nil
        webView.removeFromSuperview()
        done(self, result)
    }
}
