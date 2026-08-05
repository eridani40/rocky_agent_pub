# PRD Change Log — v0.0.8

> 版本：v0.0.8 · 日期：2026-06-21
> 增量记录 v0.0.8 相对 v0.0.7 引入的产品需求变更。
> 全量产品定义见 `specs/prd/overall/`。
> v0.0.8 = **真实 agent 基础对话页**：把「无 session、单轮、模拟」的 chat（v0.0.3 §3.1）**彻底替换**为「session 化、agent loop + inbox + 工具、SSE 流、transcript 持久化」的基础 agent 对话页。

## 摘要

v0.0.8 在 PRD 层落地 `states/v0.0.8/user_query.md`（含用户授权的 6 项默认值）。一句话：**用户能在应用内新建/选中/删除会话、发消息触发真实 agent run、看到流式回答、工具调用合并展示、loading 阶段胶囊、空态、run 结束 finish reason（异常附 error desc），多轮超限自动 compact，打开旧会话读最近 50 条 transcript + 上滑续载。**

UI 概念权威：`specs/ui/components/chat-page/_overview.md`（三栏 / conv-panel / tool-batch 视图层合并 / loading 阶段 / empty / run-finish + finish reason / markdown answer）。
视觉契约：`reqs/v0.0.8/easy-opc-chat-v9a.html`。
技术概念权威：`specs/tech/agent/`（agent_manager / agent_loop / agent_event / context_engine / session_store / agent_message / tools）+ `specs/tech/app/frontend/[P0]sse_channel.md`。

## 1. 版本目标 + Scope

### 1.1 目标
- 把 chat 从「验证 LLM 配置的切片」升级为「真实基础 agent 对话产品」。
- 后端按 spec 全实现 agent 子系统（属「未提及依赖」，见 §3）。
- 前端**替换**：新 ChatPage（按 `_overview.md`）接管；删除旧无 session `POST /chat` + 旧 `ChatPage/chat-store/sse-client`。

### 1.2 IN SCOPE
1. **Session 化对话**：创建/列表/选中/删除会话；打开 session 读最近 50 条 transcript + 订阅 SSE。
2. **发消息触发 run**：发消息 → AgentManager.enqueue → AgentLoop.start → run 生命周期。
3. **流式回答**：经 SSE（topic=`agent_loop`, group=`session_id:<sid>`）增量渲染 answer（markdown）。
4. **工具调用合并展示**：assistant 产 tool_call → 视图层连续合并为单个 tool-batch 胶囊（跨消息边界）；KV 参数/结果；result 永远附着对应 call。
5. **Loading 阶段胶囊**：悬浮于输入框左上方，随事件切文案（思考中/生成/调用工具/执行中），run 结束即消失。
6. **空态**：新建空会话或选无消息会话 → empty-state 引导态。
7. **Run 结束 finish reason**：最近一次 run 末条消息下方渲染；异常态附 `error.message` + `error.code`。
8. **Markdown answer**：agent 最终 answer 支持 markdown（段落/加粗/行内代码/列表/代码块）。
9. **Transcript 分页续载**：上滑到 50 条尽头若还有则续载（`getMessages(beforeId, limit)`）。
10. **工具**：file（read/write/edit/glob/grep）+ bash。
11. **自动 compact**：上下文超限 → ContextEngine.compact → summary 生效 → 继续对话。

### 1.3 OUT OF SCOPE（明确排除）
| 排除项 | 理由 |
|--------|------|
| HITL 审批 UI | 用户授权默认值#1：基础版工具直接执行；`require_approval` 留枚举不触发 |
| Full system prompt builder | 默认值#2：简单固定默认值 |
| usage 累计/展示 | 默认值#3：不做 UI 展示；仅内部 char 估算 context window 触发 compact |
| forked agent compact | 用户明确简化：compact = snapshot + user → LLM → 解析 `<summary>` |
| ingest handler chain / truncate / offload | 用户明确简化：ingest 仅存储 |
| 外部插件发现/安装 | 沿用 v0.0.3 OUT |
| tokenizer | char × ratio 估算（沿用） |

## 2. 用户授权的默认值（写进 PRD，不重新争论）
1. **无 HITL 审批**：工具直接执行；`require_approval` 枚举保留不触发。
2. **system prompt 固定默认值**：不上 full builder。
3. **usage 不展示**：但内部保留 char 估算 context window 用于触发 compact。
4. **真机冒烟**走 anthropic-compatible 网关（minimax/glm）；**自动化测试走 mock**（`ROCKY_TEST_MOCK_LLM=1`）。
5. **彻底替换旧 chat**（非并存）。
6. 在 dev1 开 `v0.0.8-agent` 分支开发（不开 worktree）。

## 3. 未提及依赖（后端按 spec 全实现）
> 这些是前端功能的前置，用户未显式提及但属 spec 已定义概念，按 spec 落地：

- **EventBus + EventHub**（replayable, topic=`agent_loop`, group=`session_id:<sid>`）：`specs/tech/agent/event/`。
- **SessionStore**：transcript 分片持久化 + summary；`session_store.md`。
- **AgentManager + AgentLoop + Inbox**（基础 loop, eager inbox）：`agent_manager.md` / `agent_loop.md`。
- **ContextEngine 三接口**（简化版，见 §4）。
- **工具执行引擎**：file（read/write/edit/glob/grep）+ bash；`tools/`。
- **SSE channel**：GET `/sse` + POST `/sse/subscribe` + `/sse/unsubscribe`；`sse_channel.md`。
- **anthropic cache control 2bp**：`providers_and_models/anthropic_impl.md`。

## 4. ContextEngine 三接口简化（用户明确）
- `ingest(config, msgs)` = **仅存储**（append 进 transcript），不做 handler chain / truncate / offload。
- `assemble(config)` = 单个 mapper 读全部 transcript 作历史；若已存在 summary，则保留 **head 3 + tail 3 + recent**（summary 作为一条 message）。
- `compact(config)` = **不用 forked agent**；取当前 snapshot + 一条 user 消息 → 调 LLM → 从结果解析 `<summary>` 当作 summary（推进 `summaryUpTo`）。

## 5. 功能清单（详）

### 5.1 Session 化对话
- **新建**：点 `conv-new-btn`（+） → 创建空 Session 并选中 → chat-detail 显示 empty-state。
- **列表**：conv-panel 220px，逐条 `conv-item-{id}`（title + time mono）；active 项 Terracotta 浅底 + 文字高亮；hover 米白底。
- **选中**：点 `conv-item-{id}` → 切 active；空会话显 empty-state。
- **删除**：会话项 hover 出删除入口（预留固定空间，不抖动）；删除后列表移除。
- **加载**：打开 session → `GET /session/:id/messages?limit=50` 读最近 50 条 transcript → 渲染消息流；同时 `POST /sse/subscribe { topic:'agent_loop', group:'session_id:<sid>' }`。
- **续载**：消息流上滑到顶若还有 → `GET .../messages?beforeId=<最旧id>&limit=50` → 前插。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-5.1.1 | 点 `conv-new-btn` → 看主区 | 空会话创建并选中；主区显 `chat-empty-state` |
| UC-5.1.2 | 已有会话列表 → 点某 `conv-item-{id}` | 切 active（Terracotta 浅底）；主区载入该 session 最近 50 条消息 |
| UC-5.1.3 | 删除一个会话 | 列表移除该项；若删的是 active 则切到下一个或空态 |

### 5.2 发消息触发 run + 流式回答
- 输入 `chat-input` → `chat-send`/Enter → `POST /session/:id/messages`（user query） → 后端 `AgentManager.enqueue` → `AgentLoop.start`（新 run）。
- user 气泡立即入列（右侧深底）。
- loading-status 出现（thinking → answering → tool_calling/tool_executing）；SSE 增量推送 assistant answer → 左侧 accent-surface 气泡 markdown 流式追加。
- `run_end` 到达 → loading 消失 → 末条消息下方渲染 run-finish（翻译 stopReason）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-5.2.1 | 发一条 query（mock 路径） | user 气泡入列 → loading「思考中→生成回答」→ assistant answer 流式追加 → run_end → loading 消失 + run-finish 显「✓ 已完成」 |

### 5.3 工具调用合并展示（tool-batch 视图层合并）
- assistant 消息产 tool_call → 渲染为 tool-call-item（call + 绑定的 result）。
- **视图层连续合并**：把有序消息流拍平为 view-element 序列，任意连续的 tool-call-item 合并为一个 tool-batch 胶囊；遇到非 tool 元素（answer/user）即断开；**与消息边界无关**（跨多条 assistant 消息但位置连续的 tool_call 并入同一 batch）。
- tool-batch 折叠态：小圆角胶囊「工具调用 + {done}/{total}」；点开 → 大圆角面板包裹各 tool-call-item。
- tool-call-item head：icon + name(mono) + status pill（done=sage ✓ / running=gold）+ chevron。
- 展开body：参数 + 结果，**KV 行**（左 key 固定宽右对齐 muted / 右 value mono fg-2）；严禁原始 JSON 串/生硬代码框。
- **result 永远附着对应 call**：先扫所有 `role='tool'` 消息建 `Map<toolCallId, ToolResultBlock>`，每个 item 查自己 result。
- part 以 `messageId + toolCallId/text-index` 为 key（非数组 index）——SSE 乱序/增量不抖动。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-5.3.1 | 发触发 bash 工具的 query | run 期间产 tool_call → 一个折叠 tool-batch → tool_result 回灌绑定 → run 继续 answer；点开 batch 见面板含各 item；点 item 展 KV 参数/结果 |
| UC-5.3.2 | 连续多工具跨消息边界 | 视图层合并进同一 tool-batch（位置连续即合并，不分消息） |

### 5.4 Loading 阶段胶囊
- 悬浮于输入框左上方（`absolute left-10 bottom-[72px]`），脱离消息流。
- 一次 run 唯一一个胶囊；阶段：thinking/answering/tool_calling/tool_executing，随 SSE 事件切文案。
- run 结束（finish/error）→ `opacity-0 pointer-events-none` 立即隐藏。

### 5.5 空态
- active 会话无消息 → `chat-empty-state`（icon 72px + 标题「空会话」+ mono 副标题「在下方输入消息开始对话」）；不显示空白/报错。

### 5.6 Run 结束 + finish reason（req2）
- **仅最近一次 run** 在其末条消息下方渲染 run-finish；历史 run 不重复。
- 正常（`no_tool_call`/`no_new_messages`）：克制细分隔线 + 「✓ 已完成」。
- 限制/异常：`max_iterations`/`doom_loop` → 警告色（gold）；`error` → 错误卡片「执行出错」+ `error.message`（desc）+ `error.code`（mono pill）；`require_approval`（HITL 暂停）→ sage「等待审批」（v0.0.8 不触发，枚举保留）。
- 文案翻译表集中维护（coder 实现常量）。

### 5.7 Markdown answer
- agent 最终 answer 气泡支持 markdown：最小支持 段落/加粗/行内代码/列表/代码块；代码块走卡片态（不生硬灰底），对齐 v9a.html 克制风格。

### 5.8 Transcript 分页续载
- 打开 session：读最近 50 条 transcript。
- 上滑到顶（50 条尽头）若 `hasMore` → 续载下一页（`beforeId`），前插；无更多则不再请求。

### 5.9 工具（file + bash）
- 工具执行引擎落地：file（read/write/edit/glob/grep）+ bash。
- 工具结果回灌 agent（`tool_result` 消息） → agent 继续回复。

### 5.10 自动 compact
- char 估算 context window 超 threshold → ContextEngine.compact（snapshot + user → LLM → 解析 `<summary>` → 推进 summaryUpTo）。
- compact 后 assemble 生效（head 3 + tail 3 + recent + summary）；用户无感知，对话继续。

## 6. 关键用户路径（MANDATORY — 每条至少 1 个 AT/ET case）

| 路径 | 链路 | 最低 case |
|------|------|----------|
| **路径A：新建会话 → 空态 → 纯文本回复** | 点新建 → empty-state → 发消息 → 收纯文本流式回复 → run 结束（finish reason=正常完成） | AT（POST message + SSE run 序列）+ ET（UC-5.1.1 + UC-5.2.1） |
| **路径B：发消息 → 调工具（bash/file）→ tool_result 回灌 → 继续回复** | 发触发工具的 query → tool-batch 合并展示 → KV 参数/结果 → result 附着 call → agent 继续回复 | AT（SSE tool_call/tool_result 事件序列 + run 续答）+ ET（UC-5.3.1） |
| **路径C：run 异常 → run-finish 展示 error desc** | 发 query → run 期间 error 事件 → run_end(stopReason=error) → run-finish 错误卡片显 `error.message` + `error.code` | AT（注入 error 的 mock SSE 序列）+ ET（断言 `run-finish-error-desc` + `run-finish-error-code` 可见） |
| **路径D：多轮对话 → 上下文超限 → 自动 compact → 继续** | 多轮对话积累 → char 估算超阈值 → compact 触发 → summary 生成 → assemble 生效（head 3 + tail 3 + recent + summary）→ 继续对话正常 | AT（mock 触发 compact + 断言 summary 生成 + assemble 含 summary）+ ET（多轮后断言对话仍正常 + 无报错） |
| **路径E：打开旧会话 → 读最近 50 → 上滑续载** | 选旧会话 → 读最近 50 条渲染 → 上滑到顶 → 续载更多历史前插 | AT（GET messages limit=50 + beforeId 分页）+ ET（UC-5.1.2 + 滚动续载断言） |
| **路径F：连续多工具跨消息边界 → 视图层合并** | 发 query 触发跨消息边界的连续 tool_call → 合并进同一 tool-batch | ET（UC-5.3.2，断言单一 tool-batch 含全部 call） |

## 7. PRD ↔ ui/tech spec 对齐核对

### 7.1 对齐结论（一致）
| PRD 引用 | spec 来源 | 对齐 |
|---------|----------|-----|
| 三栏布局 / conv-panel 220px / chat-detail flex-1 | `_overview.md` §1 | ✅ |
| 真实 Message + ContentBlock 渲染规则 | `_overview.md` §2 / `agent_message_interface.md` | ✅ |
| tool-batch 视图层连续合并（跨消息边界） | `_overview.md` §2 rule5 / §4.8 | ✅ |
| result 永远附着 call（Map<toolCallId>） | `_overview.md` §2 rule4 / §4.9 | ✅ |
| loading 阶段胶囊 4 阶段 | `_overview.md` §4.10 | ✅ |
| run-finish + finish reason + error desc/code | `_overview.md` §2 rule7 / §4.13 / `agent_event.md` §4.1+§6 | ✅（error 字段对齐） |
| SSE topic=`agent_loop` group=`session_id:<sid>` | `agent_event.md` 开头声明 / `sse_channel.md` §4 | ✅ |
| SessionStore transcript 分片 + summary + getMessages(range/beforeId) | `session_store.md` §3+§4 | ✅ |
| ContextEngine 三接口简化（ingest 仅存 / assemble mapper / compact 解析 summary） | `context_engine.md` + 用户明确简化 | ✅（简化口径用户授权） |
| 工具 file(read/write/edit/glob/grep)+bash | `tools/[P0]overall.md` + `file_op_tools.md` + `bash_tools.md` | ✅ |
| anthropic cache control 2bp | `providers_and_models/anthropic_impl.md` | ✅ |
| AgentManager.enqueue + AgentLoop.start + Inbox | `agent_manager.md` / `agent_loop.md` | ✅ |
| testid 全集（conv-panel/tool-batch/loading/empty/run-finish…） | `_overview.md` §7 | ✅ |

### 7.2 需 orchestrator 留意的小不一致（不阻断 PRD，落 spec 阶段统一）
> 这些是 spec 内部已有的措辞差异，PRD 按「权威枚举源 = `agent_loop.md` §2 StopReason」对齐：

- **StopReason `require_approval` vs `pending_approval`/`approval_rejected`**：`_overview.md` §2 rule7 + §4.13 写 `require_approval`，而 `agent_loop.md` §2 枚举写 `require_approval`、正文流程图出现 `pending_approval`/`approval_rejected`。**PRD 采纳 `_overview.md` 的对外文案「等待审批」**（v0.0.8 不触发，枚举保留）；建议 architect 在 tech spec 统一 stopReason 枚举命名（`require_approval` 为准，删除流程图里的 `pending_approval`/`approval_rejected` 或明确区分）。
- **`usage_block` 事件**：`agent_event.md` §6 定义了 UsageBlockEvent，但用户默认值#3「usage 不展示」。PRD：后端可仍 emit（内部 char 估算用），前端**不渲染** usage 面板。无矛盾，仅说明。

### 7.3 无需新落 ui/tech spec 的概念
v0.0.8 引用的所有概念（conv-panel / tool-batch / loading-status / empty-state / run-finish / transcript 分页 / session CRUD / agent loop / context engine / tools / SSE channel）**全部已在 spec 定义**，PRD 不发明新概念。

## 8. 验收标准（功能 + 视觉保真度，二者都是门槛）

### 8.1 功能验收
- §6 六条关键用户路径全部有 AT + ET case 且通过。
- session CRUD / 发消息 / 流式回答 / tool-batch 合并 / loading / empty / run-finish / transcript 分页 / compact 全部可演示。
- 自动化测试走 mock（`ROCKY_TEST_MOCK_LLM=1`）全绿；真机冒烟走 minimax/glm 至少跑通路径 A + B。

### 8.2 视觉保真度验收（对照 `easy-opc-chat-v9a.html`，MANDATORY）
- e2e-verifier 用 `vision_check.py compare <impl截图> <v9a截图> <checks>` 逐维度（layout/font/border/color）判定。
- 覆盖：三栏布局比例 / conv-panel header+item / chat topbar / user 右深底 + agent 左 accent-surface 气泡 / 头像列对齐 / tool-batch 折叠+展开 / loading 胶囊 / empty-state / run-finish 各态 / input-bar。
- 明显偏差建 `BUG-xxx-[open].md` 标「视觉保真」。

### 8.3 文档同步
- doc-modifier 同步：`specs/prd/overall/03-llm-chat.md`（补 v0.0.8 关键路径，旧 §3.1 作废）+ `specs/ui/overall/02-llm-chat.md`（§3 已删，确认引用本 spec）+ `specs/tech/overall/` + `specs/api/overall/`（session/message/sse 端点）。

## 9. 文档修订（overall 就地更新）

| 文件 | 修订 | 标注 |
|------|------|------|
| `specs/prd/overall/03-llm-chat.md` §3.1 | 旧「Chat 流式对话」（无 session 单轮）**作废**；新增 v0.0.8 真实 agent 对话章节（session 化 + tool-batch + loading + empty + run-finish + transcript 分页 + compact） | `[v0.0.8]`（旧 §3.1 标 `[作废-被 v0.0.8 取代]`） |
| `specs/prd/overall/03-llm-chat.md` §4 关键路径 | 补路径 A–F（v0.0.8） | `[v0.0.8]` |
| `specs/prd/overall/03-llm-chat.md` §7 范围边界 | v0.0.3 OUT 中的「agent loop / session 持久化 / 工具调用 / context engine」标记「v0.0.8 已交付」 | `[v0.0.8 modified]` |

---

## 版本

version: 1.0（v0.0.8 新建：真实 agent 基础对话页；彻底替换 v0.0.3 §3.1 模拟 chat）
