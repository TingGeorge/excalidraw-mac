import BridgeCore
import Foundation

/// Implements the MCP tools on top of the app bridge.
final class Tools {
    let bridge: BridgeClient
    let workingDirectory: URL

    init(bridge: BridgeClient, workingDirectory: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)) {
        self.bridge = bridge
        self.workingDirectory = workingDirectory
    }

    /// Result of tools/call. Tool failures are reported in-band (isError) so the agent can react.
    func call(name: String, arguments: [String: JSON]) -> JSON {
        do {
            return ["content": .array(try run(name, arguments))]
        } catch {
            return ["content": [text("Error: \(error)")], "isError": true]
        }
    }

    private func run(_ name: String, _ args: [String: JSON]) throws -> [JSON] {
        switch name {
        case "get_scene", "add_elements", "add_mermaid", "update_elements", "delete_elements", "clear_canvas",
            "zoom_to_fit":
            return [text(try bridge.call(name, .object(args)).text)]
        case "export_image":
            return try exportImage(args)
        case "save_file":
            var params: [String: JSON] = [:]
            if let path = args["path"]?.string {
                var url = resolve(path)
                if url.pathExtension.isEmpty { url.appendPathExtension("excalidraw") }
                try createParent(of: url)
                params["path"] = .string(url.path)
            }
            let r = try bridge.call("save_file", .object(params))
            return [text("Saved to \(r["path"]?.string ?? "?")")]
        case "open_file":
            guard let path = args["path"]?.string else { throw BridgeError("`path` is required") }
            let url = resolve(path)
            guard FileManager.default.fileExists(atPath: url.path) else { throw BridgeError("no such file: \(url.path)") }
            var params = args
            params["path"] = .string(url.path)
            return [text(try bridge.call("open_file", .object(params)).text)]
        default:
            throw BridgeError("unknown tool \"\(name)\"")
        }
    }

    private func exportImage(_ args: [String: JSON]) throws -> [JSON] {
        var params = args
        let path = params.removeValue(forKey: "path")?.string
        let returnImage = params.removeValue(forKey: "return_image")?.bool ?? (path == nil)
        if params["scale"] == nil { params["scale"] = path == nil ? 1 : 2 }
        let r = try bridge.call("export_image", .object(params))
        let size = "\(r["width"]?.number.map { Int($0) } ?? 0)x\(r["height"]?.number.map { Int($0) } ?? 0)"
        var content: [JSON] = []

        if r["mimeType"]?.string == "image/svg+xml" {
            let svg = r["text"]?.string ?? ""
            if let path {
                let url = resolve(path)
                try createParent(of: url)
                try Data(svg.utf8).write(to: url, options: .atomic)
                content.append(text("Saved SVG (\(size)) to \(url.path)"))
            } else {
                content.append(text(svg))
            }
            return content
        }

        guard let b64 = r["base64"]?.string, let data = Data(base64Encoded: b64) else {
            throw BridgeError("the app returned no image data")
        }
        if let path {
            let url = resolve(path)
            try createParent(of: url)
            try data.write(to: url, options: .atomic)
            content.append(text("Saved PNG (\(size) px) to \(url.path)"))
        }
        if returnImage {
            content.append(["type": "image", "data": .string(b64), "mimeType": "image/png"])
            if path == nil { content.append(text("PNG \(size) px")) }
        }
        return content
    }

    private func text(_ s: String) -> JSON { ["type": "text", "text": .string(s)] }

    func resolve(_ path: String) -> URL {
        var p = path
        if p == "~" || p.hasPrefix("~/") {
            p = FileManager.default.homeDirectoryForCurrentUser.path + p.dropFirst()
        }
        if p.hasPrefix("/") { return URL(fileURLWithPath: p).standardizedFileURL }
        return workingDirectory.appendingPathComponent(p).standardizedFileURL
    }

    private func createParent(of url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    }
}
