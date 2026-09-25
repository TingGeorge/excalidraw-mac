#if os(macOS)
import BridgeCore
import Foundation

/// Listens on the Unix socket for the MCP server (excalidraw-mcp) and runs its requests.
/// File operations are done here so they behave exactly like the File menu;
/// everything else is passed to the page.
@MainActor
final class AppBridge {
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

        switch method {
        case "open_file":
            guard let path = params["path"]?.string else { return respond(.failure(BridgeError("`path` is required"))) }
            if store.dirty && params["discard_changes"]?.bool != true {
                let file = store.currentFile.map { " to \($0.path)" } ?? ""
                return respond(
                    .failure(
                        BridgeError(
                            "The canvas has unsaved changes\(file). Save them with save_file first, or pass discard_changes: true to replace them."
                        )))
            }
            canvas.open(URL(fileURLWithPath: path)) { error in
                if let error { respond(.failure(error)) } else { respond(.success(["path": .string(path)])) }
            }

        case "save_file":
            guard let url = params["path"]?.string.map({ URL(fileURLWithPath: $0) }) ?? store.currentFile else {
                return respond(.failure(BridgeError("This drawing has never been saved: pass a path.")))
            }
            canvas.write(to: url) { error in
                if let error { respond(.failure(error)) } else { respond(.success(["path": .string(url.path)])) }
            }

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
