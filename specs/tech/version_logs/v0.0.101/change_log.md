# v0.0.101 tech 变更日志（ask-question tool + 通用 pending 悬挂机制 + 列表指示器 + workspace 绝对路径修复）

> 跨版本发布说明（版本轴）。位置轴见各 KB 的 `log.md`。method 级变更契约见 `change_plan.md`（编码硬阻断）。
> 权威 req：`reqs/[done] v0.0.101.ask_question_tool/{1,2,3}-*.md`（#3 决策锁定表最权威）。

## 核心设计原则（index.md ④ 沉淀）

1. **悬挂型 tool 不原地等待**：`Tool.interaction()` 返非 null → 引擎不真跑、生成 pending 占位 result（合法 pair）+ 入 `pendingToolCalls` 队列 → loop `StopReason=tool_pending` 退出 + session=suspended。「等待用户输入」从进程内阻塞变成**跨进程/跨设备持久化状态**（落盘 pendingToolCalls + suspended 态）→ 服务端部署 / 多渠道统一架构的第一性原则。
2. **回填走 inbox（不独立接口）**：用户答案构造 `tool_reply` message（sender.source='tool_reply'）→ `deliverTo(sessionId)` → pre-process 按 `handleType` 编辑已写入的占位 content block（占位→真实 + status pending→success/fail）。复用 inbox 统一入口，不发明新接口。
3. **transcript「首次发给 LLM 时冻结」**（非写入即冻结）：pending 占位 block 写入后、loop 退出 → 尚未发给 LLM → pre-process 编辑有效 → 下一轮 LLM 首次消费看到真实答案。这是「先占位后编辑」在 append-only 规则下成立的唯一前提（实现必须保证）。
4. **handleType 三分发**：direct_result（答案即 result，ask-question）/ approval（allow 补跑 / deny 拒绝，未来 tool-approval）/ callback（tool.onReply 自定义，扩展点）。infra 层只管队列+suspended+peek+匹配，不关心 subType/handleType。
5. **suspended 是合法存活态**（非 idle）：reconcileOnStartup 保留 suspended（不清 idle）+ 校验 pendingToolCalls 落盘一致。`running===state∈{running,interrupting}` **排除 suspended**（D6，列表亮「?」非 spinner）。

## 各 KB 变更（位置轴 = 各 KB log.md 同步一条）

### agent_interface_and_loop

- **`[P0]agent_loop_base.md §9` StopReason 扩展**：新增 `tool_pending`（通用悬挂退出）；**删 `require_approval`**（O7 代决废弃——被 tool_pending 取代，零 emit 永不触发故安全删）。全集改 7→7（替换非新增）。
- **`[P0]agent_hitl.md` 从 `[future]` 落地为 canonical**：approval 分支落地（handleType=approval）+ **新增 feedback 分支**（ask-question，handleType=direct_result）；§1（触发悬挂：③ 段悬挂分流 + emit 队首 + markSuspended）/§2（处理回填：tool_reply 进 inbox → handleToolReply 三分发编辑占位 block + b/c 路径分流）/§3 四情况 a/b/c/d /§4 INV-1..7 全部按 D1-D5/H1-H5（3-ask §6/§7）改写为通用悬挂机制；去掉 `[future — 不实现]` 标注。
- **`[P0]agent_event.md §7 payload + §9 mapping` breaking**：`RequireHumanInputEvent` 从 `{toolCalls:ToolCallBlock[]; prompt?}`（审批向）改细化为 `{pending: PendingToolCall}`（单个队首，承载 need_feedback/need_approval 双分支）；§9 reducer mapping 「require_human_input」描述对齐为「HITL 悬挂：emit 队首 + 前端 mount 提问卡/审批卡」。
- **`[P0]agent_inbox_enqueue.md`**：drain 增 tool_reply 识别（sender.source='tool_reply'）+ toolCallId 匹配 pendingToolCalls + handleType 三分发编辑 content block + pending 分支跳出后续 LLM/工具 + user query 的 c 路径（放弃：占位原样不清 + 清空队列）。
- **`prepareStage 门禁两个对称分支 fix`**（change_plan 模块 E 落地细化，coder 实证发现 + 修复）：
  - **b-path 续跑 fix**（loop-stage-context.ts:96-106）：纯 tool_reply drain（replyResolvedAny=true 且 hitlAfterReplyPending=false，无 user query、无残留 pending）时，占位 block 已编辑但 cursor 未推进（无新 msg id）→ 须 `refreshSnapshotOnly`（clearReplay + assemble + setSystem，不 ingest）刷新 snapshot + 准入门禁加例外 `ingestUpTo===llmUpTo && !replyResolvedAny` 才返 no_new（否则误判 no_new 不调 LLM）。曾致 submit final_assistant_text fail（占位编辑后 LLM 未续跑）。
  - **re-suspend 门禁 fix**（loop-stage-context.ts:107-112）：仍有 pending（hitlAfterReplyPending=true）时 prepareStage 须 `if(state.hitlAfterReplyPending) return 'ok'`（re-suspend 不需 snapshot，run-react-loop.ts:111 段会 break tool_pending→suspended）——本行必须在下面 `!state.snapshot` 门禁**之前**：re-suspend 时 refreshSnapshotOnly 条件漏此分支（仍 pending 不刷 snapshot）→ state.snapshot=null → !snapshot 门禁误返 no_new → onRunEnd markIdle（应 suspended，曾致 multi_pending fail）。
  - **两条 fix 是 prepareStage 门禁的对称分支**（续 LLM / re-suspend），均纳入 `agent_hitl.md §2` 关键点 + INV；架构原则沉淀至 `index.md ④ 14/15/16`。

### session

- **`[P0]session_state.md §1/§2/§3/§5`**：五态 → **六态**（加 `suspended`）；`running===state∈{running,interrupting}` 排除 suspended（INV-2）；状态机图加 `running --(生成 pending)--> suspended --(回填/query)--> running`；`markSuspended` 新 CAS（生产者=onRunEnd stopReason=tool_pending）；`markRunning` WHERE 加 suspended（suspended→running 是回填激活）；`reconcileOnStartup` 保留 suspended + 校验 pendingToolCalls（不清 idle，INV-3）；不变量补 suspended 相关。
- **`[P0]session_store.md §2/§4`**：Session 加 `pendingToolCalls: PendingToolCall[]`（落盘，INV-3）；SessionStore API 扩展 `markSuspended`/`peekPendingToolCall`/`setPendingToolCalls`/`resolvePendingToolCall`。

### tools

- **`[P0]tool_execution_engine.md §2/§4/§5`**：`Tool.needsApproval?():boolean` → `Tool.interaction?(input,ctx): ToolInteraction|null`（null=普通 tool 立即 run）+ `Tool.onReply?(payload,ctx): Promise<ToolRunResult>`（仅 callback）；execute 返签名 `Promise<{results, pending}>`（pending 含 PendingToolCall wrapper）；§5 从「恒跳过」改为「interaction 返非 null → 生成 pending result 不真跑 + 入队」。
- **`[P0]bash_tools.md`**：cwd `<workdir>/workspace` → `<workdir>`（不多层）；description 同步。
- **`[P0]file_op_tools.md`**：path 语义对齐代码实际（**已绝对路径**，`isAbsolute` 校验 + `PATH_NOT_ABSOLUTE` code；req 说的 `resolveInWorkspace` drift 不存在）。

### message

- **`[P0]agent_message_interface.md §4.7/§4.10/§5`**：ToolResultBlock 加顶层 `status:'success'|'pending'|'fail'` + pending 的 `subState`+`data`；新增 `ToolReplyBlock` ContentBlock（tool_reply，携 toolCallId/handleType/payload）；MessageSource enum 加 `'tool_reply'`；MessageSender 判别联合加 `{source:'tool_reply',tool_reply:{toolCallId,runId}}` 变体。

### app/frontend

- **`[P0]chat_area_hooks.md §3`**：useMessages 订阅 `require_human_input` event（payload=pending 单个）→ mount 提问卡；onInit 在 GET /messages 后追加 GET /pending-tool-call（seed 提问卡，类比 v0.0.97 GET /inbox seed enqueue）。

## spec↔code gap（doc-modifier 阶段 5 同步）

| gap | 现状 spec/req | 代码实际 | 处置 |
|---|---|---|---|
| #1 file 工具 path | req 说 `file.ts resolveInWorkspace` join workspace 层 | file-write/read/edit/glob/grep **已绝对路径**（`isAbsolute` 校验 + `PATH_NOT_ABSOLUTE`），无 resolveInWorkspace | #1 实际只剩 bash.ts cwd；doc-modifier 改 spec 对齐 |
| `require_approval` | spec 列为 HITL 占位 | 零 emit | 本版删（O7）；doc-modifier 改 spec |
| studio hook 名 | req 写 `use-studio-unread.ts` | 真名 `use-studio-unread-meta.ts` | 本版按真名；doc-modifier 改 req 引用 |
| `require_human_input` emit | spec「从未 emit」 | grep 实证仅定义处、零 emit | spec 准确，无需改 |

## 待办（非本版）

- `03-llm-chat.md` 已超 300 行，本版只增量不拆，记待办。
- handleType=approval/callback 的真实 tool 实例（D1 共用 infra，留后续版本）。
- 提问卡草稿前端缓存（O8 代决=YAGNI 不缓存，如用户反馈需要再扩）。
