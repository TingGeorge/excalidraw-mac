#if os(macOS)
import AppKit
import BridgeCore

/// Listens on the Unix socket for the MCP server (excalidraw-mcp) and passes its requests to
/// the page of the frontmost drawing window. Only canvas operations are allowed: agents can't
/// open, save or export files.
@MainActor
final class AppBridge {
    /// Methods that work even when no drawing is open.
    static let anytime: Set<String> = ["ping", "diagnostics", "status", "window_info"]
    /// Page methods an agent may call.
    static let forwarded: Set<String> = [
        "ping", "diagnostics", "status", "get_scene", "add_elements", "add_mermaid", "update_elements",
        "delete_elements", "clear_canvas", "export_image", "zoom_to_fit",
    ]

    /// The drawing window agents work on (the frontmost one), nil when no drawing is open.
    private let canvas: () -> CanvasController?
    /// Every drawing window (window_info, for tests).
    private let canvases: () -> [CanvasController]
    private var server: LineServer?
    /// Called on the main thread when an agent connects or the last one disconnects.
    var onAgentConnected: ((Bool) -> Void)?

    init(canvas: @escaping () -> CanvasController?, canvases: @escaping () -> [CanvasController]) {
        self.canvas = canvas
        self.canvases = canvases
    }

    func start() throws {
        try AppPaths.ensureSupportDirectory()
        let server = LineServer(path: AppPaths.socketPath) { [weak self] line, connection in
            Task { @MainActor in
                self?.handle(line) { reply in try? connection.writeLine(reply) }
            }
        }
        server.onConnectionsChanged = { [weak self] count in
            Task { @MainActor in self?.onAgentConnected?(count > 0) }
        }
        try server.start()
        self.server = server
    }

    func stop() {
        server?.stop()
    }

    private static var visibleWindows: Int {
        NSApp.windows.filter { $0.isVisible && !($0 is NSPanel) }.count
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

        // Agents work on the drawing the user has open (the frontmost one); they never open or
        // save files.
        guard let canvas = canvas() ?? canvases().first else {
            if method == "window_info" { return respond(.success(["visibleWindows": .int(Self.visibleWindows)])) }
            return respond(
                .failure(
                    BridgeError(
                        "No drawing is open in Excalidraw. Ask the user to create a new file (File > New File…) or open one in the app, then try again."
                    )))
        }
        if !Self.anytime.contains(method) && !canvas.hasDocument {
            return respond(
                .failure(
                    BridgeError(
                        "No drawing is open in Excalidraw. Ask the user to create a new file (File > New File…) or open one in the app, then try again."
                    )))
        }

        switch method {
        case "window_info":
            // Screen position of the drawing window (top-left origin), for UI tests.
            let frame = canvas.window.frame
            let screenHeight = NSScreen.screens.first?.frame.height ?? 0
            respond(
                .success([
                    "x": .double(frame.minX), "y": .double(screenHeight - frame.maxY),
                    "width": .double(frame.width), "height": .double(frame.height),
                    "visible": .bool(canvas.window.isVisible),
                    "trafficLightsStart": .double(
                        Double(canvas.window.standardWindowButton(.closeButton).map { $0.convert($0.bounds, to: nil).minX } ?? -1)),
                    "trafficLightsEnd": .double(Double(canvas.trafficLightsEnd)),
                    "trafficLightPasses": .int(canvas.trafficLightPasses),
                    "trafficLightMoves": .int(canvas.trafficLightMoves),
                    // Middle of the traffic lights, from the top of the window (the row's middle is 26).
                    "trafficLightsMiddle": .double(
                        Double(
                            canvas.window.standardWindowButton(.closeButton).map {
                                frame.height - $0.convert($0.bounds, to: nil).midY
                            } ?? -1)),
                    // Each of close / minimise / zoom: [left, middle from the top of the window,
                    // how much of it is visible (1 = all)], plus the views holding it.
                    "trafficLights": .array(
                        canvas.trafficLights.map { button in
                            let r = button.convert(button.bounds, to: nil)
                            let shown = button.visibleRect.width * button.visibleRect.height
                            return .array([
                                .double(Double(r.minX)), .double(Double(frame.height - r.midY)),
                                .double(Double(shown / max(1, r.width * r.height))),
                            ])
                        }),
                    "trafficLightViews": .string(
                        canvas.trafficLights.map { button in
                            var chain: [String] = []
                            var view: NSView? = button
                            while let v = view {
                                chain.append("\(type(of: v)) \(NSStringFromRect(v.frame))")
                                view = v.superview
                            }
                            return chain.joined(separator: " < ")
                        }.joined(separator: "\n")),
                    "appearance": .string(canvas.window.effectiveAppearance.name == .darkAqua ? "dark" : "light"),
                    // The drawing windows or the start screen, never both.
                    "visibleWindows": .int(Self.visibleWindows),
                    // Every drawing open, frontmost first.
                    "files": .array(canvases().compactMap { $0.file.map { .string($0.path) } }),
                ]))

        case "get_scene":
            canvas.call("get_scene", params) { result in
                respond(
                    result.map { scene in
                        var o = scene.object ?? [:]
                        o["file"] = canvas.file.map { .string($0.path) } ?? .null
                        o["dirty"] = .bool(canvas.dirty)
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
