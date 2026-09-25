#if os(macOS)
import AppKit

/// Excalidraw's purple, used for the primary action and the highlighted recent file.
let excalidrawAccent = NSColor(srgbRed: 0x69 / 255, green: 0x65 / 255, blue: 0xdb / 255, alpha: 1)

/// The window shown when no drawing is open, in the style of Xcode's / Keynote's welcome
/// windows: a frosted sidebar with the app and its actions, recent files on the right.
@MainActor
final class StartWindowController: NSObject, NSWindowDelegate {
    let window: NSWindow
    private let store: Store
    private let onNew: () -> Void
    private let onOpen: () -> Void
    private let onAgentSetup: () -> Void
    private let onOpenRecent: (URL) -> Void
    private let search = NSSearchField()
    private let list = NSStackView()
    private let emptyLabel = NSTextField(wrappingLabelWithString: "")

    init(
        store: Store, onNew: @escaping () -> Void, onOpen: @escaping () -> Void,
        onAgentSetup: @escaping () -> Void, onOpenRecent: @escaping (URL) -> Void
    ) {
        self.store = store
        self.onNew = onNew
        self.onOpen = onOpen
        self.onAgentSetup = onAgentSetup
        self.onOpenRecent = onOpenRecent
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 780, height: 480),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        window.title = "Excalidraw"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.delegate = self
        window.contentView = makeContent()
        window.center()
    }

    func show() {
        search.stringValue = ""
        reloadRecent()
        window.makeKeyAndOrderFront(nil)
    }

    func hide() {
        window.orderOut(nil)
    }

    /// Closing the start screen quits the app (there is nothing else open).
    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    // MARK: Layout

    private func makeContent() -> NSView {
        let root = NSView()

        // Sidebar: frosted, like Finder's / Xcode's.
        let sidebar = NSVisualEffectView()
        sidebar.material = .sidebar
        sidebar.blendingMode = .behindWindow
        sidebar.state = .followsWindowActiveState
        sidebar.translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 88).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 88).isActive = true

        let name = NSTextField(labelWithString: "Excalidraw")
        name.font = .systemFont(ofSize: 22, weight: .bold)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let subtitle = NSTextField(
            labelWithString: L10n.t("Version \(version) · Works offline", "版本 \(version) · 離線可用"))
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.textColor = .secondaryLabelColor

        let actions = NSStackView(views: [
            ActionRow(
                symbol: "doc.badge.plus", title: L10n.t("New File…", "新增檔案…"), shortcut: "⌘N", prominent: true,
                action: onNew),
            ActionRow(symbol: "folder", title: L10n.t("Open…", "開啟檔案…"), shortcut: "⌘O", action: onOpen),
            ActionRow(
                symbol: "sparkles", title: L10n.t("Connect an AI Agent…", "連接 AI Agent…"), shortcut: nil,
                action: onAgentSetup),
        ])
        actions.orientation = .vertical
        actions.spacing = 2
        for row in actions.arrangedSubviews {
            row.widthAnchor.constraint(equalTo: actions.widthAnchor).isActive = true
        }

        let brand = NSStackView(views: [icon, name, subtitle])
        brand.orientation = .vertical
        brand.alignment = .centerX
        brand.spacing = 4
        brand.setCustomSpacing(12, after: icon)

        let side = NSStackView(views: [brand, actions])
        side.orientation = .vertical
        side.alignment = .centerX
        side.spacing = 32
        side.translatesAutoresizingMaskIntoConstraints = false
        sidebar.addSubview(side)

        // Right: recent files.
        let right = NSView()
        right.translatesAutoresizingMaskIntoConstraints = false

        let header = NSTextField(labelWithString: L10n.t("Recent", "最近使用"))
        header.font = .systemFont(ofSize: 13, weight: .semibold)
        search.placeholderString = L10n.t("Search", "搜尋")
        search.controlSize = .regular
        search.sendsSearchStringImmediately = true
        search.target = self
        search.action = #selector(searchChanged(_:))
        search.translatesAutoresizingMaskIntoConstraints = false
        search.widthAnchor.constraint(equalToConstant: 180).isActive = true
        let headerRow = NSStackView(views: [header, flexibleSpace(), search])
        headerRow.orientation = .horizontal
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 2
        list.translatesAutoresizingMaskIntoConstraints = false
        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(list)
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = document
        scroll.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.alignment = .center
        emptyLabel.textColor = .tertiaryLabelColor
        emptyLabel.font = .systemFont(ofSize: 13)
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false

        right.addSubview(headerRow)
        right.addSubview(scroll)
        right.addSubview(emptyLabel)

        let divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(sidebar)
        root.addSubview(divider)
        root.addSubview(right)
        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            sidebar.topAnchor.constraint(equalTo: root.topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            sidebar.widthAnchor.constraint(equalToConstant: 280),
            side.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 64),
            side.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 20),
            side.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -20),
            actions.widthAnchor.constraint(equalTo: side.widthAnchor),

            divider.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            divider.topAnchor.constraint(equalTo: root.topAnchor),
            divider.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            divider.widthAnchor.constraint(equalToConstant: 1),

            right.leadingAnchor.constraint(equalTo: divider.trailingAnchor),
            right.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            right.topAnchor.constraint(equalTo: root.topAnchor),
            right.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            headerRow.topAnchor.constraint(equalTo: right.topAnchor, constant: 20),
            headerRow.leadingAnchor.constraint(equalTo: right.leadingAnchor, constant: 24),
            headerRow.trailingAnchor.constraint(equalTo: right.trailingAnchor, constant: -20),
            scroll.topAnchor.constraint(equalTo: headerRow.bottomAnchor, constant: 12),
            scroll.leadingAnchor.constraint(equalTo: right.leadingAnchor, constant: 12),
            scroll.trailingAnchor.constraint(equalTo: right.trailingAnchor, constant: -12),
            scroll.bottomAnchor.constraint(equalTo: right.bottomAnchor, constant: -12),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            list.topAnchor.constraint(equalTo: document.topAnchor),
            list.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            list.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            list.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            emptyLabel.centerXAnchor.constraint(equalTo: right.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: right.centerYAnchor),
        ])
        return root
    }

    @objc private func searchChanged(_ sender: Any?) {
        reloadRecent()
    }

    private func reloadRecent() {
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let query = search.stringValue.trimmingCharacters(in: .whitespaces).lowercased()
        var files: [(URL, Bool)] = []
        if let file = store.recoverableFile { files.append((file, true)) }
        for url in store.recentFiles where url != store.recoverableFile {
            if FileManager.default.fileExists(atPath: url.path) { files.append((url, false)) }
        }
        let shown = files.filter { query.isEmpty || $0.0.path.lowercased().contains(query) }.prefix(20)
        for (url, recoverable) in shown {
            let row = RecentRow(
                url: url, thumbnail: NSImage(contentsOf: store.thumbnailURL(for: url)), recoverable: recoverable,
                open: { [weak self] in self?.onOpenRecent(url) },
                remove: { [weak self] in
                    self?.store.removeRecent(url)
                    self?.reloadRecent()
                })
            list.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
        emptyLabel.isHidden = !shown.isEmpty
        emptyLabel.stringValue =
            files.isEmpty
            ? L10n.t("No recent files yet.\nPress ⌘N to create one.", "還沒有最近使用的檔案\n按 ⌘N 建立第一個")
            : L10n.t("No matches", "找不到符合的檔案")
    }
}

/// Empty view that takes up the remaining width in a stack.
@MainActor
private func flexibleSpace() -> NSView {
    let view = NSView()
    view.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
    view.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
    return view
}

/// A flipped document view, so the list starts at the top of the scroll view.
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// A row with hover highlighting that runs `action` when clicked.
@MainActor
private class HoverRow: NSView {
    var hovering = false { didSet { if hovering != oldValue { hoverChanged() } } }
    private let action: () -> Void

    init(action: @escaping () -> Void) {
        self.action = action
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(
            NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) {
        if bounds.contains(convert(event.locationInWindow, from: nil)) { action() }
    }

    func hoverChanged() { needsDisplay = true }
}

/// "New File…  ⌘N" in the sidebar.
@MainActor
private final class ActionRow: HoverRow {
    private let prominent: Bool

    init(symbol: String, title: String, shortcut: String?, prominent: Bool = false, action: @escaping () -> Void) {
        self.prominent = prominent
        super.init(action: action)
        let image = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil) ?? NSImage())
        image.symbolConfiguration = .init(pointSize: 15, weight: .medium)
        image.contentTintColor = prominent ? excalidrawAccent : .secondaryLabelColor
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13, weight: prominent ? .semibold : .medium)
        let key = NSTextField(labelWithString: shortcut ?? "")
        key.font = .systemFont(ofSize: 12)
        key.textColor = .secondaryLabelColor
        let row = NSStackView(views: [image, label, flexibleSpace(), key])
        row.spacing = 12
        row.edgeInsets = NSEdgeInsets(top: 9, left: 12, bottom: 9, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            image.widthAnchor.constraint(equalToConstant: 20),
        ])
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
        if prominent {
            layer?.shadowColor = NSColor.black.withAlphaComponent(0.08).cgColor
            layer?.shadowOpacity = 1
            layer?.shadowRadius = 2
            layer?.shadowOffset = NSSize(width: 0, height: -1)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        let base: NSColor = prominent ? .controlBackgroundColor : .clear
        layer?.backgroundColor = (hovering ? NSColor.labelColor.withAlphaComponent(0.07) : base).cgColor
    }

    override var wantsUpdateLayer: Bool { true }
}

/// A recent file: preview, name, folder, date. Highlighted in the accent colour on hover.
@MainActor
private final class RecentRow: HoverRow {
    private let name: NSTextField
    private let detail: NSTextField
    private let date: NSTextField
    private let recoverable: Bool

    init(url: URL, thumbnail: NSImage?, recoverable: Bool, open: @escaping () -> Void, remove: @escaping () -> Void) {
        self.recoverable = recoverable
        name = NSTextField(labelWithString: url.deletingPathExtension().lastPathComponent)
        detail = NSTextField(
            labelWithString: recoverable
                ? L10n.t("Unsaved changes — click to restore", "有未儲存的變更，點一下恢復")
                : (url.deletingLastPathComponent().path as NSString).abbreviatingWithTildeInPath)
        date = NSTextField(labelWithString: Self.relativeDate(of: url))
        super.init(action: open)

        let preview = NSImageView()
        preview.image = thumbnail ?? NSWorkspace.shared.icon(forFile: url.path)
        preview.imageScaling = .scaleProportionallyDown
        preview.wantsLayer = true
        preview.layer?.backgroundColor = NSColor.white.cgColor
        preview.layer?.cornerRadius = 5
        preview.layer?.borderWidth = 1
        preview.layer?.borderColor = NSColor.separatorColor.cgColor
        preview.translatesAutoresizingMaskIntoConstraints = false
        preview.widthAnchor.constraint(equalToConstant: 52).isActive = true
        preview.heightAnchor.constraint(equalToConstant: 36).isActive = true

        name.font = .systemFont(ofSize: 13, weight: .semibold)
        name.lineBreakMode = .byTruncatingMiddle
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detail.font = .systemFont(ofSize: 11)
        detail.lineBreakMode = .byTruncatingMiddle
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        date.font = .systemFont(ofSize: 11)
        let text = NSStackView(views: [name, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [preview, text, flexibleSpace(), date])
        row.spacing = 12
        row.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        toolTip = url.path
        setAccessibilityRole(.button)
        setAccessibilityLabel(url.lastPathComponent)

        let menu = NSMenu()
        menu.addItem(ClosureMenuItem(title: L10n.t("Show in Finder", "在 Finder 中顯示")) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        })
        menu.addItem(ClosureMenuItem(title: L10n.t("Remove from Recent", "從最近使用中移除"), run: remove))
        self.menu = menu
        hoverChanged()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = (hovering ? excalidrawAccent : NSColor.clear).cgColor
    }

    override func hoverChanged() {
        super.hoverChanged()
        name.textColor = hovering ? .white : .labelColor
        detail.textColor = hovering ? .white.withAlphaComponent(0.85) : (recoverable ? .systemOrange : .secondaryLabelColor)
        date.textColor = hovering ? .white.withAlphaComponent(0.85) : .secondaryLabelColor
    }

    /// "14:05" today, "Yesterday", else "Sep 20" (in the system language).
    private static func relativeDate(of url: URL) -> String {
        guard let modified = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        else { return "" }
        let locale = Locale(identifier: Locale.preferredLanguages.first ?? "en")
        let calendar = Calendar.current
        let formatter = DateFormatter()
        formatter.locale = locale
        if calendar.isDateInToday(modified) {
            formatter.timeStyle = .short
            return formatter.string(from: modified)
        }
        if calendar.isDateInYesterday(modified) { return L10n.t("Yesterday", "昨天") }
        formatter.setLocalizedDateFormatFromTemplate(
            calendar.isDate(modified, equalTo: Date(), toGranularity: .year) ? "MMMd" : "yMMMd")
        return formatter.string(from: modified)
    }
}

/// A menu item that runs a closure.
private final class ClosureMenuItem: NSMenuItem {
    private let run: () -> Void

    init(title: String, run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(perform(_:)), keyEquivalent: "")
        target = self
    }

    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func perform(_ sender: Any?) { run() }
}
#endif
