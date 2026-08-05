import CoreGraphics
import Foundation

// FixtureBridge —— fixture app 与 Service 之间的桥接层（本版本 P1 方案 A：只落 bridge，fixture app 推迟）。
//
// 用途（未来 fixture app 落地后启用）：
//   - fixture app 通过 writeState 写「模拟 AX 树」到 /tmp/.../state.json
//   - Service.readAxTree/getAppState 在 mode == .fixture 时改读 state.json（跳过真 AX）
//   - Service.click/type/... 通过 post(FixtureCommand) 发 DistributedNotification 给 fixture app
//   - fixture app 收到通知后模拟 UI 响应 + writeState 回执 → 端到端确定性 XCTest
//
// 现状（v0.0.160 落地）：
//   - Codable structs + readState/writeState/post 全部实装（依赖仅 Foundation + CoreGraphics，CLT 可编）
//   - Service 各 action 加 `if snap.mode == .fixture { /* TODO fixture 分支 */ }` 占位注释
//   - fixture mode 未激活（AccessibilitySnapshot.build 默认 mode = .accessibility），透明落既有 accessibility 路径
//
// 参考: refs/open-codex-computer-use `FixtureBridge.swift`（139 行逐字对齐）
//       specs/tech/version_logs/v0.0.160/change_plan.md 模块 I（I-1 ~ I-4）

/// fixture app 里一个 rect 的 Codable 表示（对齐 open-codex）
public struct FixtureRect: Codable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(rect: CGRect) {
        x = rect.origin.x
        y = rect.origin.y
        width = rect.width
        height = rect.height
    }

    public var cgRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

/// fixture app 里一个 element 的状态快照（供 Service 读取，等价 AX element）
public struct FixtureElementState: Codable, Sendable {
    public let identifier: String
    public let index: Int
    public let role: String
    public let title: String?
    public let value: String?
    public let actions: [String]
    public let frame: FixtureRect

    public init(identifier: String, index: Int, role: String, title: String?, value: String?, actions: [String], frame: FixtureRect) {
        self.identifier = identifier
        self.index = index
        self.role = role
        self.title = title
        self.value = value
        self.actions = actions
        self.frame = frame
    }
}

/// fixture app 主状态（对齐 open-codex `FixtureAppState`）
public struct FixtureAppState: Codable, Sendable {
    public let windowTitle: String
    public let windowBounds: FixtureRect
    public let focusedIdentifier: String?
    public let elements: [FixtureElementState]

    public init(windowTitle: String, windowBounds: FixtureRect, focusedIdentifier: String?, elements: [FixtureElementState]) {
        self.windowTitle = windowTitle
        self.windowBounds = windowBounds
        self.focusedIdentifier = focusedIdentifier
        self.elements = elements
    }
}

/// Service → fixture app 的命令（click/type/scroll 抽象成统一格式，字段 all-optional 按 kind 消费）
public struct FixtureCommand: Codable, Sendable {
    public let kind: String
    public let identifier: String
    public let value: String?
    public let x: Double?
    public let y: Double?
    public let toX: Double?
    public let toY: Double?
    public let direction: String?
    public let pages: Double?

    public init(
        kind: String,
        identifier: String,
        value: String? = nil,
        x: Double? = nil,
        y: Double? = nil,
        toX: Double? = nil,
        toY: Double? = nil,
        direction: String? = nil,
        pages: Double? = nil
    ) {
        self.kind = kind
        self.identifier = identifier
        self.value = value
        self.x = x
        self.y = y
        self.toX = toX
        self.toY = toY
        self.direction = direction
        self.pages = pages
    }
}

/// fixture bridge 命名空间（无实例状态；文件 IO + DistributedNotificationCenter 静态方法）
public enum FixtureBridge {
    /// fixture app 名称（AppDiscovery.isUserFacingListApp 用；虽然 v0.0.160 fixture app 未落地，
    /// AppDiscovery 走 `NSRunningApplication.activationPolicy == .regular` 判定，此常量为占位便于未来接入）
    public static let appName = "RockyComputerUseFixture"

    /// fixture app 与 Service 之间的 DistributedNotification 通道名
    public static let distributedNotificationName = Notification.Name("com.rocky.computer-use.fixture.command")

    /// state.json 落地位置：`$TMPDIR/rocky-computer-use-fixture/state.json`
    /// 对齐 open-codex：走 NSTemporaryDirectory 避免用户 Library 权限依赖
    public static var stateFileURL: URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("rocky-computer-use-fixture", isDirectory: true)
            .appendingPathComponent("state.json")
    }

    /// 读取 fixture app 写入的最新状态；文件不存在返 nil；
    /// 读取失败（json 半写等）5 次重试 sleep 0.05s，仍失败 throw。
    ///
    /// - Returns: 反序列化的 FixtureAppState；文件不存在 → nil
    /// - Throws: 反序列化最终失败时 throw
    public static func readState() throws -> FixtureAppState? {
        let url = stateFileURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }

        var lastError: Error?

        for attempt in 0..<5 {
            do {
                let data = try Data(contentsOf: url)
                return try JSONDecoder().decode(FixtureAppState.self, from: data)
            } catch {
                lastError = error
                if attempt < 4 {
                    Thread.sleep(forTimeInterval: 0.05)
                }
            }
        }

        throw lastError ?? ComputerUseError.message("Failed to read fixture state")
    }

    /// fixture app 写状态入口（fixture app 内部调用；Service 只读不写）。
    /// 走 `.atomic` 原子写（避免读方看到半写文件）。
    public static func writeState(_ state: FixtureAppState) throws {
        let directory = stateFileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(state)
        try data.write(to: stateFileURL, options: .atomic)
    }

    /// Service → fixture app：发 DistributedNotification（跨进程即时投递）。
    /// payload = FixtureCommand JSON 序列化后放 userInfo["payload"]（Notification 只带 String 稳）。
    public static func post(_ command: FixtureCommand) throws {
        let payload = try String(data: JSONEncoder().encode(command), encoding: .utf8)
        DistributedNotificationCenter.default().postNotificationName(
            distributedNotificationName,
            object: nil,
            userInfo: payload.map { ["payload": $0] },
            options: .deliverImmediately
        )
    }
}
