import Foundation

#if canImport(Darwin)
import Darwin
private let sockStream = Int32(SOCK_STREAM)
#else
import Glibc
private let sockStream = Int32(SOCK_STREAM.rawValue)
#endif

/// Newline-delimited JSON over a Unix domain socket: the app <-> MCP server wire.
public struct SocketError: Error, CustomStringConvertible {
    public let description: String
    public let code: Int32

    init(_ what: String, code: Int32 = errno) {
        self.code = code
        self.description = "\(what): \(String(cString: strerror(code)))"
    }

    init(message: String, code: Int32 = 0) {
        self.code = code
        self.description = message
    }

    /// Nobody is listening (socket file missing or stale).
    public var isNotRunning: Bool { code == ENOENT || code == ECONNREFUSED }
    public var isTimeout: Bool { code == EAGAIN }
}

private func makeAddress(_ path: String) throws -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    guard bytes.count < capacity else {
        throw SocketError(message: "socket path is too long (\(bytes.count) bytes, max \(capacity - 1)): \(path)")
    }
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
        buf.copyBytes(from: bytes)
        buf[bytes.count] = 0
    }
    #if canImport(Darwin)
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    #endif
    return addr
}

private func withSockaddr<T>(_ addr: inout sockaddr_un, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
    withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            body($0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
}

private func sysConnect(_ fd: Int32, _ addr: UnsafePointer<sockaddr>, _ len: socklen_t) -> Int32 {
    #if canImport(Darwin)
    return Darwin.connect(fd, addr, len)
    #else
    return Glibc.connect(fd, addr, len)
    #endif
}

/// One connected socket, read and written line by line. Writes are thread-safe.
public final class LineConnection: @unchecked Sendable {
    public let fd: Int32
    private var buffer = [UInt8]()
    private let writeLock = NSLock()
    private let closeLock = NSLock()
    private var closed = false

    init(fd: Int32) {
        self.fd = fd
        #if canImport(Darwin)
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        #endif
    }

    deinit { close() }

    /// Give up on a read after `seconds` (0 = wait forever).
    public func setReadTimeout(seconds: Int) {
        var tv = timeval(tv_sec: seconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    /// The next line without its "\n", or nil at end of stream.
    public func readLine() throws -> String? {
        while true {
            if let nl = buffer.firstIndex(of: 10) {
                let line = String(decoding: buffer[..<nl], as: UTF8.self)
                buffer.removeSubrange(...nl)
                return line
            }
            var chunk = [UInt8](repeating: 0, count: 65536)
            let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n > 0 {
                buffer.append(contentsOf: chunk[..<n])
            } else if n == 0 {
                return nil
            } else if errno == EINTR {
                continue
            } else if errno == EAGAIN || errno == EWOULDBLOCK {
                throw SocketError(message: "timed out waiting for the Excalidraw app to answer", code: EAGAIN)
            } else {
                throw SocketError("read")
            }
        }
    }

    public func writeLine(_ line: String) throws {
        writeLock.lock()
        defer { writeLock.unlock() }
        var data = Array(line.utf8)
        data.append(10)
        var offset = 0
        while offset < data.count {
            #if canImport(Darwin)
            let n = data[offset...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            #else
            let n = data[offset...].withUnsafeBytes { send(fd, $0.baseAddress, $0.count, Int32(MSG_NOSIGNAL)) }
            #endif
            if n < 0 {
                if errno == EINTR { continue }
                throw SocketError("write")
            }
            offset += n
        }
    }

    public func close() {
        closeLock.lock()
        defer { closeLock.unlock() }
        if !closed {
            closed = true
            _ = shutdown(fd, Int32(SHUT_RDWR))
            #if canImport(Darwin)
            _ = Darwin.close(fd)
            #else
            _ = Glibc.close(fd)
            #endif
        }
    }

    public static func connect(path: String) throws -> LineConnection {
        let fd = socket(AF_UNIX, sockStream, 0)
        guard fd >= 0 else { throw SocketError("socket") }
        var addr = try makeAddress(path)
        let rc = withSockaddr(&addr) { sysConnect(fd, $0, $1) }
        if rc != 0 {
            let err = SocketError("connect to \(path)")
            #if canImport(Darwin)
            _ = Darwin.close(fd)
            #else
            _ = Glibc.close(fd)
            #endif
            throw err
        }
        return LineConnection(fd: fd)
    }
}

/// Accepts connections on a Unix socket and calls `onLine` for every line received
/// (on that connection's own background thread).
public final class LineServer: @unchecked Sendable {
    public let path: String
    private let onLine: @Sendable (String, LineConnection) -> Void
    private var listenFD: Int32 = -1

    public init(path: String, onLine: @escaping @Sendable (String, LineConnection) -> Void) {
        self.path = path
        self.onLine = onLine
    }

    public func start() throws {
        // A socket file left over from a crash: remove it unless something answers.
        if FileManager.default.fileExists(atPath: path) {
            if let probe = try? LineConnection.connect(path: path) {
                probe.close()
                throw SocketError(message: "another Excalidraw app is already listening on \(path)")
            }
            unlink(path)
        }
        let fd = socket(AF_UNIX, sockStream, 0)
        guard fd >= 0 else { throw SocketError("socket") }
        var addr = try makeAddress(path)
        let oldMask = umask(0o077)  // socket file is created 0600
        let rc = withSockaddr(&addr) { bind(fd, $0, $1) }
        umask(oldMask)
        guard rc == 0 else { throw SocketError("bind \(path)") }
        guard listen(fd, 16) == 0 else { throw SocketError("listen") }
        listenFD = fd
        let thread = Thread { [weak self] in self?.acceptLoop(fd) }
        thread.name = "bridge-accept"
        thread.start()
    }

    public func stop() {
        if listenFD >= 0 {
            _ = shutdown(listenFD, Int32(SHUT_RDWR))
            #if canImport(Darwin)
            _ = Darwin.close(listenFD)
            #else
            _ = Glibc.close(listenFD)
            #endif
            listenFD = -1
            unlink(path)
        }
    }

    private func acceptLoop(_ fd: Int32) {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                return  // listening socket closed
            }
            let conn = LineConnection(fd: client)
            let t = Thread { [onLine] in
                while let line = try? conn.readLine() {
                    if !line.isEmpty { onLine(line, conn) }
                }
                conn.close()
            }
            t.name = "bridge-connection"
            t.start()
        }
    }
}
