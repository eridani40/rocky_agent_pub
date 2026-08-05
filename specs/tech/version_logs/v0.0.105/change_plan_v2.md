# v0.0.105 变更计划书 v2（架构 pivot 后 — method 级 review 合同）

> **本文件取代 `change_plan.md`（v1，spawn helper + connector 架构）。** v1 保留作历史；coder/reviewer 一律以本 v2 为准。
> 8 列：所属模块 / 文件路径 / 函数·符号 / 类型(A=新增/M=修改/D=删除) / 变更内容 / 约束 / 参考 / 影响行。行 = 函数/符号。

## 0. Pivot 结论与铁律（不可违背）

**真机 dogfood 铁证（2026-07-10）**：`@app/server` 裸 spawn Swift helper 子进程**拿不到 macOS TCC 权限**（TCC 按进程签名身份判定，spawn 子进程不继承宿主授权，实测 4+ 次）。用户拍板 + 竞品 iFurySt 实证 + 用户真机验证成功（辅助功能✓ + 屏幕录制✓ + 测试截图出桌面缩略图）：

**铁律**：macOS 原生能力（截图 / AX 树 / 键鼠输入 / 权限查询）**必须在 Rocky Electron 主进程内实现**（`com.rocky.agent` = TCC 权限主体）。**绝不 spawn 独立 helper 二进制。** 详见 memory `macos-tcc-spawn-no-perm-use-electron-host`。

## 1. 架构总览：ComputerNativePort 模式（替代 spawn/driver/connector）

**核心翻转**：废除「ConnectorManager → spawn Swift helper driver → IPC session」三层，改为「主进程注入 `ComputerNativePort` 实现 → server tool 直调 port」。computer **去连接器语义**（无 toggle / owner 锁 / connect-disconnect；本机主进程常驻能力，不像 browser 连外部 CDP）。

```
                         [ Rocky Electron 主进程 = TCC 权限主体 ]
app/electron (唯一 import electron)                         app/server (零 electron)
┌─────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ main.ts startBackend()               │        │ ComputerNativePort (interface)         │
│   → startBackend 后 setComputerNative│───注入─▶│   checkPermissions() / screenshot()    │
│     Port( makeElectronComputerNative │        │ native-port-registry (setX/getX)       │
│           Port() )                   │        │   ↓ bootstrap 读 registry(或env mock)  │
│ computer-native-port.ts (electron    │        │ BootstrapResult.computerNativePort     │
│   impl：复用 spike compute*(desktop  │        │   ↓ session-config 注入 ctx.config     │
│   Capturer/systemPreferences))       │        │ tools/computer-use/screenshot.ts       │
│ computer-permissions-ipc.ts (UI 路径 │        │   → port.screenshot() → wrapScreenshot │
│   window.rockyComputer，已验证 spike)│        │   → ToolRunResult{[ImageBlock]} 回灌 LLM│
└─────────────────────────────────────┘        └──────────────────────────────────────┘
```

**不变量**：
1. **server 零 electron 依赖** — `ComputerNativePort` 是纯 TS interface；server 只调 port，绝不 import electron / 绝不 spawn。
2. **main.ts 是唯一 electron 入口** — port 的电子实现 + 注入都在 `app/electron`。
3. **UT/AT 可注入 mock port** — 守 memory `test-no-real-spawn-system-gui`（零真实 spawn/GUI）。
4. **两条独立路径**：① UI 权限面板走 `window.rockyComputer`（preload→主进程 IPC，spike 已验证，**本版本不动**）；② agent 截图走 `ComputerNativePort`（本版本第一批新建）。二者各调同一批主进程原生原语（desktopCapturer/systemPreferences），但互不依赖。

## 2. 注入链路（替代旧 ConnectorManager bootstrap）

| 环节 | 机制 | 三态行为 |
|---|---|---|
| 注入原语 | `setComputerNativePort(port)`（server 导出的 process 级 setter，架构原则#6 setX 注入） | main.ts 在 `startBackend` 后调，传入 electron impl |
| bootstrap 消费 | `bootstrapBuiltinPlugins` 读 `resolveMockComputerNativePort(env) ?? resolveLoopbackComputerNativePort(env) ?? getComputerNativePort()` → `BootstrapResult.computerNativePort` | **packaged**：registry 有 electron 直调 port → 全闭环；**dev(bun 后端)**：`ROCKY_DEV_COMPUTER_LOOPBACK_PORT` 有值 → LoopbackComputerNativePort（纯 fetch → Electron 主进程 loopback 通道 → desktopCapturer，**dev 可验闭环**，见 §5.5 P0-G）；**AT**：env mock → MockComputerNativePort（零 electron/spawn）；**非 electron/无通道**：undefined → tool 返「仅桌面 App 可用」 |
| tool 消费 | session-config 注入 `ctx.config.computerNativePort`；screenshot tool 读取 | 缺省 undefined → fail-closed errorResult |

> **为何用 registry setter 而非 startServer opts 透传**：`handleRequest(req, dataDir)` 是全局纯函数、bootstrap 按 dataDir 缓存懒建，port 是 process 级单例（一个 Electron 宿主）。透传会污染 `handleRequest`/`getBootstrap` 签名；setter 是最小侵入且对齐既有 per-dataDir bootstrap 单例范式。main.ts 在首个请求前 set → bootstrap 首建时读到，时序安全。

## 3. 分批策略

- **第一批「截图闭环」（本次 change_plan v2 主体，method 级）**：agent 调 `screenshot` tool → 主进程 desktopCapturer 截图 → ImageBlock 回灌 LLM 看屏幕。**不需 native addon**（纯 Electron desktopCapturer/systemPreferences）。
- **第二批「native addon」（本文件 §6 给方向+选型，不 method 级）**：AX 树读取 + CGEvent 键鼠输入，native addon 跑主进程内共享 TCC 身份。

---

## 4. 旧 T1-T6 代码处置表（逐文件：保留/废弃/移植/改造 + 理由）

> 废弃代码按 memory `soft-delete-instead-of-rm` 用 `mv` 到 `soft_deleted/`（保留可回溯），不直接 rm。`.build/` 构建垃圾可直接清。

### T1 — ImageBlock（模块 A）：**全保留** ✅

| 文件 | 处置 | 理由 |
|---|---|---|
| `app/server/src/message/types.ts` ImageBlock/ImageSource/ContentBlock | **保留** | 截图回灌 LLM 的协议原语，与原生实现无关；screenshot tool 直接消费 |
| `app/server/src/llm/protocol-encode.ts` case image | **保留** | spec 形→wire 形翻译，wrapScreenshot 产出依赖它 |
| `app/server/src/llm/protocol-types.ts` image variant | **保留** | wire 形，不动 |
| `app/web/src/components/chat-page/*` image 渲染 | **保留** | 截图在对话区展示 |

### T2 — platform/computer + swift-helper（模块 B）：**大部废弃，Swift 输入/AX 逻辑留作 addon 移植素材**

| 文件 | 处置 | 理由 |
|---|---|---|
| `platform/computer/ipc-client.ts` | **废弃**(mv) | spawn newline-JSON IPC 传输层，pivot 无 spawn |
| `platform/computer/macos.ts`（MacOSComputerDriver） | **废弃**(mv) | spawn helper + 握手，driver 抽象整废 |
| `platform/computer/macos-session.ts`（MacOSComputerSession） | **废弃**(mv) | stdin/stdout IPC 长会话，无 helper 进程 |
| `platform/computer/helper-bundle.ts` | **废弃**(mv) | 解压 `.app` bundle，无 bundle |
| `platform/computer/pick-driver.ts` | **废弃**(mv) | 平台→driver 选择，port 取代 driver 抽象 |
| `platform/computer/unsupported-driver.ts` / `linux.ts` / `windows.ts` | **废弃**(mv) | driver 占位 stub，无 driver 概念（非 macOS 由 port impl 内 supported=false 降级） |
| `platform/computer/mock.ts`（MockComputerDriver） | **改造** | 概念保留：改写为 `MockComputerNativePort`（读 fixture，零 spawn），见 §5 模块 P0-F |
| `platform/computer/types.ts` | **改造** | 抽出仍有效的纯类型形状（ComputerPermissions/ScreenshotResult/AxTreeNode/AppInfo/PixelPoint/ComputerTarget/ClickOptions/ComputerError）进新 `native-port.ts`；**删** ComputerDriver/ComputerSession/ComputerConnectOptions（session/connect/driver 概念） |
| `platform/computer/coords.ts` | **保留(batch2)** | pixel→window→global 坐标换算，第二批键鼠输入需要；batch1 不接线 |
| `platform/computer/index.ts` | **改造** | barrel 重导出 native-port 而非 driver |
| `platform/computer/swift-helper/Sources/{InputSimulation,AccessibilitySnapshot,KeyMapping,Service,Support}.swift` | **保留(移植素材)** | CGEvent postToPid 后台输入 + AX 树采集 + xdotool 键映射 = 第二批 addon 核心逻辑，Electron 无等价物，高价值 |
| `swift-helper/Sources/{Screenshot,Permissions}.swift` | **保留(低优移植素材)** | 截图/权限 batch1 已由 desktopCapturer/systemPreferences 取代；仅第二批若需高保真截图再参考 |
| `swift-helper/{main.swift,Package.swift(executable)}` | **改造(batch2)** | executable+stdin 循环废；第二批改 dylib target（见 §6） |
| `swift-helper/dist/*.app.zip` + `.app/` + `.build/` | **废弃/清理** | 预编译 spawn bundle + 构建产物，`.build/` 直接清 |
| `scripts/build-swift-helper.sh` | **废弃**(mv) | spawn helper 构建脚本；第二批 addon 构建脚本另起 |
| `tests/api/env_start.sh` `ROCKY_TEST_COMPUTER_DRIVER=mock` | **改造** | 改为 `ROCKY_TEST_COMPUTER_NATIVE_PORT=mock` |

### T3 — ComputerConnectorManager + 共享 connector 类型（模块 D）：**连接器整废，browser 共享类型保留但回退 computer 位**

| 文件 | 处置 | 理由 |
|---|---|---|
| `platform/computer/connector-manager.ts`（ComputerConnectorManager） | **废弃**(mv) | 去连接器语义（无 owner/switch/lazy connect） |
| `platform/computer/connector-bootstrap.ts` | **废弃**(mv) | 同上 |
| `app/server/src/connector/types.ts` | **改造(回退 computer 位)** | 共享抽取本身是干净重构，**保留**；但**必删** computer 特化：`import ComputerPermissions`（line 13，指向将废的 platform/computer/types）+ `ConnectorId` 回 `'browser'`（line 16）+ `permissions?` 字段（line 44）+ `permission_missing` kind（line 53）。否则 typecheck 断（依赖已废文件） |
| `tools/browser/connector-types.ts`（thin re-export） | **保留** | browser 重构无害 |
| `tools/browser/connector-manager.ts`（import 改向） | **保留** | browser 实现零改动 |

### T4 — computer 工具集（模块 C）：**未编码（pending），旧设计废弃，第一批重设计**

旧设计（7 工具 + connector-resolver 走 ConnectorManager + 双路权限门禁）→ **废弃**。第一批只做 `screenshot` 单工具（走 port，无 connector），见 §5。第二批补齐其余工具（走 addon）。

### T5 — HTTP facade（模块 E）：**未编码（pending），全废弃**

| 项 | 处置 | 理由 |
|---|---|---|
| `handlers/computer-permissions.ts`（旧设计 GET /connector/computer/permissions） | **不做** | 前端权限走 Electron IPC（spike 已做 window.rockyComputer），不需 HTTP 端点 |
| `handlers/connector.ts` VALID_CONNECTOR_IDS / 双 manager 路由 | **无需改**（未编码，仍 `['browser']` 单 manager） | 连接器不含 computer |
| `router.ts` line 149-150 `computerConnectorManager: bs.computerConnectorManager` | **改造** | 改为 `computerNativePort: bs.computerNativePort`（见 §5 模块 P0-C） |

### T6 — UI（模块 F）：**spike 版保留，旧连接器设计不做**

| 文件 | 处置 | 理由 |
|---|---|---|
| `connector-page/section-computer-connector.tsx`（spike，Electron IPC） | **保留** ✅ | 真机验证成功，pivot 正确形态（权限两行 + 3 按钮 + 测试截图） |
| `connector-page/page-connector.tsx` computer tab（spike 已接） | **保留** ✅ | 自管 IPC 态，无 ConnectorState/onToggle |
| 旧设计 `computer-connector-permissions.tsx`（HTTP 轮询 useComputerPermissions hook） | **不做** | 权限走 Electron IPC，无 HTTP 轮询 |
| 旧设计 6 态连接状态机（switch×permission×connection） | **不做** | 无连接语义，spike 只留权限引导 |
| mock-llm computer 剧本 `@@cu:toolName@@` | **改造** | 简化为 screenshot 单工具剧本（见 §5 模块 P0-F） |

---

## 5. 第一批「截图闭环」change_plan（method 级，8 列）

> 闭环目标：**agent 调 `screenshot` tool → 主进程 desktopCapturer 截图 → wrapScreenshot 成 ImageBlock → 回灌 LLM 看屏幕**。零 native addon。

### 模块 P0-A：ComputerNativePort 接口（server 侧，零 electron）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| platform | app/server/src/platform/computer/native-port.ts | `ComputerPermissions` | A | `{accessibility:'granted'\|'missing', screenRecording:'granted'\|'missing'}`（从旧 types.ts 迁入） | 值域闭合两态；tool 门禁消费 | §1；spike computer-permissions-ipc.ts | +4 |
| platform | app/server/src/platform/computer/native-port.ts | `ComputerScreenshotResult` | A | `{ok:boolean, mediaType?:'image/png'\|'image/jpeg', data?:string(裸 base64 无 data:前缀), width?, height?, reason?}` | ok=false 不抛，返 reason；data 无前缀直接进 ImageBlock.source.data | §1；T1 ImageSource base64 契约 | +9 |
| platform | app/server/src/platform/computer/native-port.ts | `ComputerScreenshotOptions` | A | `{maxBytes?:number, maxSide?:number}`（截图预算，可选） | batch1 可全缺省 | — | +4 |
| platform | app/server/src/platform/computer/native-port.ts | `ComputerNativePort` | A | interface `{ checkPermissions():Promise<ComputerPermissions>; screenshot(opts?):Promise<ComputerScreenshotResult> }`；注释预留第二批 readAxTree/click/type/scroll/pressKey | **MUST** 零 electron 依赖（纯 interface）；**MUST NOT** 声明 connect/session/disconnect（去连接器语义） | 架构原则#2/#3；§1 不变量1 | +14 |
| platform | app/server/src/platform/computer/native-port.ts | `AxTreeNode`/`AppInfo`/`PixelPoint`/`ComputerTarget`/`ClickOptions`/`ComputerError` | A | 从旧 types.ts 迁入（第二批用；batch1 不消费但先落库避免二次搬迁） | 仅纯类型 + Error 类；不迁 Driver/Session/ConnectOptions | §6；旧 types.ts | +40 |
| platform | app/server/src/platform/computer/native-port-registry.ts | `setComputerNativePort(port?)` / `getComputerNativePort()` | A | process 级 holder：`let _port; set 存 / get 取`。主进程注入 seam | **MUST** 是模块单例（一个 Electron 宿主）；set 传 undefined 可清 | 架构原则#6 setX 注入；§2 | +10 |
| server | app/server/src/index.ts | `setComputerNativePort` 导出 | M | `export { setComputerNativePort } from './platform/computer/native-port-registry'` + `export type { ComputerNativePort, ComputerPermissions, ComputerScreenshotResult } from './platform/computer/native-port'` | 让 app/electron 能 import 注入 + 类型 | 现 index.ts:15 startServer 导出范式 | +2 |

### 模块 P0-B：主进程 port 实现（app/electron，唯一 import electron）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| electron | app/electron/src/computer-native-port.ts | `makeElectronComputerNativePort()` | A | 返 `ComputerNativePort` impl：`checkPermissions` 调 spike `computeGetPermissions(platform, systemPreferences)` → map `{accessibility: p.accessibility?'granted':'missing', screenRecording: p.screenRecording==='granted'?'granted':'missing'}`；`screenshot` 调 spike `computeTestScreenshot(platform, desktopCapturer)` → 剥离 `data:image/png;base64,` 前缀 → `{ok, mediaType:'image/png', data, width, height}` 或 `{ok:false, reason}` | **MUST** 复用 spike `computer-permissions-ipc.ts` 的 compute* 纯函数（不重造）；**MUST** 截图请求可用分辨率（desktopCapturer thumbnailSize 设为显示器实际尺寸，非 spike 的 640×400 测试缩略图）；electron 值 lazy require（对齐 spike 可测性） | spike computer-permissions-ipc.ts computeGetPermissions/computeTestScreenshot；§1 路径② | +45 |
| electron | app/electron/src/main.ts | 注入/loopback 分态 | M | **packaged**（`shouldStartBackend(env)`）：`await startBackend` 后 `const {setComputerNativePort}=require('@app/server'); setComputerNativePort(makeElectronComputerNativePort())`（直注入，server 在主进程内）。**dev**（else + `env.ROCKY_DEV_COMPUTER_LOOPBACK_PORT` 有值）：`startComputerLoopbackServer(env)`（开 loopback 通道供外部 bun 后端调，见 §5.5 P0-G） | **MUST** packaged 走直注入、dev 走 loopback，二者互斥（dev 不 startBackend）；**MUST** packaged 在首个请求前 set；**MUST** dev loopback 在 app.whenReady 后启（desktopCapturer 需 ready） | §2 时序；main.ts:77-85 startBackend 块；§5.5 P0-G | +7 |

### 模块 P0-C：注入链路（bootstrap → session-config，替代 connectorManager）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| platform | app/server/src/platform/computer/mock-native-port.ts | `MockComputerNativePort` + `resolveMockComputerNativePort(env)` | A | `ROCKY_TEST_COMPUTER_NATIVE_PORT==='mock'` → 读 `<DATA_DIR>/computer-mock.json` fixture（`{permissions,screenshotBase64,mediaType,width,height}`）返 port；无 fixture 用默认 granted+固定 base64 | **MUST** 零子进程/零 GUI（守 test-no-real-spawn-system-gui）；仿 ROCKY_TEST_MOCK_LLM 范式 | memory test-no-real-spawn-system-gui；§2 | +40 |
| bootstrap | app/server/src/bootstrap.ts | `computerNativePort` 解析 | M | **删** `createAndBootstrapComputerConnectorManager` import + 调用（line 48/807-808）；改三态单选 precedence `const computerNativePort = resolveMockComputerNativePort(process.env) ?? resolveLoopbackComputerNativePort(process.env) ?? getComputerNativePort()`；BootstrapResult 返回加 `computerNativePort` | **MUST NOT** 保留 computerConnectorManager；**MUST** 优先级 test-mock > dev-loopback > packaged-registry（互斥单选）；降级 undefined 不阻断启动 | 现 bootstrap.ts:48/807；§2；§5.5 P0-G | +7/-5 |
| bootstrap | app/server/src/bootstrap.ts | `BootstrapResult.computerNativePort` | M | **删** `computerConnectorManager: GenericConnectorManager<ComputerSession>` 字段（line ~166）；加 `computerNativePort?: ComputerNativePort` | 类型改 → 连带删 ComputerSession/GenericConnectorManager import | 现 bootstrap.ts:161-166 | +2/-6 |
| handlers | app/server/src/handlers/session-deps.ts | `SessionHandlerDeps.computerNativePort` | M | **删** `computerConnectorManager?: GenericConnectorManager<ComputerSession>`（line 107）+ 相关 import（ComputerSession/GenericConnectorManager）；加 `computerNativePort?: ComputerNativePort` | **MUST NOT** 残留 ComputerSession 类型引用（连带 typecheck 断） | 现 session-deps.ts:99-107 | +3/-8 |
| router | app/server/src/router.ts | sessionDeps computer 注入 | M | line 149-150 `computerConnectorManager: bs.computerConnectorManager` → `computerNativePort: bs.computerNativePort` | — | 现 router.ts:149 | +1/-1 |
| handlers | app/server/src/handlers/session-config.ts | computerNativePort 注入 | M | 注入块加 `computerNativePort: deps.computerNativePort`（仿 line 250 connectorManager） | tool 经 ctx.config.computerNativePort 读 | 现 session-config.ts:250 | +2 |
| tools | app/server/src/tools/types.ts | `ToolSessionConfigLike.computerNativePort` | M | 加 `computerNativePort?: unknown`（鸭子类型，对齐 connectorManager?:unknown line 108） | 缺省 undefined → screenshot tool fail-closed | 现 types.ts:108 | +5 |

### 模块 P0-D：screenshot tool（server 侧，走 port + 权限门禁）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools | app/server/src/tools/computer-use/permissions.ts | `PermissionRequirement` / `checkPermissionGate(req,perms)` / `formatPermissionMissing(which)` | A | requirement `{accessibility?,screenRecording?}`；gate 返任一 missing 名或 null；formatter 引导文案含「系统设置」「屏幕录制」「Rocky」关键词 | **MUST** 文案含 3 关键词（AT 断言）；纯函数无副作用 | design.md §5.2；旧 change_plan 契约2 | +25 |
| tools | app/server/src/tools/computer-use/image-block.ts | `wrapScreenshot(shot)` | A | `ComputerScreenshotResult` → `ImageBlock{type:'image', source:{kind:'base64', data: shot.data}, mediaType: shot.mediaType ?? 'image/png'}` | **MUST** 依赖 T1 ImageBlock（已 done）；data 已裸 base64 直传 | T1 message/types.ts ImageBlock；§1 路径② | +8 |
| tools | app/server/src/tools/computer-use/screenshot.ts | `screenshotTool: Tool` | A | ToolDefinition(name='screenshot', 无参 additionalProperties:false, description 后缀「(computer use)」) + run：读 `ctx.config.computerNativePort` → undefined 返 errorResult(「仅 Rocky 桌面 App 可用」) → `checkPermissions()` → `checkPermissionGate({screenRecording:true})` missing 返 errorResult(formatPermissionMissing) → `port.screenshot()` → !ok 返 errorResult(reason) → `{content:[wrapScreenshot(shot)], isError:false}` | **MUST** 走 port 不绕过；**MUST** 门禁 screenRecording；**MUST NOT** import electron/spawn | 架构原则#3 tool 独立；design.md §5.2 门禁 | +40 |
| tools | app/server/src/tools/computer-use/index.ts | `COMPUTER_USE_TOOLS: Tool[]` | A | `export const COMPUTER_USE_TOOLS = [screenshotTool]`（第一批仅 1，第二批扩） | 注册序稳定 | — | +5 |
| tools | app/server/src/tools/registry.ts | `defaultTools()` | M | import COMPUTER_USE_TOOLS + spread 进返回数组 | **MUST NOT** 双注册；保序 | 现 registry.ts defaultTools | +3 |
| agent | app/server/src/agent/tool-policy.ts | `TOOL_POLICY['playground-rocky'].bound` | M | 加 `'screenshot'`（第一批仅 playground）；更新计数注释 | **MUST NOT** 加 subagent（控 OS 风险）；leader/mate 第二批补 | 现 tool-policy.ts playground bound；design.md §8 | +2 |

### 模块 P0-E：ImageBlock 接上确认（T1 已做）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm | app/server/src/llm/protocol-encode.ts | encodeContentBlock case image | — | **无改动，验证**：wrapScreenshot 产 spec 形 ImageBlock（source.kind='base64'），encode 已翻译 base64→wire `{type:'base64',media_type,data}` | 禁改 T1 已 done 逻辑 | T1；现 protocol-encode.ts | 0 |

### 模块 P0-F：测试基建（mock port + mock-llm 剧本）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | tests/api/env_start.sh | `ROCKY_TEST_COMPUTER_NATIVE_PORT=mock` | M | 加 env（替旧 ROCKY_TEST_COMPUTER_DRIVER）；写 `<DATA_DIR>/computer-mock.json` fixture | AT 依赖 | §2 AT 态；memory test-mock-llm-default-on 范式 | +3 |
| test | app/server/src/mock-llm-scenarios.ts + mock-llm.ts | screenshot 剧本 | M | MOCK_LLM=1 扫 last user `@@cu:screenshot@@` → turn1 出 `screenshot` tool_call（无参）+ turn2 收 tool_result 后 end_turn | 仿 buildToolScenario | 旧 change_plan 钩子3（简化单工具） | +15 |

> **AT 处置**：旧 8 个打 HTTP 端点的 AT case 全废（端点不存在）。第一批 AT 改测 **screenshot tool 直调 mock native port**：① mock-llm 触发 screenshot tool_call → tool 走 mock port → 断言 ToolResultBlock 含 ImageBlock（base64 落地正确）；② mock port 权限 missing → 断言 failed + 3 关键词引导。**具体 case 由 test-designer 阶段处理**（本表仅定基建钩子）。

### 模块 P0-G：dev 截图 loopback 通道（让 dev 模式 agent 截图走通到主进程 desktopCapturer）

> **用户硬要求（覆盖旧 §254）**：agent 截图必须 **dev 模式（`run-dev.sh`）就能验证**，不接受「必须打包 Rocky.app 才能验」。本模块给出 dev 可验方案。

**根因**：dev 三进程 = ① Electron 主进程（`main.ts`，`shouldStartBackend=false` 不起后端，但仍建 BrowserWindow + 注册 computer IPC + **持有 desktopCapturer**）② 独立 bun 后端（`dev.env` `API_START_CMD="bun run app/server/src/index.ts"`，**agent 工具在此进程跑**）③ vite dev server（proxy `/session` 等 → bun 后端）。UI 截图能 dev 验是因渲染进程 + 主进程都在 Electron 内（`window.rockyComputer` IPC）；agent 截图走 bun 后端进程，**够不到主进程 desktopCapturer** —— 这才是根因。

**方案抉择：推荐选项 D（loopback 通道），否决选项 A（后端进主进程）。**

| 维度 | 选项 A（dev 后端也进 Electron 主进程） | 选项 D（dev 后端保持 bun 独立，加 loopback 通道）✅ |
|---|---|---|
| dev 后端运行时 | bun→**Electron Node**（TS 不能直跑，需编译 dist 或 TS loader） | **bun 不变**（TS-direct，零编译步） |
| dev 后端热重载/迭代 | 后端重启**焊死**在整个 Electron 重启上；失去隔离快重启 + `bun --watch` 可能性 | **完全不变**（独立进程，可 `bun --watch` 自动重启、可单独 kill 重启，秒级 TS-direct） |
| 与 test env 一致性 | dev 用 Electron-Node 后端、test 用 bun 后端 → **进程模型分裂** | dev/test 都是 bun 独立后端 → **一致** |
| native port 实现数 | 1 份（直调 desktopCapturer） | 2 份薄适配（dev=fetch 通道 / packaged=直调），但底层同一 `makeElectronComputerNativePort()`（compute\* 单一源，无逻辑重复） |
| 主进程新端点 | 无 | 有（dev-only loopback，127.0.0.1 + token） |
| dev 验证保真度 | dev==packaged（同进程直调） | 通道跨进程走 base64 over HTTP，**比直调更贴近真实序列化路径**（能抓图像编码 bug）；底层 desktopCapturer 调用完全相同 |

**推荐 D 的决定性理由**：用户约束「**优先保 dev 后端热重载体验**」。dev 后端是 **bun 独立进程跑 TS-direct** —— 这是核心 DX 资产（零编译步 + 隔离快重启 + 可加 `bun --watch` + 与 test env 同进程模型）。选项 A 把后端焊进 Electron 主进程，**三重回退**：① 运行时 bun→Electron-Node（TS 需编译）② 后端重启焊死 Electron 重启（失去隔离）③ dev 与 test env 进程模型分裂。选项 D 对 bun 后端进程模型**零改动**，用一个 dev-only loopback 薄通道把「bun 后端 → 主进程 desktopCapturer」的最后一跳桥起来。两份 port 实现的分歧**仅在传输层**（in-process 直调 vs fetch），底层截图逻辑（`makeElectronComputerNativePort` → `computeTestScreenshot`）完全同源。

**通道形态**：Electron 主进程（dev）额外起一个极小 `node:http` loopback server（bind `127.0.0.1:ROCKY_DEV_COMPUTER_LOOPBACK_PORT`），handler 内部复用 `makeElectronComputerNativePort()` 实例，`GET /permissions` → `port.checkPermissions()`、`POST /screenshot` → `port.screenshot(body)` JSON 返；bun 后端的 dev port 实现 `LoopbackComputerNativePort` 纯 fetch 调它。方向 = 主进程暴露给后端（dev-only 权宜），token header 防同机其他进程误撞截图端点。

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| platform | app/server/src/platform/computer/loopback-native-port.ts | `LoopbackComputerNativePort` | A | class implements `ComputerNativePort`：ctor(baseUrl,token)；`checkPermissions()` = `fetch(baseUrl+'/permissions',{headers:{'x-rocky-dev-token':token}})`→json→map 到 ComputerPermissions；`screenshot(opts)` = `fetch(baseUrl+'/screenshot',{method:'POST',headers,body:JSON.stringify(opts??{})})`→json→ComputerScreenshotResult；fetch 抛 → `screenshot` 返 `{ok:false,reason}`、`checkPermissions` 返双 missing（fail-closed 不崩） | **MUST** 零 electron（纯 fetch，undici/global fetch）；**MUST NOT** import electron；**MUST** fetch 异常 fail-closed 不抛穿 tool | §1 不变量1；P0-A ComputerNativePort；用户约束「server 零 electron」 | +42 |
| platform | app/server/src/platform/computer/loopback-native-port.ts | `resolveLoopbackComputerNativePort(env)` | A | `env.ROCKY_DEV_COMPUTER_LOOPBACK_PORT` 有值 → `new LoopbackComputerNativePort('http://127.0.0.1:'+port, env.ROCKY_DEV_COMPUTER_LOOPBACK_TOKEN ?? '')`；否则 undefined | **MUST** 仅认 `ROCKY_DEV_COMPUTER_LOOPBACK_PORT`（仅 dev.env 设）；bootstrap 中优先级低于 test-mock（mock 先解析） | §2；仿 resolveMockComputerNativePort（P0-C） | +8 |
| electron | app/electron/src/computer-loopback-server.ts | `startComputerLoopbackServer(env)` | A | `node:http` server bind `127.0.0.1:env.ROCKY_DEV_COMPUTER_LOOPBACK_PORT`；内部 `const port = makeElectronComputerNativePort()`；路由 `GET /permissions`→`port.checkPermissions()`、`POST /screenshot`（读 body opts）→`port.screenshot(opts)`，JSON 序列化返；每请求先校验 `x-rocky-dev-token` header == `env.ROCKY_DEV_COMPUTER_LOOPBACK_TOKEN`（缺/错→403）；异常→500+{ok:false,reason} | **MUST** 仅 `127.0.0.1` bind + token 校验；**MUST** 复用 `makeElectronComputerNativePort()`（P0-B，不重造截图/权限逻辑）；**MUST** 仅 dev 启（main.ts else 分支调）；**MUST NOT** 进 packaged 路径 | P0-B makeElectronComputerNativePort；§5.5 决策；http-server.ts node:http 范式 | +55 |
| env | dev.env + dev.env.example | `ROCKY_DEV_COMPUTER_LOOPBACK_PORT` / `ROCKY_DEV_COMPUTER_LOOPBACK_TOKEN` | M | dev.env 加两键（port 如 `3719`；token 任意 dev 字符串）；`run-dev.sh` `set -a . ./dev.env` 已导出 → **Electron 主进程 + bun 后端均继承**（同一份 env，port/token 天然对齐） | **MUST** 仅 dev.env 设（prod.env 不设 → packaged 走 registry 直调）；**MUST NOT** 把真 token 入库（dev.env.example 给占位注释） | §2；run-dev.sh:30-32 set -a | +2 |
| scripts | scripts/run-dev.sh | 端口预清理列表 | M | 第 45 行 `for p in "$API_PORT" "$WEB_PORT"` 加 `"${ROCKY_DEV_COMPUTER_LOOPBACK_PORT:-}"`（清上次残留 loopback 端口）；空值 for 循环安全跳过 | 仅 dev 调试便利；无则依赖 OS 端口回收 | run-dev.sh:44-47 | +1 |

**dev 工作流影响说明（run-dev.sh / vite proxy / dev.env / backend-bootstrap）**：
- **`run-dev.sh`**：三进程编排**不变**（server bun + web vite + electron 顺序不动）。仅第 45 行端口预清理列表加 loopback 端口（minor）。`set -a . ./dev.env` 已让新增两键自动导出给两个子进程，无需额外传参。
- **`dev.env`**：新增 `ROCKY_DEV_COMPUTER_LOOPBACK_PORT` + `ROCKY_DEV_COMPUTER_LOOPBACK_TOKEN` 两键（dev.env.example 同步给占位）。**这是激活 dev 通道的唯一开关**：设了才走 loopback，没设则 dev 截图仍降级「仅桌面 App 可用」（向后兼容）。
- **vite proxy（`vite.config.ts`）**：**零改动**。loopback 通道是「bun 后端 ↔ Electron 主进程」的后端间通信，**不经渲染层**；渲染进程/vite 完全不知情。（对比：若走渲染层 IPC 中转才需动 vite，D 方案不走那条路。）
- **`backend-bootstrap.ts`**：**零改动**。`shouldStartBackend(env)` 逻辑不变（dev=false）；D 方案不让 dev 后端进主进程，故不碰 startBackend 判定。dev 通道的启动在 `main.ts` 的 else 分支（`!shouldStartBackend`），与 backend-bootstrap 解耦。
- **AT/ET（`env_start.sh`）**：**零影响**。env_start 设 `ROCKY_TEST_COMPUTER_NATIVE_PORT=mock`，bootstrap precedence 中 mock 优先级最高（先于 loopback 解析），永不触通道；且 env_start 不设 `ROCKY_DEV_COMPUTER_LOOPBACK_PORT`，loopback 解析返 undefined，双保险。
- **packaged**：**零影响**。prod.env 不设 loopback 键 → bootstrap 走 `getComputerNativePort()`（registry，main.ts packaged 分支直注入 `makeElectronComputerNativePort()`），与 v2 §1 已定路径完全一致。

---

## 6. 第二批「native addon」方向 + 技术选型（结论 + 理由，非 method 级）

> **method 级 change_plan 已产出**：见 `change_plan_v2_batch2.md`（B2.1 架构增量 + B2.2 编译链 + B2.3 分级 spike + B2.4 P1-A~G method 表 + B2.5 风险 + B2.7 符号核对）。本节保留方向/选型结论。

**目标**：AX 树读取 + CGEvent 键鼠输入（click/type/scroll/pressKey），native addon 跑主进程内共享 Rocky TCC 身份。扩 `ComputerNativePort`：`readAxTree()` / `click()` / `type()` / `scroll()` / `pressKey()`。electron impl 在 `computer-native-port.ts` 内调 addon。

**三路评估**：

| 方案 | 描述 | 优 | 劣 | 结论 |
|---|---|---|---|---|
| ① **Swift 编译 dylib + N-API 桥**（推荐） | 复用 iFurySt/T2 Swift 成果（InputSimulation/AccessibilitySnapshot/KeyMapping）编译成 dylib，薄 C++ N-API addon 或 `@napi-rs` 桥暴露给 Node | 直接复用已逆向的 CGEvent postToPid + AX 语义动作链 + xdotool 键映射（省数百行重写）；Swift 天然处理 CFType 引用计数（ARC），**无 FFI 引用计数地狱**；ScreenCaptureKit/AX 高层 API Swift 原生 | 需 Swift↔C↔N-API 两层桥（@_cdecl 导出 C ABI）；打包需 dylib 进 electron-builder + codesign | **✅ 推荐** |
| ② C++ N-API addon 直调 ApplicationServices/CoreGraphics | node-gyp/node-addon-api 直接 C++ 调 AXUIElement*/CGEvent | 单一语言桥（C++→N-API）；无 Swift 依赖 | 全部 AX/CGEvent 逻辑用 C++ 重写（iFurySt 成果作废）；CFType 手动 CFRetain/CFRelease 易泄漏；开发量最大 | 备选（若拒 Swift toolchain 依赖） |
| ③ koffi/现代 FFI 直调 framework | koffi 从 Node 直接 dlopen ApplicationServices | 无编译步骤 | **AX API 的 CFType 引用计数在 FFI 下是地狱**（调研已警告 Bun:ffi 调 AX=FFI 地狱）；CGEvent 结构体传递 + 回调易崩；生产不可靠 | **❌ 否决** |

**推荐 ①（Swift dylib + N-API 桥）**，理由：
1. **复用逆向成果**：T2 的 `InputSimulation.swift`（postToPid 后台输入，iFurySt 核心创新——**不抢前台、不需 Input Monitoring**）+ `AccessibilitySnapshot.swift`（AX 树 + 语义动作链）+ `KeyMapping.swift`（xdotool→virtualKey）已是可编译的 Swift 逻辑，dylib 化即用，避免 C++ 重写。
2. **规避 FFI 引用计数地狱**：AX API 大量返回 `CFTypeRef`（AXUIElementRef 等），需精确 CFRetain/CFRelease。Swift ARC 自动管理；③ FFI 手动管理必崩。这是否决 ③、不选 ② 手写 C++ 的关键。
3. **TCC 身份共享**：addon 是主进程加载的动态库，**继承 Rocky 主进程 TCC 身份**（铁律满足，与 spawn 子进程本质区别）。
4. **postToPid 保留**：iFurySt 核心 = `CGEvent.postToPid(pid)` 定向后台输入（不走全局 event tap → 不需 `kTCCServiceListenEvent` Input Monitoring）。dylib 内保留此路径，仅 `kTCCServiceAccessibility` 一权限即可键鼠。

**关键工程点（第二批立项时细化）**：
- **桥接**：Swift `@_cdecl` 导出 C ABI 函数 → C++ node-addon-api 薄封装（或 `@napi-rs/cli` Rust 桥，但 Rust↔Swift 又多一层，仍推 C++ 薄桥）。截图仍走 Electron desktopCapturer（batch1 已验证，addon 只补 AX+输入）。
- **打包**：dylib 进 `electron-builder` extraResources + `codesign`（Rocky.app 签名覆盖）；`node-gyp` 预编译 arm64/x64 双架构 或 CI 产物。**禁** runtime 依赖用户装 Swift toolchain。
- **权限**：AX+输入仅需 Accessibility（systemPreferences.isTrustedAccessibilityClient 已在 spike 查询）；无需 Screen Recording（截图归 batch1 desktopCapturer）。
- **坐标**：复用 `coords.ts`（保留素材）pixel→window→global 换算喂 CGEvent。

---

## 7. spec 处置（doc-sync 待办，doc-modifier 阶段5）

> 架构师本次只出 change_plan v2；旧 tech/api spec 描述 spawn helper + connector，pivot 后需重写。列清单供 doc-modifier 统一改。

| spec 文件 | 处置 |
|---|---|
| `specs/tech/agent/platform/[P1]computer_driver.md` | **重写** → `[P1]computer_native_capability.md`：ComputerNativePort 接口 + 注入链路 + 主进程实现，删 spawn/IPC/bundle 全部内容 |
| `specs/tech/agent/tools/[P1]computer_use_tool.md` | **重写**：单 `computer` tool + `action` dispatch（screenshot/read_ax_tree/click/type/scroll/key 是同一 tool 的不同 action，非多独立 tool；扁平 action-discriminated schema + 按 action 权限门禁 + tool→action→port method 映射；走 port + 门禁），删 7 工具/connector-resolver/owner。详见 change_plan_v2_batch2.md B2.8 |
| `specs/tech/config/[P1]connectors.md` | **回退**：删 computer 第 2 连接器全部内容（§1/§3.1/§3.2.2/§5.2/§8），回 browser-only |
| `specs/api/overall/18-computer-use.md` | **废弃**：无 HTTP 端点（前端走 Electron IPC）；mv 或标废 |
| `specs/ui/overall/05-connectors.md` + `specs/ui/components/connector-page/section-computer-connector.md` | **对齐 spike**：权限引导 + 测试截图形态，删 6 态连接状态机 |
| `specs/tech/agent/message/[P0]agent_message_interface.md` §4.2 ImageBlock | **保留**（T1 已对） |
| 各子系统 log.md（platform/tools/config） | 追加 v0.0.105 pivot 块 |

---

## 8. 核对总览（architect 自检 — 引用符号存在性）

| 引用 | 状态 | 备注 |
|---|---|---|
| `message/types.ts ImageBlock/ImageSource` | ✓ T1 已 done | source.kind='base64' 裸 base64；wrapScreenshot 直消费 |
| `protocol-encode.ts case image` | ✓ T1 已 done | 翻译 base64→wire |
| spike `computeGetPermissions`/`computeTestScreenshot`（computer-permissions-ipc.ts） | ✓ 现有 | electron port impl 复用 |
| spike `ComputerPermissions{platform,supported,accessibility:bool,screenRecording:status}` / `ScreenshotResult{ok,dataUrl}` | ✓ 现有 | 与 port 形状不同（UI 路径 vs tool 路径），port impl 内做形状适配 |
| `startBackend`（backend-bootstrap.ts）/ `main.ts` startBackend 块（:77-85） | ✓ 现有 | 注入 seam 落点 |
| `@app/server index.ts` 导出范式（startServer :15） | ✓ 现有 | 加 setComputerNativePort 导出 |
| `bootstrap.ts` computerConnectorManager（:48 import / :807 调 / :161-166 字段） | ✓ 现有（T3 加） | **删并换** computerNativePort |
| `router.ts` computerConnectorManager 注入（:149-150） | ✓ 现有（T3 加） | 换 computerNativePort |
| `session-deps.ts` computerConnectorManager（:99-107 + ComputerSession import） | ✓ 现有（T3 加） | 换 computerNativePort，删 ComputerSession import |
| `session-config.ts` connectorManager 注入（:250） | ✓ 现有 | 仿加 computerNativePort |
| `connector/types.ts` computer 位（:13 import / :16 ConnectorId / :44 permissions / :53 permission_missing） | ✓ 现有（T3 加） | **回退**（依赖将废的 platform/computer/types，不删 typecheck 断） |
| `tools/types.ts ToolSessionConfigLike.connectorManager`（:108 unknown） | ✓ 现有 | 仿加 computerNativePort?:unknown |
| `tools/registry.ts defaultTools()` | ✓ 现有 | spread COMPUTER_USE_TOOLS |
| `tool-policy.ts TOOL_POLICY['playground-rocky'].bound` | ✓ 现有 | 加 'screenshot' |
| `handlers/connector.ts VALID_CONNECTOR_IDS` | ✓ 现有 `['browser']`（T5 未编码） | **无需改** |
| `T2 platform/computer/{types,coords,mock,swift-helper Sources}` | ✓ 现有 | 按 §4 改造/移植/废弃 |
| `run-dev.sh` `set -a . ./dev.env`（:30-32） | ✓ 现有 | 新增 loopback 两键自动导出给 Electron 主进程 + bun 后端（P0-G） |
| `run-dev.sh` 端口预清理 for 循环（:44-47） | ✓ 现有 | 加 loopback 端口清理（P0-G） |
| `http-server.ts` node:http `startServer`（:118） | ✓ 现有 | loopback server 复用同 `node:http` 范式（另起极小 server，不复用 startServer） | 
| `makeElectronComputerNativePort()`（P0-B 新增） | 本版新增 | loopback server 内部复用它（单一截图/权限逻辑源，dev/packaged 同源） |
| `shouldStartBackend(env)`（backend-bootstrap.ts :48） | ✓ 现有 | dev=false 不变；loopback 启动在 main.ts `!shouldStartBackend` else 分支，不碰此函数 |

---

## 9. 与用户 pivot 方向的调整建议（architect）

1. **注入用 registry setter 而非 startServer opts 透传** —— 见 §2 注解，避免污染 `handleRequest(dataDir)` 全局纯函数签名。若用户偏好显式透传，可加 `StartServerOptions.computerNativePort` 但仍需 registry 承接（bootstrap 懒建 + per-dataDir 缓存），透传收益低。**建议采纳 setter。**
2. **dev 模式 agent 截图 dev 可验（走 D 方案 loopback 通道，覆盖旧「须打包」结论）** —— 用户硬要求：agent 截图必须 `run-dev.sh` dev 模式就能验，不接受「必须打包 Rocky.app 才能验」。根因是 dev 后端是独立 bun 进程够不到主进程 desktopCapturer（非「dev 不支持」）。**解法（§5.5 P0-G）**：Electron 主进程（dev 也常驻）额外开一个 `127.0.0.1` loopback 通道暴露 screenshot/permissions，bun 后端的 dev port 实现纯 fetch 走通道到主进程 desktopCapturer → 完整闭环（截图→base64→ImageBlock→回灌 LLM）**dev 可验**。dev Electron 的 TCC 身份是 Electron.app（spike 已真机验证 dev 可截图），够验闭环功能；packaged 才是 `com.rocky.agent` 身份（路径不变，v2 §1 已定，直调 desktopCapturer 不走通道）。UI 权限面板（window.rockyComputer）dev 本就可用，不变。**推荐 D 不选 A（后端进主进程）**：A 会让 dev 后端 bun→Electron-Node（TS 需编译）+ 重启焊死 Electron + 与 test env 进程模型分裂，违反用户「优先保 dev 后端热重载体验」约束（详见 §5.5 决策表）。
3. **screenshot 分辨率** —— spike `computeTestScreenshot` 用 640×400 缩略图（仅证明能截）。agent 用需可用分辨率：port impl 的 screenshot 应把 desktopCapturer `thumbnailSize` 设为显示器实际尺寸（§5 P0-B 已列 MUST）。**建议第一批就做全分辨率**，否则 LLM 看不清屏幕内容闭环无意义。
4. **单 tool `screenshot` vs `get_app_state`** —— 第一批只截图（无 AX），故独立 `screenshot` tool 足够；第二批 AX 就绪后再引入 `get_app_state`（截图+AX 聚合）。第一批不做聚合，命名 `screenshot` 清晰。**建议采纳。**
5. **旧 T2 `.build/` 构建产物** —— `swift-helper/.build/`（数十 MB 编译缓存）应从版本控制清理（不是 soft-delete，是构建垃圾）；`Sources/*.swift` 移植素材保留。
