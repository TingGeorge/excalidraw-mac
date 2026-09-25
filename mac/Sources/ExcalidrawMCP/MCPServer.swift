import BridgeCore
import Foundation

/// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), tools only.
final class MCPServer {
    static let supportedVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
    let tools: Tools
    let version: String

    init(tools: Tools, version: String) {
        self.tools = tools
        self.version = version
    }

    func run() {
        while let line = readLine(strippingNewline: true) {
            if let reply = handle(line) { send(reply) }
        }
    }

    /// Returns the response to write, or nil for notifications and stray responses.
    func handle(_ line: String) -> JSON? {
        if line.allSatisfy({ $0.isWhitespace }) { return nil }
        guard let message = try? JSON.parse(line), message.object != nil else {
            return error(id: .null, code: -32700, "Parse error")
        }
        guard let method = message["method"]?.string else { return nil }  // a response to a request we never send
        guard let id = message["id"], id != .null else { return nil }  // notification
        let params = message["params"] ?? [:]

        switch method {
        case "initialize":
            let requested = params["protocolVersion"]?.string ?? ""
            let chosen = Self.supportedVersions.contains(requested) ? requested : Self.supportedVersions[0]
            return result(id: id, [
                "protocolVersion": .string(chosen),
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": "excalidraw-mac", "title": "Excalidraw for Mac", "version": .string(version)],
                "instructions": .string(serverInstructions),
            ])
        case "ping":
            return result(id: id, [:])
        case "tools/list":
            return result(id: id, ["tools": toolDefinitions])
        case "tools/call":
            guard let name = params["name"]?.string else {
                return error(id: id, code: -32602, "tools/call needs a tool name")
            }
            return result(id: id, tools.call(name: name, arguments: params["arguments"]?.object ?? [:]))
        default:
            return error(id: id, code: -32601, "Method not found: \(method)")
        }
    }

    private func result(id: JSON, _ result: JSON) -> JSON {
        ["jsonrpc": "2.0", "id": id, "result": result]
    }

    private func error(id: JSON, code: Int, _ message: String) -> JSON {
        ["jsonrpc": "2.0", "id": id, "error": ["code": .int(code), "message": .string(message)]]
    }

    private func send(_ message: JSON) {
        FileHandle.standardOutput.write(Data((message.text + "\n").utf8))
    }
}
