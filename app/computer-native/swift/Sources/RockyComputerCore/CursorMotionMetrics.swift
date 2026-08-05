/**
 * CursorMotion metrics 与打分上下文：MotionMetrics + MotionScoringContext。
 *
 * 逐字对齐 open-codex `CursorMotionModel.swift` §1071-§1143：从
 * `HeadingDrivenCursorMotionModel` 的 nested structs 拆出（避免主模型文件超 300 行 cap）。
 *
 * 参考: refs/open-codex-computer-use/.../CursorMotionModel.swift §1071-§1143
 */

import CoreGraphics
import Foundation

extension HeadingDrivenCursorMotionModel {
    /// 打分上下文：起终朝向 + 首选侧派生的多维需求指标。
    struct MotionScoringContext {
        let metrics: MotionMetrics
        let startForward: CGVector
        let endForward: CGVector
        let preferredSide: Int

        /// 起点朝向与直线方向的夹角占比（[0, 1]，需要多少转弯）。
        var turnDemand: CGFloat {
            min(abs(HeadingDrivenCursorMotionModel.signedAngle(from: startForward, to: metrics.direction)) / .pi, 1)
        }

        /// 直线方向与终点朝向的夹角占比（[0, 1]，需要多少减速到位）。
        var arrivalDemand: CGFloat {
            min(abs(HeadingDrivenCursorMotionModel.signedAngle(from: metrics.direction, to: endForward)) / .pi, 1)
        }

        /// 直度（1 - max(turnDemand, arrivalDemand * 0.82)，越大越直）。
        var directness: CGFloat {
            (1 - max(turnDemand, arrivalDemand * 0.82)).clamped(to: 0...1)
        }
    }

    /// 运动几何度量：距离 / 方向 / 法线 / 各方向因子（横 / 纵 / 对角 / 近 / 远）。
    struct MotionMetrics {
        let start: CGPoint
        let end: CGPoint
        let dx: CGFloat
        let dy: CGFloat
        let distance: CGFloat
        let direction: CGVector
        let normal: CGVector
        let horizontalFactor: CGFloat
        let verticalFactor: CGFloat
        let diagonalFactor: CGFloat
        let closeFactor: CGFloat
        let farFactor: CGFloat

        init(start: CGPoint, end: CGPoint) {
            self.start = start
            self.end = end
            dx = end.x - start.x
            dy = end.y - start.y
            distance = max(hypot(dx, dy), 1)
            direction = HeadingDrivenCursorMotionModel.normalizedOrDefault(CGVector(dx: dx, dy: dy))
            normal = HeadingDrivenCursorMotionModel.normalizedOrDefault(CGVector(dx: -direction.dy, dy: direction.dx))
            horizontalFactor = abs(dx) / distance
            verticalFactor = abs(dy) / distance
            diagonalFactor = min(horizontalFactor, verticalFactor) * 2
            closeFactor = (1 - (distance / 280)).clamped(to: 0...1)
            farFactor = ((distance - 180) / 540).clamped(to: 0...1)
        }
    }
}
