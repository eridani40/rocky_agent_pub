import ApplicationServices
import CoreGraphics
import Foundation

@testable import RockyComputerCore

// Block4Tests —— v0.0.160 块 4（Spotlight AppDiscovery + FixtureBridge stub）UT。
//
// 拆自 main.swift 保 main.swift ≤ 300 行硬约束；`expect()` 由 main.swift 定义（同 target 模块作用域可见）。
// 参考: specs/tech/version_logs/v0.0.160/change_plan.md 模块 H + 模块 I
//       app/computer-native/swift/Tests/RockyComputerCoreTestRunner/main.swift（expect + 计数器）

/// 块 4 全量 UT 入口——由 main.swift 结尾统一调用。
func runBlock4Tests() {
    // MARK: - v0.0.160 gap#10: AppDiscovery / ListedAppDescriptor.renderedLine

    // renderedLine 格式：`"<name> — <bundleId> [<flags>]"`（对齐 open-codex :20-36）
    do {
        // 无 flags 情况（不 running / 不 frontmost / 无 lastUsed / 无 uses）
        let entry = ListedAppDescriptor(
            name: "TestApp", bundleIdentifier: "com.example.test",
            isRunning: false, isFrontmost: false, lastUsed: nil, uses: nil
        )
        expect(entry.renderedLine == "TestApp — com.example.test []",
               "renderedLine 空 flags → '<name> — <bundleId> []'")
    }
    do {
        // frontmost + running 双 flag
        let entry = ListedAppDescriptor(
            name: "Safari", bundleIdentifier: "com.apple.Safari",
            isRunning: true, isFrontmost: true, lastUsed: nil, uses: nil
        )
        expect(entry.renderedLine == "Safari — com.apple.Safari [frontmost, running]",
               "renderedLine frontmost + running → 双 flag 拼接")
    }
    do {
        // running + lastUsed + uses（非 frontmost）
        let fixedDate = AppDiscovery.usageDateFormatter.date(from: "2026-07-16")!
        let entry = ListedAppDescriptor(
            name: "Xcode", bundleIdentifier: "com.apple.dt.Xcode",
            isRunning: true, isFrontmost: false, lastUsed: fixedDate, uses: 42
        )
        expect(entry.renderedLine == "Xcode — com.apple.dt.Xcode [running, last-used=2026-07-16, uses=42]",
               "renderedLine running + lastUsed + uses → 三 flag 顺序对齐 open-codex")
    }
    do {
        // 全 4 flag（frontmost + running + lastUsed + uses）
        let fixedDate = AppDiscovery.usageDateFormatter.date(from: "2025-12-01")!
        let entry = ListedAppDescriptor(
            name: "Finder", bundleIdentifier: "com.apple.finder",
            isRunning: true, isFrontmost: true, lastUsed: fixedDate, uses: 100
        )
        expect(entry.renderedLine == "Finder — com.apple.finder [frontmost, running, last-used=2025-12-01, uses=100]",
               "renderedLine 全 4 flag 顺序 = frontmost > running > last-used > uses")
    }

    // MARK: - v0.0.160 gap#10: AppDiscovery.compareListedApps 排序规则

    // 排序规则：frontmost > running > 有 lastUsed > lastUsed 大 > uses 大 > name asc
    do {
        let frontmost = ListedAppDescriptor(name: "A", bundleIdentifier: "a",
            isRunning: true, isFrontmost: true, lastUsed: nil, uses: nil)
        let running = ListedAppDescriptor(name: "B", bundleIdentifier: "b",
            isRunning: true, isFrontmost: false, lastUsed: nil, uses: nil)
        expect(AppDiscovery.compareListedApps(frontmost, running),
               "compareListedApps frontmost 优先 running")
    }
    do {
        let running = ListedAppDescriptor(name: "A", bundleIdentifier: "a",
            isRunning: true, isFrontmost: false, lastUsed: nil, uses: nil)
        let notRunning = ListedAppDescriptor(name: "A", bundleIdentifier: "a",
            isRunning: false, isFrontmost: false, lastUsed: nil, uses: nil)
        expect(AppDiscovery.compareListedApps(running, notRunning),
               "compareListedApps running 优先 non-running")
    }
    do {
        // 都非 running：有 lastUsed 优先无 lastUsed
        let hasLastUsed = ListedAppDescriptor(name: "A", bundleIdentifier: "a",
            isRunning: false, isFrontmost: false, lastUsed: Date(), uses: nil)
        let noLastUsed = ListedAppDescriptor(name: "A", bundleIdentifier: "a",
            isRunning: false, isFrontmost: false, lastUsed: nil, uses: nil)
        expect(AppDiscovery.compareListedApps(hasLastUsed, noLastUsed),
               "compareListedApps 有 lastUsed 优先 无 lastUsed")
    }
    do {
        // 都非 running + 都有 lastUsed：新的 > 旧的
        let newer = ListedAppDescriptor(name: "A", bundleIdentifier: "a",
            isRunning: false, isFrontmost: false,
            lastUsed: AppDiscovery.usageDateFormatter.date(from: "2026-07-16")!, uses: nil)
        let older = ListedAppDescriptor(name: "A", bundleIdentifier: "a",
            isRunning: false, isFrontmost: false,
            lastUsed: AppDiscovery.usageDateFormatter.date(from: "2026-06-01")!, uses: nil)
        expect(AppDiscovery.compareListedApps(newer, older),
               "compareListedApps 新 lastUsed 优先 旧 lastUsed（按 startOfDay 比较）")
    }
    do {
        // 同天 lastUsed → 走 uses 决胜
        let sameDate = AppDiscovery.usageDateFormatter.date(from: "2026-07-16")!
        let moreUses = ListedAppDescriptor(name: "A", bundleIdentifier: "a",
            isRunning: false, isFrontmost: false, lastUsed: sameDate, uses: 50)
        let fewerUses = ListedAppDescriptor(name: "A", bundleIdentifier: "a",
            isRunning: false, isFrontmost: false, lastUsed: sameDate, uses: 10)
        expect(AppDiscovery.compareListedApps(moreUses, fewerUses),
               "compareListedApps 同天 lastUsed → uses 大者优先")
    }
    do {
        // 全平局 → name 字母序（case-insensitive）
        let apple = ListedAppDescriptor(name: "Apple", bundleIdentifier: "a",
            isRunning: false, isFrontmost: false, lastUsed: nil, uses: nil)
        let banana = ListedAppDescriptor(name: "Banana", bundleIdentifier: "b",
            isRunning: false, isFrontmost: false, lastUsed: nil, uses: nil)
        expect(AppDiscovery.compareListedApps(apple, banana),
               "compareListedApps 全平局 → name 字母序（Apple 优先 Banana）")
        // case-insensitive
        let lower = ListedAppDescriptor(name: "apple", bundleIdentifier: "a",
            isRunning: false, isFrontmost: false, lastUsed: nil, uses: nil)
        let upper = ListedAppDescriptor(name: "BANANA", bundleIdentifier: "b",
            isRunning: false, isFrontmost: false, lastUsed: nil, uses: nil)
        expect(AppDiscovery.compareListedApps(lower, upper),
               "compareListedApps name 字母序 case-insensitive")
    }

    // MARK: - v0.0.160 gap#10: AppDiscovery.recentUsageCutoff（14 天窗口）

    do {
        // 参考日 = 2026-07-16 → cutoff = startOfDay(2026-07-16) - 13 天 = 2026-07-03 00:00
        let refDate = AppDiscovery.usageDateFormatter.date(from: "2026-07-16")!
        let cutoff = AppDiscovery.recentUsageCutoff(referenceDate: refDate)
        let cutoffStr = AppDiscovery.usageDateFormatter.string(from: cutoff)
        expect(cutoffStr == "2026-07-03",
               "recentUsageCutoff 参考日 2026-07-16 → cutoff 2026-07-03 (13 天前 startOfDay)")
    }

    // MARK: - v0.0.160 gap#10: SpotlightAppIndex fail-closed

    // SpotlightAppIndex.recentApps 在 CI/无权限/沙盒环境返 [] 不 throw；
    // 本机开发环境可能有真实索引（能返 >0），只校「不 throw / 未来 cutoff 必空」两不变量
    do {
        // 用远古 cutoff 保证结果集空（2200-01-01 之后无任何 macOS app 使用记录）
        let ancientCutoff = AppDiscovery.usageDateFormatter.date(from: "2200-01-01")!
        let records = SpotlightAppIndex.recentApps(cutoffDate: ancientCutoff)
        expect(records.isEmpty,
               "SpotlightAppIndex.recentApps cutoff=未来 2200 → 空数组（无 app 满足未来 cutoff）")
    }
    do {
        // 权限缺失/失败路径由 MDQuery 内部返 [] 处理，此处只校「不崩溃」
        _ = SpotlightAppIndex.recentApps(cutoffDate: Date(timeIntervalSince1970: 0))
        expect(true, "SpotlightAppIndex.recentApps 不抛异常（fail-closed 语义）")
    }

    // MARK: - v0.0.160 gap#12: FixtureBridge Codable + 常量

    // FixtureCommand 序列化 / 反序列化 roundtrip
    do {
        let cmd = FixtureCommand(kind: "click", identifier: "btn-ok", x: 10.5, y: 20.5)
        let data = try! JSONEncoder().encode(cmd)
        let decoded = try! JSONDecoder().decode(FixtureCommand.self, from: data)
        expect(decoded.kind == "click", "FixtureCommand Codable kind roundtrip")
        expect(decoded.identifier == "btn-ok", "FixtureCommand Codable identifier roundtrip")
        expect(decoded.x == 10.5 && decoded.y == 20.5, "FixtureCommand Codable x/y roundtrip")
        expect(decoded.value == nil && decoded.pages == nil, "FixtureCommand 未传字段 → nil")
    }
    // FixtureCommand 全字段
    do {
        let cmd = FixtureCommand(
            kind: "drag", identifier: "obj-a", value: "text",
            x: 1, y: 2, toX: 3, toY: 4, direction: "down", pages: 2.5
        )
        let data = try! JSONEncoder().encode(cmd)
        let decoded = try! JSONDecoder().decode(FixtureCommand.self, from: data)
        expect(decoded.kind == "drag" && decoded.value == "text" && decoded.pages == 2.5,
               "FixtureCommand 全字段 Codable roundtrip")
        expect(decoded.toX == 3 && decoded.toY == 4 && decoded.direction == "down",
               "FixtureCommand 拖拽字段 roundtrip")
    }
    // FixtureRect roundtrip
    do {
        let rect = FixtureRect(rect: CGRect(x: 5, y: 10, width: 100, height: 200))
        let data = try! JSONEncoder().encode(rect)
        let decoded = try! JSONDecoder().decode(FixtureRect.self, from: data)
        expect(decoded.cgRect == CGRect(x: 5, y: 10, width: 100, height: 200),
               "FixtureRect Codable roundtrip cgRect 等价")
    }
    // FixtureAppState 复合结构 roundtrip
    do {
        let state = FixtureAppState(
            windowTitle: "Test Window",
            windowBounds: FixtureRect(rect: CGRect(x: 0, y: 0, width: 800, height: 600)),
            focusedIdentifier: "input-1",
            elements: [
                FixtureElementState(
                    identifier: "el-1", index: 0, role: "AXButton",
                    title: "OK", value: nil, actions: ["AXPress"],
                    frame: FixtureRect(rect: CGRect(x: 10, y: 20, width: 50, height: 30))
                )
            ]
        )
        let data = try! JSONEncoder().encode(state)
        let decoded = try! JSONDecoder().decode(FixtureAppState.self, from: data)
        expect(decoded.windowTitle == "Test Window", "FixtureAppState.windowTitle roundtrip")
        expect(decoded.focusedIdentifier == "input-1", "FixtureAppState.focusedIdentifier roundtrip")
        expect(decoded.elements.count == 1 && decoded.elements[0].identifier == "el-1",
               "FixtureAppState.elements 数组 roundtrip")
    }
    // 常量：Rocky-scoped 命名（不直接采 open-codex `dev.opencodex.opencomputeruse`，改 Rocky 命名空间）
    expect(FixtureBridge.appName == "RockyComputerUseFixture",
           "FixtureBridge.appName == 'RockyComputerUseFixture'")
    expect(FixtureBridge.distributedNotificationName.rawValue == "com.rocky.computer-use.fixture.command",
           "FixtureBridge.distributedNotificationName Rocky-scoped")
    expect(FixtureBridge.stateFileURL.lastPathComponent == "state.json",
           "FixtureBridge.stateFileURL 末尾 state.json")
    expect(FixtureBridge.stateFileURL.path.contains("rocky-computer-use-fixture"),
           "FixtureBridge.stateFileURL 目录 rocky-computer-use-fixture")
    // readState 不存在文件 → nil
    do {
        // stateFileURL 默认不存在（除非某测试预先写过）→ 应返 nil；如已存在则跳过（非稳定断言）
        if !FileManager.default.fileExists(atPath: FixtureBridge.stateFileURL.path) {
            let result = try! FixtureBridge.readState()
            expect(result == nil,
                   "FixtureBridge.readState 文件不存在 → nil")
        } else {
            expect(true, "FixtureBridge.stateFileURL 已存在，跳过 nil 断言（不干扰其他测试）")
        }
    }

    // MARK: - v0.0.160 gap#12: SnapshotMode enum

    expect(SnapshotMode.accessibility != SnapshotMode.fixture,
           "SnapshotMode.accessibility != .fixture (enum case 区分)")
}
