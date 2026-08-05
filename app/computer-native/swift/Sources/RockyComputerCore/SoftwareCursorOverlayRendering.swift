/**
 * SoftwareCursorOverlay 渲染层：placeCursor / 动力学推进 / clamp / 几何辅助。
 *
 * 逐字对齐 open-codex `initialRenderState / seedVisualDynamicsIfNeeded / advanceVisualDynamics
 * / placeCursor / writeObservationSnapshot / clampTipPosition / screen / pumpFrame / pause
 * / distanceBetween / defaultInitialTipPosition / currentForwardVector / restingForwardVector
 * / forwardVector / windowConstraintHitCount / motionBounds / candidatePreference / windowID
 * / isWindowPresent / refreshActiveOrderingIfNeeded`（v0.0.160 gap#11 拆分）。
 *
 * 参考: refs/open-codex-computer-use/.../SoftwareCursorOverlay.swift
 */

import AppKit
import CoreGraphics
import Foundation
import QuartzCore

@MainActor
extension SoftwareCursorOverlay {
    // MARK: - 光标状态推进 + 上屏

    /// 屏幕左上角起的默认 tip 位置（overlay 首次显示前）。
    static func defaultInitialTipPosition() -> CGPoint {
        defaultVisualCursorInitialTipPosition(
            windowOrigin: .zero,
            tipAnchor: artwork.geometry.tipAnchor
        )
    }

    /// 首次显示时的渲染态（无速度/无雾偏移，仅 tip 位置就位）。
    static func initialRenderState(at tipPosition: CGPoint) -> CursorVisualRenderState {
        CursorVisualRenderState(
            tipPosition: tipPosition,
            rotation: 0,
            cursorBodyOffset: CGVector(dx: 0, dy: 0),
            fogOffset: CGVector(dx: 0, dy: 0),
            fogOpacity: CursorVisualDynamicsConfiguration.officialInspired.fogOpacityBase,
            fogScale: 1
        )
    }

    /// 首次动力学需 seed 状态：给定 tip 位置 + 时间作为初值。
    static func seedVisualDynamicsIfNeeded(at tipPosition: CGPoint, time: CFTimeInterval) {
        guard visualDynamicsState == nil else {
            return
        }

        visualDynamicsState = CursorVisualDynamicsAnimator.state(
            at: tipPosition,
            time: CGFloat(time)
        )
    }

    /// 推进动力学模拟至目标 tip 位置 + 目标时间，返回渲染态。
    static func advanceVisualDynamics(
        toward targetTipPosition: CGPoint,
        idleAngleOffset: CGFloat = 0,
        at time: CFTimeInterval
    ) -> CursorVisualRenderState {
        let clampedTarget = clampTipPosition(targetTipPosition)
        seedVisualDynamicsIfNeeded(at: clampedTarget, time: time)

        let result = CursorVisualDynamicsAnimator.advance(
            state: visualDynamicsState ?? CursorVisualDynamicsAnimator.state(at: clampedTarget, time: CGFloat(time)),
            targetTipPosition: clampedTarget,
            targetTime: CGFloat(time),
            idleAngleOffset: idleAngleOffset,
            baseHeading: renderBaseHeading,
            renderYAxisMultiplier: renderYAxisMultiplier
        )
        visualDynamicsState = result.state
        return result.renderState
    }

    /// 把渲染态应用到 panel + 视图（面板位置 + 视图属性 + 触发重绘）。
    static func placeCursor(using renderState: CursorVisualRenderState, clickProgress: CGFloat) {
        guard let panel, let cursorView else {
            return
        }

        panel.setFrameOrigin(artwork.geometry.origin(forTipPosition: renderState.tipPosition))
        cursorView.rotation = renderState.rotation
        cursorView.cursorBodyOffset = renderState.cursorBodyOffset
        cursorView.fogOffset = renderState.fogOffset
        cursorView.fogOpacity = renderState.fogOpacity
        cursorView.fogScale = renderState.fogScale
        cursorView.clickProgress = clickProgress
        cursorView.needsDisplay = true
        displayedTipPosition = renderState.tipPosition
        writeObservationSnapshot(
            tipPosition: renderState.tipPosition,
            rotation: renderState.rotation
        )
    }

    /// 写观测快照到文件（debug 用，只有 env 显式指定路径时才写；写失败静默）。
    static func writeObservationSnapshot(tipPosition: CGPoint?, rotation: CGFloat?) {
        guard
            let url = visualCursorObservationFileURL(environment: ProcessInfo.processInfo.environment)
        else {
            return
        }

        let snapshot = VisualCursorObservationSnapshot(
            phase: observationPhase,
            tipPosition: tipPosition,
            restingTipPosition: restingTipPosition,
            rotation: rotation,
            timestamp: CACurrentMediaTime()
        )

        do {
            let directory = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(snapshot)
            try data.write(to: url, options: .atomic)
        } catch {
            // 观测仅 debug 用，不能影响真实工具执行。
        }
    }

    // MARK: - 几何辅助

    /// 将 tip 位置钳到可见屏幕范围（保 overlay 不超屏）。
    static func clampTipPosition(_ tipPosition: CGPoint) -> CGPoint {
        guard let screen = screen(containing: tipPosition) ?? NSScreen.main ?? NSScreen.screens.first else {
            return tipPosition
        }

        let visibleFrame = screen.visibleFrame
        let minX = visibleFrame.minX + artwork.geometry.tipAnchor.x
        let maxX = visibleFrame.maxX - (artwork.geometry.windowSize.width - artwork.geometry.tipAnchor.x)
        let minY = visibleFrame.minY + artwork.geometry.tipAnchor.y
        let maxY = visibleFrame.maxY - (artwork.geometry.windowSize.height - artwork.geometry.tipAnchor.y)

        return CGPoint(
            x: tipPosition.x.clamped(to: minX...maxX),
            y: tipPosition.y.clamped(to: minY...maxY)
        )
    }

    static func screen(containing point: CGPoint) -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(point) }
    }

    static func distanceBetween(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(rhs.x - lhs.x, rhs.y - lhs.y)
    }

    // MARK: - 主 run loop 泵帧（addon 无 main run loop 时无操作，见 change_plan G-1 约束）

    /// 泵一帧主 run loop（120fps 上限），推进动画。
    static func pumpFrame() {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(1 / 120))
    }

    /// 阻塞等待 duration 秒，期间持续泵帧维持动画流畅。
    static func pause(for duration: TimeInterval) {
        let start = CACurrentMediaTime()
        while CACurrentMediaTime() - start < duration {
            pumpFrame()
        }
    }

    // MARK: - 朝向向量（供 HeadingDrivenCursorMotionModel 选路径）

    static func currentForwardVector() -> CGVector {
        let renderRotation = cursorView?.rotation ?? 0
        return forwardVector(renderRotation: renderRotation)
    }

    static func restingForwardVector() -> CGVector {
        forwardVector(renderRotation: 0)
    }

    static func forwardVector(renderRotation: CGFloat) -> CGVector {
        let angle = visualCursorAppKitForwardHeading(renderRotation: renderRotation)
        return CGVector(dx: cos(angle), dy: sin(angle))
    }

    // MARK: - 窗口重合度 + 排序辅助

    /// 数一条路径采样点中命中目标窗口的次数（避免路径穿过遮挡窗）。
    static func windowConstraintHitCount(
        for path: CursorMotionPath,
        relativeTo targetWindow: CursorTargetWindow,
        excludingWindowNumber: Int
    ) -> Int {
        path.sampledConstraintPoints().reduce(into: 0) { result, point in
            if windowID(at: point, excludingWindowNumber: excludingWindowNumber) == targetWindow.windowID {
                result += 1
            }
        }
    }

    /// 计算路径运动范围（跨屏时联合两屏可见区域）。
    static func motionBounds(from start: CGPoint, to end: CGPoint) -> CGRect? {
        let startScreen = screen(containing: start) ?? NSScreen.main ?? NSScreen.screens.first
        let endScreen = screen(containing: end) ?? startScreen

        switch (startScreen, endScreen) {
        case let (startScreen?, endScreen?) where startScreen === endScreen:
            return startScreen.visibleFrame
        case let (startScreen?, endScreen?):
            return startScreen.visibleFrame.union(endScreen.visibleFrame)
        case let (screen?, nil), let (nil, screen?):
            return screen.visibleFrame
        default:
            return nil
        }
    }

    /// 候选偏好排序：优先在屏内 → score 小 → identifier 字典序稳定。
    static func candidatePreference(_ lhs: CursorMotionCandidate, _ rhs: CursorMotionCandidate) -> Bool {
        if lhs.measurement.staysInBounds != rhs.measurement.staysInBounds {
            return lhs.measurement.staysInBounds && !rhs.measurement.staysInBounds
        }
        if lhs.score != rhs.score {
            return lhs.score < rhs.score
        }
        return lhs.identifier < rhs.identifier
    }

    /// 查询屏幕点归属的窗口 ID（排除 overlay 自身）。
    static func windowID(at point: CGPoint, excludingWindowNumber: Int) -> CGWindowID? {
        let windowNumber = NSWindow.windowNumber(
            at: NSPoint(x: point.x, y: point.y),
            belowWindowWithWindowNumber: excludingWindowNumber
        )

        guard windowNumber > 0 else {
            return nil
        }

        return CGWindowID(windowNumber)
    }

    /// 判目标窗口是否仍存在（CGWindowList 查询）。
    static func isWindowPresent(_ windowID: CGWindowID) -> Bool {
        guard windowID != 0,
              let windowInfo = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]]
        else {
            return false
        }

        return !windowInfo.isEmpty
    }

    /// 若 active target 窗口消失，则回退到普通 orderFront（避免 overlay 卡在死窗口层级）。
    static func refreshActiveOrderingIfNeeded() {
        guard let activeTargetWindow else {
            return
        }

        if isWindowPresent(activeTargetWindow.windowID) {
            configureOrdering(relativeTo: activeTargetWindow, forceReorder: true)
            return
        }

        configureOrdering(relativeTo: nil)
    }
}
