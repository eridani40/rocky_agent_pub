import AppKit
import CoreServices
import Foundation

// AppDiscovery —— list_apps 主入口。合并「运行中 app」+「Spotlight 最近使用过的非运行 app」+ 排序 + 渲染。
//
// 排序规则（逐字对齐 open-codex `compareListedApps` :222-251）：
//   1. frontmost（前台）优先
//   2. running（运行中）优先
//   3. 有 lastUsed 的优先
//   4. lastUsed 按 startOfDay 比较（同一天平局走下一层）
//   5. uses 大的优先
//   6. name 字母序（case-insensitive）
//
// 输出格式（renderedLine，逐字对齐 open-codex :20-36）：
//   "<name> — <bundleId> [<flag1>, <flag2>, ...]"
//   flags = frontmost | running | last-used=YYYY-MM-DD | uses=<n>
//
// 非运行 app 上限 10 条（`maxRecentNonRunningApps`，对齐 open-codex :55）——防 LLM 视野爆炸。
//
// 参考: refs/open-codex-computer-use `AppDiscovery.swift`
//       specs/tech/version_logs/v0.0.160/change_plan.md 模块 H（H-1, H-2, H-4）

/// list_apps 里一条 app 记录（对齐 open-codex `ListedAppDescriptor`）
struct ListedAppDescriptor {
    let name: String
    let bundleIdentifier: String
    let isRunning: Bool
    let isFrontmost: Bool
    let lastUsed: Date?
    let uses: Int?

    /// 单行渲染：`"<name> — <bundleId> [frontmost, running, last-used=YYYY-MM-DD, uses=N]"`
    /// 逐字对齐 open-codex `renderedLine`（:20-36）
    var renderedLine: String {
        var markers: [String] = []
        if isFrontmost {
            markers.append("frontmost")
        }
        if isRunning {
            markers.append("running")
        }
        if let lastUsed {
            markers.append("last-used=\(AppDiscovery.usageDateFormatter.string(from: lastUsed))")
        }
        if let uses {
            markers.append("uses=\(uses)")
        }

        return "\(name) — \(bundleIdentifier) [\(markers.joined(separator: ", "))]"
    }
}

/// 运行中 app 的紧凑描述（供 listCatalog 内部合并；不出到 list_apps 契约）
struct RunningAppDescriptor {
    let name: String
    let bundleIdentifier: String?
    let pid: pid_t
    let runningApplication: NSRunningApplication
}

/// list_apps 主入口命名空间（无实例状态）
enum AppDiscovery {
    /// 非运行 app 上限（对齐 open-codex :55）——超过部分丢弃防 LLM 视野过长
    private static let maxRecentNonRunningApps = 10
    /// fixture app（预留：fixture app 未 bundleIdentifier 时的兜底 id；对齐 open-codex :56）
    private static let fixtureListBundleIdentifier = "com.rocky.computer-use.fixture"

    /// 日期格式化：`YYYY-MM-DD`（en_US_POSIX 保稳定，对齐 open-codex :64-70）
    static let usageDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// 主入口：合并 running + Spotlight recent → 排序 → 截断非运行 top 10
    ///
    /// - Returns: 排序后的 app 列表（frontmost 排头，followed by running,
    ///   然后 lastUsed / uses / name 依次决胜；非运行至多 10 个）
    static func listCatalog() -> [ListedAppDescriptor] {
        let running = userFacingRunningApps()
        let frontmostBundleIdentifier = NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.lowercased()

        // 运行中 app 按 bundleId 去重（frontmost 或 activationPolicy=.regular）
        let runningByBundle = running.reduce(into: [String: RunningAppDescriptor]()) { result, descriptor in
            guard let bundleIdentifier = listedBundleIdentifier(for: descriptor) else {
                return
            }
            let key = bundleIdentifier.lowercased()
            if result[key] == nil {
                result[key] = descriptor
            }
        }

        var entriesByBundle: [String: ListedAppDescriptor] = [:]

        // 先入 Spotlight recent（非运行 app 通过它入表；运行 app 若同时命中则 running-优先字段稍后覆盖）
        for record in SpotlightAppIndex.recentApps(cutoffDate: recentUsageCutoff()) {
            let key = record.bundleIdentifier.lowercased()
            let runningDescriptor = runningByBundle[key]
            entriesByBundle[key] = ListedAppDescriptor(
                name: runningDescriptor?.name ?? record.name,
                bundleIdentifier: record.bundleIdentifier,
                isRunning: runningDescriptor != nil,
                isFrontmost: key == frontmostBundleIdentifier,
                lastUsed: record.lastUsed,
                uses: record.uses
            )
        }

        // 覆盖 / 补充所有 running（Spotlight 可能漏收）
        for descriptor in running {
            guard let bundleIdentifier = listedBundleIdentifier(for: descriptor) else {
                continue
            }
            let key = bundleIdentifier.lowercased()
            let existing = entriesByBundle[key]
            entriesByBundle[key] = ListedAppDescriptor(
                name: descriptor.name,
                bundleIdentifier: bundleIdentifier,
                isRunning: true,
                isFrontmost: key == frontmostBundleIdentifier,
                lastUsed: existing?.lastUsed,
                uses: existing?.uses
            )
        }

        let sorted = entriesByBundle.values.sorted(by: compareListedApps)
        let runningEntries = sorted.filter(\.isRunning)
        let recentEntries = sorted.filter { !$0.isRunning }.prefix(maxRecentNonRunningApps)
        return runningEntries + Array(recentEntries)
    }

    /// 排序谓词（逐字对齐 open-codex `compareListedApps` :222-251，暴露给 UT 覆盖）
    ///
    /// 优先级：frontmost > running > 有 lastUsed > lastUsed 大 > uses 大 > name 字母序
    static func compareListedApps(_ lhs: ListedAppDescriptor, _ rhs: ListedAppDescriptor) -> Bool {
        // 1. frontmost 优先
        if lhs.isFrontmost != rhs.isFrontmost {
            return lhs.isFrontmost && !rhs.isFrontmost
        }
        // 2. running 优先
        if lhs.isRunning != rhs.isRunning {
            return lhs.isRunning && !rhs.isRunning
        }
        // 3. 有 lastUsed 优先
        let lhsHasUsage = lhs.lastUsed != nil
        let rhsHasUsage = rhs.lastUsed != nil
        if lhsHasUsage != rhsHasUsage {
            return lhsHasUsage && !rhsHasUsage
        }
        // 4. lastUsed 大（按 startOfDay 比较，同天走下一层）
        let calendar = Calendar(identifier: .gregorian)
        if let lhsLast = lhs.lastUsed, let rhsLast = rhs.lastUsed {
            let lhsDay = calendar.startOfDay(for: lhsLast)
            let rhsDay = calendar.startOfDay(for: rhsLast)
            if lhsDay != rhsDay {
                return lhsDay > rhsDay
            }
        }
        // 5. uses 大
        if let lhsUses = lhs.uses, let rhsUses = rhs.uses, lhsUses != rhsUses {
            return lhsUses > rhsUses
        }
        // 6. name 字母序
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }

    /// Spotlight cutoff：只看过去 14 天使用过的 app（对齐 open-codex :347-351）
    static func recentUsageCutoff(referenceDate: Date = Date()) -> Date {
        let calendar = Calendar(identifier: .gregorian)
        let startOfToday = calendar.startOfDay(for: referenceDate)
        return calendar.date(byAdding: .day, value: -13, to: startOfToday) ?? startOfToday
    }

    // MARK: - private helpers

    /// 运行中 + user-facing app（`activationPolicy == .regular` 或 fixture app）
    /// 按去重 bundleId 输出（避免 helper 多进程重复）
    private static func userFacingRunningApps() -> [RunningAppDescriptor] {
        var seen: Set<String> = []
        var descriptors: [RunningAppDescriptor] = []

        for descriptor in runningApps() {
            guard isUserFacingListApp(descriptor.runningApplication) else {
                continue
            }
            guard let bundleIdentifier = listedBundleIdentifier(for: descriptor) else {
                continue
            }
            let key = bundleIdentifier.lowercased()
            guard seen.insert(key).inserted else {
                continue
            }
            descriptors.append(descriptor)
        }

        return descriptors
    }

    /// 走 `NSWorkspace.shared.runningApplications` 拿全量 running（按 active + name 排序）
    private static func runningApps() -> [RunningAppDescriptor] {
        NSWorkspace.shared.runningApplications
            .filter { !$0.isTerminated }
            .sorted { lhs, rhs in
                if lhs.isActive != rhs.isActive {
                    return lhs.isActive && !rhs.isActive
                }
                return appName(lhs).localizedCaseInsensitiveCompare(appName(rhs)) == .orderedAscending
            }
            .map { app in
                RunningAppDescriptor(
                    name: appName(app),
                    bundleIdentifier: app.bundleIdentifier,
                    pid: app.processIdentifier,
                    runningApplication: app
                )
            }
    }

    /// 判定「用户可见 app」：activationPolicy == .regular，或 fixture app 名匹配
    private static func isUserFacingListApp(_ app: NSRunningApplication) -> Bool {
        if appName(app) == FixtureBridge.appName {
            return true
        }
        return app.activationPolicy == .regular
    }

    /// 拿 running app 的展示 bundleId（缺失 bundleId 时若是 fixture app 走占位 id；否则 nil 排除）
    private static func listedBundleIdentifier(for descriptor: RunningAppDescriptor) -> String? {
        if let bundleIdentifier = descriptor.bundleIdentifier, !bundleIdentifier.isEmpty {
            return bundleIdentifier
        }
        guard descriptor.name == FixtureBridge.appName else {
            return nil
        }
        return fixtureListBundleIdentifier
    }

    /// 拿 running app 的展示 name（localizedName > bundle CFBundleDisplayName/Name > 文件名 > pid 兜底）
    private static func appName(_ app: NSRunningApplication) -> String {
        app.localizedName
            ?? bundleDisplayName(Bundle(url: app.bundleURL ?? URL(fileURLWithPath: "/")))
            ?? app.bundleURL?.deletingPathExtension().lastPathComponent
            ?? app.executableURL?.lastPathComponent
            ?? "pid-\(app.processIdentifier)"
    }

    private static func bundleDisplayName(_ bundle: Bundle?) -> String? {
        guard let bundle else { return nil }
        let displayName = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
        let bundleName = bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String
        return displayName ?? bundleName
    }
}

/// list_apps 对外契约层（Service.listApps 调）——委托 `AppDiscovery.listCatalog()` 展平成 `[String: Any]`。
///
/// 未安装 Spotlight 权限 / MDQuery 失败 → SpotlightAppIndex fail-closed 返 []，
/// listCatalog 自动降级为「纯运行中 app」（保 v0.0.159 契约不倒退）。
///
/// 输出 dict 字段：bundleId / name / pid / isRunning（v0.0.159 契约）+
/// v0.0.160 新增可选 line / isFrontmost / lastUsed（YYYY-MM-DD）/ uses。
enum Applications {
    static func list() -> [[String: Any]] {
        // 用 bundleId 反查 running app pid（catalog 里 isRunning=true 的项 → pid；否则 0 占位）
        let runningPidByBundle: [String: Int32] = NSWorkspace.shared.runningApplications
            .reduce(into: [:]) { acc, app in
                guard let bid = app.bundleIdentifier, !bid.isEmpty else { return }
                let key = bid.lowercased()
                if acc[key] == nil { acc[key] = app.processIdentifier }
            }

        return AppDiscovery.listCatalog().map { entry in
            var dict: [String: Any] = [
                "bundleId": entry.bundleIdentifier,
                "name": entry.name,
                "pid": Int(runningPidByBundle[entry.bundleIdentifier.lowercased()] ?? 0),
                "isRunning": entry.isRunning,
                // 供 LLM 直接消费的整行渲染（含 frontmost/running/last-used/uses 标记，逐字对齐 open-codex）
                "line": entry.renderedLine,
                "isFrontmost": entry.isFrontmost,
            ]
            if let lastUsed = entry.lastUsed {
                dict["lastUsed"] = AppDiscovery.usageDateFormatter.string(from: lastUsed)
            }
            if let uses = entry.uses {
                dict["uses"] = uses
            }
            return dict
        }
    }
}
