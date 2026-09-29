#if os(macOS)
import AppKit
import BridgeCore
import UniformTypeIdentifiers

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private let store = Store()
    /// One window per open drawing, the one the menus and agents act on first.
    private var canvases: [CanvasController] = []
    /// A window with the page already loaded, not showing anything: the next file opens in it.
    private var spare: CanvasController?
    private var start: StartWindowController?
    private var settings: SettingsWindowController?
    private var bridge: AppBridge?
    private var pendingFiles: [URL] = []
    private var sigterm: DispatchSourceSignal?
    private var agentConnected = false

    /// The drawing window the menus act on: the frontmost one.
    private var canvas: CanvasController? { canvases.first }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMainMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        spare = makeCanvas()
        start = StartWindowController(
            store: store,
            onNew: { [weak self] in self?.createDocument() },
            onOpen: { [weak self] in self?.openDocument() },
            onAgentSetup: { [weak self] in self?.showAgentSetup(nil) },
            onOpenRecent: { [weak self] url in self?.openFile(url) })

        let bridge = AppBridge(canvas: { [weak self] in self?.canvas ?? self?.spare }, canvases: { [weak self] in self?.canvases ?? [] })
        bridge.onAgentConnected = { [weak self] connected in
            guard let self else { return }
            self.agentConnected = connected
            for canvas in self.canvases + [self.spare].compactMap({ $0 }) { canvas.setAgentConnected(connected) }
        }
        do {
            try bridge.start()
            self.bridge = bridge
        } catch {
            NSLog("Excalidraw: AI agent bridge not available: \(error)")
        }

        // Launched by opening files (Finder, `open file.excalidraw`): go straight to them. They
        // may also arrive just after launch, so wait one turn before showing the start screen.
        if !pendingFiles.isEmpty {
            pendingFiles.forEach(openFile)
        } else {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.openingFiles == 0 else { return }
                self.showRightWindow()
            }
        }
        pendingFiles = []

        // `kill` / `killall Excalidraw`: keep unsaved changes as recovery copies and exit
        // without questions. They come back the next time each file is opened.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { [weak self] in self?.terminateForSignal() }
        source.resume()
        sigterm = source
    }

    /// A drawing window, not showing a drawing yet; its page starts loading right away.
    private func makeCanvas() -> CanvasController {
        let canvas = CanvasController(store: store)
        // Only one kind of window at a time: the drawings, or the start screen.
        canvas.onShow = { [weak self] in self?.start?.hide() }
        canvas.onActivated = { [weak self] canvas in
            guard let self, let i = self.canvases.firstIndex(where: { $0 === canvas }) else { return }
            self.canvases.insert(self.canvases.remove(at: i), at: 0)
        }
        canvas.onClosed = { [weak self] canvas in
            guard let self else { return }
            self.canvases.removeAll { $0 === canvas }
            if self.canvases.isEmpty { self.showRightWindow() }
        }
        canvas.onNewDocument = { [weak self] in self?.createDocument() }
        canvas.onOpenDocument = { [weak self] in self?.openDocument() }
        canvas.onThemePreference = { [weak self] theme in
            guard let self else { return }
            self.store.setThemePreference(theme)
            self.settings?.select(theme: theme)
            for other in self.canvases where other !== canvas { other.setThemePreference(theme) }
            self.spare?.setThemePreference(theme)
        }
        canvas.onLibrary = { [weak self] canvas, items in
            guard let self, self.store.saveLibrary(items) else { return }
            for other in self.canvases + [self.spare].compactMap({ $0 }) where other !== canvas { other.setLibrary(items) }
        }
        if agentConnected { canvas.setAgentConnected(true) }
        return canvas
    }

    /// The drawing windows when a file is open, otherwise the start screen.
    private func showRightWindow() {
        guard let start else { return }
        if let canvas {
            start.hide()
            canvas.show()
        } else {
            start.show()
        }
    }

    private func terminateForSignal() {
        var waiting = canvases.count
        let finish = {
            self.bridge?.stop()
            self.store.flush()
            exit(0)
        }
        guard waiting > 0 else { return finish() }
        for canvas in canvases {
            canvas.flushAutosave {
                waiting -= 1
                if waiting == 0 { finish() }
            }
        }
    }

    /// Double-clicked .excalidraw files (Finder, Dock, `open file.excalidraw`) and recent files.
    func application(_ application: NSApplication, open urls: [URL]) {
        if spare == nil && canvases.isEmpty { pendingFiles += urls } else { urls.forEach(openFile) }
    }

    /// Files being opened (so the start screen doesn't flash up meanwhile).
    private var openingFiles = 0

    /// Shows `url` in its own window (the one it is already in, if it is open).
    private func openFile(_ url: URL) {
        if let open = canvases.first(where: { $0.file?.standardizedFileURL == url.standardizedFileURL }) {
            return open.show()
        }
        let canvas = spare ?? makeCanvas()
        spare = nil
        // Next to the frontmost drawing, a little down and to the right, the same size.
        if let front = self.canvas?.window, front.isVisible {
            var frame = front.frame
            frame.origin.x += 26
            frame.origin.y -= 26
            canvas.window.setFrame(frame, display: false)
        }
        openingFiles += 1
        canvas.open(url) { error in
            self.openingFiles -= 1
            if let error {
                if self.spare == nil { self.spare = canvas } else { canvas.tearDown() }
                if !FileManager.default.fileExists(atPath: url.path) { self.store.removeRecent(url) }
                self.showError(error)
                if self.canvases.isEmpty { self.showRightWindow() }
                return
            }
            self.canvases.removeAll { $0 === canvas }
            self.canvases.insert(canvas, at: 0)
            // The next file opens as fast as this one did.
            if self.spare == nil { self.spare = self.makeCanvas() }
        }
    }

    private func showError(_ error: BridgeError) {
        if let canvas { return canvas.showError(error) }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n.t("Something went wrong", "發生錯誤")
        alert.informativeText = error.description
        alert.runModal()
    }

    /// File > New: pick a folder and a name, create the file there, open it in a new window.
    func createDocument() {
        let panel = NSSavePanel()
        panel.title = L10n.t("New Excalidraw File", "新增 Excalidraw 檔案")
        panel.message = L10n.t("Choose a folder and a name for your drawing.", "選擇要存放繪圖的資料夾，並輸入檔名。")
        panel.prompt = L10n.t("Create", "建立")
        panel.allowedContentTypes = [.excalidrawScene]
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = "\(L10n.t("Untitled", "未命名")).excalidraw"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            // Replacing a file that is open: that window shows the new, empty drawing.
            if let open = self.canvases.first(where: { $0.file?.standardizedFileURL == url.standardizedFileURL }) {
                self.store.documentClosed(url)
                open.tearDown()
            }
            do {
                try Data(CanvasController.emptyScene.utf8).write(to: url, options: .atomic)
            } catch {
                return self.showError(
                    BridgeError(
                        L10n.t(
                            "Could not create \(url.path): \(error.localizedDescription)",
                            "無法建立 \(url.path)：\(error.localizedDescription)")))
            }
            self.openFile(url)
        }
    }

    /// File > Open: each file in its own window.
    func openDocument() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.excalidrawScene, .json]
        panel.allowsMultipleSelection = true
        panel.begin { response in
            guard response == .OK else { return }
            panel.urls.forEach(self.openFile)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Clicking the Dock icon with no window showing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showRightWindow() }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// Quit: ask about unsaved changes in each window, frontmost first; Cancel stops quitting.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !canvases.isEmpty else { return .terminateNow }
        var remaining = canvases
        func next() {
            guard let canvas = remaining.first else {
                // Saved or discarded on purpose: no recovery copies.
                for canvas in canvases { if let file = canvas.file { store.documentClosed(file) } }
                store.flush()
                NSApp.reply(toApplicationShouldTerminate: true)
                return
            }
            remaining.removeFirst()
            canvas.confirmClosing { ok in
                guard ok else { return NSApp.reply(toApplicationShouldTerminate: false) }
                next()
            }
        }
        next()
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridge?.stop()
        store.flush()
    }

    // MARK: Menu actions

    @objc func newDocument(_ sender: Any?) { createDocument() }
    @objc func openDocument(_ sender: Any?) { openDocument() }
    @objc func saveDocument(_ sender: Any?) { canvas?.save() }
    @objc func saveDocumentAs(_ sender: Any?) { canvas?.saveAs() }
    @objc func exportImage(_ sender: Any?) { canvas?.openExportDialog() }
    @objc func zoomIn(_ sender: Any?) { canvas?.view("zoomIn") }
    @objc func zoomOut(_ sender: Any?) { canvas?.view("zoomOut") }
    @objc func actualSize(_ sender: Any?) { canvas?.view("actualSize") }
    @objc func zoomToFit(_ sender: Any?) { canvas?.view("zoomToFit") }
    @objc func toggleDarkMode(_ sender: Any?) { canvas?.view("toggleTheme") }
    @objc func toggleLibrary(_ sender: Any?) { canvas?.view("toggleLibrary") }

    @objc func showSettings(_ sender: Any?) {
        if settings == nil {
            settings = SettingsWindowController(
                onTheme: { [weak self] theme in
                    guard let self else { return }
                    self.store.setThemePreference(theme)
                    for canvas in self.canvases + [self.spare].compactMap({ $0 }) { canvas.setThemePreference(theme) }
                },
                onAgentSetup: { [weak self] in self?.showAgentSetup(nil) })
        }
        settings?.show(theme: store.themePreference)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(toggleDarkMode(_:)):
            menuItem.state = canvas?.window.appearance?.name == .darkAqua ? .on : .off
            return canvas?.hasDocument == true
        case #selector(saveDocument(_:)), #selector(saveDocumentAs(_:)), #selector(exportImage(_:)),
            #selector(zoomIn(_:)), #selector(zoomOut(_:)), #selector(actualSize(_:)), #selector(zoomToFit(_:)),
            #selector(toggleLibrary(_:)):
            return canvas?.hasDocument == true
        default:
            return true
        }
    }

    @objc func openHelp(_ sender: Any?) {
        let readme = L10n.isChinese ? "blob/main/README.zh-TW.md" : "#readme"
        NSWorkspace.shared.open(URL(string: "https://github.com/TingGeorge/excalidraw-mac/\(readme)")!)
    }

    /// Help > Acknowledgements: the licenses of everything the app includes (bundled with it).
    @objc func showAcknowledgements(_ sender: Any?) {
        guard let url = Bundle.main.url(forResource: "THIRD_PARTY_NOTICES", withExtension: "txt") else { return }
        NSWorkspace.shared.open(url)
    }

    /// Shows how to connect Claude Code (or any MCP client) to this app.
    @objc func showAgentSetup(_ sender: Any?) {
        let server = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/excalidraw-mcp").path
        let claudeCommand = "claude mcp add excalidraw --scope user -- \(shellQuote(server))"
        let jsonConfig = """
            {
              "mcpServers": {
                "excalidraw": { "command": \(JSON.string(server).text) }
              }
            }
            """

        let alert = NSAlert()
        alert.messageText = L10n.t("Connect an AI agent (MCP)", "連接 AI Agent（MCP）")
        alert.informativeText = L10n.t(
            "This app includes an MCP server, so agents such as Claude Code can draw in the file you have open: read the canvas, add shapes and Mermaid diagrams, edit, and look at the result. Agents can't save or open files; you save with ⌘S.\n\nClaude Code: run this command once in Terminal. Other MCP clients (Claude Desktop, Cursor…): add the JSON to their MCP settings.",
            "這個 App 內建 MCP 伺服器，Claude Code 等 agent 可以在你開著的檔案裡畫圖：讀取畫布、新增圖形與 Mermaid 圖表、修改、看畫出來的結果。agent 不能存檔或開檔，存檔由你按 ⌘S。\n\nClaude Code：在「終端機」執行一次下面的指令。其他 MCP 用戶端（Claude Desktop、Cursor…）：把 JSON 加進它們的 MCP 設定。"
        )
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 520, height: 150))
        text.string = "\(claudeCommand)\n\n\(jsonConfig)"
        text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        text.isEditable = false
        text.isSelectable = true
        text.textContainerInset = NSSize(width: 6, height: 6)
        let scroll = NSScrollView(frame: text.frame)
        scroll.documentView = text
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        alert.accessoryView = scroll
        alert.addButton(withTitle: L10n.t("Copy Claude Code Command", "複製 Claude Code 指令"))
        alert.addButton(withTitle: L10n.t("Copy JSON", "複製 JSON"))
        alert.addButton(withTitle: L10n.t("Done", "完成"))

        let copy = { (s: String) in
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(s, forType: .string)
        }
        switch alert.runModal() {
        case .alertFirstButtonReturn: copy(claudeCommand)
        case .alertSecondButtonReturn: copy(jsonConfig)
        default: break
        }
    }

    private func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    // MARK: Menu bar

    private func buildMainMenu() -> NSMenu {
        let t = L10n.t
        let main = NSMenu()

        @discardableResult
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            for i in items { menu.addItem(i) }
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = menu
            main.addItem(holder)
            return menu
        }
        func item(_ title: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil)
            -> NSMenuItem
        {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }

        submenu("Excalidraw", [
            item(t("About Excalidraw", "關於 Excalidraw"), #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item(t("Settings…", "設定…"), #selector(showSettings(_:)), ",", target: self),
            item(t("Connect an AI Agent (MCP)…", "連接 AI Agent（MCP）…"), #selector(showAgentSetup(_:)), target: self),
            .separator(),
            item(t("Hide Excalidraw", "隱藏 Excalidraw"), #selector(NSApplication.hide(_:)), "h"),
            item(t("Hide Others", "隱藏其他"), #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item(t("Show All", "顯示全部"), #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item(t("Quit Excalidraw", "結束 Excalidraw"), #selector(NSApplication.terminate(_:)), "q"),
        ])
        submenu(t("File", "檔案"), [
            item(t("New File…", "新增檔案…"), #selector(newDocument(_:)), "n", target: self),
            item(t("Open…", "開啟…"), #selector(openDocument(_:)), "o", target: self),
            .separator(),
            item(t("Close", "關閉"), #selector(NSWindow.performClose(_:)), "w"),
            item(t("Save", "儲存"), #selector(saveDocument(_:)), "s", target: self),
            item(t("Save As…", "另存新檔…"), #selector(saveDocumentAs(_:)), "s", [.command, .shift], target: self),
            .separator(),
            // Excalidraw's export dialog: preview, PNG / SVG / clipboard, background, dark mode, scale.
            item(t("Export Image…", "匯出圖片…"), #selector(exportImage(_:)), "e", [.command, .shift], target: self),
        ])
        // Standard responder actions. In the drawing window they act on the canvas (its undo
        // history and clipboard, see CanvasContainerView), or on the text being typed.
        submenu(t("Edit", "編輯"), [
            item(t("Undo", "還原"), Selector(("undo:")), "z"),
            item(t("Redo", "重做"), Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item(t("Cut", "剪下"), #selector(NSText.cut(_:)), "x"),
            item(t("Copy", "拷貝"), #selector(NSText.copy(_:)), "c"),
            item(t("Paste", "貼上"), #selector(NSText.paste(_:)), "v"),
            item(t("Select All", "全選"), #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu(t("View", "顯示方式"), [
            item(t("Zoom In", "放大"), #selector(zoomIn(_:)), "+", target: self),
            item(t("Zoom Out", "縮小"), #selector(zoomOut(_:)), "-", target: self),
            item(t("Actual Size", "實際大小"), #selector(actualSize(_:)), "0", target: self),
            item(t("Zoom to Fit", "縮放至符合畫面"), #selector(zoomToFit(_:)), target: self),
            .separator(),
            item(t("Dark Mode", "深色模式"), #selector(toggleDarkMode(_:)), target: self),
            item(t("Library", "素材庫"), #selector(toggleLibrary(_:)), target: self),
            .separator(),
            item(t("Enter Full Screen", "進入全螢幕"), #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let window = submenu(t("Window", "視窗"), [
            item(t("Minimize", "縮到最小"), #selector(NSWindow.performMiniaturize(_:)), "m"),
            item(t("Zoom", "縮放"), #selector(NSWindow.performZoom(_:))),
        ])
        NSApp.windowsMenu = window
        let help = submenu(t("Help", "輔助說明"), [
            item(t("Excalidraw for Mac Help", "Excalidraw for Mac 說明"), #selector(openHelp(_:)), target: self),
            item(t("Connect an AI Agent (MCP)…", "連接 AI Agent（MCP）…"), #selector(showAgentSetup(_:)), target: self),
            .separator(),
            item(t("Acknowledgements", "致謝與授權"), #selector(showAcknowledgements(_:)), target: self),
        ])
        NSApp.helpMenu = help
        return main
    }
}
#endif
