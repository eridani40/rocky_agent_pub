# v0.0.58.cron Tech Change Log — 调度器抽象 + cron 子系统

> version: 1.0 · 2026-07-03
> PRD 权威：`specs/prd/version_logs/v0.0.58/change_log.md`
> API 权威：`specs/api/version_logs/v0.0.58.cron/change_log.md`

---

## 1. 新增子系统 KB：`specs/tech/scheduling/`

新建顶层 KB（OKF：index + log + 5 spec 文件），从 `specs/tech/squad/[P1]scheduler.md` 抽出公共调度逻辑，沉淀为进程级单例引擎。

| 文件 | 内容 |
|---|---|
| `index.md` | 总起（5 章 OKF）：是什么 / 边界 / 系统关系 / 9 项核心原则 / 导航 |
| `log.md` | KB 变更日志 |
| `[P0]engine.md` | SchedulerEngine 单例 + 1s 轮询 + isDue（interval/cron 双分支）+ fire-and-forget + boot loader |
| `[P0]job_registry.md` | Job `{id,type,schedule,payload,lastFiredAt,enabled,createdAt,owner}` + JobHandler `fire(job,now)` + Registry + PersistenceAdapter 双实现 |
| `[P0]cron_expr.md` | 5 字段 cron 解析（搬 claude-code `refs/claude-code/src/utils/cron.ts`）+ 扩 per-job tz + computeNextCronRunMs + dom/dow OR 语义 + cronstrue zh_CN UI 选型 |
| `[P1]heartbeat_handler.md` | heartbeat 从 SquadScheduler.tryFire 迁移 + 回归红线 §4（6 项 v0.0.33.4 不变量） |
| `[P1]cron_subsystem.md` | cron handler + cron.json schema + buildCronUserMessage（子类 "cron"）+ session.timezone 新字段 + session 销毁注销 hook + TOOL_POLICY bound |

## 2. 核心架构变更（需求 3 — 调度器抽象）

### 2.1 SquadScheduler 一次到位 retire

- **决策**：v0.0.58 一次性把 SquadScheduler 改造为「向 engine register heartbeat jobs」的 adapter，**删除 SquadScheduler.tick/tryFire/fireOne**（避免死代码，符合「代码静默偏离 spec 是最危险的」教训）。
- **对外接口保留**：`SquadRuntime.ensureScheduler/reloadSquad/reloadRole/stopAll` 签名不变（handler / squad 工具 caller 不受影响）。
- **风险**：中。需 v0.0.33.4 全量回归 UT + AT（heartbeat_member_fire / window_skip / busy_skip / budget_skip / killswitch / multi_squad_isolation）。

### 2.2 引擎纯调度 + gate 全下沉

- SchedulerEngine **不感知业务**（无 budget/squad/session 字样），只判 isDue + 调 handler.fire（fire-and-forget 不 await）。
- heartbeat gate（killswitch/window/budget/busy）下沉 HeartbeatHandler。
- cron gate（session exists/busy/squad budget）下沉 CronHandler。

### 2.3 持久化双源

- heartbeat → `.rocky_squad/state/scheduler.json`（v0.0.33.4 schema 不动，零数据迁移）。
- cron → `.sessions/{sessionId}/cron.json`（新文件，schema v1.0）。
- engine 通过 PersistenceAdapter 抽象，boot loader 双源加载。

## 3. cron 子系统新增（需求 1）

- **Job type='cron'**：owner=session，schedule={kind:'cron',expr,tz}，payload={sessionId,name,prompt,squadId}。
- **buildCronUserMessage**：sender.system.kind="cron"（`message/types.ts:251` 开放枚举本版本正式启用），metadata.cron 携带 payload。
- **session.timezone 新字段**（schema_defs/session/session.ts）：IANA，optional，取值优先级 session > squad > 进程本地。
- **session 销毁注销**：session-store.deleteSession 末尾调注入的 onSessionDestroyed 回调 → cronAdapter.removeAllJobs + engine.unregister all cron jobs of session。注入回调避免循环依赖。
- **6 cron agent 工具**（cron_create/list/update/disable/enable/delete）+ **6 UI HTTP 端点**（GET/POST/PATCH/disable/enable/DELETE `/session/:sid/cron[/:jid]`），两路径正交共享底层（详 `specs/api/overall/16-cron.md`）。

## 4. cron 解析与人话化

- **解析**：搬 claude-code `refs/claude-code/src/utils/cron.ts` 自实现（5 字段 + step/range/list + dom/dow OR 语义 + 7=Sunday alias），扩 per-job tz 支持（`computeNextCronRunMs(expr, from, tz)` 内部用 Intl.DateTimeFormat 取 tz 字段）。
- **server 零 npm 依赖**：server 不引入 cron 解析库；人话化纯 UI 关注点。
- **UI 人话化**：`app/web/` 引入 `cronstrue`（~50KB，zh_CN 内置），展示态用 `cronstrue.toString(expr, {locale:'zh_CN', tz})`，翻译不出 fallback raw expr；编辑态用预设频率 chip（每 N 分钟 / 每 N 小时 / 每天 HH:mm / 每周 X HH:mm / 自定义）程序生成 expr。
- **工具层不变**：agent `cron_create` 收 cron expr 原样。

## 5. 回归红线（v0.0.33.4 heartbeat 6 项不变量）

详 `specs/tech/scheduling/[P1]heartbeat_handler.md §4`：
1. per-member interval + activeWindow 不变
2. gate 顺序 window→budget→busy→deliverTo 不变
3. killswitch 每 tick 现取 不变
4. lastFiredAt 续接语义 不变（scheduler.json 不动）
5. null-budget Gate 放行 不变
6. 多 squad 隔离（Job.id 全局唯一）不变

## 6. 文件级总变更清单（汇总）

### 新增（13 个文件）

| 文件 | 内容 |
|---|---|
| `app/server/src/scheduling/engine.ts` | SchedulerEngine 单例 |
| `app/server/src/scheduling/types.ts` | Job/JobHandler/Schedule/Registry/PersistenceAdapter interface |
| `app/server/src/scheduling/registry.ts` | JobHandlerRegistry 实现 |
| `app/server/src/scheduling/active-window.ts` | withinActiveWindow/toTimeZoneHHmm（迁出 gate-chain.ts） |
| `app/server/src/scheduling/cron-expr.ts` | parseCronExpression + computeNextCronRunMs |
| `app/server/src/scheduling/cron-message.ts` | buildCronUserMessage |
| `app/server/src/scheduling/handlers/heartbeat-handler.ts` | HeartbeatHandler（迁移自 gate-chain.ts tryFire） |
| `app/server/src/scheduling/handlers/cron-handler.ts` | CronHandler |
| `app/server/src/scheduling/persistence/heartbeat-adapter.ts` | HeartbeatPersistenceAdapter（包装 SchedulerStateStore） |
| `app/server/src/scheduling/persistence/cron-adapter.ts` | CronPersistenceAdapter（cron.json） |
| `app/server/src/tools/cron/cron-tool.ts` | 6 cron agent 工具 |
| `app/server/src/tools/cron/types.ts` | CronJobSummary 等 |
| `app/server/src/handlers/cron-handler.ts` | 6 UI HTTP 端点 |

### 修改（8 个文件）

| 文件 | 变更内容 |
|---|---|
| `app/server/src/bootstrap.ts` | 新增 `bootScheduler()`：注册 handlers + 双源 loadJobs + engine.start() + SIGTERM trap；wire sessionStore.onSessionDestroyed → cronAdapter.removeAllJobs + engine.unregister |
| `app/server/src/squad/squad-runtime.ts` | ensureScheduler/reloadSquad/reloadRole/stopAll 改为 engine.register/unregister；budget cache 模式保留 |
| `app/server/src/squad/scheduler/scheduler.ts` | **retire SquadScheduler class**（保留 RoleHeartbeat/SquadSnapshot interface 移到 scheduling/types.ts） |
| `app/server/src/squad/scheduler/gate-chain.ts` | withinActiveWindow/toTimeZoneHHmm 迁出到 scheduling/active-window.ts；本文件 tryFire 删除（迁到 HeartbeatHandler）；TickResult 类型保留或迁出 |
| `app/server/src/message/types.ts` | 注释更新：`system.kind` 开放枚举正式启用 `"cron"` 值（字段 schema 不动） |
| `app/server/src/agent/session-store.ts` | deleteSession 末尾调 onSessionDestroyed 回调；schema_defs 加 timezone 字段 |
| `app/server/src/agent/schema_defs/session/session.ts` | 加 `timezone: {type:'string', required:false}` |
| `app/server/src/tools/registry.ts` + `tool-policy.ts` | defaultTools 加 6 cron；policy bound playground/studio-leader/studio-mate 含 cron，squad/subagent 不含 |

### UI（app/web/）

| 文件 | 变更内容 |
|---|---|
| `app/web/package.json` | 加 `cronstrue` dependency |
| `app/web/src/.../*Cron*` 组件 | UI 实现（详 specs/ui/，coder 编码前置产出组件 spec） |

> UI 组件 spec 由 coder 编码前置产出（CLAUDE.md 「前端组件化 spec」要求），arch 阶段只在 `[P1]cron_subsystem.md §7` 列端点契约 + `[P0]cron_expr.md §7` 列人话化选型。

## 7. 重大风险/技术死胡同（需用户决策）

**R1（中风险，需用户确认 retire 时机）**：SquadScheduler 一次到位 retire（v0.0.58 删除并迁移到 HeartbeatHandler）vs 渐进 adapter 包装保留兼容。
- **arch 推荐**：一次到位 retire（避免死代码）。
- **风险**：v0.0.33.4 全量回归 UT/AT 必须无破坏；如时间紧可降级为 adapter 包装（HeartbeatHandler 内部仍调 SquadScheduler，但 SquadScheduler 改造为不带 1s 轮询的 gate-only 工具类）。

**R2（中风险）**：SchedulerEngine 进程单例 vs v0.0.33.4 多 squad 独立实例的性能/隔离差异。
- **结论**：单 interval 遍历 Map（每秒 ≤几十次 iteration）+ .unref()，比 N 个 interval 更省资源；多 squad 隔离通过 Job.id prefix（`heartbeat:<squadId>:<memberId>`）+ PersistenceAdapter 按 owner 分片实现。
- **不算死胡同**，但需 AT 多 squad 并发回归。

**R3（低风险）**：cron expr per-job tz 扩展——claude-code 原实现 hardcoded 进程本地，扩展用 Intl.DateTimeFormat 改算法。
- **结论**：算法明确（fieldsInTz + 分钟级迭代），UT 覆盖多 tz + DST + 跨月即可。

**R4（决策点，PRD/arch 阶段细化）**：session.timezone 取值——是否在 `POST /session` body 接受？UI 哪里改？
- **arch 建议**：本版本仅 schema 字段 + 服务端默认值（squad.timezone fallback + 进程本地兜底）；UI 改入口留 backlog（先靠默认值跑通）。

无重大技术死胡同。所有风险可通过 AT/UT 全量回归覆盖。

---

> 跨 API 发布说明：`specs/api/version_logs/v0.0.58.cron/change_log.md`。
