import ApplicationServices
import CoreGraphics
import Foundation

// ClickStrategy —— AX click 策略层（v0.0.159 抽离 + v0.0.160 扩展 5 层 fallback）。
// 编排顺序：① web row 优化 → ② preferred → ③ descendant → ④ hit-test → ⑤ activation-only。
// 分工：本文件=策略序列 / web row / AX action 执行；ClickHitTest.swift=几何/activation/list item；
//     ClickCoordinateHitTest.swift=hit-test + clickActionPoints + shouldScanDescendants。
// 参考: refs/open-codex-computer-use ComputerUseService.swift（各函数逐字对齐）
//       specs/tech/version_logs/v0.0.160/change_plan.md 模块 C

enum ClickStrategy {
    // MARK: - 常量（系统无 kAXOpenAction/kAXWebAreaRole 常量，走裸字符串）

    static let axOpenAction = "AXOpen"
    static let axWebAreaRole = "AXWebArea"

    // MARK: - Electron / web row 判定

    /// Electron 类 app 加速判定（bundle + appName 白名单，trim + lowercased 归一，均 nil → false）。参考 open-codex L307。
    static func isElectronScopedTarget(bundleId: String?, appName: String?) -> Bool {
        let normBundle = bundleId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normName = appName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let b = normBundle,
           b.hasPrefix("com.electron.")
            || b.contains(".electron.")
            || b.contains("lark")
            || b.contains("feishu")
        {
            return true
        }
        if let n = normName, n == "lark" || n == "feishu" || n == "飞书" {
            return true
        }
        return false
    }

    /// 是否倾向对 web row 祖先做 AXPress（双闸，参考 open-codex L327）：必要=hasAncestorRole(AXWebArea)；
    /// 命中后 → isElectronScopedTarget 或 role ∈ {StaticText/Group/Unknown}。role fallback 覆盖 WorkBuddy 类。
    static func shouldPreferContainingWebRowAXClick(
        record: ElementRecord,
        bundleId: String?,
        appName: String?
    ) -> Bool {
        // 必要条件：AXWebArea 祖先存在
        guard AccessibilitySnapshot.hasAncestorRole(axWebAreaRole, of: record.element) else {
            return false
        }
        // 加速通道：明确 Electron/Lark/Feishu 环境
        if isElectronScopedTarget(bundleId: bundleId, appName: appName) { return true }
        // Fallback：hasWebArea 命中但 bundle 判定未过（如 WorkBuddy），按 role 近似判定
        switch record.role {
        case "AXStaticText", "AXGroup", "AXUnknown":
            return true
        default:
            return false
        }
    }

    /// rawActions 是否含 primary click 语义动作（大小写不敏感）。
    /// 4 个 primary action：AXPress / AXConfirm / AXOpen / AXShowMenu（对齐 open-codex L1106）。
    static func hasPrimaryClickAction(rawActions: [String]) -> Bool {
        let primaries = [
            kAXPressAction as String,
            kAXConfirmAction as String,
            axOpenAction,
            kAXShowMenuAction as String,
        ]
        for action in rawActions {
            for p in primaries where action.caseInsensitiveCompare(p) == .orderedSame {
                return true
            }
        }
        return false
    }

    /// 候选 frame 是否「包含 target 的 web row 行动区」（对齐 open-codex L257）：hasPrimaryAction=true +
    /// candidate -2 inset 含 targetCenter + w/h ≥ target + h ≤ max(target.h+32, target.h*2)。
    static func isLikelyContainingRowActionFrame(
        targetFrame: CGRect,
        candidateFrame: CGRect?,
        hasPrimaryAction: Bool
    ) -> Bool {
        guard hasPrimaryAction, let candidateFrame else { return false }
        let targetCenter = CGPoint(x: targetFrame.midX, y: targetFrame.midY)
        guard candidateFrame.insetBy(dx: -2, dy: -2).contains(targetCenter) else { return false }
        guard candidateFrame.width >= targetFrame.width,
              candidateFrame.height >= targetFrame.height,
              candidateFrame.height <= max(targetFrame.height + 32, targetFrame.height * 2)
        else { return false }
        return true
    }

    // MARK: - AX action 执行

    /// 执行 named action（availableActions 白名单校验后 AXUIElementPerformAction）。对齐 open-codex L899。
    /// availableActions 不含 → false；success + repeatCount>1 非末次 sleep 50ms；
    /// attributeUnsupported + AXOpen → true（特例）；容忍失败集 → false；未知错误 → throw。
    static func performAction(
        named action: String,
        on element: AXUIElement,
        availableActions: [String],
        repeatCount: Int = 1
    ) throws -> Bool {
        // availableActions 白名单校验（case-insensitive）
        guard availableActions.contains(where: { $0.caseInsensitiveCompare(action) == .orderedSame }) else {
            return false
        }
        let attempts = max(repeatCount, 1)
        for index in 0..<attempts {
            let result = AXUIElementPerformAction(element, action as CFString)
            switch result {
            case .success:
                // 非末次 → 短 sleep 让 AX server / UI 消化（对齐 open-codex 50ms）
                if index < attempts - 1 {
                    Thread.sleep(forTimeInterval: 0.05)
                }
            case .attributeUnsupported where action.caseInsensitiveCompare(axOpenAction) == .orderedSame:
                // AXOpen 特例：部分实现返 attributeUnsupported 但语义已触发
                return true
            case .failure, .actionUnsupported, .attributeUnsupported, .cannotComplete,
                 .noValue, .invalidUIElement, .illegalArgument:
                return false
            default:
                throw ComputerUseError.message("AXUIElementPerformAction(\(action)) failed with \(result.rawValue)")
            }
        }
        return true
    }

    /// 6 层祖先 web row 遍历（对齐 open-codex L1148；深度硬编码 6）。命中 isLikelyContainingRowActionFrame 即对
    /// parent AXPress；未命中 → false。前置：仅左键单击调用（Service.click 侧校验）。
    static func performContainingWebRowClick(record: ElementRecord) throws -> Bool {
        guard let targetFrame = record.screenFrame else { return false }
        var current = record.element
        for _ in 0..<6 {
            guard let parent = AccessibilitySnapshot.copyParent(of: current) else { return false }
            let parentActions = AccessibilitySnapshot.rawActionsOf(parent)
            let parentFrame = AccessibilitySnapshot.frameOf(parent)
            let primary = hasPrimaryClickAction(rawActions: parentActions)
            if isLikelyContainingRowActionFrame(
                targetFrame: targetFrame,
                candidateFrame: parentFrame,
                hasPrimaryAction: primary
            ),
                try performAction(
                    named: kAXPressAction as String,
                    on: parent,
                    availableActions: parentActions,
                    repeatCount: 1
                )
            {
                debugLog("web row hit at ancestor role=\(AccessibilitySnapshot.stringAttr(parent, kAXRoleAttribute) ?? "?")")
                return true
            }
            current = parent
        }
        return false
    }

    /// Primary click 序列（左键 AXPress→AXConfirm→AXOpen；右键 AXShowMenu；middle 无）。参考 open-codex L707。
    /// clickCount 只对左键 AXPress 生效（AXConfirm/AXOpen/AXShowMenu 语义只做 1 次）。
    /// v0.0.160 gap#8：左键单击 + 非 AXWebArea → 前置试 selectContainingListItem（对齐 L714-720）。
    static func performPreferredClick(
        record: ElementRecord,
        button: MouseButtonKind,
        clickCount: Int
    ) throws -> Bool {
        let element = record.element
        switch button {
        case .left:
            // v0.0.160: 左键单击 + 非 web area → 优先试 list item 原生选中
            if clickCount <= 1,
               !AccessibilitySnapshot.hasAncestorRole(axWebAreaRole, of: element),
               try ClickHitTest.selectContainingListItem(for: element)
            {
                return true
            }
            if try performAction(named: kAXPressAction as String, on: element, availableActions: record.rawActions, repeatCount: clickCount) {
                return true
            }
            if try performAction(named: kAXConfirmAction as String, on: element, availableActions: record.rawActions, repeatCount: 1) {
                return true
            }
            if try performAction(named: axOpenAction, on: element, availableActions: record.rawActions, repeatCount: 1) {
                return true
            }
        case .right:
            if try performAction(named: kAXShowMenuAction as String, on: element, availableActions: record.rawActions, repeatCount: 1) {
                return true
            }
        case .middle:
            break
        }
        return false
    }

    /// 主编排入口（Service.click 调用）——5 层 fallback（对齐 open-codex L813-897）。
    /// 每层成功即 sleep 150ms return true；全失败 return false → Service.click 走 CGEvent 兜底。
    /// pid / allRecords 供 ④ hit-test 用（`AXUIElementCopyElementAtPosition` + `bestElement`）；
    /// coordinate 分支应传 `includeNearbyHitTesting=false, allowActivationFallback=false`（对齐 L482）。
    static func performAXClickSequence(
        record: ElementRecord,
        bundleId: String?,
        appName: String?,
        button: MouseButtonKind,
        clickCount: Int,
        includeNearbyHitTesting: Bool = true,
        allowActivationFallback: Bool = true,
        pid: pid_t = 0,
        allRecords: [Int: ElementRecord] = [:]
    ) throws -> Bool {
        let preferWebRow = shouldPreferContainingWebRowAXClick(
            record: record, bundleId: bundleId, appName: appName
        )
        debugLog("click decision preferWebRow=\(preferWebRow) role=\(record.role) button=\(button.rawValue) count=\(clickCount)")

        // ① web row 优化路径
        if preferWebRow, button == .left, clickCount <= 1,
           try performContainingWebRowClick(record: record)
        {
            Thread.sleep(forTimeInterval: 0.15)
            return true
        }

        // ②③④：非 web row 场景走 preferred → descendant → hit-test 序列
        if !preferWebRow {
            // ② preferred click 序列（含 list item 前置 + AXPress/AXConfirm/AXOpen）
            if try performPreferredClick(record: record, button: button, clickCount: clickCount) {
                debugLog("handled by preferred click")
                Thread.sleep(forTimeInterval: 0.15)
                return true
            }
            // ③ 3 层子树 descendant 候选（v0.0.160 gap#4）
            for candidate in ClickHitTest.descendantClickCandidates(for: record) {
                if try performPreferredClick(record: candidate, button: button, clickCount: clickCount) {
                    debugLog("handled by descendant candidate")
                    Thread.sleep(forTimeInterval: 0.15)
                    return true
                }
            }
            // ④ hit-test 候选（v0.0.160 gap#5，对齐 open-codex L846-877）：
            // 对 record 的 clickActionPoints 每点，先 AX 拾取 or bestElement 拿候选 record →
            // 过 synthetic-side filter → preferred click；命中 hit-frame 显著大于原 frame 时
            // 还要扫其 descendant 子树（sideActionScope=原 record，避免误把 side action 视为合成侧按钮）。
            if includeNearbyHitTesting, pid > 0 {
                for point in ClickCoordinateHitTest.clickActionPoints(for: record) {
                    let hitRecord = ClickCoordinateHitTest.hitTestElement(at: point, pid: pid)
                        ?? ClickCoordinateHitTest.bestElement(containing: point, in: allRecords)
                    guard let hit = hitRecord else { continue }
                    if !ClickHitTest.isLikelySyntheticSideAction(hit, in: record),
                       try performPreferredClick(record: hit, button: button, clickCount: clickCount)
                    {
                        debugLog("handled by hit-test candidate")
                        Thread.sleep(forTimeInterval: 0.15)
                        return true
                    }
                    if ClickCoordinateHitTest.shouldScanDescendantsOfHitRecord(
                        originalFrame: record.screenFrame, hitFrame: hit.screenFrame
                    ) {
                        for cand in ClickHitTest.descendantClickCandidates(for: hit, sideActionScope: record) {
                            if try performPreferredClick(record: cand, button: button, clickCount: clickCount) {
                                debugLog("handled by hit-test descendant")
                                Thread.sleep(forTimeInterval: 0.15)
                                return true
                            }
                        }
                    }
                }
            }
        }

        // ⑤ activation-only fallback（v0.0.160 gap#2）：仅 AXWindow role + 左键 + 非合成节点
        guard allowActivationFallback,
              !record.isSyntheticText,
              button == .left,
              ClickHitTest.canUseActivationOnlyClickFallback(role: record.role)
        else {
            return false
        }
        if try ClickHitTest.activateClickTarget(
            element: record.element, availableActions: record.rawActions
        ) {
            debugLog("handled by activation fallback")
            Thread.sleep(forTimeInterval: 0.15)
            return true
        }
        return false
    }

    // MARK: - debug

    /// 仅 `RC_COMPUTER_DEBUG=1` 时输出到 stderr（生产默认关；dev dogfood 排查用）。
    static func debugLog(_ message: String) {
        guard ProcessInfo.processInfo.environment["RC_COMPUTER_DEBUG"] == "1" else { return }
        if let data = "[click] \(message)\n".data(using: .utf8) {
            FileHandle.standardError.write(data)
        }
    }
}
