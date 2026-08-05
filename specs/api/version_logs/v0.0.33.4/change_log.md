# v0.0.33.4 API 变更日志 — Scheduler 心跳 + Budget + file-watch 端点

> 范围：v0.0.33.1 已落的 `PATCH /squad/:id`（enableHeartBeat/budget 占位）**本版本字段生效** + 新增 3 端点（heartbeat 配置 / budget usage 查询 / scheduler history）。权威设计：`specs/tech/squad/[P1]scheduler.md` + `[P1]squad_filewatch.md` + `[P1]squad_autonomy.md §5/§6`。
> 父契约：`specs/api/overall/11a-squad-endpoints.md`（v0.0.33.1 端点主体）。本文是变更总结，端点表更新由 doc-modifier 同步进 11a（§1.4 PATCH /squad 行为变更 + 新增 §4 heartbeat/budget/scheduler 三端点）。
> PRD 来源：`specs/prd/version_logs/v0.0.33.4/change_log.md §5`。

---

## 1. 端点变更总览

| # | 方法 | 路径 | 状态 | 用途 |
|---|---|---|---|---|
| 1 | `PATCH` | `/squad/:id` | **行为变更**（v0.0.33.1 占位 → 本版生效） | enableHeartBeat / budget / timezone 字段真生效，写后 scheduler.reloadSquad |
| 2 | `PATCH` | `/squad/:id/member/:mid/heartbeat` | **新增** | 改 member.heartbeat（activeWindow/interval），写后 scheduler.reloadRole 实时刷 timer |
| 3 | `GET` | `/squad/:id/budget/usage` | **新增** | 当前 daily 窗口 consumed + remaining + limit + 窗口边界（横向聚合 team sessions） |
| 4 | `GET` | `/squad/:id/scheduler/history` | **新增** | 自动工作历史（tick wake + file-watch wake），who/when/reason/path/actionSummary |

> **路径决策**（arch 拍板，偏离 PRD §5 措辞）：PRD 写 `/squad/:id/role/:roleId/heartbeat`，但项目无独立 role entity（member.role=leader|mate 是字段非实体，leader 也是 member，leaderId=member.id）。为与现有 `/squad/:id/member/:mid` 路由一致，采用 `/member/:mid/heartbeat`。leader 心跳走 `/squad/:id/member/:leaderId/heartbeat`。SquadChat 无 member record（session.type=squad，无 memberId）→ 天然无此端点入口（404 自然，不特判）。

---

## 2. `PATCH /squad/:id`（行为变更：占位字段生效）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PATCH` | `/squad/:id` | 改 name/description/modelDefault + **enableHeartBeat/budget/timezone 真生效**（写后 scheduler.reloadSquad） | `PatchSquadBody` | `200` + `SquadDetail` |

```typescript
interface PatchSquadBody {
  name?: string;
  description?: string;
  modelDefault?: string;
  // [v0.0.33.4] 以下字段本版生效（v0.0.33.1 仅占位存）：
  enableHeartBeat?: boolean;        // killswitch，toggle 后 ≤1s 生效（scheduler 每 tick 轮询）
  budget?: { limit: number; window: "daily"; scope: "team" } | null;
  timezone?: string;                // IANA tz（如 "Asia/Shanghai"），默认 user local；activeWindow + daily 回血都跟它
}
```

**行为**（v0.0.33.4 新增）：
- 写 enableHeartBeat → scheduler killswitch 即时（下一 tick ≤1s 读到新值）。
- 写 budget → budget-aggregator 即时用新 limit。
- 写 timezone → activeWindow 判定 + daily 窗口分桶即时切新 tz。
- 三字段均触发 `scheduler.reloadSquad()`（刷新缓存；killswitch 本就每 tick 轮询故 reloadSquad 主要刷 budget/tz 缓存）。
- **[v0.0.33.4] SquadDetail 完整回显**：成功返 `200 + SquadDetail`，**无论是否本次修改**，响应必含 `enableHeartBeat` / `budget`（含 null 未配）/ `timezone` 三字段——三字段为必含字段（GET /squad/:id 同样回显），前端据此回显 UI 状态。

**错误**：`400` body 非法 / timezone 非 IANA / budget.limit<0；`404` squad 不存在。

---

## 3. `PATCH /squad/:id/member/:mid/heartbeat`（新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PATCH` | `/squad/:id/member/:mid/heartbeat` | 改 member.heartbeat（activeWindow/interval），写后 scheduler.reloadRole 实时刷 timer（无需重启） | `PatchHeartbeatBody` | `200` + `{ member: Member, warning?: string }`（含新 heartbeat；benched 时带 warning） |

```typescript
interface PatchHeartbeatBody {
  heartbeat: {
    activeWindow: { start: string; end: string };  // "HH:mm" 24h，跟 squad.timezone
    interval: number;                               // 分钟（≥1）
  } | null;                                          // null=关闭该 role 心跳（纯 reactive）
}
```

**行为**：
- 写 member.heartbeat → `scheduler.reloadRole(memberId)`：替换 timerStates 中该 role 的 HeartbeatConfig，下一 tick 按 新 interval 排下次（实时生效，P10）。
- `heartbeat=null` → 从 timerStates 移除该 role（纯 reactive）。
- **leader 可配**（leaderId 是 member.id）；**SquadChat 无此端点**（无 member record，路径不匹配返 404）。
- **benched member**：heartbeat 写入存储但 timerStates 不装载（reloadRole 时 check member.state==='deployed'，benched 不入调度）。
- **[v0.0.33.4] benched 返 warning**：对 benched member 写 heartbeat，响应 `200` + `warning: string`（如 `"member is benched; heartbeat stored but not scheduled"`）——存储成功但提示不入调度。响应 schema：`{ member: Member, warning?: string }`（warning 仅 benched 时出现；正常 deployed 无此字段）。

**错误**：`400` activeWindow.start>=end / interval<1 / 格式错；`404` squad/member 不存在。**[v0.0.33.4] benched 不返 409**——本版选 `200 + warning`（见上行行为段：heartbeat 存储成功但响应带 `warning` 提示不入调度），故 benched 走成功路径而非错误路径。

---

## 4. `GET /squad/:id/budget/usage`（新增）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/squad/:id/budget/usage` | 当前 daily 窗口消耗 + 剩余 + limit + 窗口边界 | `200` + `BudgetUsage` |

```typescript
interface BudgetUsage {
  squadId: string;
  limit: number;                    // squad.budget.limit（null 时=-1 或省略，表示无 budget）
  window: "daily";
  consumed: number;                 // Σ team sessions total.total_tokens（当窗口）
  remaining: number;                // limit - consumed（<0 表示超限）
  windowStart: string;              // ISO，当日 squad.timezone 0 点
  windowEnd: string;                // ISO，次日 squad.timezone 0 点（回血时刻）
  perSession: Array<{ sessionId: string; role: "leader"|"mate"|"squad"; consumed: number }>;  // 明细
  timezone: string;
}
```

**行为**：
- 横向聚合 `{leaderSessionId, ...memberSessionIds, squadChatSessionId}` 的 `getUsageView(sid).total.total_tokens`（当窗口，按 squad.timezone 当日 0 点为窗口左界）。
- **reactive + proactive 都计入 consumed**（TBD3：consumption always-on；budget gate 仅 proactive）。
- budget=null（未配）→ `limit=-1, remaining=-1`，consumed 仍算（**仅 Display 用**；该 -1 **不进 scheduler gate**——gate 对 null 直接放行 proactive，见 `[P1]scheduler.md §4 gate2`）。
- UI budget meter 轮询此端点 + SSE `session_usage_update` 实时刷新（P11）。

**错误**：`404` squad 不存在。

---

## 5. `GET /squad/:id/scheduler/history`（新增）

| 方法 | 路径 | 语义 | query | 成功响应 |
|------|------|------|-------|---------|
| `GET` | `/squad/:id/scheduler/history` | 自动工作历史（心跳 + file-watch 唤醒） | `?limit=N`（缺省 50，max 200）+ `?roleId=<memberId>`（可选过滤） | `200` + `{ items: SchedulerHistoryEntry[] }` |

```typescript
interface SchedulerHistoryEntry {
  id: string;                       // ulid
  squadId: string;
  roleId: string;                   // member.id（leader 或 mate）
  roleName: string;                 // member.name（UI 显示）
  at: string;                       // ISO，触发时刻
  reason: "heartbeat" | "file-changed";
  path?: string;                    // reason=file-changed 时的变更 relPath
  result: "fired" | "skipped_busy" | "skipped_budget" | "skipped_window" | "skipped_killswitch";
  actionSummary?: string;           // role run 结束后回填的行动摘要（best-effort，可能空）
}
```

**行为**：
- 时间倒序（最新在前）。
- 来源 = scheduler ring buffer（`[P1]scheduler.md §8`）+ 可选 history.jsonl 持久化（重启不丢）。
- file-watch 唤醒也记此历史（reason=file-changed，复用 recordHistory）。
- UI「自动工作」tab 展示（P12）。

**错误**：`404` squad 不存在；`400` limit>200。

---

## 6. AT 覆盖映射（14 路径，PRD §3）

| 路径 | 覆盖端点 | 断言要点 |
|---|---|---|
| P1 基础心跳触发 | PATCH /member/:mid/heartbeat + GET /scheduler/history | history 出现 reason=heartbeat result=fired |
| P2 activeWindow 外不醒 | PATCH /member/:mid/heartbeat(activeWindow 外) + GET /scheduler/history | 无新 fired 记录 |
| P3 enableHeartBeat 关 | PATCH /squad/:id{enableHeartBeat:false} + POST messages(群聊) | scheduler/history result=skipped_killswitch；群聊仍 200 |
| P4 budget 耗尽 | PATCH /squad/:id{budget:{limit:小}} + GET /budget/usage | usage.remaining<=0；history skipped_budget；reactive 仍响应 |
| P5 跨日回血 | GET /budget/usage（跨日） | windowStart 切换；remaining 重置 |
| P6 重启续接 | GET /scheduler/history（重启前后） | lastFiredAt 连续不丢 |
| P7 file-watch board→leader | 写 board/tasks/{id}.json + GET /scheduler/history | history 出现 reason=file-changed path=board/... roleId=leader |
| P8 file-watch outputs→member | 写 outputs/{ownerName}/x.md + GET /scheduler/history | roleId=owner member |
| P9 debounce | 1s 内改 board 文件 10 次 + GET /scheduler/history | 仅 1 条 file-changed 记录 |
| P10 配置实时 | PATCH /member/:mid/heartbeat(interval 改) + GET /scheduler/history | 下次 fired 间隔变 |
| P11 budget meter 实时 | 触发 reactive 对话 + GET /budget/usage | consumed 实时增 |
| P12 自动工作历史 | 触发 N 次 tick + GET /scheduler/history | N 条记录 |
| P13 busy 跳过 | role running 时 tick + GET /scheduler/history | result=skipped_busy |
| P14 多 squad 隔离 | 两 squad 各配 + GET /budget/usage + /scheduler/history | 互不影响 |

> P10-P12 纯 UI 交互由 ET 覆盖（GET 端点断言可辅助 AT）。

---

## 7. 文件级变更清单（API 层）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/handlers/squad-handler.ts`（或 splits） | 修改 | PATCH /squad/:id 写后调 `scheduler.reloadSquad()`（11a §1.4 行为变更） |
| `app/server/src/handlers/squad-heartbeat-handler.ts` | 新增 | PATCH /squad/:id/member/:mid/heartbeat 端点 + 调 `scheduler.reloadRole(mid)` |
| `app/server/src/handlers/squad-budget-handler.ts` | 新增 | GET /squad/:id/budget/usage 端点（调 budget-aggregator） |
| `app/server/src/handlers/squad-scheduler-handler.ts` | 新增 | GET /squad/:id/scheduler/history 端点（读 scheduler history ring buffer） |
| `app/server/src/routes.ts`（或 router 注册点） | 修改 | 注册 3 新路由 |
| `specs/api/overall/11a-squad-endpoints.md` | 修改（doc-modifier 同步） | §1.4 PATCH /squad 行为变更注记 + 新增 §4 heartbeat/budget/scheduler 端点表 |

---

## 8. 版本

version: 1.0 `[v0.0.33.4]`：PATCH /squad/:id 占位字段生效（enableHeartBeat/budget/timezone + scheduler.reloadSquad）+ 新增 PATCH /member/:mid/heartbeat（reloadRole 实时刷 timer）+ GET /budget/usage（横向聚合 team sessions + daily 窗口 + perSession 明细）+ GET /scheduler/history（heartbeat+file-changed 统一历史）。路径用 /member/:mid（非 PRD 措辞 /role/:roleId，因无 role 实体）。对齐 PRD §5 + 14 路径 AT 映射。
