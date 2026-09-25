#if os(macOS)
import BridgeCore
import Foundation

/// What survives a relaunch: the canvas (autosaved), the open file, unsaved state,
/// theme and library. Lives in ~/Library/Application Support/Excalidraw/.
@MainActor
final class Store {
    private struct State: Codable {
        var currentFile: String?
        var dirty = false
        var theme: String?
    }

    let directory = AppPaths.supportDirectory
    private(set) var currentFile: URL?
    private(set) var dirty = false
    private var theme: String?
    private let io = DispatchQueue(label: "store-io")

    private var autosaveURL: URL { directory.appendingPathComponent("autosave.excalidraw") }
    private var libraryURL: URL { directory.appendingPathComponent("library.json") }
    private var stateURL: URL { directory.appendingPathComponent("state.json") }

    init() {
        try? AppPaths.ensureSupportDirectory()
        if let data = try? Data(contentsOf: stateURL), let state = try? JSONDecoder().decode(State.self, from: data) {
            currentFile = state.currentFile.map { URL(fileURLWithPath: $0) }
            dirty = state.dirty
            theme = state.theme
        }
    }

    func setCurrentFile(_ url: URL?) {
        currentFile = url
        persistState()
    }

    func setDirty(_ value: Bool) {
        guard value != dirty else { return }
        dirty = value
        persistState()
    }

    func saveAutosave(scene: String, theme: String?) {
        if let theme, theme != self.theme {
            self.theme = theme
            persistState()
        }
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

    /// Startup data for the page (GET excalidraw://app/__native__/session).
    func sessionJSON() -> Data {
        flush()
        let scene = Self.validJSON(at: autosaveURL) ?? "null"
        let library = Self.validJSON(at: libraryURL) ?? "null"
        let themeJSON = theme.map { JSON.string($0).text } ?? "null"
        return Data("{\"scene\":\(scene),\"theme\":\(themeJSON),\"dirty\":\(dirty),\"library\":\(library)}".utf8)
    }

    private func persistState() {
        let state = State(currentFile: currentFile?.path, dirty: dirty, theme: theme)
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
