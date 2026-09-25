import Foundation

/// An error reported by the app (e.g. "no element with id …"), as opposed to a transport failure.
public struct BridgeError: Error, CustomStringConvertible {
    public let description: String
    public init(_ message: String) { description = message }
}

/// Calls the running Excalidraw app:  {"id":1,"method":"…","params":{…}}  ->  {"id":1,"ok":true,"result":…}
public final class BridgeClient {
    public let socketPath: String
    /// Starts the app when nobody is listening; nil = don't try.
    public var launch: (() throws -> Void)?
    public var launchTimeout: TimeInterval = 30
    public var callTimeoutSeconds = 180

    private var connection: LineConnection?
    private var nextID = 1

    public init(socketPath: String = AppPaths.socketPath, launch: (() throws -> Void)? = nil) {
        self.socketPath = socketPath
        self.launch = launch
    }

    public func call(_ method: String, _ params: JSON = [:]) throws -> JSON {
        let reused = connection != nil
        do {
            return try callOnce(method, params)
        } catch let error as SocketError {
            connection?.close()
            connection = nil
            // The app may have been restarted since we last connected: reconnect once.
            guard reused, !error.isTimeout else { throw error }
            return try callOnce(method, params)
        }
    }

    private func callOnce(_ method: String, _ params: JSON) throws -> JSON {
        let conn = try connect()
        let id = nextID
        nextID += 1
        let request: JSON = ["id": .int(id), "method": .string(method), "params": params]
        try conn.writeLine(request.text)
        while true {
            guard let line = try conn.readLine() else {
                connection = nil
                throw SocketError(message: "the Excalidraw app closed the connection")
            }
            let reply = try JSON.parse(line)
            guard case .int(let replyID)? = reply["id"], replyID == id else { continue }
            if reply["ok"]?.bool == true { return reply["result"] ?? .null }
            throw BridgeError(reply["error"]?.string ?? "unknown error from the Excalidraw app")
        }
    }

    private func connect() throws -> LineConnection {
        if let c = connection { return c }
        let conn: LineConnection
        do {
            conn = try LineConnection.connect(path: socketPath)
        } catch let error as SocketError where error.isNotRunning {
            guard let launch else {
                throw BridgeError("The Excalidraw app is not running (no socket at \(socketPath)).")
            }
            try launch()
            conn = try waitForSocket()
        }
        conn.setReadTimeout(seconds: callTimeoutSeconds)
        connection = conn
        return conn
    }

    private func waitForSocket() throws -> LineConnection {
        let deadline = Date().addingTimeInterval(launchTimeout)
        while Date() < deadline {
            if let c = try? LineConnection.connect(path: socketPath) { return c }
            Thread.sleep(forTimeInterval: 0.2)
        }
        throw BridgeError("Started the Excalidraw app, but it did not become ready within \(Int(launchTimeout)) seconds.")
    }
}
