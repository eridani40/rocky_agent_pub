import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

// 单窗口截图 —— ScreenCaptureKit（SCContentFilter desktopIndependentWindow）+ Retina scaleFactor
// + bounded PNG（≤900KB / ≤1280px 降采样）。从旧 swift-helper Screenshot.swift 逐字迁入 addon 包。
// 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.3 Spike 2 + P1-B
//
// SCScreenshotManager.captureImage 是 async；BlockingBridge.run 用 semaphore 桥到 addon 的
// AsyncWorker 同步执行线程（off-main worker，Task 在 Swift 并发全局执行器另跑，wait 不死锁）。
// 与旧 spawn helper 唯一区别：调用方从 stdin 循环线程变为 N-API AsyncWorker::Execute 线程，
// 同步阻塞语义一致（Spike 2 目标：验证 ScreenCaptureKit async 在 node-gyp addon 内跑通）。

/// 截图结果（供 Service.screenshot 序列化返 TS）
struct CapturedWindow {
    let pid: pid_t
    let bounds: CGRect  // point 坐标系，y-down
    let base64: String
    let width: Int
    let height: Int
    let scaleFactor: Double
}

private let screenshotMaxBytes = 900_000
private let screenshotMaxDimension: CGFloat = 1280
private let screenshotMinScale: CGFloat = 0.25

enum ScreenCapture {
    /// 截 appHint（bundle id / 名称）指向 app 的前窗；nil → 前台非本进程 app
    static func capture(appHint: String?) throws -> CapturedWindow {
        let snapshot = Permissions.snapshot()
        guard snapshot.screenRecording else {
            throw ComputerUseError.permissionMissing(which: "screen_recording")
        }
        guard let target = frontWindow(appHint: appHint) else {
            throw ComputerUseError.appNotFound(appHint ?? "frontmost")
        }
        let image = try BlockingBridge.run(timeout: 5) {
            try await captureImage(windowID: target.windowID, bounds: target.bounds)
        }
        guard let image, let png = boundedPNGData(image) else {
            throw ComputerUseError.message("screenshot capture/encode failed")
        }
        return CapturedWindow(
            pid: target.pid,
            bounds: target.bounds,
            base64: png.base64EncodedString(),
            width: image.width,
            height: image.height,
            scaleFactor: Double(scaleFactor(for: target.bounds))
        )
    }

    private struct WindowRef {
        let windowID: CGWindowID
        let pid: pid_t
        let bounds: CGRect
    }

    /// CGWindowListCopyWindowInfo 找目标 app 的最前 layer-0 窗口。
    private static func frontWindow(appHint: String?) -> WindowRef? {
        let selfPid = ProcessInfo.processInfo.processIdentifier
        let targetPid: pid_t? = resolvePid(appHint: appHint)
        guard let infoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        var best: WindowRef?
        var bestArea: CGFloat = 0
        for info in infoList {
            guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner != selfPid,
                  let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let windowNumber = info[kCGWindowNumber as String] as? Int,
                  let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { continue }
            if let targetPid, owner != targetPid { continue }
            let area = bounds.width * bounds.height
            if area >= 20_000, area > bestArea {
                bestArea = area
                best = WindowRef(windowID: CGWindowID(windowNumber), pid: owner, bounds: bounds)
            }
        }
        return best
    }

    /// appHint（bundle id / localizedName）→ pid；nil → 前台 app pid
    private static func resolvePid(appHint: String?) -> pid_t? {
        let apps = NSWorkspace.shared.runningApplications
        if let hint = appHint, !hint.isEmpty {
            let match = apps.first { $0.bundleIdentifier == hint || $0.localizedName == hint }
            return match?.processIdentifier
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    private static func scaleFactor(for bounds: CGRect) -> CGFloat {
        NSScreen.screens.first(where: { $0.frame.intersects(bounds) })?.backingScaleFactor
            ?? NSScreen.main?.backingScaleFactor ?? 1
    }

    private static func captureImage(windowID: CGWindowID, bounds: CGRect) async throws -> CGImage? {
        let content = try await SCShareableContent.current
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else { return nil }
        let config = SCStreamConfiguration()
        let sf = scaleFactor(for: bounds)
        let size = window.frame.isEmpty ? bounds.size : window.frame.size
        config.width = max(1, Int(ceil(size.width * sf)))
        config.height = max(1, Int(ceil(size.height * sf)))
        config.showsCursor = false
        config.scalesToFit = false
        config.ignoreShadowsSingleWindow = true
        let filter = SCContentFilter(desktopIndependentWindow: window)
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    /// PNG ≤900KB 直接返回；否则逐步降采样（scale *= 0.85，下限 0.25）。
    private static func boundedPNGData(_ image: CGImage) -> Data? {
        guard image.width > 0, image.height > 0 else { return nil }
        let largest = CGFloat(max(image.width, image.height))
        var scale = min(1, screenshotMaxDimension / largest)
        let original = pngData(image)
        if scale >= 1, let original, original.count <= screenshotMaxBytes { return original }
        var best = original
        while scale >= screenshotMinScale {
            guard let resized = resized(image, scale: scale), let data = pngData(resized) else { break }
            best = data
            if data.count <= screenshotMaxBytes { return data }
            scale *= 0.85
        }
        return best
    }

    private static func pngData(_ image: CGImage) -> Data? {
        NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }

    private static func resized(_ image: CGImage, scale: CGFloat) -> CGImage? {
        let w = max(1, Int((CGFloat(image.width) * scale).rounded()))
        let h = max(1, Int((CGFloat(image.height) * scale).rounded()))
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }
}

/// async → sync 阻塞桥（addon AsyncWorker::Execute 是同步执行线程，ScreenCaptureKit API 是 async）。
/// Task 在 Swift 并发全局执行器（独立线程池）跑，semaphore 在 worker 线程等待 → 不自我死锁。
enum BlockingBridge {
    static func run<T>(timeout: TimeInterval, _ op: @escaping () async throws -> T) throws -> T {
        let sem = DispatchSemaphore(value: 0)
        let box = ResultBox<T>()
        Task {
            do { box.value = .success(try await op()) } catch { box.value = .failure(error) }
            sem.signal()
        }
        if sem.wait(timeout: .now() + timeout) == .timedOut {
            throw ComputerUseError.message("operation timed out (\(timeout)s)")
        }
        switch box.value {
        case let .success(v): return v
        case let .failure(e): throw e
        case .none: throw ComputerUseError.message("operation produced no result")
        }
    }

    private final class ResultBox<T>: @unchecked Sendable {
        var value: Result<T, Error>?
    }
}
