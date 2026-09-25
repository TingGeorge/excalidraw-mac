// Real mouse input for the macOS UI test:  swift mouse.swift click X Y | drag X1 Y1 X2 Y2
// (screen points, top-left origin).
import CoreGraphics
import Foundation

func post(_ type: CGEventType, _ point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    usleep(40_000)
}

let args = CommandLine.arguments.dropFirst().map { $0 }
let n = args.dropFirst().compactMap(Double.init)
switch args.first {
case "click" where n.count == 2:
    let p = CGPoint(x: n[0], y: n[1])
    post(.mouseMoved, p)
    post(.leftMouseDown, p)
    post(.leftMouseUp, p)
case "drag" where n.count == 4:
    let a = CGPoint(x: n[0], y: n[1])
    let b = CGPoint(x: n[2], y: n[3])
    post(.mouseMoved, a)
    post(.leftMouseDown, a)
    for i in 1...12 {
        let t = Double(i) / 12
        post(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
    }
    post(.leftMouseUp, b)
default:
    FileHandle.standardError.write(Data("usage: mouse.swift click X Y | drag X1 Y1 X2 Y2\n".utf8))
    exit(2)
}
