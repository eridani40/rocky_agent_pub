/**
 * OfficialCursorMotionModel：官方参考路径 candidate 生成 + 打分 + 挑最优。
 *
 * 逐字对齐 open-codex `CursorMotionModel.swift` §328-§588：guide 向量派生、
 * primary/secondary extent 二分段、tableA × tableB 双弧候选生成、几何打分。
 *
 * 参考: refs/open-codex-computer-use/.../CursorMotionModel.swift §328-§588
 */

import CoreGraphics
import Foundation

/// 官方参考模型：基于固定 guide 向量派生 candidate 路径 + 几何打分挑选。
enum OfficialCursorMotionModel {
    static let minimumStepDistance: CGFloat = 0.01
    static let guideVectorInLocalBasis = CGVector(dx: -0.6946583704589973, dy: 0.7193398003386512)
    static let tableA: [CGFloat] = [0.55, 0.8, 1.05]
    static let tableB: [CGFloat] = [0.65, 1.0, 1.35]
    /// 计算一次并缓存的 spring close-enough 时长（作为标准动画时长基准）。
    static let closeEnoughTime = CursorMotionProgressAnimator.closeEnoughTime()

    private static let normalizationEpsilon: CGFloat = 0.001
    private static let sideBiasScale: CGFloat = 0.65
    private static let primaryDistanceScale: CGFloat = 0.41960295031576633
    private static let directSpanScale: CGFloat = 0.9
    private static let secondaryDistanceScale: CGFloat = 0.2765523188064277
    private static let arcDistanceScale: CGFloat = 0.5783555327868779
    private static let candidateArcMin: CGFloat = 38
    private static let candidateArcMax: CGFloat = 440
    private static let scoreExcessLengthWeight: CGFloat = 320
    private static let scoreAngleEnergyWeight: CGFloat = 140
    private static let scoreMaxAngleWeight: CGFloat = 180
    private static let scoreTotalTurnWeight: CGFloat = 18
    private static let scoreOutOfBoundsPenalty: CGFloat = 45

    /// 生成一批候选路径：2 条 base（full-guide + scaled-guide）+ tableA × tableB × 2side 弧形候选。
    static func makeCandidates(start: CGPoint, end: CGPoint, bounds: CGRect?) -> [CursorMotionCandidate] {
        let delta = end - start
        let distance = max(delta.length, normalizationEpsilon)
        let direction = delta.normalized
        let localNormal = direction.perpendicular
        let guide = direction.scaled(by: guideVectorInLocalBasis.dx)
            + localNormal.scaled(by: guideVectorInLocalBasis.dy)
        let reverseGuide = guide.scaled(by: -1)

        let (startExtentPre, endExtentPre) = binaryPiecewisePrimaryExtents(distance: distance)
        let startExtent = min(startExtentPre, clipPositiveRay(origin: start, direction: guide, bounds: bounds))
        let endExtent = min(endExtentPre, clipPositiveRay(origin: end, direction: reverseGuide, bounds: bounds))

        let startExtentScaled = min(
            max(startExtent * sideBiasScale, 0),
            clipPositiveRay(origin: start, direction: guide, bounds: bounds)
        )
        let endExtentScaled = min(
            max(endExtent * sideBiasScale, 0),
            clipPositiveRay(origin: end, direction: reverseGuide, bounds: bounds)
        )

        let fullStartControl = start + guide.scaled(by: startExtent)
        let fullEndControl = end - guide.scaled(by: endExtent)
        let scaledStartControl = start + guide.scaled(by: startExtentScaled)
        let scaledEndControl = end - guide.scaled(by: endExtentScaled)

        let rawHandleExtent = binaryPiecewiseHandleExtent(distance: distance)
        let rawArcExtent = (distance * arcDistanceScale).clamped(to: candidateArcMin...candidateArcMax)

        let midpoint = CGPoint(x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5)
        var signedNormal = localNormal
        let cross = (guide.dy * direction.dx) - (guide.dx * direction.dy)
        if cross < 0 {
            signedNormal = signedNormal.scaled(by: -1)
        }
        let arcAnchorBias = guide.scaled(by: startExtent * sideBiasScale)
        let forwardUnit = normalizedOrDefault(
            direction.scaled(by: distance) + signedNormal.scaled(by: rawArcExtent),
            minimumLength: rawHandleExtent
        )

        var candidates: [CursorMotionCandidate] = []
        candidates.append(
            makeCandidate(
                identifier: "base-full-guide",
                kind: .base,
                side: 0,
                tableAScale: nil,
                tableBScale: nil,
                path: CursorMotionPath(
                    start: start,
                    end: end,
                    startControl: fullStartControl,
                    endControl: fullEndControl,
                    segments: [
                        CursorMotionSegment(end: end, control1: fullStartControl, control2: fullEndControl)
                    ],
                    curveScale: 1
                ),
                distance: distance,
                bounds: bounds
            )
        )
        candidates.append(
            makeCandidate(
                identifier: "base-scaled-guide",
                kind: .base,
                side: 0,
                tableAScale: nil,
                tableBScale: nil,
                path: CursorMotionPath(
                    start: start,
                    end: end,
                    startControl: scaledStartControl,
                    endControl: scaledEndControl,
                    segments: [
                        CursorMotionSegment(end: end, control1: scaledStartControl, control2: scaledEndControl)
                    ],
                    curveScale: sideBiasScale
                ),
                distance: distance,
                bounds: bounds
            )
        )

        for outerScale in tableA {
            let anchorOffset = signedNormal.scaled(by: rawHandleExtent * outerScale)
            for innerScale in tableB {
                let tangentSpan = forwardUnit.scaled(by: rawArcExtent * innerScale)

                for side in [1, -1] {
                    let anchor = midpoint + arcAnchorBias + anchorOffset.scaled(by: CGFloat(side))
                    let arcIn = anchor - tangentSpan
                    let arcOut = anchor + tangentSpan
                    let path = CursorMotionPath(
                        start: start,
                        end: end,
                        startControl: fullStartControl,
                        arc: anchor,
                        arcIn: arcIn,
                        arcOut: arcOut,
                        endControl: fullEndControl,
                        segments: [
                            CursorMotionSegment(end: anchor, control1: fullStartControl, control2: arcIn),
                            CursorMotionSegment(end: end, control1: arcOut, control2: fullEndControl)
                        ],
                        curveScale: innerScale
                    )

                    candidates.append(
                        makeCandidate(
                            identifier: "a\(outerScale.cursorIdentifier)-b\(innerScale.cursorIdentifier)-\(side > 0 ? "positive" : "negative")",
                            kind: .arched,
                            side: side,
                            tableAScale: outerScale,
                            tableBScale: innerScale,
                            path: path,
                            distance: distance,
                            bounds: bounds
                        )
                    )
                }
            }
        }

        return candidates
    }

    /// 挑最优候选：优先 in-bounds，然后 score 最小，identifier 打破 tie。
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

    /// 标准动画时长 = 缓存的 spring closeEnoughTime（不看距离/度量）。
    static func calibratedTravelDuration(distance _: CGFloat, measurement _: CursorMotionMeasurement) -> CGFloat {
        closeEnoughTime
    }

    private static func makeCandidate(
        identifier: String,
        kind: CursorMotionKind,
        side: Int,
        tableAScale: CGFloat?,
        tableBScale: CGFloat?,
        path: CursorMotionPath,
        distance: CGFloat,
        bounds: CGRect?
    ) -> CursorMotionCandidate {
        let measurement = path.measure(bounds: bounds, minStepDistance: minimumStepDistance)
        let score = scoreCandidate(distance: distance, measurement: measurement)
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

    /// 候选打分：路径超长惩罚 + 角度变化能量 + 峰值转角 + 总转角 + 超屏惩罚。
    private static func scoreCandidate(distance: CGFloat, measurement: CursorMotionMeasurement) -> CGFloat {
        let excessLengthRatio = max((measurement.length / max(distance, 1)) - 1, 0)
        return (excessLengthRatio * scoreExcessLengthWeight)
            + (measurement.angleChangeEnergy * scoreAngleEnergyWeight)
            + (measurement.maxAngleChange * scoreMaxAngleWeight)
            + (measurement.totalTurn * scoreTotalTurnWeight)
            + (measurement.staysInBounds ? 0 : scoreOutOfBoundsPenalty)
    }

    private static func binaryPiecewisePrimaryExtents(distance: CGFloat) -> (startExtent: CGFloat, endExtent: CGFloat) {
        let primary = distance * primaryDistanceScale
        let direct = distance * directSpanScale
        let secondary = distance * 0.15
        let lowCutoff: CGFloat = 48
        let highCutoff: CGFloat = 640

        if primary < lowCutoff {
            return (lowCutoff, lowCutoff)
        }
        if primary < highCutoff {
            return (primary, direct)
        }
        if secondary < highCutoff {
            return (highCutoff, lowCutoff)
        }
        return (highCutoff, highCutoff)
    }

    private static func binaryPiecewiseHandleExtent(distance: CGFloat) -> CGFloat {
        let raw = distance * secondaryDistanceScale
        if raw < 50 {
            return 50
        }
        if raw < 640 {
            return raw
        }
        return 520
    }

    /// 沿方向从原点出发到 bounds 边界的最大距离（无 bounds 时 infinity）。
    private static func clipPositiveRay(origin: CGPoint, direction: CGVector, bounds: CGRect?) -> CGFloat {
        guard let bounds else {
            return .infinity
        }

        var limit = CGFloat.infinity
        if direction.dx > 0 {
            limit = min(limit, (bounds.maxX - origin.x) / direction.dx)
        } else if direction.dx < 0 {
            limit = min(limit, (bounds.minX - origin.x) / direction.dx)
        }

        if direction.dy > 0 {
            limit = min(limit, (bounds.maxY - origin.y) / direction.dy)
        } else if direction.dy < 0 {
            limit = min(limit, (bounds.minY - origin.y) / direction.dy)
        }

        return max(limit, 0)
    }

    private static func normalizedOrDefault(_ vector: CGVector, minimumLength: CGFloat) -> CGVector {
        let length = vector.length
        if length < minimumLength || length < normalizationEpsilon {
            return CGVector(dx: 1, dy: 0)
        }
        return vector.scaled(by: 1 / length)
    }
}
