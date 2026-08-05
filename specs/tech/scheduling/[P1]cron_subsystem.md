---
type: design
title: Cron 子系统 — cron handler + cron.json + cronMessage + session 注销
priority: P1
status: active
updated: 2026-07-23
since: v0.0.58
---

# Cron 子系统（session 级定时任务）

> session 归属的 cron job handler + cron.json 持久化 + cronMessage（子类 "cron"）+ session 销毁注销 + 重启续接。
> 引用：`[P0]engine.md` isDue / `[P0]job_registry.md` Job / `[P0]cron_expr.md` 解析。
> 调研依据：`specs/research/v0.0.58-cron-scheduling.md §2.7（持久化）+ §5（orphan 清理）+ §6.2（cron.json）`。

---

## 1. cron job type 定义

```typescript
// Job.type='cron' 完整形态
{
  id: `cron:${sessionId}:${cronJobId}`,       // 全局唯一
  type: 'cron',
  schedule: { kind:'cron', expr:'*/30 * * * *', tz:'Asia/Shanghai' },
  payload: {
    sessionId,                                 // owner session
    name: '检查 todo.md',
    prompt: '检查 todo.md 推进未完成任务',
    squadId: session.squadId ?? null,          // 派生：playground=null，squad member=squadId
  },
  lastFiredAt: null,                           // 首次 null
  enabled: true,
  createdAt: now.toISOString(),
  owner: sessionId,
}
```

**归属规则**（req.md 已决）：
- cron job **归属 session**（playground / leader / mate 各自），不归属 squad。
- session 销毁 → 该 session 全部 cron jobs 注销（不迁移给其他 session）。
- 同一 session 内多 cron job 并存（per-session cron.json 数组）。

---

## 2. CronHandler 实现

```typescript
class CronHandler implements JobHandler {
  constructor(private deps: {
    isSessionBusy(sessionId): Promise<boolean>;
    deliverTo(sessionId, message): Promise<unknown>;
    /** squad budget 余量（仅 payload.squadId!==null 时调）；返 null=放行 */
    squadBudgetRemaining(squadId): Promise<number | null>;
    /** session 是否存在（archive/delete 后返 false） */
    sessionExists(sessionId): Promise<boolean>;
    engine: SchedulerEngine;
    cronStore: CronPersistenceAdapter;
  }) {}

  async fire(job: Job, now: Date): Promise<void> {
    if (job.type !== 'cron') return;
    const p = job.payload as CronPayload;
    try {
      // gate0: session 仍存在（防 archived session 残留 job 触发）
      if (!(await this.deps.sessionExists(p.sessionId))) {
        // orphan 自动清理（claude-code teammate 模式，researcher §5）
        await this.deps.cronStore.removeJob(p.sessionId, job.id);
        this.deps.engine.unregister(job.id);
        return;
      }
      if (!job.enabled) return;  // engine 已 check，双保险
      // gate1: busy（防 enqueue 堆 tick，与 heartbeat gate3 同语义）
      if (await this.deps.isSessionBusy(p.sessionId)) return;
      // gate2: squad budget（仅 squad session；playground skip）
      if (p.squadId !== null) {
        const remaining = await this.deps.squadBudgetRemaining(p.squadId);
        if (remaining !== null && remaining <= 0) return;  // 无 budget
      }
      // 全通过 → 投递 cron Message
      await this.deps.deliverTo(p.sessionId, buildCronUserMessage(p, now.toISOString()));
      // 更新 lastFiredAt（engine 落内存 + cronStore 落盘）
      this.deps.engine.updateJobLastFiredAt(job.id, now.toISOString());
      await this.deps.cronStore.upsertJob(p.sessionId, { ...job, lastFiredAt: now.toISOString() });
    } catch {
      // best-effort
    }
  }
}
```

**Gate 对比 heartbeat**（去 window gate）：
- cron schedule 不带 activeWindow（cron expr 自带时段，如 `0 9-18 * * 1-5` 表达工作时段）。
- killswitch 无（cron 无 squad.enableHeartBeat 总开关；用户用 enabled=false 单 job 禁用）。

---

## 3. cron.json 持久化

**路径**：`{root}/sessions/{sessionId}/cron.json`

**schema**（v0.0.58 定义，原子写）：
```typescript
interface CronFile {
  version: 1;
  sessionId: string;
  jobs: CronFileEntry[];
}
interface CronFileEntry {
  id: string;                // cronJobId（不含 sessionId 前缀，session 内唯一）
  cron: string;              // 5 字段 expr
  tz: string;                // IANA
  name: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;         // ISO
  lastFiredAt: string | null;
}
```

**CronPersistenceAdapter**（`PersistenceAdapter` 实现）：
- `loadJobs(sessionId)`：读 cron.json → 转 `Job[]`（id=`cron:${sessionId}:${entry.id}`，schedule={kind:'cron',expr,tz}, payload={sessionId,name,prompt,squadId:派生}, lastFiredAt/createdAt/enabled 透传）。squadId 派生：调 `sessionStore.getSession(sessionId).squadId ?? null`。
- `upsertJob(sessionId, job)`：read-modify-write 全量 + 原子写（与 `SchedulerStateStore.writeRole` 同模式）。
- `removeJob(sessionId, jobId)`：filter out entry + 原子写。
- `removeAllJobs(sessionId)`：删整个 cron.json 文件（session 销毁时）。

**原子写**：复用 `app/server/src/persistence/fs-io.ts:atomicWriteSync`（v0.0.33.4 已用，与 `scheduler.json` 同机制，无新代码）。

**性能**：单 session 预期 cron jobs < 10；read-modify-write 全量足够。

---

## 4. cronMessage（子类 "cron"）

```typescript
// app/server/src/scheduling/cron-message.ts
import { ulid } from '../config/ulid';
import type { Message, ContentBlock } from '../message/types';
import type { CronPayload } from './payloads';

export function buildCronUserMessage(payload: CronPayload, at: string): Message {
  return {
    id: ulid(),
    sessionId: payload.sessionId,
    role: 'user',
    content: [{
      type: 'text',
      text: `[cron:${payload.name}] ${payload.prompt}`,
    }] as ContentBlock[],
    sender: {
      source: 'system',
      system: { kind: 'cron', refId: payload.sessionId },
    },
    metadata: {
      cron: { at, name: payload.name, prompt: payload.prompt },
    },
  };
}
```

**对齐 `buildTickUserMessage`**（`squad/scheduler/tick-message.ts`）模式：
- `role:'user'`（走 inbox enqueue）
- `sender.source:'system'` + `system.kind:'cron'`（`message/types.ts:251` 已预留开放枚举，本版本正式启用 `"cron"` 值）
- content = TextBlock（agent prompt 识别后自主决定做不做，与 proactive_tick 同语义）
- metadata.cron 携带完整 payload（programmatic access，UI/audit 可读）

**与 TickMessage 区别**：
- TickMessage 嵌入 `metadata.tickMessage`（reason='heartbeat'|'file-changed'）
- cron 嵌入 `metadata.cron`（name + prompt）—— 不混用 metadata key，便于 audit 过滤。

> **[v0.0.58.cron-fix] cron message 走统一 SSE（离线/在线一致）**
>
> `sender.source='system'` **保留不变**（早前曾改 'user' 绕过 drain 分流，已回退——违反 sender 语义）。cron message 的离线/在线统一**不在 buildCronUserMessage 处解决**，而在 drain 阶段统一：`drainAndPartition` 让所有 source（user/system/agent/approval）的 message 都 emit SSE message_start/blocks/end（详 `agent_loop_eager_drain.md §5.1`）。
>
> 结果：cron fire 时前端 SSE 实时收到（role='user' + metadata.cron），与 GET /messages 看到的完全同源；前端通过 `message-flatten.ts` 的 `m.role==='user'` 分支默认展示。TickMessage（heartbeat / file-changed）同此模式（real-time SSE），与 GET 行为一致。

---

## 5. timezone 来源（v0.0.58.cron-fix2 修订）

**目标**：schedule.tz 必须反映用户实际所在时区，否则北京用户建「每天 9:00」会按 server（可能 UTC）算 → 触发错时。

**取值优先级**（buildCronJob 的 tz 入参）：
1. **UI HTTP 建 cron 时**：`body.timezone`——前端取客户端本地 tz（`Intl.DateTimeFormat().resolvedOptions().timeZone`，IANA 如 `Asia/Shanghai`）现取现传。「全局用本地 timezone 随时取用」：每次建 cron 时前端取当前 client tz，**不存 session**。
2. **缺省 / cron 工具 action=create**：走 `resolveTz` fallback——session.timezone → squad.timezone → server 进程本地。
3. **session.timezone 字段**：schema 仍保留（本版本已建 session 时可设），但**实际落点很少**（UI 走「随时取用」不写 session）；作 fallback 链的兜底层。

**为什么不存 session.timezone**：用户要「全局用本地 timezone 随时取用」——前端每次建 cron 现取当前 client tz 即可，session 不持有 tz 状态（避免 server 端冗余字段 + 用户跨设备时区不一致需同步问题）。

**cron 工具 action=create**：不暴露 timezone 字段（agent 不感知用户时区），统一走 `resolveTz` fallback。fallback 第一跳 session.timezone 大多为空 → 实际命中 squad.timezone 或 server 本地。

**展示层**（前端 cron-job-card fmt）：已用 `getHours()` 等 JS 本地方法渲染 nextFireAt（按浏览器本地 tz 展示），本身正确；问题在 schedule.tz 错用了 server 时区 → 本次修复源头。

---

## 6. cron agent 工具（单工具 `cron` + action enum）

v0.0.104 起 6 个独立工具合并为**单工具 `cron`**（仿 browser 范式：单工具 + action enum + 平铺参数）。`run()` 解析 `input.action` → 前置校验（缺失/非法 → errorResult）→ dispatch 分流到原 6 操作实现（实现未动，复用 cron-tool-shared.ts）。

| action | 入参 | 出参 | 行为 |
|---|---|---|---|
| `create` | `{action, cron, prompt, name?, enabled?}` | `{jobId, cron, name, nextFireAt}` | 校验 cron expr → resolveTz fallback（session→squad→server，agent 不感知 client tz，§5）→ 建 Job → engine.register + cronStore.upsertJob |
| `list` | `{action}` | `{jobs: CronJobSummary[]}` | 读 cronStore.loadJobs(sessionId) |
| `update` | `{action, jobId, cron?, prompt?, name?}` | `{jobId, cron, name, prompt}` | 校验 → 修改 → register + upsert |
| `disable` | `{action, jobId}` | `{jobId, enabled:false}` | register(enabled:false) + upsert |
| `enable` | `{action, jobId}` | `{jobId, enabled:true}` | register(enabled:true) + upsert |
| `delete` | `{action, jobId}` | `{jobId, deleted:true}` | engine.unregister + cronStore.removeJob |

**inputSchema**：`required: ['action']`；`action` enum 6 值；`cron`/`prompt`/`name`/`enabled`/`jobId` 平铺，description 注明适用哪个 action。详 `specs/api/overall/16-cron.md §3.2`。
**SessionId 来源**：工具 ctx 自动取 `ctx.session.id`（agent 不传 sessionId，强制归属当前 session）。
**CronJobSummary**：`{id, name, cron, tz, prompt, enabled, lastFiredAt, nextFireAt}`（nextFireAt = computeNextCronRunMs(cron, now, tz) 现算）。

**入参校验**（在 `cron-tool.ts` 内）：
- `action` 必填且 ∈ 6 enum 值，否则 errorResult（前置校验，不进 dispatch）。
- `cron`（create/update）必须 `parseCronExpression(cron) !== null`，否则 errorResult 返。
- `prompt`（create/update）非空 string。
- `name` 缺省 = `prompt.slice(0,30)`。

**详细 tool spec / testid / UI 文案**：API 文档 `specs/api/overall/16-cron.md`。

---

## 7. UI 专用 HTTP 端点（与 agent 工具正交）

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/session/:sessionId/cron` | 列出 cron jobs（含 nextFireAt） |
| `POST` | `/session/:sessionId/cron` | 新建（body: `{cron, prompt, name?, enabled?}`） |
| `PATCH` | `/session/:sessionId/cron/:jobId` | 更新（body: `{cron?, prompt?, name?}`） |
| `POST` | `/session/:sessionId/cron/:jobId/disable` | 禁用 |
| `POST` | `/session/:sessionId/cron/:jobId/enable` | 启用 |
| `DELETE` | `/session/:sessionId/cron/:jobId` | 删除 |

**实现**：`app/server/src/handlers/cron-handler.ts`（新文件），内部调 `cronStore + engine`（与 cron-tool 共用底层，不互相调）。
**鉴权**：与 `/session/:sessionId/memory` 同模式（v0.0.55 长期记忆 UI 端点），verify session 存在 + user 权限。
**详 API 契约**：`specs/api/overall/16-cron.md`。

---

## 8. session 销毁注销 cron（orphan 清理）

**hook 接线**（claude-code teammate 模式，researcher §5）：
```typescript
// session-store.ts deleteSession 末尾（注入回调，避免循环依赖）
async deleteSession(sessionId): Promise<void> {
  // ... 现有删除逻辑 ...
  // v0.0.58 新增：注销该 session 的全部 cron jobs
  await this.onSessionDestroyed?.(sessionId);
}

// bootstrap.ts wiring
sessionStore.onSessionDestroyed = async (sessionId) => {
  await cronAdapter.removeAllJobs(sessionId);          // 删 cron.json
  for (const job of engine.snapshot().values()) {
    if (job.type === 'cron' && (job.payload as CronPayload).sessionId === sessionId) {
      engine.unregister(job.id);
    }
  }
};
```

**注意**：注入 callback 而非 session-store 直接 import cronAdapter（避免 `session-store → scheduling → session-store` 循环依赖，对齐 `agent_manager`/`session-workspace-manager` 已有 hook 模式）。

**HeartbeatHandler 自保**：`fire` 内 gate0 `sessionExists` check + orphan auto-clean 双保险（即使 session 销毁 hook 漏调，handler fire 时也会发现 session 不存在自动清理）。

**[v0.0.192] 级联删场景每 descendant 均触发 `onSessionDestroyed`**：`DELETE /session/:id` 经 `store.collectDescendants(id)` BFS 快照子孙后**逐个** `deleteSession`（子孙先删、parent 最后删）；`dissolveSquad` 经 `store.listSessionsBySquad(squadId)` 平铺快照全部 squad session 后同样**逐个** `deleteSession`。每个 descendant 的 `deleteSession` 末尾都跑 `onSessionDestroyed` → 该 descendant 的内存 cron job 在 engine 中注销 + `cron.json` 删除。堵住「删 parent 后 child cron 继续烧 token」的潜伏调度漏洞。机制本身不变（onSessionDestroyed 行为同本节上方），只是级联路径让每 descendant 都走一次。详 `specs/tech/version_logs/v0.0.192.delete_cleanup/change_plan.md`。

---

## 9. 重启续接（boot loader cron 部分）

```typescript
// bootstrap.ts bootScheduler 一部分（详 engine.md §6）
for (const session of await sessionStore.listSessions()) {
  // 仅装载有 cron.json 的 session；无文件跳过
  const jobs = await cronAdapter.loadJobs(session.id);
  for (const job of jobs) {
    engine.register(job);  // CronHandler 已注册，engine.tick 能路由
  }
}
```

**注意**：
- lastFiredAt 续接：cron.json 已存，loadJobs 回填到 Job.lastFiredAt。
- 重启期间跨过到点：boot 后首 tick isDue=true（anchor=lastFiredAt 或 createdAt）→ CronHandler.fire → gate 通过则触发一次（at-most-once，无堆，与 heartbeat §6 一致）。

---

## 10. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/scheduling/handlers/cron-handler.ts` | 新增 | `CronHandler implements JobHandler`：fire（gate=busy+squad budget+session exists+orphan clean） |
| `app/server/src/scheduling/persistence/cron-adapter.ts` | 新增 | `CronPersistenceAdapter`：loadJobs/upsertJob/removeJob/removeAllJobs + CronFile/CronFileEntry schema |
| `app/server/src/scheduling/cron-message.ts` | 新增 | `buildCronUserMessage(payload, at)`：deliverTo-ready Message（子类 "cron"） |
| `app/server/src/tools/cron/cron-tool.ts` | 新增 | 6 工具：cron_create/list/update/disable/enable/delete（详见 `specs/api/overall/16-cron.md`） |
| `app/server/src/tools/cron/types.ts` | 新增 | CronJobSummary / CronCreateBody / CronUpdateBody 等 interface |
| `app/server/src/tools/registry.ts` | 修改 | `defaultTools` 加 6 cron tools；TOOL_POLICY bound 配置（详 §11） |
| `app/server/src/handlers/cron-handler.ts` | 新增 | UI 专用 HTTP 端点（6 个，详 specs/api/overall/16-cron.md） |
| `app/server/src/agent/session-store.ts` | 修改 | `deleteSession()` 末尾调注入的 `onSessionDestroyed` 回调；schema 加 `timezone?:string` |
| `app/server/src/agent/schema_defs/session/session.ts` | 修改 | 加 `timezone: {type:'string', required:false}` |
| `app/server/src/bootstrap.ts` | 修改 | wire `sessionStore.onSessionDestroyed` → cronAdapter.removeAllJobs + engine.unregister all cron jobs |
| `app/server/src/scheduling/handlers/__tests__/cron-handler.test.ts` | 新增 | UT：gate (busy/budget/session not exist) / orphan clean / fire 成功 |
| `app/server/src/scheduling/persistence/__tests__/cron-adapter.test.ts` | 新增 | UT：loadJobs/upsertJob/removeJob/removeAllJobs + 原子写 |

---

## 11. TOOL_POLICY bound（cron 工具适用范围）

| session type key | cron 工具可用？ |
|---|---|
| `playground-rocky` | ✅（默认绑 `'cron'`） |
| `studio-leader` / `studio-mate` | ✅（默认绑 `'cron'`，归属各自 session） |
| `studio-squad`（SquadChat 群聊） | ❌（哑路由不调工具） |
| `subagent` | ❌（临时派生 session，无独立 cron 概念） |

**配置位置**：`app/server/src/agent/tool-policy.ts`（v0.0.48 leader/mate static-by-type 体系），单工具 `'cron'` 加入 `playground-rocky` + `studio-leader` + `studio-mate` 的 bound 列表。registry.ts defaultTools 也注册单工具 `cron`。

> squad member/leader session 与 playground 共用 cron 工具（cron 归属 session 不归属 squad），单 type=`'cron'` job handler 路由（不拆 squad/playground），对齐 req.md 决策。

---

## 12. boot.ts 装配（T6 wiring）

boot.ts 是 v0.0.58 实现层的装配中心（独立子模块 `app/server/src/scheduling/boot.ts`），spec §6/§8/§9 + index §④ 都引用此处的 wiring 决策：

**Two-phase init**（打破 HeartbeatHandler ↔ squadRuntime 循环依赖）：
1. `createEngine(dataDir, sessionStore)` → 构造空 registry + engine（不 start）+ cronStore（CronPersistenceAdapter）。
2. caller（bootstrap）用 engine 构造 squadRuntime（squadRuntime 需要 engine 注入 registerHeartbeatJobs）。
3. `bootScheduler(deps)` → 注册 handlers + 双源 loadJobs + onSessionDestroyed wire + SIGTERM trap + engine.start。

**budget 双源 wiring**（关键设计决策）：
- **HeartbeatHandler** 注入 **sync `budgetRemaining(squadId): number`** —— boot.ts:138-163 维护 `budgetCache: Map<squadId, number>`，启动 prime（拉全 squad 一次）+ 30s `setInterval(refreshAll).unref()` 后台刷新；cache 缺值返 `Infinity`（放行，对齐 null-budget）。理由：heartbeat tick 高频（per-member interval），sync gate 不能 await。
- **CronHandler** 注入 **async `squadBudgetRemaining(squadId): Promise<number | null>`** —— 直接调 `budgetAggregator.squadBudgetRemaining(squadId, now)` **fresh（不走 cache）**；返 null = squad 无 budget（放行）。理由：cron 触发稀疏（per job per minute 级），每 fire 现取可接受，避免 cache stale 致 budget gate 误判。

**onSessionDestroyed hook wiring**（boot.ts:227-242）：
```
sessionStore.onSessionDestroyed = async (sessionId) => {
  await cronStore.removeAllJobs(sessionId);   // 删 cron.json（fs cascade 已删时 no-op）
  for (const job of engine.snapshot().values()) {
    if (job.type !== 'cron') continue;
    if ((job.payload as CronPayload).sessionId === sessionId) {
      engine.unregister(job.id);
    }
  }
};
```
注入式 callback 避免 `session-store → scheduling → session-store` 循环依赖（对齐 agent_manager / session-workspace-manager 已有 hook 模式）。

**SIGTERM/SIGINT trap**（boot.ts:246-258 + `registerSchedulerEngineShutdownTrap`）：`engine.stop() + clearInterval(budgetRefreshHandle)`，幂等 global flag 防重复挂载。

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
