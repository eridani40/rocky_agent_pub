/**
 * CursorMotion 弹簧动画：进度 spring 配置 + 状态 + 步进器。
 *
 * 逐字对齐 open-codex `CursorMotionModel.swift` §205-§326：
 *   - `CursorMotionSpringConfiguration`：spring 参数（response / dampingFraction /
 *     stiffness / drag / dt / close-enough 阈值）
 *   - `CursorMotionSpringState`：动画状态（time / velocity / force）
 *   - `CursorMotionProgressAnimator`：单步 + 到目标时间 + close-enough 判定 + 官方时长求解
 *
 * 参考: refs/open-codex-computer-use/.../CursorMotionModel.swift §205-§326
 */

import CoreGraphics
import Foundation

/// spring 动画配置（stiffness / drag 由 response + dampingFraction 派生）。
struct CursorMotionSpringConfiguration: Equatable {
    let response: CGFloat
    let dampingFraction: CGFloat
    let stiffness: CGFloat
    let drag: CGFloat
    let dt: CGFloat
    let closeEnoughProgressThreshold: CGFloat
    let closeEnoughDistanceThreshold: CGFloat
    let idleVelocityThreshold: CGFloat

    /// 官方参考实现的 spring 配置（response=1.4 / damping=0.9 / 240Hz 步长）。
    static let official: CursorMotionSpringConfiguration = {
        let response: CGFloat = 1.4
        let dampingFraction: CGFloat = 0.9
        let dt: CGFloat = 1.0 / 240.0
        let idleVelocityThreshold: CGFloat = 28_800
        let rawStiffness = response > 0 ? pow((2 * .pi) / response, 2) : .infinity
        let stiffness = min(rawStiffness, idleVelocityThreshold)
        let drag = 2 * dampingFraction * sqrt(stiffness)

        return CursorMotionSpringConfiguration(
            response: response,
            dampingFraction: dampingFraction,
            stiffness: stiffness,
            drag: drag,
            dt: dt,
            closeEnoughProgressThreshold: 1,
            closeEnoughDistanceThreshold: 0.01,
            idleVelocityThreshold: idleVelocityThreshold
        )
    }()
}

/// spring 动画状态（当前时间 + 速度 + 力）。
struct CursorMotionSpringState: Equatable {
    var time: CGFloat = 0
    var velocity: CGFloat = 0
    var force: CGFloat = 0
}

/// 进度 spring 步进器：把 progress 从 0 → 1 弹性拉过来。
enum CursorMotionProgressAnimator {
    /// 单步推进（一个 dt 步长）。
    static func advance(
        current: CGFloat,
        target: CGFloat = 1,
        state: CursorMotionSpringState,
        configuration: CursorMotionSpringConfiguration = .official
    ) -> (current: CGFloat, state: CursorMotionSpringState) {
        let halfDT = configuration.dt * 0.5
        let velocityHalf = state.velocity + (state.force * halfDT)
        let nextCurrent = current + (velocityHalf * configuration.dt)
        let force = (configuration.stiffness * (target - nextCurrent))
            + ((-configuration.drag) * velocityHalf)
        let velocity = velocityHalf + (force * halfDT)

        return (
            nextCurrent,
            CursorMotionSpringState(
                time: state.time + configuration.dt,
                velocity: velocity,
                force: force
            )
        )
    }

    /// 推进到目标时间（一次调用循环若干 dt 步长）。
    /// - Note: 若上次已滞后 > 1s（背景态），只补一帧避免尖刺。
    static func advance(
        current: CGFloat,
        target: CGFloat = 1,
        state: CursorMotionSpringState,
        configuration: CursorMotionSpringConfiguration = .official,
        to targetTime: CGFloat
    ) -> (current: CGFloat, state: CursorMotionSpringState) {
        var adjustedState = state
        var adjustedCurrent = current

        if (targetTime - adjustedState.time) > 1 {
            adjustedState.time = targetTime - (1.0 / 60.0)
        }

        while adjustedState.time < targetTime {
            (adjustedCurrent, adjustedState) = advance(
                current: adjustedCurrent,
                target: target,
                state: adjustedState,
                configuration: configuration
            )
        }

        return (adjustedCurrent, adjustedState)
    }

    /// 判 progress 是否已足够接近 target（阈值判定）。
    static func isCloseEnough(
        progress: CGFloat,
        target: CGFloat = 1,
        configuration: CursorMotionSpringConfiguration = .official
    ) -> Bool {
        progress >= configuration.closeEnoughProgressThreshold
            && abs(target - progress) <= configuration.closeEnoughDistanceThreshold
    }

    /// 官方参考实现：预先算出 close-enough 所需时长（一次性缓存值）。
    static func closeEnoughTime(
        configuration: CursorMotionSpringConfiguration = .official
    ) -> CGFloat {
        var current: CGFloat = 0
        var state = CursorMotionSpringState()
        var step = 0

        while step < 4_096 {
            step += 1
            let targetTime = CGFloat(step) * configuration.dt
            (current, state) = advance(
                current: current,
                target: 1,
                state: state,
                configuration: configuration,
                to: targetTime
            )

            if isCloseEnough(progress: current, configuration: configuration) {
                return state.time
            }
        }

        return 1.43
    }
}
