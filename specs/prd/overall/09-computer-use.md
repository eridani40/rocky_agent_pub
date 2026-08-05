# Computer Use — agent 控制 macOS [v0.0.105]

> version: 2.0 · 引入版本 v0.0.105 · 最后更新：2026-07-10
> 权威设计输入：`reqs/[working] v0.0.105.computer_use/design.md`（用户已确认 2026-07-10）
> 综合调研：`specs/research/v0.0.105-computer-use.md` + 4 份子调研（e2b / iFurySt open-codex / openclaw / project-tool-system）
> 增量记录：`specs/prd/version_logs/v0.0.105.computer_use.md`

> ## ⚠ 架构 pivot 更新（实现与本 PRD 原设计有重大差异，2026-07-10）
>
> 本 PRD 原设计（下文 §1-§5 大部）描述「spawn Swift helper + computer 作连接器 + ~9 独立工具 + owner 锁 lazy connect」，实现时经历 **pivot**（真机 dogfood：裸 spawn 子进程拿不到 macOS TCC 权限）。**产品意图不变**（agent 看屏幕 + 操作键鼠 + 权限门禁 + 截图回灌 LLM），但**实现形态变了**，以下为**现状权威**（下文旧描述仅存历史，读时以此为准）：
>
> | 维度 | PRD 原设计（旧，下文） | **现状（权威）** | 权威 spec |
> |---|---|---|---|
> | 工具形态 | ~9 独立工具 + disconnect | **单 `computer` tool + 11 action**（对齐 open-codex） | `tech/agent/tools/[P1]computer_use_tool.md` |
> | OS 抽象 | spawn Swift helper + JSON IPC session | **主进程注入 `ComputerNativePort` + native addon**（Swift dylib + N-API，继承 Rocky TCC 身份） | `tech/agent/platform/[P1]computer_native_capability.md` |
> | 连接治理 | computer 作第 2 连接器 + owner 锁 + lazy connect + disconnect | **去连接器语义**（本机主进程常驻能力，无 toggle/owner/connect-disconnect） | `tech/config/[P1]connectors.md`（回退 browser-only） |
> | 连接器页 computer tab | toggle + 6 态连接矩阵 + 权限面板 | **权限引导卡片**（权限两行 + 引导按钮 + 测试截图，走 Electron IPC） | `ui/overall/05-connectors.md §3.2` |
> | 权限门禁 | 每 action 前 + owner 锁前置 permission_missing | 每 action 前按 ACTION_PERMS 查 `port.checkPermissions()`（无连接前置） | `computer_use_tool.md §3.3` |
> | HTTP 端点 | `GET /connector/computer/permissions` | **无公共端点**（agent 走 tool→port，UI 走 IPC，dev loopback 通道） | `api/overall/18-computer-use.md` |
>
> 保留有效：ImageBlock 全链路打通（§2.5）、macOS only、不接 Anthropic 原生 beta（自定义 schema）、能力 1:1 对齐 open-codex（含 P1 的 perform_secondary_action/set_value/drag，本版本已全落）、listApps 仅运行态 app（已装/近期 app 待未来 mdfind）。跨版本发布说明 → `specs/tech/version_logs/v0.0.105/change_log.md`。

## 0. 概念先行（MANDATORY）

**PRD 已读并对齐的已有概念权威源**：
- tech：`specs/tech/config/[P1]connectors.md`（连接器双状态机 + ConnectorManager + lazy connect + owner 锁 + 门禁分层）；`specs/tech/agent/tools/[P1]browser_tool.md`（BrowserDriver/BrowserSession 抽象范式 + 子进程 + 三流分离）；`specs/tech/agent/tools/index.md`（工具系统：串行执行 + policy bound + HITL interaction 钩子）；`specs/tech/agent/message/[P0]agent_message_interface.md` §4.2 ImageBlock + ToolResultBlock.content（ImageBlock 协议层已声明）；`specs/tech/agent/tools/[P0]tool_policy.md`（TOOL_POLICY bound 五角色）
- ui：`specs/ui/overall/05-connectors.md`（连接器页 testid 树 + 双状态映射 + `connector-tabs` 预埋多 tab）；`specs/ui/components/connector-page/{page-connector.md, section-browser-connector.md}`（page/card/toggle/status/guide 组件 spec + testid 约定）；`specs/ui/overall/03-config-center.md`（设置入口三合一 + nav 底部「连接器」入口）

**本版本引入的新概念（需 architect 在架构期落 tech/ui spec，本 PRD 不擅自发明实现细节）**：

> 下表为架构期原设计落点；实现 pivot 后多项变更（工具形态 / OS 抽象 / 连接治理），以顶部「架构 pivot 更新」表 + 各权威 tech spec 为准。

| 新概念 | 落点 | 说明 |
|---|---|---|
| computer_use 工具集（~9 独立工具） | `specs/tech/agent/tools/[P1]computer_use_tool.md`（新建） | 每个独立 ToolDefinition + run（非聚合），custom schema（不接 Anthropic 原生 beta，D4） |
| ComputerDriver / ComputerSession 接口 | `specs/tech/agent/platform/`（新建 OKF KB） | 仿 BrowserDriver/BrowserSession；macOS 首发；linux/windows 仅签名 |
| Swift helper binary | 同上 KB | CGEvent.postToPid + ScreenCaptureKit + AXUIElement；TS 经 subprocess + JSON IPC 驱动 |
| computer connector（第 2 connector 类型） | 扩 `specs/tech/config/[P1]connectors.md` | `ConnectorState.id` 加 `'computer'`；双状态机复用 + 多一层系统权限态 |
| ComputerConnectorManager（owner 锁 + 权限门禁 + lazy） | 同上 | 仿 browser ConnectorManager；门禁含 `permission_missing` 态 |
| computer-connector-card（含权限面板） | `specs/ui/components/connector-page/section-computer-connector.md`（新建） | 仿 section-browser-connector；新增权限面板组件 |
| 运行时权限门禁（tool 层） | computer_use_tool.md | 每 action 执行前按所需权限预检，缺→ToolRunResult failed + 引导 |
| ImageBlock 全链路打通 | 扩 `specs/tech/agent/message/[P0]agent_message_interface.md` + log | ContentBlock union + 序列化 + assemble + 前端渲染（P0 前置） |

---

## 1. 产品定位

**是什么**：computer use 工具让 agent 能**看到 macOS 屏幕 + 操作键鼠**——通过截图回灌 LLM 决策 + AX/坐标双路定位 + CGEvent 后台键鼠注入。

**解决什么**：browser 工具只能控制 chrome 进程（web 页面内）；当用户需求超出 web（操作原生 app、跨 app 拖拽、系统对话框、Finder/Mail/Notes 等非 web UI），browser 无能为力。computer use 把 agent 的控制边界从「chrome tab」扩到「整个 macOS 桌面」。

**与 browser connector 的关系（并列、非替代）**：

| 维度 | browser connector | computer connector |
|---|---|---|
| 控制边界 | chrome 进程内（一个浏览器 tab） | 整个 macOS 桌面（所有 app + 系统） |
| 驱动模型 | a11y tree + element ref（CDP） | AX tree + 截图像素坐标（postToPid + AX） |
| 截图角色 | 辅助（vision 校验） | **主交互通道**（每 turn 开头截图回灌 LLM） |
| 连接器状态机 | 双状态（switch + connection） | 双状态 + **多一层系统权限态**（Accessibility + Screen Recording） |
| connector id | `'browser'` | `'computer'`（ConnectorState[] 第 2 项） |
| nav 入口 | 连接器页第 1 tab | 连接器页第 2 tab（`connector-tab-computer`） |

**与 browser tool §6 已锁决策的关系**：browser_tool.md §8「截图+坐标（computer-use 路线）本版本不支持（P2 再说）」——本版本（v0.0.105=P2 兑现）正式引入，但作为**独立 connector + 独立工具集**，不并入 browser tool。

---

## 2. 功能需求

### 2.1 computer_use 工具集（~9 独立工具 + disconnect）[v0.0.105] [P0]

**描述**：以 iFurySt open-codex 为蓝本，computer control 能力暴露为**一组独立工具**（非聚合 computer tool，D2 锁定），每个独立 ToolDefinition schema 简洁、policy 可单独 bound。**不接 Anthropic 原生 beta**（D4），用自定义 schema 跨协议（anthropic_messages / openai-compat / minimax）一致。

**优先级**：P0（含 disconnect）、P1（perform_secondary_action / set_value / drag 等扩展项可视实现进度后置）

**用户故事**：作为对话中的 agent，我希望调一个独立工具（如 `click`）即可点击屏幕某元素，工具内部完成权限预检 + 坐标换算 + Swift helper IPC + 结果包装——LLM 不感知 OS 细节。

**action 清单（对齐 design.md §2）**：

| 工具 | 必填参数 | 可选参数 | 所需 macOS 权限 | P |
|---|---|---|---|---|
| `list_apps` | — | — | Accessibility | P0 |
| `get_app_state` | — | app?, textLimit?(500), maxTreeNodes?(1200), maxTreeDepth?(64) | **Screen Recording + Accessibility** | P0（每 turn 开头调，返 key window 截图 + AX tree 含 element_index） |
| `click` | element_index 或 coordinate | button?(left/right/middle), clickCount?(1/2/3) | Accessibility | P0 |
| `perform_secondary_action` | element_index 或 coordinate | — | Accessibility | P1 |
| `scroll` | coordinate, direction(up/down/left/right) | pages?(1) | Accessibility | P0 |
| `drag` | from, to | steps?(10) | Accessibility | P1 |
| `type_text` | text | coordinate?, chunkSize?(64), delayMs?(12) | Accessibility | P0 |
| `press_key` | key(xdotool 语法) | coordinate? | Accessibility | P0 |
| `set_value` | element_index, value | — | Accessibility | P1 |
| `disconnect` | — | — | —（释放 owner 锁） | P0 |

**grounding 策略（D3）**：AX `element_index` 优先 + 坐标兜底。坐标系=绝对像素（截图像素）+ Retina scale 链（`screenshotPixelSize/windowBounds = scale(≈2.0)` → `pixel/scale = windowPoint` → `+windowBounds.origin = globalPoint`）。截图不单独成 tool——`get_app_state` 返回 key window 截图 + AX tree。

**OS 抽象层（D1+D2+req 问2）**：`ComputerDriver` / `ComputerSession` 一套接口 + 每 OS 一实现（macOS 首发，linux/windows 仅签名）。三层切分（工具层 / Driver 层 / 连接治理层），详 tech spec（架构期落）。

**E2E/AT Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-2.1.1 | agent 调 `get_app_state`（无 app） | 返当前 key window 截图（image block）+ AX tree（含 element_index）；ToolRunResult.content 含 image |
| UC-2.1.2 | agent 调 `click({element_index:N})` | AX 定位元素 → postToPid click；返回成功文本 |
| UC-2.1.3 | agent 调 `click({coordinate:{x,y}})` | 像素坐标经 Retina scale 链换算为 globalPoint → click；返回成功 |
| UC-2.1.4 | agent 调 `type_text({text:'hello'})` | Unicode chunking（extended grapheme cluster）→ postToPid type；返回成功 |
| UC-2.1.5 | agent 调 `disconnect` | owner 锁释放；后续其他 session 可抢；返回成功（idempotent） |

### 2.2 computer 作为连接器页第 2 tab [v0.0.105] [P0]

**描述**：现有 `connector-tabs`（v0.0.23 预埋多 tab，目前仅 browser）落地第 2 tab——`connector-tab-computer`。`connectors: ConnectorState[]` 加 `'computer'` 项，`onToggle` id 类型扩 `'browser' | 'computer'`。computer 复用 browser 双状态机（switch + connection）+ **多一层系统权限态**。

**优先级**：P0

**用户故事**：作为用户，我希望在熟悉的「连接器」页一键启用/停用「computer」能力——与 browser 并列，不新增 nav 入口（沿用 nav 底部 `nav-connector`）。

**期望行为**：
- 进入连接器页 → tab 栏现有「浏览器」+ 新增「computer」（testid `connector-tab-computer`），默认仍选中 browser。
- 切到 computer tab → 主区显 `section-computer-connector`（含 `computer-connector-card` + 权限面板，见 §2.3）。
- computer 的 switch=off → 显「未启用」（灰），同 browser 初始态。
- computer 的 switch=on + permission missing → 显「需要系统权限」（橙）+ 阻止连接（不变量）。
- computer 的 switch=on + permission granted + connection=disconnected → 显「已启用（未连接）」（灰），等 LLM 首次 computer use 工具调用 lazy connect。
- lazy connect / owner 锁 / disconnect 语义**完全复用** browser connector（`[P1]connectors.md` §3.2/§5）——computer ConnectorManager 仿 browser，门禁多一层 `permission_missing`。

**对齐 ui spec（MANDATORY）**：computer-connector-card 视觉/结构仿 `section-browser-connector.md`；权限面板是新组件，需 architect 落 `specs/ui/components/connector-page/section-computer-connector.md` + `computer-connector-permissions.md`（权限面板独立 spec）。testid 命名沿用前缀约定（`computer-connector-toggle-on/off`、`computer-connector-status`、`computer-connector-permissions` 等）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-2.2.1 | nav 底部「连接器」→ 看 tab 栏 | browser tab + computer tab 两 tab 可见；默认选中 browser |
| UC-2.2.2 | 点 `connector-tab-computer` → 主区切到 computer | 渲染 `computer-connector-card`（含名称「computer」+ 描述 + toggle + status + 权限面板） |
| UC-2.2.3 | switch=off 时点 toggle on | 立即 `switch=on`；若 permission missing → status「需要系统权限」（橙）+ 阻止连接；不进 connecting |
| UC-2.2.4 | switch=on + permission granted + connection=disconnected 时点 toggle off | driver.disconnect（若曾 lazy connect）+ 收敛到 switch=off / disconnected |

### 2.3 权限双重防线（UI 主动监测 + 运行时硬门禁）[v0.0.105] [P0]

**macOS 权限 2 类**：Accessibility（键鼠 + AX）+ Screen Recording（截图）。不需 Input Monitoring（postToPid 关键优势）。

**优先级**：P0（两防线都是验收门槛）

#### 2.3.1 UI 主动监测（computer-connector-card 内权限面板）

**描述**：权限面板（testid `computer-connector-permissions`）两行：`accessibility` + `screen-recording`，每行 ✓绿已授权 / ✗红未授权 + 「去授权」按钮（仅 missing 显示，预留固定空间防位移）。

**三重动态监测**：
1. app/window 重新获焦时立即重检（用户从系统设置授权完回来）
2. computer tab 打开且 switch=on 时每 ~3s 轮询
3. 手动「重新检测」按钮（testid `computer-permissions-recheck`）

**后端契约**：`GET /connector/computer/permissions` → Swift helper 预检（TCC.db `auth_value==2` + `AXIsProcessTrusted()` + `CGPreflightScreenCaptureAccess()` 合并）→ `{accessibility: 'granted'|'missing', screenRecording: 'granted'|'missing'}`。

**授权引导**：点「去授权」→ 深链系统设置（`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` / `Privacy_ScreenCapture`）→ 文案「找到『Rocky Computer Use』打开开关 + 密码确认」→ 回 app 焦点回检自动 ✓。

#### 2.3.2 运行时硬门禁（tool 层，每个 action 执行前）

**描述**：每个 action 声明所需权限（见 §2.1 表）。`tool.run()` 流程：① 解析 action 所需权限 → ② Swift helper 预检（或缓存态）→ ③ **任一 missing → 返回 `ToolRunResult{status:'failed', content:[{type:'text', text: reason}]}`**。

**reason 必须写清 + 引导**，例：
> 执行「screenshot」需要「屏幕录制」权限。请前往 **系统设置 ▸ 隐私与安全性 ▸ 屏幕录制**，开启「Rocky Computer Use」后重试。

**防御深度**：即使用户授权后中途在系统设置撤销，下次 action 运行时门禁拦下 + failed + 引导。UI 面板的动态监测与 tool 门禁**共享同一权限预检后端**。

**E2E/AT Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-2.3.1 | computer tab + switch on + 两权限均 missing → 看权限面板 | 两行均显 ✗红 + 各自「去授权」按钮；status「需要系统权限」（橙） |
| UC-2.3.2 | 点 accessibility 行「去授权」→ 系统设置开启 → 回 app | 焦点回检：accessibility 行变 ✓绿；「去授权」按钮消失（预留空间不位移） |
| UC-2.3.3 | agent 调 `get_app_state` 但 Screen Recording missing | tool 返 `failed` + reason 引导去系统设置开屏幕录制 |
| UC-2.3.4 | agent 调 `click` 但 Accessibility missing | tool 返 `failed` + reason 引导去系统设置开 Accessibility |
| UC-2.3.5 | 授权后用户在系统设置撤销 → agent 下次调 action | 门禁拦下 + failed + 引导重新授权 |

### 2.4 computer-connector-card 状态矩阵 [v0.0.105]

对齐 design.md §6（PRD 直接引用，不重定义）：

| switch | permission | connection | status(色) | 额外 |
|---|---|---|---|---|
| off | — | disconnected | 「未启用」灰 | — |
| on | **missing** | disconnected | 「需要系统权限」橙 | 显权限面板 + 去授权；**阻止连接** |
| on | granted | disconnected | 「已启用（未连接）」灰 | LLM 首次 computer use 时 lazy 连 |
| on | granted | connecting | 「连接中…」黄+spinner | lazy connect 期间 |
| on | granted | connected | 「已连接」绿 | agent 正控制 |
| on | granted | error | 「连接失败」红 | error + 重试 |

**不变量**：permission missing 时，switch=on 也不进 connecting（连接前置门禁）。权限面板 switch=on 时常驻。

### 2.5 ImageBlock 全链路打通（P0 前置，独立 Task 最先做）[v0.0.105] [P0]

**描述**：`message/types.ts` ContentBlock union 砍了 ImageBlock（标 future 删了），但协议层 `protocol-encode.ts:255` + spec §4.2 已就绪 image encode。这是 computer use 接入的**最大前置工作量**——不打通，截图回灌 LLM 的核心闭环就断。

**打通 5 点**（对齐 design.md §7 + research §3.1）：
1. `message/types.ts:174-180 ContentBlock` union 加 ImageBlock（`{type:'image', source: ImageSource, mediaType}`，`ImageSource = {kind:'base64', data} | {kind:'url', url}`）
2. spec / protocol 两形态对齐（encode 处适配 spec 用顶层 mediaType / 协议层 source 内 media_type）
3. `ToolResultBlock.content: ContentBlock[]` 承载 image + CrudStore 序列化 base64（DB 行大小评估 PNG 常 1-2MB）
4. context assemble 不过滤 image（typecheck + UT 验证无 drop 逻辑）
5. 前端渲染 image content block（chat UI 展示截图，最小化：占位 + click 展开）—— P1 最小占位

**优先级**：P0（1-4）、P1（5 前端渲染）

**用户故事**：作为 agent，我希望调 `get_app_state` 后，截图能正确包装成 ToolResultBlock.content 的 image block，经 agent loop → context assemble → llm caller protocol-encode → 下一轮 LLM 看到截图决策下一个 action。

### 2.6 安全红线 + HITL 审批 [v0.0.105] [P0]

**描述**：能控 OS 的工具不能裸跑（参考 openclaw）。三层防线：

1. **TOOL_POLICY bound 分级**：`playground-rocky` 默认加 computer_use 工具集；`subagent` **不**加（控 OS 风险高）；`studio-*` 视场景。对齐 `specs/tech/agent/tools/[P0]tool_policy.md`。
2. **switch flag 默认 off**：用户主动开启才启用，不静默 on。
3. **HITL 审批（复用 v0.0.101 tool-approval pending）**：computer use 工具挂 `interaction()` 钩子，首次截图/点击前转 pending 用户确认（复用 ask-question 通用 pending 机制）。破坏性动作（发送/删除/购买类 app 操作）二次确认（参考 iFurySt MCPServer instructions）。

**对齐 tech spec**：HITL 机制走 `[P0]tool_execution_engine.md` 的 `interaction()` / `onReply()` 钩子（v0.0.101 落地），不在本版本新发明。

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

> 采用 design.md §11 P1-P5。每条 ≥1 个 AT/E2E case。路径编号 = test-plan.md 路径→case 映射的 key。

### 路径 1（P1）：首次启用 + 权限授权
- 链路：连接器页 → computer tab → 开 switch → 权限面板显 missing → 「去授权」→ 系统设置开启两权限 → 回 app 焦点回检 ✓ → status「已启用（未连接）」。
- 关键断言：① 两权限均 missing 时显橙「需要系统权限」并阻止 connecting；② 焦点回检自动 ✓；③ granted 后 status 切到灰「已启用（未连接）」。
- UC: UC-2.2.3 + UC-2.3.1 + UC-2.3.2。

### 路径 2（P2）：agent 控制 macOS（screenshot → 决策 → click → disconnect 全链路）
- 链路：对话 agent 调 `get_app_state` → ConnectorManager lazy connect（owner 锁）→ 截图回灌 LLM（image block）→ LLM 决策 → `click` → … → `disconnect` 释放 owner。
- 关键断言：① 第一次 `get_app_state` 触发 lazy connect + 记 owner；② 同 owner 后续 action 复用 session；③ ToolResultBlock.content 含 ImageBlock（依赖 §2.5 打通）；④ `disconnect` 释放 owner。
- UC: UC-2.1.1 + UC-2.1.2 + UC-2.1.5。

### 路径 3（P3）：缺权限运行时报错
- 链路：agent 调 `get_app_state` 但 Screen Recording 未授权 → tool result `failed` + reason 引导。
- 关键断言：① 不抛异常（返 ToolRunResult）；② content 含引导文案（含「屏幕录制」+「系统设置」+「Rocky Computer Use」关键词）。
- UC: UC-2.3.3。

### 路径 4（P4）：权限中途撤销
- 链路：已授权 + 已 lazy connect 状态下，用户在系统设置撤销某权限 → agent 下次调对应 action → 门禁拦下 → `failed` + 引导。
- 关键断言：① 运行时门禁拦下；② reason 引导重新授权；③ owner 锁不自动释放（仍是 owner，等用户重授权或主动 disconnect）。
- UC: UC-2.3.5。

### 路径 5（P5）：owner 锁冲突
- 链路：session A 已 lazy connect（owner=A，connected）→ session B 调 computer use action → ConnectorManager `connectForToolRun` 返 `{ok:false, kind:'in_use_by_other', ownerSessionId:'A'}` → tool result 含引导文案。
- 关键断言：① 第二个 session 不抢占、不排队；② 错误经 tool result 传达 LLM，UI 无 toast/modal（沿用 browser 不变量）；③ session A 的 owner 不变。
- UC: 复用 browser 已有 owner 锁语义（`[P1]connectors.md` §5）。

---

## 4. 范围与非目标（对齐 design.md §10）

**本版本范围**：
- macOS only（Swift helper binary，复用 iFurySt open-codex `OpenComputerUseKit` 逆向成果）
- §2.1 P0 action 集合：`list_apps` / `get_app_state` / `click` / `scroll` / `type_text` / `press_key` / `disconnect`
- ImageBlock 全链路打通（§2.5 §1-4）
- connector 多 tab UI（§2.2）+ 权限双重防线（§2.3）
- 工具接入 + 连接治理集成（ConnectorManager 扩 `'computer'`）
- Swift helper 打包 `.app` bundle（`LSUIElement` agent 式无 Dock 图标，D6 预编译进项目）

**非目标（本版本明确不做）**：
- ❌ Linux / Windows 实现（仅留 `linux.ts`/`windows.ts` 接口签名，D5 推后）
- ❌ Anthropic 原生 computer_use beta 协议接入（D4 自定义 schema）
- ❌ P1 扩展 action（`perform_secondary_action` / `set_value` / `drag`）视实现进度后置
- ❌ 视觉 grounding 模型（e2b OS-Atlas/ShowUI 路线，D3 排除）
- ❌ E2E 进 run_all 自动套件（真 OS 不可控 + CI 无 Accessibility 权限，仅 dogfood 文档化）
- ❌ osascript/screencapture CLI 生产路径（仅开发期 fallback，因抢前台缺陷）

---

## 5. 待澄清（design.md ↔ 现有 spec 无矛盾记录）

本 PRD 产出时核对 design.md ↔ `specs/ui/` + `specs/tech/` 概念一致性，**无矛盾**：
- design.md「连接器页变多 tab（browser|computer）」 ↔ `specs/ui/overall/05-connectors.md` §2「connector-tabs（v0.0.23 仅 1 tab，**预埋多 tab**）」✅ 一致（预埋落地）。
- design.md「computer 复用 browser 双状态机（switch + connection）」+「多一层系统权限态」 ↔ `specs/tech/config/[P1]connectors.md` §2 双状态机 + §5 ConnectorManager 接口 ✅ 一致（computer ConnectorManager 仿 browser + 门禁加 permission 分层）。
- design.md「lazy connect 由 LLM 首次使用触发」 ↔ `[P1]connectors.md` §3.2 `[v0.0.46]` lazy connect 语义 ✅ 一致。
- design.md「owner 锁 sessionId 全局唯一」 ↔ `[P1]connectors.md` §5 owner 生命周期 ✅ 一致。
- design.md §2 `disconnect` action 释放 owner 锁 ↔ `[P1]connectors.md` §3.2 LLM disconnect action 行 ✅ 一致。
- design.md §7 ImageBlock GAP ↔ `specs/tech/agent/message/[P0]agent_message_interface.md` §4.2 已声明 ImageBlock（代码层 types.ts 砍了，spec 已就绪）✅ 一致。

**唯一需 architect 阶段细化的开放点**：
- Swift helper 与 TS 主进程的 IPC 协议细节（design.md §1「subprocess + JSON IPC 仿 NodeWorkerDriver」给方向，具体协议格式留架构期 change_plan）。
- `.app` bundle 分发签名机制（D6 预编译进项目，CI macOS runner 编译签名细节留架构期）。

---

## 版本

```yaml
version: 1.0
intro_version: v0.0.105
note: |
  v0.0.105 新增：computer use 工具集（~9 独立工具 + disconnect，D2 独立工具形态）
  + computer 作为连接器第 2 tab（connector-tabs 预埋落地，扩 ConnectorState.id='computer'）
  + 权限双重防线（UI 三重动态监测 + 运行时硬门禁每 action 预检）+ macOS Swift helper binary
  （postToPid + ScreenCaptureKit + AX，复用 iFurySt open-codex 逆向成果）+ ImageBlock 全链路打通
  （P0 前置，独立 Task 最先做）+ HITL 审批（复用 v0.0.101 tool-approval pending）。
  macOS only；不接 Anthropic 原生 beta（D4 自定义 schema）；linux/windows 仅留接口签名。
  权威 design = reqs/[working] v0.0.105.computer_use/design.md（用户已确认）。
  详 specs/prd/version_logs/v0.0.105.computer_use.md。
```
