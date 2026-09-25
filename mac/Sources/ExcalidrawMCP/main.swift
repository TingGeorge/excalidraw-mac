import BridgeCore
import Foundation

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// excalidraw-mcp: an MCP server (stdio) that lets AI agents draw in the Excalidraw app.
// It lives inside Excalidraw.app/Contents/MacOS/ and starts the app when needed.

let version = "0.1.0"
signal(SIGPIPE, SIG_IGN)

if CommandLine.arguments.contains("--version") {
    print("excalidraw-mcp \(version)")
    exit(0)
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("excalidraw-mcp: \(message)\n".utf8))
}

/// Starts Excalidraw.app in the background (without taking focus from the terminal).
func launchApp() throws {
    #if os(macOS)
    let env = ProcessInfo.processInfo.environment
    var args = ["-g"]
    // Keep the app and this server on the same support folder (tests use a temporary one).
    if let home = env["EXCALIDRAW_MAC_HOME"], !home.isEmpty {
        args += ["--env", "EXCALIDRAW_MAC_HOME=\(home)"]
    }
    if let path = env["EXCALIDRAW_APP_PATH"], !path.isEmpty {
        args.append(path)
    } else if Bundle.main.bundleURL.pathExtension == "app" {
        args.append(Bundle.main.bundleURL.path)  // the app this binary ships in
    } else {
        args += ["-b", AppPaths.bundleIdentifier]
    }
    log("starting the app: open \(args.joined(separator: " "))")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = args
    p.standardOutput = FileHandle.standardError
    p.standardError = FileHandle.standardError
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else {
        throw BridgeError("Could not start Excalidraw.app (is it in /Applications?).")
    }
    #else
    throw BridgeError("The Excalidraw app is not running.")
    #endif
}

let bridge = BridgeClient(launch: launchApp)
MCPServer(tools: Tools(bridge: bridge), version: version).run()
