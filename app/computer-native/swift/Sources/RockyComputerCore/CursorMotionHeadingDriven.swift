/**
 * HeadingDrivenCursorMotionModel：基于当前朝向 + 目标朝向的路径 candidate 生成 + 打分。
 *
 * 逐字对齐 open-codex `CursorMotionModel.swift` §590-§1069 主方法体：
 *   - makeCandidates / chooseBestCandidate / makePath / makeCandidate / scoreCandidate
 *   - preferredTurnSide / resolvedGuide / normalizedOrDefault / signedAngle
 * 拆分归属：
 *   - `CursorMotionDescriptors.swift`：descriptor 表 + MotionDescriptor 结构
 *   - `CursorMotionMetrics.swift`：MotionScoringContext + MotionMetrics 嵌套 struct
 *
 * 参考: refs/open-codex-computer-use/.../CursorMotionModel.swift §590-§1069
 */

import CoreGraphics
import Foundation

/// 基于朝向 candidate 挑选的运动模型（相比 Official 更能保留起终朝向）。
enum HeadingDrivenCursorMotionModel {
    static let defaultStartHandle: CGFloat = 0.29
    static let defaultEndHandle: CGFloat = 0.08
    static let defaultArcSize: CGFloat = 0.06
    static let defaultArcFlow: CGFloat = 0.64
    static let normalizationEpsilon: CGFloat = 0.001

    /// 生成候选：先算 metrics + 首选侧，再遍历 descriptor 表生成路径 + 打分。
    static func makeCandidates(
        start: CGPoint,
        end: CGPoint,
        bounds: CGRect?,
        startForward: CGVector,
        endForward: CGVector
    ) -> [CursorMotionCandidate] {
        let metrics = MotionMetrics(start: start, end: end)
        let resolvedStartForward = normalizedOrDefault(startForward)
        let resolvedEndForward = normalizedOrDefault(endForward)
        let preferredSide = preferredTurnSide(
            metrics: metrics,
            startForward: resolvedStartForward,
            endForward: resolvedEndForward
        )
        let scoringContext = MotionScoringContext(
            metrics: metrics,
            startForward: resolvedStartForward,
            endForward: resolvedEndForward,
            preferredSide: preferredSide
        )

        return descriptors(for: metrics, preferredSide: preferredSide).map { descriptor in
            let path = makePath(
                from: start,
                to: end,
                metrics: metrics,
                descriptor: descriptor,
                startForward: resolvedStartForward,
                endForward: resolvedEndForward
            )
            return makeCandidate(
                identifier: descriptor.id,
                kind: descriptor.kind,
                side: descriptor.side,
                tableAScale: nil,
                tableBScale: nil,
                path: path,
                bounds: bounds,
                context: scoringContext,
                descriptor: descriptor
            )
        }
    }

    /// 挑最优候选：优先 in-bounds，然后 score 最小，identifier 稳定 tie-break。
    static func chooseBestCandidate(from candidates: [CursorMotionCandidate]) -> CursorMotionCandidate? {
        guard !candidates.isEmpty else {
            return nil
        }

        let inBoundsCandidates = candidates.filter(\.measurement.staysInBounds)
        let pool = inBoundsCandidates.isEmpty ? candidates : inBoundsCandidates
        return pool.min { lhs, rhs in
            if lhs.score == rhs.score {
                return lhs.identifier < rhs.identifier
            }
            return lhs.score < rhs.score
        }
    }

    /// 校准动画时长（转发到 Official）。
    static func calibratedTravelDuration(distance: CGFloat, measurement: CursorMotionMeasurement) -> CGFloat {
        OfficialCursorMotionModel.calibratedTravelDuration(distance: distance, measurement: measurement)
    }

    /// 由 descriptor + metrics 计算 cubic Bezier 路径（起终 guide + 弧偏移）。
    static func makePath(
        from start: CGPoint,
        to end: CGPoint,
        metrics: MotionMetrics,
        descriptor: MotionDescriptor,
        startForward: CGVector,
        endForward: CGVector
    ) -> CursorMotionPath {
        let distance = metrics.distance
        let direction = metrics.direction
        let normal = metrics.normal
        let resolvedFlow = (defaultArcFlow + descriptor.flowShift).clamped(to: 0...1)
        let flowBias = (resolvedFlow - 0.5) * distance * 0.18

        let baseStartReach = distance * (0.10 + defaultStartHandle * 0.56)
        let baseEndReach = distance * (0.11 + defaultEndHandle * 0.62)
        let distanceLift = 0.68 + (metrics.farFactor * 0.56)
        let baseArcHeight = min(
            max(distance * (0.10 + defaultArcSize * 0.92) * descriptor.arcScale * distanceLift, 20),
            distance * 0.96
        )

        let sideSign = CGFloat(descriptor.side)
        let arcVector = CGVector(
            dx: normal.dx * baseArcHeight * sideSign,
            dy: normal.dy * baseArcHeight * sideSign
        )

        let startGuide = resolvedGuide(
            line: direction,
            forward: startForward,
            normal: normal,
            sideSign: sideSign,
            lineWeight: descriptor.startLineWeight,
            headingWeight: descriptor.startHeadingWeight,
            normalBias: descriptor.startGuideNormalBias
        )
        let endGuide = resolvedGuide(
            line: direction,
            forward: endForward,
            normal: normal,
            sideSign: sideSign,
            lineWeight: descriptor.endLineWeight,
            headingWeight: descriptor.endHeadingWeight,
            normalBias: descriptor.endGuideNormalBias
        )

        let startReach = max(baseStartReach * descriptor.startReachScale + flowBias * descriptor.startFlowWeight, 12)
        let endReach = max(baseEndReach * descriptor.endReachScale - flowBias * descriptor.endFlowWeight, 12)
        let control1Base = start + startGuide.scaled(by: startReach)
        let control2Base = end - endGuide.scaled(by: endReach)

        let control1 = control1Base + arcVector.scaled(by: descriptor.startNormalScale)
        let control2 = control2Base + arcVector.scaled(by: descriptor.endNormalScale)
        let resolvedArcHeight = baseArcHeight * max(
            abs(descriptor.startNormalScale),
            abs(descriptor.endNormalScale),
            0.12
        )

        return CursorMotionPath(
            start: start,
            end: end,
            startControl: control1,
            endControl: control2,
            segments: [
                CursorMotionSegment(end: end, control1: control1, control2: control2)
            ],
            curveScale: resolvedArcHeight
        )
    }

    static func makeCandidate(
        identifier: String,
        kind: CursorMotionKind,
        side: Int,
        tableAScale: CGFloat?,
        tableBScale: CGFloat?,
        path: CursorMotionPath,
        bounds: CGRect?,
        context: MotionScoringContext,
        descriptor: MotionDescriptor
    ) -> CursorMotionCandidate {
        let measurement = path.measure(bounds: bounds, minStepDistance: OfficialCursorMotionModel.minimumStepDistance)
        let score = scoreCandidate(
            measurement: measurement,
            path: path,
            descriptor: descriptor,
            context: context
        )

        return CursorMotionCandidate(
            identifier: identifier,
            kind: kind,
            side: side,
            tableAScale: tableAScale,
            tableBScale: tableBScale,
            path: path,
            measurement: measurement,
            score: score
        )
    }

    /// 综合几何 + 朝向 + descriptor family 特性打分。
    static func scoreCandidate(
        measurement: CursorMotionMeasurement,
        path: CursorMotionPath,
        descriptor: MotionDescriptor,
        context: MotionScoringContext
    ) -> CGFloat {
        let distance = max(context.metrics.distance, 1)
        let excessLengthRatio = max((measurement.length / distance) - 1, 0)
        let startTangent = normalizedOrDefault(path.tangent(at: 0.04))
        let endTangent = normalizedOrDefault(path.tangent(at: 0.96))
        let startHeadingError = abs(signedAngle(from: context.startForward, to: startTangent))
        let endHeadingError = abs(signedAngle(from: endTangent, to: context.endForward))

        var score = descriptor.scoreBias
        score += excessLengthRatio * 180
        score += measurement.angleChangeEnergy * 90
        score += measurement.maxAngleChange * 85
        score += measurement.totalTurn * (descriptor.side == 0 ? 10 : 12)
        score += startHeadingError * 150
        score += endHeadingError * 120

        if descriptor.side == 0 {
            score += context.turnDemand * 130
            score += context.arrivalDemand * 30
        } else {
            score += context.directness * 90
            if descriptor.side != context.preferredSide {
                score += max(context.turnDemand, 0.45) * 200
            }
        }

        switch descriptor.family {
        case "turn":
            score += (1 - context.turnDemand) * 55
        case "brake":
            score += (1 - context.arrivalDemand) * 40
        case "orbit":
            score += context.directness * 70
        case "direct":
            score += max(context.turnDemand - 0.12, 0) * 80
        default:
            break
        }

        if measurement.staysInBounds == false {
            score += 90
        }

        return score
    }

    /// 首选转弯侧：起点朝向差 > 阈值 → 服从起点；否则用终点朝向差 → 否则纵横比 → 否则 dx 符号。
    static func preferredTurnSide(
        metrics: MotionMetrics,
        startForward: CGVector,
        endForward: CGVector
    ) -> Int {
        let startDelta = signedAngle(from: startForward, to: metrics.direction)
        if abs(startDelta) > 0.16 {
            return startDelta > 0 ? 1 : -1
        }

        let endDelta = signedAngle(from: metrics.direction, to: endForward)
        if abs(endDelta) > 0.18 {
            return endDelta > 0 ? -1 : 1
        }

        if abs(metrics.dy) > abs(metrics.dx) * 0.72 {
            return metrics.dy > 0 ? -1 : 1
        }

        return metrics.dx >= 0 ? 1 : -1
    }

    /// 综合 line / forward / normal 三向的 guide 向量（归一化后返回）。
    static func resolvedGuide(
        line: CGVector,
        forward: CGVector,
        normal: CGVector,
        sideSign: CGFloat,
        lineWeight: CGFloat,
        headingWeight: CGFloat,
        normalBias: CGFloat
    ) -> CGVector {
        normalizedOrDefault(
            line.scaled(by: lineWeight)
                + forward.scaled(by: headingWeight)
                + normal.scaled(by: normalBias * sideSign)
        )
    }

    static func normalizedOrDefault(_ vector: CGVector) -> CGVector {
        let length = max(vector.length, normalizationEpsilon)
        return CGVector(dx: vector.dx / length, dy: vector.dy / length)
    }

    /// 计算两向量间的带符号夹角（[-π, π]）。
    static func signedAngle(from lhs: CGVector, to rhs: CGVector) -> CGFloat {
        atan2((lhs.dx * rhs.dy) - (lhs.dy * rhs.dx), (lhs.dx * rhs.dx) + (lhs.dy * rhs.dy))
    }
}
