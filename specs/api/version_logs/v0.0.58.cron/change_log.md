# v0.0.58.cron API Change Log — cron UI HTTP + agent 工具

> version: 1.0 · 2026-07-03
> PRD 权威：`specs/prd/version_logs/v0.0.58/change_log.md`
> Tech 权威：`specs/tech/version_logs/v0.0.58.cron/change_log.md`

---

## 1. 新增端点 — `16-cron.md`

### 1.1 UI 专用 HTTP（6 个）

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/session/:sessionId/cron` | 列出该 session 全部 cron jobs（含现算 nextFireAt） |
| `POST` | `/session/:sessionId/cron` | 新建（body: `{cron, prompt, name?, enabled?}`） |
| `PATCH` | `/session/:sessionId/cron/:jobId` | 更新（body: `{cron?, prompt?, name?}`） |
| `POST` | `/session/:sessionId/cron/:jobId/disable` | 禁用 |
| `POST` | `/session/:sessionId/cron/:jobId/enable` | 启用 |
| `DELETE` | `/session/:sessionId/cron/:jobId` | 删除 |

- **路径前缀**：`/session/:sessionId/cron`（对齐 v0.0.55 长期记忆 UI 端点 `/memory/:scope` + sessionId 模式）
- **共享底层**：与 agent cron 工具共用 CronPersistenceAdapter + SchedulerEngine，**正交**（不互相调用，同操作两入口）
- **鉴权**：与 `/session/:id/memory` 同模式（verify session 存在 + 调用方权限）
- **nextFireAt**：每次响应时现算（`computeNextCronRunMs(cron, now, tz)`）；`enabled=false` → null

### 1.2 CronJobSummary（共享响应形态）

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
  nextFireAt: string | null;
}
```

UI / agent 工具响应均用此形态（除 create/update 等窄响应）。

## 2. 新增 agent 工具 — `16-cron.md §3`

| 工具 | 入参 | 出参 |
|---|---|---|
| `cron_create` | `{cron, prompt, name?, enabled?}` | `{jobId, cron, name, nextFireAt}` |
| `cron_list` | `{}` | `{jobs: CronJobSummary[]}` |
| `cron_update` | `{jobId, cron?, prompt?, name?}` | `{jobId, cron, name, prompt}` |
| `cron_disable` | `{jobId}` | `{jobId, enabled:false}` |
| `cron_enable` | `{jobId}` | `{jobId, enabled:true}` |
| `cron_delete` | `{jobId}` | `{jobId, deleted:true}` |

- **sessionId 自动取** `ctx.session.id`（agent 不传）。
- **TOOL_POLICY bound**：playground / studio-leader / studio-mate 默认绑；squad / subagent 不绑。
- **cron expr 校验**：`parseCronExpression(cron) !== null`，否则 isError=true + reason。

## 3. 共享契约

- **cron expr 标准**：5 字段 minute-hour-dom-month-dow（不支持 L/W/?/name 别名，详 tech `[P0]cron_expr.md §2`）。
- **tz 取值**：session.timezone（新字段）> squad.timezone > 进程本地。agent / UI 都不传 tz。
- **cron job 归属**：session（不归属 squad）。session 销毁自动注销（HTTP 不暴露批量注销端点）。

## 4. 修改端点 — `04-agent-session.md`

### 4.1 `POST /session` 接受 `timezone`

```typescript
interface CreateSessionBody {
  // ... 现有字段 ...
  timezone?: string;   // IANA，optional，缺省 fallback squad.timezone > 进程本地
}
```

**注意**：本版本仅 schema 字段 + 服务端默认值；UI 改 timezone 入口留 backlog。

### 4.2 session store 新增 `onSessionDestroyed` 回调

非 HTTP 端点，但影响 session 销毁副作用契约：`deleteSession()` 末尾调注入的回调（cron 子系统 wire 注销 cron jobs）。对外 HTTP 行为不变。

## 5. AT 落点（PRD 5 路径）

| PRD 路径 | AT case | 文件 |
|---|---|---|
| 路径 1（playground cron 触发） | `tests/api/cron/playground_cron_fire_tc1/` | 新建 |
| 路径 2（UI 管理 CRUD） | `tests/api/cron/ui_cron_crud_tc1/` | 新建 |
| 路径 3（squad mate 归属） | `tests/api/cron/squad_mate_cron_tc1/` | 新建 |
| 路径 4（重启续接 lastFiredAt） | `tests/api/cron/cron_restart_resume_tc1/` | 新建 |
| 路径 5（heartbeat 回归） | 复用现有 `tests/api/squad/heartbeat_*` 系列（不破坏即可） | 已有 |

**AT 关键断言**（designer 设计 case 时基于本契约）：
- `cron_create` 返 201 + CronJobSummary，含 nextFireAt 现算值
- `cron_list` 返数组（含多 job 顺序）
- disable → 到点不触发（nextFireAt=null）
- enable → 恢复（nextFireAt 非 null）
- delete → 后续 GET 返空 / GET single 404
- 重启后 cron job 仍存在（lastFiredAt 续接）

## 6. 边界

- **不在 UI 暴露 cron.json 文件路径**：UI / agent 只看到 CronJobSummary。
- **不在 UI 暴露 budget gate 细节**：用户只能观察「到点没触发」（lastFiredAt 没推进），不直接告知 budget skip。
- **agent 工具不暴露 tz 字段**：tz 由 session 派生（agent 不知道用户时区）。
- **squad chat session 不绑 cron 工具**：squad chat 是哑路由不调工具；cron 工具绑 playground / leader / mate session。

---

> Tech 权威：`specs/tech/scheduling/`。
