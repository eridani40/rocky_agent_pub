# §2-§8 架构层 / 权限 / AX snapshot / 错误 / 测试 / 视觉反馈 / MCP schema

**前置**：`overview.md` 摘要与优先级；`actions-diff.md` 逐 action 对比。本文覆盖跨 action 的架构维度。

---

## §2 架构层差异

### 2.1 Service 单例 vs snapshotsByApp cache

- **ours**：`ComputerUseService` 单例（`Service.swift:14`），进程内共享 `lastRecords: [Int: ElementRecord]` + `lastPid` + `lastBundleId/lastAppName`（v0.0.159 加）。**session 无关**——所有 Rocky 会话共享同一份 lastRecords 缓存（last-call-wins）。
- **open-codex**：`ComputerUseService.snapshotsByApp: [String: AppSnapshot]`（`refs/.../ComputerUseService.swift:351`），**per-app 缓存**——用 app query（lowercased bundleId / name 三 key）索引 AppSnapshot（含 `elements: [Int: ElementRecord]`, `windowBounds`, `screenshotPNGData`, `focusedElement` 等 12 字段）。每个 tool call 前 `currentSnapshot(for: query)` 命中缓存；`refreshSnapshot` 显式失效。
- **意义**：open-codex 是 stdio MCP server，一个 process 可并发被多个 assistant turn 用；per-app cache 避免 pollution。Rocky 是 electron 主进程 in-process addon，一个 process 只有一个 session 在跑（session 是 rocky 侧的 sessionId，不是 native 侧概念）。
- **判定**：`[不移植]` — 架构本质差异。**但值得关注**：如果未来 Rocky 让多 session 并发跑 computer tool，共享 lastRecords 会互相踩（session A 拿了 idx=5 → session B 拿 read_ax_tree 覆盖 lastRecords → session A click idx=5 命中 B 的元素）。当前 tool policy 限一个绑定 playground，无并发风险；一旦解锁需要重设计。

### 2.2 Native bridge — CBridge N-API vs Swift Executable + MCP stdio

- **ours**：`CBridge.swift` 用 `@_cdecl` 导出 C ABI 三符号（`rocky_cu_ping / rocky_cu_invoke / rocky_cu_free`），通过 node-gyp 编 `.node` 二进制被 electron 主进程 `require`。`rocky_cu_invoke` = method + JSON params → JSON result 串。同步阻塞（AsyncWorker off-main）。
- **open-codex**：Swift executable `open-computer-use mcp` 起 stdio MCP JSON-RPC server（`refs/.../MCPServer.swift:20-149`），每行 `initialize / tools/list / tools/call / notifications/turn-ended / ping` 交换；Codex 端作为 MCP client 通过 stdio spawn 它。
- **意义**：
  - **packaged 部署**：ours 需要 `.node` 二进制签名 + electron ABI 匹配（v0.0.108 打过血战，见 memory `native-addon-workspace-skip-install-nodegyp`）；open-codex 直接是 macOS `.app` bundle 内嵌 executable
  - **macOS TCC 权限主体**：ours = rocky 主 `.app`（`rocky_agent`）拿 accessibility，addon 继承（memory `macos-tcc-spawn-no-perm-use-electron-host` — 我们的选择就为避免 TCC 隔离）；open-codex = `Open Computer Use.app` 独立拿权限
  - **notifications/turn-ended**：open-codex 有「turn 结束 → 重置 SoftwareCursorOverlay」机制；我们无对应概念（因为 in-process，agent turn 结束 = tool return，无跨 tool call 状态需清）
- **判定**：`[不移植]` — 我们的 in-process addon 是刻意选择的方案，且已跑通 packaged（memory 里全部相关坑都有记录）。open-codex 的 MCP stdio 模式与我们 electron 集成模式冲突。

### 2.3 snapshot 缓存 vs lastRecords

见 §2.1。

### 2.4 SoftwareCursorOverlay（视觉光标反馈）

- **open-codex**：完整 `SoftwareCursorOverlay.swift`（870 行 NSWindow + NSView 层）+ `CursorMotionModel.swift`（1506 行动力学：velocity / rotation / idle timeout / eased motion）+ `SoftwareCursorGlyphRenderer.swift`（293 行 SVG-ish 光标渲染）。click 前后 `moveVisualCursor` / `pulseVisualCursor` / `settleVisualCursor` 让用户看到"某个虚拟光标"移动 + 脉冲。
- **ours**：无。dev dogfood 时 click 静默发生（用户看不到落点，不知道命中没命中）。
- **判定**：`[可选]`（用户裁决入口）— 视觉反馈对 dogfood 体验有大幅提升，但成本极高：
  - 2669 行 Swift + NSWindow 单独窗口层
  - 需要 UI 线程（我们 addon 无 main run loop，需拆 dispatch）
  - 与 macOS Big Sur+ 后 SecureCoding 有兼容坑
  - Rocky 已有 electron UI 层，用户可看 chat log 里 tool call step 反馈，视觉光标价值边际

  推荐做法：**不移植 SoftwareCursorOverlay 本体**，但可以借鉴其**信号面**——click 成功 / 失败 通过 tool result 文本明确标注（如 `已通过 AX 路径 xxx 点击 [element role=... title=...]`）让 LLM 与用户都能读到"我做了什么"。

### 2.5 FixtureBridge（测试固定桩）

- **open-codex**：`FixtureBridge.swift`（139 行）+ `ComputerUseService` 内 `if snapshot.mode == .fixture` 分支覆盖 8 个 action。fixture 是独立 macOS app (`OpenComputerUseFixture`)——测试时 xctest 里启动 fixture、写 `state.json` 到 `NSTemporaryDirectory/open-computer-use-fixture/state.json` → `SnapshotBuilder.readState` 直接读；action 走 `DistributedNotificationCenter.post` 发命令回 fixture app。
- **ours**：Swift 端无 fixture bridge。TS 侧有 `mock-native-port.ts` / `loopback-native-port.ts`（`app/server/src/platform/computer/`）+ `tests/api/{computer,browser}/` 走 mock。
- **判定**：`[可选]` — fixture bridge 让 XCTest 能真实跑完整 Service 链路（不 mock AX），我们 v0.0.159 的 31-assertion 手写 executable runner 只覆盖纯逻辑函数（无 mock AXUIElement）。**当前依赖 dev dogfood 手验够用**，暂不移植；如果发现 v0.0.159 移植策略 regress 而 dogfood 侦测不出，回头考虑。

### 2.6 tool schema / MCP 集成

- **ours**：`schema.ts` 定义 `COMPUTER_INPUT_SCHEMA`（扁平 action-discriminated，单 tool）。tool 定义在 `computer.ts`。schema 与 dispatcher 平铺在 TS。
- **open-codex**：`ToolDefinitions.swift`（233 行）—— 9 个独立 ToolDefinition 分列出来，每个 `inputSchema` 是完整 JSON schema，`annotations` 含 `destructiveHint / idempotentHint / readOnlyHint / openWorldHint` MCP 标注（对齐 MCP tool metadata 规范）。`MCPServer.swift` `tools/list` 直接返 `ToolDefinitions.all.map(\.asDictionary)`。
- **意义**：MCP annotations（如 `readOnlyHint: true`）供 host 端做 UI 决策（不需用户 confirm）；我们 tool schema 无这些语义。
- **判定**：`[可选]` — 如果 Rocky 未来把 `computer` tool 输出的 destructive-hint 传给主 UI 层做 confirm 弹窗（如 `press_key: cmd+q` 危险级），annotations 值得。当前没有这个消费方，先不加。

---

## §3 权限体系

### 3.1 我们的 Permissions

- **位置**：`app/computer-native/swift/Sources/RockyComputerCore/Permissions.swift`（92 行）
- **策略**：`granted = (TCC.db auth_value == 2) || AXIsProcessTrusted() || CGPreflightScreenCaptureAccess()`（`:14-21`）——**任一 source 视 granted**（防 false negative）。TCC.db 直读走 bundle id + bundle path × client_type 0/1 四组合。
- **权限主体**：Rocky 主 `.app`（TCC "会 dylib 的宿主"），addon 继承（memory `macos-tcc-spawn-no-perm-use-electron-host`）
- **入口**：`Service.readAxTree/screenshot/getAppState/click/*` 里都 `guard Permissions.snapshot().accessibility` 前置

### 3.2 open-codex Permissions

- **位置**：`refs/.../Permissions.swift`（547 行）
- **策略**：与 ours 逻辑一致 `permissionGranted(persisted, runtime)`（`:468`）
- **权限主体**：`com.ifuryst.opencomputeruse`（release） / `com.ifuryst.opencomputeruse.dev`（dev）——两独立 bundle id
- **onboarding**：`PermissionOnboardingApp.launch()`（`OpenComputerUseMain.swift:53`）——`doctor` 命令检测缺权限时启动 SwiftUI onboarding 窗口（`PermissionOnboardingApp.swift` 1435 行），带图文引导 + drag-to-approve
- **candidate 查找**：`preferredInstalledAppBundleURL` 搜 `/Applications` / npm global / homebrew Caskroom / Cellar / 开发目录 fallback（`:229-329`）——因为 open-codex 可从 npm 安装、homebrew 装、直接 download 装，多路径合并
- **judgement rule**：`permissionClients` 合 bundle id + bundle path + release id + dev id 四路（`:178-214`）避免运行位置迁移导致 TCC db 记录失联

### 3.3 差异 & 判定

- **onboarding UI**：`[不移植]` — Rocky 已有 electron UI 处理权限引导（`app/electron/src/permissions/`），不需要 Swift 侧的 SwiftUI onboarding
- **多 candidate 查找**：`[不移植]` — 我们只从一个位置（`Rocky.app`）跑，不需要跨安装源匹配
- **权限模型**：本质等价，判定已对齐 ✓

---

## §4 AX snapshot / 序列化

### 4.1 ElementRecord 字段对比

| 字段 | ours（v0.0.159） | open-codex |
|---|---|---|
| `index` | Int | Int |
| `element` | AXUIElement | AXUIElement? (fixture 时 nil) |
| `role` | String | 无（渲染时 stringValue(of:element, kAXRoleAttribute) 现查） |
| `title` | String? | 无（同上） |
| `value` | String? | 无（同上） |
| `screenFrame`/`localFrame` | CGRect? screenFrame | CGRect? localFrame（window-relative）|
| `actions`（filtered secondary） | [String] | 无（只存 rawActions） |
| `rawActions`（v0.0.159 新增） | [String] | [String] |
| `prettyActions` | 无 | [String]（pretty 别名，如 `AXPress` → `Press`） |
| `identifier` | 无 | String? (`AXIdentifier`) |
| `isSyntheticText` | 无 | Bool（renderer 合并子 AXStaticText 时的合成节点标记） |

- **判定**：
  - `identifier` `[可选]` — 采集 `AXIdentifier` 属性对 fixture 有用（fixture 只用 identifier 定位元素），对真机作用有限
  - `isSyntheticText` `[可选]` — v0.0.159 我们用 `role ∈ {AXStaticText, AXGroup, AXUnknown}` 近似替代（`ClickStrategy.swift:81`），足够；除非要移植 synthetic side action filter 才需要
  - `prettyActions` `[可选]` — 已论述 `actions-diff.md` §1.5，无强移植理由

### 4.2 render 文本对比

- ours：`{indent}{index} {role} "{title}" Value: {value} Secondary Actions: {a1, a2}`（`AccessibilitySnapshot.swift:60-66`）
- open-codex：见 `actions-diff.md` §1.3，极精细（`TreeRenderer` 170+ 行）
- **判定**：ours 简洁足够，`[不移植]` open-codex render，除非发现 LLM 判断力受限于 render 结构

### 4.3 采集深度 / budget

- ours = 1200 / 64 / 500（`AccessibilitySnapshot.swift:39` 默认）
- open-codex = 1200 / 64 / 500（`AccessibilityTreeLimits.defaultMaxNodeCount = 1200`, `defaultMaxDepth = 64`, `defaultTextLimit = 500`）
- **一致** ✓（逐字迁移）

---

## §5 错误处理 / 分类

### 5.1 我们的 ComputerUseError（`Support.swift`）

- 7 case：`message / invalidArguments / permissionMissing(which) / appNotFound / elementNotFound(Int) / notSettable`
- 每 case 有 `code` 字段（`helper_error / invalid_arguments / permission_missing / app_not_found / ax_element_not_found / not_settable`）与 TS 侧 `ComputerErrorCode` 对齐（`native-port.ts:113-117`）

### 5.2 open-codex Errors

- 6 case：`message / unsupportedTool / invalidArguments / appNotFound / permissionDenied / stateUnavailable`
- 无 `code` 字段（走 MCP `isError:true + text` 语义）
- 特色：`stateUnavailable` 是 open-codex 特有——「窗口没找到 / 元素没 frame / 元素没 element backing」等**运行时状态问题**分类，与 `message` 通用错误区分

### 5.3 差异 & 判定

- `stateUnavailable` `[值得移植]` — 我们把这类归到 `message` 或 `elementNotFound`，语义不精确。加一个 `stateUnavailable` 类让 TS 侧能区分「AX 树里找不到」vs「元素没坐标不能点」，对调试 / 用户提示更友好。约 5 行 Swift + `native-port.ts` type 加一个。
- 其余分类均等价

---

## §6 测试策略

### 6.1 我们

- **Swift 侧**：executable runner `RockyComputerCoreTestRunner`（`Tests/RockyComputerCoreTestRunner/main.swift`，188 行）+ 手写 `expect()`。31 assertions 覆盖 `isElectronScopedTarget / isLikelyContainingRowActionFrame / hasPrimaryClickAction` 纯逻辑（不 mock AXUIElement）。跑法：`swift run --package-path app/computer-native/swift RockyComputerCoreTestRunner`。
- **偏离原因**：本机装 Command Line Tools（无 Xcode → 无 XCTest.framework），swiftpm testTarget 编不过
- **TS 侧**：`app/server/src/tools/computer-use/__tests__/` + `platform/computer/__tests__/` vitest UT + `tests/api/{computer,browser}/` AT

### 6.2 open-codex

- **Swift 侧**：`OpenComputerUseKitTests.swift` 单文件 1924 行 **约 133 个 XCTest 用例**，覆盖：
  - CLI 参数解析（15+）
  - `boundedScreenshotPNGData` 大小 / 分辨率 shrink
  - `ToolDefinitions` 表面数量
  - element_index 参数各种输入类型
  - `MacOSAppAgentProxyDecision` 路由
  - `PermissionDiagnostics` 缺失顺序
  - `AppDiscovery` 排序 rules
  - `preferredInstalledAppBundleURL` 优先级
  - `KeyPressParser` xdotool 别名
  - MCP `initialize` response
  - **click 决策集群（14+ 用例）**：`SyntheticTextClickUsesLeadingSafePointOnly / NormalClickKeepsCenterThenLeadingFallback / SyntheticSideActionFilter{RejectsTrailingDoneButton / KeepsMainRowPreviewContainingDone / KeepsLargeRowNamedDone} / HitRecordDescendantScan{RejectsBroadWebAreaHit / KeepsNearbyRowHit} / ContainingRowAction{AcceptsTightClickableAncestor / RejectsBroadWebArea / RequiresPrimaryAction} / ContainingWebRowOptimization{RejectsChromeWebGroups / RejectsChromeSyntheticText / KeepsLarkSyntheticRows / RequiresWebAreaAncestor} / ActivationOnlyClickFallback{RejectsPlainStaticText / KeepsWindowRaisePath} / KeyboardTextFallback{RejectsPlainWebArea / AcceptsEditableTextRole / AcceptsSettableValueElement}`
  - **AX render 集群（20+ 用例）**：`SnapshotRenderedTextStartsDirectlyWithAppHeader / SelectedTextUsesOfficialSingleLineFormat / AccessibilityTreeBudgetAllowsDeepElectronWebViews / AccessibilityRendererElidesEmptyGenericElectronWrappers / OnlyMergesShortTextOnlySiblingRuns / RendersSummariesWithImagesAsChildren / FiltersScrollToVisibleNoise / FiltersImplicitMenuActions / UsesOfficialZoomWindowActionName / KeepsLinkRoleWhenSuppressingChildren / KeepsMarkdownShapeForSummaryLinks / SuppressesDuplicateDescriptionForSameTextMarkdownLinks / FormatsPlaceholderSegment`
  - `BlockingAsyncBridgeTimesOutScreenshotWork`（screenshot timeout）

### 6.3 差异 & 判定

- **XCTest 环境**：`[可选]` — 装完整 Xcode（非 CLT）才能跑 XCTest；v0.0.159 已给出 executable runner 妥协方案，够用。**如果要移植** `actions-diff.md` §1.4 ①/②/③ 项 click fallback，UT 覆盖是必要的——open-codex 的 `ContainingWebRowOptimization*` 4 case 就直接可移植过来，覆盖我们 v0.0.159 移植的策略函数。
- **fixture bridge**：`[可选]`（见 §2.5）— 让完整 Service 链路走 UT 需要 fixture
- **我们独有的 TS AT 覆盖**：`tests/api/computer/` 与 `tests/api/browser/` — open-codex 是纯 Swift + xctest，无对应；我们对 TS 侧 tool → port → mock port 有 AT 覆盖，这层他们没有。

---

## §7 视觉 / 交互反馈

（见 §2.4 已展开）

**补充**：open-codex 的 `pulseVisualCursor(at:clickCount:mouseButton:)` 在 click 后触发 3 阶段动画（scale-up → hold → scale-down），持续约 300ms。这个反馈**对开发者可见**——用户能看到"agent 在你屏幕上点了哪里"，与 agent action 建立 trust。

**是否是我们的缺陷**：视 dogfood 用户角色定，如果只做 rocky 内部 dogfood（我们已看得到 chat log），非缺陷；如果做外部 dev preview（用户屏幕上真的动东西），视觉反馈缺失会让用户困惑「刚才 agent 点了啥」。

---

## §8 tool schema / MCP 集成

（见 §2.6）

**补充观察**：open-codex 每个 `ToolDefinition.description` 都以 `"This tool is part of plugin \`Computer Use\`."` 结尾（`refs/.../ToolDefinitions.swift:35/54/69/...`）——这是 Codex 端的插件识别 marker。我们无对应需求。

Rocky 的 `computer.description`（`computer.ts:88-94`）已很完整，不需要拆成 9 个独立 tool——反而单 tool + action-discriminated 对 LLM tool inventory 更节约 token。
