#if os(macOS)
import BridgeCore
import Foundation

/// Listens on the Unix socket for the MCP server (excalidraw-mcp) and passes its requests to
/// the page. Only canvas operations are allowed: agents can't open, save or export files.
@MainActor
final class AppBridge {
    /// Methods that work even when no drawing is open.
    static let anytime: Set<String> = ["ping", "diagnostics", "status"]
    /// Page methods an agent may call.
    static let forwarded: Set<String> = [
        "ping", "diagnostics", "status", "get_scene", "add_elements", "add_mermaid", "update_elements",
        "delete_elements", "clear_canvas", "export_image", "zoom_to_fit",
    ]

    private let canvas: CanvasController
    private let store: Store
    private var server: LineServer?

    init(canvas: CanvasController, store: Store) {
        self.canvas = canvas
        self.store = store
    }

    func start() throws {
        try AppPaths.ensureSupportDirectory()
        let server = LineServer(path: AppPaths.socketPath) { [weak self] line, connection in
            Task { @MainActor in
                self?.handle(line) { reply in try? connection.writeLine(reply) }
            }
        }
        try server.start()
        self.server = server
    }

    func stop() {
        server?.stop()
    }

    private func handle(_ line: String, reply: @escaping (String) -> Void) {
        guard let request = try? JSON.parse(line), let id = request["id"] else { return }
        let method = request["method"]?.string ?? ""
        let params = request["params"] ?? [:]
        let respond = { (result: Result<JSON, BridgeError>) in
            switch result {
            case .success(let value): reply((["id": id, "ok": true, "result": value] as JSON).text)
            case .failure(let error): reply((["id": id, "ok": false, "error": .string(error.description)] as JSON).text)
            }
        }

        // Agents work on the drawing the user has open; they never open or save files.
        if !Self.anytime.contains(method) && !canvas.hasDocument {
            return respond(
                .failure(
                    BridgeError(
                        "No drawing is open in Excalidraw. Ask the user to create a new file (File > New File…) or open one in the app, then try again."
                    )))
        }

        switch method {
        case "get_scene":
            canvas.call("get_scene", params) { result in
                respond(
                    result.map { scene in
                        var o = scene.object ?? [:]
                        o["file"] = self.store.currentFile.map { .string($0.path) } ?? .null
                        o["dirty"] = .bool(self.store.dirty)
                        return .object(o)
                    })
            }

        default:
            guard Self.forwarded.contains(method) else {
                return respond(.failure(BridgeError("unknown method \"\(method)\"")))
            }
            canvas.call(method, params, completion: respond)
        }
    }
}
#endif
