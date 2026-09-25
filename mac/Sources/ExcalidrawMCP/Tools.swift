import BridgeCore
import Foundation

/// Implements the MCP tools on top of the app bridge. Tools only touch the canvas of the
/// drawing the user has open; nothing here reads or writes files.
final class Tools {
    let bridge: BridgeClient

    init(bridge: BridgeClient) {
        self.bridge = bridge
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
        case "render_image":
            var params = args
            params["format"] = "png"
            if params["scale"] == nil { params["scale"] = 1 }
            let r = try bridge.call("export_image", .object(params))
            guard let b64 = r["base64"]?.string else { throw BridgeError("the app returned no image data") }
            let size = "\(r["width"]?.number.map { Int($0) } ?? 0)x\(r["height"]?.number.map { Int($0) } ?? 0)"
            return [["type": "image", "data": .string(b64), "mimeType": "image/png"], text("PNG \(size) px")]
        default:
            throw BridgeError("unknown tool \"\(name)\"")
        }
    }

    private func text(_ s: String) -> JSON { ["type": "text", "text": .string(s)] }
}
