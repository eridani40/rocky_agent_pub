# v0.0.205.t2_cons — API 变更日志（整理优化 + 存储模型统一）

> 引入版本 v0.0.205.t2_cons · 2026-07-26
> 一句话：本版本 API 域 2 项变更——`GET /consolidation/status` 响应加 `status`/`startedAt`（T2 整理 running 态可观测，修前端切走切回 UX bug）；`GET /skill` 加 `?sessionId=` 参数 + `SkillEntry.scope` 值域 `'squad'`→`'group'`（skills 入口 UI 数据源 + scope 三层改名）。
> 权威契约：`specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md`（method 级）。

## 1. `GET /consolidation/status` 响应字段扩展（非破坏性新增）

| 端点 | 变更 | 契约位置 |
|---|---|---|
| `GET /consolidation/status` | 响应加 `status: 'running'\|'idle'\|'failed'` + `startedAt: string\|null`（源自 AppTaskLock 内存态；done 归 idle） | `specs/api/overall/03-config-center.md §2.7` |

- 非破坏性：只加字段，旧前端忽略新字段继续工作。
- 配套后端行为（非 API 面）：`AppTaskLock.acquire` 加超时接管（running 且 startedAt>1h → 强制获取，内存 only 不落盘）。

## 2. `GET /skill` 加 `?sessionId=` 参数 + scope 值域 squad→group

| 端点 | 变更 | 契约位置 |
|---|---|---|
| `GET /skill` | ① query 加 `?sessionId=<sid>`（handler 经 sessionStore 解析 workspace + groupDir；与 `?workspace=` 并存时 sessionId 优先；session not found → 404）；② `SkillEntry.scope` 值域 `'squad'` → `'group'`（group=squad 或 classroom 团队 ws `<groupWs>/.rocky/skills/`，原路径 `.rocky_squad/skills/` 废止） | `specs/api/overall/06-skill.md §3` |

- ① 非破坏性新增（chat 悬浮菜单 skills 入口数据源，前端按 scope 分 session/group/global 三 tab）。
- ② **破坏性值变更**：前端/测试按 `scope === 'squad'` 过滤的逻辑需同步改 `'group'`；存量 squad skills 由 MigrationManager `squad-rocky-dir` handler 平移到 `.rocky/skills/`。

## 3. 不变项（明确边界）

- `/memory/*` UI 端点契约**不变**（scope 仍 `global|session` 两值；底层介质换 per-entry md 对用户透明；group scope 本版不进 UI）。
- `POST /consolidation/run`、`/config/app?group=consolidation` 契约不变。
- `memory_manage` / `skill_manage` 工具（LLM 面，非 HTTP）scope 枚举 `'squad'`→`'group'` 属工具契约变更，记录在 `specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md` 模块 A4。
