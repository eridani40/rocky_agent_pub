import Foundation

// ServiceHelpers —— 从 Service.swift 拆出的 file-scope 纯函数（保 Service.swift ≤ 300 行硬约束）。
// 内部（module-internal）可见，@testable RockyComputerCore 直接调用做 UT。
//
// 参考: refs/open-codex-computer-use ComputerUseService.swift
// 参考文档: specs/tech/version_logs/v0.0.160/change_plan.md 模块 E (E-7, E-8, E-10)

// MARK: - pretty actions 两级 match（对齐 open-codex `matchingAction` L691-701）

/// 与 record 的 rawActions/prettyActions 匹配用户传入的 action 名（两级）：
/// ① rawActions case-insensitive 精确 match → 命中返 raw 原字符串
/// ② prettyActions position match（zip raw/pretty，pretty case-insensitive 命中 → 返对应 raw）
/// 均未命中 → nil。用户传 "Press" 会 match "AXPress" pretty；传 "AXPress" 直命中 raw。
func matchingAction(requested: String, in record: ElementRecord) -> String? {
    if let exact = record.rawActions.first(where: { $0.caseInsensitiveCompare(requested) == .orderedSame }) {
        return exact
    }
    if let pretty = zip(record.rawActions, record.prettyActions).first(where: {
        $0.1.caseInsensitiveCompare(requested) == .orderedSame
    }) {
        return pretty.0
    }
    return nil
}

// MARK: - scroll 整数分页判定（对齐 open-codex `integralScrollPageCount` L1601-1607）

/// pages 是否可整分（tolerance 1e-6）→ 返 rounded Int（下限 1，负数保底）；非整数 → nil。
/// Service.scroll AX-first 用——非整数直接 CGEvent fallback，保连续/局部滚动语义。
func integralScrollPageCount(_ pages: Double) -> Int? {
    let rounded = pages.rounded(.toNearestOrAwayFromZero)
    guard abs(pages - rounded) < 0.000001 else { return nil }
    return max(Int(rounded), 1)
}
