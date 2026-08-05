import ApplicationServices
import CoreGraphics
import Foundation

// ClickHitTest —— AX click 几何 / 描述性辅助层，从 ClickStrategy.swift 拆出（v0.0.160）。
//
// 职责：为 ClickStrategy 主编排 (`performAXClickSequence`) 提供不依赖 CGEvent 的纯函数
// 与 AX helper，支撑「preferred → descendant → hit-test → activation-only」多层 fallback：
//   - descendantClickCandidates：3 层子树扫描，找出 primary-action 候选元素
//   - clickPriority / frameArea：候选排序（priority 越小越优先，同 priority 面积小者优先）
//   - accessibilityLabels：读元素 title/description/help/value/AXIdentifier
//   - isLikelySyntheticSideAction*：识别「trailing 小完成按钮」这类合成侧按钮
//   - canUseActivationOnlyClickFallback：判定 role == AXWindow（activation 只有 window 支持）
//   - selectContainingListItem：向上 8 层找 AXList 用 kAXSelectedChildren 语义选中
//   - setBoolAttribute / activateClickTarget：activation-only fallback 的 AX 属性写入
//   - isAttributeSettable：AXUIElementIsAttributeSettable 包装
//
// 与 ClickStrategy 的分工：ClickStrategy 承载策略序列（web row / preferred / AXPress 序列），
// ClickHitTest 承载支撑其上下文的 helper。跨命名空间调用 `ClickStrategy.performAction` /
// `ClickStrategy.hasPrimaryClickAction` 避免循环依赖（都是静态方法，无实例状态）。
//
// 参考: refs/open-codex-computer-use ComputerUseService.swift
//   - descendantClickCandidates L1048-1095 / clickPriority L1005 / frameArea L1024
//   - accessibilityLabels L1206 / isLikelySyntheticSideActionCandidate L191-235 / L1097
//   - canUseActivationOnlyClickFallback L277-283 / activateClickTarget L924-940
//   - setBoolAttribute L942-952 / selectContainingListItem L769-811 / selectableListItem L791
//
// 参考文档：specs/tech/version_logs/v0.0.160/change_plan.md 模块 C
//         specs/tech/agent/platform/[P1]computer_native_capability.md §5-§6

enum ClickHitTest {
    // MARK: - descendant 候选扫描（C-1 / C-2）

    /// 3 层子树递归扫描（depth < 3 硬约束，对齐 open-codex L1073）：
    /// 每个子元素读 rawActions + role + title/value + screenFrame 构造 `ElementRecord`
    /// （index=-1 表示无 tree cache 位置，identifier=nil / isSyntheticText=false / prettyActions=rawActions）。
    /// 返回全部候选（不 filter primaryAction 与 synthetic-side，交由 wrapper 上层做）。
    static func descendantClickCandidates(of element: AXUIElement, depth: Int = 0) -> [ElementRecord] {
        guard depth < 3 else { return [] }
        var results: [ElementRecord] = []
        for child in AccessibilitySnapshot.childrenOf(element) {
            let rawActions = AccessibilitySnapshot.rawActionsOf(child)
            let role = AccessibilitySnapshot.stringAttr(child, kAXRoleAttribute) ?? "AXUnknown"
            let title = AccessibilitySnapshot.stringAttr(child, kAXTitleAttribute)
            let value = AccessibilitySnapshot.stringAttr(child, kAXValueAttribute)
            let frame = AccessibilitySnapshot.frameOf(child)
            // secondary actions = rawActions 去 AXPress（保 walk 派生规则一致）
            let actions = rawActions.filter { $0 != (kAXPressAction as String) }
            results.append(
                ElementRecord(
                    index: -1, element: child, role: role, title: title,
                    value: value, screenFrame: frame,
                    actions: actions, rawActions: rawActions,
                    identifier: nil, isSyntheticText: false, prettyActions: rawActions
                )
            )
            results.append(contentsOf: descendantClickCandidates(of: child, depth: depth + 1))
        }
        return results
    }

    /// 上层 wrapper：调 depth=0 版本 + `isLikelySyntheticSideAction` filter（scope 默认 record 自身）
    /// + `clickPriority` 升序 / 同优先级按 `frameArea` 升序排序。对齐 open-codex L1048-1071。
    ///
    /// **偏离 change_plan 说明**：change_plan 原写 `for:snapshot:sideActionScope:`（依赖 AppSnapshot.windowBounds
    /// 计算 localFrame）。Rocky ElementRecord 使用 screenFrame（y-down 全屏坐标），几何判定坐标系无关，
    /// 故 snapshot 参数不需要，简化签名为 `(for:sideActionScope:)`。coder 决策。
    static func descendantClickCandidates(
        for record: ElementRecord,
        sideActionScope: ElementRecord? = nil
    ) -> [ElementRecord] {
        let parent = sideActionScope ?? record
        return descendantClickCandidates(of: record.element)
            .filter { !isLikelySyntheticSideAction($0, in: parent) }
            .sorted { lhs, rhs in
                let lp = clickPriority(for: lhs)
                let rp = clickPriority(for: rhs)
                if lp != rp { return lp < rp }
                return frameArea(of: lhs) < frameArea(of: rhs)
            }
    }

    // MARK: - 优先级 / 面积（候选排序，C-3 / C-4）

    /// 候选点击优先级（越小越优先），对齐 open-codex L1005-1022：
    /// - 0：rawActions 含 AXPress / AXConfirm / AXShowMenu / AXRaise 之一（case-insensitive）
    /// - 1：element 可 set kAXMainAttribute 或 kAXFocusedAttribute（可 activation）
    /// - 2：其余
    ///
    /// **注意**：priority-0 集与 `ClickStrategy.hasPrimaryClickAction`（AXPress/AXConfirm/AXOpen/AXShowMenu）
    /// **不同** — 前者含 AXRaise 不含 AXOpen。逐字对齐 open-codex 两处不同集合定义。
    static func clickPriority(for record: ElementRecord) -> Int {
        let primaries = [
            kAXPressAction as String,
            kAXConfirmAction as String,
            kAXShowMenuAction as String,
            kAXRaiseAction as String,
        ]
        if record.rawActions.contains(where: { action in
            primaries.contains { p in action.caseInsensitiveCompare(p) == .orderedSame }
        }) {
            return 0
        }
        if isAttributeSettable(record.element, attribute: kAXMainAttribute as String)
            || isAttributeSettable(record.element, attribute: kAXFocusedAttribute as String)
        {
            return 1
        }
        return 2
    }

    /// 元素 screenFrame 面积（w*h）；nil frame 返 `.greatestFiniteMagnitude`（排最后）。
    static func frameArea(of record: ElementRecord) -> CGFloat {
        guard let frame = record.screenFrame else { return .greatestFiniteMagnitude }
        return frame.width * frame.height
    }

    // MARK: - 标签读取 + 合成侧按钮判定（C-5 / C-6）

    /// 依次读元素 title / description / help / value / AXIdentifier 五属性，返回非 nil 列表。
    /// 对齐 open-codex `accessibilityLabels` L1206-1220。element nil 直接返 []。
    static func accessibilityLabels(for element: AXUIElement?) -> [String] {
        guard let element else { return [] }
        return [
            kAXTitleAttribute as String,
            kAXDescriptionAttribute as String,
            kAXHelpAttribute as String,
            kAXValueAttribute as String,
            "AXIdentifier",
        ].compactMap { attr in
            AccessibilitySnapshot.stringAttr(element, attr)
        }
    }

    /// wrapper：从 candidate + parent 提取 frame / label / primaryAction 后调纯函数判定。
    /// primaryAction 直接复用 `ClickStrategy.hasPrimaryClickAction`。
    static func isLikelySyntheticSideAction(_ candidate: ElementRecord, in parent: ElementRecord) -> Bool {
        isLikelySyntheticSideActionCandidate(
            parentFrame: parent.screenFrame,
            candidateFrame: candidate.screenFrame,
            hasPrimaryAction: ClickStrategy.hasPrimaryClickAction(rawActions: candidate.rawActions),
            labels: accessibilityLabels(for: candidate.element)
        )
    }

    /// 纯函数（供 UT 覆盖，逐字对齐 open-codex L191-235）：几何 + 标签 + primaryAction 三条件判定
    /// 「合成侧按钮」（trailing band 内的小完成按钮，descendant 扫描时应过滤掉避免误点）。
    ///
    /// - hasSideActionLabel：labels 归一 trim.lowercased ∈ {"完成","done","complete","archive"}
    ///   或 count ≤ 24 时：含 "完成" / (含 "mark" 且 (含 "done" 或 "complete"))
    /// - trailingBandWidth = min(max(parentFrame.width * 0.22, 56), 140)
    /// - isTrailing = candidateFrame.midX >= parentFrame.maxX - trailingBandWidth
    /// - isCompact = (width ≤ max(88, parentW*0.18)) && (height ≤ max(44, parentH*1.2))
    /// - 判定 A：`hasSideActionLabel && hasPrimaryAction && isCompact` → true（label 类）
    /// - 判定 B：`isTrailing && isCompact && (hasPrimaryAction || hasSideActionLabel)` → true（trailing 类）
    /// - parentFrame / candidateFrame 任一 nil → false
    static func isLikelySyntheticSideActionCandidate(
        parentFrame: CGRect?,
        candidateFrame: CGRect?,
        hasPrimaryAction: Bool,
        labels: [String]
    ) -> Bool {
        let hasSideActionLabel = labels.contains { label in
            let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !normalized.isEmpty else { return false }
            if normalized == "完成" || normalized == "done"
                || normalized == "complete" || normalized == "archive"
            {
                return true
            }
            if normalized.count <= 24 {
                if normalized.contains("完成") { return true }
                if normalized.contains("mark")
                    && (normalized.contains("done") || normalized.contains("complete"))
                {
                    return true
                }
            }
            return false
        }
        guard let parentFrame, let candidateFrame else { return false }
        let trailingBandWidth = min(max(parentFrame.width * 0.22, 56), 140)
        let isTrailing = candidateFrame.midX >= parentFrame.maxX - trailingBandWidth
        let compactWidth = candidateFrame.width <= max(88, parentFrame.width * 0.18)
        let compactHeight = candidateFrame.height <= max(44, parentFrame.height * 1.2)
        let isCompact = compactWidth && compactHeight
        if hasSideActionLabel && hasPrimaryAction && isCompact { return true }
        return isTrailing && isCompact && (hasPrimaryAction || hasSideActionLabel)
    }

    // MARK: - activation-only fallback 支撑（C-8 / C-9 / C-10）

    /// role 是否允许 activation-only fallback（当所有 AX click 序列失败时退而求其次只激活窗口）。
    /// 仅 `kAXWindowRole` 生效，普通 UI 元素禁用（对齐 open-codex L277-283）。
    static func canUseActivationOnlyClickFallback(role: String?) -> Bool {
        guard let role else { return false }
        return role == (kAXWindowRole as String)
    }

    /// 尝试激活元素（不点击，只求焦点/主窗口）：AXRaise → set kAXMain=true → set kAXFocused=true。
    /// 三步任一成功即 activated=true（累积或语义，**非短路** — 对齐 open-codex L924-940）。
    /// availableActions 供 performAction 白名单校验；未含 AXRaise 时该步直接返 false 继续走 setBool。
    static func activateClickTarget(element: AXUIElement, availableActions: [String]) throws -> Bool {
        var activated = false
        if try ClickStrategy.performAction(
            named: kAXRaiseAction as String, on: element, availableActions: availableActions
        ) {
            activated = true
        }
        if try setBoolAttribute(named: kAXMainAttribute as String, on: element) {
            activated = true
        }
        if try setBoolAttribute(named: kAXFocusedAttribute as String, on: element) {
            activated = true
        }
        return activated
    }

    /// 对元素设置 CFBoolean=true（供 activateClickTarget 用）。对齐 open-codex L942-952：
    /// - `.success` → true
    /// - 容忍失败集（failure/attributeUnsupported/actionUnsupported/cannotComplete/
    ///   noValue/invalidUIElement/illegalArgument）→ false
    /// - 未知错误码 → throw `.message`
    static func setBoolAttribute(named attribute: String, on element: AXUIElement) throws -> Bool {
        let result = AXUIElementSetAttributeValue(element, attribute as CFString, kCFBooleanTrue)
        switch result {
        case .success:
            return true
        case .failure, .attributeUnsupported, .actionUnsupported, .cannotComplete,
             .noValue, .invalidUIElement, .illegalArgument:
            return false
        default:
            throw ComputerUseError.message(
                "AXUIElementSetAttributeValue(\(attribute)) failed with \(result.rawValue)"
            )
        }
    }

    // MARK: - list item 选中（C-7，performPreferredClick 左键前置）

    /// 从 element 向上找最多 8 层 AXList，命中即用 kAXSelectedChildrenAttribute 语义选中「元素所在 list 的直接子项」。
    /// 只对左键单击 + 非 web area 场景启用（编排在 `ClickStrategy.performPreferredClick` 内校验）。
    /// 对齐 open-codex L769-811：
    /// - 找不到 selectable list → false（继续 AXPress 序列）
    /// - `AXUIElementSetAttributeValue([directChild] as CFArray)` success → sleep 0.15 return true
    /// - 容忍失败集 → false；未知错误 → throw `.message`
    static func selectContainingListItem(for element: AXUIElement) throws -> Bool {
        guard let target = selectableListItem(containing: element) else { return false }
        let result = AXUIElementSetAttributeValue(
            target.list,
            kAXSelectedChildrenAttribute as CFString,
            [target.item] as CFArray
        )
        switch result {
        case .success:
            Thread.sleep(forTimeInterval: 0.15)
            return true
        case .failure, .attributeUnsupported, .actionUnsupported, .cannotComplete,
             .noValue, .invalidUIElement, .illegalArgument:
            return false
        default:
            throw ComputerUseError.message(
                "AXUIElementSetAttributeValue(\(kAXSelectedChildrenAttribute)) failed with \(result.rawValue)"
            )
        }
    }

    /// 向上最多 8 层 copyParent，追踪 directChild（元素在当前 list 中的直接子项）。
    /// 找到 role=AXList 且 kAXSelectedChildrenAttribute 可 set 的祖先即返 (list, item=directChild)；
    /// 否则 nil。对齐 open-codex L791-811。
    private static func selectableListItem(
        containing element: AXUIElement
    ) -> (list: AXUIElement, item: AXUIElement)? {
        var current = element
        var directChild = element
        for _ in 0..<8 {
            guard let parent = AccessibilitySnapshot.copyParent(of: current) else { return nil }
            if AccessibilitySnapshot.stringAttr(parent, kAXRoleAttribute) == (kAXListRole as String),
               isAttributeSettable(parent, attribute: kAXSelectedChildrenAttribute as String)
            {
                return (parent, directChild)
            }
            directChild = parent
            current = parent
        }
        return nil
    }

    // MARK: - AX 属性 settable 判定（activation 优先级 + list item 复用）

    /// 元素某属性是否可写（`AXUIElementIsAttributeSettable` 包装）。API 失败或 settable=false → false。
    static func isAttributeSettable(_ element: AXUIElement, attribute: String) -> Bool {
        var settable: DarwinBoolean = false
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        return result == .success && settable.boolValue
    }
}
