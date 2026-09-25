#if os(macOS)
import BridgeCore
import CryptoKit
import Foundation

/// App state kept in ~/Library/Application Support/Excalidraw/:
/// - recent files, theme and library;
/// - a recovery copy of the open drawing (autosave.excalidraw). It never touches the user's
///   file: only ⌘S does. It is used only if the app was killed with unsaved changes; a normal
///   close or quit (after "Save" / "Don't Save") discards it.
@MainActor
final class Store {
    private struct State: Codable {
        var currentFile: String?
        var dirty = false
        var theme: String?
        var recent: [String]? = []
    }

    let directory = AppPaths.supportDirectory
    /// The drawing open in this session (nil = start screen).
    private(set) var currentFile: URL?
    private(set) var dirty = false
    /// "light" / "dark", or nil to follow the system.
    private var theme: String?
    private(set) var recentFiles: [URL] = []
    /// A file that was open with unsaved changes when the app was last killed.
    private(set) var recoverableFile: URL?
    private let io = DispatchQueue(label: "store-io")

    private var autosaveURL: URL { directory.appendingPathComponent("autosave.excalidraw") }
    private var libraryURL: URL { directory.appendingPathComponent("library.json") }
    private var stateURL: URL { directory.appendingPathComponent("state.json") }

    init() {
        try? AppPaths.ensureSupportDirectory()
        guard let data = try? Data(contentsOf: stateURL), let state = try? JSONDecoder().decode(State.self, from: data)
        else { return }
        theme = state.theme
        recentFiles = (state.recent ?? []).map { URL(fileURLWithPath: $0) }
        if state.dirty, let path = state.currentFile, Self.validJSON(at: autosaveURL) != nil {
            recoverableFile = URL(fileURLWithPath: path)
        }
    }

    /// The unsaved drawing to restore when `url` is opened, if the app was killed while editing it.
    func recoveredScene(for url: URL) -> String? {
        guard let file = recoverableFile, file.standardizedFileURL == url.standardizedFileURL else { return nil }
        return Self.validJSON(at: autosaveURL)
    }

    func documentOpened(_ url: URL, dirty: Bool) {
        recoverableFile = nil
        currentFile = url
        self.dirty = dirty
        noteRecent(url)
        persistState()
    }

    /// The drawing was closed on purpose (saved or changes discarded): forget the recovery copy.
    func documentClosed() {
        currentFile = nil
        dirty = false
        persistState()
        let url = autosaveURL
        io.async { try? FileManager.default.removeItem(at: url) }
    }

    func setDirty(_ value: Bool) {
        guard value != dirty else { return }
        dirty = value
        persistState()
    }

    func noteRecent(_ url: URL) {
        recentFiles.removeAll { $0.standardizedFileURL == url.standardizedFileURL }
        recentFiles.insert(url, at: 0)
        recentFiles = Array(recentFiles.prefix(10))
        persistState()
    }

    func removeRecent(_ url: URL) {
        recentFiles.removeAll { $0.standardizedFileURL == url.standardizedFileURL }
        if recoverableFile == url { recoverableFile = nil }
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

    func saveAutosave(scene: String, theme: String?) {
        guard currentFile != nil else { return }
        let url = autosaveURL
        io.async { try? Data(scene.utf8).write(to: url, options: .atomic) }
    }

    func saveLibrary(_ items: String) {
        let url = libraryURL
        io.async { try? Data(items.utf8).write(to: url, options: .atomic) }
    }

    /// Wait for pending writes (before quitting).
    func flush() {
        io.sync {}
    }

    /// Startup data for the page (GET excalidraw://app/__native__/session). The page starts
    /// empty; drawings are loaded when the user opens a file.
    func sessionJSON() -> Data {
        flush()
        let library = Self.validJSON(at: libraryURL) ?? "null"
        let themeJSON = JSON.string(themePreference).text
        return Data("{\"scene\":null,\"theme\":\(themeJSON),\"dirty\":false,\"library\":\(library)}".utf8)
    }

    private func persistState() {
        // Keep the recovery info of a killed session until the user has opened something else.
        let file = currentFile ?? recoverableFile
        let state = State(
            currentFile: file?.path, dirty: currentFile != nil ? dirty : recoverableFile != nil, theme: theme,
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
