# API Change Log — v0.0.16

> 增量记录 v0.0.16 相对 v0.0.15 的 HTTP 端点契约变更。
> 全量契约：`specs/api/overall/04-agent-session.md`（已就地更新到 v1.4）。PRD：`specs/prd/version_logs/v0.0.16/change_log.md`。Tech：`specs/tech/version_logs/v0.0.16/change_log.md`。

## 1. Scope

v0.0.16 agent session 域新增 3 端点 + 1 spec drift 修正：

1. **新增 `GET /session/:id/usage`**（§2）—— usage 视图初始拉取（ContextWindowUsage 7 字段 + 三分区 AccumulatedUsage + 4 cacheRate 派生）。
2. **新增 `POST /session/:id/compact`**（§3）—— 手动触发 compact（fire-and-forget 202，409 拒绝 running/interrupting/compact_in_progress）。
3. **新增 `POST /session/:id/clear`**（§4）—— 清空 session 内容保留实体（同步原子 200，前置 abort+markSummaryFailed）。
4. **spec drift 修正**（§5）—— SessionUsageView 键名对齐代码（全称键 → 简写键）。

> 端点内部实现（forked agent compact 执行路径 / clearSession 单事务 / 并发编排）属 tech spec 范畴，不在本 API 契约文件展开。详见 `specs/tech/agent/context/[P0]context_compact_detail.md` + `specs/tech/agent/session/[P0]session_clear.md`。

---

## 2. `GET /session/:id/usage` — usage 视图（新增）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session/:id/usage` | 读 session 当前 usage 视图，供 usage 面板初始展示 | `200` + `SessionUsageView` |

**SessionUsageView 形态**（对齐代码 `session-store-types.ts:177-190`，简写键 + Record 化）：

```typescript
interface SessionUsageView {
  current: Record<string, number>;             // 主对话分区
  sub: Record<string, number>;                 // 子 agent 上报分区
  forked: Record<string, number>;              // forked 旁路分区（compact 等）
  total: Record<string, number>;               // 三分区合计
  ratio: number;                               // char→token 比率（sliding window=3 中位数，冷启动 1.0）
  contextWindowUsage?: ContextWindowUsage;     // 7 字段：system/message/tool/total/maxOutput/tokenLimit/remaining
  currentCacheRate: number;                    // 派生：input_cache_read / input_total_tokens（分母 0 返 0）
  subCacheRate: number;
  forkedCacheRate: number;
  totalCacheRate: number;
}

interface ContextWindowUsage {
  systemTokens: number;
  messageTokens: number;
  toolTokens: number;
  totalTokens: number;          // = system + messages + tools
  maxOutputTokens: number;      // 默认 20000
  tokenLimit: number;           // 模型 context window 上限
  remainingTokens: number;      // = tokenLimit − totalTokens − maxOutputTokens
}
```

**行为**：
- 调 `sessionStore.getUsageView(sid)` 读 SessionUsageMeta 三分区 + RatioWindow + contextWindowUsage 派生。
- 历史 record 缺字段（v0.0.8 老数据 3 字段）→ 内部 normalize 兜底补全。
- 实时刷新由 SSE `session_usage_update` 推送（topic=`session_panel`）—— 本端点仅作初始拉取。

**错误**：`404` session 不存在。

---

## 3. `POST /session/:id/compact` — 手动触发 compact（新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/compact` | 手动触发 compact（fire-and-forget）；复用 forked agent 执行路径 | 空 | `202` + `{ ok: true }` |

**触发条件**（caller 校验）：

| 当前态 | 行为 |
|---|---|
| `session.state === "interrupting"` | `409` + `{ error: "session_interrupting" }` |
| `summaryTask.status === "running"` | `409` + `{ error: "compact_in_progress" }` |
| `summaryTask.status ∈ {idle, done, failed}` 且非 interrupting | 通过 → 调 compact 执行路径（fire-and-forget，立即返 202） |

**行为**：
1. 校验触发条件。
2. 调 compact 执行路径：`markSummaryRunning` → forked agent（继承 system + NO_TOOLS）→ setSummary + appendMessages(compact_notice) → markSummaryDone/failed。
3. compact 完成或失败后内部 emit `summary_task_update`（status=done/failed，topic=`session_panel`），前端按钮状态刷新。
4. 端点本身异步，不 await compact 完成。

**幂等 / 并发**：
- compact 进行中再点 → 409 `compact_in_progress`。
- session state=interrupting 时点 → 409 `session_interrupting`。

**错误**：`404` session 不存在；`405` 非 POST；`409` interrupting / compact_in_progress。

> compact 成功后 transcript 插一条 `role=system` message（`metadata.kind=compact_notice`，文案「上下文已整理（v{version}，压缩至 {summaryUpTo}）」），前端订阅 agent_loop topic 收到 message_start + text_block_delta + message_end 渲染（**[BUG-001 修复]** 走标准 emit 序列，非离线补插）。

---

## 4. `POST /session/:id/clear` — 清空会话（新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/clear` | 清空 session 所有内容（保留实体），同步原子 | `ClearBody?`（可选） | `200` + `{ ok: true, session: Session }` |

```typescript
interface ClearBody {
  force?: boolean;       // 可选，默认 false；true 时跳过 abort 收尾直接强制清空（调试用）
}
```

**行为**（force=false 默认前置并发清理）：
1. 若 `session.state ∈ {running, interrupting}` → POST /session/:id/abort（4 步收尾）→ 等 state 转 interrupted。
2. 若 `summaryTask.status === "running"` → markSummaryFailed + 清 forked agent buffer。
3. `sessionStore.clearSession(sid)`（单事务清空：transcript/summary/runs/usage 三分区 + RatioWindow + contextWindowUsage / summaryTask=idle / state=idle）。tokenLimit + maxOutputTokens 保留。
4. **store 内 emit 三事件**（对齐 stateMachine 模式）：`session_status_update`(state=idle) + `session_usage_update`(零 view) + `messages_cleared`（前端清对话区）。
5. 同步返 200 + 重置后的 Session。

**清空范围**：

| 范围 | 清理后 |
|---|---|
| transcript / summary / runs | 空 / `{version:0,summaryUpTo:null,content:null}` / 空 |
| usage 三分区 / RatioWindow / contextWindowUsage | 全零 / 冷启动 / 零占用（tokenLimit 保留） |
| summaryTask / state / running / currentRunId | `{status:idle,...}` / `idle` / `false` / `null` |
| **session.id / title / status / config / createdAt / parentSessionId** | **保留**（不变） |

**force 语义**：`force=true` 跳过 abort 收尾，直接 clearSession + 重置 idle（调试 / 紧急清理用，生产不暴露）。

**错误**：`404` session 不存在；`405` 非 POST；`400` body 非法 JSON。

> clear 是「保留 session 清内容」语义，区别于 `DELETE /session/:id`（删整个 session）。前端用确认 modal 防误操作。

---

## 5. spec drift 修正（SessionUsageView 键名）

**问题**：`04-agent-session.md §6` 原 spec 写全称键 `currentAgentAccumulatedUsage` / `subAgentAccumulatedUsage` / `forkedAgentAccumulatedUsage` / `totalAccumulatedUsage`，是设计期理想形态。

**真行为**：代码 `session-store-types.ts:177-190` 实际返简写键 `current` / `sub` / `forked` / `total`（v0.0.14 起真累加激活后的真行为）。每个分区是 `Record<string, number>` 而非 `AccumulatedUsage` 强类型对象（store 序列化路径通用）。

**修正**：spec 对齐代码（代码是权威）。`04-agent-session.md §6` SessionUsageView 接口签名改为简写键 + Record 化 + 加注释说明字段集合权威源（`session_usage.md §2` AccumulatedUsage）。

---

## 6. 错误码汇总变更

| HTTP | 场景（v0.0.16 前） | 场景（v0.0.16 后追加） |
|------|------|------|
| `409` | （v0.0.12 messages 路径已移除） | `POST /session/:id/compact` 在 interrupting 态 / compact 进行中 |
| `405` | summary 非 GET | compact 非 POST / clear 非 POST |

---

## 7. AT 路径新增（路径 R-W，详见 `04-agent-session.md §10`）

| 路径 | 端点组合 |
|------|---------|
| **R：usage 初始拉取** | `GET /session/:id/usage`（200）→ 断言 SessionUsageView（7 字段 ContextWindowUsage + 三分区 + 4 cacheRate） |
| **S：多轮 → SSE session_usage_update** | `POST /session/:id/messages`（真 LLM 多轮）→ `GET /sse`（topic=session_panel）断言 session_usage_update 序列 + GET usage 字段非零 |
| **T：手动 compact → system message 留痕** | `POST /session/:id/compact`（202）→ SSE summary_task_update(running→done) + message_start(role=system, metadata.kind=compact_notice) → GET messages 含 system message → GET summary 非 null |
| **U：手动 compact 并发拒绝** | 触发 compact（summaryTask=running）→ 立即 POST /compact → 409 compact_in_progress |
| **V：clear 清空 → empty-state + usage 归零** | POST /clear（200）→ session state=idle + GET messages 空 + summary 初始 + usage 零 |
| **W：running 中 clear → 先 abort 再 clear** | running 中 → POST /clear（200）→ 内部 abort + clear → state=idle + GET messages 空 |

---

## 8. 文件变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/router.ts` | 修改 | 新增 GET /session/:id/usage + POST /session/:id/compact + POST /session/:id/clear 路由分发 |
| `app/server/src/handlers/session-usage.ts` | 新增 | GET /session/:id/usage handler |
| `app/server/src/handlers/session-compact.ts` | 新增 | POST /session/:id/compact handler（202 / 409） |
| `app/server/src/handlers/session-clear.ts` | 新增 | POST /session/:id/clear handler（200 同步 + 前置 abort） |
| `app/server/src/agent/session-clear-op.ts` | 新增 | clearSessionStoreOp 单事务 + store 内 emit |
| `app/server/src/agent/context-compact-runner.ts` | 新增 | compact 执行路径编排 |
| `app/server/src/agent/context-ingest-pipeline.ts` | 新增 | compact_notice 构造 + appendMessages 落点 + 标准 emit 序列 |
| `app/server/src/agent/context-usage-calc.ts` | 新增 | ContextWindowUsage 7 字段计算 + normalize |
| `app/server/src/agent/session-store-types.ts` | 修改 | SessionUsageView 简写键 + 4 cacheRate 派生字段 |
| `app/server/src/agent/session-usage-helper.ts` | 修改 | deriveUsageView 派生 4 cacheRate |
| `app/server/src/agent/context-engine.ts` | 修改 | assemble 读 getRatio + compact 算式补 maxOutputTokens |

---

## 9. 版本

version: 1.0（v0.0.16 新建：3 新端点 GET usage / POST compact / POST clear + SessionUsageView spec drift 修正 + 错误码 409/405 追加 + AT 路径 R-W）。
