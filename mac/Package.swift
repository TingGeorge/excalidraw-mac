// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ExcalidrawMac",
    platforms: [.macOS(.v13)],
    products: [
        // The app itself (AppKit + WKWebView; macOS only).
        .executable(name: "Excalidraw", targets: ["ExcalidrawApp"]),
        // The MCP server agents launch; it talks to the running app over a Unix socket.
        .executable(name: "excalidraw-mcp", targets: ["ExcalidrawMCP"]),
    ],
    targets: [
        .target(name: "BridgeCore"),
        .executableTarget(name: "ExcalidrawApp", dependencies: ["BridgeCore"]),
        .executableTarget(name: "ExcalidrawMCP", dependencies: ["BridgeCore"]),
    ]
)
