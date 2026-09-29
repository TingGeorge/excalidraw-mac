#if os(macOS)
import AppKit
import BridgeCore
import UniformTypeIdentifiers
import WebKit

extension UTType {
    /// .excalidraw files (JSON). Declared in Info.plist.
    static let excalidrawScene = UTType(exportedAs: "io.github.tinggeorge.excalidraw.scene", conformingTo: .json)
}

/// A drawing window (the Excalidraw page with one file) and its document commands (save /
/// export / close). The app has one of these per open file, plus a spare with the page already
/// loaded so the next file opens right away.
@MainActor
final class CanvasController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler, WKDownloadDelegate
{
    let store: Store
    let window: NSWindow
    /// The drawing shown in this window (nil: the spare, not showing anything yet).
    private(set) var file: URL?
    /// Unsaved changes.
    private(set) var dirty = false
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
        let container = CanvasContainerView(frame: webView.frame)
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        dragArea.frame = NSRect(
            x: 0, y: container.bounds.height - Self.titlebarHeight, width: container.bounds.width,
            height: Self.titlebarHeight)
        dragArea.autoresizingMask = [.width, .minYMargin]
        container.addSubview(dragArea)
        window.contentView = container
        container.controller = self
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .textBackgroundColor
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        // The smallest size where the title bar row (menu, file name, tools, Library / Export)
        // fits in one line and the properties panel doesn't need to scroll much.
        window.minSize = NSSize(width: 960, height: 600)
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
        repositionTrafficLights()
        onShow?()
    }

    /// The traffic lights, found anew each time: AppKit may replace them (the zoom button, with
    /// its window tiling menu, on newer macOS).
    var trafficLights: [NSButton] {
        [.closeButton, .miniaturizeButton, .zoomButton].compactMap { window.standardWindowButton($0) }
    }

    /// Moves the traffic lights down so they are centred in the 52 pt row the page's top bar
    /// uses (the same thing Electron's `trafficLightPosition` does). Positions are worked out in
    /// window coordinates, so it doesn't matter which views AppKit keeps the buttons in.
    private func positionTrafficLights() {
        let buttons = trafficLights
        guard !positioningTrafficLights, !window.styleMask.contains(.fullScreen), buttons.count == 3 else { return }
        positioningTrafficLights = true
        defer { positioningTrafficLights = false }
        trafficLightPasses += 1
        watchTrafficLights(buttons)
        if trafficLightSpacing == nil {
            // AppKit's own distance between the buttons, before we move them.
            let x = buttons.map { $0.convert($0.bounds, to: nil).minX }
            let spacing = ((x[2] - x[0]) / 2).rounded()
            trafficLightSpacing = spacing > 10 && spacing < 40 ? spacing : 20
        }
        // The title bar views holding the buttons (just under the window's frame view) cover the
        // whole 52 pt row, so nothing gets clipped.
        let frameView = window.contentView?.superview
        for button in buttons {
            var view: NSView = button
            while let parent = view.superview, parent !== frameView { view = parent }
            guard view !== button, view.superview === frameView else { continue }
            var frame = view.frame
            frame.size.height = max(frame.height, Self.titlebarHeight)
            frame.origin.y = window.frame.height - frame.height
            if view.frame != frame {
                view.frame = frame
                trafficLightMoves += 1
            }
        }
        let spacing = trafficLightSpacing ?? 20
        for (index, button) in buttons.enumerated() {
            guard let parent = button.superview else { continue }
            let size = button.frame.size
            let target = NSRect(
                x: Self.edgeInset + CGFloat(index) * spacing,
                y: (window.frame.height - Self.titlebarHeight / 2 - size.height / 2).rounded(),
                width: size.width, height: size.height)
            let origin = parent.convert(target, from: nil).origin
            if abs(button.frame.minX - origin.x) > 0.25 || abs(button.frame.minY - origin.y) > 0.25 {
                button.setFrameOrigin(origin)
                trafficLightMoves += 1
            }
        }
        let end = buttons[2].convert(buttons[2].bounds, to: nil).maxX
        if end != trafficLightsEnd {
            trafficLightsEnd = end
            sendDocumentInfo()
        }
    }

    /// Places the traffic lights now and once more after AppKit's pending layout has run.
    private func repositionTrafficLights() {
        positionTrafficLights()
        DispatchQueue.main.async { self.positionTrafficLights() }
    }

    private var positioningTrafficLights = false
    /// How often the traffic lights were placed / actually moved (window_info): a window nobody
    /// touches should do neither.
    private(set) var trafficLightPasses = 0
    private(set) var trafficLightMoves = 0
    /// AppKit's distance between the traffic lights (close → minimise → zoom).
    private var trafficLightSpacing: CGFloat?
    private var watchedTitlebarViews: [ObjectIdentifier: NSObjectProtocol] = [:]

    /// AppKit lays the title bar out again on its own: on resize, on full screen changes, when
    /// the window becomes key, when the appearance (light / dark) or the title / edited state
    /// changes. Each time it puts the buttons back at the top of a 28 pt title bar, half outside
    /// our 52 pt row. So watch the buttons and the views holding them and put them back right
    /// away, before anything is drawn.
    private func watchTrafficLights(_ buttons: [NSButton]) {
        let frameView = window.contentView?.superview
        var views: [NSView] = []
        for button in buttons {
            var view: NSView? = button
            while let v = view, v !== frameView {
                views.append(v)
                view = v.superview
            }
        }
        for view in views where watchedTitlebarViews[ObjectIdentifier(view)] == nil {
            view.postsFrameChangedNotifications = true
            watchedTitlebarViews[ObjectIdentifier(view)] = NotificationCenter.default.addObserver(
                forName: NSView.frameDidChangeNotification, object: view, queue: nil
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.positionTrafficLights() }
            }
        }
    }

    /// Distance of the traffic lights (and everything else) from the window edges, in points.
    static let edgeInset: CGFloat = 16
    /// Where the traffic lights end; the page lays out its menu button from here.
    private(set) var trafficLightsEnd: CGFloat = 70

    func windowDidResize(_ notification: Notification) { positionTrafficLights() }
    func windowDidBecomeKey(_ notification: Notification) { repositionTrafficLights() }
    func windowDidResignKey(_ notification: Notification) { repositionTrafficLights() }
    func windowDidEnterFullScreen(_ notification: Notification) { sendDocumentInfo() }
    func windowDidExitFullScreen(_ notification: Notification) {
        repositionTrafficLights()
        sendDocumentInfo()
    }

    /// Light / dark: only touch the window when it actually changes (every change makes AppKit
    /// lay out the title bar again).
    private func applyAppearance(dark: Bool, background: NSColor?) {
        let name: NSAppearance.Name = dark ? .darkAqua : .aqua
        if window.appearance?.name != name {
            window.appearance = NSAppearance(named: name)
            repositionTrafficLights()
        }
        if let background, window.backgroundColor != background { window.backgroundColor = background }
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
            dirty = body["value"] as? Bool ?? false
            if let file { store.setDirty(dirty, for: file) }
            updateTitle()
        case "autosave":
            if let scene = body["scene"] as? String, let file { store.saveAutosave(scene: scene, for: file) }
        case "library":
            if let items = body["items"] as? String { onLibrary?(self, items) }
        case "titlebarHoles":
            let rects = body["rects"] as? [[Double]] ?? []
            dragArea.holes = rects.compactMap { r in
                r.count == 4 ? NSRect(x: r[0], y: r[1], width: r[2], height: r[3]) : nil
            }
        case "appearance":
            applyAppearance(
                dark: (body["theme"] as? String) == "dark",
                background: (body["background"] as? String).flatMap { NSColor(hex: $0) })
        case "themePreference":
            if let value = body["value"] as? String { onThemePreference?(value) }
        case "editState":
            editState = EditState(
                textEditing: body["textEditing"] as? Bool ?? false, canUndo: body["canUndo"] as? Bool ?? false,
                canRedo: body["canRedo"] as? Bool ?? false, hasSelection: body["hasSelection"] as? Bool ?? false)
            (webView as? CanvasWebView)?.textEditing = editState.textEditing
        case "menu":
            switch body["action"] as? String {
            case "new": onNewDocument?()
            case "open": onOpenDocument?()
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

    /// Called when this window's drawing is closed (the window is gone for good).
    var onClosed: ((CanvasController) -> Void)?
    /// Called when this window becomes the one the menus and agents act on.
    var onActivated: ((CanvasController) -> Void)?
    /// File > New / Open picked in the page's own menu.
    var onNewDocument: (() -> Void)?
    var onOpenDocument: (() -> Void)?
    /// The page's library changed (it is shared by all windows).
    var onLibrary: ((CanvasController, String) -> Void)?

    var hasDocument: Bool { file != nil }

    var displayName: String {
        file?.lastPathComponent ?? "Excalidraw"
    }

    /// The page shows the file name and folder in the title bar row; the window title (hidden)
    /// is still set for the Window menu and Mission Control.
    func updateTitle() {
        // Each of these makes AppKit lay out the title bar again (and move the traffic lights):
        // only set what changed, then put the lights back.
        let title = file?.deletingPathExtension().lastPathComponent ?? "Excalidraw"
        var changed = false
        if window.title != title {
            window.title = title
            changed = true
        }
        if window.representedURL != file {
            window.representedURL = file
            changed = true
        }
        if window.isDocumentEdited != dirty {
            window.isDocumentEdited = dirty
            changed = true
        }
        if changed { repositionTrafficLights() }
        sendDocumentInfo()
    }

    private func sendDocumentInfo() {
        var info: [String: JSON] = [
            "fullscreen": .bool(window.styleMask.contains(.fullScreen)),
            "trafficLightsEnd": .double(Double(trafficLightsEnd)),
        ]
        if let file {
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
        guard hasDocument, dirty else { return completion(true) }
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

    static let emptyScene = """
        {"type":"excalidraw","version":2,"source":"Excalidraw for Mac","elements":[],\
        "appState":{"gridSize":20,"viewBackgroundColor":"#ffffff"},"files":{}}
        """

    /// Shows `url` in this window, which shows nothing yet (the spare). If the app was killed
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
                self.file = url
                self.dirty = recovered != nil
                self.store.documentOpened(url, dirty: recovered != nil)
                if recovered == nil { self.refreshThumbnail() }
                self.updateTitle()
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
                self.show()
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

    /// Closes the drawing and its window (after asking about unsaved changes).
    func closeDocument(completion: ((Bool) -> Void)? = nil) {
        confirmClosing { ok in
            guard ok else {
                completion?(false)
                return
            }
            if let file = self.file { self.store.documentClosed(file) }
            self.tearDown()
            completion?(true)
        }
    }

    /// The window goes away for good: the page and its web process too.
    func tearDown() {
        guard !tornDown else { return }
        tornDown = true
        file = nil
        whenReady = []
        for observer in watchedTitlebarViews.values { NotificationCenter.default.removeObserver(observer) }
        watchedTitlebarViews = [:]
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "native")
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        window.delegate = nil
        window.close()
        onClosed?(self)
    }

    private var tornDown = false

    func save(completion: ((Bool) -> Void)? = nil) {
        guard let url = file else {
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
        panel.directoryURL = file?.deletingLastPathComponent()
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
                    self.store.documentMoved(from: self.file ?? url, to: url, dirty: false)
                    self.file = url
                    self.dirty = false
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
        guard let file else { return }
        call("export_image", ["format": "png", "max_size": 480, "background": true, "padding": 32]) { result in
            let png = (try? result.get())?["base64"]?.string.flatMap { Data(base64Encoded: $0) }
            self.store.saveThumbnail(png, for: file)
        }
    }

    /// File > Export Image…: Excalidraw's export dialog (preview, PNG / SVG / clipboard,
    /// background, dark mode, scale). Its files are named after the drawing.
    func openExportDialog() {
        guard hasDocument else { return }
        show()
        call("open_export_dialog") { _ in }
    }

    /// View menu commands (zoom, dark mode, library).
    func view(_ action: String) {
        guard hasDocument else { return }
        call("view", ["action": .string(action)]) { _ in }
    }

    /// Theme picked in Settings: "system", "light" or "dark".
    func setThemePreference(_ preference: String) {
        call("set_theme_preference", ["preference": .string(preference)]) { _ in }
    }

    /// Called when the user picks light / dark in the page (Excalidraw's menu, the View menu).
    var onThemePreference: ((String) -> Void)?

    // MARK: Edit menu
    //
    // Undo / Redo / Cut / Copy / Paste / Select All act on the canvas (Excalidraw's history and
    // clipboard), and on the text while a text field in the page has the keyboard.

    struct EditState {
        var textEditing = false
        var canUndo = false
        var canRedo = false
        var hasSelection = false
    }

    private(set) var editState = EditState()

    func validateEdit(_ item: NSMenuItem) -> Bool {
        guard hasDocument else { return false }
        if editState.textEditing, let undo = webView.undoManager {
            // Typing in a text field: its own undo ("Undo Typing").
            switch item.action {
            case #selector(CanvasContainerView.undo(_:)):
                item.title = undo.undoMenuItemTitle
                return undo.canUndo
            case #selector(CanvasContainerView.redo(_:)):
                item.title = undo.redoMenuItemTitle
                return undo.canRedo
            default:
                return true
            }
        }
        switch item.action {
        case #selector(CanvasContainerView.undo(_:)):
            item.title = L10n.t("Undo", "還原")
            return editState.canUndo
        case #selector(CanvasContainerView.redo(_:)):
            item.title = L10n.t("Redo", "重做")
            return editState.canRedo
        case #selector(NSText.cut(_:)), #selector(NSText.copy(_:)):
            return editState.hasSelection
        default:
            return true
        }
    }

    /// Runs an Edit menu command on the canvas. `fallback` is the standard action, used when a
    /// text field in the page turns out to have the keyboard.
    func edit(_ action: String, fallback: Selector, sender: Any?) {
        var params: [String: JSON] = ["action": .string(action)]
        if action == "paste" {
            let pasteboard = NSPasteboard.general
            if let text = pasteboard.string(forType: .string) { params["text"] = .string(text) }
            if let png = Self.pngFromPasteboard(pasteboard) { params["image"] = .string(png.base64EncodedString()) }
        }
        call("edit", .object(params)) { result in
            guard case .success(let reply) = result else { return }
            if reply["native"]?.bool == true {
                (self.webView as? CanvasWebView)?.performStandard(fallback, sender: sender)
                return
            }
            if let clipboard = reply["clipboard"]?.object, !clipboard.isEmpty {
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                for (type, value) in clipboard {
                    guard let text = value.string else { continue }
                    switch type {
                    case "text/plain": pasteboard.setString(text, forType: .string)
                    case "text/html": pasteboard.setString(text, forType: .html)
                    default: break
                    }
                }
            }
        }
    }

    private static func pngFromPasteboard(_ pasteboard: NSPasteboard) -> Data? {
        if let png = pasteboard.data(forType: .png) { return png }
        guard pasteboard.string(forType: .string) == nil,  // text wins over e.g. a rich text snapshot
            let image = NSImage(pasteboard: pasteboard), let tiff = image.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff)
        else { return nil }
        return bitmap.representation(using: .png, properties: [:])
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
            if case .success(let r) = result, let scene = r["scene"]?.string, let file = self.file {
                self.store.saveAutosave(scene: scene, for: file)
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

    /// Closing the window closes its drawing (the start screen shows when none is left).
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeDocument()
        return false
    }

    func windowDidBecomeMain(_ notification: Notification) { onActivated?(self) }

    /// The shared library changed in another window.
    func setLibrary(_ items: String) {
        call("set_library", ["items": .string(items)]) { _ in }
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
///
/// While the canvas has the keyboard it passes the Edit menu's actions on to its container
/// (the canvas does them); while a text field in the page has it, WebKit does them as usual.
final class CanvasWebView: WKWebView {
    override var mouseDownCanMoveWindow: Bool { false }

    var textEditing = false
    private var standardAction: Selector?

    static let editActions: Set<Selector> = [
        Selector(("undo:")), Selector(("redo:")), #selector(NSText.cut(_:)), #selector(NSText.copy(_:)),
        #selector(NSText.paste(_:)), #selector(NSText.selectAll(_:)),
    ]

    override func responds(to selector: Selector!) -> Bool {
        if let selector, Self.editActions.contains(selector), !textEditing, standardAction != selector { return false }
        return super.responds(to: selector)
    }

    /// Runs WebKit's own version of an Edit menu action (text editing).
    func performStandard(_ action: Selector, sender: Any?) {
        standardAction = action
        defer { standardAction = nil }
        if super.responds(to: action) {
            NSApp.sendAction(action, to: self, from: sender)
        } else if action == Selector(("undo:")) {
            undoManager?.undo()
        } else if action == Selector(("redo:")) {
            undoManager?.redo()
        }
    }
}

/// Holds the web view and the title bar drag area, and does the Edit menu's actions for the
/// canvas (they reach it when the web view passes them on, see CanvasWebView).
final class CanvasContainerView: NSView, NSMenuItemValidation {
    weak var controller: CanvasController?

    @objc func undo(_ sender: Any?) { controller?.edit("undo", fallback: #selector(undo(_:)), sender: sender) }
    @objc func redo(_ sender: Any?) { controller?.edit("redo", fallback: #selector(redo(_:)), sender: sender) }
    @objc func cut(_ sender: Any?) { controller?.edit("cut", fallback: #selector(NSText.cut(_:)), sender: sender) }
    @objc func copy(_ sender: Any?) { controller?.edit("copy", fallback: #selector(NSText.copy(_:)), sender: sender) }
    @objc func paste(_ sender: Any?) { controller?.edit("paste", fallback: #selector(NSText.paste(_:)), sender: sender) }
    @objc override func selectAll(_ sender: Any?) {
        controller?.edit("selectAll", fallback: #selector(NSText.selectAll(_:)), sender: sender)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        controller?.validateEdit(menuItem) ?? false
    }
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
