# v0.0.105 变更计划书 v2 — 第二批「computer 能力集 1:1 对齐 open-codex」（method 级 review 合同）

> **重设计背景（用户决策 2026-07-10）**：波次 A 已落「单 `computer` tool + 6 action」（screenshot/read_ax_tree/click/type/scroll/key），
> 但**缺 open-codex（iFurySt open-codex，主参考竞品）的 drag/set_value/perform_secondary_action/list_apps，且未采用 app-scoped 模型**。
> 用户拍板「**对齐，重新 plan**」：**保持单 1 个 `computer` tool + action 参数**（不回退多 tool）；**action 能力集完整对齐 open-codex 9 tool**（不缺任何能力）。
> 本文件 = 第二批契约（就地修订，取代旧 6-action 框架）。8 列：所属模块 / 文件路径 / 函数·符号 / 类型(A=新增/M=修改/D=删除) / 变更内容 / 约束 / 参考 / 影响行。行 = 函数/符号。
> **扩展而非重写**：单 tool 框架 / run() dispatch / fail-closed 分层 / 扁平 action-discriminated schema / CBridge native 桥 / mock fixture 范式全保留；素材 iFurySt 现成（迁移，非发明）。

## B2.0 铁律承接（不可违背）

macOS 原生能力（AX 树 / 键鼠 / 权限）**必须在 Rocky Electron 主进程内**（`com.rocky.agent` = TCC 权限主体）。
native addon = 主进程加载的动态库（`.node` + Swift `dylib`），**继承主进程 TCC 身份**（绝不 spawn helper，memory `macos-tcc-spawn-no-perm-use-electron-host`）。
**postToPid 后台输入**仅需 Accessibility（无需 Input Monitoring / 不抢前台）。

---

## B2.1 open-codex 1:1 能力对齐（本批核心）

### A. 9-tool → 我们 action 映射（能力 1:1，不缺）

| # | open-codex tool | open-codex 参数 | 我们 action | 我们参数 | port method | 结果包装 |
|---|---|---|---|---|---|---|
| 1 | `list_apps` | — | `list_apps` | — | `port.listApps()` | TextBlock（app 列表） |
| 2 | `get_app_state` | app / text_limit / max_tree_nodes / max_tree_depth | `get_app_state` | app? / text_limit? / max_tree_nodes? / max_tree_depth? | `port.getAppState(opts)` | **ImageBlock + TextBlock**（截图 + AX 树） |
| 3 | `click` | app / element_index\|(x,y) / click_count / mouse_button | `click` | element_index?\|(x?,y?) / click_count? / mouse_button? / app? | `port.click(target,opts)` | TextBlock |
| 4 | `perform_secondary_action` | app / element_index / action | `perform_secondary_action` | element_index / secondary_action / app? | `port.performSecondaryAction(idx,name,opts)` | TextBlock |
| 5 | `scroll` | app / element_index / direction / pages | `scroll` | direction / element_index?\|(x?,y?) / pages? / app? | `port.scroll(target,opts)` | TextBlock |
| 6 | `drag` | app / from_x,from_y,to_x,to_y | `drag` | from_x,from_y,to_x,to_y / app? | `port.drag(from,to,opts)` | TextBlock |
| 7 | `type_text` | app / text | `type_text` | text / app? | `port.type(text,opts)` | TextBlock |
| 8 | `press_key` | app / key | `press_key` | key / app? | `port.pressKey(key,opts)` | TextBlock |
| 9 | `set_value` | app / element_index / value | `set_value` | element_index / value / app? | `port.setValue(idx,value,opts)` | TextBlock |

**我们额外 2 个（open-codex 折进 get_app_state；我们保留为轻量单模态补充，additive 不违反「能力不缺」）**：

| 我们 action | 参数 | port method | 结果包装 | 保留理由 |
|---|---|---|---|---|
| `screenshot` | — | `port.screenshot()` | ImageBlock | 波次 A 已实现/AT 2/2 过；纯像素快照（省 AX token）；「先看整屏找 app」；零 native 风险 |
| `read_ax_tree` | app? / text_limit? / max_tree_nodes? / max_tree_depth? | `port.readAxTree(opts)` | TextBlock | spike 已验的主 native 路径；动作后**只刷 AX 不带截图**（省图像 token，胜 open-codex 每轮必带图） |

> **合计 11 action，覆盖 open-codex 全部 9 + 2 我们的省 token 补充**。action 命名对齐 open-codex 原名（`type`→`type_text`、`key`→`press_key`，便于对照）。
> `perform_secondary_action` 的动作名参数取名 `secondary_action`（不用 open-codex 原名 `action`——`action` 是本 tool discriminator，冲突）。

### B. 关键决策

**决策 A — get_app_state 合一 + per-window 截图（用户拍板 2026-07-10）**：
- **采纳合一 `get_app_state` 为主 action**（单窗口截图 + AX 树一次返回，对应 open-codex「每 turn 先调」），返 `[ImageBlock, TextBlock]`。
- **截图 = native ScreenCaptureKit 单窗口截图**（真正贴 open-codex，用户接受额外 native 截图 spike 风险+工作量）：`get_app_state` + `screenshot` action 均走 native addon 的 ScreenCaptureKit（`SCContentFilter(desktopIndependentWindow)`），**不用** Electron desktopCapturer 全屏。素材现成——旧 swift-helper `Screenshot.swift`（`ScreenCapture.capture` 已含 `SCShareableContent.current`→`SCScreenshotManager.captureImage` + `boundedPNGData` 900KB/1280px/0.85 步进 + Retina `backingScaleFactor` + `frontWindow` layer-0 定位 + `BlockingBridge.run(timeout:5)` async→sync 桥）迁入 computer-native。
- **删 Electron desktopCapturer 全屏 screenshot 路径**（波次 A 已建，见 P1-C）：screenshot/get_app_state 统一 native per-window。理由：单一 window-relative 坐标模型不容两套截图坐标空间；delete-dead-code；贴 open-codex。全屏 overview 若未来需要 = native ScreenCaptureKit display-capture 模式（单机制），不复活 electron。
- **保留 `screenshot`+`read_ax_tree` 单模态补充**（D-B=11，用户确认）：screenshot=纯图（单窗口）/ read_ax_tree=纯树（省图像 token）/ get_app_state=图+树。

**决策 B — app 定位方式**：`app` 参数 = **bundleId 或 localizedName 字符串**（对齐 iFurySt：`NSWorkspace.runningApplications` 按 `bundleIdentifier || localizedName` 匹配）。pid 内部由 Swift `resolvePid(appHint:)` 解析（已实现于 computer-native Service）；`app` 全 action 可选，缺省 frontmost。TS 侧不管 pid。

### C. app-scoped 模型 + 坐标语义（open-codex window-relative 三段式）

- **app-scoped 落点 = AX(element_index 按该 app AX 树序号) + postToPid(按该 app pid) + 单窗口截图(该 app key window)**；`get_app_state`/`screenshot`/`read_ax_tree` 带 `app` → Swift resolvePid → 采该 app 窗口/AX 树；element_index 缓存在 Swift `ComputerUseService` 单例 `lastRecords`（last-call-wins，跨 invoke 复用）。
- **坐标模型 = window-relative 三段式（用户拍板，随 per-window 截图）**：
  - **element_index（主）**：AX 元素 → `screenFrame`（AXPosition screen-global point）中心 → AXPress 语义动作 或 postToPid。**零像素数学**（此路径不受 window-relative 影响）。
  - **x,y 像素（辅）/ drag from-to（仅坐标）**：单窗口截图像素 → `coords.pixelToGlobalPoint(pixel, scaleFactor, windowBounds)`：`windowPoint = pixel/scaleFactor`→`globalPoint = windowPoint + windowBounds.origin`（iFurySt 三段式，coords.ts 现成、本就为此设计）。`scaleFactor = coords.deriveScaleFactor(screenshotWidth, windowBounds, reported)` = `截图像素宽/windowBounds.w`（多显示器混合 DPI 更准）。
  - `screenshot`/`get_app_state` 返回 `windowBounds`（screen point，= `CapturedWindow.bounds`）+ 截图像素宽 → tool 按 sessionId 缓存 `{scaleFactor, windowBounds}`（session-state）；**coordinate 动作前必先 screenshot/get_app_state 建坐标上下文**（read_ax_tree AX-only 不建 windowBounds，只支持 element_index）。
- **app-session 生命周期**：`get_app_state({app})` 启动/复用 → Swift 采该 app AX 树写 `lastRecords`+`lastPid` → 后续 `click/scroll/set_value/perform_secondary_action({element_index})` 查 `lastRecords`。**契约：同 app 的 element_index 动作前必先 get_app_state/read_ax_tree**（cache last-call-wins）。computer 仅 bound playground（单人单桌面），无跨 session 并发。

---

## B2.2 对波次 A 已实现代码的 delta（改 / 留 清单）

### 留（不动，波次 A 资产复用）

| 保留项 | 文件 | 说明 |
|---|---|---|
| 单 `computer` tool 框架 + run() dispatch 机制 | `tools/computer-use/computer.ts` | tool 主体 + switch dispatch + ACTION_PERMS 门禁模式全留；仅扩 action 集 |
| fail-closed 分层 | computer.ts run() | action 校验 → port undefined → 权限门禁 → handler，四层不变 |
| 扁平 action-discriminated schema 骨架 | `tools/computer-use/schema.ts` | 结构留（`action` enum + primitive 可选参数 + additionalProperties:false + required:['action']）；仅扩 enum/参数 |
| CBridge native 桥（@_cdecl invoke/ping/free）| `app/computer-native/swift/…/CBridge.swift` | JSON-in/JSON-out C ABI 桥不变；扩是同桥上更多 dispatch case |
| N-API AsyncWorker + 构建链 | `app/computer-native/{src/addon.cc, binding.gyp, index.js, scripts/build-native.sh}` | 已建（spike 0/1 验通 ping+readAxTree）；不动 |
| mock port fixture 加载范式 | `platform/computer/mock-native-port.ts` | `fileFixtureLoader` call-time fresh 读；扩 fixture 字段 + 方法 |
| native-port 类型/接口骨架 | `platform/computer/native-port.ts` | 类型 `AxTreeNode/AppInfo/PixelPoint/ComputerTarget/WindowBounds/ComputerError` 留；扩方法/新类型 |
| coords（`pixelToGlobalPoint`+`deriveScaleFactor`）| coords.ts | **本就为 window-relative 三段式设计**，本批正式接入（D-A per-window 后 windowBounds 非零）；不改逻辑 |
| permissions / image-block | 各同名 .ts | 权限 gate / wrapScreenshot 复用（screenshot/get_app_state 图仍走 wrapScreenshot） |
| AccessibilitySnapshot / Permissions / Support（native）| computer-native swift | 保留；AccessibilitySnapshot 增强（secondary actions 渲染，见 P1-B） |

### 改（本批重构点）

| 改动项 | 现状（波次 A） | 目标 | 归属 |
|---|---|---|---|
| action 集 | 6（screenshot/read_ax_tree/click/type/scroll/key）| 11（+get_app_state/list_apps/drag/set_value/perform_secondary_action；type→type_text；key→press_key）| P1-F |
| schema 参数 | element_index/x/y/text/keys/direction/amount/click_count/mouse_button/app/text_limit/… | +app（全 action）+from_x/from_y/to_x/to_y+value+secondary_action；keys→key；amount→pages | P1-F schema.ts |
| port 接口 | 7 方法 | +getAppState/listApps/drag/setValue/performSecondaryAction；各动作 opts 加 app | P1-A |
| **screenshot 截图源** | electron desktopCapturer 全屏（波次 A）| **native ScreenCaptureKit 单窗口**（迁 Screenshot.swift；删 electron 全屏路径）| P1-B/P1-C |
| 坐标模型 | （波次 A 未接 coordinate）| window-relative 三段式（windowBounds+scaleFactor 缓存）| P1-F target/session-state |
| **electron port（未完成）** | **仅 checkPermissions+screenshot(desktopCapturer)** | **screenshot/getAppState 改调 native addon；补全 readAxTree/click/type/scroll/pressKey/listApps/drag/setValue/performSecondaryAction；删 desktopCapturer 全屏 helper** | P1-C |
| **loopback server（未完成）** | **routeLoopback 仅 /permissions+/screenshot** | **加 `/invoke` 泛路由承接全部 native 方法** | P1-D |
| **native CBridge dispatch（spike 级）** | **仅 ping+readAxTree** | **+click/scroll/drag/type/pressKey/listApps/setValue/performSecondaryAction** | P1-B |
| **native Service（spike 级）** | **仅 readAxTree** | **迁 click/scroll/drag/type/pressKey/listApps/setValue（旧 swift-helper 现成）+ 新增 performSecondaryAction** | P1-B |
| native 素材迁移 | computer-native 缺 InputSimulation/KeyMapping | 从旧 `swift-helper/` 迁入 InputSimulation.swift+KeyMapping.swift；迁完删旧 swift-helper（死代码）| P1-B |
| mock port | 5 native 方法 | +getAppState/listApps/drag/setValue/performSecondaryAction | P1-E |
| AT case | screenshot 2 case | 新 action case（test-designer 阶段）；directive `@@cu:<json>@@` 机制不变 | P1-G |

> **波次 A 真实完成度**：TS tool 层 + port 接口 + mock + loopback-client 齐；但 **electron port / loopback server / native CBridge+Service 仅 spike 级（readAxTree 通）**——本批既补 open-codex 能力，也**补全波次 A 遗留的真 native wiring**。

---

## B2.3 method 级 change_plan（8 列）

### 模块 P1-A：ComputerNativePort 扩接口（server 侧，零 electron / 零 native）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| platform | app/server/src/platform/computer/native-port.ts | `ComputerScreenshotResult` | M | 加 `windowBounds?:WindowBounds`（per-window 截图返窗口 screen point 边界，供 coordinate 三段式）+ `scaleFactor?`（若未有） | 单窗口截图必带 windowBounds+width（坐标上下文）；裸 base64 | B2.1 决策A/C；Screenshot.swift CapturedWindow.bounds | +4 |
| platform | native-port.ts | `GetAppStateOptions` | A | `{app?, textLimit?, maxNodes?, maxDepth?}`（复用 AxTreeOptions 形；语义化别名） | 可用 `AxTreeOptions` 复用，不必另建（coder 定） | B2.1 A #2 | +4 |
| platform | native-port.ts | `GetAppStateResult` | A | `{ok, screenshot?:{data,mediaType,width,height,windowBounds}, axText?, pid?, scaleFactor?, windowBounds?, reason?}`（单窗口截图+AX 合一） | ok=false 返 reason 不抛；截图裸 base64；windowBounds 供三段式 | B2.1 决策A/C；wrapScreenshot | +12 |
| platform | native-port.ts | `DragOptions` / `SetValueOptions` / `SecondaryActionOptions` | A | Drag`{steps?, pid?, app?}`；SetValue`{pid?, app?}`；SecondaryAction`{pid?, app?}` | 全可选；app→Swift resolvePid | Service.swift drag/setValue | +9 |
| platform | native-port.ts | `ClickOptions`/`ScrollOptions`/`TypeOptions`/`PressKeyOptions`/`AxTreeOptions` | M | 各加 `app?:string`（app-scoped pid 定位；AxTreeOptions 已有 app 保留） | 纯类型加字段；缺省 frontmost | B2.1 决策B | +4 |
| platform | native-port.ts | `ComputerNativePort`（接口体） | M | 加 5 方法：`getAppState(opts?):Promise<GetAppStateResult>` / `listApps():Promise<AppInfo[]>` / `drag(from:PixelPoint,to:PixelPoint,opts?:DragOptions):Promise<ComputerActionResult>` / `setValue(elementIndex:number,value:string,opts?:SetValueOptions):…` / `performSecondaryAction(elementIndex:number,action:string,opts?:SecondaryActionOptions):…`；保留既有 7 方法 | **MUST** 零 electron/零 native；**MUST NOT** 加 connect/session；drag 用 PixelPoint（已换算 screen point） | 架构原则#2/#3；native-port.ts:78-93 | +7 |
| platform | native-port.ts | `AppInfo` | M | 已有（bundleId/name/pid/isRunning）；确认 barrel 导出 | 无需改结构 | native-port.ts:119 | 0 |
| platform | app/server/src/platform/computer/index.ts | barrel 导出 | M | 加 `GetAppStateOptions`/`GetAppStateResult`/`DragOptions`/`SetValueOptions`/`SecondaryActionOptions`/`AppInfo` 类型导出 | 稳定接口面 | 现 index.ts 导出块 | +6 |

### 模块 P1-B：native addon（Swift dylib CBridge + Service 补全 + AX secondary 渲染）

> native 代码（Swift），非 TS coder 常规产物；本表列文件+符号定契约，编码交熟悉 native 的执行。素材 iFurySt 现成（旧 swift-helper 逐字迁）。

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| native | app/computer-native/swift/Sources/RockyComputerCore/{Screenshot,InputSimulation,KeyMapping}.swift | （3 文件整体） | A(mv) | 从旧 `swift-helper/…/RockyComputerUseHelper/` **逐字迁入**：Screenshot.swift（ScreenCaptureKit 单窗口截图 + BlockingBridge async→sync + boundedPNGData 压缩）+ InputSimulation.swift（click/scroll/drag/type/pressKey 依赖）+ KeyMapping.swift；仅调 module 名 | **MUST** 逐字移植（`ScreenCapture.capture`/`captureImage`/`boundedPNGData`/`frontWindow`/`BlockingBridge.run`；clickTargeted/scrollTargeted/dragTargeted/typeText/pressKey/KeyPressParser.parse 全保留） | 旧 Screenshot.swift:24-169/InputSimulation.swift:38-137/KeyMapping.swift；grep 确认符号存在 | mv |
| native | computer-native/…/Service.swift | `screenshot`/`getAppState` | A(mv) | 从旧 swift-helper Service.swift **逐字迁入**：`screenshot(params)`→`ScreenCapture.capture(appHint)`→`{data,mime,width,height,scaleFactor,windowBounds}`；`getAppState(params)`→capture + `AccessibilitySnapshot.build` 合并→`{screenshot,axTreeText,windowBounds,scaleFactor,pid}`（写 lastRecords/lastPid） | **MUST** app hint 走 `params["app"]`（旧 screenshot 用 appId，统一改 app）；getAppState 写 element_index 缓存 | 旧 Service.swift:19-43（screenshot/getAppState） | +30 |
| native | computer-native/…/Service.swift | `click`/`scroll`/`drag`/`type`/`pressKey`/`listApps`/`setValue` | A(mv) | 从旧 swift-helper Service.swift **逐字迁入**（含 AXPress 语义优先 click 链 + settable 校验 setValue + Applications.list）；params 走 `[String:Any]` dict（对齐现 readAxTree 范式） | **MUST** 复用 lastRecords/lastPid 缓存（element_index 定位）；逐字移植不改逻辑 | 旧 Service.swift:45-107 | +90 |
| native | computer-native/…/Service.swift | `performSecondaryAction(params)` | A | **新增**（open-codex 缺失的唯一 native 方法）：查 `lastRecords[elementIndex]` → `AXUIElementPerformAction(rec.element, actionName as CFString)`；非 .success 抛 `not a valid secondary action` | **MUST** 查 lastRecords；无效 action 报错不静默；只读 AX 动作 | research §perform_secondary_action（ComputerUseService.swift:485-512） | +12 |
| native | computer-native/…/AccessibilitySnapshot.swift | `walk` / `ElementRecord` | M | 采集 `AXUIElementCopyActionNames` → ElementRecord 加 `actions:[String]`；渲染行加 `Secondary Actions: <names>`（对齐 open-codex AX 文本格式，供 LLM 知可用 action）；nodeDict 加 actions | **MUST** 过滤 AXPress（primary，不列 secondary）；budget 内 | research §7 AX 渲染格式；现 walk:39-62 | +14 |
| native | computer-native/…/CBridge.swift | `dispatch(method,params)` | M | switch 加 `screenshot/getAppState/click/scroll/drag/type/pressKey/listApps/setValue/performSecondaryAction` 10 case（读类返 result；动作类返 `{ok:true}`；异常 fail-closed `{ok:false,error}`）；保留 ping/readAxTree | **MUST** 复用 sharedService 单例；异常转 `{ok:false,error}`（对齐现 catch） | 现 CBridge.swift:29-46；旧 main.swift dispatch:44-52 | +22 |
| native | computer-native/swift/Package.swift | product/target | M | 确认 ScreenCaptureKit 随 `import` 自动链接（SwiftPM 系统 framework 免显式 linkerSettings）；`.macOS(.v14)`+`.swiftLanguageMode(.v5)` 已就位不改 | **MUST** dylib 能 resolve ScreenCaptureKit/CoreMedia | 现 Package.swift:16-25 | +0 |
| native | app/server/src/platform/computer/swift-helper/ | （旧整目录） | D | 迁走 Screenshot/InputSimulation/KeyMapping/Service 方法后，旧 swift-helper（main.swift stdin 循环 + 旧 Service 壳）**彻底删**（spawn pivot 已废，死代码） | **MUST** 无 .ts 引用（已 grep 确认零引用）；彻底删不留 | memory delete-dead-code-no-deprecate-mark | 删 8 文件 |

### 模块 P1-C：主进程 port 补全（app/electron，调 addon）—— 波次 A 遗留 + 新方法

> **关键**：波次 A `makeElectronComputerNativePort` **仅实现 checkPermissions+screenshot**（native 方法全缺）。本批补全全部 native 方法（否则 tool 调 port.readAxTree/click 等 = undefined 崩）。

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| electron | app/electron/src/computer-native-port.ts | `loadComputerAddon()` | A | lazy `require('@app/computer-native')`→`{invoke,ping}\|undefined`（非 darwin/加载失败→undefined，warn 不抛） | **MUST** 加载失败 fail-closed（各 native 方法返 {ok:false}） | 现 index.js fail-closed；B2.0 | +12 |
| electron | computer-native-port.ts | `makeElectronComputerNativePort`（返回体） | M | 全 native 方法走 addon：`screenshot/getAppState/readAxTree/click/type/scroll/pressKey/drag/setValue/performSecondaryAction` 各 `JSON.stringify(params)`→`addon.invoke(method,json)`→`JSON.parse`→map 结果；addon 缺失→{ok:false,reason}。**screenshot 改调 `addon.invoke('screenshot',{app})`（native ScreenCaptureKit 单窗口），不再 desktopCapturer**；checkPermissions 保留 electron systemPreferences 不动 | **MUST** screenshot/getAppState 走 native（决策A）；**MUST** checkPermissions 保 electron；addon 缺失 fail-closed；lazy require | 现 makeElectronComputerNativePort:88-123；B2.1 决策A/C | +80/-30 |
| electron | computer-native-port.ts | `getAppState` | A | 直调 `addon.invoke('getAppState',{app,...})`（native ScreenCaptureKit 截图+AX 合一）→ map `{ok, screenshot:{data,mediaType,width,height,windowBounds}, axText, pid, scaleFactor, windowBounds}` | **MUST** native 合一（非 electron 组合）；addon 缺失 fail-closed | B2.1 决策A；旧 Service.getAppState | +18 |
| electron | computer-native-port.ts | `fullResThumbnailSize`/`stripDataUrlPrefix`/`ScreenLike`/`ElectronComputerNatives.screen` | D | desktopCapturer 全屏 screenshot 专属 helper——screenshot 改 native 后死代码，彻底删（`desktopCapturer` 依赖亦从 screenshot 路径移除；`computer-permissions-ipc.ts` 的 `computeTestScreenshot` 权限测试路径保留，不碰） | **MUST** 删死代码不留；不误删 permissions-ipc | memory delete-dead-code；现 computer-native-port.ts:46-79 | -35 |
| electron | computer-native-port.ts | `ElectronComputerNativePort`（接口镜像） | M | 结构化镜像加 getAppState/readAxTree/listApps/click/type/scroll/pressKey/drag/setValue/performSecondaryAction 签名 | electron 侧惯例结构化类型（不跨包 import type） | 现 ElectronComputerNativePort:41-44 | +12 |

### 模块 P1-D：dev loopback 补全（generic /invoke 泛路由）—— 波次 A 遗留

> **关键**：波次 A `routeLoopback` **仅 /permissions+/screenshot**；LoopbackComputerNativePort（client）已走 `/invoke`，但 server 端 `/invoke` 未实现（dev 下 readAxTree 等必 404）。本批补 server `/invoke`。

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| electron | app/electron/src/computer-loopback-server.ts | `routeLoopback` | M | 加 `POST /invoke {method,params}`：按 method 分发 `port[method](...params)`→JSON 返（generic 单路由承接全部 native 方法）；保留 /permissions+/screenshot | **MUST** 保 token 校验；**MUST** 复用同一 makeElectronComputerNativePort 实例（同 addon 单例） | 现 routeLoopback:33-52 | +16 |
| electron | computer-loopback-server.ts | body 读取（drainBody→readJsonBody） | M | `/invoke` 需 params body → 加 JSON body 解析（解析失败→{}）；保 /screenshot drain | 保连接不挂 | 现 drainBody:59 | +8 |
| platform | app/server/src/platform/computer/loopback-native-port.ts | `LoopbackComputerNativePort`（类体） | M | 加 `getAppState/listApps/drag/setValue/performSecondaryAction` 5 方法（各走 `/invoke`，复用现 `action()`/`invoke()` 私有法）；readAxTree/click/type/scroll/pressKey 已有不动 | **MUST** 零 electron 纯 fetch；fetch 异常 fail-closed | 现 LoopbackComputerNativePort:91-146 | +40 |

### 模块 P1-E：mock port 扩展（AT/UT 注入，零子进程/零 GUI）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| platform | app/server/src/platform/computer/mock-native-port.ts | `ComputerMockFixture` | M | screenshot 段加 `windowBounds?`（per-window 坐标上下文）；加 `appState?:{screenshot?,axText?,pid?,scaleFactor?,windowBounds?}`、`apps?:AppInfo[]`；`actionResults` 加 `drag?/setValue?/performSecondaryAction?` | 全可选，缺则默认 | 现 ComputerMockFixture:74-96 | +10 |
| platform | mock-native-port.ts | `MockComputerNativePort`（类体） | M | screenshot 返值加 windowBounds（缺→默认 `{0,0,width,height/scale}`）；加 `getAppState`（缺→默认小树+1×1PNG+scaleFactor:2+windowBounds）/`listApps`（缺→默认 1 app）/`drag`/`setValue`/`performSecondaryAction`（各走 fixture.actionResults，缺→{ok:true}）；扩 actionResult 联合键 | **MUST** 零子进程/零 GUI；call-time fresh 读 | memory test-no-real-spawn-system-gui；现 MockComputerNativePort:126-182 | +46 |

### 模块 P1-F：computer tool 层（单 `computer` tool + 11 action dispatch）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools | app/server/src/tools/computer-use/schema.ts | `COMPUTER_INPUT_SCHEMA` + `ACTION_DESCRIPTION` | M | action enum 6→11（+get_app_state/list_apps/drag/set_value/perform_secondary_action；type→type_text；key→press_key）；参数加 `app`/`from_x`/`from_y`/`to_x`/`to_y`/`value`/`secondary_action`；`keys`→`key`；`amount`→`pages`；description 逐 action 更新（含「get_app_state 主，每轮先调」引导） | **MUST** additionalProperties:false + required:['action']；扁平 primitive | B2.1 A；现 schema.ts:34-69 | +50/-15 |
| tools | tools/computer-use/computer.ts | `COMPUTER_ACTIONS` + `ACTION_PERMS` + `run()` switch | M | ACTIONS 6→11；ACTION_PERMS 加新 action（get_app_state→screenRecording+accessibility 双门禁；list_apps→accessibility；drag/set_value/perform_secondary_action→accessibility）；switch 加 5 新 case + 改 type_text/press_key case | **MUST** 走 port 不绕过；**MUST NOT** import electron/native；get_app_state 需双权限（截图+AX） | 现 computer.ts:32-107 | +30/-6 |
| tools | tools/computer-use/session-state.ts | `ComputerSessionState` / `setComputerCoordContext(sid,{scaleFactor,windowBounds})` | M | `ComputerSessionState` 加 `windowBounds?:WindowBounds`；`setComputerScaleFactor`→`setComputerCoordContext`（一次写 scaleFactor+windowBounds）；`getComputerState` 不变 | **MUST** 按 sessionId 隔离；纯内存；coordinate 动作读此上下文 | B2.1 决策C；现 session-state.ts:13-38 | +12/-6 |
| tools | tools/computer-use/target.ts | `resolveTarget` / `resolveDrag`（新） | M | resolveTarget(input, scaleFactor, windowBounds)：coordinate 分支 `pixelToGlobalPoint({x,y}, sf, windowBounds)`（window-relative 三段式，**非 {0,0,0,0}**）；新增 `resolveDrag(input, sf, windowBounds)`：`{from_x,from_y,to_x,to_y}`→两 PixelPoint（各 pixelToGlobalPoint(sf,windowBounds)）；缺→null | **MUST** 用 coords.pixelToGlobalPoint + 缓存 windowBounds；纯函数；drag 仅坐标 | B2.1 决策C；现 target.ts:24-41；coords.ts:44 | +26/-8 |
| tools | tools/computer-use/actions/screenshot.ts | `handleScreenshot(port,ctx)` | M | 签名加 ctx；`port.screenshot()`→!ok errorResult→**缓存坐标上下文**（`setComputerCoordContext(sid,{scaleFactor:deriveScaleFactor(shot.width,shot.windowBounds,shot.scaleFactor), windowBounds:shot.windowBounds})`）→wrapScreenshot ImageBlock | **MUST** 单窗口截图后建坐标上下文（供 coordinate click）；复用 wrapScreenshot | B2.1 决策C；现 actions/screenshot.ts；coords.deriveScaleFactor | +18/-4 |
| tools | tools/computer-use/actions/get-app-state.ts | `handleGetAppState(input,port,ctx)` | A | 映射 opts→`port.getAppState(opts)`→!ok errorResult→**缓存坐标上下文**（deriveScaleFactor + windowBounds）→返 `{content:[wrapScreenshot(shot.screenshot), textBlock(axText)], isError:false}`（图+树多内容） | **MUST** 图+树合一；缓存 scaleFactor+windowBounds | B2.1 决策A/C；wrapScreenshot；textResult | +46 |
| tools | tools/computer-use/actions/list-apps.ts | `handleListApps(port)` | A | `port.listApps()`→格式化 app 列表为 TextBlock（每行 name / bundleId / pid） | 纯读；无参数 | AppInfo；Applications.list | +22 |
| tools | tools/computer-use/actions/drag.ts | `handleDrag(input,port,ctx)` | A | `resolveDrag(input,sf)`→null errorResult→`port.drag(from,to,{app})`→!ok errorResult→textResult | **MUST** 用 resolveDrag（仅坐标） | DragOptions；Service.drag | +30 |
| tools | tools/computer-use/actions/set-value.ts | `handleSetValue(input,port)` | A | 校验 `element_index`(int) + `value`(string)→`port.setValue(idx,value,{app})`→!ok errorResult→textResult | **MUST** element_index+value 必填校验 | Service.setValue（settable 校验 Swift 侧） | +30 |
| tools | tools/computer-use/actions/perform-secondary-action.ts | `handlePerformSecondaryAction(input,port)` | A | 校验 `element_index`(int) + `secondary_action`(string)→`port.performSecondaryAction(idx,name,{app})`→!ok errorResult→textResult | **MUST** 二者必填校验 | Service.performSecondaryAction | +30 |
| tools | tools/computer-use/actions/type.ts→type-text.ts | `handleType`→`handleTypeText` | M | 重命名文件+函数（对齐 type_text）；逻辑不变（校验 text→port.type→!ok→textResult）；opts 传 app | 逻辑等价，仅命名 | 现 actions/type.ts | +2/-2 |
| tools | tools/computer-use/actions/key.ts→press-key.ts | `handleKey`→`handlePressKey` | M | 重命名文件+函数（对齐 press_key）；`input.keys`→`input.key`；逻辑不变；opts 传 app | 逻辑等价，仅命名+参数键 | 现 actions/key.ts | +2/-2 |
| tools | tools/computer-use/actions/{click,scroll}.ts | handleClick/handleScroll | M | 读缓存坐标上下文 `{scaleFactor,windowBounds}=getComputerState(sid)` → `resolveTarget(input, sf, windowBounds)`（window-relative）；opts 传 app；scroll `input.amount`→`input.pages` | **MUST** coordinate 用缓存 windowBounds；element_index 不受影响 | B2.1 决策C；现 click.ts:26-31/scroll.ts:30-36 | +8 |
| tools | tools/computer-use/actions/read-ax-tree.ts | handleReadAxTree | M | **停缓存 scaleFactor**（AX-only 无窗口截图 → 不建坐标上下文；coordinate 上下文改由 screenshot/get_app_state 建）；opts 保 app | read-ax-tree 只出 element_index（coordinate 需先 screenshot/get_app_state） | B2.1 决策C；现 read-ax-tree.ts:36-40 | +0/-5 |
| agent | app/server/src/agent/tool-policy.ts | `TOOL_POLICY['playground-rocky'].bound` | M | 保 `'computer'`（单 tool 名覆盖 11 action，无需改）；更新注释列 11 action | **MUST NOT** 加 subagent/leader/mate/squad（控 OS 风险）；仅注释 | 现 tool-policy.ts:66-67 | +0/-0（注释） |

### 模块 P1-G：测试基建（mock fixture + mock-llm 剧本）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | tests/api/env_start.sh | computer-mock.json fixture | M | 加 `appState`（get_app_state）+ `apps`（list_apps）+ actionResults 的 drag/setValue/performSecondaryAction | 沿用 ROCKY_TEST_COMPUTER_NATIVE_PORT=mock | 现 fixture；P1-E | +8 |
| test | app/server/src/mock-llm.ts + mock-llm-scenarios.ts | computer directive → 单 `computer` tool_call | M | **机制不变**（`@@cu:<json>@@`→单 name='computer' tool_call，arguments=json）；仅 test-designer 用新 action json（如 `@@cu:{"action":"drag","from_x":10,"from_y":20,"to_x":30,"to_y":40}@@`） | **MUST** 出 name='computer'（现已是）；无需改代码，仅 directive 内容 | 现 mock-llm.ts:43/buildComputerScenario | +0 |

> **AT 处置**：AT 用 **mock port 测 tool 逻辑**（11 action dispatch / 门禁 / target·drag 解析 / 结果映射 / 错误分支），**不测真 OS 操作**。case 由 test-designer 阶段定；**真操作（真 AX 树 / 真键鼠 / 真 drag）走 dev dogfood 手验，不进 run_all**（守 test-no-real-spawn-system-gui：run_all 绝不触真原生动作）。

---

## B2.4 computer-mock.json fixture 契约（coder 定稿 — AT designer 按此写 case，全字段可选缺则默认）

```jsonc
{
  "permissions": { "accessibility": "granted"|"missing", "screenRecording": "granted"|"missing" },
  // action=screenshot（native 单窗口；windowBounds 供 coordinate 三段式；缺→默认 1×1PNG+scaleFactor:2）
  "screenshotBase64": "<裸 base64>", "mediaType": "image/png", "width": 0, "height": 0,
  "screenshotScaleFactor": 2, "screenshotWindowBounds": { "x": 0, "y": 0, "w": 0, "h": 0 },
  "appState": {                                    // action=get_app_state（缺→默认小树+1×1PNG+scaleFactor:2+windowBounds）
    "screenshot": { "data": "<裸 base64>", "mediaType": "image/png", "width": 0, "height": 0, "windowBounds": {"x":0,"y":0,"w":0,"h":0} },
    "axText": "[0] AXButton \"OK\" Secondary Actions: Raise\n[1] ...", "pid": 1234, "scaleFactor": 2,
    "windowBounds": { "x": 0, "y": 0, "w": 0, "h": 0 }, "ok": true, "reason": "<ok:false 时>"
  },
  "axTree": { "ok": true, "text": "...", "nodes": [...], "pid": 1234, "scaleFactor": 2 },  // action=read_ax_tree
  "apps": [ { "bundleId": "com.apple.Safari", "name": "Safari", "pid": 501, "isRunning": true } ], // list_apps
  "actionResults": {                               // click/type/scroll/drag/setValue/performSecondaryAction/pressKey
    "click": {"ok":true}, "type": {"ok":true}, "scroll": {"ok":true}, "pressKey": {"ok":true},
    "drag": {"ok":true}, "setValue": {"ok":true}, "performSecondaryAction": {"ok":true}   // 各缺→{ok:true}；ok:false+reason 测 !ok 分支
  }
}
```
- mock 不真操作 OS，**忽略 target/opts**，成败纯由 fixture 驱动（确定性）。directive `@@cu:<json>@@`（json=tool arguments），断言 `tool_call.name==='computer'` + `arguments.action==='<action>'`。

---

## B2.5 编译链 + spike + 波次 B 落地顺序（分级 de-risk）

- **编译链**（承前，不变）：Swift `swift build -c release`→`libRockyComputerCore.dylib`（`@_cdecl` C ABI）→ node-gyp（Electron headers ABI）→ `rocky_computer.node`（rpath `@loader_path` 并置 dylib）→ electron-builder `files`+`asarUnpack:['**/*.node','**/*.dylib']`+ 嵌套 codesign。**已建 + spike 0/1 通**（ping + readAxTree）。
- **Spike 2（native ScreenCaptureKit 截图 — 波次 B 第一个 spike，D-A 新增最大风险）**：验证 ScreenCaptureKit 在 node-gyp 编译的 addon 里跑通——framework 链接（ScreenCaptureKit/CoreMedia 随 `import` 自动链）+ Screen Recording TCC（addon 在 Electron 主进程，TCC 身份 = Rocky/Electron，与第一批 desktopCapturer 一致）+ `SCScreenshotManager.captureImage` async 回 PNG（`BlockingBridge.run(timeout:5)` 包 + AsyncWorker off-main，参考已验 readAxTree spike）。验证点：`addon.invoke('screenshot',{app})` 返非空 PNG base64 + windowBounds。**风险标注**：ScreenCaptureKit async Swift API + CMSampleBuffer/CGImage CFType 密集，`@_cdecl` 同步桥内必须 BlockingBridge 包（iFurySt 现成 timeout=5）；**编译链/权限通过前不铺全部截图逻辑**（同 readAxTree spike 分级原则）。
- **Spike 3（click AXPress + postToPid）**：手验一次（AXPress 语义 + postToPid 不抢前台）；通后 scroll/drag/type/pressKey/setValue/performSecondaryAction 同桥同范式逐个接（dev dogfood）。

**波次 B 落地顺序（spike→全量）**：
1. **Spike 2 native 截图**（先验编译+TCC+ScreenCaptureKit 链）→ 通则迁 Screenshot.swift 全量 + Service.screenshot/getAppState + CBridge screenshot/getAppState case（P1-B 截图半）。
2. **Spike 3 click** → 通则迁 Service 全部动作方法 + performSecondaryAction + AccessibilitySnapshot secondary 渲染 + CBridge 剩余 case（P1-B 动作半）。
3. **electron/loopback 补全**（P1-C/P1-D）：screenshot/getAppState 改调 native + 全 native 方法接线 + /invoke 泛路由。
4. **tool 层 11 action 重构**（P1-F）+ **mock/port 类型/AT**（P1-A/P1-E/P1-G）：**可与 native（1-3）并行**——tool 层用 mock port 完成编码+AT（不触真 OS），native 通后 dev dogfood 手验真操作。

## B2.6 风险点

| 风险 | 说明 | 缓解 |
|---|---|---|
| native 动作类真机行为 | click/type/scroll/drag postToPid 目标行为需真机验（mock 测不到）| dev dogfood 手验；AXPress 语义优先降坐标依赖 |
| AsyncWorker 线程 × CGEvent | 动作类 Thread.sleep 在 off-main worker | 现 addon.cc 已 AsyncWorker；CGEvent postToPid 线程安全 |
| secondary action 采集开销 | AXUIElementCopyActionNames 每元素一次 AX 调用 | budget 内（1200 节点）；只在 walk 采一次 |
| electron port native 方法漏接 | 波次 A 只接 2 方法，本批补 10+ | P1-C 逐方法列；typecheck + mock AT 兜 |

## B2.7 核对总览（architect 自检 — 引用符号存在性，已 grep/读确认）

| 引用 | 状态 | 备注 |
|---|---|---|
| 旧 swift-helper `Service.{screenshot,getAppState,click,scroll,drag,type,pressKey,listApps,setValue}` | ✓ 现有 | 迁入 computer-native（screenshot/getAppState/drag/listApps/setValue 全现成，非发明）；Service.swift:19-107 |
| 旧 swift-helper `Screenshot.swift`：`ScreenCapture.capture`/`captureImage`(SCShareableContent→SCScreenshotManager)/`boundedPNGData`/`frontWindow`/`BlockingBridge.run`/`CapturedWindow.bounds` | ✓ 现有 | **D-A per-window 截图迁入源**；Screenshot.swift:24-169 |
| 旧 swift-helper `InputSimulation.{clickTargeted,scrollTargeted,dragTargeted,typeText,pressKey}` + `KeyPressParser.parse` | ✓ 现有 | 迁入 computer-native；InputSimulation.swift:38-137 |
| computer-native `Permissions.snapshot().screenRecording`（Screenshot 前置权限）+ `Support.ComputerUseError` 全 case | ✓ 现有 | Screenshot/setValue 迁入依赖；已 grep 确认 |
| computer-native `Service.readAxTree` / `resolvePid(appHint:)` / `nodeDict` | ✓ 现有 | get_app_state 复用 readAxTree；resolvePid 支持 app hint |
| computer-native `CBridge.dispatch`（ping+readAxTree）/ `AccessibilitySnapshot.{build,walk,ElementRecord}` | ✓ 现有 | 扩 dispatch case + walk 加 secondary actions |
| `AXUIElementPerformAction` / `AXUIElementCopyActionNames` | ✓ Apple AX API | performSecondaryAction / secondary 采集 |
| `native-port.ts` 7 方法 + `AppInfo/AxTreeNode/PixelPoint/ComputerTarget/ComputerActionResult` | ✓ 现有 | 扩 5 方法 + GetAppStateResult/DragOptions 等新类型 |
| `mock-native-port.ts` ComputerMockFixture / MockComputerNativePort / fileFixtureLoader | ✓ 现有 | 扩 appState/apps fixture + 5 方法 |
| `loopback-native-port.ts` LoopbackComputerNativePort.{invoke,action}` 私有法 | ✓ 现有 | 5 新方法复用 |
| **`computer-loopback-server.ts routeLoopback`（仅 /permissions+/screenshot，无 /invoke）** | ⚠ 波次 A 缺 | **本批补 /invoke 泛路由** |
| **`computer-native-port.ts makeElectronComputerNativePort`（仅 checkPermissions+screenshot(desktopCapturer)）** | ⚠ 波次 A 缺 | **本批 screenshot 改调 native + 补全全 native 方法 + getAppState；删 desktopCapturer 全屏 helper** |
| `computer.ts run/COMPUTER_ACTIONS/ACTION_PERMS` + `schema.ts COMPUTER_INPUT_SCHEMA` | ✓ 现有 | 6→11 action |
| `target.ts resolveTarget` / `coords.pixelToGlobalPoint` / `session-state` / `image-block.wrapScreenshot` / `types.textResult/errorResult` | ✓ 现有 | 复用 + resolveDrag 新增 |
| `tool-policy 'computer'` / `registry COMPUTER_USE_TOOLS` / `ToolInput=Record<string,unknown>` | ✓ 现有 | 单 tool 名不改；ToolInput 任意参数 OK |
| mock-llm `@@cu:<json>@@` / `buildComputerScenario`（出 name='computer'） | ✓ 现有 | 机制不变，仅 directive 内容 |

## B2.8 决策定稿（用户已拍板 2026-07-10）

| # | 决策 | 定稿 | 落地 |
|---|---|---|---|
| D-A | get_app_state 合一 + 截图源 | **合一为主 action（图+树）+ native ScreenCaptureKit 单窗口截图**（用户拍板，接受额外 native 截图 spike 风险+工作量）；迁 Screenshot.swift 进 addon | P1-B（迁 Screenshot.swift + Service.screenshot/getAppState）；Spike 2 先验 |
| D-B | 保留 screenshot / read_ax_tree 补充 | **保留（共 11 action）**（用户确认，省 token/additive）| P1-F（screenshot 纯图 / read_ax_tree 纯树 / get_app_state 图+树）|
| D-C | app 定位 | **bundleId 或 name 字符串**，pid Swift `resolvePid(appHint:)` 内解析 | 对齐 iFurySt（现成）|
| D-D | 坐标模型 | **open-codex window-relative 三段式**（`windowPoint=pixel/scale`→`+windowBounds.origin`）（用户拍板，随 per-window 截图；推翻上版 screen-global）| P1-F（target.ts+session-state 缓存 windowBounds）；coords.ts 现成 |
| — | electron desktopCapturer 全屏 screenshot 处置 | **删（screenshot 走 native per-window）**（architect 定，理由：单一 window-relative 坐标模型/delete-dead-code/贴 open-codex；全屏 overview 未来走 native display-capture 模式）| P1-C 删 fullResThumbnailSize/stripDataUrlPrefix；permissions-ipc computeTestScreenshot 保留 |
