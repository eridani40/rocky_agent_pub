# v0.0.159 变更计划书（method 级 review 合同）

> 主题：computer tool click 对 Electron / Chromium web content 生效修复（AXPress 空转根治）。
> 8 列：所属模块 / 文件路径 / 函数·符号 / 类型(A=新增/M=修改/D=删除) / 变更内容 / 约束 / 参考 / 影响行。
> 行 = 函数/符号（新增 struct/enum 也各占一行）。
>
> **架构原则**：
> 1. **策略层与遍历层分离**：click 决策/多步 AX 序列封装为独立 `ClickStrategy` 名字空间（新文件 `ClickStrategy.swift`）；AX 遍历原语（copyParent/hasAncestorRole）留在 `AccessibilitySnapshot.swift` 静态命名空间（复用现有 `AXUIElementCopyAttributeValue` 封装）。避免 `Service.swift` 300 行上限，且 XCTest UT 能纯 Swift 覆盖策略函数。
> 2. **仅改 native**：`app/computer-native/swift/Sources/RockyComputerCore/` 三文件 + 新 `ClickStrategy.swift`；TS 侧 `click.ts` / `native-port.ts` / dispatch 全不动（TS 契约不变）。
> 3. **Electron 判定 = 双闸兼收（req.md context finding + 用户偏好）**：`hasAncestorRole("AXWebArea")` 单独兜底触发 web row 路径（覆盖 WorkBuddy 这类 bundleId 不含 electron 字样），`isElectronScopedTarget(bundleId, appName)` 作**加速判定通道**（明确白名单场景直接放行 role/synthetic 判定环节）——推荐理由：req.md 明确要求覆盖 WorkBuddy，纯 bundle 判定会漏，纯 AXWebArea 兜底又风险偏宽；两者叠加 = 明确 Electron 走优化路径，未知 hasWebArea 也不空转。
> 4. **祖先深度 = 6**（对齐 open-codex；hasAncestorRole 通用深度 12，与 open-codex 一致）。
> 5. **AX action 多步序列**：左键 AXPress → AXConfirm → AXOpen；右键 AXShowMenu；AX 全失败落 InputSimulation.clickTargeted（现有 CGEvent fallback）。
> 6. **测试策略**：新增 Swift XCTest target（决策函数纯逻辑 UT——bundle 判定 / frame 匹配 / role 判定 / 序列组合）；真机行为按现有 spec §「native 动作类真机行为 dev dogfood 手验」。**AT/ET 豁免**（无 API/UI/DB 契约变更，纯 native 修复；memory `ui-only-ut-skip-at-et` 用户裁决同类豁免）。
>
> **核对状态**（architect grep 核对，引用符号存在）：
> - ApplicationServices 常量 `kAXPressAction` / `kAXConfirmAction` / `kAXShowMenuAction` / `kAXParentAttribute` / `kAXRoleAttribute` / `kAXChildrenAttribute` / `kAXPositionAttribute` / `kAXSizeAttribute` — 均系统标准常量（Xcode 14+ SDK）。
> - 字符串常量 `"AXOpen"` / `"AXWebArea"` — 无 Swift 常量对应，open-codex 也用裸字符串；本 spec 直接引用字面量并加常量封装（`ClickStrategy.axOpenAction` / `.axWebAreaRole`）以便 UT 稳定引用。
> - `AXUIElementPerformAction` / `AXUIElementCopyAttributeValue` / `AXUIElementCopyActionNames` / `AXUIElementCreateApplication` — 现 `AccessibilitySnapshot.swift` 已在用。
> - `NSRunningApplication(processIdentifier:)` / `.bundleIdentifier` / `.localizedName` — 现 `Service.swift:23` 已在用。
> - `ElementRecord.element: AXUIElement` — 已存（AccessibilitySnapshot.swift:12），无需重新暴露。

---

## 模块 A：AccessibilitySnapshot 增强（ElementRecord + AX 遍历 helper）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `ElementRecord` | M | 新增字段 `rawActions: [String]`（未过滤 AXPress 的全动作列表）；`actions` 保留（现语义 = 已过滤 AXPress 的 secondary actions，供 nodeDict/AX 文本 render） | rawActions 供 `ClickStrategy.hasPrimaryClickAction` 检 AXPress/AXConfirm/AXOpen/AXShowMenu；不改 actions 语义（AX 文本渲染不变，避免 LLM 视角回归） | req §C1 + specs `[P1]computer_native_capability.md §5 AccessibilitySnapshot 行` | +2/-0 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `walk(_:depth:...)` | M | 采集 rawActions（`AXUIElementCopyActionNames` 全量）→ 构造 ElementRecord 时同时填 rawActions；actions（filtered）从 rawActions 派生 | 一次采集两用（AX 一遍避免二次 API call）；render 只用 filtered actions | 参考 open-codex `copyActions(for:)` L1376 | +3/-1 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `rawActionsOf(_ element: AXUIElement) -> [String]` | A | 全量 action 名列表（不过滤 AXPress） | 返 `[]` 而非 nil（简化调用）；`AXUIElementCopyActionNames` 失败等价空 | 对齐 open-codex `copyActions` | +6 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `copyParent(of element: AXUIElement) -> AXUIElement?` | A | `AXUIElementCopyAttributeValue(kAXParentAttribute)` 单步 parent；失败返 nil | force-cast 复用 `AXValueGetTypeID` 校验；不做 fallback（不递归） | 对齐 open-codex L1396 | +7 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `hasAncestorRole(_ role: String, of element: AXUIElement, maxDepth: Int = 12) -> Bool` | A | 循环 copyParent 至 maxDepth，任一祖先 role 匹配返 true；到根/失败返 false | maxDepth 默认 12（对齐 open-codex L1191）；不越 maxDepth；nil parent 即停 | 对齐 open-codex L1188 | +10 |

---

## 模块 B：ClickStrategy — 新增策略层（新文件）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy` enum | A | 命名空间（无实例），存 static helpers + 常量（`axOpenAction = "AXOpen"` / `axWebAreaRole = "AXWebArea"`） | 用 enum 而非 struct（Swift 惯用 namespace 模式）；常量集中，避免全文件散字面量 | req §A/B；架构原则 1 | +8 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy.isElectronScopedTarget(bundleId:appName:) -> Bool` | A | bundleId 判定：`hasPrefix("com.electron.")` 或 `.contains(".electron.")` 或 `.contains("lark")` 或 `.contains("feishu")`；appName lowercased ∈ {"lark","feishu","飞书"}；均去空格 lowercased 后判 | bundleId/appName 均 optional，nil 时按 false 分支处理；纯字符串逻辑，供 XCTest 覆盖 | 对齐 open-codex L307 `isElectronScopedWebRowClickOptimizationTarget` | +18 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy.shouldPreferContainingWebRowAXClick(record:bundleId:appName:) -> Bool` | A | 决策：`hasAncestorRole("AXWebArea", of: record.element)` 为核心必要条件；命中后再看 `isElectronScopedTarget(bundleId,appName)` → true 直接放行；如 bundle 判定 false 但 hasWebArea 命中，则回退看 role ∈ {AXStaticText, AXGroup, AXUnknown} 时也放行（覆盖 WorkBuddy 兜底） | **决策核心：架构原则 3 双闸兼收**；不完全套 open-codex `shouldPreferContainingWebRowAXClickCandidate` 的 isSyntheticText 判定（我们 ElementRecord 无此字段，避免额外采集），改用 role 白名单近似 | 对齐 open-codex L327 + req §A1 finding；参考原则 3 | +18 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy.hasPrimaryClickAction(rawActions:) -> Bool` | A | rawActions 含 `AXPress` / `AXConfirm` / `AXOpen` / `AXShowMenu` 之一（case-insensitive）返 true | 用 caseInsensitiveCompare（open-codex 同）；供 web row 祖先判定 + descendant 判定共用 | 对齐 open-codex L1106 | +8 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy.isLikelyContainingRowActionFrame(targetFrame:candidateFrame:hasPrimaryAction:) -> Bool` | A | 几何判定：candidateFrame 需扩 -2 后含 targetCenter；candidateFrame.width ≥ targetFrame.width；height ≥ targetFrame.height 且 ≤ max(targetHeight+32, targetHeight*2)；缺 hasPrimaryAction 直接 false | 纯 CGRect 逻辑；供 XCTest UT 全路径覆盖 | 对齐 open-codex L257 | +14 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy.performAction(named:on:availableActions:repeatCount:) throws -> Bool` | A | availableActions 不含 action → false；`AXUIElementPerformAction` `.success` → true，clickCount>1 尝试 sleep 50ms 重放；`.attributeUnsupported` 且 action=AXOpen → true（open-codex 特例：AXOpen 部分实现无属性但仍触发）；其余 failure/actionUnsupported/cannotComplete/noValue/invalidUIElement/illegalArgument → false；未知 → throw | 只对已声明 available 的 action 尝试（避免污染 log）；不 sleep repeat 尾轮；throw 走上游 catch，不吞 | 对齐 open-codex L899 | +22 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy.performContainingWebRowClick(record:) throws -> Bool` | A | 仅左键单击生效（button/clickCount 校验交调用侧，函数不重复校验；接受 `ElementRecord` 已含 element+screenFrame）；从 element 向上 copyParent 最多 6 层：每层取 rawActions + frameOf → `hasPrimaryClickAction` 且 `isLikelyContainingRowActionFrame(target=record.screenFrame!, candidate=parentFrame, hasPrimaryAction=true)` 命中即对该 parent `performAction(named: kAXPressAction as String, ..., rawActions, 1)` → 成功 return true | 深度硬编码 6（架构原则 4）；screenFrame nil 直接 return false；每层调用 AX API 各失败即静默过（不 throw）；命中后 sleep 150ms（对齐 open-codex `Thread.sleep(0.15)`） | 对齐 open-codex L1131 | +32 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy.performPreferredClick(record:button:clickCount:) throws -> Bool` | A | switch button：`.left` → 顺序尝试 `performAction(kAXPressAction, ..., record.rawActions, clickCount)` → `kAXConfirmAction` → `axOpenAction`，任一 true 即 return true；`.right` → `performAction(kAXShowMenuAction, ..., record.rawActions, 1)`；`.middle` → false | 每步 throw 都逃逸给上游；不做 sleep（sleep 由 performAXClickSequence 统一后置）；clickCount 只对 left AXPress 生效（Confirm/Open 语义只做 1 次） | 对齐 open-codex L707 | +22 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy.performAXClickSequence(record:bundleId:appName:button:clickCount:) throws -> Bool` | A | 主编排：① `shouldPreferContainingWebRowAXClick(record, bundleId, appName)` → 命中且左键单击 → `performContainingWebRowClick(record)` 成功即 return true（含 150ms sleep）；② 未走 web row 或 web row 失败 → `performPreferredClick(record, button, clickCount)` 成功 → sleep 150ms return true；③ 全 false → return false（交调用侧走 CGEvent fallback） | 单一入口暴露给 Service.click，避免 Service 承担序列逻辑；不吞 throw；success 后统一 sleep 150ms（AX 动作 → UI 反应窗口） | 对齐 open-codex L813（简化：暂不带 descendantClickCandidates / clickActionPoints / activationFallback，留后续增强） | +22 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `ClickStrategy.debugLog(_ message:)` | A | 仅 `ProcessInfo.processInfo.environment["RC_COMPUTER_DEBUG"] == "1"` 时 `FileHandle.standardError.write("[click] \(message)\n")` | 生产默认关；env 开则出现在 addon stderr；纯打印 no-throw | 对齐 open-codex `debugClickDecision`（简化，不落文件） | +8 |

---

## 模块 C：Service.swift click 主流程接入

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `ComputerUseService.lastBundleId: String?` | A | 与 lastPid/lastRecords 并列的私有存储；readAxTree/getAppState 同步写入（既有 `NSRunningApplication(processIdentifier: pid).bundleIdentifier` 直接落缓存） | 供 click 决策免二次 `NSRunningApplication` 查询（frontmost 变化不影响此次点击对齐的 app） | req.md context finding 「bundleId 已采集 §Service.swift:23」 | +1 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `ComputerUseService.lastAppName: String?` | A | 同 lastBundleId，落 `NSRunningApplication(processIdentifier: pid).localizedName` | 供 `ClickStrategy.isElectronScopedTarget` 的 appName 判定路径 | req §A1 | +1 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `readAxTree(_:)` | M | 已 resolve pid 后拿 `NSRunningApplication(processIdentifier: pid)`，加两行：`lastBundleId = running?.bundleIdentifier`；`lastAppName = running?.localizedName`（复用已存的 running 局部） | 保持 last-call-wins；nil 允许（后续 click 决策 nil safe） | 现 Service.swift:23 | +2 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `getAppState(_:)` | M | 同 readAxTree：resolve pid 后落 lastBundleId + lastAppName | 与 readAxTree 一致，避免 click 走 getAppState 后决策丢字段 | 现 Service.swift:55 | +2 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `click(_:)` | M | element_index 分支：替换现 82-88 行 AXPress-only 分支——先 `let handled = try ClickStrategy.performAXClickSequence(record: rec, bundleId: lastBundleId, appName: lastAppName, button: button, clickCount: clickCount)`；handled==true → return；handled==false → 走既有 InputSimulation.clickTargeted（保留 CGEvent 兜底） | **MUST NOT** 保留旧「if AXPress .success → return」short-circuit；handled 失败必须 fallback，禁止吞失败；coordinate 分支不动（TS 已给全局 point） | req §D + 现 Service.swift:75-91；对齐架构原则 5 | +6/-4 |

---

## 模块 D：Package + 测试

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| package | app/computer-native/swift/Package.swift | `Package.targets` | M | 新增 `executableTarget(name: "RockyComputerCoreTestRunner", dependencies: ["RockyComputerCore"], path: "Tests/RockyComputerCoreTestRunner", swiftSettings: [.swiftLanguageMode(.v5)])`（**收尾偏离原 `testTarget`**，见文末偏离尾注 §D-1） | 保持 macOS 14 平台；language mode 与主 target 一致 | 现 Package.swift:22 | +6 |
| test | app/computer-native/swift/Tests/RockyComputerCoreTestRunner/main.swift | executable `main` + 手写 `expect()` runner | A | 覆盖 `isElectronScopedTarget`（bundle prefix / substring / appName lark/feishu/飞书 / nil 双 nil / 大小写混合）；`isLikelyContainingRowActionFrame`（含中心/宽高上下限/hasPrimaryAction=false 直接 false/candidateFrame nil 直接 false）；`hasPrimaryClickAction`（4 primary action 各 hit + case insensitive + 空数组 false）。**手写 `expect(_:_:)` 断言 + `exit(1)` on fail**（**收尾偏离原 XCTestCase**，见文末偏离尾注 §D-1）。31 assertions 全绿。跑法 `swift run --package-path app/computer-native/swift RockyComputerCoreTestRunner`（exit 0=全绿；exit 1=有 FAIL 并 stderr 打印明细） | 只测纯逻辑函数（不 mock AXUIElement）；不触真 AX API；文件 ≤300 行（实测 188 行） | req §测试 + 架构原则 6 | +188 |
| test | ~~app/computer-native/swift/Tests/RockyComputerCoreTests/AccessibilityHelperTests.swift~~ | ~~`AccessibilityHelperTests` XCTestCase~~ | ~~A~~ | **收尾未创建**（附录偏离边界允许：AXUIElement 无 mock 途径 → 真机 dev dogfood 手验单独跑）。`copyParent` / `hasAncestorRole` / `frameOf` / `rawActionsOf` 均依赖 live AX API，无稳定 mock 路径 | — | 见附录「偏离边界」 | 0（未建） |

---

## 模块 E：Spec 更新

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec | specs/tech/agent/platform/[P1]computer_native_capability.md | §5「Swift 文件」表 AccessibilitySnapshot / Service.swift 行 | M | AccessibilitySnapshot 行增补「+ raw actions（供 primary click 判定）+ copyParent / hasAncestorRole 遍历 helper」；Service.swift 行改为「+ lastBundleId/lastAppName 缓存」；表新增 ClickStrategy 行（策略层：`shouldPreferContainingWebRowAXClick / performContainingWebRowClick / performPreferredClick / performAXClickSequence` + Electron 白名单判定） | 保持表结构不变；行内一句话概述职责 | req §影响范围 | +2/-0 加行 + 修 2 行 |
| spec | specs/tech/agent/platform/[P1]computer_native_capability.md | §6 element_index 说明 | M | 现「element_index → AXPress 语义动作 或 postToPid」改为「element_index → **AX click 序列**（web content 特殊路径 → AXPress→AXConfirm→AXOpen；右键 AXShowMenu；6 层祖先 web row fallback）→ 失败落 postToPid（CGEvent 兜底）。**v0.0.159 修订**：v0.0.105 单步 AXPress 策略对 Electron/Chromium web content 空转（AX 返 success 但 DOM 未触发），新增 web row 祖先遍历 + AX action 多步序列」 | 保留原文关键结论（零像素数学 robust）；只补策略描述 + 修订标注 | 现 §146 + req §根因 | +6/-1 |
| spec | specs/tech/agent/platform/[P1]computer_native_capability.md | §8 已知局限 新增小节 | M | 加一条：「**click 策略未覆盖场景**（v0.0.159 起有意留白，后续调优）：descendant click candidates 循环 / 邻近 hit-test 补偿 / AXWindow AXRaise+AXMain+AXFocused activation fallback / selectContainingListItem — 参考 open-codex 但本版本先落 6 层 web row + 3-step 序列已够覆盖 WorkBuddy / wb-clone 场景；未来失败率超阈值再补」 | 与 open-codex 差距点显性化，便于后续增强定位 | req §与 open-codex 对比 | +5 |

---

## 附：偏离边界（coder 可自主决策，不必汇报）

| 项 | 允许偏离范围 |
|---|---|
| 常量声明位置 | `axOpenAction` / `axWebAreaRole` 挂 `ClickStrategy` 或提到 `AccessibilitySnapshot` 皆可，只要单一权威源 |
| debugLog 实现 | 是否走 os_log / print / FileHandle 由 coder 定，只要能被 env 开关 |
| Tests/AccessibilityHelperTests.swift | 若纯 mock 太重可只留 ClickStrategyTests，AccessibilityHelperTests 整个删除（不算偏离） |
| performAXClickSequence 内 150ms sleep | 若测试期发现该 sleep 拖慢 SPI 可挪到 native-port.ts 层 debounce（需汇报 orchestrator） |

## 附：核心约束（不可偏离，偏离必汇报 orchestrator）

- **TS 侧完全不动**（tools/computer-use/actions/click.ts / platform/computer/native-port.ts / addon.cc 均不改）
- **祖先深度硬编码 6 层**（架构原则 4），不改成参数化（避免 tuning 面过大）
- **isElectronScopedTarget bundle 白名单**（`com.electron.` prefix / `.electron.` substring / `lark` / `feishu`）不缩窄；appName 白名单 `Lark`/`Feishu`/`飞书` 不缩窄
- **AX action 顺序左键 = AXPress → AXConfirm → AXOpen**，不重排、不加/减步骤
- **AXPress 失败必 fallback CGEvent**（现有兜底不删）
- **不引入新第三方依赖**（纯 Foundation / ApplicationServices / AppKit）

---

## 收尾偏离尾注（doc-sync 记录，coder 汇报 → orchestrator 裁决通过）

### §D-1：XCTest testTarget → executableTarget（RockyComputerCoreTestRunner）

**原契约**：模块 D 第 1/2 行 = `testTarget "RockyComputerCoreTests"` + `XCTestCase` 子类；跑法 `swift test`。

**实际实现**：`executableTarget "RockyComputerCoreTestRunner"` + 手写 `expect(_:_:)` runner（`Tests/RockyComputerCoreTestRunner/main.swift`）；跑法 `swift run --package-path app/computer-native/swift RockyComputerCoreTestRunner`。

**偏离理由**：本机装的是 Command Line Tools（`xcode-select -p = /Library/Developer/CommandLineTools`），完整 Xcode 未装 → `XCTest.framework` 与 Swift `Testing` module 均缺失（swiftpm `testTarget` 编译 `no such module 'XCTest'` / `'Testing'`）。改 executable + 手写 `expect()` 达成同等目标（策略函数纯逻辑 UT，31 assertions 全绿），实现细节偏离但目标不变。

**影响范围**：仅本目录 UT runner 形态；产品代码零影响；打包链零影响（build-native.sh 走 `--product RockyComputerCore` 只编 dylib 主产品，见 §D-2）。

### §D-2：build-native.sh 加 `--product RockyComputerCore` 过滤

**原契约**：build-native.sh 走 `swift build -c release`（编所有 target）。

**实际实现**：`swift build -c release --product RockyComputerCore`。

**偏离理由**：release build 会一并编 TestRunner target；TestRunner 若走 `@testable import` 需 debug + `enable-testing`，release 直接崩。`--product` 过滤只编 dylib 主产品，语义不变、打包全链已跑通（swift dylib + electron `.node`，`nm` 校验 `_rocky_cu_ping` 导出 + `otool` `@rpath` 正确）。**纯技术微调**，无功能影响。

### §D-3：AccessibilityHelperTests 未创建

**原契约**：模块 D 第 3 行 = `AccessibilityHelperTests` XCTestCase 占位。

**实际实现**：未创建。

**偏离理由**：附录「偏离边界」明确允许——`copyParent` / `hasAncestorRole` / `frameOf` / `rawActionsOf` 均依赖 live AXUIElement，无稳定 mock 途径；纯 mock 太重收益低。真机行为走 dev dogfood 手验（对齐 spec `[P1]computer_native_capability.md` 「native 动作类真机行为 dev dogfood 手验」既定策略）。
