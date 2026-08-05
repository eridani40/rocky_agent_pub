# v0.0.105 变更计划书（method 级 review 合同）

> 架构期冻结的契约：planner 按本表切 task，coder 按本表实现，reviewer 按本表查偏离。
> 8 列：所属模块 / 文件路径 / 函数·符号 / 类型(A=新增/M=修改/D=删除) / 变更内容 / 约束 / 参考 / 影响行。
> 行 = 函数/符号（新增 class/interface/type 也各占一行）。
> **架构原则**：复用现有 ConnectorManager 双状态机/browser 范式，不重造；ImageBlock P0 前置（独立 Task 最先做）；权限双重防线（共享同一预检后端）；postToPid + Swift helper（仿 NodeWorkerDriver 三流分离 IPC）；linux/windows 仅接口签名。
> **核对状态**：架构期已 grep 核对引用符号存在（ConnectorManager / ContentBlock / TOOL_POLICY / defaultTools 等已验）。注「新增」= 现无此符号；「修改」= 已存在需改。

---

## 模块 A：ImageBlock 全链路打通（P0 前置，独立 Task 最先做）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| message | app/server/src/message/types.ts | `ImageBlock` | A | 加 interface `{type:'image', source:ImageSource, mediaType:string}` + `ImageSource = {kind:'url',url} \| {kind:'base64',data}` | 形态严格对齐 spec `agent_message_interface §4.2`（source.kind/base64 双态 + mediaType 顶层，**非** wire 嵌套形） | specs/tech/agent/message/[P0]agent_message_interface.md §4.2；design.md §7 | +12 |
| message | app/server/src/message/types.ts | `ContentBlock` | M | union 加 `\| ImageBlock`（6→7 类） | 保留向后兼容（旧数据无 image 不受影响）；不强制所有 role 允许 image（system/user/assistant/tool_result.content 都可承载，spec §3 表） | specs/tech/agent/message/[P0]agent_message_interface.md §3 | +1 |
| llm | app/server/src/llm/protocol-encode.ts | `encodeContentBlock` `case 'image'` | M | 现行 `{type:'image', source: b.source}` 假设 source 已 wire 形（来自 protocol-types）；适配新 spec 形 ImageBlock：source.kind==='base64' → `{type:'base64', media_type: mediaType, data}`；source.kind==='url' → `{type:'url', url}` | **禁**直接透传 `b.source`（spec 形 ≠ wire 形，drift 致 LLM 收错字段名）；encode 函数入参已是 spec ContentBlock（message/types），出参 wire 形 Record | specs/tech/agent/message §4.2；现 protocol-encode.ts:255 | +6/-2 |
| llm | app/server/src/llm/protocol-types.ts | `ContentBlock` (image variant) | M | 现 image variant 用 wire 嵌套形 `{source:{type,media_type,data}}`。**保留不动**（这是 wire 形，encode 产出对齐它）；只补注释说明 encode 输入侧（message/types ImageBlock spec 形）与输出侧（本 wire 形）的差异 | 禁两份 ContentBlock 概念合并（spec↔wire 形态差异是 spec 落地的已知分叉，encode 翻译） | 现状（types.ts 已对齐 spec，protocol-types 保留 wire） | +3 注释 |
| message | app/server/src/message/types.ts（注释） | 文件顶部注释 | M | 加 `[v0.0.105] ImageBlock 落地` 注释段，标注 v0.0.8 砍了的 ImageBlock 补回 + encode 适配点 | 不改其他 block 类型 | — | +4 |
| assemble | app/server/src/agent/context-compact-helpers.ts | （无改动，验证） | — | 已核对：仅 `b.type === 'text' \| 'reasoning'` 提取 text，image 不被 drop；compaction summary 是 text，image 在 compact 时随旧 message 落入 summary 是预期 | 禁后续添加 image filter 逻辑（会破坏 LLM 多模态上下文） | 已 grep 验证 | 0 |
| persistence | （无改动） | CrudStore JSON 序列化 base64 | — | JSON 自然处理 base64 string（PNG ~1-2MB / record）；FsCrudStore 文件存储可承载；本版本不优化 blob store | 若后续需独立 blob store，新版本处理 | — | 0 |
| ui | app/web/src/components/llm-chat/*（image 渲染） | image content block 渲染 | A | P1 最小占位：chat UI 渲染 image content block（占位 + click 展开）；可后置到 P1 | 非阻断（不渲染也不影响 LLM 收到 image，仅 UX） | PRD §2.5 ⑤ | +N（coder 定） |

---

## 模块 B：ComputerDriver / ComputerSession 接口 + macOS Swift helper

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| platform | app/server/src/platform/computer/types.ts | `ComputerPermissions` | A | `{accessibility:'granted'\|'missing', screenRecording:'granted'\|'missing'}` | 字段值域闭合（'granted'\|'missing' 两态） | platform/[P1]computer_driver.md §2 | +3 |
| platform | app/server/src/platform/computer/types.ts | `ScreenshotResult` | A | `{mime, data:base64, width, height, scaleFactor, windowBounds?}` | data 裸 base64（无 `data:` 前缀），让 tool 层包装 ImageBlock | §2 | +8 |
| platform | app/server/src/platform/computer/types.ts | `AxTreeNode` / `AppInfo` / `AppStateResult` / `PixelPoint` | A | 接口定义（element index/role/title/value/frame/children；AppInfo bundleId/name/pid/isRunning） | element_index 是顺序整数（非稳定 ID），跨 turn 失效 | §2 | +25 |
| platform | app/server/src/platform/computer/types.ts | `ComputerSession` | A | 长会话接口（checkPermissions/screenshot/click/drag/scroll/type/pressKey/getAppState/listApps/setValue/close） | click/scroll 收 `{elementIndex}\|{coordinate:PixelPoint}` 二选一；close 必释放 helper 进程；坐标换算在 driver 内部（pixel→windowPoint→globalPoint） | §2 | +30 |
| platform | app/server/src/platform/computer/types.ts | `ComputerDriver` | A | `{platform, isAvailable, connect(opts?,signal?), requestPermissions?, close}` | connect 返 ComputerSession（spawn helper + 握手）；不实现 connect 时抛 unsupported_platform | §2 | +10 |
| platform | app/server/src/platform/computer/types.ts | `ComputerConnectOptions` | A | `{helperPath?, screenshotMaxBytes?, screenshotMaxSide?}` | helperPath 默认解开预编译 zip 到 DATA_DIR 的位置 | §2 | +5 |
| platform | app/server/src/platform/computer/macos.ts | `MacOSComputerDriver` class | A | implements ComputerDriver：`isAvailable()` 检 process.platform==='darwin' + helper 解压 + 可执行位；`connect()` 解 zip → spawn helper → 握手（hello/ready）→ 返 MacOSComputerSession | 禁 Bun:ffi（不可用）；禁 osascript 生产路径（抢前台）；spawn detached 进程组；握手 protocol:1 | §3.1；specs/research/v0.0.105-cu-ifuryst-open-codex.md §5 | +60 |
| platform | app/server/src/platform/computer/macos.ts | `MacOSComputerSession` class | A | implements ComputerSession：持 ChildProcess + pending Map<id,{resolve,reject}>；每方法 = 写 stdin request + 等 stdout 同 id response（超时 30s）；`checkPermissions()` 优先用握手 tcc 态 + 异步刷新 | request id = ULID；超时 reject `ipc_timeout` + 标 session 不可用；stderr 非空拼 error.message | §3.1-§3.3 | +180 |
| platform | app/server/src/platform/computer/macos.ts | `MacOSComputerSession.click/scroll/drag` 坐标换算 | A | coordinate 模式：screenshotPixel / scaleFactor + windowBounds.origin → globalPoint；element_index 模式：AX 直接给 windowPoint 不换算 | scaleFactor 用 screenshot.width/windowBounds.w（不假设 2.0，多显示器混合 DPI）；y-down 坐标系 | §5 | 内含 |
| platform | app/server/src/platform/computer/macos.ts | `MacOSComputerSession.close` | A | 发 `{kind:'shutdown'}` → 等 helper exit（grace 5s）→ SIGTERM → SIGKILL 终极兜底；进程组清理 `process.kill(-pgid,'SIGKILL')` | 禁泄漏 helper 子进程（复用 BUG-001 经验：进程组 SIGKILL） | browser_tool.md §3.4；§3.1 | +15 |
| platform | app/server/src/platform/computer/linux.ts | `LinuxComputerDriver` | A | implements ComputerDriver：`isAvailable()`=false；`connect()` 抛 `unsupported_platform`；其余方法 stub | 仅签名，实现推后（D5） | §7 | +15 |
| platform | app/server/src/platform/computer/windows.ts | `WindowsComputerDriver` | A | 同 Linux 占位 | 仅签名 | §7 | +15 |
| platform | app/server/src/platform/computer/pick-driver.ts | `pickComputerDriver()` | A | 按 process.platform 选 driver（darwin→MacOS / linux→Linux / win32→Windows） | 仿 tools/browser/pick-driver.ts 范式 | browser_tool.md §3.3 | +12 |
| platform | app/server/src/platform/computer/swift-helper/Package.swift | Swift Package manifest | A | `.macOS(.v14)` + `swift-tools-version:6.2` + executable target `RockyComputerUseHelper` | 依赖：AppKit / ApplicationServices / CoreGraphics / ScreenCaptureKit / ImageIO / Carbon.HIToolbox / SQLite3 | research §6 | +25 |
| platform | app/server/src/platform/computer/swift-helper/Sources/RockyComputerUseHelper/main.swift | helper 入口 | A | stdin readLine 循环 + JSON 解码 + 分发（method→命令实现）+ stdout 编码；握手（hello→ready）；shutdown drain exit | newline-delimited JSON，每行一条；不生成 id（TS 侧生成）；stderr 诊断日志 | §3.2 | +120 |
| platform | app/server/src/platform/computer/swift-helper/Sources/RockyComputerUseHelper/Screenshot.swift | screenshot method 实现 | A | SCShareableContent → SCContentFilter(desktopIndependentWindow:) → SCScreenshotManager.captureImage + ImageIO 编码 PNG/JPEG + Retina scaleFactor | 字节预算 ≤900KB / 像素边 ≤1280（降采样）；showsCursor=false | research §6 | +80 |
| platform | app/server/src/platform/computer/swift-helper/Sources/RockyComputerUseHelper/InputSimulation.swift | click/scroll/drag/type/pressKey 实现 | A | CGEvent.postToPid 定向投递；type Unicode extended grapheme cluster chunking ≤64 UTF-16/chunk；pressKey xdotool spec 解析 | 不抢前台；不需 Input Monitoring；chunk 间 sleep(12ms) | research §8；§3.3 | +200 |
| platform | app/server/src/platform/computer/swift-helper/Sources/RockyComputerUseHelper/AccessibilitySnapshot.swift | getAppState / listApps / setValue / element_index AX tree 采集 | A | AXUIElement tree 采集（budget 1200 节点/64 层/500 字符 textLimit）+ element_index 顺序整数；AXSelectedChildren→AXPress/AXConfirm/AXOpen 语义动作链 + AXUIElementCopyElementAtPosition hit-test fallback + postToPid 物理鼠标 fallback | element_index 非稳定 ID（同 turn 有效） | research §4-§5 | +300 |
| platform | app/server/src/platform/computer/swift-helper/Sources/RockyComputerUseHelper/Permissions.swift | checkPermissions 实现 | A | TCC.db auth_value==2 直读（client_type=1 bundle）+ AXIsProcessTrusted() + CGPreflightScreenCaptureAccess() 三者 OR 合并 | 防 CLI/GUI TCC 不一致（research §10 已踩坑） | §3.4 | +120 |
| platform | app/server/src/platform/computer/swift-helper/Sources/RockyComputerUseHelper/KeyMapping.swift | xdotool key spec → virtualKey 映射 | A | KeyPressParser.parse spec（'a'/'Return'/'super+c'/'Up'/'KP_0'）→ Carbon kVK_* virtualKey + modifiers | modifier 先 down 主键 down/up modifier 反序 up | research §6 | +150 |
| platform | app/server/src/platform/computer/swift-helper/dist/RockyComputerUseHelper.app.zip | 预编译产物 | A | ad-hoc 签名的 `.app` bundle zip（随包发布；runtime 解压到 DATA_DIR） | 禁 runtime 依赖用户机器装 Swift toolchain（D6） | §6 | 二进制 |
| scripts/build-swift-helper.sh | 构建脚本 | A | swift build -c release + bundle 装配（Info.plist: LSUIElement=true + CFBundleIdentifier=com.rocky-agent.computer-use-helper）+ codesign（ad-hoc `--sign -`）+ zip | 开发者手动跑，非 runtime；CI 接 Developer ID cert 时改 codesign 参数 | §6 | +40 |

---

## 模块 C：Computer use 工具集（~9 独立 ToolDefinition）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools | app/server/src/tools/computer-use/permissions.ts | `PermissionRequirement` type | A | `{accessibility?:true, screenRecording?:true}` | — | computer_use_tool.md §5 | +3 |
| tools | app/server/src/tools/computer-use/permissions.ts | `ACTION_REQUIRED_PERMISSIONS` const | A | `Record<toolName, PermissionRequirement>`：list_apps/get_app_state/click/scroll/type_text/press_key → {accessibility:true}；get_app_state → +{screenRecording:true}；disconnect → {} | 静态声明表，门禁统一查；disconnect 无权限需求（不调 helper） | §2 + §5 | +15 |
| tools | app/server/src/tools/computer-use/permissions.ts | `checkPermissionGate` | A | `(required, perms) → 'accessibility'\|'screenRecording'\|null`（任一 missing 返其名） | 全 granted 返 null | §5 | +8 |
| tools | app/server/src/tools/computer-use/permissions.ts | `formatPermissionMissing(which)` | A | 引导文案：「执行此操作需要「${zh}」权限。请前往 系统设置 ▸ 隐私与安全性 ▸ ${zh}，开启「Rocky Computer Use」后重试」 | 文案含「系统设置」「Rocky Computer Use」关键词（AT 断言用） | PRD §2.3.2 | +12 |
| tools | app/server/src/tools/computer-use/connector-resolver.ts | `resolveComputerSession(ctx)` | A | 从 `ctx.config.computerConnectorManager` 取：检查存在 → connectForToolRun('computer', sessionId) → 失败按 kind 映射文案返 errorResult | 禁绕过 ConnectorManager 直 spawn helper；switch off → not_enabled 文案；in_use_by_other → 引导 owner session 先 disconnect | connectors.md §5.2；browser tool.ts:228-240 | +35 |
| tools | app/server/src/tools/computer-use/image-block.ts | `wrapScreenshot(screenshot)` | A | ScreenshotResult → ImageBlock `{type:'image', source:{kind:'base64', data: screenshot.data}, mediaType: screenshot.mime}` | 依赖 message/types ImageBlock（模块 A 打通后可用） | §4.2；agent_message_interface §4.2 | +8 |
| tools | app/server/src/tools/computer-use/list-apps.ts | `listAppsTool: Tool` | A | ToolDefinition（name='list_apps', 无参 schema, additionalProperties:false）+ run：resolveComputerSession → checkPermissionGate(accessibility) → session.listApps() → textResult(JSON) | description 后缀「(computer use tool)」引导 LLM | §4.1 | +30 |
| tools | app/server/src/tools/computer-use/get-app-state.ts | `getAppStateTool: Tool` | A | ToolDefinition（name='get_app_state', 可选 app/textLimit/default 500/maxTreeNodes/1200/maxTreeDepth/64）+ run：门禁（accessibility + screenRecording）→ session.getAppState(opts) → ToolRunResult content=[ImageBlock{screenshot}, TextBlock{axTree format}] | 每 turn 开头调；返 image + text 双 block；依赖 ImageBlock 打通 | §4.2 | +50 |
| tools | app/server/src/tools/computer-use/click.ts | `clickTool: Tool` | A | ToolDefinition（elementIndex\|coordinate 二选一，button/clickCount 可选）+ run：门禁 accessibility → session.click(target, {button,clickCount}) | coordinate 是 screenshotPixel（driver 内换算）；engine schema 不强 XOR → run 内补校验（无 target → errorResult） | §4.3 | +45 |
| tools | app/server/src/tools/computer-use/scroll.ts | `scrollTool: Tool` | A | ToolDefinition（coordinate+direction 必填，pages 默认 1，elementIndex 可选）+ run | coordinate screenshotPixel | §4.4 | +40 |
| tools | app/server/src/tools/computer-use/type-text.ts | `typeTextTool: Tool` | A | ToolDefinition（text 必填，coordinate/chunkSize 64/delayMs 12 可选）+ run：session.type(text, {chunkSize,delayMs}) | Unicode chunking 在 driver/Swift helper（不 tool 层） | §4.5 | +35 |
| tools | app/server/src/tools/computer-use/press-key.ts | `pressKeyTool: Tool` | A | ToolDefinition（key 必填，xdotool 语法，coordinate 可选）+ run：session.pressKey(key) | key spec 透传 driver；driver 解析 | §4.6 | +30 |
| tools | app/server/src/tools/computer-use/disconnect.ts | `disconnectTool: Tool` | A | ToolDefinition（name='disconnect', 无参）+ run：computerConnectorManager.disconnect('computer', sessionId) → textResult（isError:false 幂等）；**不调 helper 不查权限** | idempotent；未连接 no-op | §4.7；connectors.md §3.2.2 | +25 |
| tools | app/server/src/tools/computer-use/index.ts | `COMPUTER_USE_TOOLS: Tool[]` | A | 导出 7 P0 工具数组（list_apps/get_app_state/click/scroll/type_text/press_key/disconnect）；P1 三工具（perform_secondary_action/drag/set_value）占位视进度 | 注册序保稳定 | §11 | +15 |
| tools | app/server/src/tools/registry.ts | `defaultTools()` | M | import COMPUTER_USE_TOOLS + spread 进返回数组 | 禁双注册；保注册序 | 现状 registry.ts:64 | +3 |
| tools | app/server/src/tools/types.ts | `ToolSessionConfigLike.computerConnectorManager` | M | 加字段 `computerConnectorManager?: unknown`（鸭子类型，对齐 connectorManager 既有字段） | 缺省 undefined → computer use tools 返「未配置」errorResult | 现状 types.ts:108 connectorManager | +5 |
| agent | app/server/src/agent/tool-policy.ts | `TOOL_POLICY['playground-rocky'].bound` | M | 加 `'list_apps','get_app_state','click','scroll','type_text','press_key','disconnect'`（7 工具 P0 集） | 禁加到 subagent bound（控 OS 风险高）；studio-leader/mate 视场景加（建议加，coder 定） | tool_policy.md §2.2 | +7 |
| agent | app/server/src/agent/tool-policy.ts | `TOOL_POLICY['studio-leader'].bound` / `TOOL_POLICY['studio-mate'].bound` | M | 同上 7 工具（如场景需要） | studio-squad 不加（哑路由）；subagent 不加（risk） | §2.2 | +7/+7 |
| agent | app/server/src/agent/tool-policy.ts | bound 注释段 | M | 更新计数注释（playground 21+7=28；leader/mate 同） | 保注释与实际 bound 一致 | §2.2 注释 | +3 |

---

## 模块 D：ComputerConnectorManager + 共享 connector 类型提取

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| connector | app/server/src/connector/types.ts | `ConnectorId` | A（提取） | `'browser' \| 'computer'`（从 tools/browser/connector-types.ts 提取 + 加 'computer'） | v0.0.105 唯一新 'computer' 值 | connectors.md §3.1 | +1/-0 |
| connector | app/server/src/connector/types.ts | `ConnectorState` / `ConnectorSwitch` / `ConnectorConnection` / `OwnerRef` | A（提取） | 从 tools/browser/connector-types.ts 整体迁移；ConnectorState 加 `permissions?: ComputerPermissions` 字段（仅 computer） | 共享类型唯一源（browser + computer import） | connectors.md §3.1 | +25 |
| connector | app/server/src/connector/types.ts | `ConnectForToolRunErrorKind` / `ConnectForToolRunResult<SessionT>` | A（提取+泛化） | kind 联合加 `'permission_missing'`；Result 泛型化（BrowserSession / ComputerSession 各 instance） | 禁合并 typed session（Driver 层已 typed） | connectors.md §5 | +15 |
| connector | app/server/src/connector/types.ts | `ConnectorManager<SessionT>` interface | A（提取+泛化） | 共享接口（getState/getAll/isReady/getSession/getOwner/enable/disable/bootstrap/connectForToolRun/disconnect） | 每 manager 各实现一份（typed session 各异） | §5 | +18 |
| tools/browser | app/server/src/tools/browser/connector-types.ts | 全文件 | M（thin re-export） | 改为 `export * from '../../connector/types'` + browser 特定类型（BrowserSession 关联）保留；保 import 兼容（外部从 connector-manager 导入仍可用） | 禁破坏现有 import 路径（migrate 期 thin re-export） | 现状 | -50/+5 |
| tools/browser | app/server/src/tools/browser/connector-manager.ts | `BrowserConnectorManager` | M | import 改 from '../../connector/types'；实现不变（保 v0.0.46 lazy connect 语义） | 禁改 lazy connect / owner 锁 / 失败即停语义 | connectors.md §5.1 | +3/-3 |
| platform | app/server/src/platform/computer/connector-manager.ts | `ComputerConnectorManager` class | A | implements ConnectorManager<ComputerSession>：state/owner/session/permissions；门禁分层 1（switch off）→ 1.5（permission missing，调 driver.checkPermissions 不需 session 存在）→ 2（in_use_by_other）→ 3（复用）→ 4（lazy connect spawn helper）；disable 杀 helper 进程 | 不变量：permission missing 阻止 connecting；owner 锁 sessionId 全局唯一；disconnect idempotent；失败即停不重试 | connectors.md §5.2；browser connector-manager.ts 同构 | +180 |
| platform | app/server/src/platform/computer/connector-manager.ts | `ComputerConnectorManager.connectForToolRun` 门禁 1.5 | A | 调 `driver.checkPermissions?()` 或独立 TCC.db 查询（不依赖 session 存在）；missing → 返 `{kind:'permission_missing', which}` | driver-level checkPermissions 必须支持 disconnected 态调用（预检不依赖 connect） | computer_driver.md §3.4 | 内含 |
| platform | app/server/src/platform/computer/connector-bootstrap.ts | `createAndBootstrapComputerConnectorManager(dataDir)` | A | 工厂：构造 MacOSComputerDriver + ComputerConnectorManager + 调 bootstrap（仅读 intent 恢复 state.switch，不 connect） | 仿 tools/browser/connector-bootstrap.ts；失败降级 noop | browser connector-bootstrap.ts | +35 |
| handlers | app/server/src/handlers/session-deps.ts | `computerConnectorManager?` 字段 | M | SessionDeps 加字段（仿 connectorManager）；router 从 bootstrap.computerConnectorManager 注入；DELETE /session/:id 兜底 disconnect('computer', id) | 缺省 → session-config 走 noop（computer use tools fail-closed） | 现状 session-deps.ts:97 | +8 |
| bootstrap | app/server/src/bootstrap.ts | `createAndBootstrapComputerConnectorManager` 调用 | M | 加 import + 在 createAndBootstrapConnectorManager 之后调；bootstrap 返回对象加 `computerConnectorManager` 字段；注入 session-deps | 降级不阻断 app 启动（同 browser） | 现状 bootstrap.ts:795 | +10 |
| bootstrap | app/server/src/bootstrap.ts | `BootstrapDeps.computerConnectorManager` 字段 | M | 接口加字段（仿 connectorManager） | — | 现状 bootstrap.ts:154 | +3 |

---

## 模块 E：HTTP facade + 路由

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| handlers | app/server/src/handlers/computer-permissions.ts | `handleComputerPermissions(driver)` | A | `GET /connector/computer/permissions` → 调 driver.checkPermissions() → 200 `{accessibility, screenRecording}`；driver 缺失 / 非 macOS → 200 两 missing（不报错）；helper 异常 → 500 | 禁 404（linux CI 跑 UI dom 不断）；共享 driver-level 预检（与 tool 门禁零 drift） | api/18-computer-use.md §2 | +30 |
| handlers | app/server/src/handlers/computer-permissions.ts | `handleComputerPermissionsRoute(req, method, path, driver)` | A | 路由分发 /connector/computer/permissions | 非 GET → 405 + Allow:GET | §2.5 | +15 |
| handlers | app/server/src/handlers/connector.ts | `VALID_CONNECTOR_IDS` | M | 加 'computer'：`new Set<ConnectorId>(['browser', 'computer'])` | — | api/18 §3.3 | +1 |
| handlers | app/server/src/handlers/connector.ts | `handleConnectorList(cm_browser, cm_computer)` | M | 改签名接两 manager；串两 getAll → items | 禁合并 ConnectorManager 实例；按 id 路由 | §3.3 | +8/-3 |
| handlers | app/server/src/handlers/connector.ts | `handleConnectorRoute` | M | 按 `:id` 路由到对应 manager（browser→cm_browser / computer→cm_computer） | — | §3.3 | +10/-3 |
| router | app/server/src/handlers/router.ts | `/connector/computer/permissions` 路由 | M | 注册 `GET /connector/computer/permissions` → handleComputerPermissionsRoute | 加在 `/config/connectors` 路由附近 | api/18 §2.5 | +5 |
| router | app/server/src/handlers/router.ts | `/config/connectors` 调用点 | M | handleConnectorRoute 传两 manager（cm_browser + cm_computer） | — | 现状 | +2/-1 |

---

## 模块 F：UI connector 页 computer tab（testid 契约 + 组件）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui | app/web/src/components/connector-page/page-connector.tsx | `PageConnector` | M | tab 栏从单 tab 扩双 tab（browser \| computer）；active tab state；按 active 渲染对应 section | 默认 browser 选中；tab 切换不持久化 | ui/05-connectors.md §2-§3.3 | +30/-5 |
| ui | app/web/src/components/connector-page/section-computer-connector.tsx | `SectionComputerConnector` | A | computer-connector-card 组件：toggle + status（6 态矩阵）+ guide + 权限面板；props {state, permissions, onToggle, onRecheck} | 6 态矩阵含「需要系统权限」橙；permission missing 阻止 connecting 不变量；switch=on 时权限面板常驻 | ui/05-connectors.md §3.2 | +200 |
| ui | app/web/src/components/connector-page/computer-connector-permissions.tsx | `ComputerConnectorPermissions` | A | 权限面板组件：两行（accessibility + screen-recording），每行 ✓绿/✗红 + 「去授权」（仅 missing，预留固定空间防位移）+ 「重新检测」按钮 | 三重动态监测：①window focus 立即重检 ②switch=on 时 3s 轮询 ③手动按钮 | ui §3.2；api/18 §2 | +120 |
| ui | app/web/src/components/connector-page/computer-connector-permissions.tsx | `useComputerPermissions(sessionId, switchState)` hook | A | 三重监测调度（focus + setInterval 3000 + manual）→ GET /connector/computer/permissions → 返 {accessibility, screenRecording, recheck} | 禁固定 sleep（用 focus event + setInterval）；switch=off 时停止轮询 | ui §3.2 | +30 |
| ui | app/web/src/components/connector-page/page-connector.tsx | tab 切换 handler | A | `onTabChange(id:'browser'\|'computer')` → setActiveTab | — | §3.3 | +8 |
| ui | app/web/src/components/llm-chat/*（image 渲染，模块 A 补） | image content block 渲染 | A | P1 最小占位（chat UI 展示 image block，click 展开） | 非阻断（可后置 P1） | PRD §2.5 ⑤ | +N |

---

## 模块 G：spec 同步（架构期已产出，coder/doc-modifier 维护）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| specs | specs/tech/agent/platform/index.md + log.md | OKF KB | A | 新建 platform KB 总起 + log（v0.0.105 块） | 架构期已产出 | — | 已写 |
| specs | specs/tech/agent/platform/[P1]computer_driver.md | 接口 + IPC 协议 + bundle 机制 | A | 新建 computer_driver spec | 架构期已产出 | — | 已写 |
| specs | specs/tech/agent/tools/[P1]computer_use_tool.md | 工具集 spec | A | 新建 computer_use_tool spec | 架构期已产出 | — | 已写 |
| specs | specs/tech/agent/tools/log.md | log 追加 v0.0.105 块 | M | 加 v0.0.105 块（新建 computer_use_tool.md + 模块 A ImageBlock） | — | — | +15 |
| specs | specs/tech/agent/tools/index.md | 导航 | M | 加 computer_use_tool.md 行；工具数 17→24（加 7 P0 computer use tools） | — | — | +2 |
| specs | specs/tech/config/[P1]connectors.md | computer 第 2 connector | M | §1/§3.1/§3.2.2/§5/§5.2/§8 全改（架构期已产出） | — | — | 已改 |
| specs | specs/tech/config/log.md | log 追加 v0.0.105 块 | M | 加 v0.0.105 块 | — | — | +10 |
| specs | specs/tech/agent/message/[P0]agent_message_interface.md | ImageBlock GAP note | M | §4.2 加 [v0.0.105] note（架构期已产出） | — | — | 已改 |
| specs | specs/tech/agent/message/log.md | log 追加 v0.0.105 块 | M | 加 v0.0.105 块（架构期已产出） | — | — | 已改 |
| specs | specs/ui/overall/05-connectors.md | computer tab UI 契约 | M | §1-§5 全改（架构期已产出） | — | — | 已改 |
| specs | specs/api/overall/18-computer-use.md | API 契约 | A | 新建（架构期已产出） | — | — | 已写 |

---

## 开放点解决方案（架构期产出）

### 开放点① TS↔Swift IPC 协议格式

**方案**：newline-delimited JSON over stdin/stdout（仿 NodeWorkerDriver 三流分离），消息用 `kind` discriminator：
- TS→Swift：`{kind:'hello'\|'request'\|'shutdown', ...}`（hello 握手 / request 方法调用 id=ULID / shutdown 关闭）
- Swift→TS：`{kind:'ready'\|'response'\|'event', ...}`（ready 握手响应含初始 tcc 态省一次 checkPermissions / response id 配对 / event 异步如 permission_changed）
- 协议版本 `protocol:1`（握手协商；未来加 negotiation）
- 长会话（一次 connect 一个 helper 进程，跨多 action 复用）；不像 NodeWorkerDriver 一次性（computer session 有 AX element_index refs 跨 action 状态）
- 超时 30s（TS 侧）→ reject `ipc_timeout` + 标 session 不可用
- 详 `specs/tech/agent/platform/[P1]computer_driver.md §3.2`

### 开放点② `.app` bundle CI 编译签名机制

**方案**：D6 预编译 `.app` zip 进项目（`app/server/src/platform/computer/swift-helper/dist/RockyComputerUseHelper.app.zip`）：
- 仓库结构：Swift Package（`Package.swift` .macOS(.v14)）+ Sources/RockyComputerUseHelper/*.swift（复用 iFurySt open-codex 逆向成果）+ dist/ 预编译 zip
- 构建：`scripts/build-swift-helper.sh`（swift build -c release + bundle 装配 Info.plist LSUIElement=true + codesign `--sign -` ad-hoc + zip）
- CI：GitHub Actions `macos-latest` job 跑 build script；release 流水线接 Developer ID Application 证书（`APPLE_DEV_ID_CERT_BASE64` secret）+ notarytool submit
- Runtime 部署：`MacOSComputerDriver.connect` 检测 darwin → 解 zip 到 `<DATA_DIR>/computer-helper/v<version>/` → 校验 codesign → spawn `<app>/Contents/MacOS/RockyComputerUseHelper`
- tradeoff：v0.0.105 首版 ad-hoc 签名（TCC 授权挂 bundle id 但签名身份不稳，bundle 移动可能丢授权，文档化首次授权 + 重授权流程）；后续接 Developer ID
- 详 `specs/tech/agent/platform/[P1]computer_driver.md §6`

---

## 核对总览（architect 自检 — 引用符号存在性）

| 引用 | 状态 | 备注 |
|---|---|---|
| `message/types.ts ContentBlock` union（行 174-180） | ✓ 现有 6 类无 image | 加 ImageBlock 是真新增 |
| `protocol-encode.ts encodeContentBlock case 'image'`（行 255） | ✓ 现有但假设 wire 形 | 修改（适配 spec 形翻译） |
| `protocol-types.ts ContentBlock image variant` | ✓ 现有 wire 形 | 保留（注释说明 spec↔wire 分叉） |
| `tools/registry.ts defaultTools()`（行 64） | ✓ 现有 | spread COMPUTER_USE_TOOLS |
| `tools/types.ts ToolSessionConfigLike.connectorManager`（行 108） | ✓ 现有 | 加 computerConnectorManager 字段（仿） |
| `tools/browser/connector-types.ts` ConnectorManager 接口 | ✓ 现有 browser-only | 提取到 connector/types.ts 泛型化 |
| `tools/browser/connector-manager.ts BrowserConnectorManager` | ✓ 现有 | import 改向；实现不变 |
| `agent/tool-policy.ts TOOL_POLICY['playground-rocky'].bound` | ✓ 现有 21 项 | 加 7 computer use 工具 |
| `handlers/connector.ts VALID_CONNECTOR_IDS`（行 29） | ✓ 现有 `Set<ConnectorId>(['browser'])` | 加 'computer' |
| `handlers/session-deps.ts SessionDeps.connectorManager`（行 97） | ✓ 现有 | 加 computerConnectorManager 字段 |
| `bootstrap.ts createAndBootstrapConnectorManager`（行 795） | ✓ 现有 | 仿新增 computer 版 |
| `app/server/src/platform/` 目录 | ✓ 存在（workspace-dialog.ts/workspace-open.ts） | 加 computer/ 子目录 |
| `app/server/src/connector/` 目录 | ✗ 不存在 | 新建（共享类型提取目标） |
| `app/server/src/tools/computer-use/` 目录 | ✗ 不存在 | 新建（工具集） |
| enum 闭合性（ComputerPermissions 字段值） | 新增（architect 定义的开放接口） | TS string literal union，非 Record<Enum>，无闭合性风险 |

---

## 与 PRD/design 的偏差记录（architect 阶段）

| 项 | PRD/design 表述 | architect 决策 | 理由 |
|---|---|---|---|
| ConnectorManager 形态 | design.md §3「扩现有 ConnectorManager 加 `computer` 类型」 | **不合并**：browser 与 computer 各独立 manager，共享类型提取到 `app/server/src/connector/types.ts`（新建） | typed session 不同（BrowserSession vs ComputerSession）；合并需泛型 ConnectorManager<SessionT>，对仅 2 消费者复杂度溢出；提取共享类型 + 各 manager 各实现是更清晰的边界 |
| 共享类型位置 | 隐含 tools/browser/connector-types.ts | 新建 `app/server/src/connector/types.ts` | 镜像 spec 位置（specs/tech/config/）；future connector #3 trivial 扩；tools/browser/ 改 thin re-export 保 import 兼容 |
| 坐标换算位置 | design.md §2「坐标换算链」未指定层 | **driver 内部**（screenshot scaleFactor + windowBounds.origin 是 driver 产物，tool 层不需重复持有） | driver 薄包装 + 测试可控（mock driver 不需造 scaleFactor fixture） |
| ImageBlock 打通深度 | design.md §7 5 点 | 拆独立 Task 最先做（模块 A）+ 标注 encode 适配是关键 GAP（PRD 未明确） | encode 现 `{source: b.source}` 假设 wire 形，spec ImageBlock 形不同 → 必翻译，否则 LLM 收错字段名；架构期核对发现 |
| HITL interaction 接入 | PRD §2.6「computer use 工具挂 interaction() 钩子」 | P0 **不挂**（首版聚焦工具能力打通）；P1 接入 | subState='need_approval' / handleType='approval' 的 approval handleType 已 spec 留位但 v0.0.101 未实例；首版主要防线是 TOOL_POLICY bound + switch flag + 运行时权限门禁 |
| linux/windows 实现 | design.md §10「仅接口签名」 | 接口签名 + Driver 占位类（isAvailable=false, connect 抛 unsupported_platform） | 显式 stub 优于留空，UT/AT 可测「平台不支持」分支 |

---

## 编码简报（orchestrator 裁决 — api-test-designer 阶段 2.5 挖出的 coder 依赖钩子 + 契约固化）

> 来源：api-test-designer 冒烟 8 个 AT case 时发现的实现依赖 + 契约不明确点。orchestrator 裁决后固化，coder 编码波次必须落实（否则 case 4-8 无法通过）。

### A. coder 必须补的测试基建钩子（3 个，模块 B/D/mock-llm）

| # | 钩子 | 落点 | 契约 | 依赖 case |
|---|---|---|---|---|
| 钩子1 | `ROCKY_TEST_COMPUTER_DRIVER=mock` env → 装 MockComputerDriver | `platform/computer/pick-driver.ts` + 读 `<DATA_DIR>/computer-mock.json` fixture | fixture `{permissions:{accessibility,screenRecording}, screenshotBase64, screenshotWidth/Height, scaleFactor, axTreeText, clickAck}`；零子进程（守 test-no-real-spawn-system-gui）；仿 `ROCKY_TEST_MOCK_LLM` 范式 | 全 8 case |
| 钩子2 | `ROCKY_TEST_COMPUTER_DRIVER=mock` 进 `tests/api/env_start.sh`（或 NODE_ENV=test 默认 mock driver） | tests/api/env_start.sh | env_start 未设该 env → 全 case mock driver 不生效 | 全 8 case |
| 钩子3 | mock LLM computer 剧本 | `tests/.../mock-llm.ts`（现只出 bash-echo） | MOCK_LLM=1 时扫 last user 消息标记 `@@cu:<toolName>@@`（get_app_state/click/disconnect）→ turn1 出该 computer_use tool_call（默认 args）、turn2 收 tool_result 后出收尾 end_turn（仿 buildToolScenario） | case 4-8 |

### B. orchestrator 已裁决的契约点（4 个 — coder 按此实现，doc-modifier 阶段5 同步 spec）

| # | 契约点 | 裁决 | 理由 |
|---|---|---|---|
| 契约1 | click 参数命名 `element_index`(PRD/UC snake) vs `elementIndex`(computer_use_tool.md §4.3 camel) | **统一 `element_index`（snake_case）** — inputSchema + PRD + UC 全用 snake | 对齐 open-codex 蓝本（其 tool schema snake）；doc-modifier 阶段5 改 computer_use_tool.md §4.3 camel→snake |
| 契约2 | 缺权限门禁 formatter 措辞（门禁1.5 formatConnectorError vs tool.run §5 formatPermissionMissing） | **两路 formatter 引导措辞必须一致**，都含 3 关键词（辅助功能/系统设置/Rocky Computer Use）— PRD「共享同一预检后端」核心约束 | case 6 按 PRD path-3 断言 3 关键词；无论先命中哪路门禁都须引导一致 |
| 契约3 | owner 跨 run 持有性（connectors §3.2.2 computer 无「run-idle 释放 owner」行） | **computer owner 仅在 disconnect action / session DELETE / toggle-off / helper 崩溃时释放**（不在 run-idle 释放） | PRD P5 明确假设 owner 持有到显式释放；case 7/8 依赖；与 browser「session 结束兜底断」一致但 computer 不做 run-idle 释放。doc-modifier 补 connectors §3.2.2 owner 释放条件行 |
| 契约4 | in_use_by_other tool-result 确切措辞 | **result 里 surface `ownerSessionId`** 给 LLM 参考 + isError=true | case 8 容错断言（owner sid 或 in_use_by_other/占用/其他会话 关键词）；建议明确 surface ownerSessionId |

**coder 落实以上 → 8 AT case 可通过。契约1/3 是 doc-sync 待办（doc-modifier 阶段5 同步 computer_use_tool.md + connectors.md）。**
