/**
 * SoftwareCursorOverlay 主入口：public API + 窗口生命周期。
 *
 * 逐字对齐 open-codex `SoftwareCursorOverlay.swift` 主 enum + 三主命令方法（moveCursor /
 * pulseClick / settle）+ reset + 面板准备 + 排序。Rocky 侧新增 Rocky-命名的 public wrapper
 * (`moveVisualCursor / pulseVisualCursor / settleVisualCursor`) 供 Service 集成。
 *
 * 拆分归属（v0.0.160 change_plan G-1）：
 *   - Support: VisualCursorSupport / free helpers / 类型 / CursorPanel / SoftwareCursorView
 *   - **本文件**: SoftwareCursorOverlay 主 enum + public API + prepareWindow + configureOrdering + reset
 *   - Anim: animateMove + animateClickPulse + startIdleAnimation + scheduleHide + hideOverlay
 *   - Rendering: placeCursor + dynamics + clamp + observation + 几何辅助
 *
 * 参考: refs/open-codex-computer-use/.../SoftwareCursorOverlay.swift
 * 参考: specs/tech/version_logs/v0.0.160/change_plan.md 模块 G
 */

import AppKit
import CoreGraphics
import Foundation
import QuartzCore

/// 视觉光标 overlay 单例管理器。**@MainActor 隔离**，所有状态只能主线程访问。
///
/// Service 集成入口：`moveVisualCursor / pulseVisualCursor / settleVisualCursor`（Rocky 命名）。
/// 内部 open-codex 逐字对齐入口：`moveCursor / pulseClick / settle / reset`。
@MainActor
enum SoftwareCursorOverlay {
    // MARK: - 内部状态

    static let artwork = CursorArtwork.active
    static let renderBaseHeading = visualCursorRenderBaseHeading()
    static let renderYAxisMultiplier = visualCursorRuntimeRenderYAxisMultiplier()
    static var panel: CursorPanel?
    static var cursorView: SoftwareCursorView?
    static var restingTipPosition: CGPoint?
    static var displayedTipPosition: CGPoint?
    static var activeTargetWindow: CursorTargetWindow?
    static var visualDynamicsState: CursorVisualDynamicsState?
    static var idleTimer: Timer?
    static var hideTimer: Timer?
    static var idlePhase: CGFloat = 0
    static var observationPhase = "hidden"

    // MARK: - Rocky public wrappers（Service 集成入口，fire-and-forget 主线程调度）

    /// 移动光标至指定屏幕点（Rocky 命名入口）。
    /// - Parameters:
    ///   - target: 目标屏幕点（AppKit 全局坐标）
    ///   - windowInfo: 目标窗口 windowID + layer（可选，用于 overlay 相对定位）
    static nonisolated func moveVisualCursor(to target: CGPoint, in windowInfo: CursorTargetWindow? = nil) {
        VisualCursorSupport.performOnMain {
            SoftwareCursorOverlay.moveCursor(to: target, in: windowInfo)
        }
    }

    /// 触发点击 pulse 动画（Rocky 命名入口）。
    /// - Parameters:
    ///   - point: 点击屏幕点（AppKit 全局坐标）
    ///   - clickCount: 点击次数（≥1，单击/双击/三击）
    ///   - mouseButton: 鼠标按键（.left/.right 影响 pulse 视觉倾向）
    ///   - windowInfo: 目标窗口（可选）
    static nonisolated func pulseVisualCursor(
        at point: CGPoint,
        clickCount: Int,
        mouseButton: MouseButtonKind,
        in windowInfo: CursorTargetWindow? = nil
    ) {
        VisualCursorSupport.performOnMain {
            SoftwareCursorOverlay.pulseClick(
                at: point,
                clickCount: clickCount,
                mouseButton: mouseButton,
                in: windowInfo
            )
        }
    }

    /// 定位光标至静息点（Rocky 命名入口）。
    /// - Parameters:
    ///   - point: 静息屏幕点（AppKit 全局坐标）
    ///   - windowInfo: 目标窗口（可选）
    static nonisolated func settleVisualCursor(at point: CGPoint, in windowInfo: CursorTargetWindow? = nil) {
        VisualCursorSupport.performOnMain {
            SoftwareCursorOverlay.settle(at: point, in: windowInfo)
        }
    }

    // MARK: - open-codex 逐字对齐 API

    /// 移动光标到目标点（内部 API，逐字对齐 open-codex `moveCursor`）。
    static func moveCursor(to targetPoint: CGPoint, in targetWindow: CursorTargetWindow?) {
        guard VisualCursorSupport.isEnabled, canPresentOverlay else {
            return
        }

        prepareWindowIfNeeded()
        stopIdleAnimation()
        cancelPendingHide()
        configureOrdering(relativeTo: targetWindow)

        let constrainedTarget = clampTipPosition(targetPoint)
        let isFreshStart = displayedTipPosition == nil
        let startPoint = displayedTipPosition ?? defaultInitialTipPosition()
        let now = CACurrentMediaTime()

        observationPhase = "moving"
        panel?.alphaValue = 1
        if isFreshStart {
            visualDynamicsState = CursorVisualDynamicsAnimator.state(at: startPoint, time: CGFloat(now))
            placeCursor(using: initialRenderState(at: startPoint), clickProgress: 0)
        } else {
            seedVisualDynamicsIfNeeded(at: startPoint, time: now)
            placeCursor(
                using: advanceVisualDynamics(
                    toward: startPoint,
                    at: now
                ),
                clickProgress: 0
            )
        }

        if distanceBetween(startPoint, constrainedTarget) > 2 {
            animateMove(from: startPoint, to: constrainedTarget, relativeTo: targetWindow)
        }
    }

    /// 点击 pulse 动画（内部 API，逐字对齐 open-codex `pulseClick`）。
    static func pulseClick(
        at targetPoint: CGPoint,
        clickCount: Int,
        mouseButton: MouseButtonKind,
        in targetWindow: CursorTargetWindow?
    ) {
        guard VisualCursorSupport.isEnabled, canPresentOverlay else {
            return
        }

        configureOrdering(relativeTo: targetWindow)
        let constrainedTarget = clampTipPosition(targetPoint)
        let now = CACurrentMediaTime()
        seedVisualDynamicsIfNeeded(at: constrainedTarget, time: now)
        restingTipPosition = constrainedTarget
        observationPhase = "pulse"
        animateClickPulse(at: constrainedTarget, clickCount: max(clickCount, 1), mouseButton: mouseButton)
        startIdleAnimation()
        scheduleHide(after: visualCursorPostInteractionIdleTimeout())
    }

    /// 光标静息至目标点（内部 API，逐字对齐 open-codex `settle`）。
    static func settle(at targetPoint: CGPoint, in targetWindow: CursorTargetWindow?) {
        guard VisualCursorSupport.isEnabled, canPresentOverlay else {
            return
        }

        configureOrdering(relativeTo: targetWindow)
        let constrainedTarget = clampTipPosition(targetPoint)
        restingTipPosition = constrainedTarget
        observationPhase = "settling"
        placeCursor(
            using: advanceVisualDynamics(
                toward: constrainedTarget,
                at: CACurrentMediaTime()
            ),
            clickProgress: 0
        )
        startIdleAnimation()
        scheduleHide(after: visualCursorPostInteractionIdleTimeout())
    }

    /// 重置 overlay 到隐藏状态（清空所有内部记忆）。
    static func reset() {
        stopIdleAnimation()
        cancelPendingHide()
        displayedTipPosition = nil
        restingTipPosition = nil
        activeTargetWindow = nil
        visualDynamicsState = nil
        observationPhase = "hidden"
        writeObservationSnapshot(tipPosition: nil, rotation: nil)
        panel?.orderOut(nil)
    }

    // MARK: - 面板准备与排序（open-codex `prepareWindowIfNeeded` / `configureOrdering`）

    /// 是否能呈现 overlay（至少一块屏幕）。
    static var canPresentOverlay: Bool {
        !NSScreen.screens.isEmpty
    }

    /// 懒初始化 CursorPanel + 视图（只做一次）。
    static func prepareWindowIfNeeded() {
        guard panel == nil else {
            return
        }

        let panel = CursorPanel(
            contentRect: CGRect(origin: .zero, size: artwork.geometry.windowSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .normal
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.animationBehavior = .none

        let view = SoftwareCursorView(frame: CGRect(origin: .zero, size: artwork.geometry.windowSize))
        panel.contentView = view

        self.panel = panel
        self.cursorView = view
    }

    /// 配置 overlay 面板相对目标窗口的层级 + 排序（默认 forceReorder=false）。
    static func configureOrdering(relativeTo targetWindow: CursorTargetWindow?) {
        configureOrdering(relativeTo: targetWindow, forceReorder: false)
    }

    /// 配置 overlay 面板相对目标窗口的层级 + 排序。
    /// - Parameter forceReorder: true 时强制 reorder 即使当前排序未变。
    static func configureOrdering(relativeTo targetWindow: CursorTargetWindow?, forceReorder: Bool) {
        guard let panel else {
            return
        }

        let effectiveTargetWindow = targetWindow.flatMap { targetWindow in
            isWindowPresent(targetWindow.windowID) ? targetWindow : nil
        }

        let desiredLevel = NSWindow.Level(rawValue: effectiveTargetWindow?.layer ?? 0)
        if panel.level != desiredLevel {
            panel.level = desiredLevel
        }

        if shouldReorderCursorPanel(
            activeTargetWindow: activeTargetWindow,
            effectiveTargetWindow: effectiveTargetWindow,
            panelIsVisible: panel.isVisible,
            forceReorder: forceReorder
        ) {
            if let effectiveTargetWindow {
                panel.order(.above, relativeTo: Int(effectiveTargetWindow.windowID))
            } else {
                panel.orderFront(nil)
            }
            activeTargetWindow = effectiveTargetWindow
        }
    }
}
