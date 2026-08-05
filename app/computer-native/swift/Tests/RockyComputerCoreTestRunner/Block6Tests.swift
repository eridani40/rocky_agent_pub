import CoreGraphics
import Foundation

@testable import RockyComputerCore

// Block6Tests —— v0.0.160 块 6（SoftwareCursorOverlay 视觉光标）UT，覆盖 gap #11。
//
// 覆盖范围（纯数学 + 纯逻辑辅助函数；SoftwareCursorOverlay 主体依赖 NSWindow / NSScreen /
// 主线程 run loop，不可 UT，需 dev dogfood 手验）：
//   - VisualCursorSupport env 门禁解析（默认关，Rocky 侧适配）
//   - CursorMotionPath.sample 端点边界 + 中点采样
//   - CursorMotionPath.sampledConstraintPoints 数量
//   - CursorMotionSpring.advance close-enough 收敛
//   - CGVector 扩展（length / normalized / perpendicular / scaled）
//   - HeadingDrivenCursorMotionModel.signedAngle / normalizedOrDefault
//   - CursorVisualDynamicsAnimator.state seeding
//   - shouldReorderCursorPanel 逻辑分支
//   - CursorWindowGeometry origin ↔ tipPosition 互逆
//   - visualCursorScreenStateVelocity y 轴翻转
//   - visualCursorIdlePose sin 振幅有界
//
// 参考: specs/tech/version_logs/v0.0.160/change_plan.md 模块 G

func runBlock6Tests() {
    // MARK: - visualCursorEnabled（env 门禁）

    expect(visualCursorEnabled(environment: [:]) == false,
           "visualCursorEnabled 未设 = 关（Rocky 默认关）")
    expect(visualCursorEnabled(environment: ["ROCKY_CU_VISUAL_CURSOR": ""]) == false,
           "visualCursorEnabled 空字符串 = 关")
    expect(visualCursorEnabled(environment: ["ROCKY_CU_VISUAL_CURSOR": "1"]) == true,
           "visualCursorEnabled '1' = 开")
    expect(visualCursorEnabled(environment: ["ROCKY_CU_VISUAL_CURSOR": "true"]) == true,
           "visualCursorEnabled 'true' = 开")
    expect(visualCursorEnabled(environment: ["ROCKY_CU_VISUAL_CURSOR": "yes"]) == true,
           "visualCursorEnabled 'yes' = 开")
    expect(visualCursorEnabled(environment: ["ROCKY_CU_VISUAL_CURSOR": "ON"]) == true,
           "visualCursorEnabled 'ON' 大小写归一 = 开")
    expect(visualCursorEnabled(environment: ["ROCKY_CU_VISUAL_CURSOR": "  true  "]) == true,
           "visualCursorEnabled trim + lowercase = 开")
    expect(visualCursorEnabled(environment: ["ROCKY_CU_VISUAL_CURSOR": "0"]) == false,
           "visualCursorEnabled '0' = 关")
    expect(visualCursorEnabled(environment: ["ROCKY_CU_VISUAL_CURSOR": "off"]) == false,
           "visualCursorEnabled 'off' = 关")
    expect(visualCursorEnabled(environment: ["ROCKY_CU_VISUAL_CURSOR": "garbage"]) == false,
           "visualCursorEnabled 无法识别值 = 关（保守）")

    // MARK: - CursorMotionPath.sample 端点

    do {
        let path = CursorMotionPath(start: CGPoint(x: 0, y: 0), end: CGPoint(x: 100, y: 0))
        let s = path.sample(at: 0)
        expect(abs(s.point.x - 0) < 0.001 && abs(s.point.y - 0) < 0.001,
               "CursorMotionPath.sample(0) → start")
        let e = path.sample(at: 1)
        expect(abs(e.point.x - 100) < 0.001 && abs(e.point.y - 0) < 0.001,
               "CursorMotionPath.sample(1) → end")
    }

    // MARK: - CursorMotionPath.sampledConstraintPoints

    do {
        let path = CursorMotionPath(start: .zero, end: CGPoint(x: 100, y: 100))
        let pts = path.sampledConstraintPoints(samplesPerSegment: 6)
        expect(pts.count == 6, "sampledConstraintPoints 单段 6 采样 = 6 点")
    }

    // MARK: - CursorMotionSpring 收敛

    do {
        let (_, state) = CursorMotionProgressAnimator.advance(
            current: 0, state: CursorMotionSpringState()
        )
        expect(state.time > 0, "SpringAnimator.advance 时间增加")
        expect(state.velocity != 0, "SpringAnimator.advance 初步产生速度")

        let closeTime = CursorMotionProgressAnimator.closeEnoughTime()
        expect(closeTime > 0 && closeTime < 4,
               "closeEnoughTime 收敛在合理时长（0-4s）")
        expect(CursorMotionProgressAnimator.isCloseEnough(progress: 1.0),
               "isCloseEnough progress=1 → true")
        expect(!CursorMotionProgressAnimator.isCloseEnough(progress: 0.5),
               "isCloseEnough progress=0.5 → false")
    }

    // MARK: - CGVector 扩展

    do {
        let v = CGVector(dx: 3, dy: 4)
        expect(abs(v.length - 5) < 0.001, "CGVector.length 3-4-5 三角 = 5")
        let n = v.normalized
        expect(abs(n.length - 1) < 0.001, "CGVector.normalized 长度 = 1")
        let p = v.perpendicular
        expect(p.dx == -4 && p.dy == 3, "CGVector.perpendicular (3,4) → (-4,3)")
        let s = v.scaled(by: 2)
        expect(s.dx == 6 && s.dy == 8, "CGVector.scaled(2) = (6,8)")
    }

    // MARK: - HeadingDrivenCursorMotionModel signed math

    do {
        let a = CGVector(dx: 1, dy: 0)
        let b = CGVector(dx: 0, dy: 1)
        let angle = HeadingDrivenCursorMotionModel.signedAngle(from: a, to: b)
        expect(abs(angle - .pi / 2) < 0.001, "signedAngle (1,0)→(0,1) = π/2")
        let angleRev = HeadingDrivenCursorMotionModel.signedAngle(from: b, to: a)
        expect(abs(angleRev - (-.pi / 2)) < 0.001, "signedAngle (0,1)→(1,0) = -π/2")

        // normalizedOrDefault 用 epsilon 除法保数值稳定（零向量 → 结果仍 (0,0)，不崩不 NaN）
        let zeroDiv = HeadingDrivenCursorMotionModel.normalizedOrDefault(CGVector(dx: 0, dy: 0))
        expect(zeroDiv.dx == 0 && zeroDiv.dy == 0,
               "normalizedOrDefault 零向量 → (0,0) 且不 NaN/inf")
        let unit = HeadingDrivenCursorMotionModel.normalizedOrDefault(CGVector(dx: 3, dy: 4))
        expect(abs(unit.length - 1) < 0.001,
               "normalizedOrDefault (3,4) → unit vector")
    }

    // MARK: - CursorVisualDynamicsAnimator.state seeding

    do {
        let s = CursorVisualDynamicsAnimator.state(at: CGPoint(x: 10, y: 20), time: 5)
        expect(s.time == 5, "VisualDynamics.state.time seeded")
        expect(s.tipPosition.x == 10 && s.tipPosition.y == 20,
               "VisualDynamics.state.tipPosition seeded")
        expect(s.tipVelocity.dx == 0 && s.tipVelocity.dy == 0,
               "VisualDynamics.state 初始速度 = 0")
    }

    // MARK: - shouldReorderCursorPanel

    do {
        let w1 = CursorTargetWindow(windowID: 1, layer: 0)
        let w2 = CursorTargetWindow(windowID: 2, layer: 0)

        expect(shouldReorderCursorPanel(activeTargetWindow: nil, effectiveTargetWindow: nil,
                                        panelIsVisible: false, forceReorder: false) == true,
               "shouldReorderCursorPanel 面板不可见 → true")
        expect(shouldReorderCursorPanel(activeTargetWindow: w1, effectiveTargetWindow: w1,
                                        panelIsVisible: true, forceReorder: false) == false,
               "shouldReorderCursorPanel 状态一致 + 可见 → false")
        expect(shouldReorderCursorPanel(activeTargetWindow: w1, effectiveTargetWindow: w2,
                                        panelIsVisible: true, forceReorder: false) == true,
               "shouldReorderCursorPanel active != effective → true")
        expect(shouldReorderCursorPanel(activeTargetWindow: w1, effectiveTargetWindow: w1,
                                        panelIsVisible: true, forceReorder: true) == true,
               "shouldReorderCursorPanel forceReorder → true")
    }

    // MARK: - CursorWindowGeometry 互逆

    do {
        let geom = CursorWindowGeometry(
            windowSize: CGSize(width: 100, height: 100),
            tipAnchor: CGPoint(x: 40, y: 60)
        )
        let tip = CGPoint(x: 200, y: 300)
        let origin = geom.origin(forTipPosition: tip)
        expect(origin.x == 160 && origin.y == 240,
               "CursorWindowGeometry.origin = tip - anchor")
        let backTip = geom.tipPosition(forOrigin: origin)
        expect(abs(backTip.x - tip.x) < 0.001 && abs(backTip.y - tip.y) < 0.001,
               "CursorWindowGeometry.origin/tipPosition 互逆")
    }

    // MARK: - visualCursorScreenStateVelocity y 轴翻转

    do {
        let v = CGVector(dx: 3, dy: 4)
        let flipped = visualCursorScreenStateVelocity(fromRuntimeVelocity: v, yAxisMultiplier: -1)
        expect(flipped.dx == 3 && flipped.dy == -4,
               "visualCursorScreenStateVelocity y=-1 翻转 dy 符号")

        let same = visualCursorScreenStateVelocity(fromRuntimeVelocity: v, yAxisMultiplier: 1)
        expect(same.dx == 3 && same.dy == 4,
               "visualCursorScreenStateVelocity y=1 不变")
    }

    // MARK: - visualCursorIdlePose 振幅有界

    do {
        let resting = CGPoint(x: 100, y: 200)
        let amplitude = visualCursorIdleRotationAmplitude()
        for phase: CGFloat in stride(from: 0, through: 20, by: 0.5) {
            let pose = visualCursorIdlePose(restingTipPosition: resting, phase: phase)
            expect(pose.tipPosition.x == resting.x && pose.tipPosition.y == resting.y,
                   "visualCursorIdlePose tip 恒等 resting phase=\(phase)")
            expect(abs(pose.angleOffset) <= amplitude + 0.001,
                   "visualCursorIdlePose angleOffset ∈ [-amp, amp] phase=\(phase)")
        }
    }

    // MARK: - visualCursorPostInteractionIdleTimeout 常量

    expect(visualCursorPostInteractionIdleTimeout() == 30,
           "visualCursorPostInteractionIdleTimeout = 30s（open-codex 逐字）")

    // MARK: - CGFloat.clamped

    do {
        let v: CGFloat = 5
        expect(v.clamped(to: 0...10) == 5, "clamped 在范围内 → 原值")
        expect(CGFloat(15).clamped(to: 0...10) == 10, "clamped 超上限 → upper")
        expect(CGFloat(-5).clamped(to: 0...10) == 0, "clamped 低下限 → lower")
        expect(CGFloat.clamped(15, lower: 0, upper: 10) == 10, "clamped(_:lower:upper:) 超上限")
    }

    // MARK: - CursorMotionKind rawValue（逐字对齐 open-codex）

    expect(CursorMotionKind.base.rawValue == "base", "CursorMotionKind.base = 'base'")
    expect(CursorMotionKind.arched.rawValue == "arched", "CursorMotionKind.arched = 'arched'")

    // MARK: - SoftwareCursorGlyphMetrics 常量（逐字对齐 open-codex）

    expect(SoftwareCursorGlyphMetrics.windowSize == CGSize(width: 126, height: 126),
           "SoftwareCursorGlyphMetrics.windowSize = 126×126")
    expect(abs(SoftwareCursorGlyphMetrics.tipAnchor.x - 60.35) < 0.001 &&
           abs(SoftwareCursorGlyphMetrics.tipAnchor.y - 70.3) < 0.001,
           "SoftwareCursorGlyphMetrics.tipAnchor = (60.35, 70.3)")
    expect(SoftwareCursorGlyphMetrics.pointerSize == CGSize(width: 21, height: 21),
           "SoftwareCursorGlyphMetrics.pointerSize = 21×21")

    // MARK: - MotionMetrics 计算

    do {
        let m = HeadingDrivenCursorMotionModel.MotionMetrics(
            start: CGPoint(x: 0, y: 0),
            end: CGPoint(x: 100, y: 0)
        )
        expect(m.dx == 100 && m.dy == 0, "MotionMetrics dx/dy")
        expect(abs(m.distance - 100) < 0.001, "MotionMetrics distance")
        expect(abs(m.direction.dx - 1) < 0.001 && abs(m.direction.dy - 0) < 0.001,
               "MotionMetrics direction 单位化")
        expect(abs(m.horizontalFactor - 1) < 0.001, "MotionMetrics horizontalFactor = 1（纯横）")
        expect(abs(m.verticalFactor - 0) < 0.001, "MotionMetrics verticalFactor = 0")
    }

    // MARK: - rockyComputerUseTurnEndedNotificationName 命名空间

    expect(rockyComputerUseTurnEndedNotificationName.rawValue == "com.rocky.agent.turn-ended",
           "rockyComputerUseTurnEndedNotificationName = com.rocky.agent.turn-ended")
}
