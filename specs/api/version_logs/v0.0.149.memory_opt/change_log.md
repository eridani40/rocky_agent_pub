# v0.0.149.memory_opt — API Change Log（memory entry 加 source/updatedAt + 响应落盘值）

> 增量变更。全量权威：`specs/api/overall/15-memory-ui.md`（version 3.1）。
> 权威输入：`specs/prd/version_logs/v0.0.149.memory_opt/change_log.md`（需求 3）+ `specs/tech/version_logs/v0.0.149.memory_opt/change_plan.md`（F1/H1）。
> 一句话：memory entry schema 加 `source`/`updatedAt` 两字段；POST/PATCH 响应改用 service 落盘值（消除「落盘值≠响应值」双戳）。session group 走通用 KV（无新端点）。

## §1 entry schema 扩展（additive，非 breaking）

`MemoryEntry` 新增两字段（request/response 全链路；落两介质 managed-store + user-memory-service）：

| 字段 | 类型 | 含义 | 写侧规则 |
|------|------|------|---------|
| `source` | `'user' \| 'agent'` | originator：UI 写='user' / agent 工具写='agent'；**存量=agent** | **POST origin=user**（handler 显式传 `source:'user'`）；**PATCH 不改 source**（origin 不可变，保留既有）；**archive 保留既有**（非 write 路径不刷戳） |
| `updatedAt` | string (ISO 8601) | 最后修改时间；**service 落盘值**；组内排序依据 | **POST/PATCH 刷新为 now**；**archive 保留既有**；存量由 migration 补 now |

**存量 migration**：`migrateMemorySourceUpdatedAt(appConfig, dataDir)`（bootstrap 启动一次性、字段缺失为 marker、幂等非破坏）；覆盖 user_memory entries[] + sessions/`*`/session_memory.md。

## §2 POST/PATCH 响应变更（关键 — service 落盘值，非响应层合成）

**[v0.0.149 关键订正]**：POST/PATCH 响应里的 `entry` 改用 service 层落盘的真实对象（`{ entry: written }`），**不再在 HTTP 响应层临时合成 `updatedAt: nowIso()`**。

- **变更前**（v0.0.148）：handler `memory.ts handleMemoryCreate/handleMemoryUpdate` 在响应层临时拼 `updatedAt: nowIso()`（L125/139/184/205）但未真正落盘——「落盘值≠响应值」双戳风险。
- **变更后**（v0.0.149）：updatedAt 成真正落盘字段后，POST/PATCH 响应改用 service 落盘的 `written` 对象（`{ entry: written }`），消除双戳。
- **DELETE 的 `archivedAt` 仍用 `nowIso()`**（不变；archive 与 updatedAt 不同字段，archive 非 write 路径不刷 updatedAt）。
- **archive 路径**（`archiveEntry`/`UserMemoryService.archive`）按 contract 仅 write 刷 updatedAt 时机 — archive 不刷戳（保留既有 source/updatedAt）。

## §3 不变契约（本版显式确认）

| 端点/字段 | 状态 | 说明 |
|-----------|------|------|
| `GET /memory/:scope` | 不变（响应体加 source/updatedAt 字段，additive） | entries[] 元素加 source/updatedAt；缺失 source 读 `'agent'`，缺 updatedAt 读 `''` |
| `POST /memory/:scope` | path/body 不变；响应 `entry` 加 source/updatedAt（落盘值） | UI POST origin=user 盖 source；updatedAt=now |
| `PATCH /memory/:scope/:name` | path/body 不变；响应 `entry` 加 source（保留既有）/updatedAt（刷新） | **不接受 source 改动**（PATCH body 即便含 source 也忽略，保留既有 origin） |
| `DELETE /memory/:scope/:name` | 不变 | 响应 `{ ok, archivedAt }` 不变；archive 保留 entry 既有 source/updatedAt |
| 300 词硬限 / evolvable gate | 不变 | service 层单点强制（覆盖 UI + agent 两路径） |

## §4 session group（应用设置 KV，无新端点）

`app_config` 新 group `session`（key=default，data={maxSkillInject?, maxMemoryInject?}，缺失回退 50）走**通用 KV CRUD**（`/config/app/session` GET/PUT 复用既有 `/config/app/:group` 通用 KV 路径），**无新 API 端点**。详 `specs/tech/config/[P0]app_config.md §3.15` + UI `specs/ui/components/app-dev-config-page/section-session-config.md`。

## §5 AT 影响

无新 AT case（用户铁律：纯确定性逻辑无 LLM 不确定性，不进 AT）。既有 memory AT case（`tests/api/memory/session_memory_crud_tc1/` / `user_memory_crud_tc1/`）若 assert 了 entry schema，需在 recording_drift 重录时同步加 source/updatedAt 字段断言；recordings 不主动改（回放轮 drift 触发再重录）。

## §6 文件变更

| 文件 | 变更 |
|------|------|
| `specs/api/overall/15-memory-ui.md` | §1 头注（version 3.1 + v0.0.149 标记）；§2 entry schema 加 source/updatedAt + v0.0.149 注；§3.2 GET 响应示例加 source/updatedAt；§4.2/§5.2 POST/PATCH 响应说明改「service 落盘值」；§8 强制点加 source/updatedAt 流向 |
