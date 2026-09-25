#if os(macOS)
import AppKit
import BridgeCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private let store = Store()
    private var canvas: CanvasController?
    private var start: StartWindowController?
    private var bridge: AppBridge?
    private var pendingFiles: [URL] = []
    private var sigterm: DispatchSourceSignal?

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMainMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let canvas = CanvasController(store: store)
        canvas.onDocumentChanged = { [weak self] in self?.showRightWindow() }
        self.canvas = canvas
        start = StartWindowController(
            store: store,
            onNew: { canvas.createDocument() },
            onOpen: { canvas.openDocument() },
            onAgentSetup: { [weak self] in self?.showAgentSetup(nil) },
            onOpenRecent: { [weak self] url in self?.openFile(url) })

        let bridge = AppBridge(canvas: canvas, store: store)
        do {
            try bridge.start()
            self.bridge = bridge
        } catch {
            NSLog("Excalidraw: AI agent bridge not available: \(error)")
        }

        if let url = pendingFiles.first { openFile(url) } else { showRightWindow() }
        pendingFiles = []

        // `kill` / `killall Excalidraw`: keep unsaved changes as a recovery copy and exit
        // without questions. They come back the next time that file is opened.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { [weak self] in self?.terminateForSignal() }
        source.resume()
        sigterm = source
    }

    /// The drawing window when a file is open, otherwise the start screen.
    private func showRightWindow() {
        guard let canvas, let start else { return }
        if canvas.hasDocument {
            start.hide()
            canvas.show()
        } else {
            start.show()
        }
    }

    private func terminateForSignal() {
        let finish = {
            self.bridge?.stop()
            self.store.flush()
            exit(0)
        }
        if let canvas { canvas.flushAutosave(completion: finish) } else { finish() }
    }

    /// Double-clicked .excalidraw files (Finder, Dock, `open file.excalidraw`) and recent files.
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first else { return }
        if canvas == nil { pendingFiles = [url] } else { openFile(url) }
    }

    private func openFile(_ url: URL) {
        guard let canvas else { return }
        if canvas.store.currentFile?.standardizedFileURL == url.standardizedFileURL {
            return canvas.show()
        }
        canvas.confirmClosing { ok in
            guard ok else { return }
            canvas.open(url) { error in
                guard let error else { return }
                if !FileManager.default.fileExists(atPath: url.path) { self.store.removeRecent(url) }
                canvas.showError(error)
                self.showRightWindow()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Clicking the Dock icon with no window showing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showRightWindow() }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let canvas, canvas.hasDocument else { return .terminateNow }
        canvas.confirmClosing { ok in
            guard ok else {
                NSApp.reply(toApplicationShouldTerminate: false)
                return
            }
            self.store.documentClosed()  // saved or discarded on purpose: no recovery copy
            self.store.flush()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridge?.stop()
        store.flush()
    }

    // MARK: Menu actions

    @objc func newDocument(_ sender: Any?) { canvas?.createDocument() }
    @objc func openDocument(_ sender: Any?) { canvas?.openDocument() }
    @objc func saveDocument(_ sender: Any?) { canvas?.save() }
    @objc func saveDocumentAs(_ sender: Any?) { canvas?.saveAs() }
    @objc func exportPNG(_ sender: Any?) { canvas?.exportImage(format: "png") }
    @objc func exportSVG(_ sender: Any?) { canvas?.exportImage(format: "svg") }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(saveDocument(_:)), #selector(saveDocumentAs(_:)), #selector(exportPNG(_:)),
            #selector(exportSVG(_:)):
            return canvas?.hasDocument == true
        default:
            return true
        }
    }

    @objc func openHelp(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://github.com/TingGeorge/ideas/tree/main/excalidraw-mac#readme")!)
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
            item(t("Export as PNG…", "匯出為 PNG…"), #selector(exportPNG(_:)), target: self),
            item(t("Export as SVG…", "匯出為 SVG…"), #selector(exportSVG(_:)), target: self),
        ])
        // Standard responder actions: WKWebView passes them to the page (text editing, copy/paste of shapes).
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
        ])
        NSApp.helpMenu = help
        return main
    }
}
#endif
