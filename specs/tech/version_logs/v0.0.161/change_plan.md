# v0.0.161 变更计划书 — 修 queue 消息未入 LLM context bug（drain reissue + appendNew 加固）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 背景（bug 根因 + 修复策略）

**根因**（v0.0.161 states/context.md findings 已锁定）：
1. `agent-loop-stage-pre.ts drainAndPartition` 对 `source==='user'` 分支**保留原 msgId**（HTTP-in 时刻 ulid），只有 agent/system/approval 分支 reissue newId。→ user msgId 锚在 HTTP-in 时钟，而 agent/tool 消息 msgId 锚在 drain 时钟。当排队 user msg 晚于上一 run 结束 drain（其 HTTP-in 时刻 < 上一 run 末尾 assistant/tool 的 drain 时刻），排队 user 的 ulid < 上一 run assistant/tool 的 ulid → transcript 按 ULID 排序时该 user msg 位置错乱到"过去"。
2. `base_builder.appendNew` 用 `lastPrevId` 在 transcript 中定位 + `slice(idx+1)` 切片 → 位置错乱的 user msg 落在切割点之前，被 append 路径漏掉，永久不进 LLM context。rebuild 路径（重装/首次）不受影响 → 用户实测"重装就对了"。

**修复策略（用户裁决 A + B 双修 + 3 项 invariant 硬约束）**：
- **A**（agent-loop-stage-pre）：user 分支也 reissue newId=ulid()，与 agent/system/approval 对称。从源头保证「msgId 顺序 = 实际 drain 处理顺序」。
- **B**（base_builder）：`appendNew` 用 `Set(prev.messages.id)` diff 替 `lastPrevId + slice(idx+1)`；同时保留 mergedPrev 覆盖（orphan_tool_call workaround，`append-tool-pair.test.ts` 场景 B）；引入 `summaryUpTo` cutoff 保 compact 场景不重出 m1..m4。
- **invariants**（用户明确）：
  - I1: `enqueueId` 与 `msgId` **严格独立**（一消息 = 两 ID）；enqueueId 是 inbox/UI 队列 key，msgId 是 transcript key。
  - I2: `message_enqueued` 事件（UI 排队感知）用 enqueueId 作 key，**不带 msgId**（write-in 时刻的 throwaway id 不外泄）。
  - I3: drain 后 msgId 通过 `emitEnqueuedProcessed(enqueueId, newMessageId, role)` 通知 UI 建立 enqueued 项 ↔ transcript msg 的映射（agent/system 分支已在跑此路径，user 分支同轨即可）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（agent-loop / context_assemble / spec / test） |
| 文件路径 | 完整相对路径（worktree 根为准） |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

<!-- 顺序：产品代码（A 修复 → B 修复）→ spec 同步 → UT -->

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-loop | app/server/src/agent/agent-loop-stage-pre.ts | `drainAndPartition` — user 分支（line 115-123） | 修改 | 与 agent/system/approval 分支对称化：`const newId = ulid(); const rewritten = { ...entry.message, id: newId };` 之后 `userMessages.push({enqueueId, message: rewritten})` + `processed.push({enqueueId, messageId: newId, role})` + `newMessages.push(toMessageInput(rewritten))`。**保留** entry.enqueueId 不改（I1 双 ID 独立）；write-in 时刻 entry.message.id 被丢弃（throwaway）。 | MUST reissue newId=ulid(); MUST 保留 entry.enqueueId 原值不变（I1）; MUST NOT 把 msgId 通过 `message_enqueued` 事件回灌 UI（I2 通过 emit contract 保证）; MUST 保持 tool_reply 分支（line 105-114）行为不变（tool_reply 走独立通道，不入 newMessages） | specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §6 drain 侧 cancel 配对 + §6.4 (新增 msgId 分配契约); [P0]agent_loop_eager_drain.md §5.1 drain 描述; 用户裁决 A + I1/I2/I3; context.md findings [orchestrator 00:45] | +6 / -2 |
| agent-loop | app/server/src/agent/agent-loop-stage-pre.ts | `DrainResult` 接口注释（line 25-52） | 修改 | 更新 `userMessages` 字段注释：从「user 保留原 id」改为「user 与 agent/system/approval 对称，drain 时 reissue msgId=ulid()；enqueueId 与 msgId 独立（I1）」。 | MUST 反映 A 修复后的实际语义，避免 spec/代码/注释三者漂移 | 同上 | +4 / -3 |
| agent-loop | app/server/src/handlers/session-messages.ts | `POST /messages` handler — `const msgId = ulid()` (line 228)、`userMsg.id = msgId` (line 230) | 修改 | 加注释说明「HTTP-in 时刻分配的 id 是 throwaway（inbox 需非空 id 字段），drain 时会被 reissue（I1/I3）。不通过 HTTP 响应体外泄 msgId（响应仅 runId + enqueueId）」。**代码逻辑不变**（保持 id: msgId 赋值以满足 inbox schema 非空约束）；仅加注释 + 可选变量重命名 `const transientMsgId = ulid()`。 | MUST NOT 在 HTTP 响应体加 msgId 字段（会破 I2/I3 契约、误导前端提前锁定 id）; MUST NOT 改 activate=false 测试分支的返回（`{runId:'', enqueueId}` 不变） | 用户裁决 I1/I2; specs/api/overall/04-agent-session.md §3.1 POST /messages 响应契约 | +5 / -1 |
| agent-loop | app/plugins/builtins/feishu/feishu-channel.ts | line 265 附近 sender.source='user' 的 message 构造 | 修改 | 加注释：feishu 入口构造的 msg.id 同样是 throwaway，drain 时会被 reissue（与 POST /messages 路径一致）。**代码不变**。 | MUST NOT 改 feishu 消息 sender/content 语义 | 同 session-messages.ts 注释；channel plugin 属外部消息注入通道，走同一 inbox → drain 路径 | +3 / -0 |
| context_assemble | app/plugins/builtins/rocky_context/assemble/base_builder.ts | `appendNew(prevMessages, transcript, summaryUpTo?)` (line 206-216) | 修改 | (1) 函数签名增第 3 个可选参数 `summaryUpTo: string \| null \| undefined`；(2) **保留** `mergedPrev` 覆盖逻辑（orphan_tool_call workaround，见 append-tool-pair.test.ts 场景 B，line 197-201 注释保留）；(3) **替换** `lastPrevId + slice(idx+1)` 为集合 diff：`const prevIds = new Set(prevMessages.map(m => m.id));`；(4) **引入 summaryUpTo cutoff** 保 compact 场景：`const cutoffIdx = summaryUpTo ? transcript.findIndex(m => m.id === summaryUpTo) : -1; const candidateStart = cutoffIdx >= 0 ? cutoffIdx + 1 : 0;`；(5) newOnes = `transcript.slice(candidateStart).filter(m => !prevIds.has(m.id))`；(6) return `[...mergedPrev, ...newOnes]`。 | MUST 保留 mergedPrev 覆盖（不能删，orphan_tool_call 中间态过度清理修复依赖它）; MUST 保 compact 场景不重出 m1..m4（summaryUpTo cutoff 起此作用；纯 set diff 无 cutoff 会让 compact 场景反复加回 m1..m4）; MUST NOT 依赖 msgId ULID 顺序（这是 A 应该保证的、B 是加固层不再假设） | specs/tech/agent/context/[P0]context_assemble_detail.md §2 增量构建 + §6 base_builder 产出结构; base_builder.ts 现注释 line 193-205; append-tool-pair.test.ts 场景 A/B（保留验证）; 用户裁决 B | +12 / -6 |
| context_assemble | app/plugins/builtins/rocky_context/assemble/base_builder.ts | `BaseBuilderReducer.reduce()` (line 86-109) — 调用 appendNew 处 (line 104) | 修改 | `appendNew(prev!.messages, data.transcript)` → `appendNew(prev!.messages, data.transcript, prev!.summary?.summaryUpTo ?? null)`。summaryUpTo 从 prevSnapshot.summary 取，与 shouldRebuild 逻辑同 prev 快照源。 | MUST 从 prev（不是 data.summary）取 summaryUpTo — append 分支下 curVersion === prevVersion 二者相等；从 prev 取更能表达「上一 snapshot 里已折叠边界」的语义 | 同上；shouldRebuild 逻辑参考 base_builder.ts line 90-101 | +1 / -1 |
| spec | specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md | §6 drain 侧 cancel 配对 + 新增 §6.4「msgId 分配契约（v0.0.161）」 | 修改 | (1) §6 伪代码里的「user query → 保留原 id」改为「user query → **重新生成 messageId=ulid()（与 agent/system/approval 对称）** → emit message_* + emit enqueued_message_processed(enqueueId, newId, role) → ingest 用新 id」；(2) 新增 §6.4 双 ID 契约小节：I1 enqueueId ≠ msgId 严格独立；I2 message_enqueued 事件不带 msgId（只带 enqueueId + content + source）；I3 msgId 通过 enqueued_message_processed 通知 UI；(3) 加 v0.0.161 变更记录标签指向 change_log。 | MUST 保留 §5、§7、§10 等其余小节不动; MUST 保 §10 GET /inbox 契约不变（返 InboxItemView 仍是 {enqueueId, content, enqueuedAt}，无 msgId 泄漏） | 用户裁决 A + I1/I2/I3; v0.0.66 append 注释（已存在的 orphan workaround） | +28 / -4 |
| spec | specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md | §5.1 cancel 配对 + drain 全量 emit SSE | 修改 | 更新 drain 伪代码：`user query → emit message_* + emit enqueued_message_processed + ingest 原消息（保留原 id）` → `user query → 重新生成 messageId → emit message_* + emit enqueued_message_processed → ingest 用新 id`（与 enqueued 分支合并成一段，不再区分 user/agent 保留 id 差异）。 | MUST 与 [P0]agent_inbox_enqueue.md §6 描述一致（同一 drain 契约不可有二源） | 同上；本文件是 current mode 不变量契约源 | +3 / -3 |
| spec | specs/tech/agent/context/[P0]context_assemble_detail.md | §2 增量构建（line 72 附近 append 一句） + 新增 §2.6「appendNew 集合 diff + summaryUpTo cutoff（v0.0.161）」 | 修改 | (1) §2 append 一句更新：`appendNew(prev.messages, data.transcript, summaryUpTo)` — 按 id 用 transcript 原始版本覆盖 prev 中已有的 + 集合 diff 追加 summaryUpTo 之后新增的（替旧 lastPrevId slice）；(2) 新增 §2.6 详细算法块 + v0.0.161 bug 复盘：a) 旧 lastPrevId slice 在 msgId 乱序时漏 user msg（依赖 ULID 单调 = drain 顺序 = A 修复的 invariant）b) 新集合 diff + summaryUpTo cutoff 双保险：即使 msgId 顺序被打破，也不会误裁 c) mergedPrev 覆盖逻辑保留（orphan_tool_call 中间态 workaround，见 §？引用 append-tool-pair.test.ts）。 | MUST 保 mergedPrev 覆盖描述; MUST 说明 A 与 B 的关系（A 是根治，B 是加固） | 用户裁决 B; base_builder.ts line 193-205 注释; append-tool-pair.test.ts 场景 B | +32 / -2 |
| spec | specs/tech/agent/message/[P0]agent_message_interface.md | 新增小节「§7 message.id 分配时机（drain 权威）」（现有文件末尾附加，或插入 §7 位置） | 新增 | 声明契约：(a) message.id 分配唯一权威源 = `drainAndPartition` 阶段 `ulid()`（不论 source=user/agent/system/approval/tool_reply）；(b) HTTP-in / channel-in / tool-emit 时刻分配的 id 是 **throwaway 占位**（inbox schema 非空约束），drain 时被 reissue；(c) enqueueId 与 msgId 严格独立（enqueueId = inbox 队列 key + UI 排队感知 key；msgId = transcript key + LLM context key）；(d) tool_reply 分支例外：不进 transcript，其 id 通过 `emitEnqueuedProcessed` 通知 UI 完成占位 block 编辑归属。 | MUST 明确「msgId = ULID 且 = drain 时刻分配」，为 base_builder.appendNew / logical-view / observability 提供硬 invariant | 用户裁决 I1/I2/I3; 与 [P0]agent_inbox_enqueue.md §6.4 交叉引用 | +26 / -0 |
| test | app/server/src/agent/__tests__/drain-and-partition-sender.test.ts | 新增 case: 「source=user 消息 drain 后 msgId 被 reissue，enqueueId 保持原值（I1 双 ID 独立）」 | 修改 | 在现有 `describe` 尾部新增 `it` case：构造 `userMsg` 带原 id `01USERMSG0001`、enqueueId 由 inbox 分配；drain → 断言 `result.userMessages[0].message.id !== '01USERMSG0001'`（reissue 生效） + `result.userMessages[0].enqueueId === <原 enqueueId>` + `result.processed[0].messageId === result.userMessages[0].message.id` + `result.newMessages[0].id === result.userMessages[0].message.id`（三处一致）。 | MUST 不改现有 3 个 case 通过（现有 case 只 assert sender 透传，未 assert id 保留，可继续通过） | drainAndPartition A 修复; I1/I2/I3 | +38 / -0 |
| test | app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts | 新增 case 「场景 C：msgId 乱序的 user msg（v0.0.161 bug 复现 + B 修复验证）」 | 修改 | 场景：prev.messages = [u1, a1(含 tool_call), t1]（Round N 完整 tool 配对），transcript = [u1, a1, t1, u_new, a2]，**但 u_new.id 故意置为 `01AA...`（ULID 字典序 < a1.id `01BB...`）**——模拟 v0.0.161 bug（user msg id 早于上一 run assistant）。旧实现（lastPrevId slice）会漏 u_new；新 appendNew 集合 diff 应产出 [u1, a1, t1, u_new, a2]（u_new 与 a2 都不在 prevIds → 都进 newOnes）。断言：`finalMessages.find(m => m.id === u_new.id)` 存在 + `finalMessages.find(m => m.id === 'a2')` 存在 + tool 配对完整（a1 tool_call + t1 tool_result）。 | MUST 不改现有场景 A/B 通过（B 修复保留 mergedPrev 覆盖）; MUST 用 mkCtx(prev, summaryUpTo=null) — 本场景无 compact | append-tool-pair.test.ts 现场景 A/B; base_builder.ts appendNew 新逻辑 | +42 / -0 |
| test | app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts | 新增 case 「场景 D：compact 场景下 appendNew summaryUpTo cutoff 正确」 | 修改 | 场景：prev.messages = [summary:v1 (id='summary:1'), m5, m6, m7]，summaryUpTo='m4'，transcript = [m1..m7, m8]。断言：appendNew 输出 = [summary:v1, m5, m6, m7, m8]（不重新加 m1..m4；m5/m6/m7 因在 prevIds 被过滤；m8 是 summaryUpTo 之后且不在 prev → 进 newOnes）。**若不加 summaryUpTo cutoff（纯 set diff），会产出 [summary:v1, m5, m6, m7, m1, m2, m3, m4, m8] — 本 case 防此回归**。 | MUST 断言 m1..m4 不出现在输出（compact 折叠语义不可破） | context_assemble_detail §2.6; base_builder.ts appendNew 签名新增 summaryUpTo 参数 | +45 / -0 |
| test | app/server/src/agent/__tests__/agent-loop.test.ts 或新增 `agent-loop-user-msg-reissue.test.ts` | 新增 UT 「用户排队消息 msgId 与 assistant/tool msgId 单调递增（drain 顺序不变量）」 | 新增 | 高一层集成 UT：构造 session，enqueue 1 条 user msg (throwaway id 'AA')，等到 drain 后拿到 rewritten id (new_ulid)；再 enqueue 第 2 条 user msg (throwaway id 'BB')，drain 后拿到 new_ulid_2。断言 `new_ulid < new_ulid_2`（drain 时钟顺序 = msgId 顺序）。**验证 A 修复在真实 drain 路径生效**（drain-and-partition-sender.test.ts 只测纯函数、不测 drain-完成后 emit chain）。 | MUST 用 fake ulid mock 若需确定性（或用 real ulid + 相对顺序断言）; MUST 不启真 LLM（走 stub） | A 修复的运行时 invariant 验证 | +60 / -0 |
| spec | specs/tech/version_logs/v0.0.161/change_log.md | 新增文件 change_log.md | 新增 | 落 v0.0.161 change log（bug 根因 + 修复策略 + 5 个 spec 更新点 + 5 个 UT 新增点的 roll-up 描述）。由 doc-modifier 阶段 5 完成，本 change_plan 里只标产出预期，不由 coder 写。 | MUST 由 doc-modifier 写，不由 coder 写（coder 只写代码 + UT） | CLAUDE.md 阶段 5 doc-sync 强制项 | +80 / -0 |

## 影响面评估

### 跨模块

| 模块 | 影响 |
|---|---|
| agent-loop（server） | agent-loop-stage-pre.ts drainAndPartition user 分支；session-messages.ts + feishu-channel.ts 注释澄清 |
| context_assemble（plugin） | base_builder.ts appendNew 签名 + 逻辑 |
| spec 权威源 | agent_inbox_enqueue / agent_loop_eager_drain / context_assemble_detail / agent_message_interface — 都是 P0 spec |
| UT | drain 层 + append 层 + 集成层各一/两条 |

### 破坏性 / 兼容性

- **前端**：**零破坏**。message_enqueued 事件契约不变（无 msgId 字段），POST /messages 响应契约不变（无 msgId 字段），GET /inbox 契约不变。前端 reducer 消费 enqueueId 作 key，msgId 在 emitEnqueuedProcessed 到达时才与 enqueueId 建立映射——本机制未变。
- **持久化 record**：不影响历史 record。旧 session（未走本修复）的 msg id 已落 store，本修复只影响未来 drain（新入队 user msg 走 reissue）。
- **auto-naming**：`triggerIfFirstQuery` 在 POST /messages 里 fire-and-forget 触发（session-messages.ts:249），走独立 LLM 调用（不进主 loop drain 链路），**不受 A 影响**。auto-naming 用 `plainText` 而非 msgId，msgId 是否 reissue 无关。
- **tool_reply**：drain 独立分支（line 105-114，`source==='tool_reply'`），本次修改**不动 tool_reply 分支**——tool_reply 消息不入 newMessages/userMessages/systemMessages，其 id 用作占位 block 编辑归属，行为保留。
- **agent/system/approval 分支**：本已 reissue，与 A 修复对称化后逻辑不变。
- **feishu / 其他 channel plugin**：sender.source='user' 走 user 分支，A 修复后同样 reissue msgId — 与产品行为对齐（channel 入口的 id 本就是 throwaway）。

### 依赖顺序

1. **产品代码先**（A + B 可并行独立 task；drainAndPartition 与 appendNew 无相互依赖）
2. **UT 与产品代码同 task**（coder 边写边补 UT）
3. **Spec 由 doc-modifier 阶段 5 统一同步**（本 change_plan 已列 5 个 spec 更新点，doc-modifier 按此清单执行；coder 只按 change_plan 写代码 + UT，不改 spec）

### 风险点

1. **appendNew signature 变更** — `summaryUpTo` 是新可选参数。若有其他 caller（当前只有 BaseBuilderReducer.reduce），须确认无其他调用点。grep `appendNew(` 无外部调用 → OK。
2. **`session-messages.ts` throwaway msgId 变量重命名**（transientMsgId）— 仅注释性调整。若怕破 grep/审查连续性可保 `msgId` 名 + 加注释。**coder 决定权 = 保留 msgId 变量名 + 加注释即可**（低风险）。
3. **UT append 场景 D compact 反例**必须实测——纯 set diff 会让 m1..m4 反复回来。cutoff 引入必须由 UT 断言防回归。
4. **spec 落后风险**：doc-modifier 阶段 5 若漏改任一 spec 点，将造成「spec 声明保留原 id、代码 reissue」漂移。已把 4 个 spec 更新明列于变更清单，reviewer 阶段核对。

### 无关模块（不动清单）

- **UI**（`app/web/`）：零改动。前端 message_enqueued / enqueued_message_processed / enqueued_message_canceled 消费链路未变。
- **store schema / DB**：零改动。msg 落库 schema 不变，只是落库时用的 id 现在 = drain reissue 后的 id（HTTP-in 的 throwaway id 从未落库过——从来只到 inbox，不到 sessionStore）。
- **API 契约**：`specs/api/overall/04-agent-session.md §3.1 POST /messages` 响应体不变（{runId, enqueueId}），本修复不新增 field。
- **ingest 链路**：`contextEngine.ingest(newMessages, ...)` 消费 newMessages — 只要 A 修复后 newMessages 里的 id 正确（reissue 后的），ingest 无需改。
- **compact 链路**：base_builder rebuild 路径不受 B 影响（rebuild 走 buildRebuild，不进 appendNew）。summaryUpTo 语义不变。
- **HITL / cancel / tool_reply**：drain 独立分支未动。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **本 change_plan 关键 invariant**（reviewer 必查）：
  1. drainAndPartition user 分支必 reissue newId=ulid()（不再保留 entry.message.id）
  2. userMessages / processed / newMessages 三处的 messageId 值必一致（都是同一个 newId）
  3. enqueueId 不参与 reissue（保 entry.enqueueId 原值不变）
  4. message_enqueued 事件不新增 msgId 字段
  5. base_builder.appendNew 保留 mergedPrev 覆盖 + 新增 summaryUpTo cutoff + 用集合 diff 替 slice
  6. spec 4 处更新与代码 100% 对齐（doc-modifier 阶段 5 核对）
