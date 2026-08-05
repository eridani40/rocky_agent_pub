# v0.0.101 — ask-question tool + 通用 pending 悬挂机制 + 会话列表指示器 + workspace 绝对路径修复

> 类型：架构级新功能（HITL 蓝图落地） + 列表 UX + bug 修复
> 范围：三件合并 —— ① workspace 工具绝对路径修复（bug）② 会话列表 running/suspended 指示器（UX）③ ask-question tool + 通用 pending-tool-calls 悬挂机制（架构）
> 权威 req：
> - `reqs/[done] v0.0.101.ask_question_tool/req.md`
> - `reqs/[done] v0.0.101.ask_question_tool/1-workspace-nested-dir-fix.md`（#1 定稿方案）
> - `reqs/[done] v0.0.101.ask_question_tool/2-running-indicator.md`（#2 定稿方案）
> - `reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md`（#3 定稿方案 + 决策锁定表，最关键）
> 前置概念权威源（PRD 已读对齐）：
> - tech HITL 蓝图：`specs/tech/agent/agent_interface_and_loop/[P0]agent_hitl.md`（标注 `[future — 不实现]` 的 approval 分支槽位，#3 将其落地为 canonical + 新增 feedback 分支）
> - tech loop：`[P0]agent_loop_base.md §9`（StopReason 全集，含 `require_approval` 占位）+ `[P0]agent_loop_eager_drain.md`（4 阶段主循环）+ `[P0]agent_event.md §7`（`require_human_input` Event 已定义从未 emit）
> - tech tools：`[P0]tool_execution_engine.md §5`（`Tool.needsApproval?()` 钩子字段保留，引擎恒跳过 —— #3 改造为 `Tool.interaction()`/`onReply()`）
> - tech session：`[P0]session_state.md §1`（五态 idle/running/interrupting/interrupted/error，#3 新增第 6 态 `suspended`）+ `[P0]session_store.md`（transcript append-only）
> - tech message：`[P0]agent_message_interface.md §4.10`（`ApprovalResultBlock` 已定义）+ §5（`MessageSource` 判别联合含 `'approval'` 变体）
> - tech 前端：`specs/tech/app/frontend/[P0]chat_area_hooks.md §3`（useMessages）
> - ui：`specs/ui/components/chat-page/_overview.md §4.11a`（`component-enqueue-view` 契约 — chat-input-bar 内、composer 上方、SSE 驱动）—— #3 复用此位置模式
> - api：`specs/api/overall/04-agent-session.md §3.2`（POST /messages）/§3.5（GET /inbox）/§4.2（session_meta 广播）

## 0. 决策基线（已锁，PRD 不重新讨论）

| # | 决策 | 来源 |
|---|------|------|
| 版本 | 1/2/3 合并进 **v0.0.101**（一个 worktree 走完整流程） | req.md |
| **#1 原则** | workspace 绝对路径通过 reminder（context）告诉 LLM；工具**不做多套一层、不接受相对路径**；`path` = 绝对路径，由 LLM 按 reminder 给的 workspaceDir 自己拼 | 1-workspace §修复方向 |
| **#1 沙箱** | 待用户拍板（A 保留 file 沙箱根到真实 workspaceDir / B 去掉 file 沙箱对齐 bash 无沙箱）—— **PRD 开放点 O1**，不影响主线 | 1-workspace §决策点 |
| **#2 覆盖** | playground(main + subagent) + studio(群聊 + leader + mate)；studio 无独立 subagent item 不做 | 2-running §决策 |
| **#2 共存** | running spinner 与 unread 红点错位共存（环在名字/头像处，红点右上角） | 2-running §决策 |
| **#2 验证** | UT 必做 + ET 1 case（DOM 断言 spinner testid 出现）+ AT 豁免（无 API 契约变更） | 2-running §决策 |
| **D1** | 通用 pending-tool-calls 机制（ask-question + 未来 tool-approval 共用同一 infra） | 3-ask §决策锁定表 |
| **D2** | 新增 `suspended` 态 + 落盘 `pendingToolCalls` + SSE emit `require_human_input`（payload 细化为单个 PendingToolCall）+ API `GET /session/:id/pending-tool-call` peek 队首 | 3-ask §决策锁定表 |
| **D3** | 回填走 inbox（`tool_reply` 消息类型，复用 `deliverTo`），不独立接口 | 3-ask §决策锁定表 |
| **D4** | 多 pending = 多 tool call（队列串行展示）；多 tab = 单 ask-question 内多问题（不混） | 3-ask §决策锁定表 |
| **D5** | pre-process 按 `handleType` 编辑 content block；仍有 pending 则跳出后续 LLM/工具阶段 | 3-ask §决策锁定表 |
| **D6** | suspended 独立态（非 running 子态）→ `running===state∈{running,interrupting}` **排除 suspended** → 列表 item spinner 不亮、改亮「?」 | 3-ask §决策锁定表 |
| **A** | 所有 tool 串行；ToolResultBlock 三态 success/pending/fail；pending 带 subState(need_approval/need_feedback) + data | 3-ask §决策锁定表 |
| **handleType** | 回填三分发：`direct_result`（ask-question）/ `approval`（未来 tool-approval）/ `callback`（扩展点） | 3-ask §决策锁定表 |
| **StopReason** | 新增 `tool_pending`（通用，不复用 `require_approval`） | 3-ask §决策锁定表 |
| **放弃** | 提问态无取消/跳过按钮；composer 保持可用；用户直接输入框 query 即放弃（走 c 路径） | 3-ask §决策锁定表 |

## 1. 背景

### 1.1 #1 workspace 多套一层（用户实测 bug）

session 分配目录 `<DATA_DIR>/workspaces/<sessionId>/` 是对的；但 bash/file 工具又 `join(base,'workspace')` 多套一层到 `workspaces/<id>/workspace/`。文件 tab / reminder 告诉 LLM 的工作目录却是**外层** `workspaces/<id>/` —— **告知路径 ≠ 实际落盘路径**。根因在 v0.0.8 历史遗留，对所有 session 一视同仁（非 studio 串台）。

### 1.2 #2 会话列表缺运行中指示器

session 五态中 `state∈{running,interrupting}` 即「运行中」，但列表 item 仅在未读时冒红点；运行中无任何视觉反馈。用户切多个 session 时看不出哪个在跑。

### 1.3 #3 ask-question tool + HITL 蓝图落地

用户需要 LLM 能结构化提问（单选/多选 + 「其他」展开输入框 + 多问题多 tab），并要求**agent loop 不原地等待、能退出**（「等待用户输入」从进程内阻塞变成跨进程/跨设备持久化状态 → 服务端部署 / 多渠道统一架构）。系统已为这套机制预留大量 `[future — 不实现]` 槽位（HITL 蓝图 `agent_hitl.md` / `require_human_input` Event / `ApprovalResultBlock` / `Tool.needsApproval?()`），#3 将其落地为 canonical + 扩展 feedback 分支（ask-question 首消费者，tool-approval 未来复用）。

## 2. 功能需求

### 2.1 [#1] workspace 工具绝对路径修复 [P0]

**描述**：bash/file 工具消费 workspace 路径时去掉多套的 `workspace/` 一层，并要求 `path` 为绝对路径（不再接受相对路径）。LLM 按 reminder（已告知正确外层 `workspaces/<id>/`）自己拼绝对路径。

**用户故事**：作为用户，当我对 LLM 说「把答案写进 a.txt」，我希望文件落在 reminder 告诉我的 `workspaces/<id>/a.txt`，而不是凭空多出一层 `workspaces/<id>/workspace/a.txt` 让我在文件 tab 里找不到。

**期望行为**：
- `bash` 工具 cwd = `session.workspaceDir`（外层绝对，不多层）；LLM 命令可用绝对路径或 `cd`。
- `file` 工具 `path` = 绝对路径；相对路径直接报错（不接受）；沙箱决策见开放点 O1。
- reminder 措辞可选强化（引导 LLM 「file/bash 用绝对路径，基于此工作目录」）。
- 历史已落盘到 `workspaces/<id>/workspace/` 的文件**不迁移**（用户定调「历史不管」）。
- **studio member workspace 同理修好**（同一段工具逻辑）。

### 2.2 [#2] 会话列表 running/suspended 指示器 [P0]

**描述**：playground（main + subagent）和 studio（群聊 + leader + mate）的会话列表 item 上，新增代表「运行中」的旋转环 spinner（session running 时显示），并配合 #3 引入的 `suspended` 态显示「?」指示器（session 等待用户输入时）。

**用户故事**：作为同时挂着多个 session 跑的用户，我希望列表一眼看出哪个还在跑、哪个卡在等我回答，而不是只能看到未读红点。

**期望行为**：
- **running spinner**：`state∈{running,interrupting}` 时显示旋转环；复用 `component-abort-btn.tsx` 的旋转环视觉（`border-t-[var(--color-accent)] animate-spin`）；建议抽共享 `SpinnerRing`（props: size）三处复用，subagent 传更小 size。与 unread 红点错位共存。
- **suspended「?」**：`state==='suspended'` 时显示「?」标记（D6：suspended 独立态排除 running → spinner 不亮）。
- **studio hook 补齐**：`use-studio-unread.ts` 现只取 `unread` 丢了 `running`，需照红点透传路径补提取 `running` + `state`（含 suspended）+ 透传 runningMap/stateMap。
- **布局稳定性（MANDATORY）**：spinner/「?」/红点占位固定，出现消失绝不导致相邻元素位移；预留固定空间或绝对定位。

### 2.3 [#3] ask-question tool + 通用 pending-tool-calls 悬挂机制 [P0]

**描述**：新增 `ask-question` tool（结构化提问，单 tool call 内多问题 = UI 多 tab；每题单选/多选 + 必带「其他」展开输入框；全答完才亮「提交」）。同时把「loop 遇悬挂型 tool → 写 pending 占位 + 入 pendingToolCalls 队列 → 退出 + session=suspended → 回填走 inbox → pre-process 按 handleType 编辑 content block」**落地为通用机制**（ask-question 首消费者，tool-approval 未来复用，仅 interaction 不同）。

**用户故事**：作为用户，当 LLM 需要我从 A/B/C 选一个或勾几个选项时，我希望看到一张清晰的提问卡（不是让 LLM 把题目打在消息流里我再用自然话回），逐题作答后一键提交；且如果中途切走/关 app，回来提问卡要恢复。作为系统设计者，希望 loop 能在「等用户输入」时退出，让服务端部署/多渠道（手机+电脑）统一架构。

**期望行为**（产品语义，实现细节归 architect）：

**① tool result 状态模型扩展**：ToolResultBlock 增顶层 `status: "success" | "pending" | "fail"`；当 `pending` 带细分 `subState: "need_approval" | "need_feedback"`（渲染分发 key，前端弹什么 UI）+ `data: FeedbackData | ApprovalData`（交互载荷）。

**② 串行执行 + pending 收集**：所有 tool call 串行执行（与现 `tool_execution_engine` for...of 一致）。遇悬挂型（`Tool.interaction()` 返回非 null）不真跑、直接生成 pending result（pair 合法，入 transcript）+ 入 `pendingToolCalls` 队列。

**③ session 新增 `suspended` 态（落盘）**：第六态；`running === state∈{running,interrupting}` **排除 suspended**（D6）；`reconcileOnStartup` 必须改：把 suspended 视为合法存活态保留 + 校验 pendingToolCalls 落盘一致（不清 idle）；session_meta 广播含 suspended。

**④ PendingToolCall 完整数据结构（落盘 wrapper）**：Session 新字段 `pendingToolCalls: PendingToolCall[]`（**落盘**）。字段集：定位/配对（sessionId/runId/toolCallId/toolName）+ 处理策略 `handleType: "direct_result"|"approval"|"callback"` + 渲染类型 `subState` + 交互载荷 `data` + 编辑目标（resultMessageId/resultBlockIndex）+ status。详见 3-ask §4。

**⑤ handleType 三分发（回填处理核心）**：回填进 inbox → running → pre-process 按 `toolCallId` 找 pending → 按 handleType 分发：
- `direct_result`：payload 序列化 → 编辑进 result block；`pending→success`（ask-question）。
- `approval`：`allow` 补跑原 tool 拿真实 result 编辑进 block→success；`deny` 拒绝 result→fail（未来 tool-approval）。
- `callback`：调 `tool.onReply?(payload, ctx)` 返回 result → 编辑进 block（扩展点）。
- 三分支后统一：pendingToolCalls 删一条；仍有 pending 则回 suspended + emit 下一个；无则续 LLM。

**⑥ 4 情况映射（req a/b/c/d）**：
- **a 首次产出 n 个 pending**：③ 串行生成各 result → pending 入队 → emit `require_human_input`（队首）→ StopReason=`tool_pending` 退出 + suspended。
- **b 提交后逐条推进**：回填进 inbox → running → pre-process 按 handleType 编辑 block + 删一条 → 还有则 emit 下一个 + suspended；无则续 LLM。
- **c 用户直接对话（= 放弃）**：user query 进 inbox → running → pre-process 检测「有 pending + 是 user query」→ **不编辑**（占位 result 保持 status=pending 原样）→ 清空 pendingToolCalls → 正常处理 query。LLM 看到「需反馈但未反馈」自行判断。pair 合法。
- **d 切换/重启恢复**：重启 reconcile 保留 suspended + 校验落盘；切回前端 peek 队首 + agent_loop SSE sticky replay 重渲染。

**⑦ peek + SSE + 事件 payload**：进 suspended 时 emit `require_human_input`（agent_loop topic，payload 细化为单个 PendingToolCall —— 取代 spec 现有 `{toolCalls[],prompt?}`）；API `GET /session/:id/pending-tool-call` 返回队首（recover 用：切走切回 / 重启后前端主动拉，配合 SSE sticky replay）。

**⑧ 回填消息结构（走 inbox，不独立接口）**：复用 `deliverTo` 统一入口（D3）。pre-process drain 时按 `sender.source` 识别为回填，走编辑流程而非普通 ingest。MessageShape：`{ role:"user", sender:{source:"tool_reply",toolCallId,runId}, content:[{type:"tool_reply",toolCallId,handleType,payload}] }`。

**⑨ ask-question inputSchema（多 tab/多 pending）**：单个 ask-question 内多问题（req L27 问题1标题→问题2标题→提交）= UI 多 tab；多 pending = 多 tool call 并存（§② 的 t2/t3），peek 队首串行展示；**两层不混**（D4）。每题单选/多选 + 必带「其他」（选中展开输入框）。

**⑩ Tool 钩子改造（取代旧 needsApproval）**：`Tool.interaction?(input,ctx): {subType,handleType,data} | null`（null=普通 tool 立即执行）+ `Tool.onReply?(payload,ctx): ToolResult`（仅 callback 需要）。引擎串行执行时：`interaction()` 返非 null → 不真跑、生成 pending result + 入队；返 null → 正常 run。

**⑪ 提问态放弃（无按钮，直接 query）**：无取消/跳过按钮；composer 提问态**保持可用**（不禁用）；用户放弃 → 直接输入框打 query 回车 → 关闭提问框 + 走 c 路径。提问卡唯一出口：**「提交」按钮**（全答完才亮）→ b 路径。

**⑫ transcript 冻结约束（关键实现约束）**：transcript「首次发给 LLM 时冻结」（非写入即冻结）。pending 占位 block 写入后、loop 退出 → 尚未发给 LLM → 编辑有效 → 下一轮 LLM 首次消费时看到真实答案。**实现必须保证：占位 content block 在被 LLM 首次消费前可变**。

**⑬ 前端**：新建**提问卡组件**（复用 `component-enqueue-view` 的「chat-input-bar 内、composer 上方、SSE 驱动」位置与模式）；内部多 tab（questions[]）+ 单选/多选/「其他」展开输入框 + 提交按钮（全答完才亮，无取消按钮）。可见性 = `pendingToolCalls.length>0`（非 `session.running`）。composer 提问态可用。

## 3. 关键用户路径（MANDATORY — 测试最低覆盖要求）

> 每条路径 = 至少一个 AT/ET case 覆盖。

### 3.1 路径清单

| ID | 路径 | 关键断言（落在用户价值） | 类型 |
|----|------|--------------------------|------|
| **P1（#3 主）** | LLM 调 ask-question → 前端弹提问卡（多 tab 多问题）→ 用户逐题答（单选/多选/「其他」展开输入框）→ 提交 → loop 续跑返回结果 | 提问卡按 `pending-tool-call-{toolCallId}` 渲染多 tab；全答完提交按钮才亮；提交后占位 result block 被 LLM 下一轮看到含真实 `selections`；loop 终态 run_end(stopReason=no_tool_call) | AT + ET |
| **P2（#3 多 pending）** | LLM 同时产出多个悬挂 tool call（如一个审批+一个提问，或两个提问）→ 串行展示队首 → 提交后 emit 下一个 → 逐条处理至清空 → 续 LLM | 每次仅展示队首 1 个；提交后 reducer 收 `require_human_input`（下一个 pending）切换；全部 resolved后续 LLM | AT |
| **P3（#3 放弃 c 路径）** | 提问态用户直接输入框发 query → 关闭提问框 + 占位 result 原样发 LLM + 清空 pendingToolCalls + 正常处理 query | 提问卡 unmount；LLM 下一轮看到「need_feedback 但 result 仍 pending 占位」+ 用户新 query；session 走 running → run 处理 query | AT + ET |
| **P4（#3 持久化 d 路径）** | 提问中切走/关 app → 重回 session → 提问卡恢复（peek + sticky replay） | `GET /session/:id/pending-tool-call` 返队首；`session.state==='suspended'`；前端 peek 重渲染提问卡（含用户切走前已填的中间态——若 arch 决定前端缓存则校验，否则后端只保证题目恢复） | AT + ET |
| **P5（#3 StopReason）** | loop 遇悬挂型 tool → StopReason=`tool_pending` 退出 + session=suspended（落盘） | SSE `run_end(stopReason="tool_pending")`；`GET /session/:id` 返 `state:"suspended"` + `pendingToolCalls.length>0` | AT |
| **P6（#3 handleType=direct_result）** | ask-question 提交后，pre-process 按 toolCallId 找 pending → 编辑 transcript 中 resultMessageId 那条 role=tool message 的 content[resultBlockIndex] block（占位→真实答案 + status pending→success） | `GET /messages` 该 tool message 的 content block 含 `selections` 字段 + status=success；pendingToolCalls 该条 status=resolved | AT |
| **P7（#3 reconcile 保留 suspended）** | 构造 suspended + 落盘 pendingToolCalls → 重启 bootstrap → reconcileOnStartup 保留 suspended（不清 idle）+ 校验落盘一致 | 重启后 `GET /session/:id` 返 state=suspended + pendingToolCalls 仍在；打开 session 非虚假 idle | AT |
| **P8（#1）** | LLM 用 file/bash 写文件 → 落盘在 `workspaces/<id>/` 外层（无多余 workspace 层）+ reminder 告 LLM 的路径与实际一致 | 真 LLM 用 file write `/path/to/workspaces/<id>/a.txt` → 文件系统该路径存在；`workspaces/<id>/workspace/a.txt` 不应被自动创建；AT 跑完 `ls workspaces/<id>/` 见 a.txt | AT + ET |
| **P9（#1 相对路径拒绝）** | LLM 传相对路径给 file 工具 → 工具直接报错（不接受相对路径） | file tool result isError=true，错误文案含「绝对路径」相关提示 | AT（mock LLM 构造相对路径调用） |
| **P10（#2 running spinner）** | session 进入 running 态 → 列表 item 显示 spinner（与未读红点错位共存）；进入 suspended 态 → 显示「?」；回 idle → 都消失 | session running 时 DOM 断言 `conv-item-{id}-running-spinner` 出现；suspended 时 `conv-item-{id}-suspended-mark` 出现；idle 时均不出现 | ET + UT |
| **P11（#2 studio 透传）** | studio 群聊/leader/mate session running → 经 session_meta 广播 → studio sidebar item 显示 spinner | `use-studio-unread.ts` 提取 running；studio TreeChild 显示 spinner；红点仍右上角 | ET + UT |

### 3.2 不覆盖项（明确排除 + 理由）

| 排除项 | 理由 |
|--------|------|
| tool-approval 完整审批流（allow 补跑 / deny） | D1 共用 infra 但本版本只交 ask-question 首消费者；approval 留后续版本 |
| handleType=callback 的真实扩展 tool | 仅留扩展点 spec，不交付实例 |
| 提问卡中间态（用户答了一半切走）前端恢复 | 后端只保证题目恢复（peek 队首），「答了一半的草稿」归前端缓存策略，arch 决定 |
| `require_human_input` 旧 `{toolCalls[],prompt?}` payload 向后兼容 | D2 直接细化为单个 PendingToolCall（breaking change，本版本一次性改完） |
| workspace 历史 `workspaces/<id>/workspace/` 文件迁移 | 用户定调「历史不管」，不迁移 |
| #1 file 沙箱（A/B）具体决策 | 开放点 O1，待用户拍板，不影响主线设计 |
| 视觉保真度 compare | 本版本无设计稿，跳过 |
| `component-enqueue-view` 本身重构 | #3 仅复用其位置/驱动模式，新建提问卡组件不替换 enqueue-view |

### 3.3 E2E Use Cases（每路径至少一 case，MANDATORY）

| ID | 用户操作链路 | 预期结果 |
|----|--------------|----------|
| UC-P1 | 新建 session → 发触发 ask-question 的 query → 收 SSE `require_human_input` → 提问卡 mount（多 tab）→ 逐题选/勾/其他展开输入 → 全答完提交按钮亮 → 点提交 → loop 续跑 → run_end → assistant answer 含根据答案的反应 | `pending-tool-call-{toolCallId}` mount → `pending-q-{qId}` 各题渲染 → `pending-submit-btn` disabled→enabled → 提交后 unmount + 对话区续跑 |
| UC-P3 | UC-P1 提问态 → 用户在 composer 输入框打「换个话题 X」回车 → 提问卡 unmount + query 进对话区 → LLM 回复 X 相关内容 | 提问卡 unmount + `msg-user-{newId}` 出现 + answer 跟 X 相关 |
| UC-P4 | UC-P1 提问态 → 切到 session B → 切回 A → 提问卡恢复（题目同切走前）| 切回后 `pending-tool-call-{toolCallId}` 再次 mount + 题目内容一致 |
| UC-P8 | session A → reminder 提示工作目录 `…/workspaces/<idA>` → 发「写 a.txt 到工作目录」→ LLM 调 file write 绝对路径 → 文件 tab 看 `workspaces/<idA>/` 顶层有 a.txt（无多余 workspace 层）| ws-tree 渲染 `workspaces/<idA>/a.txt`；`workspaces/<idA>/workspace/` 目录不存在或无 a.txt |
| UC-P10 | session A running（发触发工具的 query）→ 看 conv-item-A → 出现 running spinner；session B suspended（触发 ask-question）→ 看 conv-item-B → 出现「?」| DOM 断言 `conv-item-A-running-spinner` 存在；`conv-item-B-suspended-mark` 存在；两者与未读红点错位共存 |

## 4. 设计约束 / 不变量（MANDATORY）

| ID | 不变量 | 落实点 |
|----|--------|--------|
| **INV-1** | pending 占位 result 是合法 pair（配对 tool_call），transcript 不破坏 append-only | ③ 写入 pending result（status=pending, content=人话占位）；§7 编辑的是已写入的 block（首次发 LLM 前可变，§15） |
| **INV-2** | `running===state∈{running,interrupting}`（**排除 suspended**）；suspended 独立第六态 | session_state.md §1 扩展；前端 spinner/「?」据此分流 |
| **INV-3** | pendingToolCalls 是 session 持久化字段（落盘），重启存活 | SessionStore 新字段；reconcile 保留 + 校验 |
| **INV-4** | 多 pending 串行展示（peek 队首单条），不同时弹多张卡 | emit `require_human_input` 仅携队首；前端可见性 = pendingToolCalls.length>0 + 渲染 peek 返回的单个 |
| **INV-5** | 回填走 inbox（复用 deliverTo），不独立接口；sender.source="tool_reply" 判别 | POST /messages 扩展 tool_reply 消息类型；pre-process drain 按 source 识别 |
| **INV-6** | transcript content block 在被 LLM 首次消费前可变（占位→真实） | §15 实现约束；append-only 在「首次发给 LLM 时冻结」而非「写入即冻结」 |
| **INV-7** | 提问态 composer 保持可用（用户可发 query 触发放弃） | composer 不禁用；提问卡 + composer 并存 |
| **INV-8** | workspace 路径：reminder 告知 = 工具实际消费（绝对路径，无多余层） | bash cwd=`session.workspaceDir`；file `path`=绝对；reminder 引导 LLM 用绝对路径 |
| **INV-9** | running spinner / suspended「?」/ unread 红点三者占位固定，出现/消失不导致相邻位移 | 预留固定空间（visibility/opacity）或绝对定位；禁 display:none 入常规流 |

## 5. 契约变更面（arch 阶段细化）

### 5.1 API 契约（新增/扩展）

- **新增** `GET /session/:id/pending-tool-call`：返队首 PendingToolCall（recover 用，只读快照）；空队列返 200 + `{pending:null}`。
- **扩展** `POST /session/:id/messages`：支持 `tool_reply` 消息类型（sender.source="tool_reply" + content 含 tool_reply block）。
- **扩展** `GET /session/:id` 响应：含 `state:"suspended"`（第六态）+ `pendingToolCalls: PendingToolCall[]`。
- **不变**：GET /messages / GET /inbox / POST /abort / SSE 三事件 / session_meta 广播 topic。

### 5.2 数据契约

- **新增** Session 字段：`pendingToolCalls: PendingToolCall[]`（落盘）。
- **扩展** ToolResultBlock：顶层 `status: "success"|"pending"|"fail"`；pending 带 `subState: "need_approval"|"need_feedback"` + `data`。
- **新增** PendingToolCall wrapper：§4 定位/策略/渲染/载荷/编辑目标/status 字段集（3-ask §4 完整定义）。
- **新增** ContentBlock 变体：`tool_reply`（携 toolCallId/handleType/payload）。
- **扩展** MessageSender 判别联合：新增 `source:"tool_reply"` 变体（携 toolCallId/runId）。
- **扩展** MessageSource enum：`"user" | "agent" | "approval" | "system" | "tool_reply"`。
- **扩展** StopReason 联合：新增 `"tool_pending"`（不复用 `require_approval`）。
- **改造** Tool 钩子：`needsApproval?()` → `interaction?(input,ctx): {subType,handleType,data}|null` + `onReply?(payload,ctx): ToolResult`。

### 5.3 UI testid 契约（新增，arch 阶段落具体命名）

- **新增** 提问卡：`pending-tool-call-{toolCallId}`（容器）/ `pending-q-{questionId}`（单题）/ `pending-q-{questionId}-option-{key}`（选项）/ `pending-q-{questionId}-other-toggle` / `pending-q-{questionId}-other-input` / `pending-submit-btn`（提交，全答完才 enabled）。
- **新增** 列表指示器：`conv-item-{id}-running-spinner`（running）/ `conv-item-{id}-suspended-mark`（suspended「?」）。
- **不变**：enqueue-view 系列 / chat-abort / chat-send / chat-composer-editor。

### 5.4 UI 组件契约（spec delta，arch 阶段落）

- **新建** `specs/ui/components/chat-page/component-pending-question-card.md`：复用 enqueue-view「chat-input-bar 内、composer 上方、SSE 驱动」位置模式；内部多 tab + 单选/多选/其他 + 提交按钮；可见性=`pendingToolCalls.length>0`；无取消按钮。
- **扩展** `specs/ui/components/chat-page/_overview.md §4.2`：conv-item 加 running spinner + suspended「?」段（错位 unread 红点）。
- **扩展** `specs/ui/components/studio-page/`：studio hook 提取 running + state；TreeChild 渲染 spinner/「?」。
- **扩展** `specs/ui/components/chat-page/component-subagent-tree.md`：SubagentRow 加 running spinner（小 size）。

## 6. spec 对齐核对（MANDATORY — 概念 spec delta 清单）

PRD 引用的组件/接口/概念与已有 `specs/ui/` + `specs/tech/` 对照：

### 6.1 需新增/修改的概念 spec（arch 阶段落，PRD 不擅自发明）

| 层 | 文件 | 新增/修改 | 内容 |
|----|------|-----------|------|
| **tech** | `[P0]agent_hitl.md` | **从 `[future]` 落地为 canonical** | approval 分支落地（A + handleType=approval）；**新增 feedback 分支**（ask-question + handleType=direct_result）；§4a/§4b 流程图按 D1-D5/H1-H5（3-ask §6/§7）改写；去掉 `[future — 不实现]` 标注 |
| **tech** | `[P0]agent_loop_base.md §9` | **扩展 StopReason 联合** | 新增 `"tool_pending"`（不复用 `require_approval`）；区分两者语义：tool_pending=通用悬挂退出 / require_approval=审批专用占位（保留或废弃由 arch 定） |
| **tech** | `[P0]agent_loop_eager_drain.md §4` ③ | **插入悬挂分流** | ③ 工具执行后按 `Tool.interaction()` 分流：返 null 正常 run / 返非 null 生成 pending result + 入队 + StopReason=tool_pending 退出 |
| **tech** | `[P0]agent_event.md §7` | **扩展 RequireHumanInputEvent payload** | 从 `{toolCalls[],prompt?}`（审批向）改细化为 `{pending: PendingToolCall}`（单个队首，承载 need_feedback/need_approval 双分支） |
| **tech** | `[P0]tool_execution_engine.md §5` | **改造钩子** | `Tool.needsApproval?()` → `Tool.interaction?(input,ctx): {subType,handleType,data}\|null` + `Tool.onReply?(payload,ctx)`；执行引擎识别悬挂型生成 pending result 不真跑 |
| **tech** | `[P0]session_state.md §1/§2` | **扩展第六态 suspended** | 五态 → 六态；`running===state∈{running,interrupting}` 排除 suspended；状态机图加 `running --(生成 pending)--> suspended --(回填/query)--> running` 转换；reconcileOnStartup 保留 suspended + 校验 pendingToolCalls |
| **tech** | `[P0]session_store.md §2` | **新增 Session 字段** | `pendingToolCalls: PendingToolCall[]`（落盘）；扩 SessionStateStore API（markSuspended/peekPendingToolCalls 等，arch 定） |
| **tech** | `[P0]agent_message_interface.md §4.10/§5` | **扩展 ContentBlock + Sender** | 新增 `ToolReplyBlock`（或扩 `ApprovalResultBlock` 为通用，arch 定 O4）；MessageSender 判别联合加 `source:"tool_reply"` 变体；MessageSource enum 加 `"tool_reply"` |
| **tech** | `[P0]file_op_tools.md` / `[P0]bash_tools.md` | **同步 cwd/path 语义** | bash cwd=`<workdir>`（不多层）/ file `path`=绝对路径（不接受相对） |
| **api** | `specs/api/overall/04-agent-session.md` | **新增 §3.6** + 扩 §2.3/§3.2 | §3.6 GET /pending-tool-call；§2.3 GET /session 响应 state 含 suspended + pendingToolCalls；§3.2 POST /messages 支持 tool_reply 消息类型 |
| **ui** | `specs/ui/components/chat-page/component-pending-question-card.md` | **新建** | 提问卡组件 spec（位置/多 tab/单选多选/其他/提交/可见性/testid 契约） |
| **ui** | `specs/ui/components/chat-page/_overview.md §4.2/§4.11` | **扩展** | conv-item 加 running spinner + suspended「?」；§4.11 加 pending-question-card 位置段（与 enqueue-view 并存） |
| **ui** | `specs/ui/components/chat-page/component-subagent-tree.md` | **扩展** | SubagentRow 加 running spinner（小 size） |
| **ui** | `specs/ui/components/studio-page/` 相关 | **扩展** | use-studio-unread 提取 running + state；TreeChild/section-studio-sidebar 透传 + 渲染 |
| **tech** | `[P0]chat_area_hooks.md §3` | **扩展 useMessages** | 订阅 `require_human_input` event；onInit 在 GET /messages 后追加 GET /pending-tool-call（seed 提问卡，类比 v0.0.97 GET /inbox seed enqueue） |

### 6.2 发现的 spec↔设计决策不一致（需 doc-modifier 阶段 5 同步）

| 不一致点 | 现状 spec | 本版设计 | 处置 |
|---------|-----------|---------|------|
| HITL 标注 | `agent_hitl.md` 全文 `[future — 不实现]` | 落地为 canonical + 扩 feedback 分支 | doc-modifier 阶段 5 改 spec（去 `[future]` + 加 feedback） |
| Tool 钩子 | `tool_execution_engine.md §5` 用 `needsApproval?(): boolean` | 改为 `interaction?(): {subType,handleType,data}\|null` + `onReply?()` | doc-modifier 阶段 5 改 spec |
| RequireHumanInput payload | `agent_event.md §7` `{toolCalls[],prompt?}` | 改为 `{pending: PendingToolCall}`（单个） | doc-modifier 阶段 5 改 spec（breaking） |
| StopReason | `agent_loop_base.md §9` 含 `require_approval`（永不触发） | 新增 `tool_pending`（通用） | arch 决定 `require_approval` 保留/废弃；doc-modifier 同步 |
| Session 五态 | `session_state.md §1` 五态 | 六态（加 suspended） | doc-modifier 阶段 5 改 spec |
| file/bash path 语义 | 现描述含「相对 workspace」语义痕迹（具体由 arch 核实） | 绝对路径，不接受相对 | doc-modifier 阶段 5 改 spec（对齐代码实际） |
| `component-enqueue-view` 可见性 | `_overview.md §4.11a` 由 `session.running` 驱动 | 提问卡由 `pendingToolCalls.length>0` 驱动（enqueue-view 不变） | 新建 pending-question-card spec；enqueue-view spec 不改 |

## 7. 开放点（arch 拍板，PRD 不预设）

| ID | 开放点 | 备注 |
|----|-------|------|
| **O1** | #1 file 工具沙箱决策（A 保留沙箱根到真实 workspaceDir / B 去掉对齐 bash 无沙箱） | 用户拍板，PRD 不预设 |
| **O2** | 骨架 ③ 精确插入点 + `Tool.interaction`/`onReply` 钩子在 engine 的接线形态 | arch 读代码定 |
| **O3** | 审批型 `allow` 补跑原 tool 的实现（pre-process 内补跑 vs 标记后续执行） | 本版本只交 ask-question（direct_result），但 spec 要为 approval 留位 |
| **O4** | 回填 content block 形态：扩 `ApprovalResultBlock` 为通用 `ToolReplyBlock`，还是按 handleType 分 | arch 定 |
| **O5** | transcript content block 可编辑性的实现保证（§15 约束的落地机制） | arch 定 |
| **O6** | suspended 态与新 inbox（query/回填）的 activate 闸门细节 | arch 定 |
| **O7** | `require_approval` StopReason 保留还是废弃（被 `tool_pending` 取代） | arch 定 |
| **O8** | 提问卡用户答了一半切走是否前端缓存草稿 | YAGNI 倾向不缓存（后端只保证题目恢复）；如用户反馈需要再扩 |
| **O9** | SpinnerRing 是否抽共享组件（vs 各处内联） | coder 实现决策 |

## 8. 回归面（不能回归的既有行为）

| 既有行为 | 验证方式 |
|---------|---------|
| playground/studio 发消息 → agent run → assistant 回复（主对话链路） | AT 现有 chat AT + ET playground chat ET |
| running 时 enqueue 排队 → drain 逐条处理 | AT 现有 enqueue AT + ET v0.0.97 enqueue ET |
| abort run（main + forked） | AT 现有 abort AT |
| 崩溃恢复 reconcile（running/interrupting → idle + Run=interrupted） | AT 现有 reconcile AT（本版扩：suspended 保留） |
| tool_call/tool_result 配对（append-only 不破坏） | AT 现有 tool AT + 中断 in tool 配对 AT |
| workspace 文件读写（file/bash + 文件 tab + lazy watcher） | AT 现有 workspace AT + ET v0.0.17 workspace ET |
| session_meta 广播 + 未读红点（v0.0.27） | AT 现有 unread AT + ET v0.0.27 ET（本版扩：广播含 suspended） |
| studio sidebar 红点透传（v0.0.27/v0.0.28） | ET 现有 studio ET（本版扩：+ running spinner） |
| ChatComposer + @ mention 系统 | ET 现有 mention ET（提问态 composer 不禁用，不影响 mention） |

## 9. 验收标准

- §3.1 路径 P1-P11 各有 AT/ET/UT case 全 pass（#2 按 2-running §决策：UT 必做 + ET 1 case + AT 豁免）
- §6 spec 不一致全部由 doc-modifier 阶段 5 同步
- §8 回归面所有项不回归
- 本文档 §2 三个功能点全部实现 + 通过 code review
- 无设计稿 → 视觉保真度门禁跳过
