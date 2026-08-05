import ApplicationServices
import CoreGraphics
import Foundation

// TypeTextStrategy —— type_text 三段式（v0.0.160 gap#1 逐字对齐 open-codex）。
//
// 编排（Service.type 调 `type(text:pid:)`）：
//   ① focus AX set → `typeTextBySettingFocusedValueIfAvailable`：focused 元素若 kAXValue settable
//      → 拼旧值 baseValue + text → `AXUIElementSetAttributeValue`。成功 sleep 0.1 return（对齐
//      open-codex L584-587）。失败/不可写 → 下一段。
//   ② keyboard fallback 门禁 → `canTypeTextUsingKeyboardFallback`：不通过 throw
//      `.stateUnavailable("type_text requires a focused editable text element ...")`
//      （逐字对齐 open-codex L589-591 报错文案）。
//   ③ keyboard fallback → 现有 `InputSimulation.typeText`（xdotool 系语法 + Unicode 兼容）。
//
// 独立文件避免 ClickStrategy / Service 超 300 行硬约束（架构原则 4）。
//
// 参考: refs/open-codex-computer-use `ComputerUseService.swift:576-595` typeText 主编排
//                                     `:1222-1298` 四 helper
//                                     `:285-305` canUseKeyboardTextFallback 纯函数
//                                     `:1259-1270` humanizedRoleDescription
// 参考文档: specs/tech/version_logs/v0.0.160/change_plan.md 模块 E (E-1..E-6)

enum TypeTextStrategy {
    // MARK: - 主入口（Service.type 调）

    /// 三段式主入口。pid = 目标 app pid（AXUIElementCreateApplication 用），
    /// chunkSize/delayMs = 段 ③ keyboard fallback 分块参数（InputSimulation.typeText 透传）。
    ///
    /// 段 ① 成功 → sleep 0.1 return；段 ② 门禁失败 → throw `.stateUnavailable`；
    /// 段 ③ fallback InputSimulation.typeText。
    static func type(
        text: String,
        pid: pid_t,
        chunkSize: Int = 64,
        delayMs: Int = 12
    ) throws {
        // 段 ①：focus AX set 优先
        let focused = focusedElement(for: pid)
        if try typeTextBySettingFocusedValueIfAvailable(text, in: focused) {
            Thread.sleep(forTimeInterval: 0.1)
            return
        }
        // 段 ②：keyboard fallback 门禁
        guard try canTypeTextUsingKeyboardFallback(in: focused) else {
            throw ComputerUseError.stateUnavailable(
                "type_text requires a focused editable text element. Click a text entry area first, or use set_value on a settable text element."
            )
        }
        // 段 ③：keyboard fallback（既有 xdotool 系）
        try InputSimulation.typeText(text, chunkSize: chunkSize, delayMs: delayMs, pid: pid)
    }

    /// 取 pid 对应 app 的 focused UI element（`AXUIElementCreateApplication` +
    /// `kAXFocusedUIElementAttribute`）。API 失败 / nil 返 nil，交由下游 fallback。
    static func focusedElement(for pid: pid_t) -> AXUIElement? {
        guard pid > 0 else { return nil }
        let app = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &value) == .success,
              let v = value else { return nil }
        if CFGetTypeID(v) == AXUIElementGetTypeID() {
            // swiftlint:disable:next force_cast
            return (v as! AXUIElement)
        }
        return nil
    }

    // MARK: - 段 ① AX set value（对齐 open-codex L1222-1241）

    /// focused 元素 kAXValue 可写 → 拼旧值 baseValue + text → set → 成功 true / 容忍失败 false / 未知 throw。
    static func typeTextBySettingFocusedValueIfAvailable(_ text: String, in focused: AXUIElement?) throws -> Bool {
        guard let element = focused else { return false }
        guard try isSettableForSetValue(element: element, attribute: kAXValueAttribute as String) else {
            return false
        }
        let baseValue = editableBaseValue(for: element)
        let result = AXUIElementSetAttributeValue(
            element, kAXValueAttribute as CFString, (baseValue + text) as CFString
        )
        switch result {
        case .success:
            return true
        case .failure, .attributeUnsupported, .actionUnsupported, .cannotComplete,
             .noValue, .invalidUIElement, .illegalArgument:
            return false
        default:
            throw ComputerUseError.message("AXUIElementSetAttributeValue failed with \(result.rawValue)")
        }
    }

    // MARK: - 段 ② keyboard fallback 门禁（对齐 open-codex L1243-1257 + L285-305）

    /// focused 元素 role/roleDescription/valueSettable 组合判定 keyboard fallback 是否可用。
    /// focused nil → false（无 focus 直接拒绝）。
    static func canTypeTextUsingKeyboardFallback(in focused: AXUIElement?) throws -> Bool {
        guard let element = focused else { return false }
        let role = AccessibilitySnapshot.stringAttr(element, kAXRoleAttribute)
        let roleDescription: String? = role.flatMap { r in
            AccessibilitySnapshot.stringAttr(element, kAXRoleDescriptionAttribute)
                ?? humanizedRoleDescription(for: r)
        }
        return canUseKeyboardTextFallback(
            role: role,
            roleDescription: roleDescription,
            isValueSettable: try isSettableForSetValue(element: element, attribute: kAXValueAttribute as String)
        )
    }

    /// 纯函数（供 UT 覆盖，对齐 open-codex L285-305）：
    /// - valueSettable=true → true
    /// - role ∈ {AXTextField, AXTextArea, AXTextView} → true
    /// - roleDescription lowercased 含 "text field" / "text area" / "text entry" → true
    /// - 其余 → false
    static func canUseKeyboardTextFallback(role: String?, roleDescription: String?, isValueSettable: Bool) -> Bool {
        if isValueSettable { return true }
        guard let role else { return false }
        if role == (kAXTextFieldRole as String) || role == "AXTextArea" || role == "AXTextView" {
            return true
        }
        guard let roleDescription = roleDescription?.lowercased() else { return false }
        return roleDescription.contains("text field")
            || roleDescription.contains("text area")
            || roleDescription.contains("text entry")
    }

    /// AXTextField / AXTextArea / AXTextView 三 role 的 fallback 描述文案（对齐 open-codex L1259-1270）。
    /// 其他 role → 空串。
    static func humanizedRoleDescription(for role: String) -> String {
        if role == (kAXTextFieldRole as String) { return "text field" }
        switch role {
        case "AXTextArea", "AXTextView":
            return "text entry area"
        default:
            return ""
        }
    }

    // MARK: - 段 ① baseValue 拼接（对齐 open-codex L1272-1298）

    /// 优先递归找子 AXStaticText.value 过滤 placeholder → 非空 joined；
    /// 否则读 focused element 自身 kAXValue（trim 零宽 + placeholder 过滤后）。
    /// 归空 → return ""（新值全用 text 覆盖）。
    static func editableBaseValue(for element: AXUIElement) -> String {
        let childTextValues = editableDescendantTextValues(in: element).filter { !looksLikeEditablePlaceholder($0) }
        if !childTextValues.isEmpty {
            return childTextValues.joined()
        }
        guard let currentValue = AccessibilitySnapshot.stringAttr(element, kAXValueAttribute as String) else {
            return ""
        }
        let normalizedValue = normalizeEditablePlaceholderText(currentValue)
        if normalizedValue.isEmpty || looksLikeEditablePlaceholder(normalizedValue) {
            return ""
        }
        // 若 focused element 的 value 恰好等于 AXPlaceholderValue / AXPlaceholder（另存的占位）→ return ""
        for attribute in ["AXPlaceholderValue", "AXPlaceholder"] {
            guard let placeholder = AccessibilitySnapshot.stringAttr(element, attribute) else { continue }
            if normalizedValue == normalizeEditablePlaceholderText(placeholder) {
                return ""
            }
        }
        return currentValue
    }

    /// 递归 4 层向下找 AXStaticText.value/title（对齐 open-codex L1301-1322），过滤零宽/空白/占位。
    static func editableDescendantTextValues(in element: AXUIElement, depth: Int = 0) -> [String] {
        guard depth < 4 else { return [] }
        var values: [String] = []
        for child in AccessibilitySnapshot.childrenOf(element) {
            if AccessibilitySnapshot.stringAttr(child, kAXRoleAttribute) == (kAXStaticTextRole as String),
               let raw = AccessibilitySnapshot.stringAttr(child, kAXValueAttribute as String)
                    ?? AccessibilitySnapshot.stringAttr(child, kAXTitleAttribute as String)
            {
                let normalized = normalizeEditablePlaceholderText(raw)
                if !normalized.isEmpty { values.append(normalized) }
            }
            values.append(contentsOf: editableDescendantTextValues(in: child, depth: depth + 1))
        }
        return values
    }

    /// Lark 场景 known-good 占位识别（对齐 open-codex L1324-1327）。
    static func looksLikeEditablePlaceholder(_ value: String) -> Bool {
        let normalized = normalizeEditablePlaceholderText(value)
        return normalized == "沟通时请保持“公开可接受”"
    }

    /// 去零宽 U+200B + trim 空白（对齐 open-codex L1329-1333）。
    static func normalizeEditablePlaceholderText(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\u{200B}", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - AX 属性 settable 判定（isSettableForSetValue —— throwing 版）

    /// `AXUIElementIsAttributeSettable` 包装，API 调用失败 throw `.message`（对齐 open-codex L960-968）。
    /// 与 ClickHitTest.isAttributeSettable（返 false 即静默）的差异：本版本要 throw，为 typeTextBy... 提供
    /// 「查询本身失败 vs 查询到不可写」的区分（前者上抛让上层决定，后者语义上等价「无法 AX set」）。
    static func isSettableForSetValue(element: AXUIElement, attribute: String) throws -> Bool {
        var settable = DarwinBoolean(false)
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        guard result == .success else {
            throw ComputerUseError.message("AXUIElementIsAttributeSettable(\(attribute)) failed with \(result.rawValue)")
        }
        return settable.boolValue
    }
}
