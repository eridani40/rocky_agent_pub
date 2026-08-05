import ApplicationServices
import CoreGraphics
import Foundation

// TreeRenderer —— AX 树 → 喂 LLM 的文本表示。
//
// 本模块承接 v0.0.160 gap#13 「AX 树精细化 render」——从 v0.0.159 的裸 walk（role+title+value）
// 升级到 open-codex 精细化 render：
//   - 段化输出：traits / label(Description) / help / url / identifier / value / placeholder / Secondary Actions
//   - Electron generic wrapper 折叠（`shouldElideNode`）+ 多子节点合并 summary（`summarizedGenericText`）
//   - AXLink 转 markdown 格式 `[text](url)`
//   - list/outline 部分展示提示 `(showing 0-N of TOTAL items)`
//   - synthetic text 合成节点（isSyntheticText=true）承载 summary 折叠后仍要展示的行
//
// LLM 视角变化 risk：render 一变则 LLM 观测彻底洗一遍——UT 不覆盖真实 AX；须在 dev dogfood
// 6+ 场景（Safari / Finder / Xcode / VSCode / Lark / WorkBuddy）人工验 `get_app_state` 无退化。
//
// 参考:
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:647-914 (RenderContext + TreeRenderer)
//   - specs/tech/version_logs/v0.0.160/change_plan.md 模块 F（F-1 ~ F-8）

// MARK: - AccessibilityTreeLimits（节点数 / 深度上限）

/// 树遍历上限（`shouldContinueRendering` 消费）。与 rocky v0.0.105 既有 maxNodes/maxDepth 语义等价，
/// 但用值类型 struct 便于按需替换（open-codex 对齐）。
public struct AccessibilityTreeLimits: Equatable, Sendable {
    public static let defaultMaxNodeCount = 1200
    public static let defaultMaxDepth = 64
    public static let defaults = AccessibilityTreeLimits(
        maxNodeCount: defaultMaxNodeCount,
        maxDepth: defaultMaxDepth
    )

    public let maxNodeCount: Int
    public let maxDepth: Int

    public init(maxNodeCount: Int = defaultMaxNodeCount, maxDepth: Int = defaultMaxDepth) {
        self.maxNodeCount = maxNodeCount
        self.maxDepth = maxDepth
    }
}

// MARK: - RenderContext

/// 渲染上下文（TreeRenderer 只读依赖，一次 build 全程复用）。
struct RenderContext {
    /// window frame（screen coord）——供 windowRelativeFrame 换算 local coord。nil = 无窗口坐标信息。
    let windowBounds: CGRect?
    /// 当前 focused 元素（供 `render` 内识别写入 focusedSummary）。
    let focusedElement: AXUIElement?
    /// 文本截断策略（sanitize/sanitizedValue/placeholder/... 消费）。
    let textLimit: SnapshotTextLimit
    /// 遍历上限（`shouldContinueRendering` 消费）。
    let treeLimits: AccessibilityTreeLimits
}

// MARK: - TreeRenderer

/// AX 树 → LLM 文本渲染器。
///
/// 用法：
/// ```swift
/// var renderer = TreeRenderer(context: ctx)
/// renderer.render(appElement)                // 主窗口
/// renderer.render(menuBarElement)            // menubar（若非 root）
/// let text = renderer.lines.joined(separator: "\n")
/// let records = renderer.records             // element_index → ElementRecord
/// let focus = renderer.focusedSummary        // "The focused UI element is X" 用
/// ```
///
/// 逐字对齐 open-codex `AccessibilitySnapshot.swift:654-914`。
struct TreeRenderer {
    let context: RenderContext
    /// 下一个 element_index（0 起，走 render 主路径 + renderSyntheticText 递增）。
    var nextIndex = 0
    /// 已产出的文本行（合并 "\n" 即为 axText body）。
    var lines: [String] = []
    /// element_index → ElementRecord（Service.lastRecords 消费，click/setValue/... 定位用）。
    var records: [Int: ElementRecord] = [:]
    /// focused 元素的 body 行（不含前置 tabs），供 AppSnapshot 顶层追加 "The focused UI element is X"。
    var focusedSummary: String?

    init(context: RenderContext) { self.context = context }

    /// 主渲染入口——DFS 递归 AX tree：ancestors 用 CFEqual 判环；shouldContinueRendering 门禁；
    /// shouldElideNode 隐藏空 wrapper（保 children 递归）；组装 10 段 lineBody + Secondary Actions；
    /// 记 `records[index]` = ElementRecord（含 identifier/isSyntheticText/prettyActions 三新字段）；
    /// row 特化（selected=false 时展开 flat texts）；genericTextSummary + summaryImages 走 synthetic children。
    ///
    /// 参考: open-codex AccessibilitySnapshot.swift:666-838（逐字对齐）。
    mutating func render(_ root: AXUIElement, depth: Int = 0, ancestors: [AXUIElement] = []) {
        guard shouldContinueRendering(nextIndex: nextIndex, depth: depth, limits: context.treeLimits) else { return }
        guard !ancestors.contains(where: { CFEqual($0, root) }) else { return }
        let nextAncestors = ancestors + [root]

        let index = nextIndex
        let role = _axString(root, kAXRoleAttribute) ?? "AXUnknown"
        let subrole = _axString(root, kAXSubroleAttribute)
        let baseRoleText = roleDescription(of: root, role: role, subrole: subrole)
        let label = _axString(root, kAXDescriptionAttribute).map { sanitizeText($0, textLimit: context.textLimit) }
        let help = _axString(root, kAXHelpAttribute).map { sanitizeText($0, textLimit: context.textLimit) }
        let value = sanitizedValue(of: root, textLimit: context.textLimit)
        let axIdentifier = displayIdentifier(_axString(root, kAXIdentifierAttribute))
        let traits = summarizeTraits(of: root)
        let actions = _axActions(root) ?? []
        let prettyActions = meaningfulActions(actions, role: role)
        let placeholder = placeholderValue(of: root, textLimit: context.textLimit)
        let waDepth = webAreaDepth(role: role, ancestors: ancestors)
        let screenFrame = AccessibilitySnapshot.frameOf(root)
        let localFrame: CGRect? = {
            guard let sf = screenFrame else { return nil }
            guard let wb = context.windowBounds else { return sf }
            return windowRelativeFrame(elementFrame: sf, windowBounds: wb)
        }()
        let rowTexts = role == kAXRowRole as String ? flattenedRowTexts(of: root, textLimit: context.textLimit) : []
        let childElements = children(of: root)
        let genericTextSummary = summarizedGenericText(of: root, role: role, childElements: childElements, textLimit: context.textLimit)
        let summaryImageChildren = genericTextSummary == nil ? [] : summaryImageDescendants(of: root)
        let rendersSummaryAsChildren = shouldRenderGenericTextSummaryAsChildren(genericTextSummary, summaryImageCount: summaryImageChildren.count)
        let title = preferredDisplayTitle(
            for: root, role: role, label: label, identifier: axIdentifier,
            explicitValue: value, rowTexts: rowTexts, textLimit: context.textLimit
        )
        let linkText = role == "AXLink" ? markdownLinkText(for: root, title: title, label: label, value: value, textLimit: context.textLimit) : nil
        let displayTitle = linkText ?? title
        let inlineRowSummary = outlineRowSummary(for: root, role: role)
        let hidesChildren = shouldSuppressChildren(role: role, title: displayTitle, genericTextSummary: genericTextSummary)
        let roleText = displayRoleText(baseRoleText: baseRoleText, role: role, title: displayTitle, label: label, suppressChildren: hidesChildren)

        // 空 generic wrapper 折叠 —— 保 children 递归但不产出自身行
        if shouldElideNode(
            role: role, title: displayTitle, label: label, value: value, identifier: axIdentifier,
            traits: traits, actions: prettyActions, childCount: childElements.count,
            genericTextSummary: genericTextSummary, webAreaDepth: waDepth
        ) {
            for child in childElements { render(child, depth: depth, ancestors: nextAncestors) }
            return
        }

        nextIndex += 1

        // 组装 10 段
        let traitsSegment = traits.isEmpty ? "" : " (\(traits.joined(separator: ", ")))"
        let titleSegment = displayTitle.map { " \($0)" } ?? ""
        let rowSummary = inlineRowSummary ?? (rendersSummaryAsChildren ? nil : genericTextSummary)
        let rowSummarySegment = rowSummary.map { " \($0)" } ?? ""
        let labelSegment = formattedLabelSegment(label, title: displayTitle, linkText: linkText, textLimit: context.textLimit)
        let helpSegment: String = {
            guard let help else { return "" }
            if help == displayTitle || help == label { return "" }
            return " Help: \(help)"
        }()
        let urlSegment = formattedURLSegment(for: root, title: displayTitle, label: label, textLimit: context.textLimit)
        let identifierSegment = displayIdentifierSegment(role: role, identifier: axIdentifier, title: displayTitle)
        let rawValueSegment = formattedValueSegment(for: root, roleText: roleText, title: displayTitle, value: value)
        let valueSegment = formattedValueSegmentWithSeparator(
            rawValueSegment, precedingSegments: [labelSegment, helpSegment, urlSegment, identifierSegment]
        )
        let placeholderSegment = formattedPlaceholderSegment(
            placeholder, title: displayTitle, label: label, value: value,
            precedingSegments: [labelSegment, helpSegment, urlSegment, identifierSegment, valueSegment]
        )
        let actionsPrefix = shouldCommaSeparateActions(
            title: displayTitle, inlineRowSummary: inlineRowSummary,
            genericTextSummary: genericTextSummary,
            segments: [labelSegment, helpSegment, urlSegment, identifierSegment, valueSegment, placeholderSegment]
        ) ? ", Secondary Actions: " : " Secondary Actions: "
        let actionsSegment = prettyActions.isEmpty ? "" : "\(actionsPrefix)\(prettyActions.joined(separator: ", "))"
        let linePrefix = roleText.isEmpty ? "\(index)" : "\(index) \(roleText)"

        let lineBody = "\(linePrefix)\(traitsSegment)\(titleSegment)\(rowSummarySegment)\(labelSegment)\(helpSegment)\(urlSegment)\(identifierSegment)\(valueSegment)\(placeholderSegment)"
        lines.append("\(String(repeating: "\t", count: depth))\(lineBody)\(actionsSegment)")

        // ElementRecord 写入 records（rocky 结构：role/title/value/screenFrame/actions[未过滤 primary] + 三新字段）
        // 注：rocky screenFrame 保 screen coord（Service.click 用），open-codex localFrame 保 window-relative；
        // 保留 rocky 语义（screenFrame + rawActions 全量），identifier/isSyntheticText/prettyActions 追加。
        _ = localFrame  // localFrame 仅日志用，records 不放（rocky 不需要）
        let secondaryActions = actions.filter { $0 != (kAXPressAction as String) }
        records[index] = ElementRecord(
            index: index, element: root, role: role, title: displayTitle,
            value: value, screenFrame: screenFrame, actions: secondaryActions, rawActions: actions,
            identifier: axIdentifier, isSyntheticText: false, prettyActions: prettyActions
        )

        // focused 记 body（不含 tabs）—— AppSnapshot 顶层用 "The focused UI element is X"
        if let focusedElement = context.focusedElement, CFEqual(focusedElement, root) {
            focusedSummary = lineBody
        }

        // row 特化：selected=false → 展开 rowTexts.dropFirst 每 text 直插 lines（无 index/depth 前缀）
        if role == kAXRowRole as String, _axBool(root, kAXSelectedAttribute) != true {
            for text in Array(rowTexts.dropFirst()) { lines.append(text) }
            return
        }

        // generic summary + images → 走 synthetic children 分支
        if rendersSummaryAsChildren, let genericTextSummary {
            renderSyntheticText(genericTextSummary, representedBy: root, depth: depth + 1)
            for image in summaryImageChildren { render(image, depth: depth + 1, ancestors: nextAncestors) }
            return
        }

        // suppressed children：menubar item / link 已 markdown / genericSummary 已消化
        if hidesChildren { return }

        for child in childElements { render(child, depth: depth + 1, ancestors: nextAncestors) }
    }

    /// synthetic text 合成节点：短文本 summary 折叠后仍要展示的 text 行；records 标 isSyntheticText=true。
    /// 参考: open-codex AccessibilitySnapshot.swift:840-858。
    private mutating func renderSyntheticText(_ text: String, representedBy element: AXUIElement, depth: Int) {
        guard shouldContinueRendering(nextIndex: nextIndex, depth: depth, limits: context.treeLimits) else { return }
        let index = nextIndex
        nextIndex += 1
        lines.append("\(String(repeating: "\t", count: depth))\(index) text \(text)")
        records[index] = ElementRecord(
            index: index, element: element, role: "AXStaticText", title: nil,
            value: text, screenFrame: AccessibilitySnapshot.frameOf(element), actions: [], rawActions: [],
            identifier: nil, isSyntheticText: true, prettyActions: []
        )
    }

    /// children 遍历：按 rows / contents / visibleChildren 优先级组合去重（open-codex 878-913）。
    /// list/outline/table/browser 用 rows 主通道；shouldSkipChild 过滤（menubar Apple 菜单）。
    private func children(of element: AXUIElement) -> [AXUIElement] {
        let role = _axString(element, kAXRoleAttribute)
        let rows = _axArray(element, kAXRowsAttribute) ?? []
        let visibleChildren = _axArray(element, axVisibleChildrenAttribute) ?? []
        let attributes = childTraversalAttributes(
            role: role, hasRows: !rows.isEmpty, hasVisibleChildren: !visibleChildren.isEmpty
        )
        var out: [AXUIElement] = []
        for attribute in attributes {
            let sourceValues: [AXUIElement]
            if attribute == kAXRowsAttribute { sourceValues = rows }
            else if attribute == axVisibleChildrenAttribute { sourceValues = visibleChildren }
            else { sourceValues = _axArray(element, attribute) ?? [] }
            let values = attribute == kAXRowsAttribute ? visibleRows(in: sourceValues, parent: element) : sourceValues
            for child in values {
                if shouldSkipChild(child, of: element) { continue }
                if !out.contains(where: { CFEqual($0, child) }) { out.append(child) }
            }
        }
        return out
    }
}
