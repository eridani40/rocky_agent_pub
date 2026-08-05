import AppKit
import ApplicationServices
import Foundation

// WindowRecovery —— 隐藏 / 最小化窗口恢复策略。
//
// 触发场景：Service 采 AX 树时发现 app 无 focused window（`snapshot.windows.isEmpty`）——
// 大概率窗口被最小化 / app 被 hide / 系统 Space 切走。按 open-codex 顺序四步尝试：
//   1. NSRunningApplication.unhide()（app 被 hide 时唤回）
//   2. NSRunningApplication.activate(options:[.activateAllWindows])（全窗口拉前台）
//   3. NSWorkspace.openApplication（app 已终止或 hide 深度锁；对齐 open-codex 的
//      `/usr/bin/open -b` 但**不 spawn 子进程**，改走系统 API + 短 timeout）
//   4. AXWindow：unminimize（若最小化）+ AXRaise + kAXMainAttribute + kAXFocusedAttribute
// 任一步骤 success → recovered=true；末尾 sleep 0.7s 等 UI 稳定。
//
// 参考: refs/open-codex-computer-use `AccessibilitySnapshot.swift:245-269`
//       specs/tech/version_logs/v0.0.160/change_plan.md 模块 B（B-9/B-10）
//
// 供 Service 各 action（本块 B4 仅落函数；调用点由块 3 添加）在 `snapshot.windows.isEmpty` 分支调用。

/// AX 找不到窗口时的通用 error message（对齐 open-codex `Errors.swift:3` 常量）。
/// throw 路径：Service 侧发现 recoverVisibleWindow=false 后 `throw .stateUnavailable(computerUseNoWindowFoundMessage)`。
let computerUseNoWindowFoundMessage = "Apple event error -10005: cgWindowNotFound"

/// 窗口恢复延迟：UI 状态生效 → AX 树能看到窗口的等待窗口。0.7s 是 open-codex 实测值。
private let windowVisibilityRecoveryDelay: TimeInterval = 0.7

enum WindowRecovery {
    /// 尝试恢复 pid 对应 app 的可见窗口。任一子步骤成功即返 true；末尾 sleep 0.7s。
    ///
    /// - Parameters:
    ///   - pid: 目标 app pid
    ///   - bundleId: bundleIdentifier（用于 NSWorkspace.openApplication 兜底）
    ///   - appElement: 目标 app 的 AXUIElement（`AXUIElementCreateApplication(pid)`）
    ///   - preferredWindow: 已知的目标窗口（若已从 focused window 拿到），nil 则走 firstAnyWindow 查找
    /// - Returns: 至少有一步成功 → true；全部失败 → false
    static func recoverVisibleWindow(
        pid: pid_t,
        bundleId: String?,
        appElement: AXUIElement,
        preferredWindow: AXUIElement? = nil
    ) -> Bool {
        var recovered = false

        // 1-2. NSRunningApplication.unhide + activate（app 被 hide / 后台时唤回）
        if let running = NSRunningApplication(processIdentifier: pid) {
            recovered = running.unhide() || recovered
            recovered = running.activate(options: [.activateAllWindows]) || recovered
        }

        // 3. NSWorkspace.openApplication（bundleId 已知时）——对齐 open-codex `openBundleIdentifier`
        //    但**不 spawn `/usr/bin/open`**，改走系统 openApplication API + 短 timeout（架构原则 5）
        if let bundleId {
            recovered = openBundleIdentifier(bundleId) || recovered
        }

        // 4. AXWindow：unminimize + raise + main/focused
        if let window = preferredWindow ?? firstAnyWindow(for: appElement) {
            recovered = unminimize(window) || recovered
            recovered = raise(window) || recovered
            recovered = setBoolAttribute(named: kAXMainAttribute as String, on: window) || recovered
            recovered = setBoolAttribute(named: kAXFocusedAttribute as String, on: window) || recovered
        }

        if recovered {
            Thread.sleep(forTimeInterval: windowVisibilityRecoveryDelay)
        }
        return recovered
    }

    // MARK: - private helpers

    /// 找 app 的第一个可用窗口：优先 kAXFocusedWindow；否则 windows[0] 中 role==AXWindow 的。
    private static func firstAnyWindow(for appElement: AXUIElement) -> AXUIElement? {
        // focused window
        if let v = AccessibilitySnapshot.copyAttr(appElement, kAXFocusedWindowAttribute as String),
           CFGetTypeID(v) == AXUIElementGetTypeID() {
            // swiftlint:disable:next force_cast
            return (v as! AXUIElement)
        }
        // windows[] 中 role==AXWindow
        if let v = AccessibilitySnapshot.copyAttr(appElement, kAXWindowsAttribute as String),
           let arr = v as? [AXUIElement] {
            return arr.first { AccessibilitySnapshot.stringAttr($0, kAXRoleAttribute) == (kAXWindowRole as String) }
        }
        return nil
    }

    /// 若窗口最小化（kAXMinimized=true），set 为 false 展开；否则不动。
    private static func unminimize(_ window: AXUIElement) -> Bool {
        guard boolValue(of: window, attribute: kAXMinimizedAttribute as String) == true else {
            return false
        }
        return AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success
    }

    /// AXRaise action：将窗口置为该 app 内最前。要求元素支持此 action。
    private static func raise(_ window: AXUIElement) -> Bool {
        let actions = AccessibilitySnapshot.rawActionsOf(window)
        guard actions.contains(where: { $0.caseInsensitiveCompare(kAXRaiseAction as String) == .orderedSame }) else {
            return false
        }
        return AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
    }

    /// set 一个 CFBoolean(true) 属性（`kAXMainAttribute` / `kAXFocusedAttribute` 等）。
    private static func setBoolAttribute(named attribute: String, on element: AXUIElement) -> Bool {
        AXUIElementSetAttributeValue(element, attribute as CFString, kCFBooleanTrue) == .success
    }

    /// 读取 element 的 Bool 属性值；非 Bool / 未提供返 nil。
    private static func boolValue(of element: AXUIElement, attribute: String) -> Bool? {
        guard let v = AccessibilitySnapshot.copyAttr(element, attribute) else { return nil }
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.boolValue }
        return nil
    }

    /// 通过 NSWorkspace 唤起 bundleId 对应 app。
    ///
    /// **不 spawn 子进程**（对齐 change_plan 架构原则 5）：改用 `NSWorkspace.openApplication(at:configuration:)`
    /// + DispatchSemaphore 短 timeout（0.5s），completion 回调集主线程 → 避免恢复路径阻塞 addon 太久。
    /// 找不到 app / timeout / 出错都返 false。
    private static func openBundleIdentifier(_ bundleId: String) -> Bool {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            return false
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        var success = false
        let sem = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, err in
            success = (err == nil)
            sem.signal()
        }
        // 短 timeout：恢复路径不容忍长阻塞（addon N-API 线程等 completion）
        _ = sem.wait(timeout: .now() + 0.5)
        return success
    }
}
