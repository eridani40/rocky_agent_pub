import CoreServices
import Foundation

// SpotlightAppIndex —— Spotlight metadata 索引查询「最近使用过的 macOS 应用」。
//
// 用途：AppDiscovery.listCatalog 合并「运行中 app」+「最近 X 天使用过但没在运行的 app」。
//   走系统 MDQuery API + `kMDItemLastUsedDate_Ranking` / `kMDItemUseCount` 排序。
//
// 权限：`NSMetadataQuery` 走用户目录 metadata 无需 TCC 弹窗（macOS 系统能力）。
//   packaged app 需在 Info.plist 声明 `NSMetadataQueryUsageDescription`
//   （electron-builder.yml `mac.extendInfo` 注入）；dev 环境无需额外声明。
//
// Fail-closed 语义：MDQuery 创建失败 / 执行失败 / 权限被拒 → 一律返 []（AppDiscovery 降级为纯 running）。
//   不 throw、不弹窗、不阻塞主流程。
//
// 参考: refs/open-codex-computer-use `AppDiscovery.swift:395-503` 的 private `SpotlightAppIndex` enum
//       specs/tech/version_logs/v0.0.160/change_plan.md 模块 H（H-3）

/// Spotlight metadata 查回的单条 app 记录
struct SpotlightAppRecord {
    let name: String
    let bundleIdentifier: String
    let lastUsed: Date?
    let uses: Int?
}

/// Spotlight 索引查询命名空间（无实例）
enum SpotlightAppIndex {
    /// Spotlight 谓词：找 macOS app bundle（`.app` 目录 + `com.apple.application-bundle` 类型）
    /// 逐字对齐 open-codex `AppDiscovery.swift:52`
    private static let listAppsQuery = #"kMDItemContentType == "com.apple.application-bundle" && kMDItemFSName == "*.app""#
    /// 「最近使用日期排名」属性名（对齐 open-codex，不用公开常量走裸字符串）
    private static let lastUsedDateRankingAttribute = "kMDItemLastUsedDate_Ranking"
    /// 「使用次数」属性名
    private static let useCountAttribute = "kMDItemUseCount"

    /// 查最近使用过的 macOS app（cutoffDate 之前不计入；对齐 open-codex：默认过滤 14 天前的记录）
    ///
    /// - Parameter cutoffDate: 只返回 lastUsed >= cutoffDate 的 app（AppDiscovery 传 recentUsageCutoff）
    /// - Returns: Spotlight 索引查到的 app 列表（按 lastUsed desc 排序）；权限缺失/查询失败 → []
    static func recentApps(cutoffDate: Date) -> [SpotlightAppRecord] {
        let sortingAttributes = [
            lastUsedDateRankingAttribute as CFString,
            useCountAttribute as CFString,
        ] as CFArray

        // MDQueryCreate 失败（权限拒 / 索引未就绪）→ fail-closed 返 []
        guard let query = MDQueryCreate(
            kCFAllocatorDefault,
            listAppsQuery as CFString,
            nil,
            sortingAttributes
        ) else {
            return []
        }

        MDQuerySetSearchScope(query, standardSearchScopes() as CFArray, 0)
        MDQuerySetSortOptionFlagsForAttribute(
            query,
            lastUsedDateRankingAttribute as CFString,
            kMDQueryReverseSortOrderFlag.rawValue
        )
        MDQuerySetSortOptionFlagsForAttribute(
            query,
            useCountAttribute as CFString,
            kMDQueryReverseSortOrderFlag.rawValue
        )

        // 同步执行；失败（索引不可用 / 超时）→ fail-closed 返 []
        guard MDQueryExecute(query, CFOptionFlags(kMDQuerySynchronous.rawValue)) else {
            return []
        }

        var seen: Set<String> = []
        var records: [SpotlightAppRecord] = []

        for index in 0..<MDQueryGetResultCount(query) {
            guard let rawResult = MDQueryGetResultAtIndex(query, index) else {
                continue
            }

            // MDItem 是 CoreFoundation type；unsafeBitCast 是 open-codex 采用的桥接方式
            // swiftlint:disable:next force_cast
            let item = unsafeBitCast(rawResult, to: MDItem.self)
            guard
                let bundleIdentifier = stringAttribute(kMDItemCFBundleIdentifier, item: item),
                !bundleIdentifier.isEmpty
            else {
                continue
            }

            let key = bundleIdentifier.lowercased()
            guard seen.insert(key).inserted else {
                continue
            }

            guard let path = stringAttribute(kMDItemPath, item: item) else {
                continue
            }

            let appURL = URL(fileURLWithPath: path)
            let bundle = Bundle(url: appURL)
            // 过滤后台 daemon / helper（LSBackgroundOnly / LSUIElement = 无 dock 图标 = LLM 不该看见）
            if bundle?.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool == true {
                continue
            }
            if bundle?.object(forInfoDictionaryKey: "LSUIElement") as? Bool == true {
                continue
            }

            // 优先 Ranking 日期；否则 kMDItemLastUsedDate
            let lastUsed = dateAttribute(lastUsedDateRankingAttribute as CFString, item: item)
                ?? dateAttribute(kMDItemLastUsedDate, item: item)
            guard let lastUsed, lastUsed >= cutoffDate else {
                continue
            }

            let uses = numberAttribute(useCountAttribute as CFString, item: item)?.intValue
            let displayName = bundleDisplayName(bundle)
                ?? stringAttribute(kMDItemDisplayName, item: item).map(stripAppSuffix(from:))
                ?? stripAppSuffix(from: appURL.lastPathComponent)

            records.append(
                SpotlightAppRecord(
                    name: displayName,
                    bundleIdentifier: bundleIdentifier,
                    lastUsed: lastUsed,
                    uses: uses
                )
            )
        }

        return records
    }

    // MARK: - private helpers

    /// 搜索范围：/Applications + /System/Applications + /System/Library/CoreServices + ~/Applications（若存在）
    /// 逐字对齐 open-codex `AppDiscovery.swift:477-490`
    private static func standardSearchScopes() -> [CFString] {
        var scopes: [String] = [
            "/Applications",
            "/System/Applications",
            "/System/Library/CoreServices",
        ]

        let homeApplications = NSString(string: "~/Applications").expandingTildeInPath
        if FileManager.default.fileExists(atPath: homeApplications) {
            scopes.append(homeApplications)
        }

        return scopes as [CFString]
    }

    private static func stringAttribute(_ name: CFString, item: MDItem) -> String? {
        MDItemCopyAttribute(item, name) as? String
    }

    private static func numberAttribute(_ name: CFString, item: MDItem) -> NSNumber? {
        MDItemCopyAttribute(item, name) as? NSNumber
    }

    private static func dateAttribute(_ name: CFString, item: MDItem) -> Date? {
        MDItemCopyAttribute(item, name) as? Date
    }

    private static func bundleDisplayName(_ bundle: Bundle?) -> String? {
        guard let bundle else { return nil }
        let displayName = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
        let bundleName = bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String
        return displayName ?? bundleName
    }

    private static func stripAppSuffix(from value: String) -> String {
        value.hasSuffix(".app") ? String(value.dropLast(4)) : value
    }
}
