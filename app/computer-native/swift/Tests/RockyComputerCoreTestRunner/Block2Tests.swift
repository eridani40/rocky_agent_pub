import ApplicationServices
import CoreGraphics
import Foundation

@testable import RockyComputerCore

// Block2Tests —— v0.0.160 块 2（ClickStrategy 3 层 fallback 扩展 + ClickHitTest）UT。
//
// 拆自 main.swift 保 main.swift ≤ 300 行硬约束；`expect()` 由 main.swift 定义（同 target 模块作用域可见）。
// 参考: specs/tech/version_logs/v0.0.160/change_plan.md 模块 C
//       specs/tech/agent/platform/[P1]computer_native_capability.md §5-§6
//
// 覆盖 4 项 gap（#2 activation-only / #4 descendant + priority + area / #7 synthetic side / #8 list item）。
// AXUIElement 真机行为（AXUIElementSetAttributeValue / AXUIElementIsAttributeSettable / copyParent 遍历）
// 不入 UT（无 mock 途径），依赖 dev dogfood 手验。

/// 块 2 全量 UT 入口——由 main.swift 结尾统一调用。
func runBlock2Tests() {
    // MARK: - v0.0.160 gap#2: canUseActivationOnlyClickFallback

    expect(ClickHitTest.canUseActivationOnlyClickFallback(role: kAXWindowRole as String),
           "canUseActivationOnlyClickFallback AXWindow → true")
    expect(!ClickHitTest.canUseActivationOnlyClickFallback(role: "AXButton"),
           "canUseActivationOnlyClickFallback AXButton → false")
    expect(!ClickHitTest.canUseActivationOnlyClickFallback(role: "AXStaticText"),
           "canUseActivationOnlyClickFallback AXStaticText → false")
    expect(!ClickHitTest.canUseActivationOnlyClickFallback(role: nil),
           "canUseActivationOnlyClickFallback nil → false")

    // MARK: - v0.0.160 gap#4: clickPriority（priority 0 集 vs hasPrimaryClickAction 集）

    // priority 0：primary action set = {AXPress, AXConfirm, AXShowMenu, AXRaise}
    // 注意：与 ClickStrategy.hasPrimaryClickAction（{AXPress,AXConfirm,AXOpen,AXShowMenu}）不同！
    do {
        let dummy = AXUIElementCreateSystemWide()
        let recPress = ElementRecord(index: 0, element: dummy, role: "AXButton",
            title: nil, value: nil, screenFrame: nil, actions: [], rawActions: ["AXPress"])
        let recConfirm = ElementRecord(index: 0, element: dummy, role: "AXButton",
            title: nil, value: nil, screenFrame: nil, actions: [], rawActions: ["AXConfirm"])
        let recShowMenu = ElementRecord(index: 0, element: dummy, role: "AXButton",
            title: nil, value: nil, screenFrame: nil, actions: [], rawActions: ["AXShowMenu"])
        let recRaise = ElementRecord(index: 0, element: dummy, role: "AXButton",
            title: nil, value: nil, screenFrame: nil, actions: [], rawActions: ["AXRaise"])
        let recRaiseLower = ElementRecord(index: 0, element: dummy, role: "AXButton",
            title: nil, value: nil, screenFrame: nil, actions: [], rawActions: ["axraise"])
        expect(ClickHitTest.clickPriority(for: recPress) == 0, "clickPriority AXPress → 0")
        expect(ClickHitTest.clickPriority(for: recConfirm) == 0, "clickPriority AXConfirm → 0")
        expect(ClickHitTest.clickPriority(for: recShowMenu) == 0, "clickPriority AXShowMenu → 0")
        expect(ClickHitTest.clickPriority(for: recRaise) == 0, "clickPriority AXRaise → 0")
        expect(ClickHitTest.clickPriority(for: recRaiseLower) == 0,
               "clickPriority axraise (case-insensitive) → 0")
        // AXOpen 不在 priority-0 集（不同于 hasPrimaryClickAction）
        let recOpen = ElementRecord(index: 0, element: dummy, role: "AXUnknown",
            title: nil, value: nil, screenFrame: nil, actions: [], rawActions: ["AXOpen"])
        expect(ClickHitTest.clickPriority(for: recOpen) != 0,
               "clickPriority AXOpen NOT in priority-0 (open-codex 特殊集合)")
    }

    // MARK: - v0.0.160 gap#4: frameArea

    do {
        let dummy = AXUIElementCreateSystemWide()
        let recNil = ElementRecord(index: 0, element: dummy, role: "AXButton",
            title: nil, value: nil, screenFrame: nil, actions: [], rawActions: [])
        let recFrame = ElementRecord(index: 0, element: dummy, role: "AXButton",
            title: nil, value: nil, screenFrame: CGRect(x: 0, y: 0, width: 100, height: 50),
            actions: [], rawActions: [])
        let recZero = ElementRecord(index: 0, element: dummy, role: "AXButton",
            title: nil, value: nil, screenFrame: CGRect.zero, actions: [], rawActions: [])
        expect(ClickHitTest.frameArea(of: recNil) == .greatestFiniteMagnitude,
               "frameArea nil frame → .greatestFiniteMagnitude")
        expect(ClickHitTest.frameArea(of: recFrame) == 5000,
               "frameArea (100x50) → 5000")
        expect(ClickHitTest.frameArea(of: recZero) == 0,
               "frameArea (0x0) → 0")
    }

    // MARK: - v0.0.160 gap#4: accessibilityLabels 空场景

    expect(ClickHitTest.accessibilityLabels(for: nil).isEmpty,
           "accessibilityLabels nil element → []")

    // MARK: - v0.0.160 gap#7: isLikelySyntheticSideActionCandidate（纯函数，对齐 open-codex L191-235）

    // 双 nil frame → false
    expect(!ClickHitTest.isLikelySyntheticSideActionCandidate(
        parentFrame: nil, candidateFrame: nil, hasPrimaryAction: true, labels: ["done"]
    ), "isLikelySyntheticSideActionCandidate nil frame → false")

    // 判定 B（trailing 类）：trailing + compact + primary + no label → true
    do {
        // parent width=400；trailingBandWidth = min(max(400*0.22, 56), 140) = min(max(88, 56), 140) = 88
        // parent.maxX=400；trailing 起点 = 400 - 88 = 312
        // candidate midX=370 (>=312) trailing；w=40<=max(88, 400*0.18=72)=88 compact；h=30<=max(44, 120)=120 compact
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        let candidate = CGRect(x: 350, y: 10, width: 40, height: 30)
        expect(ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: true, labels: []
        ), "isLikelySyntheticSideActionCandidate trailing+compact+primary → true (判定 B)")
    }

    // 非 trailing + compact + primary + no label → 无路径 → false
    do {
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        let candidate = CGRect(x: 10, y: 10, width: 40, height: 30)  // midX=30 << 312
        expect(!ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: true, labels: []
        ), "isLikelySyntheticSideActionCandidate leading+primary+no-label → false")
    }

    // 判定 A（label 类）：compact + label + primary → true（无论 trailing）
    do {
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        let candidate = CGRect(x: 10, y: 10, width: 40, height: 30)
        expect(ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: true, labels: ["done"]
        ), "isLikelySyntheticSideActionCandidate leading+compact+label+primary → true (判定 A)")
    }

    // label 类：primary=false + 非 trailing → A 不满足（缺 primary），B 不满足（非 trailing）→ false
    do {
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        let candidate = CGRect(x: 10, y: 10, width: 40, height: 30)
        expect(!ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: false, labels: ["done"]
        ), "isLikelySyntheticSideActionCandidate leading+label-only（no primary/trailing）→ false")
    }

    // trailing + label + 非 primary → 判定 B（label 触发）true
    do {
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        let candidate = CGRect(x: 350, y: 10, width: 40, height: 30)
        expect(ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: false, labels: ["archive"]
        ), "isLikelySyntheticSideActionCandidate trailing+compact+label(no primary) → true (判定 B)")
    }

    // trailing + primary + 大 candidate（非 compact，width 超）→ isCompact false → false
    do {
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        // width=200 > max(88, 72)=88 → 不 compact
        let candidate = CGRect(x: 190, y: 10, width: 200, height: 30)
        expect(!ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: true, labels: []
        ), "isLikelySyntheticSideActionCandidate 非 compact → false")
    }

    // label 匹配：'完成' 精确匹配
    do {
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        let candidate = CGRect(x: 10, y: 10, width: 40, height: 30)
        expect(ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: true, labels: ["完成"]
        ), "isLikelySyntheticSideActionCandidate label '完成' → true")
    }

    // label 匹配：'Mark as done'（count=12，含 mark + done）
    do {
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        let candidate = CGRect(x: 10, y: 10, width: 40, height: 30)
        expect(ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: true,
            labels: ["Mark as done"]
        ), "isLikelySyntheticSideActionCandidate label 'Mark as done' → true (mark+done, count<=24)")
    }

    // label 长文本非精确 → 不匹配（count > 24 且不精确 → false）
    do {
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        let candidate = CGRect(x: 10, y: 10, width: 40, height: 30)
        let longLabel = "This is a very long description text that mentions done somewhere in it"
        expect(!ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: true, labels: [longLabel]
        ), "isLikelySyntheticSideActionCandidate 长文本非精确 → false")
    }

    // label 大小写 + trim 归一：'  DONE  ' 归一 = 'done' → 精确匹配
    do {
        let parent = CGRect(x: 0, y: 0, width: 400, height: 100)
        let candidate = CGRect(x: 10, y: 10, width: 40, height: 30)
        expect(ClickHitTest.isLikelySyntheticSideActionCandidate(
            parentFrame: parent, candidateFrame: candidate, hasPrimaryAction: true, labels: ["  DONE  "]
        ), "isLikelySyntheticSideActionCandidate label '  DONE  ' 大小写+trim → true")
    }
}
