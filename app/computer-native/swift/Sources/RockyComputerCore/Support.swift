import Foundation

// Support —— computer use 统一错误类型（从 swift-helper/Support.swift 迁入；stdin-IPC 的
// writeJSONLine/respondOK/respondError 属已删的 main.swift spawn 循环，由 CBridge.swift 的
// JSON dispatch 承接，故不迁）。
// 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.4 P1-B
//
// code 与 TS 侧 ComputerErrorCode 对齐（permission_missing 额外带 which）。

enum ComputerUseError: Error {
    case message(String)
    case invalidArguments(String)
    case permissionMissing(which: String)  // "accessibility" | "screen_recording"
    case appNotFound(String)
    case elementNotFound(Int)
    case notSettable
    /// 运行时状态错误（对齐 open-codex `stateUnavailable`：元素还在但无坐标 / 元素消失 /
    /// 无 backing AX object / 窗口找不到等运行时状态问题，与 .message 通用错误区分）。
    /// 参考: refs/open-codex-computer-use `Errors.swift:11`；TS 侧 code = `"state_unavailable"`
    case stateUnavailable(String)

    /// error.code（TS 侧据此分类）
    var code: String {
        switch self {
        case .message: return "helper_error"
        case .invalidArguments: return "invalid_arguments"
        case .permissionMissing: return "permission_missing"
        case .appNotFound: return "app_not_found"
        case .elementNotFound: return "ax_element_not_found"
        case .notSettable: return "not_settable"
        case .stateUnavailable: return "state_unavailable"
        }
    }

    var text: String {
        switch self {
        case let .message(m): return m
        case let .invalidArguments(m): return "invalid arguments: \(m)"
        case let .permissionMissing(which): return "\(which) permission not granted"
        case let .appNotFound(app): return "app not found: \(app)"
        case let .elementNotFound(i): return "ax element not found: index \(i)"
        case .notSettable: return "element value is not settable"
        // 直接透传 message（对齐 open-codex `errorDescription` .stateUnavailable → message）
        case let .stateUnavailable(m): return m
        }
    }

    var which: String? {
        if case let .permissionMissing(which) = self { return which }
        return nil
    }
}
