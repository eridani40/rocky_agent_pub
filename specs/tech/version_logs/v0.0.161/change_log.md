# v0.0.161.message_bug — 变更日志

> 版本主题：修 queue 消息未入 LLM context bug（prod session `01KXNP8XD9N6ZY2PX4XJJ0FHBM` 22 条 user msg 只 2 条入 LLM context）。**A + B 双修 + 3 项 invariant 硬约束**：A = drainAndPartition user 分支同轨 reissue msgId（对称化，根治）；B = base_builder.appendNew 集合 diff + summaryUpTo cutoff 替 lastPrevId slice（加固）；I1/I2/I3 = enqueueId ↔ msgId 严格独立契约。
>
> 详细变更契约见同目录 `change_plan.md`（14 行 method 级）；本 log 记录 change_plan 未覆盖的连带处理 + 已同步 spec 偏离 + spec-code 一致性验证结论。

## 1. bug 根因

**prod 症状**（session `01KXNP8XD9N6ZY2PX4XJJ0FHBM`）：queue 消息持久化 + 视图展示 OK，但对比 langfuse 拉的 messages（LLM 实收 context）发现至少 4+ 条 user 追加消息在 messages.log 里完全找不到（如「只有我一个。开始招人..」/「Y」/「you」/「三人全部部署..」）。

**双问题联合触发**：
1. **drainAndPartition user 分支保留原 msgId**（`agent-loop-stage-pre.ts` line 115-123 旧代码）：source='user' 消息 drain 时**保留 entry.message.id**（HTTP-in 时刻分配的 ulid），只有 agent/system/approval 分支 reissue `newId=ulid()`。→ **user msgId 时钟锚在 HTTP-in、其他消息 msgId 时钟锚在 drain**。排队 user msg 晚于上一 run 结束 drain 时（其 HTTP-in 时刻 < 上一 run 末尾 assistant/tool 的 drain 时刻），排队 user 的 ULID < 上一 run assistant/tool 的 ULID → transcript 按 ULID 排序时该 user msg 位置错乱到"过去"。
2. **base_builder.appendNew 用 lastPrevId 切割**（`base_builder.ts` line 206-215 旧代码）：`newOnes = transcript.slice(idx+1)`，`idx` 是 `lastPrevId`（prev.messages 最后一个 id）在 transcript 中的位置。上一 run 期间入队的 user msg，因其 msgId 位置错乱到 `< idx+1` → 被裁掉不进 newOnes → 永久不进 LLM context。rebuild 路径（首次进来 / summary version 变）走 `[...transcript]` 全量，不受影响 → 用户实测「重装就对了」。

**证据链**（prod session 快照分析）：
- 22 条 user msg 全部 runId=None（user 消息不挂 runId），tool_call/tool_result 45/45 无 dangling（排除假设 C 孤儿裁剪）。
- 按 ULID 混排 run_start + user_msg：run#6 `01KXNQMN5A` < user `01KXNQMN5Q`（+45ms）< user `01KXNQMV87`（+6s），run#7 骤降 contextWindowUsage 20k 印证 assemble 丢消息。
- rebuild 路径不受影响；实测「重装对了」。

## 2. 修复策略（用户裁决 A + B 双修 + I1/I2/I3）

### A（agent-loop-stage-pre.ts）— drain 对称化 reissue

user 分支同样 reissue `newId=ulid()`，与 agent/system/approval 对称。三处 push 用同一 newId：`userMessages`（emit message_*）+ `processed`（emit enqueued_message_processed）+ `newMessages`（ingest transcript）。从源头保「msgId 顺序 = 实际 drain 处理顺序 = transcript 时间顺序」。

**代码定位**：`app/server/src/agent/agent-loop-stage-pre.ts` line 124-139。

```typescript
if (source === 'user') {
  const newId = ulid();                                          // v0.0.161 新增
  const rewritten: Message = { ...entry.message, id: newId };    // v0.0.161 新增
  result.userMessages.push({ enqueueId: entry.enqueueId, message: rewritten });
  result.processed.push({ enqueueId: entry.enqueueId, messageId: newId, role: rewritten.role });
  result.newMessages.push(toMessageInput(rewritten));
}
```

### B（base_builder.ts）— appendNew 集合 diff + summaryUpTo cutoff

`appendNew(prev, transcript, summaryUpTo?)` 三参签名：
1. **保留** mergedPrev 按 id 覆盖逻辑（v0.0.66 orphan_tool_call workaround，`append-tool-pair.test.ts` 场景 B 验证）。
2. **替换** `lastPrevId + slice(idx+1)` 顺序切片为 `Set(prevIds)` 差集：`newOnes = transcript.slice(candidateStart).filter(m => !prevIds.has(m.id))`。
3. **引入** `summaryUpTo` cutoff（`candidateStart = cutoffIdx + 1`）保 compact 场景不重出 m1..m4——纯 set diff 会让已折叠段被当"新增"重加，必须 cutoff。

**代码定位**：`app/plugins/builtins/rocky_context/assemble/base_builder.ts` line 220-241 `appendNew` 三参签名 + line 104-106 `BaseBuilderReducer.reduce` 从 `prev!.summary?.summaryUpTo ?? null` 传参。

### A 与 B 双修关系

- **A 是根治**：修复源头 msgId 分裂时钟，恢复 base_builder 对 msgId 单调的 invariant 假设。所有下游（transcript 排序、logical-view 组装、observability 关联）自动受益。
- **B 是加固**：即使未来其他 assemble 路径打破 msgId 顺序 invariant（如新增外部 message 注入通道），本函数不再假设顺序，靠集合 diff 正确追加。
- **单独 A 或单独 B 都不够**：单独 A 不加 B，未来任何一处漏 reissue 又踩同样坑；单独 B 不加 A，drainAndPartition 里的时钟分裂对 logical-view/observability 仍有影响。

### 3 项 invariant（I1/I2/I3）

- **I1（严格独立）**：`enqueueId` 与 `messageId` 是两个独立 ULID——enqueueId 是 inbox 队列 key + UI 排队感知 key，messageId 是 transcript key + LLM context key。语义不同、生命周期不同，一消息 = 两 ID。
- **I2（write-in msgId throwaway 不外泄）**：`POST /messages` 响应体、`message_enqueued` SSE、`GET /inbox` 三处均不带 msgId 字段。write-in 时刻分配的 msgId 仅满足 inbox schema 非空约束，drain 时被完全丢弃。
- **I3（drain 后 msgId 通过 emitEnqueuedProcessed 通知 UI）**：所有 processed 分支（user/agent/system/approval）产出 newId=ulid()，通过 `emitEnqueuedProcessed(enqueueId, newId, role)` 事件外泄给前端建立 `enqueueId ↔ msgId` 映射。前端 enqueue-view reducer 收到事件移除排队项，同时把 messageId 归属到 transcript message。

## 3. 5 处 spec 更新点 roll-up

| # | spec 文件 | 变更 |
|---|---|---|
| 1 | `specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md` | §6 drain 侧 cancel 配对：user query 分支从「保留原 id」改为「与 agent/system/approval 对称化 reissue newId=ulid() → emit message_* + emit enqueued_message_processed(enqueueId, newId, role) → ingest 用新 id」。新增 §6.4「msgId 分配契约（v0.0.161）」：I1 enqueueId ≠ msgId 严格独立、I2 write-in msgId throwaway 不外泄（三处：HTTP 响应 / message_enqueued SSE / GET /inbox）、I3 drain 后通过 emitEnqueuedProcessed 通知 UI。tool_reply 分支例外说明（不进 transcript、不 reissue）。含代码定位 line 编号（drainAndPartition line 124-152、session-messages.ts line 228-235、feishu-channel.ts line 265、emitEnqueuedProcessed line 174-187）。frontmatter updated → 2026-07-17。 |
| 2 | `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md` | §5.1 drain 描述：正常 processed 分支由「user query 保留原 id / enqueued 重新生成 id」改为「四分支统一 reissue newId=ulid() + emit enqueued_message_processed(enqueueId, newId, role) + ingest 用新 id」。加 v0.0.161 说明段指向 `[P0]agent_inbox_enqueue.md §6.4`（同一 drain 契约不可有二源）。frontmatter updated → 2026-07-17。 |
| 3 | `specs/tech/agent/context/[P0]context_assemble_detail.md` | §2 append 一句更新：签名 `appendNew(prev.messages, data.transcript, summaryUpTo)` — 集合 diff + summaryUpTo cutoff（替旧 lastPrevId slice）。新增 §2.6「appendNew 集合 diff + summaryUpTo cutoff（v0.0.161）」：签名 + 算法伪码 + mergedPrev 覆盖保留说明 + 集合 diff 加固 + v0.0.161 bug 复盘 + A（drain 对称化）与 B（appendNew 集合 diff）双修关系 + 纯 set diff 不安全的 compact 场景反例（必须 cutoff）+ caller 从 prev 快照取 summaryUpTo 语义。frontmatter updated → 2026-07-17。 |
| 4 | `specs/tech/agent/message/[P0]agent_message_interface.md` | 新增 §7「message.id 分配时机（drain 权威 — v0.0.161）」：msgId 唯一权威源 = drainAndPartition + ulid()；四条契约 (a) 分配唯一权威源 (b) write-in throwaway 不外泄 (c) enqueueId 与 msgId 严格独立（含 I3 emitEnqueuedProcessed 映射机制）(d) tool_reply 分支例外；下游约束（base_builder.appendNew / logical-view / observability 都依赖 msgId ULID 单调 = drain 顺序 invariant）；与 `[P0]agent_inbox_enqueue.md §6.4` 交叉引用。frontmatter updated → 2026-07-17。 |
| 5 | 3 个 KB `index.md` 原则/概念表更新 | `agent_interface_and_loop/index.md ④` 新增第 19 条原则「[v0.0.161] drain 是 msgId 分配唯一权威源（enqueueId ↔ msgId 严格独立）」；`context/index.md ④` 新增第 16 条原则「[v0.0.161] appendNew 集合 diff + summaryUpTo cutoff」；`message/index.md ④` 新增第 6 条原则「[v0.0.161] message.id 分配时机 = drain 权威（write-in 是 throwaway 占位）」。frontmatter updated → 2026-07-17。 |

## 4. 5 个 UT 新增点 roll-up

| # | 文件 | case | 覆盖点 |
|---|---|---|---|
| 1 | `app/server/src/agent/__tests__/drain-and-partition-sender.test.ts` | 「source=user 消息 drain 后 msgId 被 reissue，enqueueId 保持原值（I1 双 ID 独立）」 | user 分支 reissue + userMessages.message.id / processed.messageId / newMessages.id 三处一致 + enqueueId 保原值 |
| 2 | `app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts` | 场景 C「msgId 乱序的 user msg（v0.0.161 bug 复现 + B 修复验证）」 | 构造 u_new.id 字典序 < a1.id，旧实现漏、新集合 diff 保留（同时 tool 配对完整） |
| 3 | `app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts` | 场景 D「compact 场景 appendNew summaryUpTo cutoff 正确」 | prev=[summary:v1, m5, m6, m7]/summaryUpTo=m4/transcript=[m1..m8]，断言输出不含 m1..m4——防「后来有人删掉 cutoff 退回纯 set diff」回归 |
| 4 | `app/server/src/agent/__tests__/agent-loop-user-msg-reissue.test.ts`（新增文件） | 「用户排队消息 msgId 与 assistant/tool msgId 单调递增（drain 顺序不变量）」 | 集成 UT：连续 enqueue 2 条 user msg → 分别拿到 new_ulid_1 < new_ulid_2，验证 A 修复在真实 drain 路径生效 |
| 5 | UT-5「真实 session 回归金标」（app/plugins/builtins/rocky_context/__tests__/append-real-session.test.ts 或同类文件） | 用 `verify/snapshots/prod_01KXNP.../transcript` 真实 fixture 逐 msg checkpoint 回放 | 旧实现 dropped=3 / 新实现 dropped=0；fixture 用 `fileURLToPath(import.meta.url)` 派生绝对路径（防 merge 后失效） |

**存量 UT 同步**（3 处，修复正确性收益连带触发）：
- `assemble-reducers.test.ts:P0-1` 加 `summary.summaryUpTo='m1'`（原隐式依赖 lastPrevId slice 排除 m1）。
- `drain-emits-all-sources.test.ts:混合批` case 由「user 保留原 id、cron 重写」改为「三分支全 reissue、原 id 都不出现」。
- `drain-tool-reply-and-c-path.test.ts:混合 drain` case 由「user id === '01USERMSG0001'」改为「user id !== '01USERMSG0001' + 26 位新 ulid + newMessages.id === userMessages.id」。

## 5. 已同步的 spec 偏离

无。change_plan §背景 + §变更清单已列全 5 处 spec 变更点（4 spec 主体 + change_log）；doc-modifier 逐项按 change_plan 执行完成，无新增未列偏离。

## 6. 各 KB `log.md` 追加

- `specs/tech/agent/agent_interface_and_loop/log.md` — 追加 v0.0.161 条（§6 drain user 分支同轨 + §6.4 msgId 分配契约 I1/I2/I3）
- `specs/tech/agent/context/log.md` — 追加 v0.0.161 条（§2 append 一句 + §2.6 集合 diff + summaryUpTo cutoff）
- `specs/tech/agent/message/log.md` — 追加 v0.0.161 条（§7 message.id 分配时机 drain 权威 + 4 条契约）

## 7. 代码-spec 一致性验证结论（MANDATORY）

按 orchestrator 委派要求逐项验证「代码实现 == spec 契约」：

| 契约点 | 验证方法 | 结论 |
|---|---|---|
| drainAndPartition user 分支 reissue newId=ulid() | 读 `app/server/src/agent/agent-loop-stage-pre.ts` line 124-139 | ✅ user 分支 `const newId = ulid(); const rewritten = { ...entry.message, id: newId };` 后三处 push 用同一 newId（userMessages line 133 / processed line 134-138 / newMessages line 139），与 spec §6 伪代码 + §6.4 (a)(b)(c) 契约完全一致 |
| userMessages / processed / newMessages 三处 messageId 一致 | 同上 | ✅ 三处都 push 用同一 newId（line 133 message.id / line 136 messageId / line 139 toMessageInput(rewritten).id），无分裂 |
| enqueueId 保留 entry.enqueueId 不变（I1） | 读 line 133 / 135 | ✅ userMessages / processed 都 `enqueueId: entry.enqueueId`（原值不变） |
| message_enqueued 事件不新增 msgId 字段（I2） | grep `emitMessageEnqueued` `app/server/src/agent/agent-manager.ts` line 528-539 | ✅ 事件 payload `{type, enqueueId, role, content, source}` 无 msgId 字段（本次未改动） |
| GET /inbox 契约不带 msgId（I2） | 读 `app/server/src/handlers/session-inbox.ts` / spec §10.2 InboxItemView | ✅ InboxItemView = {enqueueId, content, enqueuedAt}（无 msgId 字段） |
| POST /messages 响应不含 msgId（I2） | 读 `app/server/src/handlers/session-messages.ts` handler 返回体 | ✅ 响应仅 `{runId, enqueueId}`（session-messages.ts:235 附近） |
| emitEnqueuedProcessed 签名 (ctx, enqueueId, messageId, role)（I3） | 读 `app/server/src/agent/agent-loop-emitters.ts` line 174-187 | ✅ 签名与 spec §6.4 I3 描述完全一致；事件体含 messageId + enqueueId + role 三字段 |
| base_builder.appendNew 三参签名 (prev, transcript, summaryUpTo?) | 读 `app/plugins/builtins/rocky_context/assemble/base_builder.ts` line 220-224 | ✅ 签名 `function appendNew(prevMessages: Message[], transcript: Message[], summaryUpTo?: string \| null): Message[]` 与 spec §2.6 描述完全一致 |
| appendNew 保留 mergedPrev 按 id 覆盖 + 集合 diff + summaryUpTo cutoff | 读 line 227-240 | ✅ line 228 `mergedPrev = prevMessages.map(m => transcriptById.get(m.id) ?? m)`（保留）+ line 230 `prevIds = new Set(...)` + line 233-235 cutoffIdx + line 237-239 集合 diff filter，与 spec §2.6 算法伪码完全一致 |
| BaseBuilderReducer.reduce 从 prev 快照取 summaryUpTo 传参 | 读 line 104-106 | ✅ `appendNew(prev!.messages, data.transcript, prev!.summary?.summaryUpTo ?? null)` 与 spec §2.6 caller 调用一致（从 prev.summary 取，非 data.summary） |
| tool_reply 分支不受 A 修改影响 | 读 agent-loop-stage-pre.ts line 114-123 | ✅ tool_reply 独立分流，push toolReplyMessages（不入 newMessages）+ processed 用 entry.message.id（不 reissue），与 spec §6.4 (d) 描述一致 |

**无发现代码偏离 spec 的新情况**。所有 change_plan 覆盖的变更、3 处代码修改重点、4 处 spec 更新点均已在代码中实现并在 spec 中同步描述。

## 8. 值得 orchestrator 关注的隐藏问题

**无**。本版本 doc-sync 阶段一次跑通：
- 4/4 spec 更新点全部修完 + 3 KB log.md 追加 + 3 KB index.md ④ 原则新增；
- 代码-spec 一致性验证 11 项全绿，无新偏离；
- context.md findings 已包含用户裁决口径（A + B 双修 + I1/I2/I3）+ code-reviewer 6 invariant 全过 + AT 冒烟回归 5/5 pass，doc-modifier 阶段无需再增裁决。

## 9. 交付摘要

- **修改 spec**：
  - `specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md`（§6 + 新增 §6.4）
  - `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md`（§5.1）
  - `specs/tech/agent/context/[P0]context_assemble_detail.md`（§2 一句 + 新增 §2.6）
  - `specs/tech/agent/message/[P0]agent_message_interface.md`（新增 §7）
- **追加 KB log**：`agent_interface_and_loop/log.md` + `context/log.md` + `message/log.md`
- **KB index 原则**：`agent_interface_and_loop/index.md ④` 加第 19 条 + `context/index.md ④` 加第 16 条 + `message/index.md ④` 加第 6 条
- **新建**：`specs/tech/version_logs/v0.0.161/change_log.md`（本文件）
- **代码-spec 一致性**：11/11 项验证通过，无新偏离
