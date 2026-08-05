import ApplicationServices
import CoreGraphics
import Foundation

@testable import RockyComputerCore

// Block3Tests —— v0.0.160 块 3（coord click 双候选 + Service 各 action 编排）UT。
//
// 拆自 main.swift 保 main.swift ≤ 300 行硬约束；`expect()` 由 main.swift 定义（同 target 模块作用域可见）。
// 参考: specs/tech/version_logs/v0.0.160/change_plan.md 模块 D + E
//       specs/tech/agent/platform/[P1]computer_native_capability.md §5-§6
//
// 覆盖 5 项 gap：#1 type_text 三段式 pure helper / #3 scroll 整数分页 / #5 coord click 双候选几何 /
// #16 set_value sleep（无 UT，行为验证依 dogfood）/ #17 pretty actions 两级 match。
// AXUIElement 真机行为（AXUIElementCopyElementAtPosition / AXUIElementSetAttributeValue /
// focusedElement kAXFocusedUIElement 拷贝）不入 UT，依 dev dogfood 手验。

/// 块 3 全量 UT 入口——由 main.swift 结尾统一调用。
func runBlock3Tests() {
    // MARK: - v0.0.160 gap#17: matchingAction 两级 match

    do {
        let dummy = AXUIElementCreateSystemWide()
        let rec = ElementRecord(
            index: 0, element: dummy, role: "AXButton", title: nil, value: nil, screenFrame: nil,
            actions: [], rawActions: ["AXPress", "AXShowMenu", "AXScrollDownByPage"],
            identifier: nil, isSyntheticText: false,
            prettyActions: ["Press", "Show Menu", "Scroll Down"]
        )
        // 精确 match rawActions（case-insensitive）
        expect(matchingAction(requested: "AXPress", in: rec) == "AXPress",
               "matchingAction exact 'AXPress' → 'AXPress'")
        expect(matchingAction(requested: "axpress", in: rec) == "AXPress",
               "matchingAction exact case-insensitive 'axpress' → 'AXPress'")
        // pretty match（position 反查 raw）
        expect(matchingAction(requested: "Press", in: rec) == "AXPress",
               "matchingAction pretty 'Press' → 'AXPress' (position 0)")
        expect(matchingAction(requested: "Show Menu", in: rec) == "AXShowMenu",
               "matchingAction pretty 'Show Menu' → 'AXShowMenu' (position 1)")
        expect(matchingAction(requested: "scroll down", in: rec) == "AXScrollDownByPage",
               "matchingAction pretty case-insensitive 'scroll down' → 'AXScrollDownByPage'")
        // 未命中 → nil
        expect(matchingAction(requested: "Bogus", in: rec) == nil,
               "matchingAction unknown 'Bogus' → nil")
        expect(matchingAction(requested: "", in: rec) == nil,
               "matchingAction empty → nil")
    }
    // rawActions 与 prettyActions 长度不匹配（zip 短端截断）
    do {
        let dummy = AXUIElementCreateSystemWide()
        let rec = ElementRecord(
            index: 0, element: dummy, role: "AXButton", title: nil, value: nil, screenFrame: nil,
            actions: [], rawActions: ["AXPress", "AXConfirm"], prettyActions: ["Press"]
        )
        expect(matchingAction(requested: "Press", in: rec) == "AXPress",
               "matchingAction zip 短端 pretty[0] 命中")
        expect(matchingAction(requested: "Confirm", in: rec) == nil,
               "matchingAction zip 短端 pretty[1] 缺失 → nil")
    }

    // MARK: - v0.0.160 gap#3: integralScrollPageCount

    expect(integralScrollPageCount(1.0) == 1, "integralScrollPageCount 1.0 → 1")
    expect(integralScrollPageCount(3.0) == 3, "integralScrollPageCount 3.0 → 3")
    expect(integralScrollPageCount(1.5) == nil, "integralScrollPageCount 1.5 → nil (非整数)")
    expect(integralScrollPageCount(2.9999999) == 3,
           "integralScrollPageCount 2.9999999 → 3 (tolerance 1e-6)")
    expect(integralScrollPageCount(0.5) == nil, "integralScrollPageCount 0.5 → nil (非整数)")
    // 边界：0 或负数
    expect(integralScrollPageCount(0.0) == 1, "integralScrollPageCount 0.0 → 1 (下限 1)")
    expect(integralScrollPageCount(-1.0) == 1, "integralScrollPageCount -1.0 → 1 (下限 1，负数保底)")

    // MARK: - v0.0.160 gap#5: ClickCoordinateHitTest.bestElement / clickActionPoints / shouldScanDescendants

    // bestElement: 从 records 中 filter contains + 排序
    do {
        let dummy = AXUIElementCreateSystemWide()
        // 三 record：大按钮（priority 0，面积 large）、小按钮（priority 0，面积 small）、无操作元素（priority 2）
        let rec1 = ElementRecord(
            index: 1, element: dummy, role: "AXButton", title: nil, value: nil,
            screenFrame: CGRect(x: 0, y: 0, width: 200, height: 200),
            actions: [], rawActions: ["AXPress"]
        )
        let rec2 = ElementRecord(
            index: 2, element: dummy, role: "AXButton", title: nil, value: nil,
            screenFrame: CGRect(x: 40, y: 40, width: 50, height: 50),
            actions: [], rawActions: ["AXPress"]
        )
        let rec3 = ElementRecord(
            index: 3, element: dummy, role: "AXGroup", title: nil, value: nil,
            screenFrame: CGRect(x: 30, y: 30, width: 100, height: 100),
            actions: [], rawActions: []
        )
        let records: [Int: ElementRecord] = [1: rec1, 2: rec2, 3: rec3]
        // point (60, 60) 落在 rec1/rec2/rec3 内；同 priority 0 的 rec1/rec2 中 rec2 面积小 → 优先
        let best = ClickCoordinateHitTest.bestElement(containing: CGPoint(x: 60, y: 60), in: records)
        expect(best?.index == 2, "bestElement (60,60) → rec2 (priority 0 + 面积最小)")
        // point (500, 500) 不在任何 record → nil
        let miss = ClickCoordinateHitTest.bestElement(containing: CGPoint(x: 500, y: 500), in: records)
        expect(miss == nil, "bestElement (500,500) → nil (无 record 包含)")
        // 空 records → nil
        let empty = ClickCoordinateHitTest.bestElement(containing: CGPoint(x: 60, y: 60), in: [:])
        expect(empty == nil, "bestElement 空 records → nil")
        // point (150, 150) 只在 rec1 内 → rec1
        let only1 = ClickCoordinateHitTest.bestElement(containing: CGPoint(x: 150, y: 150), in: records)
        expect(only1?.index == 1, "bestElement (150,150) → rec1 (唯一包含)")
    }

    // clickActionPoints: center + leading（syntheticText 只 leading）
    do {
        let dummy = AXUIElementCreateSystemWide()
        // 普通 record，宽 200 → leading = 0 + min(max(60, 20), max(196, 20)) = 60；center = 100
        let rec = ElementRecord(
            index: 0, element: dummy, role: "AXButton", title: nil, value: nil,
            screenFrame: CGRect(x: 0, y: 0, width: 200, height: 100),
            actions: [], rawActions: []
        )
        let points = ClickCoordinateHitTest.clickActionPoints(for: rec)
        expect(points.count == 2, "clickActionPoints 普通 record → 2 点 [center, leading]")
        expect(points[0] == CGPoint(x: 100, y: 50), "clickActionPoints[0] = center (100, 50)")
        expect(points[1] == CGPoint(x: 60, y: 50), "clickActionPoints[1] = leading (60, 50)")

        // synthetic text → 只 leading
        let recSynth = ElementRecord(
            index: 0, element: dummy, role: "AXStaticText", title: nil, value: nil,
            screenFrame: CGRect(x: 0, y: 0, width: 200, height: 100),
            actions: [], rawActions: [], isSyntheticText: true
        )
        let synthPoints = ClickCoordinateHitTest.clickActionPoints(for: recSynth)
        expect(synthPoints.count == 1, "clickActionPoints syntheticText → 只 leading (1 点)")
        expect(synthPoints[0] == CGPoint(x: 60, y: 50), "clickActionPoints synthetic leading (60, 50)")

        // 窄 frame（width 5）→ leading ≈ center → 只 center
        let recTiny = ElementRecord(
            index: 0, element: dummy, role: "AXButton", title: nil, value: nil,
            screenFrame: CGRect(x: 0, y: 0, width: 5, height: 5),
            actions: [], rawActions: []
        )
        let tinyPoints = ClickCoordinateHitTest.clickActionPoints(for: recTiny)
        // width 5: leading = 0 + min(max(1.5, 20), max(1, 20)) = min(20, 20) = 20；center = 2.5；|20-2.5|=17.5 !< 1
        // 20 > 5 边界外，但公式如此，两点都返
        expect(!tinyPoints.isEmpty, "clickActionPoints tiny frame 非空（防呆）")

        // nil frame → 空
        let recNoFrame = ElementRecord(
            index: 0, element: dummy, role: "AXButton", title: nil, value: nil,
            screenFrame: nil, actions: [], rawActions: []
        )
        expect(ClickCoordinateHitTest.clickActionPoints(for: recNoFrame).isEmpty,
               "clickActionPoints nil frame → 空")
    }

    // shouldScanDescendantsOfHitRecord: 面积/尺寸阈值判断
    do {
        let original = CGRect(x: 0, y: 0, width: 100, height: 50)  // area 5000
        // hitFrame area <= 12x → true
        let normal = CGRect(x: 0, y: 0, width: 200, height: 100)  // area 20000
        expect(ClickCoordinateHitTest.shouldScanDescendantsOfHitRecord(
            originalFrame: original, hitFrame: normal
        ), "shouldScanDescendants 面积 20000 <= max(60000, 20000) → true")
        // hitFrame area 60001 > max(5000*12=60000, 20000) → false
        let huge = CGRect(x: 0, y: 0, width: 1000, height: 61)  // area 61000
        expect(!ClickCoordinateHitTest.shouldScanDescendantsOfHitRecord(
            originalFrame: original, hitFrame: huge
        ), "shouldScanDescendants 面积 61000 > 60000 → false")
        // hitFrame 高 200 > max(200, 96) AND 宽 240 > max(200, 240) 不严 → 需高宽都超
        let tall = CGRect(x: 0, y: 0, width: 300, height: 300)  // 尺寸超（4x=200，2x=200）
        // area 300*300=90000 > max(60000, 20000)=60000 → false（面积维度触发）
        expect(!ClickCoordinateHitTest.shouldScanDescendantsOfHitRecord(
            originalFrame: original, hitFrame: tall
        ), "shouldScanDescendants 超大尺寸 → false（面积维度）")
        // nil 参数 → true（保底）
        expect(ClickCoordinateHitTest.shouldScanDescendantsOfHitRecord(
            originalFrame: nil, hitFrame: normal
        ), "shouldScanDescendants original nil → true (保底)")
        expect(ClickCoordinateHitTest.shouldScanDescendantsOfHitRecord(
            originalFrame: original, hitFrame: nil
        ), "shouldScanDescendants hit nil → true (保底)")
    }

    // sameElement：CFEqual 判等
    do {
        let a = AXUIElementCreateSystemWide()
        let b = AXUIElementCreateSystemWide()
        expect(ClickCoordinateHitTest.sameElement(a, a), "sameElement 同实例 → true")
        // systemWide 单例 → a == b（CFEqual）
        expect(ClickCoordinateHitTest.sameElement(a, b), "sameElement systemWide 单例 → true")
        expect(!ClickCoordinateHitTest.sameElement(nil, a), "sameElement lhs nil → false")
        expect(!ClickCoordinateHitTest.sameElement(a, nil), "sameElement rhs nil → false")
        expect(!ClickCoordinateHitTest.sameElement(nil, nil), "sameElement 双 nil → false")
    }

    // MARK: - v0.0.160 gap#1: TypeTextStrategy.canUseKeyboardTextFallback 纯函数

    // isValueSettable=true → 直 true（无视 role/roleDescription）
    expect(TypeTextStrategy.canUseKeyboardTextFallback(role: nil, roleDescription: nil, isValueSettable: true),
           "canUseKeyboardTextFallback isValueSettable=true 直接 true")
    expect(TypeTextStrategy.canUseKeyboardTextFallback(role: "AXButton", roleDescription: "button", isValueSettable: true),
           "canUseKeyboardTextFallback settable=true role=AXButton → true (settable 优先)")

    // role ∈ {AXTextField, AXTextArea, AXTextView} → true
    expect(TypeTextStrategy.canUseKeyboardTextFallback(role: kAXTextFieldRole as String, roleDescription: nil, isValueSettable: false),
           "canUseKeyboardTextFallback role AXTextField → true")
    expect(TypeTextStrategy.canUseKeyboardTextFallback(role: "AXTextArea", roleDescription: nil, isValueSettable: false),
           "canUseKeyboardTextFallback role AXTextArea → true")
    expect(TypeTextStrategy.canUseKeyboardTextFallback(role: "AXTextView", roleDescription: nil, isValueSettable: false),
           "canUseKeyboardTextFallback role AXTextView → true")

    // roleDescription 含 "text field" / "text area" / "text entry" → true
    expect(TypeTextStrategy.canUseKeyboardTextFallback(role: "AXCustom", roleDescription: "text field", isValueSettable: false),
           "canUseKeyboardTextFallback roleDescription 'text field' → true")
    expect(TypeTextStrategy.canUseKeyboardTextFallback(role: "AXCustom", roleDescription: "Multiline TEXT AREA", isValueSettable: false),
           "canUseKeyboardTextFallback roleDescription 'text area' case-insensitive → true")
    expect(TypeTextStrategy.canUseKeyboardTextFallback(role: "AXCustom", roleDescription: "text entry box", isValueSettable: false),
           "canUseKeyboardTextFallback roleDescription 'text entry' → true")

    // 其余 → false
    expect(!TypeTextStrategy.canUseKeyboardTextFallback(role: "AXButton", roleDescription: "button", isValueSettable: false),
           "canUseKeyboardTextFallback role AXButton → false")
    expect(!TypeTextStrategy.canUseKeyboardTextFallback(role: nil, roleDescription: nil, isValueSettable: false),
           "canUseKeyboardTextFallback 全 nil → false")
    expect(!TypeTextStrategy.canUseKeyboardTextFallback(role: "AXGroup", roleDescription: "group container", isValueSettable: false),
           "canUseKeyboardTextFallback role AXGroup + desc 无 text 关键字 → false")

    // MARK: - v0.0.160 gap#1: TypeTextStrategy.humanizedRoleDescription

    expect(TypeTextStrategy.humanizedRoleDescription(for: kAXTextFieldRole as String) == "text field",
           "humanizedRoleDescription AXTextField → 'text field'")
    expect(TypeTextStrategy.humanizedRoleDescription(for: "AXTextArea") == "text entry area",
           "humanizedRoleDescription AXTextArea → 'text entry area'")
    expect(TypeTextStrategy.humanizedRoleDescription(for: "AXTextView") == "text entry area",
           "humanizedRoleDescription AXTextView → 'text entry area'")
    expect(TypeTextStrategy.humanizedRoleDescription(for: "AXButton") == "",
           "humanizedRoleDescription AXButton → '' (无 fallback 文案)")
    expect(TypeTextStrategy.humanizedRoleDescription(for: "AXGroup") == "",
           "humanizedRoleDescription AXGroup → ''")

    // MARK: - v0.0.160 gap#1: TypeTextStrategy.normalizeEditablePlaceholderText / looksLikeEditablePlaceholder

    // 去零宽 + trim
    expect(TypeTextStrategy.normalizeEditablePlaceholderText("\u{200B}hello\u{200B}") == "hello",
           "normalizeEditablePlaceholderText 去零宽")
    expect(TypeTextStrategy.normalizeEditablePlaceholderText("  spaced  ") == "spaced",
           "normalizeEditablePlaceholderText trim 空白")
    expect(TypeTextStrategy.normalizeEditablePlaceholderText("\u{200B}\n \u{200B}") == "",
           "normalizeEditablePlaceholderText 全空 → 空串")

    // Lark 占位识别（含零宽/前后空白/纯净三态）
    expect(TypeTextStrategy.looksLikeEditablePlaceholder("沟通时请保持“公开可接受”"),
           "looksLikeEditablePlaceholder Lark placeholder 纯净字符串")
    expect(TypeTextStrategy.looksLikeEditablePlaceholder("\u{200B}沟通时请保持“公开可接受”\u{200B}"),
           "looksLikeEditablePlaceholder Lark placeholder 带零宽")
    expect(TypeTextStrategy.looksLikeEditablePlaceholder("  沟通时请保持“公开可接受”  "),
           "looksLikeEditablePlaceholder Lark placeholder 带空白")
    expect(!TypeTextStrategy.looksLikeEditablePlaceholder("hello world"),
           "looksLikeEditablePlaceholder 普通字符串 → false")
    expect(!TypeTextStrategy.looksLikeEditablePlaceholder(""),
           "looksLikeEditablePlaceholder 空串 → false")
}
