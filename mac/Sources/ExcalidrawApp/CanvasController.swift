#if os(macOS)
import AppKit
import BridgeCore
import UniformTypeIdentifiers
import WebKit

extension UTType {
    /// .excalidraw files (JSON). Declared in Info.plist.
    static let excalidrawScene = UTType(exportedAs: "io.github.tinggeorge.excalidraw.scene", conformingTo: .json)
}

/// The window with the Excalidraw page, and the document commands (new / open / save / export).
@MainActor
final class CanvasController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler, WKDownloadDelegate
{
    let store: Store
    let window: NSWindow
    let webView: WKWebView
    /// Set once the user agreed to close the window, so quitting doesn't ask again.
    private(set) var closeConfirmed = false

    private var ready = false
    private var whenReady: [() -> Void] = []

    init(store: Store) {
        self.store = store
        let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(
            SchemeHandler(root: webRoot, session: { store.sessionJSON() }), forURLScheme: SchemeHandler.scheme)
        let language = JSON.string(Locale.preferredLanguages.first ?? "en").text
        config.userContentController.addUserScript(
            WKUserScript(
                source: "window.__NATIVE_LANG__ = \(language);", injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820), configuration: config)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        super.init()

        config.userContentController.add(self, name: "native")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 600, height: 400)
        window.center()
        _ = window.setFrameAutosaveName("ExcalidrawMainWindow")
        updateTitle()
        webView.load(URLRequest(url: SchemeHandler.startURL))
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: Calling the page

    /// Runs a bridge method in the page once it is ready; `completion` gets the reply envelope
    /// {"ok":true,"result":…} / {"ok":false,"error":"…"} as JSON text.
    func callRaw(_ method: String, _ params: String, completion: @escaping (String) -> Void) {
        let run = { [weak self] in
            guard let self else { return }
            self.webView.callAsyncJavaScript(
                "return await window.excalidrawBridge.handle(m, p);", arguments: ["m": method, "p": params],
                in: nil, in: .page
            ) { result in
                switch result {
                case .success(let value):
                    completion(value as? String ?? Self.errorEnvelope("empty reply from the page"))
                case .failure(let error):
                    completion(Self.errorEnvelope(error.localizedDescription))
                }
            }
        }
        if ready { run() } else { whenReady.append(run) }
    }

    func call(_ method: String, _ params: JSON = [:], completion: @escaping (Result<JSON, BridgeError>) -> Void) {
        callRaw(method, params.text) { envelope in
            guard let reply = try? JSON.parse(envelope) else {
                return completion(.failure(BridgeError("unreadable reply from the page")))
            }
            if reply["ok"]?.bool == true {
                completion(.success(reply["result"] ?? .null))
            } else {
                completion(.failure(BridgeError(reply["error"]?.string ?? "unknown error")))
            }
        }
    }

    private static func errorEnvelope(_ message: String) -> String {
        (["ok": false, "error": .string(message)] as JSON).text
    }

    // MARK: Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            let queued = whenReady
            whenReady = []
            queued.forEach { $0() }
        case "dirty":
            store.setDirty(body["value"] as? Bool ?? false)
            window.isDocumentEdited = store.dirty
        case "autosave":
            if let scene = body["scene"] as? String { store.saveAutosave(scene: scene, theme: body["theme"] as? String) }
        case "library":
            if let items = body["items"] as? String { store.saveLibrary(items) }
        case "menu":
            switch body["action"] as? String {
            case "new": newDocument()
            case "open": openDocument()
            case "save": save()
            case "saveAs": saveAs()
            default: break
            }
        default:
            break
        }
    }

    // MARK: Document commands

    var displayName: String {
        store.currentFile?.lastPathComponent ?? L10n.t("Untitled", "未命名")
    }

    func updateTitle() {
        window.title = displayName
        window.representedURL = store.currentFile
        window.isDocumentEdited = store.dirty
    }

    /// Before replacing the canvas (new / open): offer to save unsaved changes. true = go ahead.
    func confirmReplacing(completion: @escaping (Bool) -> Void) {
        guard store.dirty else { return completion(true) }
        let message =
            store.currentFile == nil
            ? L10n.t("Save the current drawing first?", "要先儲存目前的繪圖嗎？")
            : L10n.t("Do you want to save the changes made to “\(displayName)”?", "要儲存對「\(displayName)」所做的變更嗎？")
        askToSave(message, completion: completion)
    }

    /// Before closing / quitting. Untitled drawings are autosaved and come back next time,
    /// so only drawings that belong to a file ask.
    func confirmClosing(completion: @escaping (Bool) -> Void) {
        guard store.dirty, store.currentFile != nil else { return completion(true) }
        askToSave(
            L10n.t("Do you want to save the changes made to “\(displayName)”?", "要儲存對「\(displayName)」所做的變更嗎？"),
            completion: completion)
    }

    private func askToSave(_ message: String, completion: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = L10n.t("Your changes will be lost if you don't save them.", "如果不儲存，變更將會遺失。")
        alert.addButton(withTitle: L10n.t("Save", "儲存"))
        alert.addButton(withTitle: L10n.t("Cancel", "取消"))
        alert.addButton(withTitle: L10n.t("Don't Save", "不儲存"))
        show()
        alert.beginSheetModal(for: window) { response in
            switch response {
            case .alertFirstButtonReturn: self.save { saved in completion(saved) }
            case .alertThirdButtonReturn: completion(true)
            default: completion(false)
            }
        }
    }

    func newDocument() {
        confirmReplacing { ok in
            guard ok else { return }
            self.call("new_scene") { _ in
                self.store.setCurrentFile(nil)
                self.store.setDirty(false)
                self.updateTitle()
            }
        }
    }

    func openDocument() {
        confirmReplacing { ok in
            guard ok else { return }
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.excalidrawScene, .json]
            panel.allowsMultipleSelection = false
            panel.beginSheetModal(for: self.window) { response in
                guard response == .OK, let url = panel.url else { return }
                self.open(url) { error in if let error { self.showError(error) } }
            }
        }
    }

    /// Replaces the canvas with a file (no questions asked; callers confirm first).
    func open(_ url: URL, completion: @escaping (BridgeError?) -> Void) {
        let text: String
        do {
            text = try String(contentsOf: url, encoding: .utf8)
        } catch {
            return completion(
                BridgeError(
                    L10n.t("Could not read \(url.path): \(error.localizedDescription)", "無法讀取 \(url.path)：\(error.localizedDescription)")))
        }
        call("load_scene_json", ["json": .string(text)]) { result in
            switch result {
            case .success:
                self.store.setCurrentFile(url)
                self.store.setDirty(false)
                self.updateTitle()
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
                completion(nil)
            case .failure(let error):
                completion(BridgeError(L10n.t("\(url.lastPathComponent) is not an Excalidraw drawing (\(error))", "\(url.lastPathComponent) 不是 Excalidraw 繪圖檔（\(error)）")))
            }
        }
    }

    func save(completion: ((Bool) -> Void)? = nil) {
        guard let url = store.currentFile else { return saveAs(completion: completion) }
        write(to: url) { error in
            if let error { self.showError(error) }
            completion?(error == nil)
        }
    }

    func saveAs(completion: ((Bool) -> Void)? = nil) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.excalidrawScene]
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = store.currentFile?.lastPathComponent ?? "\(L10n.t("Untitled", "未命名")).excalidraw"
        show()
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else {
                completion?(false)
                return
            }
            self.write(to: url) { error in
                if let error { self.showError(error) }
                completion?(error == nil)
            }
        }
    }

    /// Saves the canvas to `url`, which becomes the current document.
    func write(to url: URL, completion: @escaping (BridgeError?) -> Void) {
        call("get_scene_json") { result in
            switch result {
            case .failure(let error):
                completion(error)
            case .success(let reply):
                do {
                    try Data((reply["json"]?.string ?? "").utf8).write(to: url, options: .atomic)
                } catch {
                    return completion(
                        BridgeError(
                            L10n.t("Could not save \(url.path): \(error.localizedDescription)", "無法儲存 \(url.path)：\(error.localizedDescription)")))
                }
                self.call("mark_saved") { _ in
                    self.store.setCurrentFile(url)
                    self.store.setDirty(false)
                    self.updateTitle()
                    NSDocumentController.shared.noteNewRecentDocumentURL(url)
                    completion(nil)
                }
            }
        }
    }

    func exportImage(format: String) {
        call("export_image", ["format": .string(format), "scale": 2, "background": true]) { result in
            switch result {
            case .failure(let error):
                self.showError(error)
            case .success(let reply):
                let data =
                    format == "svg"
                    ? reply["text"]?.string.map { Data($0.utf8) }
                    : reply["base64"]?.string.flatMap { Data(base64Encoded: $0) }
                guard let data else { return }
                let panel = NSSavePanel()
                panel.allowedContentTypes = [format == "svg" ? .svg : .png]
                panel.canCreateDirectories = true
                let base = self.store.currentFile?.deletingPathExtension().lastPathComponent ?? "Excalidraw"
                panel.nameFieldStringValue = "\(base).\(format)"
                panel.beginSheetModal(for: self.window) { response in
                    guard response == .OK, let url = panel.url else { return }
                    do {
                        try data.write(to: url, options: .atomic)
                    } catch {
                        self.showError(BridgeError(error.localizedDescription))
                    }
                }
            }
        }
    }

    /// Writes the latest canvas to the autosave file (before quitting). Gives up after 3 s
    /// so a stuck page can never prevent quitting.
    func flushAutosave(completion: @escaping () -> Void) {
        final class Once { var done = false }
        let once = Once()
        let finish = {
            guard !once.done else { return }
            once.done = true
            self.store.flush()
            completion()
        }
        guard ready else { return finish() }
        call("get_autosave") { result in
            if case .success(let r) = result, let scene = r["scene"]?.string {
                self.store.saveAutosave(scene: scene, theme: r["theme"]?.string)
            }
            finish()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish() }
    }

    func showError(_ error: BridgeError) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n.t("Something went wrong", "發生錯誤")
        alert.informativeText = error.description
        show()
        alert.beginSheetModal(for: window)
    }

    // MARK: NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeConfirmed { return true }
        confirmClosing { ok in
            guard ok else { return }
            self.flushAutosave {
                self.closeConfirmed = true
                self.window.close()
            }
        }
        return false
    }

    // MARK: Navigation: keep the page local, open links in the browser, handle downloads

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async
        -> WKNavigationActionPolicy
    {
        if navigationAction.shouldPerformDownload { return .download }
        guard let url = navigationAction.request.url else { return .cancel }
        let scheme = url.scheme?.lowercased() ?? ""
        if [SchemeHandler.scheme, "about", "blob", "data"].contains(scheme) { return .allow }
        // Embedded videos / websites inside the drawing (only work when online).
        if navigationAction.targetFrame?.isMainFrame == false { return .allow }
        if ["http", "https", "mailto"].contains(scheme) { NSWorkspace.shared.open(url) }
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async
        -> WKNavigationResponsePolicy
    {
        navigationResponse.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        webView.load(URLRequest(url: SchemeHandler.startURL))
    }

    /// Excalidraw's own "Export image" dialog saves through a download: ask where to put it.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String)
        async -> URL?
    {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        show()
        guard await panel.beginSheetModal(for: window) == .OK, let url = panel.url else { return nil }
        try? FileManager.default.removeItem(at: url)  // the panel already asked about replacing it
        return url
    }

    // MARK: WKUIDelegate

    /// Links that open a new window (target=_blank) go to the default browser.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    /// <input type=file>: inserting images, importing libraries.
    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo
    ) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        guard await panel.beginSheetModal(for: window) == .OK else { return nil }
        return panel.urls
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        _ = await alert.beginSheetModal(for: window)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async
        -> Bool
    {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: L10n.t("OK", "好"))
        alert.addButton(withTitle: L10n.t("Cancel", "取消"))
        return await alert.beginSheetModal(for: window) == .alertFirstButtonReturn
    }
}
#endif
