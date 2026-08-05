/**
 * CursorMotion 路径类型：cubic Bezier segments + 采样 + 度量。
 *
 * 逐字对齐 open-codex `CursorMotionModel.swift` §1-§180：`CursorMotionSegment /
 * CursorMotionPath / CursorMotionMeasurement / CursorMotionCandidate / CursorMotionKind`。
 * cubic 采样函数 + 几何扩展见 `CursorMotionGeometry.swift`（拆出避免超 300 行 cap）。
 *
 * 参考: refs/open-codex-computer-use/.../CursorMotionModel.swift §1-§180
 * 参考: specs/tech/version_logs/v0.0.160/change_plan.md 模块 G
 */

import CoreGraphics
import Foundation

/// 单段 cubic Bezier：起点由前一段的 end / path.start 隐含，本段只声明 end + 2 个控制点。
struct CursorMotionSegment: Equatable {
    let end: CGPoint
    let control1: CGPoint
    let control2: CGPoint
}

/// 光标运动路径（一段或多段 cubic Bezier 组成）。
struct CursorMotionPath: Equatable {
    let start: CGPoint
    let end: CGPoint
    let startControl: CGPoint?
    let arc: CGPoint?
    let arcIn: CGPoint?
    let arcOut: CGPoint?
    let endControl: CGPoint?
    let segments: [CursorMotionSegment]
    let curveScale: CGFloat

    init(
        start: CGPoint,
        end: CGPoint,
        startControl: CGPoint? = nil,
        arc: CGPoint? = nil,
        arcIn: CGPoint? = nil,
        arcOut: CGPoint? = nil,
        endControl: CGPoint? = nil,
        segments: [CursorMotionSegment],
        curveScale: CGFloat = 1
    ) {
        self.start = start
        self.end = end
        self.startControl = startControl
        self.arc = arc
        self.arcIn = arcIn
        self.arcOut = arcOut
        self.endControl = endControl
        self.segments = segments
        self.curveScale = curveScale
    }

    /// 便捷构造：直线 + 侧向偏移的曲线（fallback / legacy 用）。
    init(start: CGPoint, end: CGPoint, curveDirection: CGFloat? = nil, curveScale: CGFloat = 1) {
        let delta = end - start
        let distance = max(delta.length, 1)
        let normal = delta.perpendicular.normalized
        let resolvedCurveDirection = curveDirection ?? (delta.dx >= 0 ? 1 : -1)
        let resolvedCurveScale = max(curveScale, 0)
        let curveAmount = min(max(distance * 0.22, 28), 110) * resolvedCurveScale
        let controlOffset = normal.scaled(by: curveAmount * resolvedCurveDirection)
        let control1Base = CGPoint(
            x: start.x + (delta.dx * (resolvedCurveScale == 0 ? 1.0 / 3.0 : 0.18)),
            y: start.y + (delta.dy * (resolvedCurveScale == 0 ? 1.0 / 3.0 : 0.10))
        )
        let control2Base = CGPoint(
            x: start.x + (delta.dx * (resolvedCurveScale == 0 ? 2.0 / 3.0 : 0.80)),
            y: start.y + (delta.dy * (resolvedCurveScale == 0 ? 2.0 / 3.0 : 0.96))
        )
        let control1 = control1Base + controlOffset
        let control2 = control2Base + controlOffset.scaled(by: 0.48)

        self.init(
            start: start,
            end: end,
            startControl: control1,
            endControl: control2,
            segments: [
                CursorMotionSegment(end: end, control1: control1, control2: control2)
            ],
            curveScale: resolvedCurveScale
        )
    }

    /// 按参数化 progress ∈ [0,1] 采样路径点。
    func point(at progress: CGFloat) -> CGPoint {
        sample(at: progress).point
    }

    /// 按参数化 progress ∈ [0,1] 采样路径切向量（单位化）。
    func tangent(at progress: CGFloat) -> CGVector {
        sample(at: progress).tangent
    }

    /// 采样 progress 处的点 + 切向量。
    func sample(at progress: CGFloat) -> (point: CGPoint, tangent: CGVector) {
        guard !segments.isEmpty else {
            return (start, CGVector(dx: 1, dy: 0))
        }

        let clamped = progress.clamped(to: 0...1)
        let segmentCount = segments.count
        let segmentIndex: Int
        let localT: CGFloat

        if clamped >= 1 {
            segmentIndex = segmentCount - 1
            localT = 1
        } else {
            let scaled = clamped * CGFloat(segmentCount)
            segmentIndex = min(Int(scaled), segmentCount - 1)
            localT = scaled - CGFloat(segmentIndex)
        }

        let segment = segments[segmentIndex]
        let segmentStart = segmentIndex == 0 ? start : segments[segmentIndex - 1].end
        let point = sampleCubic(
            start: segmentStart,
            control1: segment.control1,
            control2: segment.control2,
            end: segment.end,
            t: localT
        )
        let tangent = sampleCubicTangent(
            start: segmentStart,
            control1: segment.control1,
            control2: segment.control2,
            end: segment.end,
            t: localT
        ).normalized
        return (point, tangent)
    }

    /// 均匀采样若干点，供窗口重合度评估。
    func sampledConstraintPoints(samplesPerSegment: Int = 6) -> [CGPoint] {
        let totalSteps = max(segments.count * max(samplesPerSegment, 1), 1)
        return (1...totalSteps).map { step in
            point(at: CGFloat(step) / CGFloat(totalSteps))
        }
    }

    /// 计算路径度量：总长 / 角度变化能量 / 峰值转角 / 总转角 / 是否在 bounds 内。
    func measure(
        bounds: CGRect?,
        minStepDistance: CGFloat = 0.01,
        samplesPerSegment: Int = 24
    ) -> CursorMotionMeasurement {
        var totalLength: CGFloat = 0
        var angleChangeEnergy: CGFloat = 0
        var maxAngleChange: CGFloat = 0
        var totalTurn: CGFloat = 0
        var staysInBounds = bounds?.contains(start, padding: 20) ?? true
        var previousPoint = start
        var previousAngle: CGFloat?

        let totalSteps = max(segments.count * max(samplesPerSegment, 1), 1)
        for step in 1...totalSteps {
            let progress = CGFloat(step) / CGFloat(totalSteps)
            let point = point(at: progress)
            let delta = point - previousPoint
            let stepLength = delta.length

            if let bounds, staysInBounds {
                staysInBounds = bounds.contains(point, padding: 20)
            }

            if stepLength > minStepDistance {
                let angle = atan2(delta.dy, delta.dx)
                totalLength += stepLength

                if let previousAngle {
                    var angleDelta = angle - previousAngle
                    while angleDelta > .pi {
                        angleDelta -= (.pi * 2)
                    }
                    while angleDelta < -.pi {
                        angleDelta += (.pi * 2)
                    }

                    angleChangeEnergy += angleDelta * angleDelta
                    let absoluteDelta = abs(angleDelta)
                    maxAngleChange = max(maxAngleChange, absoluteDelta)
                    totalTurn += absoluteDelta
                }

                previousAngle = angle
                previousPoint = point
            }
        }

        return CursorMotionMeasurement(
            length: totalLength,
            angleChangeEnergy: angleChangeEnergy,
            maxAngleChange: maxAngleChange,
            totalTurn: totalTurn,
            staysInBounds: staysInBounds
        )
    }
}

/// 路径几何度量结果。
struct CursorMotionMeasurement: Equatable {
    let length: CGFloat
    let angleChangeEnergy: CGFloat
    let maxAngleChange: CGFloat
    let totalTurn: CGFloat
    let staysInBounds: Bool
}

/// 单个路径候选（路径 + 度量 + 打分 + 标识）。
struct CursorMotionCandidate: Equatable {
    let identifier: String
    let kind: CursorMotionKind
    let side: Int
    let tableAScale: CGFloat?
    let tableBScale: CGFloat?
    let path: CursorMotionPath
    let measurement: CursorMotionMeasurement
    let score: CGFloat
}

/// 候选类型：直线（base）或带弧（arched）。
enum CursorMotionKind: String, Equatable {
    case base
    case arched
}
