import ApplicationServices
import CoreGraphics
import Foundation

// TreeRendererHelpers —— AX-dependent 中层 helper（读元素属性 + 归一段值）。
//
// 面向 `TreeRenderer.render` 主入口调用；本文件内所有函数依赖 `AXUIElement`，
// 不能纯 UT，需真机 AX 权限。UT 覆盖仅限本文件顶部的 stringValue/attributeValue/isSettable
// 等基础 AX 包装（通过 dummy AXUIElement 触发失败路径）。
//
// 逐字对齐 refs/open-codex-computer-use `AccessibilitySnapshot.swift` 中的
// summarizeTraits/roleDescription/preferredDisplayTitle/markdownLinkText/outlineRowSummary/
// summarizedGenericText/summaryImageDescendants/isPlainGenericTextContainer/flattenedRowTexts 等区段。
//
// 参考:
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:957-1188 (AX helpers + traits + title/label)
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:1487-1604 (summary generation)
//   - refs/open-codex-computer-use AccessibilitySnapshot.swift:1641-1734 (roleDescription/actions)
//   - specs/tech/version_logs/v0.0.160/change_plan.md 模块 F

// MARK: - 基础 AX 包装（复用 AccessibilitySnapshot.copyAttr 减少重复）

/// 读原始 CFTypeRef 属性值（`copyAttr` 别名，`_ax*` 前缀标示本文件私域）。
func _axAttrValue(_ element: AXUIElement, _ attr: String) -> CFTypeRef? {
    AccessibilitySnapshot.copyAttr(element, attr)
}

/// 读 String 属性值：空/纯空白 → nil；非 String type → nil。
func _axString(_ element: AXUIElement, _ attr: String) -> String? {
    guard let v = _axAttrValue(element, attr) else { return nil }
    if CFGetTypeID(v) == CFStringGetTypeID(), let s = v as? String {
        return s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : s
    }
    return nil
}

/// 读 [AXUIElement] 数组属性值。
func _axArray(_ element: AXUIElement, _ attr: String) -> [AXUIElement]? {
    guard let v = _axAttrValue(element, attr) else { return nil }
    return v as? [AXUIElement]
}

/// 读单 AXUIElement 属性值（force-cast，AX API 语义保证类型）。
func _axElement(_ element: AXUIElement, _ attr: String) -> AXUIElement? {
    guard let v = _axAttrValue(element, attr) else { return nil }
    // swiftlint:disable:next force_cast
    return (v as! AXUIElement)
}

/// 读 Bool 属性值：非 Bool → nil。
func _axBool(_ element: AXUIElement, _ attr: String) -> Bool? {
    guard let v = _axAttrValue(element, attr) else { return nil }
    if let b = v as? Bool { return b }
    if let n = v as? NSNumber { return n.boolValue }
    return nil
}

/// 属性是否可 set（`AXUIElementIsAttributeSettable`）。
func _axIsSettable(_ element: AXUIElement, _ attr: String) -> Bool {
    var settable = DarwinBoolean(false)
    let error = AXUIElementIsAttributeSettable(element, attr as CFString, &settable)
    return error == .success && settable.boolValue
}

/// action 列表（`AXUIElementCopyActionNames`）；失败/无 → nil。
func _axActions(_ element: AXUIElement) -> [String]? {
    var actions: CFArray?
    let error = AXUIElementCopyActionNames(element, &actions)
    guard error == .success else { return nil }
    return actions as? [String]
}

// MARK: - traits（selected/expanded/disabled/settable + value type）

/// 元素 traits 序列化（open-codex 957-981）：
/// selected / expanded / disabled / settable + value type（string/boolean/float）。
func summarizeTraits(of element: AXUIElement) -> [String] {
    var values: [String] = []
    if _axBool(element, kAXSelectedAttribute) == true { values.append("selected") }
    if _axBool(element, kAXExpandedAttribute) == true { values.append("expanded") }
    if _axBool(element, kAXEnabledAttribute) == false { values.append("disabled") }
    if _axIsSettable(element, kAXValueAttribute) { values.append("settable") }
    if let vt = valueTypeTrait(of: element) { values.append(vt) }
    return values
}

/// value 类型 trait：settable 的 value 才判定；string / boolean / float。
/// 参考: open-codex 983-1005。
func valueTypeTrait(of element: AXUIElement) -> String? {
    guard _axIsSettable(element, kAXValueAttribute) else { return nil }
    guard let value = _axAttrValue(element, kAXValueAttribute) else { return nil }
    if CFGetTypeID(value) == CFStringGetTypeID() { return "string" }
    if value is NSNumber {
        if numericValueRepresentsBoolean(for: element, value: value) { return "boolean" }
        return "float"
    }
    return nil
}

/// number 0/1 是否语义 = boolean：role in {tab/checkbox/radio button} → true。
/// 参考: open-codex 1126-1145。
func numericValueRepresentsBoolean(for element: AXUIElement, value: CFTypeRef) -> Bool {
    guard let number = value as? NSNumber else { return false }
    guard number == 0 || number == 1 else { return false }
    let role = _axString(element, kAXRoleAttribute) ?? ""
    let roleText = roleDescription(of: element, role: role, subrole: _axString(element, kAXSubroleAttribute))
    return roleText == "tab" || role == kAXCheckBoxRole as String || role == kAXRadioButtonRole as String
}

// MARK: - value / placeholder 段（AX 值归一 + 截断）

/// AX Value 归一（open-codex 1092-1111）：String → sanitize；NSNumber → tab/checkbox → on/off，
/// 其他 → number.stringValue；无值/其他类型 → nil。
func sanitizedValue(of element: AXUIElement, textLimit: SnapshotTextLimit = .defaults) -> String? {
    if let string = _axString(element, kAXValueAttribute) {
        let sanitized = sanitizeText(string, textLimit: textLimit)
        return sanitized.isEmpty ? nil : sanitized
    }
    guard let value = _axAttrValue(element, kAXValueAttribute) else { return nil }
    if let number = value as? NSNumber {
        if numericValueRepresentsBoolean(for: element, value: value) { return number.boolValue ? "on" : "off" }
        return number.stringValue
    }
    return nil
}

/// placeholder 归一（open-codex 1113-1124）：AXPlaceholderValue / AXPlaceholder 两 attr 优先级；非空返 sanitized。
func placeholderValue(of element: AXUIElement, textLimit: SnapshotTextLimit = .defaults) -> String? {
    for attribute in ["AXPlaceholderValue", "AXPlaceholder"] {
        if let string = _axString(element, attribute) {
            let sanitized = sanitizeText(string, textLimit: textLimit)
            if !sanitized.isEmpty { return sanitized }
        }
    }
    return nil
}

/// 已选 focused text（open-codex 1063-1069）：AXSelectedText → sanitize；空 → nil。
func copySelectedText(_ element: AXUIElement, textLimit: SnapshotTextLimit = .defaults) -> String? {
    guard let value = _axString(element, kAXSelectedTextAttribute) else { return nil }
    let sanitized = sanitizeText(value, textLimit: textLimit)
    return sanitized.isEmpty ? nil : sanitized
}

// MARK: - roleDescription / preferredDisplayTitle

/// role → 人类展示（open-codex 1641-1671）：
/// row / group→container / menu bar item / link / web area（走 AXRoleDescription 兜 "HTML 内容"）；
/// 其他优先读 kAXRoleDescriptionAttribute（小写）；subrole==standard window 兜 "standard window"；
/// 兜 `humanizeAXToken(role)`。
func roleDescription(of element: AXUIElement, role: String, subrole: String?) -> String {
    if role == kAXRowRole as String { return "row" }
    if role == kAXGroupRole as String { return "container" }
    if role == kAXMenuBarItemRole as String { return "" }
    if role == "AXLink" { return "link" }
    if role == axWebAreaRole { return _axString(element, kAXRoleDescriptionAttribute) ?? "HTML 内容" }
    if let rd = _axString(element, kAXRoleDescriptionAttribute), !rd.isEmpty { return rd.lowercased() }
    if let subrole, subrole == kAXStandardWindowSubrole as String { return "standard window" }
    return humanizeAXToken(role)
}

/// preferredDisplayTitle（open-codex 1147-1188）：AXTitle 优先；row → 首行 rowText；
/// outline/list identifier；button/popup label；image label；group/unknown/webArea label；
/// search text field → explicitValue；否则 nil。
func preferredDisplayTitle(
    for element: AXUIElement, role: String, label: String?, identifier: String?,
    explicitValue: String?, rowTexts: [String], textLimit: SnapshotTextLimit = .defaults
) -> String? {
    if let title = _axString(element, kAXTitleAttribute), !title.isEmpty {
        return sanitizeText(title, textLimit: textLimit)
    }
    if role == kAXRowRole as String { return rowTexts.first }
    if (role == kAXOutlineRole as String || role == kAXListRole as String), let identifier { return identifier }
    if (role == kAXButtonRole as String || role == kAXPopUpButtonRole as String), let label, !label.isEmpty {
        return sanitizeText(label, textLimit: textLimit)
    }
    if role == kAXImageRole as String, let label, !label.isEmpty { return sanitizeText(label, textLimit: textLimit) }
    if (role == kAXGroupRole as String || role == kAXUnknownRole as String || role == axWebAreaRole),
       let label, !label.isEmpty {
        return sanitizeText(label, textLimit: textLimit)
    }
    guard roleDescription(of: element, role: role, subrole: _axString(element, kAXSubroleAttribute)) == "search text field" else {
        return nil
    }
    return explicitValue
}

/// AXLink → markdown 格式（open-codex 1190-1216）：url 存在时用 [label|title|value](url) 首个非空文本。
func markdownLinkText(for element: AXUIElement, title: String?, label: String?, value: String?, textLimit: SnapshotTextLimit = .defaults) -> String? {
    guard let url = urlValue(of: element, attribute: kAXURLAttribute, textLimit: textLimit), !url.isEmpty else {
        return nil
    }
    let text = [label, title, value].compactMap { c -> String? in
        guard let c else { return nil }
        let s = sanitizeText(c, textLimit: textLimit)
        return s.isEmpty ? nil : s
    }.first
    guard let text else { return nil }
    return "[\(markdownEscapedLinkText(text))](\(url))"
}

/// outline/list 部分渲染指示（open-codex 1225-1240）：`(showing 0-N of TOTAL items)`；
/// 可见 rows > 0 && < 全 rows 时才产出。
func outlineRowSummary(for element: AXUIElement, role: String) -> String? {
    guard role == kAXOutlineRole as String || role == kAXListRole as String else { return nil }
    guard let allRows = _axArray(element, kAXRowsAttribute), !allRows.isEmpty else { return nil }
    let visible = visibleRows(in: allRows, parent: element)
    guard !visible.isEmpty, visible.count < allRows.count else { return nil }
    return "(showing 0-\(visible.count - 1) of \(allRows.count) items)"
}

/// Value 段（open-codex 1242-1264）：value 空/等价 title → 隐；scroll bar/value indicator/text entry area →
/// 空格前缀；AXStaticText 无 title → 空格前缀；其余 `" Value: <value>"`。
func formattedValueSegment(for element: AXUIElement, roleText: String, title: String?, value: String?) -> String {
    guard let value, !value.isEmpty else { return "" }
    if roleText == "search text field", title == value { return "" }
    if title == nil, let role = _axString(element, kAXRoleAttribute), role == kAXStaticTextRole as String { return " \(value)" }
    if ["scroll bar", "value indicator"].contains(roleText) { return " \(value)" }
    if roleText == "text entry area" { return " \(value)" }
    return " Value: \(value)"
}

/// AXWebArea URL 段（open-codex 1322-1341）：非 AXWebArea 或 url 与 title/label 重复 → 空；否则 `", URL: <url>"`。
func formattedURLSegment(for element: AXUIElement, title: String?, label: String?, textLimit: SnapshotTextLimit = .defaults) -> String {
    guard _axString(element, kAXRoleAttribute) == axWebAreaRole else { return "" }
    guard let url = urlValue(of: element, attribute: kAXURLAttribute, textLimit: textLimit), !url.isEmpty else { return "" }
    if url == title || url == label { return "" }
    return ", URL: \(url)"
}

/// 读 URL 值（String 或 CFURL，sanitize 后返回）。参考: open-codex 1343-1363。
func urlValue(of element: AXUIElement, attribute: String, textLimit: SnapshotTextLimit = .defaults) -> String? {
    guard let value = _axAttrValue(element, attribute) else { return nil }
    if CFGetTypeID(value) == CFStringGetTypeID(), let string = value as? String {
        let s = sanitizeText(string, textLimit: textLimit)
        return s.isEmpty ? nil : s
    }
    if CFGetTypeID(value) == CFURLGetTypeID(), let url = value as? URL {
        let s = sanitizeText(url.absoluteString, textLimit: textLimit)
        return s.isEmpty ? nil : s
    }
    return nil
}

// Summary generation / row 展开 / visibleRows / shouldSkipChild / webAreaDepth
// 均在 TreeRendererSummary.swift（拆分避免单文件 ≤ 300 行超限）。
