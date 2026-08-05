---
type: spec
title: Computer Native Capability（ComputerNativePort + 主进程 native addon 注入链）
priority: P1
status: active
updated: 2026-07-16
since: v0.0.105
notes: "v0.0.160 全面对齐 open-codex 17/17 gap 闭合；SoftwareCursorOverlay API 就位但 Service 集成推迟单独版本（默认关）；FixtureBridge 仅 bridge 层（fixture app + XCTest 推迟）"
---

# Computer Native Capability — agent 控制 macOS 桌面的原生能力端口

> 管什么：`ComputerNativePort`（纯 TS 接口，server 零 electron）+ 主进程 native addon（Swift dylib + N-API）直调 + 三态注入 precedence（AT mock / dev loopback / packaged registry 直调）+ 数据形状类型（截图/AX 树/坐标/动作 options）+ 权限态两态门禁形状。
> 不管什么：单 `computer` tool 协议/dispatch/门禁（→ `../tools/[P1]computer_use_tool.md`）；UI 权限卡片（→ `specs/ui/overall/05-connectors.md` + `connector-page/section-computer-connector.md`）；ImageBlock 协议原语（→ `../message/[P0]agent_message_interface.md §4.2`）。
> 蓝本：iFurySt open-codex（`specs/research/v0.0.105-cu-ifuryst-open-codex.md`）—— 复用 postToPid + ScreenCaptureKit + AXUIElement 逆向成果。

## 1. 概述（架构铁律）

**macOS 原生能力（截图 / AX 树 / 键鼠输入 / 权限查询）必须在 Rocky Electron 主进程内实现**（`com.rocky.agent` = TCC 权限主体）。**绝不 spawn 独立 helper 二进制。**

真机 dogfood 铁证：`@app/server` 裸 spawn Swift helper 子进程**拿不到 macOS TCC 权限**（TCC 按进程签名身份判定，spawn 子进程不继承宿主授权，实测 4+ 次）。native addon 是主进程加载的动态库（`.node` + Swift `dylib`），**继承主进程 TCC 身份**——与 spawn 子进程本质区别。详见 memory `macos-tcc-spawn-no-perm-use-electron-host`。

```
                       [ Rocky Electron 主进程 = TCC 权限主体 ]
app/electron (唯一 import electron)                app/server (零 electron)
┌──────────────────────────────────────┐   ┌──────────────────────────────────────┐
│ main.ts startBackend()               │   │ ComputerNativePort (纯 TS interface)   │
│  packaged: setComputerNativePort(     │─→ │  native-port-registry (setX/getX)      │
│    makeElectronComputerNativePort())  │   │   ↓ bootstrap precedence 单选           │
│  dev:      startComputerLoopbackServer│   │ BootstrapResult.computerNativePort     │
│ computer-native-port.ts               │   │   ↓ 两处 deps 组装点注入 ctx.config     │
│  → callNative(addon, method, dict)    │   │ tools/computer-use/computer.ts         │
│ computer-native-addon.ts (加载 .node) │   │   → port.<method>() → 包装 ToolRunResult│
└──────────────────────────────────────┘   └──────────────────────────────────────┘
      ↓ N-API                                        ↑ mock (AT) / loopback (dev)
 app/computer-native/swift/…/RockyComputerCore (Swift dylib：ScreenCaptureKit + AX + CGEvent postToPid)
```

**核心翻转（v0.0.105 pivot）**：废除「ConnectorManager → spawn Swift helper driver → IPC session」三层，改为「主进程注入 `ComputerNativePort` 实现 → server tool 直调 port」。computer **去连接器语义**（无 toggle / owner 锁 / connect-disconnect / session 生命周期；本机主进程常驻能力，不像 browser 连外部 CDP）。

## 2. ComputerNativePort 接口（权威）

`app/server/src/platform/computer/native-port.ts`（行为契约 + 权限态 + Error 类）+ `native-port-types.ts`（数据形状，`native-port.ts` `export *` 再导出保 import 面稳定）。

**11 能力**（对齐 open-codex 9-tool + 2 省 token 补充）。方法均 `ok=false 返 reason 不抛`（fail-closed，addon 缺失/权限缺失 impl 侧收敛为 `ok:false`）：

```typescript
interface ComputerNativePort {
  // 读类
  checkPermissions(): Promise<ComputerPermissions>;                      // {accessibility,screenRecording} 两态
  screenshot(opts?: ComputerScreenshotOptions): Promise<ComputerScreenshotResult>;  // native 单窗口截图
  getAppState(opts?: GetAppStateOptions): Promise<GetAppStateResult>;    // 截图 + AX 树合一（主 action）
  readAxTree(opts?: AxTreeOptions): Promise<AxTreeResult>;               // 纯 AX 树（省图像 token）
  listApps(): Promise<AppInfo[]>;                                        // 运行中 app（异常返空数组）
  // 动作类（返 ComputerActionResult{ok,reason?}）
  click(target: ComputerTarget, opts?: ClickOptions): Promise<ComputerActionResult>;
  type(text: string, opts?: TypeOptions): Promise<ComputerActionResult>;
  scroll(target: ComputerTarget, opts: ScrollOptions): Promise<ComputerActionResult>;   // direction 必填
  pressKey(keySpec: string, opts?: PressKeyOptions): Promise<ComputerActionResult>;      // xdotool 语法
  drag(from: PixelPoint, to: PixelPoint, opts?: DragOptions): Promise<ComputerActionResult>;
  setValue(elementIndex: number, value: string, opts?: SetValueOptions): Promise<ComputerActionResult>;
  performSecondaryAction(elementIndex: number, action: string, opts?: SecondaryActionOptions): Promise<ComputerActionResult>;
}
```

**MUST 零 electron 依赖**（纯 interface）；**MUST NOT 声明 connect/session/disconnect**（去连接器语义）。

**关键数据形状**（`native-port-types.ts`）：

| 类型 | 关键字段 | 说明 |
|---|---|---|
| `ComputerPermissions` | `accessibility` / `screenRecording`: `'granted'\|'missing'` | 两态闭合，非 granted 一律 missing（fail-closed）。`coercePermissions(raw)` 归一化，mock/loopback 共用 |
| `ComputerScreenshotResult` | `ok, mediaType?('image/png'\|'image/jpeg'), data?(裸 base64 无 data: 前缀), width?, height?, windowBounds?, scaleFactor?, reason?` | **字段名 `mediaType`（非 `mime`）**；`data` 裸 base64（v0.0.157 起 tool 经 `saveSnapshot` 落盘 + 路径文本，**不再 inline 进 ImageBlock.source.data**）；`windowBounds` = 单窗口 screen point 边界（coordinate 三段式偏移源） |
| `GetAppStateResult` | `ok, screenshot?, axText?, pid?, scaleFactor?, windowBounds?, reason?` | 单窗口截图 + AX 树合一；`axText` = 行首 element_index 渲染树（喂 LLM 主体） |
| `AxTreeResult` | `ok, text?, nodes?, pid?, scaleFactor?, reason?` | AX-only（无截图）；`text` 作 TextBlock |
| `ComputerTarget` | `{elementIndex:number} \| {coordinate:PixelPoint}` | element_index 主 / coordinate 辅 |
| `AxTreeOptions` / `GetAppStateOptions` | `app?, textLimit?(number\|'max'), maxNodes?, maxDepth?` | **驼峰 `maxNodes`/`maxDepth`**（tool schema 的 `max_tree_nodes`/`max_tree_depth` 由 `resolveAxOptions` 映射）；`GetAppStateOptions = AxTreeOptions` 同形别名。**v0.0.160**：`textLimit` 类型扩为 `number \| 'max'`（`'max'` = 无上限关键字，Swift `SnapshotTextLimit.parse` 消费；tool schema `oneOf: [integer, {enum:['max']}]`） |
| `AppInfo` | `bundleId, name, pid` + **v0.0.160 optional** `line?, isFrontmost?, lastUsed?(ISO8601), uses?` | `line` = Swift `AppDiscovery.renderedLine` 单行 LLM 渲染（含 flags）；`isFrontmost/lastUsed/uses` = Spotlight 元数据；`list_apps` 优先用 `line` 输出，无则回退旧格式 |
| 各动作 `*Options` | 均含 `app?`（app-scoped hint，Swift `resolvePid` 定位，缺省 frontmost）+ `pid?` | ClickOptions 另有 button/clickCount；ScrollOptions direction 必填 + pages |

`ComputerError`（code + message + which?）：`ComputerErrorCode` = `unsupported_platform`/`permission_missing`/`no_coordinate_context`/`native_error`/**`state_unavailable`（v0.0.160）**/`unknown`。

**`state_unavailable` 语义（v0.0.160，对齐 Swift `ComputerUseError.stateUnavailable`）**：「元素还在但没坐标 / 元素消失 / 无 backing AX object / focused 元素非可编辑 / focused window 缺失且 recover 失败」等运行时状态问题，与 `native_error` 通用错误区分。actions 侧（`type-text.ts` / `set-value.ts`）识别 `code === 'state_unavailable'` 时返友好中文文案 + 保留 native 原始 message 供 debug。前端可给「先建立坐标上下文 / 重新 get_app_state」类提示。

## 3. 三态注入 precedence（替代旧 ConnectorManager bootstrap）

`app/server/src/bootstrap.ts` 单选 precedence（互斥，优先级高→低）：

```
computerNativePort = resolveMockComputerNativePort(env, dataDir)   // ① AT
                  ?? resolveLoopbackComputerNativePort(env)        // ② dev
                  ?? getComputerNativePort()                       // ③ packaged registry
```

| 态 | 触发条件 | port 实现 | 闭环 |
|---|---|---|---|
| **① AT mock** | `ROCKY_TEST_COMPUTER_NATIVE_PORT==='mock'`（env_start 默认设） | `MockComputerNativePort`（读 `<DATA_DIR>/computer-mock.json` fixture，call-time fresh 读，零子进程/零 GUI） | 守 memory `test-no-real-spawn-system-gui`；成败纯由 fixture 驱动 |
| **② dev loopback** | `ROCKY_DEV_COMPUTER_LOOPBACK_PORT` 有值（仅 dev.env 设） | `LoopbackComputerNativePort`（纯 fetch → Electron 主进程 loopback 通道） | dev（bun 独立后端）可验闭环，见 §4 |
| **③ packaged registry** | 无 mock/loopback env | `getComputerNativePort()`（main.ts packaged 分支 `setComputerNativePort(makeElectronComputerNativePort())` 直注入） | 主进程内直调，全闭环 |
| 降级 | 三者皆无（非 electron/无通道） | `undefined` | tool 返「仅 Rocky 桌面 App 可用」（不阻断启动） |

**为何 registry setter 而非 startServer opts 透传**：`handleRequest(req, dataDir)` 是全局纯函数、bootstrap 按 dataDir 缓存懒建，port 是 process 级单例（一个 Electron 宿主）。setter（`native-port-registry.ts` setX/getX，架构原则#6）最小侵入，不污染 `handleRequest`/`getBootstrap` 签名；main.ts 首个请求前 set → bootstrap 首建时读到，时序安全。

**两处 deps 组装点必须都注入**（BUG-001 教训 `session-config-two-deps-assembly-points`）：
1. `router.ts sessionDeps`（`computerNativePort: bs.computerNativePort`）→ `session-config.ts` 注入块（`computerNativePort: deps.computerNativePort`）→ `ctx.config.computerNativePort`。
2. `bootstrap.ts` 的 `setResolveConfig` 闭包（resolveConfig 通路透传 `...(computerNativePort ? { computerNativePort } : {})`）。漏任一处 → agent-loop 运行时 tool 经 `ctx.config` 读不到 port（fail-closed）。

## 4. dev loopback 通道（让 dev 后端够到主进程 addon）

**根因**：dev 三进程 = ① Electron 主进程（不起后端，持有 native addon + TCC 身份）② 独立 bun 后端（agent 工具在此进程跑，TS-direct 热重载）③ vite dev server。agent 工具走 bun 后端进程，**够不到主进程 addon**。

**方案**：Electron 主进程（dev）额外起极小 `node:http` loopback server（bind `127.0.0.1:ROCKY_DEV_COMPUTER_LOOPBACK_PORT`，`computer-loopback-server.ts`），内部复用 `makeElectronComputerNativePort()` 实例；bun 后端的 `LoopbackComputerNativePort` 纯 fetch 走通道。**保 bun 后端进程模型零改动**（不选「后端进主进程」——那会致 bun→Electron-Node 编译 + 重启焊死 + 与 test env 进程模型分裂）。

通道路由（`routeLoopback`，每请求校验 `x-rocky-dev-token` header）：
- `GET /permissions` → `port.checkPermissions()`
- `POST /screenshot` → `port.screenshot(opts)`（body = 截图 opts）
- `POST /invoke {method, params}` → `port[method](...params)`（**泛路由**，method 白名单校验，承接全部 native 方法，免为每动作开专属端点）

vite proxy / backend-bootstrap **零改动**（后端间通信不经渲染层）。AT/packaged 零影响（mock 优先级最高，loopback env 仅 dev.env 设）。

## 5. 主进程实现 = native addon（app/electron + app/computer-native）

`app/electron/src/computer-native-port.ts` `makeElectronComputerNativePort(deps?)`：
- `checkPermissions` → 走 electron `systemPreferences`（复用 spike `computer-permissions-ipc.ts computeGetPermissions`；addon 不管权限查询），UI spike 形状（accessibility:bool / screenRecording:多态）→ tool 门禁两态。
- 其余 10 方法 → 拼 native params dict（named 字段）→ `callNative(addon, method, dict)`（`computer-native-addon.ts`：`addon.invoke(method, JSON.stringify(params))` → 解包信封 `{ok, result?|error?}`）→ map 到 TS 结果。**screenshot/getAppState 走 native ScreenCaptureKit 单窗口截图**（非 Electron desktopCapturer 全屏——单一 window-relative 坐标模型不容两套截图坐标空间）。
- addon lazy require + 闭包缓存；**addon 缺失/加载失败 fail-closed**（各方法返 `{ok:false}` / 空数组）。`makeElectronComputerNativePort(deps)` 接受注入（fake systemPreferences + fake addon）→ UT 无需 electron runtime / 无需触真原生动作。

**native addon**（`app/computer-native/`）：Swift dylib（`swift/Sources/RockyComputerCore/`）+ N-API C++ 桥（`src/addon.cc` AsyncWorker off-main）+ 构建链（`swift build -c release` → `libRockyComputerCore.dylib` → node-gyp `rocky_computer.node`，rpath `@loader_path` 并置 dylib）。

| Swift 文件（v0.0.160 全部 top-level 平铺，共 33 个 .swift；SwiftPM 一层） | 职责 | 底层 API |
|---|---|---|
| `Screenshot.swift` | 单窗口截图 + async→sync 桥 + PNG 压缩 | `SCShareableContent.current` → `SCContentFilter(desktopIndependentWindow:)` → `SCScreenshotManager.captureImage`；`boundedPNGData`(900KB/1280px 步进)；`BlockingBridge.run(timeout:5)` |
| `InputSimulation.swift` | 键鼠输入（后台，不抢前台） | `CGEvent.postToPid(pid)`（定向投递，不走全局 event tap → 仅需 Accessibility）；clickTargeted/scrollTargeted/dragTargeted/typeText/pressKey |
| `KeyMapping.swift` | xdotool 语法 → virtualKey | `KeyPressParser.parse` |
| `Permissions.swift` / `Support.swift` | 权限快照 + Error 集 | Screenshot 前置权限；**v0.0.160 `Support.swift`** 加 `ComputerUseError.stateUnavailable(String)` case + `code`/`text` switch 分支透传 `"state_unavailable"` 字面量供 TS 侧 `ComputerErrorCode` 映射 |
| `CBridge.swift` | `@_cdecl` C ABI 桥（invoke/ping/free） | JSON-in/JSON-out，异常 fail-closed `{ok:false,error,code?}`；code 由 `ComputerUseError.code` 派生透传 |
| `AccessibilitySnapshot.swift` | AX 树采集入口 + `ElementRecord` + `AxSnapshot` + `SnapshotTextLimit` + `SnapshotMode` + `prettyActionName` 静态 helper | `AXUIElementCopyAttributeValue` 遍历；`ElementRecord`（v0.0.159 `actions` filtered + `rawActions` 未过滤 AXPress + **v0.0.160 新增 `identifier`/`isSyntheticText`/`prettyActions`**，三新字段供 click 策略层 + LLM 视图 pretty action）；`copyParent` / `hasAncestorRole(depth≤12)` AX 祖先遍历 primitive；**v0.0.160 新增**：`SnapshotTextLimit`（值类型 `maxCount: Int?`，`.defaults(500)` / `.max(nil)` / `parse("max"\|"N")` 字符串解析，对齐 open-codex `SnapshotTextLimit`）+ `SnapshotMode` enum（`.accessibility` / `.fixture`，`AxSnapshot.mode` 字段预留 fixture 路径）+ `AxSnapshot.records` 类型改 `[Int: ElementRecord]`（对齐 open-codex 索引 map；Service `nodes` 输出改 `records.values.sorted{$0.index<$1.index}.map`）+ `prettyActionName` 公开静态方法（供 Service.performSecondaryAction 两级 match + ClickStrategy 复用）；`build()` 内 `AXUIElementCreateApplication(pid)` 之后**focused window nil → `WindowRecovery.recoverVisibleWindow` 自愈 → 重查 → 仍 nil throw `.stateUnavailable(computerUseNoWindowFoundMessage)`**（对齐 open-codex `SnapshotBuilder.build:160-168`）；`build()` 内 walk 委托 `TreeRenderer.render` 主渲染 |
| `WindowRecovery.swift`（v0.0.160 新增） | 隐藏/最小化窗口自愈 | `recoverVisibleWindow(pid:bundleId:appElement:preferredWindow:) -> Bool`：`NSRunningApplication(pid).unhide()` → `.activate(options:.activateAllWindows)` → `NSWorkspace.shared.urlForApplication(withBundleIdentifier:) + openApplication(at:configuration:completionHandler:)`（DispatchSemaphore 0.5s timeout，替代 open-codex 已弃用的 `launchApplication(withBundleIdentifier:)`——**语义等价，保「不 spawn 子进程」承诺**）→ AXUnminimize set false → `kAXMainAttribute=true` / `kAXFocusedAttribute=true`；任一成功 `recovered=true`，末尾 sleep 0.7s。顶层常量 `computerUseNoWindowFoundMessage = "Apple event error -10005: cgWindowNotFound"` 供 `.stateUnavailable` 消息 |
| `ClickStrategy.swift` | click 决策序列（策略层，v0.0.160 编排扩至 300 行硬约束） | v0.0.159 基础：`isElectronScopedTarget(bundleId,appName)` / `shouldPreferContainingWebRowAXClick` / `hasPrimaryClickAction` / `isLikelyContainingRowActionFrame` / `performAction` / `performContainingWebRowClick`（6 层祖先 AXPress）/ `performPreferredClick`（左键 AXPress→AXConfirm→AXOpen；右键 AXShowMenu）/ `performAXClickSequence`（主编排）。<br>**v0.0.160 扩展**：`performPreferredClick` 左键分支加前置 `clickCount<=1 && !hasAncestorRole("AXWebArea") → selectContainingListItem`；`performAXClickSequence` 签名扩两 bool `includeNearbyHitTesting/allowActivationFallback`（默认 true 保 v0.0.159 兼容）+ pid/allRecords 两参数（默认 0/[:]），4 层 fallback 编排：① web row 优化 → ② `performPreferredClick` → ③ `descendantClickCandidates` 3 层子树扫 → ④ `includeNearbyHitTesting=true` 时对 `clickActionPoints` 每点 hit-test 双候选 → ⑤ `allowActivationFallback && button==.left && canUseActivationOnlyClickFallback(role)` → `activateClickTarget`（AXRaise+kAXMain+kAXFocused） |
| `ClickHitTest.swift`（v0.0.160 新增，297 行） | AX 几何/hit-test helpers（承接 ClickStrategy 超行拆分） | `descendantClickCandidates(for:sideActionScope:)`（3 层子树扫 depth<3 + `clickPriority`/`frameArea` 排序 + `isLikelySyntheticSideAction` filter）；`clickPriority(for:)`（primary AXPress/Confirm/ShowMenu/Raise=0 / kAXMain\|Focused settable=1 / else=2）；`frameArea(of:)`；`accessibilityLabels(for:)`（Title/Description/Help/Value/AXIdentifier compactMap）；`isLikelySyntheticSideAction` + `isLikelySyntheticSideActionCandidate`（trailing-band ≥ maxX-min(max(w*0.22,56),140) + compact ≤ max(88,w*0.18)×max(44,h*1.2) + 关键词过滤右侧「完成/done/archive/mark…done」误伤，纯函数 UT 覆盖）；`canUseActivationOnlyClickFallback(role: kAXWindowRole)`；`activateClickTarget(element:availableActions:)`（三步 `\|\|` 累积非短路：AXRaise → setBool kAXMain → setBool kAXFocused）；`setBoolAttribute(named:on:) throws -> Bool`（对齐 open-codex 错误处理模式）；`selectContainingListItem(for:) throws -> Bool`（非 web area 向上 8 层找 AXList set kAXSelectedChildrenAttribute + sleep 0.15） |
| `ClickCoordinateHitTest.swift`（v0.0.160 新增，119 行） | coordinate click 双候选支撑 | `bestElement(containing:in records:)`（filter localFrame.contains + `clickPriority`/`frameArea` 排序 first）；`hitTestElement(at:pid:)`（`AXUIElementCopyElementAtPosition` 拾取构造 ElementRecord，index=-1）；`clickCandidates(at:in records:pid:)`（`bestElement` + `hitTestElement` 去重合并，`sameElement` 用 `CFEqual` 判等）；`clickActionPoints(for:)`（isSyntheticText 且非 web area 向上找 row frame，否则 record.screenFrame；leading=minX+min(24,w*0.3)，center-leading 距离<1 单 center，否则 [center, leading]）；`shouldScanDescendantsOfHitRecord(originalFrame:hitFrame:)`（面积>12x/高>4x*96 且宽>2x*240 早退 false，nil frame 默认 true） |
| `TypeTextStrategy.swift`（v0.0.160 新增，209 行） | type_text 三段式（对齐 open-codex L576-595 + L1222-1298） | `typeTextBySettingFocusedValueIfAvailable(_ text:in focused:) throws -> Bool`（focus element `isSettableForSetValue(kAXValueAttribute)` false → false；否则 `editableBaseValue` 拿旧值 → `AXUIElementSetAttributeValue(focused, kAXValueAttribute, (base+text) as CFString)`，绕 React 合成事件层直入 DOM）；`canTypeTextUsingKeyboardFallback(in focused:) throws -> Bool`（role ∈ AXTextField/AXTextArea/AXTextView / roleDescription 含 "text field/area/entry" / valueSettable → true）；`editableBaseValue`（递归 `editableDescendantTextValues` 深度 ≤4 + placeholder 过滤）+ `humanizedRoleDescription` + `normalizeEditablePlaceholderText`（去 `\u{200B}` 零宽 + trim + Lark 特定占位 `"沟通时请保持"公开可接受""` 匹配） |
| `AppDiscovery.swift`（v0.0.160 新增，295 行含 Applications enum 迁入） | list_apps 增强入口 + 排序 | `Applications.list()`（从 v0.0.105 「只列运行中 .regular」改为调 `listCatalog()`，输出 `[{bundleId,name,pid,isRunning,line,isFrontmost?,lastUsed?,uses?}]`，pid 走 running 匹配缺失=0）；`ListedAppDescriptor` struct（+ `renderedLine` computed `"<name> — <bundleId> [frontmost, running, last-used=YYYY-MM-DD, uses=N]"`）；`compareListedApps`（排序 frontmost > running > lastUsed > uses > name）；`recentUsageCutoff`（近 14 天）；`maxRecentNonRunningApps=10` |
| `SpotlightAppIndex.swift`（v0.0.160 新增，177 行） | Spotlight 元数据同步 | `SpotlightAppIndex.recentApps(cutoffDate:) -> [SpotlightAppRecord]`：同步 `NSMetadataQuery`（`NSMetadataQueryLocalComputerScope`）→ predicate `kMDItemContentType == "com.apple.application-bundle"` → sortDescriptors `kMDItemLastUsedDate_Ranking` desc；超时 5s；**fail-closed** 权限缺失/异常返 `[]`（`AppDiscovery.listCatalog` 降级为仅运行中，保 v0.0.105 兼容） |
| `FixtureBridge.swift`（v0.0.160 新增 bridge 层 only，175 行） | 测试固定桩 bridge（fixture app + XCTest 推迟单独版本） | `FixtureRect/FixtureElementState/FixtureAppState/FixtureCommand` Codable + Sendable structs；`FixtureBridge` enum：`appName = "RockyComputerUseFixture"` + `distributedNotificationName = "com.rocky.computer-use.fixture.command"` + `stateFileURL`（`NSTemporaryDirectory/rocky-computer-use-fixture/state.json`）+ `readState()`（5 次重试 sleep 0.05 应对写方原子未落）+ `writeState()` + `post()` DistributedNotificationCenter；`SnapshotMode.fixture` 分支 Service 侧 9 method 加 `// TODO(v0.0.160-P1-A)` 占位（当前透明 no-op 走 `.accessibility` 路径）；`RockyComputerUseFixture` app + XCTest **推迟到本机装 Xcode 后单独版本**（现 CLT 缺 XCTest.framework）。**Rocky 命名空间偏离**：appName/notification/stateFileURL 目录名从 open-codex `OpenComputerUseFixture` / `dev.opencodex.*` 换 Rocky-scoped，语义 100% 对齐 |
| `TreeRenderer.swift`（v0.0.160 新增，246 行） | AX 树精细化 render 主入口（对齐 open-codex `TreeRenderer` L666-838） | `TreeRenderer` struct + `RenderContext`（`textLimit: Int? / treeLimits / windowBounds / focusedElement` 值类型）+ `render(_ root:depth:ancestors:)` 主编排 173 行（10 段：`shouldContinueRendering` 门禁 → `shouldElideNode` 隐藏空 wrapper → traits/title/rowSummary/label/help/url/identifier/value/placeholder/actions 分段 → linePrefix `"\(index) \(roleText)"` → records[index] 填充三新字段 → children 遍历 rows/contents/visibleChildren 优先级组合，`CFEqual` 环检）+ `renderSyntheticText`（短文本合成节点，`isSyntheticText=true` 仅此路径）。缩进从 v0.0.105 4 空格改 tab 对齐 open-codex |
| `TreeRendererSegments.swift`（v0.0.160 新增，293 行） | render 纯函数集（几何/字符串/优先级） | `sanitizeText / displayIdentifier / segments (Label/Value/Placeholder/Identifier) / shouldElideNode / shouldSuppressChildren / displayRoleText / meaningfulActions / shouldMergeTextOnlySiblings / childTraversalAttributes / windowRelativeFrame / shouldContinueRendering` + AX 常量（`axWebAreaRole / axContentsAttribute / axVisibleChildrenAttribute`） |
| `TreeRendererHelpers.swift`（v0.0.160 新增，246 行） | AX-dep 中层 helpers | `_axAttrValue / _axString / _axArray / _axElement / _axBool / _axIsSettable / _axActions` AX 便捷 wrappers + `summarizeTraits / valueTypeTrait / roleDescription / preferredDisplayTitle / markdownLinkText / outlineRowSummary / formattedValueSegment / formattedURLSegment / urlValue / sanitizedValue / placeholderValue / copySelectedText` |
| `TreeRendererSummary.swift`（v0.0.160 新增，151 行） | generic wrapper 折叠 + row 展开 | `summarizedGenericText / summaryImageDescendants / isPlainGenericTextContainer / descendantTextsForSummary / summaryTextForLink / flattenedRowTexts / descendantTexts / visibleRows / shouldSkipChild / webAreaDepth`（避免 Electron 深嵌 wrapper 灌爆 token 的核心逻辑） |
| `SoftwareCursorOverlaySupport.swift`（v0.0.160 新增，289 行） | 视觉光标 env 门禁 + 基础类型 | `VisualCursorSupport.isEnabled`（读 `ROCKY_CU_VISUAL_CURSOR` env，默认关；未设/`""` = 关；`1/true/yes/on` = 开）+ heading/velocity/idlePose free 函数 + Codable snapshot 类型 + `CursorTargetWindow(windowID:layer:)` + `CursorArtwork` + `shouldReorderCursorPanel` + `CursorPanel`（NSPanel 子类，不接键鼠）+ `SoftwareCursorView`（NSView + CoreGraphics 光标绘制）+ 顶层 `rockyComputerUseTurnEndedNotificationName = "com.rocky.agent.turn-ended"` |
| `SoftwareCursorOverlay.swift`（v0.0.160 新增，253 行） | overlay 主 enum + public API | `@MainActor enum SoftwareCursorOverlay`——Rocky 命名 public API `moveVisualCursor / pulseVisualCursor / settleVisualCursor` 三 `nonisolated static func`（内部 `DispatchQueue.main.async` fire-and-forget 主线程调度 + `VisualCursorSupport.isEnabled` 门禁 guard，默认关自动 no-op）；同时保留 open-codex 逐字对齐 API `moveCursor / pulseClick / settle / reset` + `prepareWindowIfNeeded / configureOrdering` |
| `SoftwareCursorOverlayAnimation.swift`（v0.0.160 新增，279 行） | @MainActor extension — 动画 | `animateMove`（spring-timed 曲线路径）+ `bestMotionCandidate`（`HeadingDriven` candidates 择优 + 目标窗口重合度评估）+ `animateClickPulse`（sinusoidal pulse，右键幅度略低）+ idle 60fps timer + `scheduleHide` 淡出 |
| `SoftwareCursorOverlayRendering.swift`（v0.0.160 新增，262 行） | @MainActor extension — 渲染 | `placeCursor / advanceVisualDynamics / seedVisualDynamicsIfNeeded / clampTipPosition / writeObservationSnapshot / pumpFrame / motionBounds / windowConstraintHitCount / candidatePreference / refreshActiveOrderingIfNeeded` |
| `SoftwareCursorGlyphRenderer.swift`（v0.0.160 新增，299 行） | 光标位图渲染（procedural CoreGraphics） | `SoftwareCursorGlyphMetrics` 常量（windowSize 126×126 / tipAnchor 60.35,70.3 / pointerSize 21×21）+ `SoftwareCursorGlyphRenderState` + `SoftwareCursorGlyphRenderer.draw`（雾 + pointer procedural）；参考位图 loader `loadReferenceCursorWindowImage()` 恒 nil（Rocky 无 asset），走 procedural 分支 |
| `CursorMotionPath.swift`（v0.0.160 新增，229 行） | 光标路径数据结构 | `CursorMotionSegment / CursorMotionPath / CursorMotionMeasurement / CursorMotionCandidate / CursorMotionKind`——cubic Bezier segments + `sample(t) / sampledConstraintPoints / measure(bounds:)` |
| `CursorMotionGeometry.swift`（v0.0.160 新增，118 行） | pure math — cubic 采样 + CG 扩展 | `sampleCubic + sampleCubicTangent` + `CGRect/CGPoint/CGVector/CGFloat` 数学扩展（长度 / 归一化 / 垂直 / scaled / clamped + `cursorIdentifier` 格式化） |
| `CursorMotionSpring.swift`（v0.0.160 新增，147 行） | 光标 spring 动力学 | `CursorMotionSpringConfiguration.official`（response=1.4 damping=0.9 240Hz）+ `CursorMotionSpringState` + `CursorMotionProgressAnimator.advance / isCloseEnough / closeEnoughTime` |
| `CursorMotionOfficial.swift`（v0.0.160 新增，280 行） | open-codex 官方候选曲线族 | `OfficialCursorMotionModel`：guide 向量派生 + primary/secondary extent 二分段 + `tableA × tableB` 双弧候选生成 + 几何打分 + `closeEnoughTime` 缓存 |
| `CursorMotionHeadingDriven.swift`（v0.0.160 新增，297 行） | 主动力学模型（heading-driven） | `HeadingDrivenCursorMotionModel`：`makeCandidates / chooseBestCandidate / makePath / makeCandidate / scoreCandidate / preferredTurnSide / resolvedGuide / signedAngle` |
| `CursorMotionDescriptors.swift`（v0.0.160 新增，155 行） | descriptors 表 | `HeadingDrivenCursorMotionModel.descriptors`——10 条 direct/turn/brake/orbit 曲线族参数 + `MotionDescriptor` struct |
| `CursorMotionMetrics.swift`（v0.0.160 新增，67 行） | 打分上下文 | `HeadingDrivenCursorMotionModel.MotionScoringContext`(turnDemand/arrivalDemand/directness) + `.MotionMetrics`(start/end/dx/dy/distance/direction/normal/factors) |
| `CursorMotionVisualDynamics.swift`（v0.0.160 新增，292 行） | 视觉动态 render state | `CursorVisualSpringConfiguration` + `CursorVisualDynamicsConfiguration.officialInspired`（tip+angle spring + body/fog 系数）+ `CursorVisualDynamicsState` + `CursorVisualRenderState` + `CursorVisualDynamicsAnimator.advance` 步进器 |
| `ServiceHelpers.swift`（v0.0.160 新增，35 行） | file-scope 纯函数（保 Service.swift ≤ 300 硬约束） | `matchingAction(requested:record:) -> String?`（rawActions exact case-insensitive → prettyActions 位置索引反查 rawActions；LLM 说 `Raise/Press` 可命中 `AXRaise/AXPress`）+ `integralScrollPageCount(pages:) -> Int?`（浮点 tolerance 0.000001 判整数） |
| `Service.swift` | 各 method 编排 + `lastRecords`/`lastPid`/`lastBundleId`/`lastAppName` 缓存（v0.0.160 = 295 行） | `resolvePid(appHint:)`；element_index 缓存 last-call-wins；**v0.0.160 变更**：click element_index 传 `lastPid/lastRecords` 给 `performAXClickSequence` 激活 hit-test 分支；click coord 分支走 `ClickCoordinateHitTest.clickCandidates(at:in:pid:)` 双候选 → `performAXClickSequence(..., includeNearbyHitTesting:false, allowActivationFallback:false)`（对齐 open-codex 严格 coord 契约）→ 全失败 `InputSimulation.clickTargeted` CGEvent 兜底；type 走 `TypeTextStrategy` 三段式，无 focused editable throw `.stateUnavailable`；scroll AX-first：`integralScrollPageCount(pages) != nil && rec.rawActions 含 AXScroll<Dir>ByPage`（`direction.capitalized`）→ `AXUIElementPerformAction` × N 次每次 sleep 0.05，否则 CGEvent；setValue 尾部 `Thread.sleep(0.1)`；performSecondaryAction 走 `matchingAction` 两级 match + sleep 0.15；**光标 overlay Service 侧未集成**（默认关，用户 dogfood 单独版本再开，见 §6.1） |
| `Tests/RockyComputerCoreTestRunner/{main.swift, Block1Tests.swift, Block2Tests.swift, Block3Tests.swift, Block4Tests.swift, Block5Tests.swift, Block6Tests.swift}` | executable UT runner（v0.0.160 拆 6 Block 文件保 main.swift ≤ 300 行） | 沿用 v0.0.159 `executableTarget` + 手写 `expect()` runner 妥协（本机 CLT 缺 `XCTest`/`Testing` module）；**v0.0.160 累计 419 asserts 全绿**（Block1=36 error/AX 基础 / Block2=40 ClickHitTest 纯函数 / Block3=61 matchingAction/integralScroll/hit-test/TypeText 纯函数 / Block4=55 AppDiscovery/Spotlight/Fixture Codable / Block5=100 TreeRenderer pure helpers / Block6=66 CursorMotion 纯数学 + env 门禁 + 通知常量）；跑法 `swift run --package-path app/computer-native/swift RockyComputerCoreTestRunner`。AX-dep 函数（`copyParent` / `hasAncestorRole` / `AXUIElementPerformAction` / `descendantClickCandidates walk` / recover 集成路径）**不入 UT**——AXUIElement 无 mock 途径，走 dev dogfood 手验（对齐既有 Rocky 惯例） |

## 6. 坐标模型（window-relative 三段式，对齐 open-codex）

`app/server/src/platform/computer/coords.ts`（`pixelToGlobalPoint` + `deriveScaleFactor`）：

```
scaleFactor  = deriveScaleFactor(截图像素宽, windowBounds, reported)   # 优先 截图宽/windowBounds.w（多显示器混合 DPI 更准）
windowPoint  = screenshotPixel / scaleFactor                          # 回 point 坐标系
globalPoint  = windowPoint + windowBounds.origin                      # 加窗口左上偏移得屏幕全局 point
```

- **element_index（主）**：AX 元素 → **AX click 序列** `ClickStrategy.performAXClickSequence`（v0.0.160 4 层 fallback + list item 前置 + 视图窗口激活，详见 §5 ClickStrategy 表行）→ 全失败落 screen-global point 中心 `postToPid`（CGEvent 兜底）。**零像素数学**（不受 window-relative 影响，robust）。**v0.0.159 修订**：v0.0.105 单步 AXPress 对 Electron web content 空转（AX 返 `.success` 但 React onClick / DOM 未触发——WorkBuddy / wb-clone / Lark / Feishu 场景），新增 web row 祖先遍历 + AX action 多步序列根治。**v0.0.160 修订**：补齐 open-codex 3 层 fallback（descendant / hit-test / activation-only）+ `selectContainingListItem`（Finder 侧边栏类）+ `isLikelySyntheticSideAction` filter（右侧「完成/done/archive」按钮误伤规避）。
- **coordinate（辅）**：单窗口截图像素 → `pixelToGlobalPoint` → **v0.0.160 起走 `ClickCoordinateHitTest.clickCandidates(at:in:pid:)` 双候选**（`bestElement containing` + `AXUIElementCopyElementAtPosition` 双候选）→ 逐个 `performAXClickSequence(includeNearbyHitTesting:false, allowActivationFallback:false)`（严格对齐 open-codex coord 契约，不递归 hit-test / 不 activation fallback）→ 全失败 CGEvent 兜底。**契约：coordinate 动作前必先 screenshot/get_app_state 建坐标上下文**（tool 按 sessionId 缓存 `{scaleFactor, windowBounds}`，见 tool spec §4）；read_ax_tree AX-only 不建 windowBounds，只支持 element_index。
- **type_text（v0.0.160 三段式）**：① `typeTextBySettingFocusedValueIfAvailable`（focus element settable → AX setValue 拼旧值直入 DOM，绕 React 合成事件层）→ ② `canTypeTextUsingKeyboardFallback`（role/roleDescription/valueSettable 门禁）→ CGEvent typeText → ③ 否则 throw `stateUnavailable` 明确报错。Electron 输入框（Lark 消息 / VSCode 命令面板）健壮性显著提升。
- **scroll（v0.0.160 AX-first）**：element_index + 整数 pages + `rec.rawActions` 含 `AXScroll<Dir>ByPage` → 对元素 `AXUIElementPerformAction` × N 次；否则落 CGEvent scrollWheel。Web 页面里 `AXWebArea/AXScrollArea` 走 AX 语义翻页比像素精准。
- **set_value（v0.0.160）**：`AXUIElementSetAttributeValue(elem, kAXValueAttribute, value)` 成功后 `Thread.sleep(0.1)` 让 UI 反应（避免立即 read_ax_tree 读到旧值）。
- **perform_secondary_action（v0.0.160）**：`matchingAction(requested, record)` 两级 match：exact rawActions case-insensitive → 否则 prettyActions 位置索引反查 rawActions（如 LLM 说 `Raise` 命中 `AXRaise`）。
- **coordinate drag from-to**：pixelToGlobalPoint（保 v0.0.105 逻辑）；`dragGlobally` HID fallback 明确不移植（破坏 "不抢前台" 承诺）。
- y-down 坐标系（macOS point，origin 左上）；postToPid 接受同坐标系。

## 6.1 视觉光标 overlay（v0.0.160 新增 — API 就位，Service 集成推迟）

**目的**：dev dogfood 时用户能看到 agent 光标动向（click 前 move + click 后 pulse），建立信任感。open-codex 移植（对齐 `SoftwareCursorOverlay` / `CursorMotionModel` / `SoftwareCursorGlyphRenderer`，Rocky 拆 13 文件 2967 行 逐字对齐）。

**架构**：
- `NSPanel` 子类 `CursorPanel`（`level=.screenSaver`, `styleMask=.borderless`, `isOpaque=false`, `backgroundColor=.clear`, `ignoresMouseEvents=true`）独立浮层，不接收鼠标事件、不遮盖 UI
- 60fps timer 步进（非 `CADisplayLink` — MainActor 主线程隔离）+ CoreGraphics glyph 绘制（无第三方 UI 库；参考位图 asset 缺失，走 procedural 分支）
- `CursorMotion*` 8 文件承载动力学：Path / Geometry / Spring / Official / HeadingDriven / Descriptors / Metrics / VisualDynamics（pure math + 打分 + candidate 择优）
- `SoftwareCursorGlyphRenderer` 承载光标形状 procedural CoreGraphics 绘制（299 行单文件）
- `@MainActor` 主线程隔离到位；`SoftwareCursorOverlay.moveVisualCursor / pulseVisualCursor / settleVisualCursor` 三 `nonisolated static func`，内部 `DispatchQueue.main.async` fire-and-forget 主线程调度

**env 门禁（v0.0.160 默认关）**：`ROCKY_CU_VISUAL_CURSOR`（Rocky 命名空间；open-codex 用 `OPEN_COMPUTER_USE_VISUAL_CURSOR`，Rocky 换名）。未设 / `""` / 非 `1/true/yes/on` = 关；显式 `1/true/yes/on` = 开。**默认关**（open-codex 默认开）——防 dogfood 前默认开启撞未验证真机场景。`VisualCursorSupport.isEnabled` 是所有 public API 的 guard 入口，关时自动 no-op（Service 侧无需门禁包裹）。

**Service 集成状态（v0.0.160 决策 G-6）**：**Rocky Service.click / setValue 未接入光标 API**——保持默认关状态。理由：（1）光标 API 全套（3 public 入口 + 主线程调度 + env guard）已就位并 UT 覆盖 66 asserts；（2）Service 集成需真机 dogfood 验证光标动力学与 Rocky Electron/多显示器场景兼容性；（3）用户明确「本版本不 dogfood 视觉光标」；（4）默认关状态下即使集成也自动 no-op，但 Service 侧代码路径变化本身需回归——推迟到用户 dogfood 单独版本一起做。**未来集成方式**：`Service.click` 内 CGEvent post 前后调 `SoftwareCursorOverlay.moveVisualCursor(to:) + pulseVisualCursor(at:clickCount:mouseButton:)`；`Service.setValue` 内调 `moveVisualCursor + settleVisualCursor`；均 fire-and-forget 不 await（否则阻塞 addon N-API 回调）。

**通知**：`rockyComputerUseTurnEndedNotificationName = Notification.Name("com.rocky.agent.turn-ended")`（Rocky 命名空间；open-codex `com.ifuryst.opencomputeruse.turn-ended` 换名），Rocky 主进程可 `DistributedNotificationCenter` 侦听 turn 结束。

**SecureCoding 兼容 macOS Big Sur+**（NSPanel subclass 需正确响应 `supportsSecureCoding`）。

## 7. 边界

| 零件 | 归属 |
|---|---|
| ComputerNativePort 接口 + 数据形状 + 三态注入 precedence + native addon + 坐标换算 | 本文 ✅ |
| 单 `computer` tool 协议 / 11 action dispatch / ACTION_PERMS 门禁 / session-state 坐标缓存 | `../tools/[P1]computer_use_tool.md` |
| ImageBlock 协议原语（ContentBlock union + wire encode） | `../message/[P0]agent_message_interface.md §4.2` + `llm/protocol-encode.ts`（**v0.0.157 起 tool 层不再构造 ImageBlock，类型保留供 protocol 层**） |
| UI 权限卡片（testid/权限两行/引导按钮/测试截图） | `specs/ui/overall/05-connectors.md` + `connector-page/section-computer-connector.md` |
| UI 权限 IPC（`window.rockyComputer` → 主进程 desktopCapturer/systemPreferences，本版本不动的 spike 路径） | `app/electron/src/computer-permissions-ipc.ts` + `preload.ts` |

## 8. 已知局限（未来扩展）

- **v0.0.160 全面对齐 open-codex — 17/17 项 gap 全闭合**：3 必移植（type_text 三段式 / click activation-only / scroll AX-first）+ 6 值得移植（descendantClickCandidates / coord 双候选 / recoverVisibleWindow / isLikelySyntheticSideAction / selectContainingListItem / stateUnavailable）+ 8 可选（Spotlight recent apps / SoftwareCursorOverlay / FixtureBridge bridge / TreeRenderer 精细化 / ElementRecord 三字段 / text_limit "max" / set_value sleep / pretty actions）。用户 v0.0.160 裁决「不创新、全对齐」，逐字迁移。
- **本工程刻意不移植 11 项**（本质架构差异，非缺陷）：MCP stdio server / 独立 Swift executable CLI / `PermissionOnboardingApp` SwiftUI onboarding / 多 bundle candidate 查找 / `MacOSAppAgentProxy` / release/dev 双 bundle 身份 / CGWindow layer sort 精细化 / `AppSafetyPolicy.blockedBundleIdentifier` / `dragGlobally` HID event tap fallback（破坏 "不抢前台"）/ pretty-only render marker 后缀。详见 `specs/research/v0.0.159/overview.md` + `actions-diff.md`。
- **listApps 语义调整（v0.0.160）**：从「只列运行中 `.regular`」改为「运行中 + Spotlight recent app 合并」（对齐 open-codex `AppDiscovery.listCatalog`）。非运行 recent app 至多 10 个；`NSMetadataQuery` 权限缺失时降级为纯运行中（fail-closed 返 `[]`）。tool `list_apps` 消息头改「未发现可控 app」（v0.0.156 前「未发现运行中的可控 app」措辞已不准）。
- **FixtureBridge = bridge 层 only（v0.0.160）**：`FixtureBridge.swift` 175 行 Codable + read/write/post 已落；`RockyComputerUseFixture` macOS app + XCTest 因本机装 CLT（缺 Xcode）**推迟到单独版本**。`SnapshotMode.fixture` 分支 Service 侧 9 method 加 `// TODO(v0.0.160-P1-A)` 占位（透明 no-op 走 `.accessibility` 路径），不阻塞其他 gap 闭合。Rocky 命名空间：`RockyComputerUseFixture` / `com.rocky.computer-use.fixture.command` / `rocky-computer-use-fixture` 目录名。
- **视觉光标 overlay Service 集成推迟（v0.0.160 G-6 决策）**：光标 API 全套（3 public 入口 + `@MainActor` 主线程隔离 + `VisualCursorSupport.isEnabled` env guard + `CursorMotion*` 8 文件动力学 + 66 UT asserts）已就位并**默认关**（`ROCKY_CU_VISUAL_CURSOR` 未设 = 关）；Rocky Service.click / setValue **未调用**光标 API——需真机 dogfood 验证 Rocky Electron/多显示器场景后单独版本集成。集成方式见 §6.1。
- **stateUnavailable 错误分类（v0.0.160）**：`ComputerErrorCode` 加 `state_unavailable`（元素还在但没坐标 / 元素消失 / 无 backing AX object / focused 无 editable / focused window 缺失且 recover 失败），与 `native_error` 通用错误区分。TS `type-text.ts` / `set-value.ts` 识别 `code === 'state_unavailable'` 返「先建立坐标上下文再重试」类友好中文文案（读类结果如 `AxTreeResult` / `GetAppStateResult` / `ComputerScreenshotResult` 走 reason 原文，未加 code 字段——未来需读类友好文案时追加 optional code 保后向兼容）。
- **AX 树精细化 render LLM 视角变化风险（v0.0.160 块 5 已知）**：`TreeRenderer` 从 v0.0.105 裸 walk 换 open-codex 精细化 render，`get_app_state.axText` 格式全洗：段化 traits/label/help/url/identifier/value/placeholder/Secondary Actions + generic wrapper 折叠 + AXLink markdown 化 + list/outline `(showing 0-N of TOTAL items)` + synthetic text 节点。缩进 4 空格改 tab。**下游需 dev dogfood 6+ 场景手验**（Safari/Finder/Xcode/VSCode/Lark/WorkBuddy）ax tree 无退化——UT 不覆盖真实 AX 输出。
- **非 macOS**：port impl 内 `supported=false` 降级（addon 非 darwin 加载返 undefined → 全方法 fail-closed）；linux/windows 原生实现推后。
