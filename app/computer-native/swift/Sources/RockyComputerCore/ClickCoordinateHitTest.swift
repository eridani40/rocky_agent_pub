import ApplicationServices
import CoreGraphics
import Foundation

// ClickCoordinateHitTest —— 坐标点击的 AX 候选拾取（v0.0.160 模块 D，gap#5 逐字对齐 open-codex）。
//
// 与 ClickHitTest 的分工：
//   - ClickHitTest = element_index 主链路的几何/描述性 helper（descendant / activation / list item）
//   - ClickCoordinateHitTest = coordinate 主链路的双候选拾取（bestElement + hitTestElement）
//     + performAXClickSequence 内 hit-test 分支复用的 `clickActionPoints`
//     / `shouldScanDescendantsOfHitRecord`
// 拆文件避免 ClickHitTest.swift 超 300 行硬约束（架构原则 4）。
//
// 参考: refs/open-codex-computer-use `ComputerUseService.swift`
//   - clickCandidates L743-767 / sameElement L761-767
//   - bestElement L970-983 / hitTestElement L985-1003
//   - clickActionPoints L1040-1046 / localClickActionPoints L173-189
//   - shouldScanDescendantsOfHitRecord L237-255
// 参考文档: specs/tech/version_logs/v0.0.160/change_plan.md 模块 D

enum ClickCoordinateHitTest {
    // MARK: - 双候选拾取（bestElement + hitTestElement）

    /// 从 lastRecords（AX 树缓存）取包含该 point 的元素，按 `clickPriority` 升序 / 同优先级面积升序取 first。
    /// 对齐 open-codex L970-983：Rocky 用 screenFrame（screen y-down）替代 open-codex 的 localFrame，
    /// coord point 也是 screen y-down 全局点（TS 侧已换算），坐标系一致。
    static func bestElement(containing point: CGPoint, in records: [Int: ElementRecord]) -> ElementRecord? {
        records.values
            .filter { $0.screenFrame?.contains(point) ?? false }
            .sorted { lhs, rhs in
                let lp = ClickHitTest.clickPriority(for: lhs)
                let rp = ClickHitTest.clickPriority(for: rhs)
                if lp != rp { return lp < rp }
                return ClickHitTest.frameArea(of: lhs) < ClickHitTest.frameArea(of: rhs)
            }
            .first
    }

    /// AX 系统 API 直接拾取（`AXUIElementCopyElementAtPosition`）——绕过 tree cache，
    /// 命中运行时最新元素（对齐 open-codex L985-1003）。构造 index=-1 的合成 record
    /// （identifier=nil / isSyntheticText=false / prettyActions=rawActions）。
    ///
    /// pid ≤ 0 / 拾取失败 → nil；上层 `clickCandidates` 与 bestElement 合并取交/并集。
    static func hitTestElement(at point: CGPoint, pid: pid_t) -> ElementRecord? {
        guard pid > 0 else { return nil }
        let appElement = AXUIElementCreateApplication(pid)
        var hit: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(
            appElement, Float(point.x), Float(point.y), &hit
        )
        guard result == .success, let hitElement = hit else { return nil }
        let rawActions = AccessibilitySnapshot.rawActionsOf(hitElement)
        let role = AccessibilitySnapshot.stringAttr(hitElement, kAXRoleAttribute) ?? "AXUnknown"
        let title = AccessibilitySnapshot.stringAttr(hitElement, kAXTitleAttribute)
        let value = AccessibilitySnapshot.stringAttr(hitElement, kAXValueAttribute)
        let frame = AccessibilitySnapshot.frameOf(hitElement)
        // secondary actions = rawActions 去 AXPress（保 walk 派生规则一致）
        let actions = rawActions.filter { $0 != (kAXPressAction as String) }
        return ElementRecord(
            index: -1, element: hitElement, role: role, title: title,
            value: value, screenFrame: frame,
            actions: actions, rawActions: rawActions,
            identifier: nil, isSyntheticText: false, prettyActions: rawActions
        )
    }

    /// 合并 bestElement + hitTestElement 结果去重（CFEqual 判等），返回顺序 = bestElement first, hitTest second。
    /// 对齐 open-codex L743-767。lastRecords 为空 + AX 拾取失败 → 返 []（Service.click 走 CGEvent 兜底）。
    static func clickCandidates(at point: CGPoint, in records: [Int: ElementRecord], pid: pid_t) -> [ElementRecord] {
        var candidates: [ElementRecord] = []
        if let best = bestElement(containing: point, in: records) {
            candidates.append(best)
        }
        if let hit = hitTestElement(at: point, pid: pid) {
            candidates.append(hit)
        }
        return candidates.reduce(into: []) { unique, candidate in
            if !unique.contains(where: { sameElement($0.element, candidate.element) }) {
                unique.append(candidate)
            }
        }
    }

    /// 两 AXUIElement 是否指向同一后端对象（CFEqual）。任一 nil → false。对齐 open-codex L761-767。
    static func sameElement(_ lhs: AXUIElement?, _ rhs: AXUIElement?) -> Bool {
        guard let lhs, let rhs else { return false }
        return CFEqual(lhs, rhs)
    }

    // MARK: - 几何辅助（performAXClickSequence 内 hit-test 分支复用）

    /// 元素 clickAction 目标点集：syntheticText 只返 leading；否则 `[center, leading]`（若 leading≈center 只返 center）。
    /// leading = frame.minX + min(max(frame.w * 0.3, 20), max(frame.w-4, 20))。对齐 open-codex L173-189。
    /// screenFrame nil → 空数组（无点可点）。
    static func clickActionPoints(for record: ElementRecord) -> [CGPoint] {
        guard let frame = record.screenFrame else { return [] }
        let center = CGPoint(x: frame.midX, y: frame.midY)
        let leadingX = frame.minX + min(max(frame.width * 0.3, 20), max(frame.width - 4, 20))
        let leading = CGPoint(x: leadingX, y: frame.midY)
        if record.isSyntheticText { return [leading] }
        if abs(leading.x - center.x) < 1 { return [center] }
        return [center, leading]
    }

    /// hit-test 命中的元素若面积 >> 原 record 面积（12x）或高宽超 4x/2x 数量级 → 返 false 跳过 descendant scan
    /// （避免把整窗/整 dialog 当候选扫）。对齐 open-codex L237-255。任一 nil → true（保底扫）。
    static func shouldScanDescendantsOfHitRecord(originalFrame: CGRect?, hitFrame: CGRect?) -> Bool {
        guard let originalFrame, let hitFrame else { return true }
        let originalArea = max(originalFrame.width * originalFrame.height, 1)
        let hitArea = hitFrame.width * hitFrame.height
        if hitArea > max(originalArea * 12, 20_000) { return false }
        if hitFrame.height > max(originalFrame.height * 4, 96),
           hitFrame.width > max(originalFrame.width * 2, 240)
        {
            return false
        }
        return true
    }
}
