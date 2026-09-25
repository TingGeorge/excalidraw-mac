#if os(macOS)
import AppKit
import BridgeCore
import UniformTypeIdentifiers
import WebKit

extension UTType {
    /// .excalidraw files (JSON). Declared in Info.plist.
    static let excalidrawScene = UTType(exportedAs: "io.github.tinggeorge.excalidraw.scene", conformingTo: .json)
}

/// The drawing window (the Excalidraw page) and the document commands (new / open / save / export).
@MainActor
final class CanvasController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler, WKDownloadDelegate
{
    let store: Store
    let window: NSWindow
    let webView: WKWebView
    private var ready = false
    private var whenReady: [() -> Void] = []
    private let dragArea = TitlebarDragArea()
    /// The title bar row the page's top bar shares, centred on the traffic lights.
    static let titlebarHeight: CGFloat = 52

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
        webView = CanvasWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820), configuration: config)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        super.init()

        config.userContentController.add(self, name: "native")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        // The canvas fills the whole window, title bar included: the page puts its menu button,
        // the file name, the tools, Library and Export in the traffic lights' row (see mac.css).
        // A transparent layer over that row drags the window wherever there is no button.
        let container = NSView(frame: webView.frame)
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        dragArea.frame = NSRect(
            x: 0, y: container.bounds.height - Self.titlebarHeight, width: container.bounds.width,
            height: Self.titlebarHeight)
        dragArea.autoresizingMask = [.width, .minYMargin]
        container.addSubview(dragArea)
        window.contentView = container
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .textBackgroundColor
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        // Narrower than this and Excalidraw switches to its phone layout.
        window.minSize = NSSize(width: 820, height: 500)
        window.center()
        _ = window.setFrameAutosaveName("ExcalidrawMainWindow")
        window.isRestorable = false
        positionTrafficLights()
        updateTitle()
        webView.load(URLRequest(url: SchemeHandler.startURL))
    }

    /// Called whenever the drawing window is shown (the app hides the start screen).
    var onShow: (() -> Void)?

    func show() {
        window.makeKeyAndOrderFront(nil)
        positionTrafficLights()
        onShow?()
    }

    /// Moves the traffic lights down so they are centred in the 52 pt row the page's top bar
    /// uses (the same thing Electron's `trafficLightPosition` does). AppKit lays the title bar
    /// out again on resize and full screen changes, so this runs after those too.
    private func positionTrafficLights() {
        guard !window.styleMask.contains(.fullScreen),
            let close = window.standardWindowButton(.closeButton),
            let mini = window.standardWindowButton(.miniaturizeButton),
            let zoom = window.standardWindowButton(.zoomButton),
            let titlebar = close.superview?.superview
        else { return }
        var frame = titlebar.frame
        frame.size.height = Self.titlebarHeight
        frame.origin.y = window.frame.height - Self.titlebarHeight
        titlebar.frame = frame
        let spacing = mini.frame.minX - close.frame.minX
        for (index, button) in [close, mini, zoom].enumerated() {
            button.setFrameOrigin(
                NSPoint(x: 20 + CGFloat(index) * spacing, y: (Self.titlebarHeight - button.frame.height) / 2))
        }
    }

    func windowDidResize(_ notification: Notification) { positionTrafficLights() }
    func windowDidBecomeKey(_ notification: Notification) { positionTrafficLights() }
    func windowDidEnterFullScreen(_ notification: Notification) { sendDocumentInfo() }
    func windowDidExitFullScreen(_ notification: Notification) {
        positionTrafficLights()
        sendDocumentInfo()
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
            updateTitle()
        case "autosave":
            if let scene = body["scene"] as? String { store.saveAutosave(scene: scene, theme: body["theme"] as? String) }
        case "library":
            if let items = body["items"] as? String { store.saveLibrary(items) }
        case "titlebarHoles":
            let rects = body["rects"] as? [[Double]] ?? []
            dragArea.holes = rects.compactMap { r in
                r.count == 4 ? NSRect(x: r[0], y: r[1], width: r[2], height: r[3]) : nil
            }
        case "exportMenu":
            let x = body["x"] as? Double ?? 0
            let y = body["y"] as? Double ?? 0
            let menu = NSMenu()
            for (title, format) in [
                (L10n.t("Export as PNG…", "匯出為 PNG…"), "png"), (L10n.t("Export as SVG…", "匯出為 SVG…"), "svg"),
            ] {
                menu.addItem(ClosureMenuItem(title: title) { [weak self] in self?.exportImage(format: format) })
            }
            // WKWebView is flipped: page coordinates map directly.
            menu.popUp(positioning: nil, at: NSPoint(x: x, y: y), in: webView)
        case "appearance":
            let dark = (body["theme"] as? String) == "dark"
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            if let hex = body["background"] as? String, let color = NSColor(hex: hex) {
                window.backgroundColor = color
            }
        case "menu":
            switch body["action"] as? String {
            case "new": createDocument()
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
    //
    // Every drawing is a file the user chose: New asks for a folder and a name and creates the
    // file right away; only ⌘S writes to it. Agents edit the canvas but never save or open files.

    /// Called when a drawing is opened or closed (the app shows / hides the start screen).
    var onDocumentChanged: (() -> Void)?

    var hasDocument: Bool { store.currentFile != nil }

    var displayName: String {
        store.currentFile?.lastPathComponent ?? "Excalidraw"
    }

    /// The page shows the file name and folder in the title bar row; the window title (hidden)
    /// is still set for the Window menu and Mission Control.
    func updateTitle() {
        window.title = store.currentFile?.deletingPathExtension().lastPathComponent ?? "Excalidraw"
        window.representedURL = store.currentFile
        window.isDocumentEdited = store.dirty
        sendDocumentInfo()
    }

    private func sendDocumentInfo() {
        var info: [String: JSON] = ["fullscreen": .bool(window.styleMask.contains(.fullScreen))]
        if let file = store.currentFile {
            info["name"] = .string(file.deletingPathExtension().lastPathComponent)
            info["folder"] = .string((file.deletingLastPathComponent().path as NSString).abbreviatingWithTildeInPath)
        }
        call("set_document_info", .object(info)) { _ in }
    }

    /// Shows or hides the "AI agent connected" indicator on the canvas.
    func setAgentConnected(_ connected: Bool) {
        call("set_agent_status", ["connected": .bool(connected)]) { _ in }
    }

    /// Before closing the drawing or replacing it with another one: offer to save unsaved
    /// changes. true = go ahead ("Save" succeeded or "Don't Save").
    func confirmClosing(completion: @escaping (Bool) -> Void) {
        guard hasDocument, store.dirty else { return completion(true) }
        let alert = NSAlert()
        alert.messageText = L10n.t(
            "Do you want to save the changes made to “\(displayName)”?", "要儲存對「\(displayName)」所做的變更嗎？")
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

    /// File > New: pick a folder and a name, create the file there, open it.
    func createDocument() {
        confirmClosing { ok in
            guard ok else { return }
            let panel = NSSavePanel()
            panel.title = L10n.t("New Excalidraw File", "新增 Excalidraw 檔案")
            panel.message = L10n.t("Choose a folder and a name for your drawing.", "選擇要存放繪圖的資料夾，並輸入檔名。")
            panel.prompt = L10n.t("Create", "建立")
            panel.allowedContentTypes = [.excalidrawScene]
            panel.canCreateDirectories = true
            panel.nameFieldStringValue = "\(L10n.t("Untitled", "未命名")).excalidraw"
            panel.begin { response in
                guard response == .OK, let url = panel.url else { return }
                do {
                    try Data(Self.emptyScene.utf8).write(to: url, options: .atomic)
                } catch {
                    return self.showError(
                        BridgeError(
                            L10n.t(
                                "Could not create \(url.path): \(error.localizedDescription)",
                                "無法建立 \(url.path)：\(error.localizedDescription)")))
                }
                self.open(url) { error in if let error { self.showError(error) } }
            }
        }
    }

    static let emptyScene = """
        {"type":"excalidraw","version":2,"source":"Excalidraw for Mac","elements":[],\
        "appState":{"gridSize":20,"viewBackgroundColor":"#ffffff"},"files":{}}
        """

    /// File > Open.
    func openDocument() {
        confirmClosing { ok in
            guard ok else { return }
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.excalidrawScene, .json]
            panel.allowsMultipleSelection = false
            panel.begin { response in
                guard response == .OK, let url = panel.url else { return }
                self.open(url) { error in if let error { self.showError(error) } }
            }
        }
    }

    /// Shows `url` in the canvas (callers ask about unsaved changes first). If the app was killed
    /// while this file had unsaved changes, those changes come back (still unsaved).
    func open(_ url: URL, completion: @escaping (BridgeError?) -> Void) {
        let recovered = store.recoveredScene(for: url)
        let text: String
        if let recovered {
            text = recovered
        } else {
            do {
                text = try String(contentsOf: url, encoding: .utf8)
            } catch {
                return completion(
                    BridgeError(
                        L10n.t(
                            "Could not read \(url.path): \(error.localizedDescription)",
                            "無法讀取 \(url.path)：\(error.localizedDescription)")))
            }
        }
        call("load_scene_json", ["json": .string(text), "dirty": .bool(recovered != nil)]) { result in
            switch result {
            case .success:
                self.store.documentOpened(url, dirty: recovered != nil)
                if recovered == nil { self.refreshThumbnail() }
                self.updateTitle()
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
                self.show()
                self.onDocumentChanged?()
                if recovered != nil {
                    let alert = NSAlert()
                    alert.messageText = L10n.t("Unsaved changes restored", "已恢復未儲存的變更")
                    alert.informativeText = L10n.t(
                        "Excalidraw quit before you saved “\(url.lastPathComponent)”. Your changes are back; press ⌘S to save them.",
                        "Excalidraw 在你儲存「\(url.lastPathComponent)」之前就結束了。變更已經恢復，按 ⌘S 儲存。")
                    alert.beginSheetModal(for: self.window)
                }
                completion(nil)
            case .failure(let error):
                completion(
                    BridgeError(
                        L10n.t(
                            "\(url.lastPathComponent) is not an Excalidraw drawing (\(error))",
                            "\(url.lastPathComponent) 不是 Excalidraw 繪圖檔（\(error)）")))
            }
        }
    }

    /// Closes the drawing (after asking about unsaved changes) and goes back to the start screen.
    func closeDocument(completion: ((Bool) -> Void)? = nil) {
        confirmClosing { ok in
            guard ok else {
                completion?(false)
                return
            }
            self.store.documentClosed()
            self.window.orderOut(nil)
            self.updateTitle()
            self.call("new_scene") { _ in }
            self.onDocumentChanged?()
            completion?(true)
        }
    }

    func save(completion: ((Bool) -> Void)? = nil) {
        guard let url = store.currentFile else {
            completion?(false)
            return
        }
        write(to: url) { error in
            if let error { self.showError(error) }
            completion?(error == nil)
        }
    }

    func saveAs(completion: ((Bool) -> Void)? = nil) {
        guard hasDocument else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.excalidrawScene]
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = displayName
        panel.directoryURL = store.currentFile?.deletingLastPathComponent()
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

    /// Saves the canvas to `url`, which becomes the open file.
    private func write(to url: URL, completion: @escaping (BridgeError?) -> Void) {
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
                            L10n.t(
                                "Could not save \(url.path): \(error.localizedDescription)",
                                "無法儲存 \(url.path)：\(error.localizedDescription)")))
                }
                self.call("mark_saved") { _ in
                    self.store.documentOpened(url, dirty: false)
                    self.refreshThumbnail()
                    self.updateTitle()
                    NSDocumentController.shared.noteNewRecentDocumentURL(url)
                    completion(nil)
                }
            }
        }
    }

    /// Updates the start screen's preview of the open file (an empty drawing has none).
    private func refreshThumbnail() {
        guard let file = store.currentFile else { return }
        call("export_image", ["format": "png", "max_size": 480, "background": true, "padding": 32]) { result in
            let png = (try? result.get())?["base64"]?.string.flatMap { Data(base64Encoded: $0) }
            self.store.saveThumbnail(png, for: file)
        }
    }

    func exportImage(format: String) {
        guard hasDocument else { return }
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
                panel.directoryURL = self.store.currentFile?.deletingLastPathComponent()
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

    /// Writes the recovery copy (when the app is killed). Gives up after 3 s so a stuck page
    /// can never prevent quitting.
    func flushAutosave(completion: @escaping () -> Void) {
        final class Once { var done = false }
        let once = Once()
        let finish = {
            guard !once.done else { return }
            once.done = true
            self.store.flush()
            completion()
        }
        guard ready, hasDocument else { return finish() }
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
        if window.isVisible {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }

    // MARK: NSWindowDelegate

    /// Closing the window closes the drawing and returns to the start screen.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeDocument()
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

/// The page's web view. It never moves the window itself (the drag area does that).
private final class CanvasWebView: WKWebView {
    override var mouseDownCanMoveWindow: Bool { false }
}

/// Covers the title bar row. Clicks on the page's buttons there (the "holes" the page reports)
/// go through to the page; anywhere else drags the window, and a double-click zooms or
/// minimises it as set in System Settings.
private final class TitlebarDragArea: NSView {
    var holes: [NSRect] = []

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard bounds.contains(local), !holes.contains(where: { $0.contains(local) }) else { return nil }
        return self
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
        } else {
            window.performDrag(with: event)
        }
    }
}

/// A menu item that runs a closure.
final class ClosureMenuItem: NSMenuItem {
    private let run: () -> Void

    init(title: String, run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(perform(_:)), keyEquivalent: "")
        target = self
    }

    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func perform(_ sender: Any?) { run() }
}

extension NSColor {
    /// "#rrggbb" -> colour (sRGB).
    convenience init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(
            srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }
}
#endif
