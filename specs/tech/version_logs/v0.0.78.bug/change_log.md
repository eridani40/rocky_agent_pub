---
type: change_log
version: v0.0.78.bug
title: compact 压缩逻辑偏离修复（fire-and-forget + SSE 恢复 + trace modeKey）
updated: 2026-07-06
---

# v0.0.78.bug · compact 压缩逻辑偏离修复

> **背景**：用户反馈「session sse 不会自动 run end / 交互上不会自动停了」。
> 调查结论：agent loop 跑去做压缩，但压缩逻辑偏离 spec——既阻塞主 loop（run_end 不发），又没把压缩状态推到 event bus。
> 两个独立根因叠加（A 阻塞 + B SSE 丢失），加一项观测性缺口（C trace name 无用途段）。
>
> 权威需求：`reqs/[working] v0.0.78.bug/req.md`
> Method 级变更契约：`specs/tech/version_logs/v0.0.78.bug/change_plan.md`

## 0. 修复总览（3 改动点）

| ID | 改动 | 范围 |
|---|---|---|
| **T1** | compact 异步化（fire-and-forget） | `loop-stage-context.ts:101`：`await runTryCompact(...)` → `void runTryCompact(...).catch(err => log)` |
| **T2** | SessionTaskLock bus 注入 + 恢复 `summary_task_update` SSE | `session-task-lock.ts` 加 `sessionPanelBus` + `setSessionPanelBus()` + `emitTaskUpdate()` 私有 helper；`acquire/markDone/markFailed/release` CAS 成功后 emit；恢复 `session-event-types.ts SummaryTaskUpdateEvent` + `session-meta-broadcaster.ts _META_TRIGGERING_TYPES`；`SessionMetaView.summaryTask?` optional（方案 A） |
| **T3** | buildTraceName 加 modeKey 段 | `agent-loop-helpers.ts` 第 4 参 `modeKey?: string`；`LoopObservabilityOpts.modeKey?`；main 显式 `'current'`，forked 用 caller 传入（`'summary'` / `'memory_extract'`） |

AT 验证：3/3 pass（手动 compact SSE 链路 / 多轮自动 compact run_end 不延迟 / langfuse trace name 含 bracket 段）。

---

## 1. T1 — compact 异步化（契约 1：fire-and-forget）

### 问题
`loop-stage-context.ts:101` emit message_end 后 `await runTryCompact(...)`，链路全 await 到 `summary_do_compact.ts:63` 跑完一次完整 forked LLM 调用。forked LLM 慢 → 主 loop 卡住 → run_end 不发 → 前端永远 running。

spec `[P0]agent_loop_unified.md §2` 写的就是 `await tryCompact`——但 spec 同时声明「compact 无副作用」（`agent_loop_forked §1`），await 与无副作用矛盾。本版本按 spec 原则纠正代码：改 fire-and-forget。

### 做法
```ts
// loop-stage-context.ts:101
void runTryCompact(spec, state).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[loop-stage-context] async compact failed (suppressed): ${msg}`);
});
```

- `runTryCompact` 函数体不变（保留内部 await tryCompact + afterVersion>beforeVersion → re-assemble 链路）；只改它的**调用方式**（caller 不再 await）。
- 外层 catch 仅观测日志；`runTryCompact` 内部 catch 已调 `markFailed` + rethrow → 外层捕获不让 unhandled rejection 上抛。
- **MUST NOT** 在主 loop 加 try/catch 等结果；**MUST NOT** 让 unhandled rejection 上抛。

### 并发不变量（5 条）
compact 与主 loop 并发跑，安全性由以下联合保证（spec `[P0]context_compact_detail.md §2c.1.1`）：

1. **per-session compact 互斥**：`SessionTaskLock.acquire(sid, 'compact', runId)` CAS 保证同一 session 同时只 1 个 compact 在跑；并发第二个 return false 跳过。
2. **forked 走独立 session/buffer**：compact 经 `manager.forkedRun({ modeKey:'summary' })` 起 forked agent，写 in_memory_session_store（forked scope），**不碰主 session transcript**。
3. **compact 无副作用**：forked agent 不调 `stateMachine.markRunning/markIdle/markError`、不动 Run 表、不 ingest 父 transcript、不发 agent_loop 事件到主对话 group。
4. **summary 写入幂等**：`store.setSummary` idempotent；失败时 summaryUpTo 不推进可重试。
5. **re-assemble 在主 loop 下一轮 prepare 自然承担**：主 loop 下一轮 `prepareStage` 调 `contextEngine.assemble('default', prevSnapshot)` 会自然重建含新 summary 的 snapshot（summary 被 default scope 的 summary_builder 自动消费）。**主 loop 不需要等 compact**。

### Spec 同步
- `[P0]agent_loop_unified.md §2` 伪代码改 `void tryCompact(...).catch(...)` + 注释引用 §0 不变量。
- `[P0]context_compact_detail.md §2c.1` 同上 + 新增 §2c.1.1 并发不变量段（5 条 + 错误观测约束）。

---

## 2. T2 — SessionTaskLock bus 注入 + summary_task_update SSE 恢复（契约 3/4）

### 问题
v0.0.55 重构 SessionTaskLock 时**过度删除**：把 `summary_task_update` SSE event 连根拔起。`session-event-types.ts:46-48` 注释自承「CompactBtn spinner 信号丢失是已知 UX 回归」。SessionTaskLock 纯内存 CAS 类，**无 bus 注入、无 emit 钩子**——状态推送代码压根没写。前端 CompactBtn + SSE 订阅**完整就绪**（`use-session-run-state.ts:204` + `chat-api.ts:201` + UI spec 全部用此事件名），后端恢复推送即生效，前端零改动。

### 做法
```ts
// session-task-lock.ts
export class SessionTaskLock {
  private sessionPanelBus?: ReplayableEventBus;

  setSessionPanelBus(bus: ReplayableEventBus): void {
    this.sessionPanelBus = bus;
  }

  acquire(sid, taskType, runId): boolean {
    // ... CAS ...
    if (casSuccess) {
      this.emitTaskUpdate(sid, next);  // CAS 成功 → emit
      return true;
    }
    return false;
  }
  // markDone / markFailed / release 同模式

  private emitTaskUpdate(sid, nextState): void {
    if (!this.sessionPanelBus) return;        // bus 未注入 → no-op（UT 兼容）
    try {
      const ts = new Date().toISOString();
      const event = { id: ulid(), type: 'summary_task_update', sessionId: sid, createdAt: ts, data: nextState };
      this.sessionPanelBus.emit(`session_id:${sid}`, { data: event, timestamp: ts });
    } catch (e) {
      console.warn(`[session-task-lock] emitTaskUpdate failed (suppressed): ${msg}`);
    }
  }
}
```

- **3 种 no-op 情形**：bus 未注入 / CAS 失败 / 非 running 调用（防幂等保护误 emit）。
- **emit 失败吞错**：observability 链路自治，不污染调用方 CAS 语义。
- bootstrap 在 `registerTopic(SESSION_PANEL_TOPIC)` 之后调 `taskLock.setSessionPanelBus(sessionStatusBus)`（同一 bus 实例）。
- `session-event-types.ts` 恢复 `SummaryTaskUpdateEvent` interface（v0.0.55 删除恢复）；data 类型用 `SessionTaskState`（从 session-task-lock.ts import）。
- `session-meta-broadcaster.ts _META_TRIGGERING_TYPES` Set 加回 `'summary_task_update'`（恢复触发 session_meta broadcast，会话列表也刷新 meta）。
- **方案 A（开放点-1 决策）**：`SessionMetaView.summaryTask?` optional——broadcaster 持 crud 不持 lock，不填此字段；前端 CompactBtn 通过单独 `summary_task_update` SSE 事件订阅 compact 状态（不读 meta_view.summaryTask）。理由：减少 broadcaster 跨实例依赖 + 与 v0.0.55 之前字段语义不同（那时 summaryTask 落盘 crud 直读，现在内存 only）。

### 事件命名决策：复用 `summary_task_update`（不改 `compact_task_update`）
1. spec `session_event.md §2` + 前端 `use-session-run-state.ts:204` + `chat-api.ts:201` + UI spec `component-usage-panel.md §3.3` 全部已用此名，前端零改动。
2. SessionTaskLock 的 `SessionTaskType` 已开放集合（`'compact' | 'tier1_consolidation' | string`），未来 tier1_consolidation 复用同事件只需在 data 里换 taskType 标签，事件名不变。
3. 「summary_task」是 spec 历史命名（v0.0.13 起），改名为「compact_task_update」会同时破 spec+前端+API 三处契约，违背「最小变更恢复 SSE」原则。

### Spec 同步
- `[P0]session_task_lock.md` 加 §「v0.0.78.bug bus 注入」段（描述 setSessionPanelBus + CAS 成功 emit + 3 种 no-op 情形）。
- `[P0]session_event.md §2` `SummaryTaskUpdateEvent.data` 类型改为 `SessionTaskState`（从 session_task_lock.md 引用，不再本地重定义 `SummaryTaskStatus`）+ 历史注释段（v0.0.13 落地 / v0.0.55 删 / v0.0.78.bug 恢复）。
- `[P0]session_event.md §3` 触发表加 v0.0.78 emit 源迁移说明（markSummary* → SessionTaskLock.acquire/markDone/markFailed/release）。
- `[P0]session_event.md §3a.3` `SessionMetaView.summaryTask` 改 optional（方案 A）。
- `04-agent-session.md` §7 line 567「v0.0.55 SSE 已删」注记 → 改为「v0.0.78.bug SSE 恢复」；§7 line 555 + §3a line 444 + §10 路径 T 同步对齐。
- `component-usage-panel.md §3.3` 加 v0.0.78.bug「SSE 恢复，前端零改动」注。

---

## 3. T3 — buildTraceName 加 modeKey 段（契约 6）

### 问题
`buildTraceName`（`agent-loop-helpers.ts:118`）三段 = `kind + sid6 + input10`，无 modeKey 段。compaction / consolidation 跟主对话 trace 名第一段相同，langfuse UI 区分不了。

### 做法
```ts
// agent-loop-helpers.ts:124
export function buildTraceName(
  sessionKind: string | undefined,
  sessionId: string,
  triggerMessages: Message[],
  modeKey?: string,                    // [v0.0.78.bug] 新增
): string {
  const kindRaw = ...;
  // modeKey 非空且 ≠ 'current' → kind 段拼后缀 [modeKey]（紧贴 kind 不加空格）
  const kind = modeKey && modeKey !== 'current' ? `${kindRaw}[${modeKey}]` : kindRaw;
  // ...
}
```

- `LoopObservabilityOpts.modeKey?: string`（注释指明来源：forked='summary'|'memory_extract'，main='current'|undefined）。
- `startTrace` 调用 `buildTraceName(..., this.opts.modeKey)`。
- `build-deps.ts` main loop 显式传 `modeKey: 'current'`（langfuse UI 区分 main vs forked 一目了然）。
- `build-forked-deps.ts` forked 用 caller 传入的 modeKey（compact='summary' / consolidation='memory_extract'），不二次推导。

### 例子
- main：`studio-leader 01KWBPa3 helloworld`（modeKey='current' 退原格式）
- forked compact：`studio-leader[summary] 01KWBPa3 helloworld`
- forked tier1：`studio-leader[memory_extract] 01KWBPa3 ...`

### Spec 同步
- `[P0]observability_interface.md §5.1` TraceStart.name 字段补 modeKey 段语义 + 例。
- `observability/log.md` 加 v0.0.78.bug 段。
- `specs/tech/version_logs/v0.0.61/change_log.md §1` 加前向引用注（v0.0.78.bug 扩展）。

---

## 4. 关键决策（用户拍板，2026-07-05）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 问题 A 方向（compact 阻塞主 loop） | 改 fire-and-forget（非 await + 加并发不变量段） | 符合 spec 契约 1 + `agent_loop_forked §1`「compact 无副作用」原则。spec 写的就是 await，但 await 与无副作用矛盾——本版本按 spec 原则纠正代码。 |
| SessionMetaView.summaryTask 数据源 | 方案 A：optional，broadcaster 不填 | 前端 CompactBtn 已通过单独事件订阅（不读 meta_view）；减少 broadcaster 跨实例依赖；与 v0.0.55 之前的字段语义不同（那时落盘 crud 直读，现在内存 only）。 |
| 事件命名 | 复用 `summary_task_update`（不改 `compact_task_update`） | 前端契约零改动 + spec 历史命名（v0.0.13 起）+ SessionTaskType 已开放集合（事件名不变，data.taskType 标签换即可）。 |
| buildTraceName modeKey 默认值 | main 显式 `'current'`（非 undefined） | langfuse UI 区分 forked vs main 一目了然；modeKey 缺省 / 'current' 都退原格式（main 视觉零回归，向后兼容）。 |
| modeKey 段紧贴 kind 不加空格 | `studio-leader[summary]` 而非 `studio-leader [summary]` | 与 sid6 之间仍单空格分隔；紧凑视觉与 bracket 风格一致。 |

---

## 5. Spec 同步清单（6+1 处，doc-modifier 阶段 5 完成）

| spec 文件 | 章节 | 同步点 |
|---|---|---|
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md` | §2 | await → void + 并发不变量引用 |
| `specs/tech/agent/context/[P0]context_compact_detail.md` | §2c.1 + §2c.1.1（新增） | await → void + 并发不变量 5 条段 |
| `specs/tech/agent/session/[P0]session_event.md` | §2 + §3 + §3a.3 + §3a.4 | data 类型统一 / emit 源迁移 / summaryTask optional |
| `specs/api/overall/04-agent-session.md` | §3a line 444 + §7 line 555/567 + §10 路径 T | drift-1 清理（v0.0.55 删 → v0.0.78.bug 恢复统一） |
| `specs/ui/components/chat-page/component-usage-panel.md` | §3.3 | CompactBtn 数据源确认 + SSE 恢复注 |
| `specs/tech/agent/observability/[P0]observability_interface.md` | §5.1 | TraceStart.name 加 modeKey 段说明 |
| `specs/tech/agent/observability/log.md` | 顶部 | v0.0.78.bug 段（buildTraceName 加 modeKey） |

### KB log.md 同步（per-KB 位置轴）
- `specs/tech/agent/agent_interface_and_loop/log.md`：v0.0.78.bug 段（fire-and-forget）
- `specs/tech/agent/context/log.md`：v0.0.78.bug 段（fire-and-forget + 不变量段）
- `specs/tech/agent/session/log.md`：v0.0.78.bug 段（SessionTaskLock bus 注入 + SSE 恢复）
- `specs/tech/agent/observability/log.md`：v0.0.78.bug 段（trace name modeKey）
- `specs/tech/version_logs/v0.0.61/change_log.md`：§1 末加前向引用注（v0.0.78.bug 扩展 modeKey）

---

## 6. 代码 ↔ spec 一致性验证（CLAUDE.md 原则 12）

逐项核对（doc-modifier 阶段 5）：

| 检查项 | 代码现状 | spec 契约 | 对齐 |
|---|---|---|---|
| SessionTaskLock emit 在 CAS 成功后（非失败路径） | `acquire/markDone/markFailed/release` CAS success 后调 emitTaskUpdate | spec §3 触发表 CAS 成功后 emit | ✓ |
| emit 失败吞错不影响 CAS 返回值 | try/catch + console.warn | spec 注「emit 异常吞掉不影响 CAS 返回 true」 | ✓ |
| bus 未注入时 no-op | `if (!this.sessionPanelBus) return;` | spec「UT 兼容」 | ✓ |
| summary_task_update data=SessionTaskState 对齐 spec §2 | data: SessionTaskState（runId/startedAt/error optional） | spec §2 改 SessionTaskState（同 session_task_lock.md §2） | ✓ |
| buildTraceName modeKey 紧贴 kind 不加空格 | `${kindRaw}[${modeKey}]` | spec §5.1 注「modeKey 段紧贴 kind 不加空格」 | ✓ |
| modeKey='current' / undefined 退原格式 | `modeKey && modeKey !== 'current' ? ... : kindRaw` | spec「main loop 视觉零回归」 | ✓ |
| main 显式传 'current' | `build-deps.ts:194` opts.modeKey='current' | spec「main 显式 current」 | ✓ |

**未发现代码静默偏离 spec**——本版本所有改动均按 change_plan 实现，spec 同步对齐。

---

## 7. 文件清单

| 文件 | 类型 | 用途 |
|---|---|---|
| `app/server/src/agent/loop-stage-context.ts` | 修改 | T1 fire-and-forget |
| `app/server/src/agent/session-task-lock.ts` | 修改 | T2 SessionTaskLock bus 注入 + emit |
| `app/server/src/agent/session-event-types.ts` | 修改 | T2 恢复 SummaryTaskUpdateEvent + SessionMetaView.summaryTask? |
| `app/server/src/agent/session-meta-broadcaster.ts` | 修改 | T2 _META_TRIGGERING_TYPES 恢复 |
| `app/server/src/bootstrap.ts` | 修改 | T2 taskLock.setSessionPanelBus(bus) 装配 |
| `app/server/src/agent/agent-loop-helpers.ts` | 修改 | T3 buildTraceName 加 modeKey |
| `app/server/src/agent/agent-loop-observability.ts` | 修改 | T3 LoopObservabilityOpts.modeKey + startTrace 透传 |
| `app/server/src/agent/build-forked-deps.ts` | 修改 | T3 forked 透传 modeKey |
| `app/server/src/agent/build-deps.ts` | 修改 | T3 main 显式 modeKey='current' |

> AT 验证 3/3 pass；详细 case 见 `states/v0.0.78.bug/verify/api-test/`。
