/**
 * CursorMotion 几何辅助：cubic Bezier 采样 + CGRect/CGPoint/CGVector/CGFloat 私有扩展。
 *
 * 逐字对齐 open-codex `CursorMotionModel.swift` §1409-§1506：cubic 采样函数 +
 * 数学运算扩展；从 `CursorMotionPath.swift` 拆出（避免主类型文件超 300 行 cap）。
 *
 * 参考: refs/open-codex-computer-use/.../CursorMotionModel.swift §1409-§1506
 */

import CoreGraphics
import Foundation

// MARK: - Cubic Bezier 采样（供 CursorMotionPath.sample 使用）

func sampleCubic(start: CGPoint, control1: CGPoint, control2: CGPoint, end: CGPoint, t: CGFloat) -> CGPoint {
    let omt = 1 - t
    let omt2 = omt * omt
    let t2 = t * t

    return CGPoint(
        x: (omt2 * omt * start.x)
            + (3 * omt2 * t * control1.x)
            + (3 * omt * t2 * control2.x)
            + (t2 * t * end.x),
        y: (omt2 * omt * start.y)
            + (3 * omt2 * t * control1.y)
            + (3 * omt * t2 * control2.y)
            + (t2 * t * end.y)
    )
}

func sampleCubicTangent(start: CGPoint, control1: CGPoint, control2: CGPoint, end: CGPoint, t: CGFloat) -> CGVector {
    let omt = 1 - t
    return CGVector(
        dx: (3 * omt * omt * (control1.x - start.x))
            + (6 * omt * t * (control2.x - control1.x))
            + (3 * t * t * (end.x - control2.x)),
        dy: (3 * omt * omt * (control1.y - start.y))
            + (6 * omt * t * (control2.y - control1.y))
            + (3 * t * t * (end.y - control2.y))
    )
}

// MARK: - 几何辅助扩展（内部使用）

extension CGRect {
    /// 带内缩 padding 判断点是否在矩形内（padding 负=向外扩，正=向内缩）。
    func contains(_ point: CGPoint, padding: CGFloat) -> Bool {
        insetBy(dx: -padding, dy: -padding).contains(point)
    }
}

extension CGPoint {
    static func + (lhs: CGPoint, rhs: CGVector) -> CGPoint {
        CGPoint(x: lhs.x + rhs.dx, y: lhs.y + rhs.dy)
    }

    static func - (lhs: CGPoint, rhs: CGVector) -> CGPoint {
        CGPoint(x: lhs.x - rhs.dx, y: lhs.y - rhs.dy)
    }

    static func - (lhs: CGPoint, rhs: CGPoint) -> CGVector {
        CGVector(dx: lhs.x - rhs.x, dy: lhs.y - rhs.y)
    }
}

extension CGVector {
    static func + (lhs: CGVector, rhs: CGVector) -> CGVector {
        CGVector(dx: lhs.dx + rhs.dx, dy: lhs.dy + rhs.dy)
    }

    static func - (lhs: CGVector, rhs: CGVector) -> CGVector {
        CGVector(dx: lhs.dx - rhs.dx, dy: lhs.dy - rhs.dy)
    }

    var length: CGFloat {
        hypot(dx, dy)
    }

    var normalized: CGVector {
        let resolvedLength = max(length, 0.001)
        return CGVector(dx: dx / resolvedLength, dy: dy / resolvedLength)
    }

    var perpendicular: CGVector {
        CGVector(dx: -dy, dy: dx)
    }

    func scaled(by factor: CGFloat) -> CGVector {
        CGVector(dx: dx * factor, dy: dy * factor)
    }

    func limited(maxLength: CGFloat) -> CGVector {
        let resolvedLength = length
        guard resolvedLength > maxLength, resolvedLength > 0.001 else {
            return self
        }

        return scaled(by: maxLength / resolvedLength)
    }
}

extension CGFloat {
    /// 三参数 clamp（下限 / 上限 显式）。
    static func clamped(_ value: CGFloat, lower: CGFloat, upper: CGFloat) -> CGFloat {
        Swift.min(Swift.max(value, lower), upper)
    }

    /// candidate identifier 使用的两位小数格式化（如 "0.55" / "1.05"）。
    var cursorIdentifier: String {
        String(format: "%.2f", Double(self))
    }

    /// clamp 到 closed range（供 progress / 系数使用）。
    func clamped(to range: ClosedRange<CGFloat>) -> CGFloat {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}
