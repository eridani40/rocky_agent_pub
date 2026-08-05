/**
 * CursorMotion descriptor 表：10 条 direct / turn / brake / orbit 曲线族参数。
 *
 * 逐字对齐 open-codex `CursorMotionModel.swift` §815-§1114：`descriptors(...)` 返回的
 * MotionDescriptor 表 + MotionDescriptor 结构体本体（从 HeadingDrivenCursorMotionModel
 * 拆出，避免主模型文件超 300 行 cap）。
 *
 * 参考: refs/open-codex-computer-use/.../CursorMotionModel.swift §815-§1114
 */

import CoreGraphics
import Foundation

extension HeadingDrivenCursorMotionModel {
    /// 生成 candidate 曲线族参数表：
    ///   - 2 条 direct（默认无侧向偏）
    ///   - 2 条 primary turn（首选侧的紧/宽两种转弯）
    ///   - 2 条 primary brake（首选侧的紧/宽两种减速）
    ///   - 2 条 primary orbit（首选侧的紧/宽两种绕行）
    ///   - 2 条 secondary（-preferredSide 的兜底 turn / brake）
    static func descriptors(for metrics: MotionMetrics, preferredSide: Int) -> [MotionDescriptor] {
        let orbitScale = 0.82 + (metrics.farFactor * 0.26)
        let turnaroundScale = 0.90 + (metrics.farFactor * 0.30)
        let brakingScale = 0.74 + (metrics.farFactor * 0.24)

        return [
            MotionDescriptor(
                id: "direct-tight", family: "direct", side: 0,
                startReachScale: 0.90, endReachScale: 0.86,
                startLineWeight: 1.12, endLineWeight: 1.04,
                startHeadingWeight: 0.18, endHeadingWeight: 0.20,
                startNormalScale: 0.02, endNormalScale: 0.02,
                startGuideNormalBias: 0, endGuideNormalBias: 0,
                startFlowWeight: 0.02, endFlowWeight: 0.02,
                flowShift: -0.02, arcScale: 0.16, scoreBias: 18
            ),
            MotionDescriptor(
                id: "direct-soft", family: "direct", side: 0,
                startReachScale: 0.98, endReachScale: 0.94,
                startLineWeight: 1.04, endLineWeight: 0.96,
                startHeadingWeight: 0.22, endHeadingWeight: 0.28,
                startNormalScale: 0.04, endNormalScale: 0.08,
                startGuideNormalBias: 0, endGuideNormalBias: 0.04,
                startFlowWeight: 0.04, endFlowWeight: 0.08,
                flowShift: 0.02, arcScale: 0.24, scoreBias: 24
            ),
            MotionDescriptor(
                id: "turn-primary-tight", family: "turn", side: preferredSide,
                startReachScale: 1.26, endReachScale: 1.30,
                startLineWeight: -0.24, endLineWeight: -0.04,
                startHeadingWeight: 1.50, endHeadingWeight: 1.18,
                startNormalScale: 0.46, endNormalScale: 0.08,
                startGuideNormalBias: 0.30, endGuideNormalBias: 0.16,
                startFlowWeight: -0.30, endFlowWeight: 0.20,
                flowShift: -0.08, arcScale: turnaroundScale, scoreBias: 40
            ),
            MotionDescriptor(
                id: "turn-primary-wide", family: "turn", side: preferredSide,
                startReachScale: 1.30, endReachScale: 1.36,
                startLineWeight: -0.28, endLineWeight: -0.10,
                startHeadingWeight: 1.54, endHeadingWeight: 1.24,
                startNormalScale: 0.58, endNormalScale: 0.12,
                startGuideNormalBias: 0.34, endGuideNormalBias: 0.20,
                startFlowWeight: -0.34, endFlowWeight: 0.24,
                flowShift: 0.06, arcScale: turnaroundScale * 1.06, scoreBias: 46
            ),
            MotionDescriptor(
                id: "brake-primary-tight", family: "brake", side: preferredSide,
                startReachScale: 0.92, endReachScale: 1.42,
                startLineWeight: 0.50, endLineWeight: -0.20,
                startHeadingWeight: 0.70, endHeadingWeight: 1.52,
                startNormalScale: 0.16, endNormalScale: 0.20,
                startGuideNormalBias: 0.10, endGuideNormalBias: 0.26,
                startFlowWeight: 0.10, endFlowWeight: 0.32,
                flowShift: -0.04, arcScale: brakingScale, scoreBias: 44
            ),
            MotionDescriptor(
                id: "brake-primary-wide", family: "brake", side: preferredSide,
                startReachScale: 0.98, endReachScale: 1.50,
                startLineWeight: 0.44, endLineWeight: -0.26,
                startHeadingWeight: 0.74, endHeadingWeight: 1.62,
                startNormalScale: 0.22, endNormalScale: 0.26,
                startGuideNormalBias: 0.12, endGuideNormalBias: 0.32,
                startFlowWeight: 0.14, endFlowWeight: 0.38,
                flowShift: 0.04, arcScale: brakingScale * 1.04, scoreBias: 50
            ),
            MotionDescriptor(
                id: "orbit-primary-tight", family: "orbit", side: preferredSide,
                startReachScale: 0.90, endReachScale: 0.98,
                startLineWeight: 0.72, endLineWeight: 0.76,
                startHeadingWeight: 0.30, endHeadingWeight: 0.22,
                startNormalScale: 0.90, endNormalScale: 0.82,
                startGuideNormalBias: 0.16, endGuideNormalBias: 0.06,
                startFlowWeight: 0.26, endFlowWeight: 0.12,
                flowShift: -0.06, arcScale: orbitScale, scoreBias: 54
            ),
            MotionDescriptor(
                id: "orbit-primary-wide", family: "orbit", side: preferredSide,
                startReachScale: 0.94, endReachScale: 1.02,
                startLineWeight: 0.68, endLineWeight: 0.82,
                startHeadingWeight: 0.28, endHeadingWeight: 0.22,
                startNormalScale: 1.02, endNormalScale: 0.94,
                startGuideNormalBias: 0.18, endGuideNormalBias: 0.08,
                startFlowWeight: 0.30, endFlowWeight: 0.16,
                flowShift: 0.06, arcScale: orbitScale * 1.06, scoreBias: 60
            ),
            MotionDescriptor(
                id: "turn-secondary", family: "turn", side: -preferredSide,
                startReachScale: 1.18, endReachScale: 1.26,
                startLineWeight: -0.18, endLineWeight: 0.02,
                startHeadingWeight: 1.32, endHeadingWeight: 1.08,
                startNormalScale: 0.34, endNormalScale: 0.06,
                startGuideNormalBias: 0.22, endGuideNormalBias: 0.14,
                startFlowWeight: -0.20, endFlowWeight: 0.14,
                flowShift: 0.02, arcScale: turnaroundScale * 0.92, scoreBias: 88
            ),
            MotionDescriptor(
                id: "brake-secondary", family: "brake", side: -preferredSide,
                startReachScale: 0.90, endReachScale: 1.34,
                startLineWeight: 0.52, endLineWeight: -0.16,
                startHeadingWeight: 0.62, endHeadingWeight: 1.40,
                startNormalScale: 0.12, endNormalScale: 0.18,
                startGuideNormalBias: 0.08, endGuideNormalBias: 0.20,
                startFlowWeight: 0.10, endFlowWeight: 0.28,
                flowShift: -0.02, arcScale: brakingScale * 0.92, scoreBias: 96
            ),
        ]
    }

    /// 一条 candidate 曲线族的参数（起终 reach / line / heading / normal 权重 + 弧规模 + 打分偏置）。
    struct MotionDescriptor {
        let id: String
        let family: String
        let side: Int
        let startReachScale: CGFloat
        let endReachScale: CGFloat
        let startLineWeight: CGFloat
        let endLineWeight: CGFloat
        let startHeadingWeight: CGFloat
        let endHeadingWeight: CGFloat
        let startNormalScale: CGFloat
        let endNormalScale: CGFloat
        let startGuideNormalBias: CGFloat
        let endGuideNormalBias: CGFloat
        let startFlowWeight: CGFloat
        let endFlowWeight: CGFloat
        let flowShift: CGFloat
        let arcScale: CGFloat
        let scoreBias: CGFloat

        var kind: CursorMotionKind {
            family == "direct" ? .base : .arched
        }
    }
}
