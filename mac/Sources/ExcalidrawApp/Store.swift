#if os(macOS)
import BridgeCore
import CryptoKit
import Foundation

/// App state kept in ~/Library/Application Support/Excalidraw/:
/// - recent files, theme and library;
/// - the drawings open in this session, each with a recovery copy (autosave/<hash>.excalidraw).
///   A recovery copy never touches the user's file: only ⌘S does. It is used only if the app
///   was killed with unsaved changes in that drawing; a normal close or quit (after "Save" /
///   "Don't Save") discards it.
@MainActor
final class Store {
    private struct OpenFile: Codable {
        var file: String
        var dirty: Bool
    }

    private struct State: Codable {
        var open: [OpenFile]?
        var theme: String?
        var recent: [String]? = []
        // Before several windows: the one drawing that was open.
        var currentFile: String?
        var dirty: Bool?
    }

    let directory = AppPaths.supportDirectory
    /// The drawings open in this session and whether each has unsaved changes.
    private var open: [(url: URL, dirty: Bool)] = []
    /// "light" / "dark", or nil to follow the system.
    private var theme: String?
    private(set) var recentFiles: [URL] = []
    /// Files that were open with unsaved changes when the app was last killed.
    private(set) var recoverableFiles: [URL] = []
    private var library: String?
    private let io = DispatchQueue(label: "store-io")

    private var libraryURL: URL { directory.appendingPathComponent("library.json") }
    private var stateURL: URL { directory.appendingPathComponent("state.json") }
    /// Where the recovery copy of the one drawing lived before several windows.
    private var legacyAutosaveURL: URL { directory.appendingPathComponent("autosave.excalidraw") }

    init() {
        try? AppPaths.ensureSupportDirectory()
        guard let data = try? Data(contentsOf: stateURL), let state = try? JSONDecoder().decode(State.self, from: data)
        else { return }
        theme = state.theme
        recentFiles = (state.recent ?? []).map { URL(fileURLWithPath: $0) }
        var killed = (state.open ?? []).filter(\.dirty).map { URL(fileURLWithPath: $0.file) }
        if state.open == nil, state.dirty == true, let path = state.currentFile {
            let url = URL(fileURLWithPath: path)
            try? FileManager.default.createDirectory(
                at: autosaveURL(for: url).deletingLastPathComponent(), withIntermediateDirectories: true)
            try? FileManager.default.moveItem(at: legacyAutosaveURL, to: autosaveURL(for: url))
            killed = [url]
        }
        recoverableFiles = killed.filter { Self.validJSON(at: autosaveURL(for: $0)) != nil }
        // Until each is opened again (or removed from the recent files), they stay recoverable.
        open = recoverableFiles.map { ($0, true) }
    }

    private func key(_ url: URL) -> String { url.standardizedFileURL.path }

    private func autosaveURL(for url: URL) -> URL {
        let digest = SHA256.hash(data: Data(key(url).utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined().prefix(32)
        return directory.appendingPathComponent("autosave/\(name).excalidraw")
    }

    private func isRecoverable(_ url: URL) -> Bool { recoverableFiles.contains { key($0) == key(url) } }

    /// The unsaved drawing to restore when `url` is opened, if the app was killed while editing it.
    func recoveredScene(for url: URL) -> String? {
        guard isRecoverable(url) else { return nil }
        return Self.validJSON(at: autosaveURL(for: url))
    }

    func documentOpened(_ url: URL, dirty: Bool) {
        recoverableFiles.removeAll { key($0) == key(url) }
        open.removeAll { key($0.url) == key(url) }
        open.append((url, dirty))
        noteRecent(url)
    }

    /// Save As: the drawing is now `url`; its recovery copy goes with it.
    func documentMoved(from old: URL, to url: URL, dirty: Bool) {
        guard key(old) != key(url) else { return documentOpened(url, dirty: dirty) }
        open.removeAll { key($0.url) == key(old) }
        discardAutosave(for: old)
        documentOpened(url, dirty: dirty)
    }

    /// The drawing was closed on purpose (saved or changes discarded): forget its recovery copy.
    func documentClosed(_ url: URL) {
        open.removeAll { key($0.url) == key(url) }
        persistState()
        discardAutosave(for: url)
    }

    private func discardAutosave(for url: URL) {
        let file = autosaveURL(for: url)
        io.async { try? FileManager.default.removeItem(at: file) }
    }

    func setDirty(_ value: Bool, for url: URL) {
        guard let i = open.firstIndex(where: { key($0.url) == key(url) }), open[i].dirty != value else { return }
        open[i].dirty = value
        persistState()
    }

    func noteRecent(_ url: URL) {
        recentFiles.removeAll { key($0) == key(url) }
        recentFiles.insert(url, at: 0)
        recentFiles = Array(recentFiles.prefix(10))
        persistState()
    }

    func removeRecent(_ url: URL) {
        recentFiles.removeAll { key($0) == key(url) }
        if isRecoverable(url) {
            recoverableFiles.removeAll { key($0) == key(url) }
            documentClosed(url)
        }
        persistState()
    }

    /// A small preview of `file` for the start screen (written when the file is opened or saved).
    func thumbnailURL(for file: URL) -> URL {
        let digest = SHA256.hash(data: Data(file.standardizedFileURL.path.utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined().prefix(32)
        return directory.appendingPathComponent("thumbnails/\(name).png")
    }

    func saveThumbnail(_ png: Data?, for file: URL) {
        let url = thumbnailURL(for: file)
        io.async {
            if let png {
                try? FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? png.write(to: url, options: .atomic)
            } else {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    /// "system", "light" or "dark" (Settings, the View menu, Excalidraw's own menu).
    var themePreference: String { theme ?? "system" }

    func setThemePreference(_ value: String) {
        let theme = value == "light" || value == "dark" ? value : nil
        guard theme != self.theme else { return }
        self.theme = theme
        persistState()
    }

    func saveAutosave(scene: String, for url: URL) {
        guard open.contains(where: { key($0.url) == key(url) }) else { return }
        let file = autosaveURL(for: url)
        io.async {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? Data(scene.utf8).write(to: file, options: .atomic)
        }
    }

    /// Saves the library (shared by all windows). false when it is what was saved last.
    @discardableResult
    func saveLibrary(_ items: String) -> Bool {
        guard items != library else { return false }
        library = items
        let url = libraryURL
        io.async { try? Data(items.utf8).write(to: url, options: .atomic) }
        return true
    }

    /// Wait for pending writes (before quitting).
    func flush() {
        io.sync {}
    }

    /// Startup data for each window's page (GET excalidraw://app/__native__/session). The page
    /// starts empty; drawings are loaded when the user opens a file.
    func sessionJSON() -> Data {
        flush()
        let library = self.library ?? Self.validJSON(at: libraryURL) ?? "null"
        let themeJSON = JSON.string(themePreference).text
        return Data("{\"scene\":null,\"theme\":\(themeJSON),\"dirty\":false,\"library\":\(library)}".utf8)
    }

    private func persistState() {
        let state = State(
            open: open.map { OpenFile(file: $0.url.path, dirty: $0.dirty) }, theme: theme,
            recent: recentFiles.map(\.path))
        guard let data = try? JSONEncoder().encode(state) else { return }
        let url = stateURL
        io.async { try? data.write(to: url, options: .atomic) }
    }

    private static func validJSON(at url: URL) -> String? {
        guard let data = try? Data(contentsOf: url), (try? JSONSerialization.jsonObject(with: data)) != nil else {
            return nil
        }
        return String(decoding: data, as: UTF8.self)
    }
}
#endif
