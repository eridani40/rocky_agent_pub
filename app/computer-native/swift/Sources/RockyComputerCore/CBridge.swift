import Foundation

// CBridge —— @_cdecl C ABI 桥接层（替 spawn helper 的 main.swift stdin 循环）。
// Rocky Electron 主进程经 N-API C++ shim（addon.cc）调用本文件导出的 C 符号。
// 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.2 决策1（JSON-in/JSON-out C ABI）
//
// 内存约定：返回值经 strdup 分配 char*；C++ 侧拷进 std::string 后必须调 rocky_cu_free 释放（跨界 free 配对）。
//
// rocky_cu_ping：健康探针（验 swift dylib → node-gyp(Electron ABI) → 主进程 require+调用 全链通）。
// rocky_cu_invoke(method, paramsJson)：分发到 ComputerUseService 单例，11 能力全接：
//   读类（返 dict）：readAxTree / screenshot / getAppState / listApps
//   动作类（返 {ok:true}）：click / scroll / drag / type / pressKey / setValue / performSecondaryAction
// 所有异常 fail-closed 转 {ok:false, error}（对齐 ComputerActionResult/GetAppStateResult 契约）。

/// addon 单例（进程内共享 AX 快照缓存，跨 invoke 复用）。
private let sharedService = ComputerUseService()

/// 分配一个 C 字符串副本（调用方经 rocky_cu_free 释放）。
private func makeCString(_ s: String) -> UnsafeMutablePointer<CChar>? {
    return strdup(s)
}

/// [String: Any] → JSON C 字符串（strdup）。序列化失败兜底 fail-closed JSON。
private func jsonCString(_ obj: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]))
        ?? Data(#"{"ok":false,"error":{"code":"serialize_failed","message":"JSON serialize failed"}}"#.utf8)
    let str = String(data: data, encoding: .utf8) ?? #"{"ok":false}"#
    return makeCString(str)
}

/// method → service 分发，返 {ok, result?|error?}。所有异常 fail-closed 转 {ok:false,error}。
private func dispatch(method: String, params: [String: Any]) -> [String: Any] {
    do {
        switch method {
        case "ping":
            return ["ok": true, "result": ["pong": "pong"]]
        case "readAxTree":
            return ["ok": true, "result": try sharedService.readAxTree(params)]
        case "screenshot":
            return ["ok": true, "result": try sharedService.screenshot(params)]
        case "getAppState":
            return ["ok": true, "result": try sharedService.getAppState(params)]
        case "listApps":
            return ["ok": true, "result": sharedService.listApps()]
        case "click":
            try sharedService.click(params)
            return ["ok": true, "result": ["ok": true]]
        case "scroll":
            try sharedService.scroll(params)
            return ["ok": true, "result": ["ok": true]]
        case "drag":
            try sharedService.drag(params)
            return ["ok": true, "result": ["ok": true]]
        case "type":
            try sharedService.type(params)
            return ["ok": true, "result": ["ok": true]]
        case "pressKey":
            try sharedService.pressKey(params)
            return ["ok": true, "result": ["ok": true]]
        case "setValue":
            try sharedService.setValue(params)
            return ["ok": true, "result": ["ok": true]]
        case "performSecondaryAction":
            try sharedService.performSecondaryAction(params)
            return ["ok": true, "result": ["ok": true]]
        default:
            return ["ok": false, "error": ["code": "invalid_arguments", "message": "unknown method: \(method)"]]
        }
    } catch let e as ComputerUseError {
        var err: [String: Any] = ["code": e.code, "message": e.text]
        if let which = e.which { err["which"] = which }
        return ["ok": false, "error": err]
    } catch {
        return ["ok": false, "error": ["code": "helper_error", "message": "\(error)"]]
    }
}

/// Spike 0 健康探针 —— 返回固定 JSON，证明 dylib 已被主进程加载且 C ABI 可调用。
@_cdecl("rocky_cu_ping")
public func rocky_cu_ping() -> UnsafeMutablePointer<CChar>? {
    let payload = #"{"ok":true,"pong":"pong","core":"RockyComputerCore"}"#
    return makeCString(payload)
}

/// 业务入口 —— method + JSON params → JSON 结果串（{ok, result?|error?}）。
/// C++ 侧经 AsyncWorker off 主线程调用（避免动作类 sleep 阻塞 UI）。
@_cdecl("rocky_cu_invoke")
public func rocky_cu_invoke(
    _ method: UnsafePointer<CChar>?, _ paramsJson: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    let methodStr = method.map { String(cString: $0) } ?? ""
    let paramsStr = paramsJson.map { String(cString: $0) } ?? "{}"
    let params = (paramsStr.data(using: .utf8)
        .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    return jsonCString(dispatch(method: methodStr, params: params))
}

/// 释放 rocky_cu_ping / rocky_cu_invoke 返回的 C 字符串（strdup 配对）。
@_cdecl("rocky_cu_free")
public func rocky_cu_free(_ ptr: UnsafeMutablePointer<CChar>?) {
    guard let ptr else { return }
    free(ptr)
}
