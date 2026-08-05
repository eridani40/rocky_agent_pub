import AppKit
import CoreGraphics
import Foundation

// CGEvent.postToPid 后台键鼠 —— iFurySt open-codex 最核心创新，从旧 swift-helper 逐字迁入 addon 包：
//   - 定向投递到目标 pid，不抢前台、不移动用户真实硬件光标、不需 Input Monitoring 权限（仅 Accessibility）
//   - coordinate 已由 TS 侧换算为屏幕全局 point（y-down），此处直接投递
// 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.3 Spike 3 + P1-B
//
// Spike 3 目标：验证 CGEvent postToPid 点击序列在 addon 的 AsyncWorker 线程跑通（不崩、结构对）。
// clickTargeted 为 Spike 3 主验路径；scroll/drag/type/pressKey 已迁入（同桥同范式），
// 其 Service 分发 / CBridge case 待 spike 通过后全量接（本 spike 只接 click）。

enum MouseButtonKind: String {
    case left, right, middle
    var downEvent: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }
    var upEvent: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }
    var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }
}

enum InputSimulation {
    static let maxKeyboardUnicodeChunkLength = 64

    static func clickTargeted(at point: CGPoint, button: MouseButtonKind, clickCount: Int, pid: pid_t) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.message("Failed to create targeted event source.")
        }
        for _ in 0..<max(clickCount, 1) {
            try postMouse(.mouseMoved, source, point, button.cgButton, clickCount, pid)
            try postMouse(button.downEvent, source, point, button.cgButton, clickCount, pid)
            try postMouse(button.upEvent, source, point, button.cgButton, clickCount, pid)
        }
    }

    static func scrollTargeted(at point: CGPoint, direction: String, pages: Double, pid: pid_t) throws {
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
            wheel1: wheel1(direction, pages), wheel2: wheel2(direction, pages), wheel3: 0
        ) else {
            throw ComputerUseError.message("Failed to create scroll event.")
        }
        event.location = point
        event.postToPid(pid)
        Thread.sleep(forTimeInterval: 0.1)
    }

    static func dragTargeted(from start: CGPoint, to end: CGPoint, steps: Int, pid: pid_t) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.message("Failed to create targeted event source.")
        }
        try postMouse(.mouseMoved, source, start, .left, 1, pid)
        try postMouse(.leftMouseDown, source, start, .left, 1, pid)
        let n = max(steps, 1)
        for step in 1...n {
            let p = Double(step) / Double(n)
            let point = CGPoint(x: start.x + (end.x - start.x) * p, y: start.y + (end.y - start.y) * p)
            try postMouse(.leftMouseDragged, source, point, .left, 1, pid)
        }
        try postMouse(.leftMouseUp, source, end, .left, 1, pid)
    }

    static func typeText(_ text: String, chunkSize: Int, delayMs: Int, pid: pid_t) throws {
        for chunk in keyboardUnicodeChunks(for: text, maxUTF16Units: max(chunkSize, 1)) {
            var mutableChunk = chunk
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            else { throw ComputerUseError.message("Failed to create keyboard event.") }
            mutableChunk.withUnsafeMutableBufferPointer { buffer in
                guard let base = buffer.baseAddress else { return }
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            }
            down.postToPid(pid)
            up.postToPid(pid)
            Thread.sleep(forTimeInterval: Double(max(delayMs, 0)) / 1000.0)
        }
    }

    /// 按 Unicode extended grapheme cluster 聚合，每 chunk ≤ maxUTF16Units UTF-16 units。
    /// 避免中文标点/emoji/代理对被逐 UTF-16 code unit 拆开（iFurySt keyboardUnicodeChunks）。
    static func keyboardUnicodeChunks(for text: String, maxUTF16Units: Int) -> [[UniChar]] {
        var chunks: [[UniChar]] = []
        var current: [UniChar] = []
        for character in text {
            let units = Array(String(character).utf16)
            if !current.isEmpty, current.count + units.count > maxUTF16Units {
                chunks.append(current)
                current.removeAll(keepingCapacity: true)
            }
            current.append(contentsOf: units)
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    static func pressKey(_ specification: String, pid: pid_t) throws {
        let parsed = try KeyPressParser.parse(specification)
        var activeFlags: CGEventFlags = []
        for modifier in parsed.modifiers {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: modifier.keyCode, keyDown: true) else {
                throw ComputerUseError.message("Failed to create modifier key down event.")
            }
            activeFlags.insert(modifier.flag)
            event.flags = activeFlags
            event.postToPid(pid)
        }
        guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: parsed.keyCode, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: parsed.keyCode, keyDown: false)
        else { throw ComputerUseError.message("Failed to create key event.") }
        keyDown.flags = activeFlags
        keyUp.flags = activeFlags
        keyDown.postToPid(pid)
        keyUp.postToPid(pid)
        for modifier in parsed.modifiers.reversed() {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: modifier.keyCode, keyDown: false) else {
                throw ComputerUseError.message("Failed to create modifier key up event.")
            }
            event.flags = activeFlags
            event.postToPid(pid)
            activeFlags.remove(modifier.flag)
        }
        Thread.sleep(forTimeInterval: 0.1)
    }

    private static func postMouse(
        _ type: CGEventType, _ source: CGEventSource, _ point: CGPoint,
        _ button: CGMouseButton, _ clickState: Int, _ pid: pid_t
    ) throws {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw ComputerUseError.message("Failed to create mouse event \(type.rawValue).")
        }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        event.postToPid(pid)
        Thread.sleep(forTimeInterval: 0.03)
    }

    private static func wheel1(_ direction: String, _ pages: Double) -> Int32 {
        switch direction {
        case "up": return scrollDelta(pages)
        case "down": return -scrollDelta(pages)
        default: return 0
        }
    }

    private static func wheel2(_ direction: String, _ pages: Double) -> Int32 {
        switch direction {
        case "left": return scrollDelta(pages)
        case "right": return -scrollDelta(pages)
        default: return 0
        }
    }

    private static func scrollDelta(_ pages: Double) -> Int32 {
        let raw = (12.0 * pages).rounded(.toNearestOrAwayFromZero)
        return Int32(min(Double(Int32.max), max(1, raw)))
    }
}
