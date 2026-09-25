#if os(macOS)
import AppKit

/// The window shown when no drawing is open: New File (choose a folder and a name),
/// Open…, and recently used files.
@MainActor
final class StartWindowController: NSObject, NSWindowDelegate {
    let window: NSWindow
    private let store: Store
    private let onNew: () -> Void
    private let onOpen: () -> Void
    private let onOpenRecent: (URL) -> Void
    private var recentShown: [URL] = []

    init(store: Store, onNew: @escaping () -> Void, onOpen: @escaping () -> Void, onOpenRecent: @escaping (URL) -> Void) {
        self.store = store
        self.onNew = onNew
        self.onOpen = onOpen
        self.onOpenRecent = onOpenRecent
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 560),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Excalidraw"
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.delegate = self
        window.center()
    }

    func show() {
        window.contentView = makeContent()
        window.makeKeyAndOrderFront(nil)
    }

    func hide() {
        window.orderOut(nil)
    }

    /// Closing the start screen quits the app (there is nothing else open).
    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    @objc private func newFile(_ sender: Any?) { onNew() }
    @objc private func openFile(_ sender: Any?) { onOpen() }

    @objc private func openRecent(_ sender: NSButton) {
        guard recentShown.indices.contains(sender.tag) else { return }
        onOpenRecent(recentShown[sender.tag])
    }

    private func makeContent() -> NSView {
        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 96).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 96).isActive = true

        let title = NSTextField(labelWithString: "Excalidraw")
        title.font = .systemFont(ofSize: 26, weight: .semibold)

        let subtitle = NSTextField(
            wrappingLabelWithString: L10n.t(
                "Create a file in a folder of your choice, or open one. Press ⌘S to save your drawing to that file.",
                "先選一個資料夾建立新檔案，或開啟既有的檔案。畫完按 ⌘S，就會存回這個檔案。"))
        subtitle.alignment = .center
        subtitle.textColor = .secondaryLabelColor
        subtitle.preferredMaxLayoutWidth = 380

        let newButton = NSButton(title: L10n.t("New File…", "新增檔案…"), target: self, action: #selector(newFile(_:)))
        newButton.keyEquivalent = "\r"
        newButton.controlSize = .large
        let openButton = NSButton(title: L10n.t("Open…", "開啟檔案…"), target: self, action: #selector(openFile(_:)))
        openButton.controlSize = .large
        let buttons = NSStackView(views: [newButton, openButton])
        buttons.spacing = 12

        let header = NSTextField(labelWithString: L10n.t("Recent", "最近使用"))
        header.font = .systemFont(ofSize: 12, weight: .semibold)
        header.textColor = .secondaryLabelColor

        let recentList = NSStackView()
        recentList.orientation = .vertical
        recentList.alignment = .leading
        recentList.spacing = 2
        recentShown = []
        if let file = store.recoverableFile {
            recentShown.append(file)
            recentList.addArrangedSubview(
                recentButton(
                    file, tag: 0,
                    note: L10n.t("⚠︎ Unsaved changes — click to restore", "⚠︎ 有未儲存的變更，點一下恢復")))
        }
        for url in store.recentFiles where url != store.recoverableFile {
            guard recentShown.count < 8 else { break }
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            recentShown.append(url)
            recentList.addArrangedSubview(recentButton(url, tag: recentShown.count - 1, note: nil))
        }
        if recentShown.isEmpty {
            let none = NSTextField(labelWithString: L10n.t("No recent files", "還沒有最近使用的檔案"))
            none.textColor = .tertiaryLabelColor
            recentList.addArrangedSubview(none)
        }

        let separator = NSBox()
        separator.boxType = .separator

        let top = NSStackView(views: [icon, title, subtitle, buttons])
        top.orientation = .vertical
        top.alignment = .centerX
        top.spacing = 12
        top.setCustomSpacing(20, after: subtitle)

        let bottom = NSStackView(views: [header, recentList])
        bottom.orientation = .vertical
        bottom.alignment = .leading
        bottom.spacing = 8

        let root = NSStackView(views: [top, separator, bottom])
        root.orientation = .vertical
        root.alignment = .centerX
        root.spacing = 20
        root.edgeInsets = NSEdgeInsets(top: 28, left: 32, bottom: 28, right: 32)
        root.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 560))
        container.addSubview(root)
        NSLayoutConstraint.activate([
            root.topAnchor.constraint(equalTo: container.topAnchor),
            root.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            root.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor),
            separator.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -64),
            bottom.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -64),
            recentList.widthAnchor.constraint(equalTo: bottom.widthAnchor),
        ])
        return container
    }

    /// "name.excalidraw   ~/folder" (or a note), click to open.
    private func recentButton(_ url: URL, tag: Int, note: String?) -> NSButton {
        let folder = (url.deletingLastPathComponent().path as NSString).abbreviatingWithTildeInPath
        let text = NSMutableAttributedString(
            string: url.lastPathComponent,
            attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: NSColor.labelColor])
        text.append(
            NSAttributedString(
                string: "   " + (note ?? folder),
                attributes: [
                    .font: NSFont.systemFont(ofSize: 12),
                    .foregroundColor: note == nil ? NSColor.secondaryLabelColor : NSColor.systemOrange,
                ]))
        let button = NSButton(title: "", target: self, action: #selector(openRecent(_:)))
        button.attributedTitle = text
        button.isBordered = false
        button.alignment = .left
        button.lineBreakMode = .byTruncatingMiddle
        button.tag = tag
        button.toolTip = url.path
        return button
    }
}
#endif
