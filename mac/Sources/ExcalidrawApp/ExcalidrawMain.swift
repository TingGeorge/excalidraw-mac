#if os(macOS)
import AppKit

@main
@MainActor
struct ExcalidrawMain {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
#else
@main
struct ExcalidrawMain {
    static func main() {
        print("The Excalidraw app runs on macOS only.")
    }
}
#endif
