---
type: design
title: Agent Loop — HITL 悬挂型 tool 流程（pending-tool-calls 通用机制，v0.0.101 canonical）
priority: P0
status: active
updated: 2026-07-12
since: v0.0.101
---

# Agent Loop — HITL 悬挂型 tool 流程（pending-tool-calls 通用机制）

> **v0.0.101 落地为 canonical**：原 `[future — 不实现]` 蓝图（approval 分支）落地 + 新增 feedback 分支（ask-question 首消费者）。旧 `needsApproval?(): boolean` 钩子泛化为 `Tool.interaction?(): ToolInteraction | null` + `Tool.onReply?()`；旧 StopReason `require_approval` 被 `tool_pending` 取代（废弃，O7）。
>
> **通用机制**：infra 层只管 `pendingToolCalls` 队列 + suspended + peek + 回填匹配，不关心 subType/handleType。三类 handleType：direct_result（结构化提问，ask-question）/ approval（危险操作审批，**[v0.0.122] 已实例**，首消费者=bash 危险命令审批）/ callback（扩展点，tool.onReply）。完整设计见 `reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md`（决策锁定表最权威）+ `specs/tech/version_logs/v0.0.101/change_log.md`（核心设计原则）+ `change_plan.md`（method 级契约）；approval 策略/审批层设计见 `../tools/[P0]tool_permission.md`。
>
> **引用关系**：上游 `[P0]agent_loop_unified.md`（③ 悬挂分流 + ① 段 HITL 后续 break 分支）；调用方 `../tools/[P0]tool_execution_engine.md §5`（interaction 分流）；消息 `../message/[P0]agent_message_interface.md §4.7/§4.10a`；session `../session/[P0]session_state.md §1`（suspended 第六态）+ `../session/[P0]session_store.md §4`（peek/set/resolve pendingToolCalls API）。**forked loop 不涉及 HITL**（forked 默认无副作用、无交互需求）。

---

## 1. 触发悬挂（§4a — ③ 工具执行后的 pending 退出）

> runReActLoop ③ 段 executeToolsForSpec 返 `{results, pending}`；当 `pending.length > 0` → 落盘 + emit 队首 + 设置 stopReason + break。run 结束后 `MainLifecyclePort.onRunEnd` 据 stopReason=tool_pending 调 markSuspended。

```
┌─→ while (!state.done)
│     │
│     ├─ ① prepareStage ...（略；见 §2 回填处理 / c 路径放弃）
│     ├─ ② callLLM ...（略；产出 ToolCallBlock[]）
│     │
│     ├─ ③ 工具调用（Tool Execution，串行）
│     │    - executeToolsForSpec(spec, toolCalls) → { results, pending }
│     │       每个 call 串行：tool.interaction(input, ctx)
│     │         ├─ 返 null（普通 tool）→ 调 tool.run → 产出 status='success'|'fail' result
│     │         └─ 返非 null（悬挂型）→ 不调 run，buildPendingResult 产出:
│     │              · 占位 ToolResultBlock { status:'pending', content:[人话占位], subState, data }
│     │              · PendingToolCall wrapper（toolCallId/handleType/subState/data/resultMessageId 占位）
│     │    - ingestToolResults(spec, state, results, pending)
│     │       · contextEngine.ingest([tool message]) → 持久化（占位 block 入 transcript，pair 合法 INV-1）
│     │       · 回填各 pending 的 resultMessageId/resultBlockIndex（ingest 后才知 message id）
│     │       · emit clear_replay + tool_result_start/delta/end
│     │       · assemble → 刷新 snapshot（占位 block 现在在 snapshot 内但未发 LLM）
│     │
│     │    - if (pending.length > 0)  // ★ HITL 悬挂分流
│     │       store.setPendingToolCalls(sid, pending)   // 落盘（INV-3）
│     │       emitRequireHumanInput(emitCtx, pending[0])  // 队首（INV-4 peek 串行展示）
│     │       state.stopReason = 'tool_pending'
│     │       state.done = true
│     │       break   // → 跳出 while → onRunEnd → markSuspended
│     │
│     └─ ④ Exit Check ...（略；pending 已 break 不达此）
└── break
    ↓
Loop 结束 → lifecycle.onRunEnd(state)
         → 检测 stopReason='tool_pending' → store.markSuspended(sid, expectedRunId)
         → emit run_end(stopReason: "tool_pending")
```

**关键点**：
- **串行 + 一次性收集**（INV-1）：所有 tool call 全部执行完才判 pending.length>0（不遇悬挂立即退出）；占位 block 全部配对入 transcript。
- **占位 result 进 transcript**：与对应 ToolCallBlock 配对（合法 pair，LLM 下一轮看到「需反馈」状态）。
- **emit 仅携队首**（INV-4）：多 pending 串行展示，前端一次渲染一张卡；resolve 后 emit 下一个。
- **markSuspended 是生产者唯一调用方**（CAS：currentRunId=expected AND state=running → suspended + running=false）。

---

## 2. 处理回填（§4b — tool_reply 进 inbox → pre-process 按 handleType 编辑）

> 用户回填答案 → POST /messages 构造 `tool_reply` message（sender.source='tool_reply'）→ deliverTo(sessionId) → suspended→running → 新一轮 loop ① prepareStage drain 时识别为 tool_reply → handleToolReply 三分发编辑占位 block。其余阶段缩略。

```
┌─→ while (!state.done)
│     │
│     ├─ ① prepareStage（drain inbox → 识别 tool_reply → handleToolReply）
│     │    - drainAndPartition(spec.wireInbox, sid)
│     │      ├─ drained.toolReplyMessages: Message[]（sender.source==='tool_reply'）
│     │      ├─ drained.userMessages / systemMessages（常规分流）
│     │      └─ drained.canceledEnqueueIds
│     │    - emitDrainResult（全量 emit，[v0.0.58.cron-fix]）
│     │    - **优先处理 tool_reply**（在 user query ingest 之前）:
│     │      for tr of drained.toolReplyMessages:
│     │        handleToolReply(spec, tr, spec.wireEmitCtx) → { resolved, stillHasPending }
│     │          1. peek 队首 + 校验 toolCallId 匹配（队首串行展示，INV-4）
│     │          2. 读 resultMessageId 对应 tool message（getMessages by id）
│     │          3. 按 handleType 三分发（§6 of 3-ask-tool req）:
│     │             ├─ direct_result：序列化 payload(FeedbackAnswer) → 编辑 block content + status pending→success
│     │             ├─ approval [v0.0.122 已实例]：payload={decision}
│     │             │    · allow → 补跑原 tool.run（经沙箱）→ 真实 result 编辑 + status→success/fail
│     │             │    · allow_always → 同 allow + ApprovalManager.recordAlways(sid, approvalKey)
│     │             │    · deny → 编辑「用户拒绝执行：{reason}」isError + status→fail
│     │             └─ callback：tool.onReply(payload, ctx) → ToolRunResult → 编辑 block + status pending→success/fail
│     │          4. appendMessages 同 id upsert 写回（store 层 upsert 语义，INV-6 编辑而非 append）
│     │          4.5. emitToolResult(emitCtx, newBlock)（emitCtx 存在时）→ 补发 tool_result_start/delta/end 三帧 SSE（INV-8）
│     │          5. resolvePendingToolCall(sid, toolCallId) → 删一项
│     │          6. peek 队首 → stillHasPending
│     │      state.hitlAfterReplyPending = stillPending（任一条 still pending）
│     │    - ingest + assemble + setSystem + 游标推进（仅 drained.newMessages.length>0）
│     │    - **c 路径检测**（user query 与 pending 共存）:
│     │      if (drained.userMessages.length > 0 && !state.hitlAfterReplyPending):
│     │        head = store.peekPendingToolCall(sid)
│     │        if (head) store.setPendingToolCalls(sid, [])  // 清空队列（占位原样保持，LLM 自判）
│     │        state.hitlClearedPending = true
│     │    - **b 路径 refresh**（仅 tool_reply drain，无 user query）:
│     │      if (replyResolvedAny && !state.hitlAfterReplyPending):
│     │        refreshSnapshotOnly()  // 占位已编辑但游标未推进 → 须 refresh snapshot 让 LLM 看到编辑后内容
│     │
│     ├─ ★ HITL 后续 break 分支（state.hitlAfterReplyPending=true）:
│     │    nextHead = store.peekPendingToolCall(sid)
│     │    if (nextHead) emitRequireHumanInput(emitCtx, nextHead)  // emit 下一个队首
│     │    state.stopReason = 'tool_pending'; state.done = true; break
│     │    （c 路径 hitlClearedPending=true 不 break，正常续 LLM）
│     │
│     ├─ ② callLLM（仅无 pending 残留时）
│     ├─ ③ 工具调用 ...（仅 LLM 产出新 tool call 时）
│     └─ ④ Exit Check ...
│
└── 循环回到 ①
```

**关键点**：
- **回填走 inbox**（INV-5）：`tool_reply` message 经 deliverTo 进 inbox，pre-process drain 时按 sender.source 识别，**不独立接口**。
- **编辑而非 append**（INV-6）：handleToolReply 通过 `appendMessages` 同 id upsert 编辑已写入的占位 block（store 层 upsert 语义），不新建 message。编辑发生在 LLM 首次消费前（loop 退出 → 下轮 pre-process）。
- **持久化后补发 tool_result SSE**（INV-8，[v0.0.124]）：编辑写回后（步骤 4）、resolve 队列前（步骤 5），须经 `emitToolResult(emitCtx, newBlock)` 补发 `tool_result_start/delta/end` 三帧——与正常执行路径（`executeTools` emit）**同构**，前端持久 SSE 通道按 `toolCallId` 定位对应 tool_result part 就地更新（pending→success/fail）。覆盖**全部 handleType 分支**（direct_result/allow/allow_always/deny/callback），在 handleToolReply 统一补，不分 branch。修复：此前 HITL 回填只持久化不推送，前端停留 pending 占位态。
- **handleType 三分发后统一**：resolvePendingToolCall 删一项；仍有 pending → emit 下一个 + suspended；无 → 续 LLM。
- **c 路径占位原样发 LLM**：用户直接 query 时占位 status='pending' 保持原样不清，pair 合法（INV-1）；LLM 看「需反馈但用户未反馈」自判。

---

## 3. 四情况映射（req §8：a/b/c/d）

| 情况 | 触发 | 流程 |
|---|---|---|
| **a 首次产出 n 个 pending** | ③ 串行遇悬挂型 tool（`interaction` 返非 null，如 ask-question）**或** [v0.0.122] 引擎 `checkPermission` 判 ask 且未 isApproved（如 bash 危险命令）| §1：buildPendingResult → setPendingToolCalls + emit require_human_input(队首) + stopReason=tool_pending + suspended。**两种触发殊途同归**：ask-question 的 pending 来自 tool.interaction；approval 的 pending 由引擎把 `PermissionDecision.ask` 翻译成 `ToolInteraction{need_approval, approval}` 后同样走 buildPendingResult（见 `../tools/[P0]tool_permission.md §4`）。 |
| **b 提交后逐条推进** | 用户点「提交」回填 | §2：tool_reply → handleToolReply 三分发编辑 + resolvePendingToolCall → 还有则 emit 下一个 + suspended；无则续 LLM |
| **c 用户直接对话（放弃）** | 用户输 query 回车（提问卡唯一出口=「提交」按钮，无取消） | §2 c 路径：检测 user query + pending 共存 → 不编辑（占位保持 pending）+ setPendingToolCalls([]) + 续 LLM（LLM 自判） |
| **d 切走切回 / 重启恢复** | 重启 / 切回 session | 重启：reconcileOnStartup 保留 suspended + 校验 pendingToolCalls 落盘一致（INV-3）；切回：前端 GET /pending-tool-call peek 队首 + SSE sticky replay 重渲染 |

---

## 4. 核心不变量

- **INV-1（pair 合法）**：每个 pending 占位 ToolResultBlock 都有对应的 ToolCallBlock 配对（LLM 视角合法），即使 status='pending'。c 路径占位原样发 LLM 仍 pair 合法。
- **INV-2（suspended 排除 running）**：`running===state∈{running,interrupting}`，**suspended 排除**。loop 已退出（等用户回填），前端列表亮「?」非 spinner（D6）。
- **INV-3（落盘存活）**：pendingToolCalls 落盘 + suspended 是合法存活态。reconcileOnStartup **保留** suspended + 校验 pendingToolCalls 一致性（空/全 resolved/损坏 → 清空 pending，state 保持 suspended）。
- **INV-4（peek 队首单条）**：多 pending 串行展示，前端一次渲染一张卡；emit require_human_input 仅携队首；resolve 后 emit 下一个。
- **INV-5（回填走 inbox）**：`tool_reply` message 经 deliverTo 复用 inbox 统一入口，**不独立接口**。
- **INV-6（编辑而非 append）**：handleToolReply 通过 store.appendMessages 同 id upsert 编辑已写入的占位 block（transcript「首次发给 LLM 时冻结」非「写入即冻结」，§15 of req 3-ask）。
- **INV-7（composer 提问态可用）**：提问卡 mount 时 composer **不禁用**（用户可发 query 触发 c 路径放弃）；唯一出口=「提交」按钮（b 路径）；无取消按钮。
- **INV-8（emit-after-persist）**：HITL 回填编辑占位 block 后必须补发 tool_result 三帧 SSE（`emitToolResult`），与正常执行路径 emit 同构。持久化正确 ≠ 前端更新——SSE 通道是前端实时刷新的唯一来源，缺 emit 则前端停留 pending 占位（数据虽已落库，只有刷新/重进才恢复）。emit 在持久化之后（保证 SSE 反映的是已落库内容，无脏推）。

---

## 5. （版本史见 `log.md`）
