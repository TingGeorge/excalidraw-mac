// Real mouse input for the macOS UI test:  swift mouse.swift click X Y | drag X1 Y1 X2 Y2
// | hover X1 Y1 X2 Y2 SECONDS | scroll X Y SECONDS   (screen points, top-left origin).
// hover moves back and forth between the two points without a button; scroll pans with
// two-finger (pixel) scrolls, both about 60 times a second like a trackpad.
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
case "hover" where n.count == 5:
    let a = CGPoint(x: n[0], y: n[1])
    let b = CGPoint(x: n[2], y: n[3])
    let end = Date().addingTimeInterval(n[4])
    var i = 0
    while Date() < end {
        let t = Double(i % 120) / 60
        let f = t <= 1 ? t : 2 - t
        CGEvent(
            mouseEventSource: nil, mouseType: .mouseMoved,
            mouseCursorPosition: CGPoint(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f), mouseButton: .left)?
            .post(tap: .cghidEventTap)
        usleep(16_000)
        i += 1
    }
case "scroll" where n.count == 3:
    post(.mouseMoved, CGPoint(x: n[0], y: n[1]))
    let end = Date().addingTimeInterval(n[2])
    var i = 0
    while Date() < end {
        let dy: Int32 = (i / 60) % 2 == 0 ? 6 : -6
        CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: 3, wheel3: 0)?
            .post(tap: .cghidEventTap)
        usleep(16_000)
        i += 1
    }
default:
    FileHandle.standardError.write(
        Data("usage: mouse.swift click X Y | drag X1 Y1 X2 Y2 | hover X1 Y1 X2 Y2 SECONDS | scroll X Y SECONDS\n".utf8))
    exit(2)
}
