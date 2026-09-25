#if os(macOS)
import AppKit

/// Excalidraw > Settings… (⌘,): appearance (follow the system, light, dark) and connecting an
/// AI agent.
@MainActor
final class SettingsWindowController: NSObject {
    let window: NSWindow
    private let appearance = NSSegmentedControl()
    private let onTheme: (String) -> Void
    private let onAgentSetup: () -> Void
    private static let themes = ["system", "light", "dark"]

    init(onTheme: @escaping (String) -> Void, onAgentSetup: @escaping () -> Void) {
        self.onTheme = onTheme
        self.onAgentSetup = onAgentSetup
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 200), styleMask: [.titled, .closable],
            backing: .buffered, defer: false)
        super.init()
        window.title = L10n.t("Settings", "設定")
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.contentView = makeContent()
        window.center()
        _ = window.setFrameAutosaveName("ExcalidrawSettingsWindow")
    }

    func show(theme: String) {
        select(theme: theme)
        window.makeKeyAndOrderFront(nil)
    }

    /// Keeps the control in step when the theme is changed elsewhere (View menu, Excalidraw's menu).
    func select(theme: String) {
        appearance.selectedSegment = Self.themes.firstIndex(of: theme) ?? 0
    }

    private func makeContent() -> NSView {
        appearance.segmentStyle = .rounded
        appearance.trackingMode = .selectOne
        appearance.segmentCount = 3
        for (index, label) in [L10n.t("System", "跟隨系統"), L10n.t("Light", "淺色"), L10n.t("Dark", "深色")].enumerated() {
            appearance.setLabel(label, forSegment: index)
            appearance.setWidth(96, forSegment: index)
        }
        appearance.target = self
        appearance.action = #selector(appearanceChanged(_:))
        appearance.setAccessibilityLabel(L10n.t("Appearance", "外觀"))

        let agentButton = NSButton(
            title: L10n.t("Connect an AI Agent…", "連接 AI Agent…"), target: self, action: #selector(agentSetup(_:)))
        agentButton.bezelStyle = .rounded
        let agentNote = NSTextField(
            wrappingLabelWithString: L10n.t(
                "Lets Claude Code and other MCP clients draw in the file you have open.",
                "讓 Claude Code 等 MCP 用戶端在你開著的檔案裡畫圖。"))
        agentNote.font = .systemFont(ofSize: 11)
        agentNote.textColor = .secondaryLabelColor
        agentNote.preferredMaxLayoutWidth = 300
        let agent = NSStackView(views: [agentButton, agentNote])
        agent.orientation = .vertical
        agent.alignment = .leading
        agent.spacing = 6

        let label = { (text: String) -> NSTextField in
            let field = NSTextField(labelWithString: text)
            field.alignment = .right
            return field
        }
        let grid = NSGridView(views: [
            [label(L10n.t("Appearance:", "外觀：")), appearance],
            [label(L10n.t("AI agent:", "AI Agent：")), agent],
        ])
        grid.rowSpacing = 20
        grid.columnSpacing = 12
        grid.column(at: 0).xPlacement = .trailing
        grid.row(at: 0).yPlacement = .center
        grid.row(at: 1).yPlacement = .top
        grid.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        root.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: root.topAnchor, constant: 28),
            grid.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -28),
            grid.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 32),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -32),
            root.widthAnchor.constraint(equalToConstant: 460),
        ])
        return root
    }

    @objc private func appearanceChanged(_ sender: NSSegmentedControl) {
        let index = sender.selectedSegment
        guard Self.themes.indices.contains(index) else { return }
        onTheme(Self.themes[index])
    }

    @objc private func agentSetup(_ sender: Any?) {
        onAgentSetup()
    }
}
#endif
