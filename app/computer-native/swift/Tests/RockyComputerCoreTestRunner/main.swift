import ApplicationServices
import CoreGraphics
import Foundation

@testable import RockyComputerCore

// UT runner（executable + 手写 assert，非 XCTest/Testing）。
// 用 executable 因本机 CLT 无 XCTest.framework；`expect()` 累积计数，exit 0/1。
// v0.0.160 块 4 UT 拆到同 target 的 Block4Tests.swift（保 main.swift ≤ 300 行硬约束）。
// 详细规则见: specs/tech/version_logs/v0.0.159/test-plan.md 第 1 节

private var failCount = 0
private var passCount = 0

@inline(never)
func expect(_ cond: Bool, _ msg: String, file: String = #file, line: Int = #line) {
    if cond {
        passCount += 1
    } else {
        failCount += 1
        let f = (file as NSString).lastPathComponent
        FileHandle.standardError.write("FAIL: \(msg) at \(f):\(line)\n".data(using: .utf8) ?? Data())
    }
}

// MARK: - isElectronScopedTarget

// bundle 前缀 `com.electron.` 命中
expect(ClickStrategy.isElectronScopedTarget(bundleId: "com.electron.myapp", appName: nil),
       "isElectronScopedTarget bundlePrefix com.electron.")
// bundle 中间含 `.electron.` 命中
expect(ClickStrategy.isElectronScopedTarget(bundleId: "org.example.electron.myapp", appName: nil),
       "isElectronScopedTarget bundle substring .electron.")
// bundle 含 `lark` 命中
expect(ClickStrategy.isElectronScopedTarget(bundleId: "com.bytedance.larkweb", appName: nil),
       "isElectronScopedTarget bundle contains lark")
// bundle 含 `feishu` 命中
expect(ClickStrategy.isElectronScopedTarget(bundleId: "com.example.feishu", appName: nil),
       "isElectronScopedTarget bundle contains feishu")
// appName == Lark 命中（bundle 匹配失败时兜底）
expect(ClickStrategy.isElectronScopedTarget(bundleId: "com.other.app", appName: "Lark"),
       "isElectronScopedTarget appName Lark")
// appName == FEISHU 命中（大小写归一）
expect(ClickStrategy.isElectronScopedTarget(bundleId: nil, appName: "FEISHU"),
       "isElectronScopedTarget appName FEISHU (case-insensitive)")
// appName == 飞书 命中（中文白名单）
expect(ClickStrategy.isElectronScopedTarget(bundleId: nil, appName: "飞书"),
       "isElectronScopedTarget appName 飞书 (chinese)")
// 双 nil → false
expect(!ClickStrategy.isElectronScopedTarget(bundleId: nil, appName: nil),
       "isElectronScopedTarget both nil returns false")
// 完全不相关 → false（WorkBuddy 场景）
expect(!ClickStrategy.isElectronScopedTarget(bundleId: "com.workbuddy.workbuddy", appName: "WorkBuddy"),
       "isElectronScopedTarget unknown app returns false")
// 大小写混合 + trim 归一
expect(ClickStrategy.isElectronScopedTarget(bundleId: nil, appName: "  LARK  "),
       "isElectronScopedTarget appName '  LARK  ' (trim + lowercase)")
// bundle 大小写混合命中
expect(ClickStrategy.isElectronScopedTarget(bundleId: "COM.ELECTRON.MYAPP", appName: nil),
       "isElectronScopedTarget bundle COM.ELECTRON.MYAPP (lowercased)")

// MARK: - isLikelyContainingRowActionFrame

// 典型 web row 命中
do {
    let target = CGRect(x: 100, y: 200, width: 50, height: 20)
    let candidate = CGRect(x: 50, y: 195, width: 400, height: 30)
    expect(ClickStrategy.isLikelyContainingRowActionFrame(
        targetFrame: target, candidateFrame: candidate, hasPrimaryAction: true
    ), "isLikelyContainingRowActionFrame typical row matches")
}
// hasPrimaryAction=false 直接 false
do {
    let target = CGRect(x: 100, y: 200, width: 50, height: 20)
    let candidate = CGRect(x: 50, y: 195, width: 400, height: 30)
    expect(!ClickStrategy.isLikelyContainingRowActionFrame(
        targetFrame: target, candidateFrame: candidate, hasPrimaryAction: false
    ), "isLikelyContainingRowActionFrame hasPrimaryAction=false → false")
}
// candidate nil → false
do {
    let target = CGRect(x: 100, y: 200, width: 50, height: 20)
    expect(!ClickStrategy.isLikelyContainingRowActionFrame(
        targetFrame: target, candidateFrame: nil, hasPrimaryAction: true
    ), "isLikelyContainingRowActionFrame candidate nil → false")
}
// candidate 不含中心 → false
do {
    let target = CGRect(x: 500, y: 500, width: 50, height: 20)
    let candidate = CGRect(x: 0, y: 0, width: 100, height: 30)
    expect(!ClickStrategy.isLikelyContainingRowActionFrame(
        targetFrame: target, candidateFrame: candidate, hasPrimaryAction: true
    ), "isLikelyContainingRowActionFrame center not contained → false")
}
// candidate width < target width → false
do {
    let target = CGRect(x: 100, y: 200, width: 400, height: 20)
    let candidate = CGRect(x: 105, y: 195, width: 50, height: 30)
    expect(!ClickStrategy.isLikelyContainingRowActionFrame(
        targetFrame: target, candidateFrame: candidate, hasPrimaryAction: true
    ), "isLikelyContainingRowActionFrame width too small → false")
}
// candidate height < target height → false
do {
    let target = CGRect(x: 100, y: 200, width: 50, height: 60)
    let candidate = CGRect(x: 50, y: 210, width: 400, height: 20)
    expect(!ClickStrategy.isLikelyContainingRowActionFrame(
        targetFrame: target, candidateFrame: candidate, hasPrimaryAction: true
    ), "isLikelyContainingRowActionFrame height too small → false")
}
// candidate height 超上限 → false
do {
    let target = CGRect(x: 100, y: 200, width: 50, height: 20)
    // 上限 = max(52, 40) = 52，给 100 远超
    let candidate = CGRect(x: 50, y: 150, width: 400, height: 100)
    expect(!ClickStrategy.isLikelyContainingRowActionFrame(
        targetFrame: target, candidateFrame: candidate, hasPrimaryAction: true
    ), "isLikelyContainingRowActionFrame height too large → false")
}
// -2 inset 边界：candidate 恰好 -2 扩后含 target 中心
do {
    let target = CGRect(x: 100, y: 200, width: 50, height: 20)
    // target 中心 = (125, 210)；candidate 从 (126, 200) → -2 扩后 x=124，含 125
    let candidate = CGRect(x: 126, y: 200, width: 50, height: 20)
    expect(ClickStrategy.isLikelyContainingRowActionFrame(
        targetFrame: target, candidateFrame: candidate, hasPrimaryAction: true
    ), "isLikelyContainingRowActionFrame -2 inset boundary matches")
}
// height 达 target+32 上限
do {
    let target = CGRect(x: 100, y: 200, width: 50, height: 20)
    // 上限 = max(52, 40) = 52
    let candidate = CGRect(x: 50, y: 190, width: 400, height: 52)
    expect(ClickStrategy.isLikelyContainingRowActionFrame(
        targetFrame: target, candidateFrame: candidate, hasPrimaryAction: true
    ), "isLikelyContainingRowActionFrame height at boundary max(target+32) matches")
}

// MARK: - hasPrimaryClickAction

expect(ClickStrategy.hasPrimaryClickAction(rawActions: [kAXPressAction as String]),
       "hasPrimaryClickAction AXPress matches")
expect(ClickStrategy.hasPrimaryClickAction(rawActions: [kAXConfirmAction as String]),
       "hasPrimaryClickAction AXConfirm matches")
expect(ClickStrategy.hasPrimaryClickAction(rawActions: ["AXOpen"]),
       "hasPrimaryClickAction AXOpen matches")
expect(ClickStrategy.hasPrimaryClickAction(rawActions: [kAXShowMenuAction as String]),
       "hasPrimaryClickAction AXShowMenu matches")
// case insensitive
expect(ClickStrategy.hasPrimaryClickAction(rawActions: ["axpress"]),
       "hasPrimaryClickAction case-insensitive axpress")
expect(ClickStrategy.hasPrimaryClickAction(rawActions: ["axopen"]),
       "hasPrimaryClickAction case-insensitive axopen")
// 空 → false
expect(!ClickStrategy.hasPrimaryClickAction(rawActions: []),
       "hasPrimaryClickAction empty → false")
// 只 secondary → false
expect(!ClickStrategy.hasPrimaryClickAction(rawActions: ["AXScrollToVisible", "AXRaise"]),
       "hasPrimaryClickAction only secondary → false")
// primary + secondary → true
expect(ClickStrategy.hasPrimaryClickAction(rawActions: ["AXScrollToVisible", "AXPress", "AXRaise"]),
       "hasPrimaryClickAction mixed matches")

// MARK: - 常量

expect(ClickStrategy.axOpenAction == "AXOpen", "constants axOpenAction == 'AXOpen'")
expect(ClickStrategy.axWebAreaRole == "AXWebArea", "constants axWebAreaRole == 'AXWebArea'")

// MARK: - v0.0.160 gap#9: ComputerUseError.stateUnavailable

do {
    let err = ComputerUseError.stateUnavailable("test message")
    expect(err.code == "state_unavailable",
           "stateUnavailable.code == 'state_unavailable' (对齐 TS ComputerErrorCode)")
    expect(err.text == "test message",
           "stateUnavailable.text = message (透传，对齐 open-codex errorDescription)")
    expect(err.which == nil,
           "stateUnavailable.which == nil (非 permissionMissing)")
}
// 现有 case 未回归
do {
    let err = ComputerUseError.message("plain")
    expect(err.code == "helper_error", "message.code 未变 (回归护栏)")
    expect(err.text == "plain", "message.text 未变")
}

// MARK: - v0.0.160 gap#15: SnapshotTextLimit + parse

expect(SnapshotTextLimit.max.maxCount == nil,
       "SnapshotTextLimit.max.maxCount == nil (无上限 sentinel)")
expect(SnapshotTextLimit.defaults.maxCount == 500,
       "SnapshotTextLimit.defaults.maxCount == 500 (与 v0.0.105 行为兼容)")
expect(SnapshotTextLimit.maxKeyword == "max",
       "SnapshotTextLimit.maxKeyword == 'max' (TS bridge 契约)")

// 显式 init 校验
expect(SnapshotTextLimit(maxCount: 1000).maxCount == 1000,
       "SnapshotTextLimit(maxCount: 1000).maxCount == 1000")

// parse: "max" → .max
expect(SnapshotTextLimit.parse("max").maxCount == nil,
       "SnapshotTextLimit.parse('max') → maxCount nil (.max sentinel)")
// 大小写不敏感
expect(SnapshotTextLimit.parse("MAX").maxCount == nil,
       "SnapshotTextLimit.parse('MAX') → maxCount nil (case-insensitive)")
// trim 白空格
expect(SnapshotTextLimit.parse("  max  ").maxCount == nil,
       "SnapshotTextLimit.parse('  max  ') → maxCount nil (trim)")
// 整数字符串
expect(SnapshotTextLimit.parse("1000").maxCount == 1000,
       "SnapshotTextLimit.parse('1000') → maxCount 1000")
expect(SnapshotTextLimit.parse("500").maxCount == 500,
       "SnapshotTextLimit.parse('500') → maxCount 500")
// 非法输入 → defaults 兜底
expect(SnapshotTextLimit.parse("").maxCount == 500,
       "SnapshotTextLimit.parse('') → defaults(500) (防呆)")
expect(SnapshotTextLimit.parse("abc").maxCount == 500,
       "SnapshotTextLimit.parse('abc') → defaults(500) (非数字兜底)")
expect(SnapshotTextLimit.parse("-1").maxCount == 500,
       "SnapshotTextLimit.parse('-1') → defaults(500) (负数兜底)")
// Equatable 一致性（值语义）
expect(SnapshotTextLimit(maxCount: 100) == SnapshotTextLimit(maxCount: 100),
       "SnapshotTextLimit Equatable 一致")
expect(SnapshotTextLimit.max == SnapshotTextLimit.parse("max"),
       "SnapshotTextLimit.max == parse('max')")

// MARK: - v0.0.160 gap#14 / #17: prettyActionName

expect(AccessibilitySnapshot.prettyActionName("AXPress") == "Press",
       "prettyActionName AXPress → 'Press'")
expect(AccessibilitySnapshot.prettyActionName("AXConfirm") == "Confirm",
       "prettyActionName AXConfirm → 'Confirm'")
expect(AccessibilitySnapshot.prettyActionName("AXOpen") == "Open",
       "prettyActionName AXOpen → 'Open'")
expect(AccessibilitySnapshot.prettyActionName("AXShowMenu") == "Show Menu",
       "prettyActionName AXShowMenu → 'Show Menu' (CamelCase 空格拆)")
expect(AccessibilitySnapshot.prettyActionName("AXRaise") == "Raise",
       "prettyActionName AXRaise → 'Raise'")
expect(AccessibilitySnapshot.prettyActionName("AXScrollDownByPage") == "Scroll Down",
       "prettyActionName AXScrollDownByPage → 'Scroll Down' (ByPage 后缀去掉)")
expect(AccessibilitySnapshot.prettyActionName("AXScrollUpByPage") == "Scroll Up",
       "prettyActionName AXScrollUpByPage → 'Scroll Up'")
// AXZoomWindow 特例（open-codex 特殊处理）
expect(AccessibilitySnapshot.prettyActionName("AXZoomWindow") == "zoom the window",
       "prettyActionName AXZoomWindow → 'zoom the window' (特例)")
// 无 AX 前缀
expect(AccessibilitySnapshot.prettyActionName("CustomAction") == "Custom Action",
       "prettyActionName no-AX-prefix → CamelCase 拆分")

// MARK: - v0.0.160 gap#14: ElementRecord 新字段默认值

// 由于 AXUIElement 无法从 UT 构造真实值，用 AXUIElementCreateSystemWide 拿一个哑元（不做 AX 操作）
do {
    let dummyElem = AXUIElementCreateSystemWide()
    // 三新字段的默认值
    let rec = ElementRecord(
        index: 0, element: dummyElem, role: "AXButton", title: "OK",
        value: nil, screenFrame: nil, actions: [], rawActions: []
        // identifier / isSyntheticText / prettyActions 走默认值
    )
    expect(rec.identifier == nil, "ElementRecord.identifier 默认 nil")
    expect(rec.isSyntheticText == false, "ElementRecord.isSyntheticText 默认 false")
    expect(rec.prettyActions.isEmpty, "ElementRecord.prettyActions 默认空数组")
    // 既有字段回归
    expect(rec.index == 0 && rec.role == "AXButton" && rec.title == "OK",
           "ElementRecord 既有字段未变（回归护栏）")
}
// 显式三新字段构造
do {
    let dummyElem = AXUIElementCreateSystemWide()
    let rec = ElementRecord(
        index: 5, element: dummyElem, role: "AXStaticText", title: nil,
        value: "hello", screenFrame: nil, actions: [], rawActions: ["AXPress"],
        identifier: "my-id", isSyntheticText: true, prettyActions: ["Press"]
    )
    expect(rec.identifier == "my-id", "ElementRecord.identifier 显式 'my-id'")
    expect(rec.isSyntheticText == true, "ElementRecord.isSyntheticText 显式 true")
    expect(rec.prettyActions == ["Press"], "ElementRecord.prettyActions 显式 ['Press']")
}

// MARK: - v0.0.160 gap#6: WindowRecovery 常量存在（recoverVisibleWindow 主流程需真机 AX，仅校常量）

expect(computerUseNoWindowFoundMessage == "Apple event error -10005: cgWindowNotFound",
       "computerUseNoWindowFoundMessage 常量对齐 open-codex Errors.swift:3")

// v0.0.160 块 2 / 块 4 / 块 5 拆分 UT——各 Block*Tests.swift 承载，保 main.swift ≤ 300 行硬约束。
// 同 target 内 .swift 文件由 SwiftPM 自动编译；expect() 定义于 main.swift 模块作用域可见。
runBlock2Tests()  // ClickHitTest / ClickStrategy 3 层 fallback（gap #2 #4 #7 #8）
runBlock3Tests()  // ClickCoordinateHitTest / TypeTextStrategy / matchingAction / integralScrollPageCount（gap #1 #3 #5 #16 #17）
runBlock4Tests()  // AppDiscovery / FixtureBridge stub（gap #10 #12）
runBlock5Tests()  // TreeRenderer 大重写 pure helpers（gap #13）
runBlock6Tests()  // SoftwareCursorOverlay / CursorMotion 纯数学（gap #11）

// MARK: - 汇报

if failCount == 0 {
    print("[UT] all \(passCount) assertions passed")
    exit(0)
} else {
    FileHandle.standardError.write("[UT] \(failCount) FAIL / \(passCount) pass\n".data(using: .utf8) ?? Data())
    exit(1)
}
