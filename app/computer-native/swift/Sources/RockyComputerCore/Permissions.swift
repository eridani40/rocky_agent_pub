import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import SQLite3

// 权限预检合并（防御 CLI/GUI TCC 不一致）——iFurySt Permissions.swift 策略：
//   granted = (TCC.db auth_value == 2) || AXIsProcessTrusted() || CGPreflightScreenCaptureAccess()
// 任一 source 视 granted 即 granted（防 false negative）。tool 门禁 + UI 面板共享此后端。

enum Permissions {
    /// 当前权限态（accessibility / screenRecording 两态）
    static func snapshot() -> (accessibility: Bool, screenRecording: Bool) {
        let persisted = TCCStore.current()
        let axRuntime = AXIsProcessTrusted()
        let scRuntime = CGPreflightScreenCaptureAccess()
        return (
            accessibility: (persisted.accessibility ?? false) || axRuntime,
            screenRecording: (persisted.screenRecording ?? false) || scRuntime
        )
    }

    /// ready 握手 / checkPermissions method 的 tcc dict（"granted" | "missing"）
    static func tccDict() -> [String: String] {
        let s = snapshot()
        return [
            "accessibility": s.accessibility ? "granted" : "missing",
            "screenRecording": s.screenRecording ? "granted" : "missing",
        ]
    }
}

/// TCC.db 直读（auth_value==2 视 granted）。合 bundle id 的 client_type 0/1（防 CLI/GUI 不一致）。
private enum TCCStore {
    private static let dbPath = "/Library/Application Support/com.apple.TCC/TCC.db"
    private static let accessibilityService = "kTCCServiceAccessibility"
    private static let screenService = "kTCCServiceScreenCapture"

    static func current() -> (accessibility: Bool?, screenRecording: Bool?) {
        let clients = permissionClients()
        return (
            accessibility: authorization(service: accessibilityService, clients: clients),
            screenRecording: authorization(service: screenService, clients: clients)
        )
    }

    /// 多重匹配客户端标识（bundle id + bundle path），各配 client_type 0/1。
    private static func permissionClients() -> [(identifier: String, type: Int32)] {
        var clients: [(String, Int32)] = []
        if let bundleId = Bundle.main.bundleIdentifier {
            clients.append((bundleId, 0))
            clients.append((bundleId, 1))
        }
        let path = Bundle.main.bundleURL.path
        clients.append((path, 0))
        clients.append((path, 1))
        return clients
    }

    private static func authorization(service: String, clients: [(identifier: String, type: Int32)]) -> Bool? {
        guard !clients.isEmpty else { return nil }
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            if db != nil { sqlite3_close(db) }
            return nil
        }
        defer { sqlite3_close(db) }
        let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        let query = """
        SELECT auth_value FROM access
        WHERE service = ? AND client = ? AND client_type = ?
        ORDER BY last_modified DESC LIMIT 1;
        """
        var found: [Int32] = []
        for client in clients {
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK else {
                if stmt != nil { sqlite3_finalize(stmt) }
                continue
            }
            sqlite3_bind_text(stmt, 1, service, -1, sqliteTransient)
            sqlite3_bind_text(stmt, 2, client.identifier, -1, sqliteTransient)
            sqlite3_bind_int(stmt, 3, client.type)
            if sqlite3_step(stmt) == SQLITE_ROW {
                found.append(sqlite3_column_int(stmt, 0))
            }
            sqlite3_finalize(stmt)
        }
        if found.isEmpty { return nil }
        return found.contains(2)  // auth_value == 2 → granted
    }
}
