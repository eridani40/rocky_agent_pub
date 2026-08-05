import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// ComputerUseService —— addon 单例，持进程内 AX 快照缓存 + lastPid。11 能力：readAxTree / screenshot /
// getAppState / click / scroll / drag / type / pressKey / listApps / setValue / performSecondaryAction。
// element_index 走 lastRecords（readAxTree/getAppState 写入，last-call-wins）。
// 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.4 P1-B / v0.0.160/change_plan.md 模块 D+E

final class ComputerUseService {
    private var lastRecords: [Int: ElementRecord] = [:]
    private var lastPid: pid_t = 0
    /// 最近一次 readAxTree/getAppState 对齐 app 的 bundleIdentifier；供 ClickStrategy 决策 Electron 加速通道。
    /// nil safe（未知 app 走 AXWebArea + role fallback 分支）。
    private var lastBundleId: String?
    /// 最近一次 readAxTree/getAppState 对齐 app 的 localizedName；供 ClickStrategy 判 Lark/Feishu/飞书 白名单。
    private var lastAppName: String?

    /// AX-only 状态读取。resolve pid → AccessibilitySnapshot.build → 写 lastRecords/lastPid → 返 {text, nodes, pid}。
    func readAxTree(_ params: [String: Any]) throws -> [String: Any] {
        let pid = try resolvePid(appHint: params["app"] as? String)
        let running = NSRunningApplication(processIdentifier: pid)
        let bundleId = running?.bundleIdentifier
        let snap = try AccessibilitySnapshot.build(
            pid: pid, bundleId: bundleId,
            textLimit: intParam(params, "textLimit", 500),
            maxNodes: intParam(params, "maxNodes", 1200),
            maxDepth: intParam(params, "maxDepth", 64)
        )
        // TODO(v0.0.160-P1-A): fixture mode → FixtureBridge.readState 反读 state.json 构造 dict
        lastRecords = snap.records
        lastPid = pid
        lastBundleId = bundleId
        lastAppName = running?.localizedName
        return [
            "text": snap.text,
            "nodes": snap.records.values.sorted { $0.index < $1.index }.map(nodeDict),
            "pid": Int(pid),
        ]
    }

    /// 单窗口截图（ScreenCaptureKit）。resolve 前窗 → base64 + windowBounds + scaleFactor。
    func screenshot(_ params: [String: Any]) throws -> [String: Any] {
        let capture = try ScreenCapture.capture(appHint: params["app"] as? String)
        lastPid = capture.pid
        return screenshotDict(capture)
    }

    /// 合一状态：单窗口截图 + AX 树一次返回（对齐 open-codex「每轮先调」语义）。
    /// 返 {screenshot, axText, windowBounds, scaleFactor, pid}。
    func getAppState(_ params: [String: Any]) throws -> [String: Any] {
        let capture = try ScreenCapture.capture(appHint: params["app"] as? String)
        lastPid = capture.pid
        let running = NSRunningApplication(processIdentifier: capture.pid)
        let bundleId = running?.bundleIdentifier
        let snap = try AccessibilitySnapshot.build(
            pid: capture.pid, bundleId: bundleId,
            textLimit: intParam(params, "textLimit", 500),
            maxNodes: intParam(params, "maxNodes", 1200),
            maxDepth: intParam(params, "maxDepth", 64)
        )
        // TODO(v0.0.160-P1-A): fixture mode → FixtureBridge.readState + fixture screenshot
        lastRecords = snap.records
        lastBundleId = bundleId
        lastAppName = running?.localizedName
        return [
            "screenshot": screenshotDict(capture),
            "axText": snap.text,
            "windowBounds": boundsDict(capture.bounds),
            "scaleFactor": capture.scaleFactor,
            "pid": Int(capture.pid),
        ]
    }

    /// 点击（element_index 主 / coordinate 辅）。
    /// element_index：查 lastRecords → performAXClickSequence（5 层 fallback，含 hit-test）→ CGEvent 兜底。
    /// coordinate（v0.0.160 gap#5）：clickCandidates(bestElement + hitTestElement 双候选) →
    /// performAXClickSequence（includeNearbyHitTesting=false / allowActivationFallback=false，对齐
    /// open-codex L482）→ 全失败 CGEvent 兜底。
    func click(_ params: [String: Any]) throws {
        // TODO(v0.0.160-P1-A): fixture mode → FixtureBridge.post(.click) 而非 InputSimulation.clickTargeted
        let target = params["target"] as? [String: Any] ?? [:]
        let pid = resolvePid(params)
        let button = MouseButtonKind(rawValue: params["button"] as? String ?? "left") ?? .left
        let clickCount = intParam(params, "clickCount", 1)
        if let idx = target["elementIndex"] as? Int {
            guard let rec = lastRecords[idx] else { throw ComputerUseError.elementNotFound(idx) }
            // 1. AX 5 层序列（hit-test 需 pid + allRecords）
            if try ClickStrategy.performAXClickSequence(
                record: rec, bundleId: lastBundleId, appName: lastAppName,
                button: button, clickCount: clickCount,
                pid: pid, allRecords: lastRecords
            ) {
                return
            }
            // 2. AX 全失败 → CGEvent postToPid 兜底
            guard let f = rec.screenFrame else { throw ComputerUseError.elementNotFound(idx) }
            try InputSimulation.clickTargeted(at: CGPoint(x: f.midX, y: f.midY), button: button, clickCount: clickCount, pid: pid)
            return
        }
        // coordinate 分支（v0.0.160 gap#5）：双候选 AX 尝试 → CGEvent 兜底
        let point = try coordPoint(target["coordinate"])
        let candidates = ClickCoordinateHitTest.clickCandidates(at: point, in: lastRecords, pid: pid)
        for candidate in candidates {
            if try ClickStrategy.performAXClickSequence(
                record: candidate, bundleId: lastBundleId, appName: lastAppName,
                button: button, clickCount: clickCount,
                includeNearbyHitTesting: false, allowActivationFallback: false
            ) {
                return
            }
        }
        try InputSimulation.clickTargeted(at: point, button: button, clickCount: clickCount, pid: pid)
    }

    /// 滚动（element_index 中心 / coordinate；direction 必填，pages 缺省 1）。
    /// v0.0.160 gap#3：element_index 场景先尝试 AX `AXScroll<Direction>ByPage` action × integralPages 次
    /// （对齐 open-codex L535-541）；命中失败/非整数/非 element_index → 落 InputSimulation.scrollTargeted。
    func scroll(_ params: [String: Any]) throws {
        // TODO(v0.0.160-P1-A): fixture mode → FixtureBridge.post(.scroll)
        let target = params["target"] as? [String: Any] ?? [:]
        let pid = resolvePid(params)
        let direction = params["direction"] as? String ?? "down"
        let pages = numParam(params, "pages") ?? 1
        // AX-first：element_index + rawActions 含 AXScroll<Dir>ByPage + pages 整数 → AXPerformAction × repeat
        if let idx = target["elementIndex"] as? Int, let rec = lastRecords[idx],
           let repeatCount = integralScrollPageCount(pages),
           let rawAction = rec.rawActions.first(where: {
               $0.caseInsensitiveCompare("AXScroll\(direction.capitalized)ByPage") == .orderedSame
           })
        {
            for _ in 0..<repeatCount {
                _ = AXUIElementPerformAction(rec.element, rawAction as CFString)
                Thread.sleep(forTimeInterval: 0.05)
            }
            return
        }
        // Fallback：CGEvent scrollWheel
        try InputSimulation.scrollTargeted(at: try pointFromTarget(target), direction: direction, pages: pages, pid: pid)
    }

    /// 拖拽（from→to，均已换算全局 point；steps 缺省 10 插值）。
    func drag(_ params: [String: Any]) throws {
        // TODO(v0.0.160-P1-A): fixture mode → FixtureBridge.post(.drag)
        let pid = resolvePid(params)
        try InputSimulation.dragTargeted(
            from: try coordPoint(params["from"]), to: try coordPoint(params["to"]),
            steps: intParam(params, "steps", 10), pid: pid
        )
    }

    /// 输入 Unicode 文本（v0.0.160 gap#1 三段式 → `TypeTextStrategy.type`）：
    /// ① focus AX kAXValue set 优先 → ② keyboard fallback 门禁不通过 throw stateUnavailable → ③ CGEvent keyboard。
    func type(_ params: [String: Any]) throws {
        // TODO(v0.0.160-P1-A): fixture mode → FixtureBridge.post(.type)
        try TypeTextStrategy.type(
            text: params["text"] as? String ?? "",
            pid: resolvePid(params),
            chunkSize: intParam(params, "chunkSize", 64),
            delayMs: intParam(params, "delayMs", 12)
        )
    }

    /// 按键/组合键（xdotool 语法，如 cmd+s / enter；KeyPressParser 解析）。
    func pressKey(_ params: [String: Any]) throws {
        // TODO(v0.0.160-P1-A): fixture mode → FixtureBridge.post(.pressKey)
        try InputSimulation.pressKey(params["key"] as? String ?? "", pid: resolvePid(params))
    }

    /// 运行中 app 列表（NSWorkspace .regular 激活策略；返 [{bundleId,name,pid,isRunning}]）。
    func listApps() -> [[String: Any]] {
        Applications.list()
    }

    /// 设值（AXUIElementSetAttributeValue）。查 lastRecords[elementIndex] → settable 校验 → set；
    /// 非 settable 抛 notSettable，set 失败抛 message。v0.0.160 gap#16：尾部 sleep 100ms 让 AX/UI 消化（对齐 open-codex L643）。
    func setValue(_ params: [String: Any]) throws {
        // TODO(v0.0.160-P1-A): fixture mode → FixtureBridge.post(.setValue) 而非 AXUIElementSetAttributeValue
        guard let idx = params["elementIndex"] as? Int, let rec = lastRecords[idx] else {
            throw ComputerUseError.elementNotFound(params["elementIndex"] as? Int ?? -1)
        }
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(rec.element, kAXValueAttribute as CFString, &settable)
        guard settable.boolValue else { throw ComputerUseError.notSettable }
        let value = params["value"] as? String ?? ""
        guard AXUIElementSetAttributeValue(rec.element, kAXValueAttribute as CFString, value as CFTypeRef) == .success else {
            throw ComputerUseError.message("AXUIElementSetAttributeValue failed for index \(idx)")
        }
        Thread.sleep(forTimeInterval: 0.1)
    }

    /// 触发 secondary action（v0.0.160 gap#17 两级 match，对齐 open-codex L691-701 + L485-511）：
    /// action 先与 rawActions case-insensitive 精确 match → 未命中再与 prettyActions position match →
    /// 找到 rawAction 名后 AXUIElementPerformAction；未找到 throw；成功尾部 sleep 150ms。
    func performSecondaryAction(_ params: [String: Any]) throws {
        // TODO(v0.0.160-P1-A): fixture mode → FixtureBridge.post(.performSecondaryAction)
        guard let idx = params["elementIndex"] as? Int, let rec = lastRecords[idx] else {
            throw ComputerUseError.elementNotFound(params["elementIndex"] as? Int ?? -1)
        }
        let action = params["action"] as? String ?? ""
        guard !action.isEmpty else { throw ComputerUseError.invalidArguments("secondary action name required") }
        guard let rawAction = matchingAction(requested: action, in: rec) else {
            throw ComputerUseError.message("'\(action)' is not a valid secondary action for element \(idx)")
        }
        let result = AXUIElementPerformAction(rec.element, rawAction as CFString)
        guard result == .success else {
            throw ComputerUseError.message("AXUIElementPerformAction failed with \(result.rawValue)")
        }
        Thread.sleep(forTimeInterval: 0.15)
    }

    // MARK: - helper

    /// CapturedWindow → 可序列化 dict（裸 base64 + windowBounds screen point + scaleFactor）
    private func screenshotDict(_ c: CapturedWindow) -> [String: Any] {
        [
            "mediaType": "image/png", "data": c.base64, "width": c.width, "height": c.height,
            "scaleFactor": c.scaleFactor, "windowBounds": boundsDict(c.bounds),
        ]
    }

    /// CGRect → {x,y,w,h}（screen point，y-down）
    private func boundsDict(_ r: CGRect) -> [String: Any] {
        ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.width), "h": Double(r.height)]
    }

    /// coordinate（已全局 point）→ CGPoint
    private func coordPoint(_ v: Any?) throws -> CGPoint {
        guard let d = v as? [String: Any], let x = numParam(d, "x"), let y = numParam(d, "y") else {
            throw ComputerUseError.invalidArguments("expected {x,y}")
        }
        return CGPoint(x: x, y: y)
    }

    /// target → 落点：elementIndex→记录中心；coordinate→已全局 point。（scroll 用）
    private func pointFromTarget(_ target: [String: Any]) throws -> CGPoint {
        if let coord = target["coordinate"] { return try coordPoint(coord) }
        if let idx = target["elementIndex"] as? Int {
            guard let rec = lastRecords[idx], let f = rec.screenFrame else { throw ComputerUseError.elementNotFound(idx) }
            return CGPoint(x: f.midX, y: f.midY)
        }
        throw ComputerUseError.invalidArguments("target requires elementIndex or coordinate")
    }

    /// 动作类 pid 解析：params["pid"] > lastPid（上次截图/AX）> frontmost。
    private func resolvePid(_ params: [String: Any]) -> pid_t {
        if let p = params["pid"] as? Int, p > 0 { return pid_t(p) }
        if lastPid > 0 { return lastPid }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    }

    private func numParam(_ params: [String: Any], _ key: String) -> Double? {
        if let d = params[key] as? Double { return d }
        if let i = params[key] as? Int { return Double(i) }
        return (params[key] as? NSNumber)?.doubleValue
    }

    /// element 记录 → 可序列化 dict（screenFrame 展平为 x/y/w/h screen point 坐标 + secondary actions）
    private func nodeDict(_ rec: ElementRecord) -> [String: Any] {
        var d: [String: Any] = ["index": rec.index, "role": rec.role]
        if let t = rec.title { d["title"] = t }
        if let v = rec.value { d["value"] = v }
        if let f = rec.screenFrame {
            d["screenFrame"] = [
                "x": Double(f.origin.x), "y": Double(f.origin.y),
                "w": Double(f.width), "h": Double(f.height),
            ]
        }
        if !rec.actions.isEmpty { d["actions"] = rec.actions }
        return d
    }

    /// pid 解析：app hint（bundleId 或 localizedName 匹配运行中 app）→ 缺则 frontmost。
    private func resolvePid(appHint: String?) throws -> pid_t {
        if let hint = appHint, !hint.isEmpty {
            let match = NSWorkspace.shared.runningApplications.first {
                $0.bundleIdentifier == hint || $0.localizedName == hint
            }
            guard let app = match else { throw ComputerUseError.appNotFound(hint) }
            return app.processIdentifier
        }
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier, pid > 0 else {
            throw ComputerUseError.message("no frontmost application")
        }
        return pid
    }

    private func intParam(_ params: [String: Any], _ key: String, _ def: Int) -> Int {
        if let i = params[key] as? Int { return i }
        return (params[key] as? NSNumber)?.intValue ?? def
    }
}

// file-scope helpers → ServiceHelpers.swift（保 Service.swift ≤ 300 行硬约束）
