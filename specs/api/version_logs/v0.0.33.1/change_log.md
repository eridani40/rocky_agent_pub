# v0.0.33.1 API 变更日志 — Squad CRUD + Studio 管理 API（对话全占位）

## 概述

本版本新增 squad/member/charter 三组管理 HTTP 端点（CRUD + hire/edit/deploy/bench + charter GET/PUT/history），session 加 bizType/squadId/memberId 三字段，POST messages 对 studio session 返 403 `studio_chat_not_ready`（占位 chat），GET /session 按 bizType 过滤隔离 Playground。**agent loop 完全不接**，所有管理动作走 HTTP + UI。

**权威接口契约**：`specs/api/overall/11-squad.md`（框架：session schema + 占位 chat 403 + bizType 隔离 + SSE + AT 映射）+ `specs/api/overall/11a-squad-endpoints.md`（端点契约主体：squad CRUD + member 管理 + charter 的 payload/响应/行为/错误码）。本文是变更总结 + 索引，不重复抄端点表。

**父版本**：v0.0.33（squad 启动）；**地基依赖**：v0.0.28（multi_agent session schema）+ v0.0.27（session_meta_update SSE）。

---

## 1. 新增端点（11a-squad-endpoints.md §1-§3）

### 1.1 Squad CRUD（11a-squad-endpoints.md §1）

| 方法 | 路径 | 行为 |
|------|------|------|
| POST | /squad | 建 squad（事务：squad + leader member + leader session + 群聊 session + 目录骨架，含补偿回滚） |
| GET | /squad | 列表（按 updatedAt desc，本版不分页） |
| GET | /squad/:id | 详情（含 members + charter + 各 sessionId） |
| PATCH | /squad/:id | 改 name/description/modelDefault；占位 budget/enableHeartBeat |

**无 DELETE**——squad 不可删（design.md §1.1 锁定；req.md 旧版 `DELETE /squad → _archived` 已推翻）。

### 1.2 Member 管理（11a-squad-endpoints.md §2）

| 方法 | 路径 | 行为 |
|------|------|------|
| POST | /squad/:id/member | hire（fresh / derive），建 mate member + mate session + workspace |
| PATCH | /squad/:id/member/:mid | edit（name/systemPrompt/tools/skills/model；不可改 role/state/squadId/sessionId） |
| POST | /squad/:id/member/:mid/deploy | state: benched → deployed |
| POST | /squad/:id/member/:mid/bench | state: deployed → benched + 通知 user；**leader 返 403 leader_not_benchable** |

**无 DELETE member**——bench 兜底（无 fire；长期 bench = 离队，record 保留可审计）。

### 1.3 Charter（11a-squad-endpoints.md §3）

| 方法 | 路径 | 行为 |
|------|------|------|
| GET | /squad/:id/charter | 读 4 字段（embedded in squad record） |
| PUT | /squad/:id/charter | partial patch（4 字段子集）+ 写一条 charter_history（append-only） |
| GET | /squad/:id/charter/history | 变更历史（时间倒序，limit 缺省 50） |

> charter 不关联 member（4 定性字段 embedded in squad record）。本版由 user 在 UI/API 直接管理（v3 才接 leader 对话驱动 update_charter）。

---

## 2. Session 字段增量（11-squad.md §2）

现有 `GET /session` / `GET /session/:id` / SSE `session_meta_update` 响应 Session 新增 3 个 optional 字段：

| 字段 | 语义 |
|------|------|
| `bizType?: "playground" \| "studio"` | optional，空=playground；studio session（squad/leader/mate/studio 内 subagent）显式 studio |
| `squadId?: string` | 所有 studio session 带（单向 → squad） |
| `memberId?: string` | 仅 leader/mate session（双向 member.sessionId） |

**type 取值统一**：`'member' → 'mate'`（B 方案，避免与 member entity 撞名）。session.type 取值集合 = `'squad' | 'leader' | 'mate' | 'subagent'`。

> **bizType 隔离三处必须都覆盖**（PRD §8）：session 字段 + GET /session 过滤 + UI 路由分离，任一漏则 Playground 列表被污染。

---

## 3. Session 端点语义变更（11-squad.md §4）

### 3.1 GET /session 加 bizType query 过滤（11-squad.md §4.1）

`GET /session?bizType=playground|studio`，**缺省 playground**——保证 Playground 列表干净（不含任何 squad/leader/mate/studio-subagent session）。现存 session lazy 默认 playground（不写值）。

### 3.2 POST /session/:id/messages 对 studio session 返 403（11-squad.md §4.5）

| 场景 | 响应 |
|------|------|
| `:id` 是 studio session（bizType=studio） | `403` + `{ "error": "studio_chat_not_ready" }` |
| `:id` 是 playground session | 沿用现有语义（`04-agent-session.md §3.2`） |

**理由**：v0.0.33.1 agent loop 完全不接，占位 chat 双层防护——即便前端被绕过（curl 直接打），后端也拒绝，保证不调 LLM、不报错。v0.0.33.2 接通后移除此 403。

> **GET /messages 仍可读**（占位 chat 不阻塞用户查看历史 transcript）。
>
> **与 v0.0.28 subagent 403 区分**：subagent session 返 `403 subagent_readonly`（v0.0.28 已实现）；studio session 返 `403 studio_chat_not_ready`（本版）。两者正交。

### 3.3 GET /session/:id/children 复用（11-squad.md §4.3）

沿用 v0.0.28（`10-multi-agent.md §3`）。对 studio 内 subagent session 同样生效（type=subagent, bizType=studio, squadId 跟 parent）。

---

## 4. SSE 策略（11-squad.md §5）

| 变更类型 | 策略 |
|---------|------|
| **session 变更**（建 squad/hire 建的 leader/mate session 等） | 复用 v0.0.27 `session_meta_update`（topic=session_meta, group=_all）——所有 session 变更广播，会话列表据此更新 + 树形分组 |
| **squad/member/charter 变更**（hire/bench/deploy/edit/charter PUT） | **v0.0.33.1 用 refetch**（操作后前端 GET /squad/:id 拉最新详情）；`squad_meta` SSE 留 v4（心跳多 member 变化时再加） |

> **单用户操作场景**：squad/member 变更不走 SSE 也够用（用户自己操作后立即 refetch）。SSE 留给 v4 心跳触发的多 member 状态变化。

---

## 5. 错误码新增（11-squad.md §6）

| HTTP | error code | 场景 |
|------|------------|------|
| 403 | `leader_not_benchable` | POST .../member/:mid/bench 对 leader（leader 永远 deployed） |
| 403 | `studio_chat_not_ready` | POST /session/:id/messages 对 studio session（占位 chat） |
| 409 | `member_name_conflict` | hire 时 name 在 squad 内重复（a2a 寻址要求 squad 内唯一） |

其他沿用 `04-agent-session.md §9` 标准 400/404/500。

---

## 6. PRD 8 路径 → API 端点映射（验证覆盖）

| PRD 路径 | 用到的端点 | 验证类型 |
|----------|-----------|---------|
| **路径 1（建 squad wizard 事务）** | POST /squad + GET /squad/:id（一致性断言） | AT（HTTP 全验） |
| **路径 2（hire fresh + derive）** | POST /squad/:id/member（fresh + derive）+ GET /squad/:id | AT |
| **路径 3（bench/deploy + leader 不可 bench）** | POST .../bench + POST .../deploy + POST .../leader/bench（403） | AT |
| **路径 4（edit member）** | PATCH /squad/:id/member/:mid + GET /squad/:id | AT |
| **路径 5（charter 编辑 + history）** | PUT /squad/:id/charter + GET /squad/:id/charter + GET /squad/:id/charter/history | AT |
| **路径 6（占位 chat）** | POST /session/:id/messages（403）+ GET /session/:id/messages（可读） | AT |
| **路径 7（Playground 隔离）** | GET /session?bizType=playground + GET /session?bizType=studio | AT |
| **路径 8（nav-rail 改造）** | （纯 UI，无 API） | ET（不验 API） |

> **路径 1-7 全 HTTP**——AT 直接 curl 全验。路径 8 是纯 UI 改造（Playground/Studio 切换 + 设置组折叠），ET 覆盖。
>
> **占位 chat 不依赖 LLM**——v0.0.33.1 agent loop 完全不接，AT 验 403 即可（符合 mock-default-on + AT case 黑盒原则，不跑真 LLM）。

---

## 7. 文件变更清单（引用 11-squad.md §8）

详见 `specs/api/overall/11-squad.md §8`（router / handlers / services / stores / session-store / sse / broadcaster 全清单）。本文不重复抄。

**新增文件**：`handlers/squad.ts` + `handlers/member.ts` + `handlers/charter.ts` + `services/squad-service.ts` + `services/charter-service.ts` + `stores/squad-store.ts`。
**修改文件**：`router.ts` + `handlers/session.ts` + `session-store.ts` + `handlers/sse.ts` + `session-meta-broadcaster.ts`。

---

## 8. 版本

version: 1.0 `[v0.0.33.1]`（首版 API 变更日志：①§1 新增 squad CRUD（无 DELETE）+ member 管理（hire/edit/deploy/bench，leader 403，无 DELETE）+ charter（GET/PUT/history，PUT 写 append-only history）三组端点；②§2 Session 加 bizType/squadId/memberId 三字段 + type member→mate 统一；③§3 GET /session 加 bizType query 缺省 playground + POST messages 对 studio session 返 403 studio_chat_not_ready + GET /children 复用；④§4 SSE 策略（session 变更复用 session_meta_update / squad/member 变更用 refetch，squad_meta SSE 留 v4）；⑤§5 新增 3 个 error code（leader_not_benchable / studio_chat_not_ready / member_name_conflict）；⑥§6 PRD 8 路径 → API 映射，路径 1-7 全 HTTP / 路径 8 纯 UI。权威契约在 `specs/api/overall/11-squad.md`（框架）+ `specs/api/overall/11a-squad-endpoints.md`（端点主体））。
