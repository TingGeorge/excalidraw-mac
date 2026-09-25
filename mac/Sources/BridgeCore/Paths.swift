import Foundation

public enum AppPaths {
    public static let bundleIdentifier = "io.github.tinggeorge.excalidraw"

    /// Where the app keeps its autosave, settings and the bridge socket.
    /// `EXCALIDRAW_MAC_HOME` overrides it (used by tests).
    public static var supportDirectory: URL {
        if let dir = ProcessInfo.processInfo.environment["EXCALIDRAW_MAC_HOME"], !dir.isEmpty {
            return URL(fileURLWithPath: dir, isDirectory: true)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        #if os(macOS)
        return home.appendingPathComponent("Library/Application Support/Excalidraw", isDirectory: true)
        #else
        return home.appendingPathComponent(".local/share/excalidraw-mac", isDirectory: true)
        #endif
    }

    /// The Unix socket the running app listens on (only the user can open it: the folder is 0700).
    public static var socketPath: String {
        supportDirectory.appendingPathComponent("bridge.sock").path
    }

    public static func ensureSupportDirectory() throws {
        try FileManager.default.createDirectory(
            at: supportDirectory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }
}
