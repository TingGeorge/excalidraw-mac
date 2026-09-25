// Prints the accessibility tree of the front window of a running app, one element per line:
// "<depth-indent>role | description | title | value". Used in CI to check what VoiceOver sees.
//   swift test/ax-tree.swift Excalidraw
import AppKit
import ApplicationServices

let name = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Excalidraw"
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == name }) else {
    FileHandle.standardError.write(Data("\(name) is not running\n".utf8))
    exit(1)
}
let root = AXUIElementCreateApplication(app.processIdentifier)

func attribute(_ element: AXUIElement, _ key: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}

func text(_ element: AXUIElement, _ key: String) -> String {
    (attribute(element, key) as? String) ?? ""
}

func dump(_ element: AXUIElement, depth: Int) {
    guard depth < 30 else { return }
    let fields = [kAXRoleAttribute, kAXDescriptionAttribute, kAXTitleAttribute, kAXValueAttribute].map {
        text(element, $0 as String)
    }
    print(String(repeating: "  ", count: depth) + fields.joined(separator: " | "))
    for child in (attribute(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] {
        dump(child, depth: depth + 1)
    }
}

let windows = (attribute(root, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
guard let window = windows.first else {
    FileHandle.standardError.write(Data("no window\n".utf8))
    exit(1)
}
dump(window, depth: 0)
