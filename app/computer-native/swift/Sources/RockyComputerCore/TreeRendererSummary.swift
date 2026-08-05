import ApplicationServices
import CoreGraphics
import Foundation

// TreeRendererSummary —— generic text 汇总 + row 展开 + visible rows 判定。
//
// AX-dependent helper 从 TreeRendererHelpers.swift 拆出，隔离 summary 相关计算。
// 面向 `TreeRenderer.render` 主入口 + `TreeRendererHelpers.summarizedGenericText/flattenedRowTexts` 调用。
//
// 逐字对齐 refs/open-codex-computer-use `AccessibilitySnapshot.swift` 中的
// summaryImageDescendants / isPlainGenericTextContainer / descendantTexts(ForSummary) /
// summaryTextForLink / flattenedRowTexts / visibleRows / shouldSkipChild / webAreaDepth。
//
// 参考:
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:864-947 (childSkip/webAreaDepth)
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:1487-1604 (summary generation)
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:1748-1865 (row/visible rows)
//   - specs/tech/version_logs/v0.0.160/change_plan.md 模块 F

// MARK: - generic text summary（Electron 无标记 wrapper 汇总）

/// 折叠 AXGroup/AXUnknown 无标记 wrapper 内的 static text 为一行汇总（open-codex 1487-1517）。
/// isPlainGenericTextContainer 判定通过 + text 数 ≥2 + shouldMergeTextOnlySiblings 通过时产出。
func summarizedGenericText(of element: AXUIElement, role: String, childElements: [AXUIElement], textLimit: SnapshotTextLimit = .defaults) -> String? {
    guard role == kAXGroupRole as String || role == kAXUnknownRole as String else { return nil }
    guard !childElements.isEmpty else { return nil }
    guard isPlainGenericTextContainer(element, children: childElements) else { return nil }
    let texts = descendantTextsForSummary(of: element, textLimit: textLimit)
    guard texts.count >= 2 else { return nil }
    guard shouldMergeTextOnlySiblings(texts) else { return nil }
    let joined = sanitizeText(texts.joined(separator: " "), textLimit: textLimit).replacingOccurrences(of: " : ", with: " :  ")
    return joined.isEmpty ? nil : joined
}

/// summary 内伴随的 image children（open-codex 1519-1547）：depth ≤4 收集 AXImage 子孙，最多 4 个。
func summaryImageDescendants(of element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    guard depth < 4 else { return [] }
    let children = _axArray(element, kAXChildrenAttribute) ?? []
    var images: [AXUIElement] = []
    for child in children {
        let role = _axString(child, kAXRoleAttribute) ?? ""
        if role == kAXImageRole as String {
            if !images.contains(where: { CFEqual($0, child) }) { images.append(child) }
        } else {
            for image in summaryImageDescendants(of: child, depth: depth + 1) {
                if !images.contains(where: { CFEqual($0, image) }) { images.append(image) }
            }
        }
        if images.count >= 4 { return Array(images.prefix(4)) }
    }
    return images
}

/// 是否 generic container 只含 static text/image/link（open-codex 1578-1604）；depth ≤3。
func isPlainGenericTextContainer(_ element: AXUIElement, children: [AXUIElement], depth: Int = 0) -> Bool {
    for child in children {
        let childRole = _axString(child, kAXRoleAttribute) ?? ""
        if childRole == kAXStaticTextRole as String || childRole == kAXImageRole as String { continue }
        if childRole == "AXLink", summaryTextForLink(child) != nil { continue }
        if childRole == kAXGroupRole as String || childRole == kAXUnknownRole as String {
            guard depth < 3 else { return false }
            if isPlainGenericTextContainer(child, children: _axArray(child, kAXChildrenAttribute) ?? [], depth: depth + 1) { continue }
        }
        return false
    }
    return true
}

/// summary 抽取 text（open-codex 1795-1822）：depth ≤8；AXLink → summaryTextForLink；
/// static text/text field → value 或 title；其余递归 children。
func descendantTextsForSummary(of element: AXUIElement, depth: Int = 0, textLimit: SnapshotTextLimit = .defaults) -> [String] {
    guard depth < 8 else { return [] }
    let role = _axString(element, kAXRoleAttribute) ?? ""
    if role == "AXLink", let linkText = summaryTextForLink(element, textLimit: textLimit) { return [linkText] }
    if role == kAXStaticTextRole as String || role == kAXTextFieldRole as String {
        if let value = sanitizedValue(of: element, textLimit: textLimit), !value.isEmpty { return [value] }
        if let title = _axString(element, kAXTitleAttribute) {
            let s = sanitizeText(title, textLimit: textLimit)
            return s.isEmpty ? [] : [s]
        }
    }
    return (_axArray(element, kAXChildrenAttribute) ?? []).flatMap { descendantTextsForSummary(of: $0, depth: depth + 1, textLimit: textLimit) }
}

/// AXLink 子孙 text → markdown 链接（open-codex 1824-1841）。
func summaryTextForLink(_ element: AXUIElement, textLimit: SnapshotTextLimit = .defaults) -> String? {
    guard let url = urlValue(of: element, attribute: kAXURLAttribute, textLimit: textLimit), !url.isEmpty else { return nil }
    let childText = (_axArray(element, kAXChildrenAttribute) ?? [])
        .flatMap { descendantTextsForSummary(of: $0, textLimit: textLimit) }.joined(separator: " ")
    let sanitized = sanitizeText(childText, textLimit: textLimit)
    guard !sanitized.isEmpty else { return nil }
    return summaryMarkdownLinkText(text: sanitized, url: url)
}

// MARK: - row 拆解 + visible rows

/// row (AXRow) 拆 flat text（open-codex 1748-1767）：cells → descendant texts → sanitize → unique 保序。
func flattenedRowTexts(of element: AXUIElement, textLimit: SnapshotTextLimit = .defaults) -> [String] {
    let cells = _axArray(element, kAXChildrenAttribute) ?? []
    let texts = cells.flatMap { descendantTexts(of: $0, textLimit: textLimit) }
        .map { sanitizeText($0, textLimit: textLimit) }.filter { !$0.isEmpty }
    var unique: [String] = []
    var seen: Set<String> = []
    for text in texts { if seen.insert(text).inserted { unique.append(text) } }
    return unique
}

/// row 内 descendant text 收集（open-codex 1769-1793）：depth ≤4；static text/text field 取 value 或 title。
func descendantTexts(of element: AXUIElement, depth: Int = 0, textLimit: SnapshotTextLimit = .defaults) -> [String] {
    guard depth < 4 else { return [] }
    var values: [String] = []
    let role = _axString(element, kAXRoleAttribute) ?? ""
    if role == kAXStaticTextRole as String || role == kAXTextFieldRole as String {
        if let value = sanitizedValue(of: element, textLimit: textLimit) {
            values.append(value)
        } else if let title = _axString(element, kAXTitleAttribute) {
            values.append(sanitizeText(title, textLimit: textLimit))
        }
    }
    for child in _axArray(element, kAXChildrenAttribute) ?? [] {
        values.append(contentsOf: descendantTexts(of: child, depth: depth + 1, textLimit: textLimit))
    }
    return values
}

/// list/outline 可见 rows（open-codex 1847-1865）：与 parent frame 相交；空则前 20 行兜底；上限 20。
func visibleRows(in rows: [AXUIElement], parent: AXUIElement) -> [AXUIElement] {
    guard let parentFrame = AccessibilitySnapshot.frameOf(parent) else { return Array(rows.prefix(20)) }
    let visible = rows.filter {
        guard let rowFrame = AccessibilitySnapshot.frameOf($0) else { return false }
        return rowFrame.intersects(parentFrame)
    }
    if visible.isEmpty { return Array(rows.prefix(20)) }
    return Array(visible.prefix(20))
}

// MARK: - child skip / parent role

/// 是否跳过 child（open-codex 940-947）：menubar 内 title == "Apple" 苹果菜单跳过。
func shouldSkipChild(_ child: AXUIElement, of parent: AXUIElement) -> Bool {
    let parentRole = _axString(parent, kAXRoleAttribute)
    guard parentRole == kAXMenuBarRole as String else { return false }
    return _axString(child, kAXTitleAttribute) == "Apple"
}

/// webArea 后代深度（open-codex 864-876）：自身 = AXWebArea → 0；祖先里有 → ancestors.count-index；否则 nil。
func webAreaDepth(role: String, ancestors: [AXUIElement]) -> Int? {
    if role == axWebAreaRole { return 0 }
    guard let idx = ancestors.firstIndex(where: { _axString($0, kAXRoleAttribute) == axWebAreaRole }) else { return nil }
    return ancestors.count - idx
}
