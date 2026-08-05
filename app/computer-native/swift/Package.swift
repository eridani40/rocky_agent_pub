// swift-tools-version: 6.2
//
// RockyComputerCore —— Rocky Agent computer use 的 macOS 原生动态库（dylib）。
// 与 spawn helper（第一批 executable）本质区别：本包产出 **动态库**，被 Rocky Electron 主进程
// 经 N-API C++ 桥（app/computer-native/src/addon.cc）加载 → 继承主进程 TCC 权限身份
// （com.rocky.agent = 权限主体），不 spawn 子进程（memory macos-tcc-spawn-no-perm-use-electron-host）。
// 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.2（编译链方案）
//
// 产物 = libRockyComputerCore.dylib；@_cdecl C ABI 入口在 CBridge.swift。
// Swift 5 语言模式：非 Sendable 的 CGImage/AXUIElement 免 Swift 6 strict concurrency 过度报错。
import PackageDescription

let package = Package(
    name: "RockyComputerCore",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "RockyComputerCore", type: .dynamic, targets: ["RockyComputerCore"]),
    ],
    targets: [
        .target(
            name: "RockyComputerCore",
            path: "Sources/RockyComputerCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // v0.0.159 新增：ClickStrategy 纯逻辑 UT。用 executableTarget + 手写 assert 而非 testTarget/XCTest：
        // 本机 Command Line Tools 未装完整 Xcode，XCTest.framework 与 Testing module 均缺失
        //（swiftpm testTarget 编译失败：`no such module 'XCTest'` / `'Testing'`）。
        // executable + 手写 expect() 达成同等目标（纯逻辑函数 UT 可跑，change_plan 允许实现细节偏离）。
        // 运行：`swift run RockyComputerCoreTestRunner`（exit 0 全绿，exit 1 存在失败并打印 FAIL 明细）。
        // AX 真机行为（copyParent/hasAncestorRole/AXUIElementPerformAction）走 dev dogfood 手验，
        // 不入此 target（AXUIElement 无 mock 途径）。
        .executableTarget(
            name: "RockyComputerCoreTestRunner",
            dependencies: ["RockyComputerCore"],
            path: "Tests/RockyComputerCoreTestRunner",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
