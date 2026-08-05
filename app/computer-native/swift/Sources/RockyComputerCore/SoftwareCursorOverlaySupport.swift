/**
 * SoftwareCursorOverlay 支撑层：环境开关、观测快照、几何辅助、面板/视图类。
 *
 * 逐字对齐 open-codex `SoftwareCursorOverlay.swift` 前半段辅助函数与类型（v0.0.160 gap#11）。
 * Rocky 侧适配：
 *   - 环境变量改为 `ROCKY_CU_VISUAL_CURSOR`（默认关，未设 = 关；open-codex 默认开），
 *     防止 dogfood 前默认开启撞未验证真机场景。
 *   - 分布式通知名换成 Rocky 命名空间 `com.rocky.agent.turn-ended`。
 *   - 视觉光标层依赖 macOS 主线程 run loop；addon 无 main run loop，Service 调用侧
 *     一律走 `DispatchQueue.main.async` fire-and-forget（漏一处即崩，见 change_plan G-1 约束）。
 * 参考: refs/open-codex-computer-use/.../SoftwareCursorOverlay.swift
 * 参考: specs/tech/version_logs/v0.0.160/change_plan.md 模块 G
 */

import AppKit
import CoreGraphics
import Foundation
import QuartzCore

/// 视觉光标 overlay 的门禁与主线程调度助手。
public enum VisualCursorSupport {
    /// 是否启用视觉光标 overlay（环境变量 `ROCKY_CU_VISUAL_CURSOR` 显式打开）。
    public static var isEnabled: Bool {
        visualCursorEnabled(environment: ProcessInfo.processInfo.environment)
    }

    /// 把闭包投递到主线程执行；已在主线程则直接就地调用。
    /// - Important: addon 无独立 main run loop，异步任务 fire-and-forget 交由宿主主进程 loop 执行。
    static func performOnMain(_ body: @escaping @MainActor () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                body()
            }
            return
        }

        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                body()
            }
        }
    }
}

/// 解析环境变量得出 overlay 是否启用。
/// - Note: **Rocky 默认关闭**（未设/空 = 关），与 open-codex 默认开相反；显式 `1/true/yes/on` 打开。
func visualCursorEnabled(environment: [String: String]) -> Bool {
    guard let rawValue = environment["ROCKY_CU_VISUAL_CURSOR"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    else {
        return false
    }

    return ["1", "true", "yes", "on"].contains(rawValue)
}

/// 视觉光标窗口的初始 tip 位置（左上角 + tip 锚偏移）。
func defaultVisualCursorInitialTipPosition(
    windowOrigin: CGPoint = .zero,
    tipAnchor: CGPoint = SoftwareCursorGlyphMetrics.tipAnchor
) -> CGPoint {
    return CGPoint(
        x: windowOrigin.x + tipAnchor.x,
        y: windowOrigin.y + tipAnchor.y
    )
}

/// 光标绘制的中性朝向基线（来自 glyph 资源）。
func visualCursorRenderBaseHeading(
    artworkNeutralHeading: CGFloat = SoftwareCursorGlyphMetrics.targetNeutralHeading
) -> CGFloat {
    artworkNeutralHeading
}

/// AppKit 全局坐标下的前进朝向（去除绘制旋转与中性偏移）。
func visualCursorAppKitForwardHeading(
    renderRotation: CGFloat,
    artworkNeutralHeading: CGFloat = SoftwareCursorGlyphMetrics.targetNeutralHeading
) -> CGFloat {
    -artworkNeutralHeading - renderRotation
}

/// 屏幕→绘制坐标 y 轴翻转因子。AppKit 全局坐标 y 向上；CursorMotion 内部 y 向下。
func visualCursorRuntimeRenderYAxisMultiplier() -> CGFloat {
    -1
}

/// 把 runtime 速度转成绘制态屏幕坐标下的速度（应用 y 轴翻转）。
func visualCursorScreenStateVelocity(
    fromRuntimeVelocity velocity: CGVector,
    yAxisMultiplier: CGFloat
) -> CGVector {
    CGVector(dx: velocity.dx, dy: velocity.dy * yAxisMultiplier)
}

/// idle 状态后自动隐藏 overlay 的等待秒数。
func visualCursorPostInteractionIdleTimeout() -> TimeInterval {
    30
}

/// idle 呼吸旋转振幅（弧度）。
func visualCursorIdleRotationAmplitude() -> CGFloat {
    0.09
}

/// 观测点 JSON 结构（debug 模式写文件）。
public struct VisualCursorObservationPoint: Codable, Sendable {
    public let x: Double
    public let y: Double

    public init(point: CGPoint) {
        x = point.x
        y = point.y
    }
}

/// 观测快照 JSON 结构（debug 模式写文件）。
public struct VisualCursorObservationSnapshot: Codable, Sendable {
    public let phase: String
    public let tipPosition: VisualCursorObservationPoint?
    public let restingTipPosition: VisualCursorObservationPoint?
    public let rotation: Double?
    public let timestamp: Double

    public init(
        phase: String,
        tipPosition: CGPoint?,
        restingTipPosition: CGPoint?,
        rotation: CGFloat?,
        timestamp: CFTimeInterval
    ) {
        self.phase = phase
        self.tipPosition = tipPosition.map(VisualCursorObservationPoint.init(point:))
        self.restingTipPosition = restingTipPosition.map(VisualCursorObservationPoint.init(point:))
        self.rotation = rotation.map(Double.init)
        self.timestamp = timestamp
    }
}

/// idle 呼吸的 tip 位置 + 角度偏移。
struct VisualCursorIdlePose {
    let tipPosition: CGPoint
    let angleOffset: CGFloat
}

/// 由静息点 + 相位算出 idle 呼吸 pose（正弦低幅）。
func visualCursorIdlePose(restingTipPosition: CGPoint, phase: CGFloat) -> VisualCursorIdlePose {
    VisualCursorIdlePose(
        tipPosition: restingTipPosition,
        angleOffset: sin(phase * 0.8) * visualCursorIdleRotationAmplitude()
    )
}

/// 观测文件路径（debug 用），未设环境变量则不写。
public func visualCursorObservationFileURL(environment: [String: String]) -> URL? {
    guard
        let rawPath = environment["ROCKY_CU_VISUAL_CURSOR_OBSERVATION_FILE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
        !rawPath.isEmpty
    else {
        return nil
    }

    return URL(fileURLWithPath: rawPath)
}

/// Turn 结束时可 post 该分布式通知（外部调试/侦听用）。
/// - Note: 命名空间换成 Rocky（`com.rocky.agent.turn-ended`）。
public let rockyComputerUseTurnEndedNotificationName = Notification.Name(
    "com.rocky.agent.turn-ended"
)

/// Post turn-ended 分布式通知（供 Rocky 主进程侦听）。
public func postRockyComputerUseTurnEndedNotification() {
    DistributedNotificationCenter.default().postNotificationName(
        rockyComputerUseTurnEndedNotificationName,
        object: nil,
        userInfo: nil,
        deliverImmediately: true
    )
}

/// 重置视觉光标（对外便捷入口，MainActor 隔离）。
@MainActor
public func resetRockyComputerUseVisualCursor() {
    SoftwareCursorOverlay.reset()
}

/// 目标窗口标识（供 overlay 相对定位使用）。
struct CursorTargetWindow: Equatable, Sendable {
    let windowID: CGWindowID
    let layer: Int
}

/// overlay 窗口几何：窗口尺寸 + tip 锚点，负责 tip 位置 ↔ 窗口 origin 的双向换算。
struct CursorWindowGeometry {
    let windowSize: CGSize
    let tipAnchor: CGPoint

    func origin(forTipPosition tipPosition: CGPoint) -> CGPoint {
        CGPoint(
            x: tipPosition.x - tipAnchor.x,
            y: tipPosition.y - tipAnchor.y
        )
    }

    func tipPosition(forOrigin origin: CGPoint) -> CGPoint {
        CGPoint(
            x: origin.x + tipAnchor.x,
            y: origin.y + tipAnchor.y
        )
    }
}

/// overlay 使用的美术资源（当前只有 active 一种）。
struct CursorArtwork {
    let geometry: CursorWindowGeometry
    static let active = CursorArtwork(
        geometry: CursorWindowGeometry(
            windowSize: SoftwareCursorGlyphMetrics.windowSize,
            tipAnchor: SoftwareCursorGlyphMetrics.tipAnchor
        )
    )
}

/// 是否需要重新排序 overlay 面板（可测试的纯逻辑，配合 UT 覆盖）。
func shouldReorderCursorPanel(
    activeTargetWindow: CursorTargetWindow?,
    effectiveTargetWindow: CursorTargetWindow?,
    panelIsVisible: Bool,
    forceReorder: Bool
) -> Bool {
    forceReorder || activeTargetWindow != effectiveTargetWindow || panelIsVisible == false
}

/// 不接收键鼠的浮层面板。
final class CursorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// 光标绘制视图：属性变化触发 `SoftwareCursorGlyphRenderer` 重绘。
final class SoftwareCursorView: NSView {
    var rotation: CGFloat = 0
    var cursorBodyOffset: CGVector = CGVector(dx: 0, dy: 0)
    var fogOffset: CGVector = CGVector(dx: 0, dy: 0)
    var fogOpacity: CGFloat = 0.12
    var fogScale: CGFloat = 1
    var clickProgress: CGFloat = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isOpaque: Bool {
        false
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        NSColor.clear.setFill()
        dirtyRect.fill()

        guard let context = NSGraphicsContext.current?.cgContext else {
            return
        }

        SoftwareCursorGlyphRenderer.draw(
            in: bounds,
            context: context,
            state: SoftwareCursorGlyphRenderState(
                rotation: rotation,
                cursorBodyOffset: cursorBodyOffset,
                fogOffset: fogOffset,
                fogOpacity: fogOpacity,
                fogScale: fogScale,
                clickProgress: clickProgress
            )
        )
    }
}
