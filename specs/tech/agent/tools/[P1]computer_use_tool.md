---
type: spec
title: Computer Use Tool（单 computer tool + 11 action）
priority: P1
status: active
updated: 2026-07-16
since: v0.0.105
---

# Computer Use Tool — agent 控制 macOS 桌面（单 `computer` tool + 11 action）

> 管什么：单一 `computer` ToolDefinition + `action` 参数 dispatch（11 action 对齐 open-codex）+ fail-closed 分层门禁（action 校验 / port undefined / 按 action 权限门禁）+ ACTION_PERMS 表 + app-scoped 模型 + window-relative 三段式坐标（session-state 缓存）+ 截图落盘（snapshot-store 共享出口）+ tool-policy bound。
> 不管什么：`ComputerNativePort` 接口 / native addon / 三态注入（→ `../platform/[P1]computer_native_capability.md`）；ImageBlock 协议原语（→ `../message/[P0]agent_message_interface.md §4.2`，**tool 层 v0.0.157 起不再构造**，类型保留供 protocol 层）；UI 权限卡片（→ `specs/ui/overall/05-connectors.md`）。
> 蓝本：iFurySt open-codex（能力集 1:1 对齐）。

## 1. 概述

computer use 能力暴露为**单一 1 个 `computer` tool + `action` 参数**（11 action 是同一 tool 的不同 action），**非** 多独立 tool、**非** 连接器。tool 层 `run()` 按 `input.action` dispatch 到对应 port method；底层 `ComputerNativePort` 保持分方法粒度（能力粒度与 tool 暴露形态无关）。

- **管什么**：`computer` tool 的 schema + run() dispatch + 权限门禁 + 坐标换算 + 结果包装。
- **不管什么**：原生能力如何实现（addon 直调 / mock / loopback，→ platform KB）；权限如何查（port.checkPermissions 背后的 electron systemPreferences）。
- **与外界交互**：只经 `ctx.config.computerNativePort`（`ComputerNativePort`）；`ctx.config.sessionId`（坐标上下文缓存 key）。**MUST 走 port 不绕过；MUST NOT import electron / native / spawn。**

**与 browser tool 的关系（并列、非替代）**：browser 控制单个 chrome tab（CDP，连接器 attach 门禁）；computer 控制整个 macOS 桌面（AX + 截图 + postToPid，本机主进程常驻能力，无连接器/owner 锁）。截图是 computer 的**主交互通道**（get_app_state 每 turn 先调，回灌 LLM）。

## 2. 11 action（对齐 open-codex 9 + 2 省 token 补充）

| action | 参数（snake_case，扁平） | port method | 结果包装 | 权限 |
|---|---|---|---|---|
| `get_app_state` | app? / text_limit?(number\|'max') / max_tree_nodes? / max_tree_depth? | `getAppState(opts)` | **[TextBlock(截图路径+size), TextBlock(AX 树)]**（截图落盘，顺序固定 [path, axText]） | screenRecording + accessibility |
| `list_apps` | — | `listApps()` | TextBlock（v0.0.160 起 = 运行中 + Spotlight recent 合并单行渲染 `<name> — <bundleId> [flags]`；无可控 app 时头「未发现可控 app」） | accessibility |
| `screenshot` | app? | `screenshot(opts)` | TextBlock（截图落盘路径 + size） | screenRecording |
| `read_ax_tree` | app? / text_limit?(number\|'max') / max_tree_nodes? / max_tree_depth? | `readAxTree(opts)` | TextBlock（纯树，省图像 token） | accessibility |
| `click` | element_index? \| (x?,y?) / click_count? / mouse_button? / app? | `click(target,opts)` | TextBlock | accessibility |
| `perform_secondary_action` | element_index / secondary_action（**v0.0.160 pretty 别名 `Press`/`Show Menu`/`Raise` 或 raw `AXPress`/`AXShowMenu`/`AXRaise` 双写法，Swift `matchingAction` case-insensitive**）/ app? | `performSecondaryAction(idx,name,opts)` | TextBlock | accessibility |
| `scroll` | direction / element_index? \| (x?,y?) / pages? / app? | `scroll(target,opts)` | TextBlock | accessibility |
| `drag` | from_x / from_y / to_x / to_y / app? | `drag(from,to,opts)` | TextBlock | accessibility |
| `type_text` | text / app? | `type(text,opts)` | TextBlock | accessibility |
| `press_key` | key（xdotool 语法）/ app? | `pressKey(key,opts)` | TextBlock | accessibility |
| `set_value` | element_index / value / app? | `setValue(idx,value,opts)` | TextBlock | accessibility |

- **命名对齐 open-codex**（`type`→`type_text`、`key`→`press_key` 便于对照）；`perform_secondary_action` 的动作名参数取 `secondary_action`（不用 open-codex 原名 `action`——`action` 是本 tool discriminator，冲突）。
- **`get_app_state` 是主 action**（截图+AX 合一，对应 open-codex「每 turn 先调」）；`screenshot`/`read_ax_tree` 是单模态省 token 补充（screenshot=纯图 / read_ax_tree=纯树 / get_app_state=图+树）。
- **v0.0.160 `text_limit: 'max'` 语义**：无上限关键字（Swift `SnapshotTextLimit.parse("max") → .max`）；schema `oneOf: [{type:'integer'},{type:'string',enum:['max']}]`；`resolveAxOptions('max')` 分支透传。
- **v0.0.160 action 侧友好文案（state_unavailable 错误分类）**：`type_text` / `set_value` handler 识别 `res.code === 'state_unavailable'` 时返「先建立坐标上下文再重试 / 无 focused editable 请先 click」类友好中文前缀 + 保留 native 原始 message 供 debug（native-port 侧详见 `../platform/[P1]computer_native_capability.md §2` ComputerErrorCode 表）。

## 3. 设计决策

### 3.1 单 tool + action dispatch（不回退多 tool）

**决策**：11 能力收敛为单 `computer` tool 的 action，而非 11 个独立 ToolDefinition。
**为何**：11 个独立 tool 会撑爆 LLM 的 tool 列表（token + 选择成本），且能力高度同源（同一 port、同一门禁范式、同一坐标模型）。单 tool + `action` enum discriminator 让 LLM 一次看清全部能力，schema 复用。
**不这样会怎样**：多 tool 需 11 份重复 schema/门禁/坐标样板，registry 注册 11 项，tool-policy bound 列 11 个名——维护面 11 倍且 LLM 选择噪声大。

代码：`tools/computer-use/computer.ts computerTool`（单 ToolDefinition，name=`'computer'`）→ registry `defaultTools()` spread `COMPUTER_USE_TOOLS=[computerTool]`。

### 3.2 扁平 action-discriminated schema（非 JSON Schema oneOf/if-then）

`COMPUTER_INPUT_SCHEMA`（`schema.ts`）= `action` 必填 enum（11 值）+ 各 action 专属可选参数（扁平 primitive）+ `additionalProperties:false` + `required:['action']`。
**为何扁平**：契合项目 loose `JSONSchemaLike` + engine「必填 + primitive」轻校验——engine 仅验 action 存在且是 string；**action-specific 必需参数**（type_text 的 text / scroll 的 direction / press_key 的 key / drag 的 from_x..to_y / set_value 的 element_index+value / perform_secondary_action 的 element_index+secondary_action）由 tool `run()`/handler 校验（缺 → errorResult，不静默）。
坐标用扁平 `x`/`y` 整数（非 Anthropic `coordinate:[x,y]` 数组），对齐 `resolveTarget` 三段式。

### 3.3 fail-closed 分层（run() 前置统一做，handler 只留「调 port + 包装」）

`computer.ts run(input, ctx)` 四层（handler 保持纯，不各自查权限）：
```
① action 非 string / 不在 11 值集 → errorResult（未知 action 引导，列 11 有效 action）
② ctx.config.computerNativePort undefined → errorResult「仅 Rocky 桌面 App 可用」（dev 提示配 ROCKY_DEV_COMPUTER_LOOPBACK_PORT）
③ ACTION_PERMS[action] 门禁：port.checkPermissions() → checkPermissionGate missing → errorResult(formatPermissionMissing)
④ switch dispatch → handleXxx(input, port[, ctx]) → 调 port.<method> → 统一包装
```

`ACTION_PERMS`（`computer.ts`）：`screenshot→{screenRecording}`；`get_app_state→{screenRecording,accessibility}` 双门禁；其余 9 action→`{accessibility}`。
`checkPermissionGate`/`formatPermissionMissing`（`permissions.ts` 纯函数）：门禁返第一个 missing 名或 null；引导文案含「系统设置」「屏幕录制」/「辅助功能」「Rocky」关键词（AT 断言 + 屏幕录制需重启 Rocky 生效提示）。

### 3.4 app-scoped 模型 + window-relative 三段式坐标

- **app-scoped**：所有 action 可选 `app` 参数（bundleId 或 localizedName），Swift `resolvePid(appHint:)` 解析 pid，缺省 frontmost。element_index 按该 app AX 树序号（Swift `lastRecords` 单例缓存，last-call-wins，跨 invoke 复用）；postToPid 按该 app pid；截图为该 app key window。
- **坐标上下文缓存**（`session-state.ts`，per-sessionId 纯内存）：`screenshot`/`get_app_state` 拿到单窗口截图后 `setComputerCoordContext(sid, {scaleFactor: deriveScaleFactor(width, windowBounds, reported), windowBounds})`；coordinate 动作（click/scroll/drag）读 `getComputerState(sid)` → `resolveTarget(input, scaleFactor, windowBounds)`/`resolveDrag(...)`（`target.ts`，window-relative 三段式换算成屏幕 point）。
- **契约**：coordinate 动作前必先 screenshot/get_app_state 建坐标上下文；`read_ax_tree` AX-only 不建 windowBounds（只支持 element_index）。element_index 路径零像素数学（不受 window-relative 影响，robust）。

## 4. run() dispatch 示例（非省略）

```typescript
// tools/computer-use/computer.ts
async run(input, ctx) {
  const action = input.action;
  if (!isComputerAction(action))                    // ① 校验
    return errorResult(`computer: 未知 action ...；有效 action：${COMPUTER_ACTIONS.join(' / ')}`);
  const port = ctx.config.computerNativePort as ComputerNativePort | undefined;
  if (!port) return errorResult('computer 仅在 Rocky 桌面 App 中可用 ...');   // ②
  const perms = await port.checkPermissions();       // ③
  const missing = checkPermissionGate(ACTION_PERMS[action], perms);
  if (missing) return errorResult(formatPermissionMissing(missing));
  switch (action) {                                  // ④
    case 'get_app_state': return handleGetAppState(input, port, ctx);
    case 'screenshot':    return handleScreenshot(input, port, ctx);
    case 'click':         return handleClick(input, port, ctx);   // 读 session-state 坐标上下文
    case 'drag':          return handleDrag(input, port, ctx);
    // list_apps / read_ax_tree / type_text / press_key / set_value / perform_secondary_action / scroll ...
  }
}
```

handler 示例（`actions/get-app-state.ts`）：`resolveAxOptions(input)` → `port.getAppState(opts)` → `!ok` errorResult → `setComputerCoordContext(sid, {scaleFactor: deriveScaleFactor(...), windowBounds})` → 截图落盘 → `{content:[TextBlock(formatSnapshotText({relPath,width,height,mediaType})), TextBlock(axText)], isError:false}`（两 TextBlock 顺序固定 [path, axText]）。**截图落盘走 `snapshot-store.saveSnapshot`**（`tools/snapshot-store.ts`，共享单一出口，被 computer-use/browser 两族消费）：`saveSnapshot({workdir, toolCallId, data, mediaType, width?, height?})` → mkdir -p `<workdir>/snapshots/` + writeFile `<toolCallId>.<ext>` → 返 `{absPath, relPath, mediaType, width?, height?}`；`formatSnapshotText` 构造 tool_result 文案 `Saved screenshot to <relPath> (<W>x<H>, <mediaType>). Use see_image tool to view it.`（browser 路径无尺寸段）。落盘失败 catch → errorResult，**不回退 inline image**（INV-157-4）。

> **v0.0.157 截图不 inline 进对话上下文（INV-157-1）**：tool_result.content[] 绝不含 ImageBlock。主对话模型走纯文本（M3）也能消费截图决策（路径 + AX 树即足够）；多模态模型按需显式调 `see_image({imagePaths:['snapshots/<id>.png']})` 读路径看图。`toolCallId` 由 engine per-call 从 `call.id` 注入到 `ToolCtx`（record/replay 下 LLM stub 返相同 id → 路径确定性，避 stub 漂移）。

## 5. tool-policy bound

`TOOL_POLICY['playground-rocky'].bound` 加单 `'computer'`（1 条覆盖全部 11 action）。
- **仅 playground-rocky**（控 OS 风险高）；**MUST NOT** 加 subagent / leader / mate / squad（临时派生/团队协作不应控制桌面）。
- 无 switch flag / 无连接器门禁（去连接器语义）；port undefined（非桌面 App）时 tool 自然 fail-closed 是首版安全防线。

## 6. 测试基建（mock port + directive）

- **mock port**：AT 用 `MockComputerNativePort`（读 `<DATA_DIR>/computer-mock.json` fixture，见 platform KB §3 ①）测 tool 逻辑（11 action dispatch / 门禁 / target·drag 解析 / 结果映射 / 错误分支），**不测真 OS 操作**。fixture 全字段可选（缺则默认：小 AX 树 + 1×1 PNG + scaleFactor:2 + windowBounds；actionResults 各缺→`{ok:true}`）。
- **mock-llm directive**：`@@cu:<json>@@`（user message 内）→ 出单 `computer` tool_call（`name='computer'`，`arguments=<json>`）。断言 `tool_call.name==='computer'` + `arguments.action==='<action>'`。机制在 `mock-llm.ts CU_DIRECTIVE_RE` + `mock-llm-scenarios.ts buildComputerScenario`。
- **真操作**（真 AX 树 / 真键鼠 / 真 drag）走 dev dogfood 手验，**不进 run_all**（守 `test-no-real-spawn-system-gui`：run_all 绝不触真原生动作）。

## 7. 文件级实现清单

| 文件 | 角色 |
|---|---|
| `tools/computer-use/computer.ts` | 单 `computer` ToolDefinition + `COMPUTER_ACTIONS`(11) + `ACTION_PERMS` + run() dispatch（四层 fail-closed + switch） |
| `tools/computer-use/schema.ts` | `COMPUTER_INPUT_SCHEMA`（扁平 action-discriminated）+ `ACTION_DESCRIPTION`（逐 action 引导文案） |
| `tools/computer-use/permissions.ts` | `PermissionRequirement` + `checkPermissionGate` + `formatPermissionMissing`（纯函数） |
| `tools/computer-use/target.ts` | `resolveTarget` / `resolveDrag`（window-relative 三段式）/ `resolveAxOptions`（snake→camel） |
| `tools/computer-use/session-state.ts` | per-sessionId 坐标上下文缓存（`setComputerCoordContext` / `getComputerState`） |
| `tools/snapshot-store.ts` | **共享** 落盘出口 `saveSnapshot` + 文案 `formatSnapshotText`（computer-use/browser 两族消费；v0.0.157 起替代已删的 `image-block.ts:wrapScreenshot`） |
| `tools/computer-use/actions/*.ts` | 11 action handler（get-app-state/list-apps/screenshot/read-ax-tree/click/perform-secondary-action/scroll/drag/type-text/press-key/set-value；screenshot/get-app-state 落盘走 saveSnapshot + 路径文本） |
| `tools/computer-use/index.ts` | `COMPUTER_USE_TOOLS=[computerTool]`（registry spread） |
| `tools/registry.ts` | `defaultTools()` spread `...COMPUTER_USE_TOOLS` |
| `agent/tool-policy.ts` | `TOOL_POLICY['playground-rocky'].bound` 加 `'computer'` |
