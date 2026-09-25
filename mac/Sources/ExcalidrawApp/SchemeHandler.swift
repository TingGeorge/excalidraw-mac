#if os(macOS)
import Foundation
import WebKit

/// Serves the bundled Excalidraw page from Contents/Resources/web at excalidraw://app/,
/// so nothing is ever loaded from the network.
@MainActor
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "excalidraw"
    static let startURL = URL(string: "excalidraw://app/index.html")!

    private let root: URL
    private let session: () -> Data

    init(root: URL, session: @escaping () -> Data) {
        self.root = root.standardizedFileURL
        self.session = session
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        var status = 200
        var type = "application/json"
        var data: Data
        if path == "/__native__/session" {
            data = session()
        } else {
            let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
            if file.path.hasPrefix(root.path + "/"), let contents = try? Data(contentsOf: file) {
                data = contents
                type = Self.mimeType(for: file.pathExtension)
            } else {
                status = 404
                type = "text/plain"
                data = Data("Not found".utf8)
            }
        }
        let headers = [
            "Content-Type": type,
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        ]
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "ico": return "image/x-icon"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }
}
#endif
