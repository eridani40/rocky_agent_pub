import AppKit
import ApplicationServices
import Foundation

// AX tree 采集 —— AXUIElement 遍历 + element_index 顺序整数 + 文本渲染（喂 LLM）。
// budget 1200 节点 / 64 层 / 500 字符 textLimit（防 token 爆炸）。复用 iFurySt AccessibilitySnapshot 结构。
// element_index 是 get_app_state 输出的顺序整数（非稳定 ID，同 turn 有效）。

/// AX 树采集时 text 段的截断策略。
///
/// - `.defaults`（maxCount=500）：默认长度上限
/// - `.max`（maxCount=nil）：不截断（对齐 open-codex `SnapshotTextLimit.max`）
///
/// 支持从 TS 侧参数解析（`"max"` 字符串 / 正整数字符串 / 缺省），
/// 消费方按 `maxCount ?? Int.max` 作截断阈值。
///
/// 参考: refs/open-codex-computer-use `AccessibilitySnapshot.swift:67-82`。
struct SnapshotTextLimit: Equatable {
    /// TS 侧协议 sentinel 关键字（保持与 open-codex 一致）。
    static let maxKeyword = "max"

    /// 默认上限 500 字符（与 v0.0.105 前既有行为对齐）。
    static let defaults = SnapshotTextLimit(maxCount: 500)

    /// 无上限 sentinel（渲染完整文本，喂 vision LLM 或全文摘要场景）。
    static let max = SnapshotTextLimit(maxCount: nil)

    /// 截断上限；nil = 不截断。消费方按 `maxCount ?? Int.max` 使用。
    let maxCount: Int?

    /// 公开 init：正整数上限（precondition 校验 >0，防呆）。
    init(maxCount: Int = 500) {
        precondition(maxCount > 0, "text limit must be positive")
        self.maxCount = maxCount
    }

    /// 私有 init：仅内部构造 `.max`（nil sentinel）。
    private init(maxCount: Int?) {
        self.maxCount = maxCount
    }

    /// 从字符串解析（TS bridge 用）：`"max"` → `.max`；正整数字符串 → `SnapshotTextLimit(maxCount:)`；
    /// 其余（空 / 负 / 非数字） → `.defaults`（防呆）。
    static func parse(_ input: String) -> SnapshotTextLimit {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.caseInsensitiveCompare(maxKeyword) == .orderedSame { return .max }
        if let n = Int(trimmed), n > 0 { return SnapshotTextLimit(maxCount: n) }
        return .defaults
    }
}

/// 单个 AX 元素记录（element_index → 元素 + 屏幕 frame，供 click/setValue/performSecondaryAction 复用）
struct ElementRecord {
    let index: Int
    let element: AXUIElement
    let role: String
    let title: String?
    let value: String?
    let screenFrame: CGRect?  // 屏幕坐标 y-down（click hit-test 用）
    let actions: [String]     // secondary action 名（AXUIElementCopyActionNames，已滤 AXPress primary）
    /// 全量 action 名列表（未过滤 AXPress）——供 ClickStrategy 判定 primary click / AX action 多步序列。
    /// 与 actions 一次 API 采集两用，避免重复调 AXUIElementCopyActionNames（AccessibilitySnapshot.walk 填充）。
    let rawActions: [String]
    /// AXIdentifier 属性（`kAXIdentifierAttribute`）——存 raw 值不做展示归一。
    /// walk 采集时读；未提供则 nil。参考 open-codex `AccessibilitySnapshot:9`。
    let identifier: String?
    /// 是否 renderer 合成的短文本节点（对齐 open-codex `renderSyntheticText`）。
    /// 本块（walk 主路径）恒为 false；TreeRenderer 重写（块 5）合成节点时才置 true。
    let isSyntheticText: Bool
    /// rawActions 的人类可读别名（如 AXPress→Press / AXShowMenu→Show Menu）——供 Service.performSecondaryAction
    /// 两级 match（rawActions exact + prettyActions position）。参考 open-codex `prettyActionName`。
    /// walk 采集时按简单规则计算（去 `AX` 前缀 + 拆 CamelCase）；F 模块 `meaningfulActions` 就绪后可替换更完整实现。
    let prettyActions: [String]

    /// 显式 init。三新字段（identifier/isSyntheticText/prettyActions）带默认值，
    /// 便于 ClickStrategy / TreeRenderer 构造合成 record（不必显式传全）。
    init(
        index: Int,
        element: AXUIElement,
        role: String,
        title: String?,
        value: String?,
        screenFrame: CGRect?,
        actions: [String],
        rawActions: [String],
        identifier: String? = nil,
        isSyntheticText: Bool = false,
        prettyActions: [String] = []
    ) {
        self.index = index
        self.element = element
        self.role = role
        self.title = title
        self.value = value
        self.screenFrame = screenFrame
        self.actions = actions
        self.rawActions = rawActions
        self.identifier = identifier
        self.isSyntheticText = isSyntheticText
        self.prettyActions = prettyActions
    }
}

/// AX 快照来源模式（对齐 open-codex `SnapshotMode`）。
///
/// - `.accessibility`：真实 AXUIElement 树（生产路径）
/// - `.fixture`：由 fixture app 通过 `FixtureBridge.writeState` 写入 state.json 的模拟树
///   （XCTest 用；v0.0.160 只落 mode 字段，Service 分支占位 TODO，实际 fixture app 待未来版本）
///
/// 参考: refs/open-codex-computer-use `AccessibilitySnapshot.swift`（SnapshotMode + AppSnapshot.mode 字段）
///       specs/tech/version_logs/v0.0.160/change_plan.md 模块 I（I-3）
enum SnapshotMode {
    case accessibility
    case fixture
}

/// AX tree 采集结果
struct AxSnapshot {
    let text: String
    /// element_index → ElementRecord 索引 map（对齐 open-codex `AppSnapshot.elements`）。
    /// v0.0.160 由 `[ElementRecord]` 改 `[Int: ElementRecord]`：Service.click 按 index O(1) 查缓存，
    /// 消费方 `values.sorted { $0.index < $1.index }` 输出稳定顺序。
    let records: [Int: ElementRecord]
    /// 快照来源（默认 `.accessibility` 保 v0.0.159 语义等价；fixture app 就绪后走 `.fixture`）
    let mode: SnapshotMode
}

enum AccessibilitySnapshot {
    /// 遍历 pid 对应 app 的 AX tree，产出渲染文本 + element 记录表。
    ///
    /// v0.0.160 换用 `TreeRenderer`（open-codex 精细化渲染）替代 v0.0.105 的裸 walk——
    /// 段化 traits/label/help/url/identifier/value/placeholder/Secondary Actions +
    /// Electron generic wrapper 折叠 + AXLink markdown 化 + list/outline 部分展示提示 +
    /// synthetic text 合成节点。text_limit 由 Service 侧 Int 包装为 `SnapshotTextLimit`
    /// 保后向兼容（TS `"max"` 支持走 SnapshotTextLimit.parse 由收尾块打通）。
    ///
    /// LLM 视角变化 risk：render 一变则 LLM 观测彻底洗一遍——UT 不覆盖真实 AX；须在 dev
    /// dogfood 6+ 场景（Safari / Finder / Xcode / VSCode / Lark / WorkBuddy）人工验 `get_app_state` 无退化。
    static func build(pid: pid_t, bundleId: String?, textLimit: Int, maxNodes: Int, maxDepth: Int) throws -> AxSnapshot {
        guard Permissions.snapshot().accessibility else {
            throw ComputerUseError.permissionMissing(which: "accessibility")
        }
        let app = AXUIElementCreateApplication(pid)

        // v0.0.160 gap#6 (B-10): focused window 缺失时尝试恢复（unhide / activate /
        // openBundleIdentifier / AXWindow raise+focus），成功后重查一次 focused；仍缺失则
        // throw `.stateUnavailable`——引导 LLM 重新 get_app_state 或换 app，避免后续渲染空跑。
        // 参考 open-codex `AccessibilitySnapshot.swift:160-168`（`SnapshotBuilder.build` 内窗口失联分支）。
        var focusedWindow = copyAttr(app, kAXFocusedWindowAttribute as String)
        if focusedWindow == nil {
            _ = WindowRecovery.recoverVisibleWindow(pid: pid, bundleId: bundleId, appElement: app)
            focusedWindow = copyAttr(app, kAXFocusedWindowAttribute as String)
        }
        if focusedWindow == nil {
            throw ComputerUseError.stateUnavailable(computerUseNoWindowFoundMessage)
        }

        let ctx = RenderContext(
            windowBounds: nil,  // rocky 未在此层采窗口 bounds（Screenshot 有，Service 层未来可注入）
            focusedElement: nil,  // rocky 未在此层识别 focused（未来可注入，先兜 nil）
            textLimit: SnapshotTextLimit(maxCount: max(textLimit, 1)),
            treeLimits: AccessibilityTreeLimits(maxNodeCount: maxNodes, maxDepth: maxDepth)
        )
        var renderer = TreeRenderer(context: ctx)
        renderer.render(app)
        // 顶部拼 App header（保 v0.0.105 契约：第一行始终 "App=xxx (pid X)"）
        var lines = ["App=\(bundleId ?? "unknown") (pid \(pid))"]
        lines.append(contentsOf: renderer.lines)
        return AxSnapshot(text: lines.joined(separator: "\n"), records: renderer.records, mode: .accessibility)
    }

    // MARK: - AX 属性读取 helper

    static func copyAttr(_ element: AXUIElement, _ attr: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
        return value
    }

    static func stringAttr(_ element: AXUIElement, _ attr: String) -> String? {
        guard let v = copyAttr(element, attr) else { return nil }
        if let s = v as? String { return s }
        if CFGetTypeID(v) == AXValueGetTypeID() { return nil }
        return (v as? NSNumber)?.stringValue
    }

    static func childrenOf(_ element: AXUIElement) -> [AXUIElement] {
        guard let v = copyAttr(element, kAXChildrenAttribute) else { return [] }
        return (v as? [AXUIElement]) ?? []
    }

    /// 元素全量 action 名列表（AXUIElementCopyActionNames，不过滤）。
    /// 供 ClickStrategy 判 primary click（AXPress/AXConfirm/AXOpen/AXShowMenu）+ walk 派生 secondary。
    /// 采集失败返 `[]`（简化调用侧，不用 optional）。
    static func rawActionsOf(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success,
              let arr = names as? [String] else { return [] }
        return arr
    }

    /// 单步上溯 parent（`kAXParentAttribute`）。失败/无 parent 返 nil。供 ClickStrategy 祖先遍历用。
    static func copyParent(of element: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value) == .success,
              let v = value else { return nil }
        // AX API 语义 parent 必是 AXUIElement，force-cast 与 open-codex 一致
        // swiftlint:disable:next force_cast
        return (v as! AXUIElement)
    }

    /// 循环 copyParent 至 maxDepth，任一祖先 role 匹配返 true；到根/失败/超深度返 false。
    /// maxDepth 默认 12（对齐 open-codex `hasAncestorRole` L1191）。
    static func hasAncestorRole(_ role: String, of element: AXUIElement, maxDepth: Int = 12) -> Bool {
        var current = element
        for _ in 0..<max(maxDepth, 0) {
            guard let parent = copyParent(of: current) else { return false }
            if stringAttr(parent, kAXRoleAttribute) == role { return true }
            current = parent
        }
        return false
    }

    /// 元素屏幕 frame（AXPosition + AXSize，y-down 屏幕坐标）
    static func frameOf(_ element: AXUIElement) -> CGRect? {
        guard let posV = copyAttr(element, kAXPositionAttribute), let sizeV = copyAttr(element, kAXSizeAttribute) else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard CFGetTypeID(posV) == AXValueGetTypeID(), CFGetTypeID(sizeV) == AXValueGetTypeID() else { return nil }
        // swiftlint:disable:next force_cast
        AXValueGetValue(posV as! AXValue, .cgPoint, &point)
        // swiftlint:disable:next force_cast
        AXValueGetValue(sizeV as! AXValue, .cgSize, &size)
        return CGRect(origin: point, size: size)
    }

    private static func truncate(_ s: String?, limit: Int) -> String? {
        guard let s, s.count > limit else { return s }
        return String(s.prefix(limit)) + "…"
    }

    // MARK: - action 别名（open-codex `prettyActionName` 对齐）

    /// AX action → 人类可读别名。规则：
    /// - `AXZoomWindow` → `"zoom the window"`（特例）
    /// - 其他：去 `AX` 前缀 → 去 `ByPage` 后缀 → 按 CamelCase 拆空格
    ///
    /// 例：`AXPress` → `"Press"`；`AXShowMenu` → `"Show Menu"`；`AXScrollDownByPage` → `"Scroll Down"`。
    ///
    /// 参考: refs/open-codex-computer-use `AccessibilitySnapshot.swift:1710-1718`。
    static func prettyActionName(_ value: String) -> String {
        if value == "AXZoomWindow" { return "zoom the window" }
        let stripped = value.hasPrefix("AX") ? String(value.dropFirst(2)) : value
        let withoutPage = stripped.replacingOccurrences(of: "ByPage", with: "")
        return splitCamelCase(withoutPage)
    }

    /// CamelCase → 空格分隔（`ShowMenu` → `"Show Menu"`）。前置字符大写不加前导空格。
    private static func splitCamelCase(_ value: String) -> String {
        var result = ""
        for character in value {
            if character.isUppercase, !result.isEmpty { result.append(" ") }
            result.append(character)
        }
        return result
    }
}

// v0.0.160：`Applications` enum（list_apps 入口）已从此文件迁至 `AppDiscovery.swift`——
// 与 AppDiscovery/SpotlightAppIndex 同文件更合概念聚合（都是 app 列表能力），
// 且保 AccessibilitySnapshot.swift ≤ 300 行硬约束。此处仅留 TODO 指路。
