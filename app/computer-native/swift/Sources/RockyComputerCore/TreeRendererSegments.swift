import ApplicationServices
import CoreGraphics
import Foundation

// TreeRendererSegments —— 文本清洗 + 段格式化 + 隐藏节点判定的纯函数集合。
//
// 面向 `TreeRenderer` 主渲染入口调用；本文件内所有函数**无副作用、可 UT**。
// 逐字对齐 refs/open-codex-computer-use `AccessibilitySnapshot.swift` 中的
// sanitize/format*Segment/shouldElideNode/shouldSuppressChildren/displayRoleText 等区段。
//
// 参考:
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:1736-1746 (sanitizeText)
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:1242-1341 (段格式化)
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:1408-1485 (elide/suppress)
//   - specs/tech/version_logs/v0.0.160/change_plan.md 模块 F

// MARK: - AX role/attribute 字符串常量（open-codex 使用裸字符串，无 kAX 常量）

let axWebAreaRole = "AXWebArea"
let axContentsAttribute = "AXContents"
let axVisibleChildrenAttribute = "AXVisibleChildren"

// MARK: - 文本清洗

/// 折行 → trim → 超长截断（后缀「...」）。textLimit.maxCount=nil 时不截断。
///
/// - `\n` → `\\n` 折行（AX text 常带换行）
/// - trim 首尾空白/换行
/// - 超上限：`prefix(maxCount) + "..."`
///
/// 参考: open-codex AccessibilitySnapshot.swift:1736-1746。
func sanitizeText(_ value: String, textLimit: SnapshotTextLimit = .defaults) -> String {
    let collapsed = value
        .replacingOccurrences(of: "\n", with: "\\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if let maxCount = textLimit.maxCount, collapsed.count > maxCount {
        return String(collapsed.prefix(maxCount)) + "..."
    }
    return collapsed
}

/// AXIdentifier 展示归一：nil / 空 / `_NS:` 前缀（AppKit 内部命名）→ nil。
func displayIdentifier(_ value: String?) -> String? {
    guard let value, !value.isEmpty, !value.hasPrefix("_NS:") else { return nil }
    return value
}

/// windowTitle 展示归一：空 → appName；`"{appName} –"` 前缀 → appName（避免重复）。
func displayWindowTitle(_ value: String?, appName: String) -> String {
    guard let value, !value.isEmpty else { return appName }
    if value.hasPrefix("\(appName) –") { return appName }
    return value
}

/// 加双引号（`"xxx"`）——open-codex `quoted(_:)`。
func quoted(_ value: String) -> String { "\"\(value)\"" }

// MARK: - CamelCase / AX 前缀归一

/// CamelCase → 空格分隔（`ShowMenu` → `"Show Menu"`）。前置字符大写不加前导空格。
func splitCamelCase(_ value: String) -> String {
    var result = ""
    for character in value {
        if character.isUppercase, !result.isEmpty { result.append(" ") }
        result.append(character)
    }
    return result
}

/// AX 常量 → 人类可读小写（`AXPopUpButton` → `"pop up button"`）。
func humanizeAXToken(_ value: String) -> String {
    let stripped = value.hasPrefix("AX") ? String(value.dropFirst(2)) : value
    return splitCamelCase(stripped).lowercased()
}

// MARK: - markdown link 转义（open-codex 1218-1223）

/// markdown link 文本转义：反斜杠 `\\` / 方括号 `[` `]` 转义。
func markdownEscapedLinkText(_ text: String) -> String {
    text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
}

/// markdown 链接文本组装：`[<escaped-text>](<url>)`。供 summarizeGenericText 内联链接用。
func summaryMarkdownLinkText(text: String, url: String) -> String {
    "[\(markdownEscapedLinkText(text))](\(url))"
}

// MARK: - 段格式化（Label / Value / Placeholder / URL / Identifier）

/// Description 段（源自 kAXDescriptionAttribute）：
/// - 无 label / label == title / sanitized == title → 空
/// - label 已被 linkText 消化（`[label](...)`）→ 空
/// - 否则 `" Description: <sanitizedLabel>"`
///
/// 参考: open-codex 1266-1287。
func formattedLabelSegment(_ label: String?, title: String?, linkText: String?, textLimit: SnapshotTextLimit = .defaults) -> String {
    guard let label, label != title else { return "" }
    let sanitizedLabel = sanitizeText(label, textLimit: textLimit)
    guard !sanitizedLabel.isEmpty, sanitizedLabel != title else { return "" }
    let comparableLabel = markdownEscapedLinkText(sanitizedLabel)
    if let linkText, linkText.hasPrefix("[\(comparableLabel)](") { return "" }
    return " Description: \(sanitizedLabel)"
}

/// Value 段跟隔（Value: 前如果有 precedingSegments 非空，补前置逗号）。
/// 参考: open-codex 1289-1295。
func formattedValueSegmentWithSeparator(_ valueSegment: String, precedingSegments: [String]) -> String {
    guard valueSegment.hasPrefix(" Value:"), precedingSegments.contains(where: { !$0.isEmpty }) else {
        return valueSegment
    }
    return ",\(valueSegment)"
}

/// Placeholder 段：与 title/label/value 重复则隐（有 title 或 precedingSegments 非空时前导逗号）。
/// 参考: open-codex 1297-1308。
func formattedPlaceholderSegment(_ placeholder: String?, title: String?, label: String?, value: String?, precedingSegments: [String]) -> String {
    guard let placeholder, !placeholder.isEmpty else { return "" }
    if placeholder == title || placeholder == label || placeholder == value { return "" }
    let prefix = precedingSegments.contains(where: { !$0.isEmpty }) || title != nil ? ", Placeholder: " : " Placeholder: "
    return "\(prefix)\(placeholder)"
}

/// Actions 段前缀：有 title / rowSummary / genericSummary / 任一 segment 非空 → 逗号分隔；否则空格分隔。
/// 参考: open-codex 1310-1320。
func shouldCommaSeparateActions(title: String?, inlineRowSummary: String?, genericTextSummary: String?, segments: [String]) -> Bool {
    title != nil
        || inlineRowSummary != nil
        || genericTextSummary != nil
        || segments.contains(where: { !$0.isEmpty })
}

/// Identifier 段：outline/list 且 title == identifier → 隐；否则 `" ID: <identifier>"`。
/// 参考: open-codex 1365-1375。
func displayIdentifierSegment(role: String, identifier: String?, title: String?) -> String {
    guard let identifier else { return "" }
    if (role == kAXOutlineRole as String || role == kAXListRole as String), title == identifier { return "" }
    return " ID: \(identifier)"
}

// MARK: - shouldElideNode / shouldSuppressChildren / displayRoleText / shouldPreserveWebAreaGenericContainer

/// 是否隐藏空 Electron generic wrapper。仅对 AXGroup/AXUnknown 判定；含 genericTextSummary 或
/// webArea 保留分支时不隐；否则「无 identity 信息」→ 隐藏但保留 children 递归。
/// 参考: open-codex 1408-1450。
func shouldElideNode(
    role: String,
    title: String?,
    label: String?,
    value: String?,
    identifier: String?,
    traits: [String],
    actions: [String],
    childCount: Int,
    genericTextSummary: String? = nil,
    webAreaDepth: Int? = nil
) -> Bool {
    let genericRoles = [kAXGroupRole as String, kAXUnknownRole as String]
    guard genericRoles.contains(role) else { return false }
    if genericTextSummary != nil { return false }
    if shouldPreserveWebAreaGenericContainer(childCount: childCount, webAreaDepth: webAreaDepth) { return false }
    if childCount == 1,
       title == nil, label == nil, value == nil, identifier == nil,
       actions.isEmpty,
       traitsAreNonDescriptiveWrapperTraits(traits) {
        return true
    }
    return title == nil && label == nil && value == nil && identifier == nil && traits.isEmpty && actions.isEmpty
}

/// webArea 后代 generic 容器保留判定：childCount>1 才保留（≤1 视为可折叠 wrapper）。
/// 参考: open-codex 1452-1458。
func shouldPreserveWebAreaGenericContainer(childCount: Int, webAreaDepth: Int?) -> Bool {
    guard childCount > 0, webAreaDepth != nil else { return false }
    return childCount > 1
}

/// traits 是否非描述性（空 / 仅 "settable","string"）。
func traitsAreNonDescriptiveWrapperTraits(_ traits: [String]) -> Bool {
    traits.isEmpty || traits == ["settable", "string"]
}

/// 是否折叠子节点：menubar item / link 且 title 已是 markdown / 有 genericTextSummary → true。
/// 参考: open-codex 1464-1485。
func shouldSuppressChildren(role: String, title: String?, genericTextSummary: String?) -> Bool {
    if role == kAXMenuBarItemRole as String { return true }
    if role == "AXLink", title?.hasPrefix("[") == true { return true }
    return genericTextSummary != nil
}

/// role text 展示归一：menubar item 隐；link 保 baseRoleText；suppressChildren=true 用 "container"；
/// radio group 但 title==nil label!=nil 隐；其余原样。
/// 参考: open-codex 1606-1630。
func displayRoleText(baseRoleText: String, role: String, title: String?, label: String?, suppressChildren: Bool) -> String {
    if role == kAXMenuBarItemRole as String { return "" }
    if role == "AXLink" { return baseRoleText }
    if suppressChildren { return "container" }
    if baseRoleText == "radio group", role == kAXRadioGroupRole as String, title == nil, label != nil { return "" }
    return baseRoleText
}

// MARK: - text-only sibling 合并判定（generic container 汇总）

/// generic container 内文本 siblings 合并判定：日期/时间双语组 / 计数器（1/5）/ 时间段（10:00-11:00）→ 拒；
/// 数量 ≤8 且总长 ≤220 → 允许合并。
/// 参考: open-codex 1553-1568。
func shouldMergeTextOnlySiblings(_ texts: [String]) -> Bool {
    if texts.contains("日期") && texts.contains("时间") { return false }
    if texts.contains(where: isSiblingCounterText(_:)) { return false }
    if texts.contains(where: isStandaloneTimeRangeText(_:)) { return false }
    let totalLength = texts.reduce(0) { $0 + $1.count }
    return texts.count <= 8 && totalLength <= 220
}

/// 计数器文本判定：`^\d+\s*/\s*\d+$`（如 "1 / 3"）。
func isSiblingCounterText(_ text: String) -> Bool {
    text.range(of: #"^\d+\s*/\s*\d+$"#, options: .regularExpression) != nil
}

/// 时间段文本判定：`^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$`（如 "10:00 - 11:30"）。
func isStandaloneTimeRangeText(_ text: String) -> Bool {
    text.range(of: #"^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$"#, options: .regularExpression) != nil
}

/// 是否将 genericTextSummary 渲染为 children（vs inline row summary）：
/// 有 summary 且伴有图像 → 走 children 分支。
/// 参考: open-codex 1549-1551。
func shouldRenderGenericTextSummaryAsChildren(_ genericTextSummary: String?, summaryImageCount: Int) -> Bool {
    genericTextSummary != nil && summaryImageCount > 0
}

// MARK: - meaningful actions 过滤（去内隐 UI 提示 + 拆 pretty 别名）

/// 过滤内隐 UI action（AXPress/AXShow*/AXConfirm/AXScrollToVisible），menubar 系再滤 Cancel/Pick，
/// AXScrollArea 时按 Up/Down 分页优先隐 Left/Right 分页；剩余走 `prettyActionName` 拆 CamelCase。
/// 参考: open-codex 1673-1708。
func meaningfulActions(_ values: [String], role: String) -> [String] {
    let menuRoles = [kAXMenuBarRole as String, kAXMenuBarItemRole as String, kAXMenuRole as String, kAXMenuItemRole as String]
    return values.filter {
        var ignored = [kAXPressAction as String, "AXShowDefaultUI", "AXShowAlternateUI", "AXShowMenu", "AXConfirm", "AXScrollToVisible"]
        if menuRoles.contains(role) { ignored.append(contentsOf: ["AXCancel", "AXPick"]) }
        return !ignored.contains($0)
    }.filter {
        guard role == kAXScrollAreaRole as String else { return true }
        if values.contains("AXScrollUpByPage") || values.contains("AXScrollDownByPage") {
            return $0 != "AXScrollLeftByPage" && $0 != "AXScrollRightByPage"
        }
        return true
    }.map(AccessibilitySnapshot.prettyActionName(_:))
}

// MARK: - 树遍历约束

/// 渲染门禁：`nextIndex < maxNodeCount && depth < maxDepth`。
/// 参考: open-codex 949-955。
func shouldContinueRendering(nextIndex: Int, depth: Int, limits: AccessibilityTreeLimits) -> Bool {
    nextIndex < limits.maxNodeCount && depth < limits.maxDepth
}

/// children 遍历属性优先级（Row/List primary 时不拉 kAXChildren，全走 rows/visibleChildren）。
/// 参考: open-codex 916-925。
func childTraversalAttributes(role: String?, hasRows: Bool, hasVisibleChildren: Bool) -> [String] {
    var attributes: [String] = []
    if !(hasRows && usesRowsAsPrimaryRole(role)) && !(hasVisibleChildren && usesVisibleChildrenAsPrimaryRole(role)) {
        attributes.append(kAXChildrenAttribute)
    }
    attributes.append(kAXRowsAttribute)
    attributes.append(axContentsAttribute)
    attributes.append(axVisibleChildrenAttribute)
    return attributes
}

/// outline/list/table/browser 用 rows 作为主 children 通道。
func usesRowsAsPrimaryRole(_ role: String?) -> Bool {
    return [kAXOutlineRole as String, kAXListRole as String, kAXTableRole as String, "AXBrowser"].contains(role)
}

/// list 用 visibleChildren 作为主 children 通道（滚动 list 优化）。
func usesVisibleChildrenAsPrimaryRole(_ role: String?) -> Bool {
    role == kAXListRole as String
}

// MARK: - window frame 换算

/// 元素 screen frame → window-relative frame（用于 renderer 局部坐标展示）。
/// 参考: open-codex 1632-1639。
func windowRelativeFrame(elementFrame: CGRect, windowBounds: CGRect) -> CGRect {
    CGRect(
        x: elementFrame.minX - windowBounds.minX,
        y: elementFrame.minY - windowBounds.minY,
        width: elementFrame.width,
        height: elementFrame.height
    )
}
