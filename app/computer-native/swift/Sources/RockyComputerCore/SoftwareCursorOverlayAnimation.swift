/**
 * SoftwareCursorOverlay 动画层：移动 / 点击 pulse / idle 呼吸 / 淡出隐藏。
 *
 * 逐字对齐 open-codex `animateMove` / `bestMotionCandidate` / `animateClickPulse`
 * / `startIdleAnimation` / `stopIdleAnimation` / `scheduleHide` / `cancelPendingHide`
 * / `hideOverlay`（v0.0.160 gap#11 拆分）。
 *
 * 全部方法都是 `SoftwareCursorOverlay` 主 enum 的扩展，@MainActor 隔离。
 * 参考: refs/open-codex-computer-use/.../SoftwareCursorOverlay.swift
 */

import AppKit
import CoreGraphics
import Foundation
import QuartzCore

@MainActor
extension SoftwareCursorOverlay {
    // MARK: - 移动动画（spring-timed 曲线路径）

    /// 从 start → end 沿最优 CursorMotion 候选曲线动画移动光标。
    static func animateMove(from start: CGPoint, to end: CGPoint, relativeTo targetWindow: CursorTargetWindow?) {
        let candidate = bestMotionCandidate(from: start, to: end, relativeTo: targetWindow)
        let path = candidate.path
        // 用 OfficialCursorMotionModel 校准过的 spring 时长（不用旧的距离压缩本地时长，
        // 否则中/长距离感觉明显比参考实现快）。
        let duration = OfficialCursorMotionModel.calibratedTravelDuration(
            distance: distanceBetween(start, end),
            measurement: candidate.measurement
        )
        let springTargetDuration = OfficialCursorMotionModel.closeEnoughTime
        let startTime = CACurrentMediaTime()
        var progress: CGFloat = 0
        var springState = CursorMotionSpringState()

        while true {
            refreshActiveOrderingIfNeeded()

            let elapsed = CGFloat(CACurrentMediaTime() - startTime)
            let normalizedElapsed = (elapsed / max(duration, 0.001)).clamped(to: 0...1)
            let springTime = normalizedElapsed * springTargetDuration
            (progress, springState) = CursorMotionProgressAnimator.advance(
                current: progress,
                state: springState,
                to: springTime
            )

            let sample = path.sample(at: progress)
            placeCursor(
                using: advanceVisualDynamics(
                    toward: sample.point,
                    at: CACurrentMediaTime()
                ),
                clickProgress: 0
            )

            if normalizedElapsed >= 1 || CursorMotionProgressAnimator.isCloseEnough(progress: progress) {
                break
            }

            pumpFrame()
        }

        placeCursor(
            using: advanceVisualDynamics(
                toward: end,
                at: CACurrentMediaTime()
            ),
            clickProgress: 0
        )
    }

    /// 选择最优路径候选：优先与目标窗口重合度高的（避免路径穿过其他窗口遮挡）。
    static func bestMotionCandidate(
        from start: CGPoint,
        to end: CGPoint,
        relativeTo targetWindow: CursorTargetWindow?
    ) -> CursorMotionCandidate {
        let bounds = motionBounds(from: start, to: end)
        let candidates = HeadingDrivenCursorMotionModel.makeCandidates(
            start: start,
            end: end,
            bounds: bounds,
            startForward: currentForwardVector(),
            endForward: restingForwardVector()
        )
        let defaultCandidate = HeadingDrivenCursorMotionModel.chooseBestCandidate(from: candidates)
            ?? CursorMotionCandidate(
                identifier: "legacy-fallback",
                kind: .base,
                side: 0,
                tableAScale: nil,
                tableBScale: nil,
                path: CursorMotionPath(start: start, end: end),
                measurement: CursorMotionPath(start: start, end: end).measure(bounds: bounds),
                score: 0
            )

        guard let targetWindow else {
            return defaultCandidate
        }

        let excludingWindowNumber = max(panel?.windowNumber ?? 0, 0)
        let evaluations = candidates.map { candidate in
            (
                candidate: candidate,
                hitCount: windowConstraintHitCount(
                    for: candidate.path,
                    relativeTo: targetWindow,
                    excludingWindowNumber: excludingWindowNumber
                )
            )
        }

        let totalSampleCount = candidates.first?.path.sampledConstraintPoints().count ?? 0
        let bestHitCount = evaluations.map(\.hitCount).max() ?? 0

        if bestHitCount == totalSampleCount, bestHitCount > 0 {
            return evaluations
                .filter { $0.hitCount == bestHitCount }
                .map(\.candidate)
                .sorted(by: candidatePreference)
                .first ?? defaultCandidate
        }

        if bestHitCount > 0 {
            return evaluations
                .filter { $0.hitCount == bestHitCount }
                .map(\.candidate)
                .sorted(by: candidatePreference)
                .first ?? defaultCandidate
        }

        return defaultCandidate
    }

    // MARK: - 点击 pulse 动画

    /// 点击 pulse 动画：每次点击一个 sinusoidal pulse（右键幅度略低）。
    static func animateClickPulse(at point: CGPoint, clickCount: Int, mouseButton: MouseButtonKind) {
        let pulseBias: CGFloat = mouseButton == .right ? 0.82 : 1

        for pulse in 0..<clickCount {
            let duration = 0.16
            let startTime = CACurrentMediaTime()

            while true {
                let elapsed = CACurrentMediaTime() - startTime
                let rawProgress = min(max(elapsed / duration, 0), 1)
                let clickProgress = sin(rawProgress * .pi) * pulseBias

                placeCursor(
                    using: advanceVisualDynamics(
                        toward: point,
                        at: CACurrentMediaTime()
                    ),
                    clickProgress: clickProgress
                )

                if rawProgress >= 1 {
                    break
                }

                pumpFrame()
            }

            if pulse < clickCount - 1 {
                pause(for: 0.05)
            }
        }

        placeCursor(
            using: advanceVisualDynamics(
                toward: point,
                at: CACurrentMediaTime()
            ),
            clickProgress: 0
        )
    }

    // MARK: - idle 呼吸动画 + 定时隐藏

    /// 启动 idle 呼吸动画（60fps 定时器，静息 tip 位置 + 呼吸角度）。
    static func startIdleAnimation() {
        guard canPresentOverlay, let restingTipPosition else {
            return
        }

        observationPhase = "idle"
        idlePhase = 0
        let timer = Timer(timeInterval: 1 / 60, repeats: true) { _ in
            MainActor.assumeIsolated {
                guard panel != nil, cursorView != nil else {
                    return
                }

                refreshActiveOrderingIfNeeded()

                observationPhase = "idle"
                idlePhase += 0.05
                let idlePose = visualCursorIdlePose(
                    restingTipPosition: restingTipPosition,
                    phase: idlePhase
                )

                placeCursor(
                    using: advanceVisualDynamics(
                        toward: idlePose.tipPosition,
                        idleAngleOffset: idlePose.angleOffset,
                        at: CACurrentMediaTime()
                    ),
                    clickProgress: 0
                )
            }
        }

        RunLoop.main.add(timer, forMode: .common)
        idleTimer = timer

        placeCursor(
            using: advanceVisualDynamics(
                toward: restingTipPosition,
                at: CACurrentMediaTime()
            ),
            clickProgress: 0
        )
    }

    /// 停止 idle 呼吸动画。
    static func stopIdleAnimation() {
        idleTimer?.invalidate()
        idleTimer = nil
    }

    /// 安排 N 秒后隐藏 overlay（覆盖已有 hide 定时器）。
    static func scheduleHide(after delay: TimeInterval) {
        cancelPendingHide()
        let timer = Timer(timeInterval: delay, repeats: false) { _ in
            MainActor.assumeIsolated {
                hideOverlay()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        hideTimer = timer
    }

    /// 取消未触发的隐藏定时器。
    static func cancelPendingHide() {
        hideTimer?.invalidate()
        hideTimer = nil
    }

    /// 淡出隐藏 overlay，动画完成后清所有状态。
    static func hideOverlay() {
        guard let panel else {
            return
        }

        stopIdleAnimation()
        cancelPendingHide()

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().alphaValue = 0
        } completionHandler: {
            MainActor.assumeIsolated {
                panel.orderOut(nil)
                panel.alphaValue = 1
                displayedTipPosition = nil
                restingTipPosition = nil
                activeTargetWindow = nil
                visualDynamicsState = nil
                observationPhase = "hidden"
                writeObservationSnapshot(tipPosition: nil, rotation: nil)
            }
        }
    }
}
