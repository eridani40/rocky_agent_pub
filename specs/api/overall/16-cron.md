# Cron / Session-Scheduled Tasks 端点契约

> version: 1.1 · 引入版本 v0.0.58.cron（v0.0.104 更新 §3：6 agent 工具合并为单工具 `cron` + action enum）
> 管什么：cron 子系统的**完整端点契约**——UI 专用 HTTP（6 个）+ agent 工具（单工具 `cron` + 6 action），两路径正交但共享底层（CronStore + SchedulerEngine）。
> 不管什么：调度引擎内部 / heartbeat handler（→ `specs/tech/scheduling/`）；UI 组件视觉/testid（→ `specs/ui/components/`）；cron expr 解析算法（→ `specs/tech/scheduling/[P0]cron_expr.md`）。
> **本文件是 AT（API Test）cron 端点的唯一依据**：api-verifier 黑盒 curl，不读代码。
>
> **权威概念源**：`specs/tech/scheduling/[P1]cron_subsystem.md` + `[P0]job_registry.md` + `[P0]cron_expr.md`。

---

## 1. 概念

- **归属 session**：cron job 归属当前 session（playground / leader / mate 各自独立），不归属 squad。
- **payload**：`{cron:expr, prompt, name?, tz, enabled, lastFiredAt?}`。`tz` 来源（v0.0.58.cron-fix2）：UI HTTP body.timezone（client local Intl）优先，否则 resolveTz fallback（session→squad→server）；agent 工具不传 timezone，走 fallback。
- **agent 工具 vs UI HTTP**：两路径完全正交（同操作两入口），共享 `CronPersistenceAdapter` + `SchedulerEngine`。
- **cron expr 标准**：5 字段 minute-hour-dom-month-dow（详 `[P0]cron_expr.md §2`），不支持 L/W/?/name 别名。
- **`sessionId` 来源**：agent 工具自动取 `ctx.session.id`；UI HTTP 必须在 path 显式传。

---

## 2. UI 专用 HTTP 端点（6 个）

### 2.1 `GET /session/:sessionId/cron` — 列 cron jobs

| 方法 | 路径 | 语义 | 成功响应 |
|---|---|---|---|
| `GET` | `/session/:sessionId/cron` | 列出该 session 所有 cron jobs（含 nextFireAt） | `200` + `{ items: CronJobSummary[] }` |

```typescript
interface CronJobSummary {
  id: string;                // 全局唯一（含 session 前缀），UI 用作 key
  sessionId: string;
  name: string;
  cron: string;              // 5 字段 raw expr
  tz: string;                // IANA（用于 UI 展示时区）
  prompt: string;
  enabled: boolean;
  createdAt: string;         // ISO
  lastFiredAt: string | null;
  nextFireAt: string | null; // 现算：computeNextCronRunMs(cron, now, tz)；enabled=false 时=null
}
```

**鉴权**：session 存在 + 调用方对该 session 有读权限（与 `/session/:id/memory` 同模式）。
**错误**：`404` session 不存在；`403` 无权限。

### 2.2 `POST /session/:sessionId/cron` — 新建 cron job

| 方法 | 路径 | 请求体 | 成功响应 |
|---|---|---|---|
| `POST` | `/session/:sessionId/cron` | `CreateCronBody` | `201` + `CronJobSummary` |

```typescript
interface CreateCronBody {
  cron: string;              // required，5 字段，校验 parseCronExpression(cron) !== null
  prompt: string;            // required，非空
  name?: string;             // optional，缺省 = prompt.slice(0,30)
  enabled?: boolean;         // optional，缺省 true
  timezone?: string;         // optional，IANA（如 Asia/Shanghai）；v0.0.58.cron-fix2
                             // UI HTTP 传 client local（Intl），agent 工具不传
}
```

**行为**：
1. 校验 cron expr 合法（不合法 400）+ prompt 非空（400）。
2. 取 tz：`body.timezone`（UI HTTP 传 client local Intl）优先 → 否则 `resolveTz` fallback（session.timezone → squad.timezone → server 进程本地）。`squadId` 始终派生自 session（payload.squadId 用于 budget gate）。
3. 生成 cronJobId（ulid）→ Job → `engine.register + cronStore.upsertJob`。
4. 返 CronJobSummary（含现算 nextFireAt，按最终 tz 算）。

**错误**：`400` cron expr 非法 / prompt 空 / body 非法 JSON；`404` session 不存在。

### 2.3 `PATCH /session/:sessionId/cron/:jobId` — 更新

| 方法 | 路径 | 请求体 | 成功响应 |
|---|---|---|---|
| `PATCH` | `/session/:sessionId/cron/:jobId` | `UpdateCronBody` | `200` + `CronJobSummary` |

```typescript
interface UpdateCronBody {
  cron?: string;             // 校验合法性
  prompt?: string;
  name?: string;
}
```

**注意**：`enabled` 不在 PATCH（用 dedicated enable/disable 端点）；`tz` 不可改（绑 session）。
**行为**：read-modify-write（cron.json 全量 read → modify → 原子写）；engine.register 替换。
**错误**：`400` cron 非法；`404` session/job 不存在。

### 2.4 `POST /session/:sessionId/cron/:jobId/disable` — 禁用

| 方法 | 路径 | 成功响应 |
|---|---|---|
| `POST` | `/session/:sessionId/cron/:jobId/disable` | `200` + `{ id, enabled:false }` |

**行为**：`engine.register({...job, enabled:false})` + `cronStore.upsertJob`。disabled 期间 isDue=true 也跳过（engine.tick 内 `if (!job.enabled) continue`）。

### 2.5 `POST /session/:sessionId/cron/:jobId/enable` — 启用

| 方法 | 路径 | 成功响应 |
|---|---|---|
| `POST` | `/session/:sessionId/cron/:jobId/enable` | `200` + `{ id, enabled:true }` |

**行为**：`engine.register({...job, enabled:true})` + `cronStore.upsertJob`。
**注意**：enable 不重置 lastFiredAt（保续接，下次 isDue 仍按 lastFiredAt+expr 算）。响应**只回 `{id, enabled:true}`**，不含 `nextFireAt`（nextFireAt 由 scheduler tick 异步算 + GET list/GET detail 响应时现算，enable/disable 端点不现算）；如需立即看 nextFireAt 调用 `GET /session/:sid/cron`。

### 2.6 `DELETE /session/:sessionId/cron/:jobId` — 删除

| 方法 | 路径 | 成功响应 |
|---|---|---|
| `DELETE` | `/session/:sessionId/cron/:jobId` | `200` + `{ id, deleted:true }` |

**行为**：`engine.unregister(jobId)` + `cronStore.removeJob`。永久删除（非归档）。

---

## 3. Agent 工具（单工具 `cron`，注册到 defaultTools）

v0.0.104 起 6 个独立工具（cron_create/list/update/disable/enable/delete）合并为**单工具 `cron` + action enum**（仿 browser 工具范式）。`run()` 解析 `input.action` → 前置校验 → dispatch 分流到原 6 操作实现（6 操作实现未动，复用 cron-tool-shared.ts）。

**action → 参数/出参矩阵**：

| action | 入参 | 出参（ToolResultBlock.content） | 行为 |
|---|---|---|---|
| `create` | `{action, cron, prompt, name?, enabled?}` | `{jobId, cron, name, nextFireAt}` | 校验 cron expr → resolveTz fallback（session→squad→server，§1 tz）→ 建 Job → engine.register + cronStore.upsertJob |
| `list` | `{action}` | `{jobs: CronJobSummary[]}` | 读 cronStore.loadJobs(sessionId) |
| `update` | `{action, jobId, cron?, prompt?, name?}` | `{jobId, cron, name, prompt}` | 校验 → read-modify-write → register + upsert |
| `disable` | `{action, jobId}` | `{jobId, enabled:false}` | register(enabled:false) + upsert |
| `enable` | `{action, jobId}` | `{jobId, enabled:true}` | register(enabled:true) + upsert |
| `delete` | `{action, jobId}` | `{jobId, deleted:true}` | engine.unregister + cronStore.removeJob |

> `enabled` 不在 update（用 disable/enable action）；`tz`/`sessionId` 自动取，agent 不传（§1 tz 来源）。

### 3.1 共通契约

- **sessionId 自动取** `ctx.session.id`（agent 不传 sessionId）。
- **action 前置校验**：`run()` 先校验 `action`——缺失 → errorResult `cron: action 必填 ...`；非法值 → `cron: action 非法 ...`；均 isError=true（action 合法才进 dispatch）。
- **错误**：isError=true + content TextBlock `[cron:<action>] <reason>`；典型错误：
  - `cron expr invalid: <expr>` — parseCronExpression 返 null
  - `prompt required` — 空字符串
  - `job not found: <jobId>` — update/disable/enable/delete 不存在
  - `[cron:create] internal error: <reason>` — 落盘失败等
- **TOOL_POLICY bound**：playground / studio-leader / studio-mate 各绑 `'cron'`；squad / subagent 不绑（详 `[P1]cron_subsystem.md §11`）。

### 3.2 inputSchema（cron 单工具）

```typescript
{
  name: 'cron',
  description: '当前 session 自治 cron 管理（6 action）。到点以 prompt 作提示词唤醒本 session。tz 自动取（agent 不传）。与 UI HTTP 正交（共享底层 persistence/engine）。',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'disable', 'enable', 'delete'],
        description: 'create=新建 cron job / list=列出本 session 全部 jobs / update=改 cron·prompt·name（不改 enabled，用 disable/enable）/ disable=禁用 / enable=启用 / delete=永久删',
      },
      cron: { type:'string', description:'action=create/update：5 字段 cron expr（minute-hour-dom-month-dow，不支持 L/W/?/name 别名），如 "*/30 * * * *"（每 30 分钟）/ "0 9 * * 1-5"（工作日 9 点）' },
      prompt: { type:'string', description:'action=create/update：到点投递的提示词（任务描述），agent 醒来后据此自主决定做不做' },
      name: { type:'string', description:'action=create/update：可选，任务名（缺省 = prompt 前 30 字）' },
      enabled: { type:'boolean', description:'action=create：可选，缺省 true' },
      jobId: { type:'string', description:'action=update/disable/enable/delete：cron job id（cron list 返回的 id）' },
    },
  },
}
```

### 3.3 与 UI HTTP 的关系

| 操作 | agent 工具 | UI HTTP | 共享底层 |
|---|---|---|---|
| 新建 | `cron` action=create | `POST /session/:sid/cron` | CronStore.upsertJob + engine.register |
| 列表 | `cron` action=list | `GET /session/:sid/cron` | CronStore.loadJobs |
| 更新 | `cron` action=update | `PATCH /session/:sid/cron/:jid` | CronStore.upsertJob + engine.register |
| 禁用 | `cron` action=disable | `POST .../disable` | 同上 |
| 启用 | `cron` action=enable | `POST .../enable` | 同上 |
| 删除 | `cron` action=delete | `DELETE /session/:sid/cron/:jid` | CronStore.removeJob + engine.unregister |

> 两路径**完全独立**调用底层（互不感知），均原子写 + engine 同步。同 session 同时刻并发（agent 调 `cron` action=create 同时 UI 调 POST）由 `cronStore.upsertJob` 的 read-modify-write + 单进程顺序保证（v0.0.33.4 scheduler.json 同模式）。

---

## 4. CronJobSummary 共享形态（agent 工具 + UI HTTP 共用）

```typescript
interface CronJobSummary {
  id: string;
  sessionId: string;
  name: string;
  cron: string;
  tz: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  nextFireAt: string | null;  // 现算：computeNextCronRunMs(cron, now, tz)；enabled=false → null
}
```

**nextFireAt 计算时机**：每次 list / create / update 响应时现算（不持久化）。`tz` 来源（v0.0.58.cron-fix2）：create 时 `body.timezone`（UI HTTP）优先，否则 resolveTz fallback；list/update 沿用 job 创建时落盘的 tz（cron.json `jobs[].tz`）。

---

## 5. AT 落点（PRD 5 路径）

| PRD 路径 | AT case | 文件 |
|---|---|---|
| 路径 1（playground cron 触发） | `tests/api/cron/playground_cron_fire_tc1/` | 新建 |
| 路径 2（UI 管理 CRUD） | `tests/api/cron/ui_cron_crud_tc1/` | 新建 |
| 路径 3（squad mate 归属） | `tests/api/cron/squad_mate_cron_tc1/` | 新建 |
| 路径 4（重启续接 lastFiredAt） | `tests/api/cron/cron_restart_resume_tc1/` | 新建 |
| 路径 5（heartbeat 回归） | 复用现有 `tests/api/squad/heartbeat_*` 系列（不动，只验不破坏） | 已有 |

详细 case 设计由 api-test-designer 按 test-plan 设计（断言基于本 change_log + 各端点契约，不看代码）。

---

## 6. 边界

- **不在 UI HTTP 暴露 raw cron expr 校验细节**：UI 端 `POST/PATCH` 返 400 时 body 含 `cron expr invalid` 即可，UI 用 cronstrue 现算能否翻译作辅助提示。
- **agent 工具不暴露 cron JSON path**：agent 只看到 `CronJobSummary`，不知道底层 cron.json 文件位置。
- **session 销毁自动注销**：HTTP 不暴露「批量注销」端点，session 销毁由 `session-store.deleteSession` 内部 hook 触发。
- **squad budget gate 透明**：UI / agent 不感知 cron fire 是否被 budget gate skip；用户只能观察到「到点没触发」（lastFiredAt 没推进）。

---

## 7. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/handlers/cron-handler.ts` | 新增 | 6 UI HTTP 端点（GET/POST/PATCH/disable/enable/DELETE），调 cronAdapter + engine |
| `app/server/src/server.ts`（路由注册位置） | 修改 | 注册 cron-handler 6 路由 |
| `app/server/src/tools/cron/cron-tool.ts` | 新增 | 6 agent 工具实现（cron_create/list/update/disable/enable/delete） |
| `app/server/src/tools/cron/types.ts` | 新增 | CronJobSummary / CreateCronBody / UpdateCronBody interface |
| `app/server/src/tools/registry.ts` | 修改 | defaultTools 加 6 cron tools |
| `app/server/src/tools/tool-policy.ts` | 修改 | playground / studio-leader / studio-mate bound 加 6 cron tools；squad/subagent 不加 |
| `specs/api/overall/16-cron.md` | 新增 | 本文件（端点契约） |
| `specs/api/version_logs/v0.0.58.cron/change_log.md` | 新增 | 跨版本发布说明 |

---

> 变更历史见 `specs/api/version_logs/vX.Y/change_log.md`；tech 权威见 `specs/tech/scheduling/`。
