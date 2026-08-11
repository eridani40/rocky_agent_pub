# Squad Management HTTP API（squad / member / studio chat）

> version: 1.2 · 引入版本 v0.0.33.1 · v0.0.33.2 修订：studio chat 拆 403，squad/leader/mate 接 agent loop；subagent 仍只读。**`[v0.0.237 removed]`** charter 三端点（GET/PUT/GET history `/squad/:id/charter`）+ `/squad/:id/board/*` 全套 endpoint 整体移除——squad 不再有 charter 字段 / charter_history entity / board 工作项；AT 不可再 curl 这些端点。
> 管什么：squad 层 API 的**框架性内容**——概述 + 设计原则 + session schema 增量字段（bizType/squadId/memberId）+ studio chat 行为 + bizType 隔离 + SSE 策略 + 错误码 + AT 映射 + 文件清单。
> **端点契约主体（payload/响应/行为）在姊妹文件 `11a-squad-endpoints.md`**：squad CRUD + member 管理两组端点的完整契约（charter 组已于 v0.0.237 移除）。
> 不管什么：agent loop 内部机制（→ tech agent specs）；team 写 action/task/goal/requirement（→ v0.0.33.3）；心跳/budget/scheduler（→ v0.0.33.4）；UI 渲染（→ `specs/ui/06-studio.md` + `specs/ui/components/`）；session 通用机制（→ `04-agent-session.md`）；a2a/spawn 细节（→ `10-multi-agent.md` / `10a-multi-agent-tool-ref.md`）。
> **本文件 + `11a-squad-endpoints.md` 共同构成 AT（API Test）squad 域依据**：api-verifier 黑盒 curl，不读代码。
>
> 范围红线：v0.0.33.1 管 CRUD + 占位；v0.0.33.2 仅拆 studio chat 403 并语义化 a2a/team 只读，未新增 HTTP 端点。
>
> **权威概念源**：`specs/tech/squad/[P1]data_model.md` + `[P1]squad_definition.md` + `specs/tech/agent/session/[P0]session_store.md` + `[P0]session_biztype.md` + `specs/ui/06-studio.md`。系统设计：`states/v0.0.33.1/design.md`。

## 1. 概述

squad API 最大化复用现有 session 端点 + 新增 squad/member 两组管理端点（charter 组已于 `[v0.0.237 removed]`）。v0.0.33.2 不新增 HTTP 端点，只让 studio 对话路径生效。本文件变更分五类：

| 类型 | 说明 |
|------|------|
| **A. Session schema 增量字段** | 现有 `GET /session` / `GET /session/:id` 响应 Session 增 `bizType?/squadId?/memberId?` 三字段（§2）。studio session 经 bizType=studio 在现有列表过滤暴露。 |
| **B. Squad CRUD**（新 HTTP） | POST/GET/GET/:id/PATCH `/squad`。建队事务（leader member + leader session + 群聊 session + 目录骨架）。**无 DELETE**（squad 不可删）。端点契约 → `11a §1` |
| **C. Member 管理**（新 HTTP） | POST `/squad/:id/member`（hire fresh/derive）/ PATCH `/squad/:id/member/:mid`（edit）/ POST `.../deploy` / POST `.../bench`（leader 返 403）。**无 DELETE**（bench 兜底）。端点契约 → `11a §2` |
| **D. ~~Charter~~**（~~新 HTTP~~，**`[v0.0.237 removed]`**） | ~~GET / PUT / GET history `/squad/:id/charter`~~。原 PUT 是 partial patch，写一条 charter_history（append-only）。**charter 全链路已移除**，AT 不可 curl。历史契约见 `11a §3`（退役） |
| **E. Studio chat + bizType 隔离** | `[v0.0.33.1]` POST studio 返 403；`[v0.0.33.2]` squad/leader/mate POST messages 返 202 接 loop，subagent 仍 403；GET `/session?bizType=...` 按业务类型过滤。§4 |

### 1.1 设计原则

1. **squad 是团队信息权威源**——member/role/sessionId 靠 squad 双向同步（应用层 service 单点维护，详见 `data_model.md §2`）。
2. **session 端点复用现有**（GET /session、GET /session/:id、GET /session/:id/messages、GET /session/:id/children）——新概念靠 `bizType/squadId/memberId` 三字段暴露，不另起一套。
3. **squad/member/charter 是新 entity → 新 HTTP 端点**（CRUD + 管理）。
4. **LLM 工具 `team`/`task`/`goal`/`requirement` 留 v3**（本版本不做对话驱动；管理全走 HTTP + UI）。
5. **Studio chat 演进**：`[v0.0.33.1]` studio POST messages 返 403 占位；`[v0.0.33.2]` squad/leader/mate 拆 403 接 loop，subagent 仍只读。
6. **squad/member 不可删，leader 不可 bench**：squad 无 DELETE 端点；member 用 bench 兜底（无 fire）；leader bench 返 403。

### 1.2 通用约定

- host `127.0.0.1`（loopback），无 TLS；port `API_PORT`（test `3700` / dev `3710` / prod `3720`）——沿用 `04-agent-session.md §1`。
- JSON 请求/响应；错误体 `{ "error": string }`。
- ULID 业务生成（squadId/memberId/historyId）。

## 2. Session schema 增量字段（§A — v0.0.33.1）

`Session` 接口（定义见 `04-agent-session.md §2.1`）新增 3 个 optional 字段（v0.0.28 已加 type/parentSessionId/scope/subAgentTemplateType/origin；**本版 type 取值 `'member'→'mate'` 统一**）：

```typescript
interface Session {
  // ...现有字段 + [v0.0.56] role/derivation/biz 替代旧 type/scope/bizType...
  role: "rocky" | "leader" | "mate" | "squad";    // [v0.0.56] 替代旧 type 字段；mate=B 方案
  derivation: "main" | "subagent";                  // [v0.0.56] 替代旧 scope + type='subagent'
  biz: "playground" | "studio";                     // [v0.0.56] 替代旧 bizType 字段（必填）
  squadId?: string;                                 // 既有，所有 studio session 带
  memberId?: string;                                // 既有，仅 leader/mate session（双向 member.sessionId）
}
```

### 2.1 字段语义与取值（[v0.0.56] type/scope/bizType→role/derivation/biz）

| 字段 | 顶层 standalone session | squad/leader/mate session | studio 内 subagent session |
|------|------------------------|---------------------------|---------------------------|
| `role` | `"rocky"` | `"squad"/"leader"/"mate"` | parent.role（bloodline） |
| `derivation` | `"main"` | `"main"` | `"subagent"` |
| `biz` | `"playground"` | `"studio"` | `"studio"`（跟 parent） |
| `squadId` | `undefined` | 该 squad 的 id | 跟 parent（同 squad） |
| `memberId` | `undefined` | 对应 member.id（双向） | `undefined`（subagent 无 memberId） |

### 2.2 在 GET /session 与 GET /session/:id 中的暴露

- **`GET /session`**（`04-agent-session.md §2.2`）：响应 `items: Session[]` 含这 3 个新字段。**默认按 bizType=playground 过滤**（详见 §4.1），避免污染 Playground 列表。
- **`GET /session/:id`**（`04-agent-session.md §2.3`）：完整 Session，含 bizType/squadId/memberId。纯读无副作用。
- **SSE `session_meta_update`**（topic=`session_meta`，group=`_all`，`04-agent-session.md §4.2`）：`SessionMetaView` 同步含 bizType/squadId/memberId，会话列表据此更新。

> **bizType 隔离三处必须都覆盖**（详见 `session_biztype.md §1` + PRD §8）：session 字段 + GET /session 过滤 + UI 路由分离，任一漏则 Playground 列表被污染。

## 3. Squad / Member / Charter 端点契约（→ 11a-squad-endpoints.md）

三组管理端点的**完整契约**（payload / 响应 / 行为 / 错误码）在姊妹文件 **`11a-squad-endpoints.md`**，本文不重复抄。速览：

| 端点组 | 方法 + 路径 | 关键语义 |
|--------|------------|---------|
| **Squad CRUD** | POST / GET / GET/:id / PATCH / **DELETE** `/squad` | 建队事务（8 步 + 补偿回滚）；`[v0.0.111]` 加 `DELETE /squad/:id` 解散（teardown → 按 squadId 平铺删全量 session → 删 record → 删管理性子路径**保留工作产出**，`[v0.0.192.delete_cleanup]` 详 `11a §1.5`） |
| **Member 管理** | POST `/squad/:id/member`（hire fresh/derive）/ PATCH `/squad/:id/member/:mid`（edit）/ POST `.../deploy` / POST `.../bench` | hire 建 mate member + mate session + workspace；leader bench 返 403 `leader_not_benchable`；**无 DELETE**（bench 兜底） |
| **Charter**（**`[v0.0.237 removed]`**） | ~~GET / PUT / GET history `/squad/:id/charter`~~ | 原 PUT partial patch + 写一条 charter_history（append-only）；charter embedded in squad record（不关联 member）。**已退役，AT 不可 curl** |

> 详见 `11a-squad-endpoints.md` §1（Squad CRUD）/ §2（Member 管理）/ §3（Charter）。本文件下文聚焦 session 复用 + 占位 chat 403 + bizType 隔离 + SSE 策略。

## 4. Session 复用 + Studio chat + bizType 隔离（§E）

### 4.1 `GET /session?biz=playground|studio` — 列表按业务类型过滤

`GET /session`（`04-agent-session.md §2.2`）加 query 参数：

| 参数 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `biz` | `"playground" \| "studio"` | `playground`（缺省） | 按 biz 字段过滤；缺省 playground 保证 Playground 列表干净（不含任何 squad session） |

**行为**：
- 缺省（无 query）→ 仅返 biz=undefined 或 playground 的 session（现存 session lazy 默认 playground）。
- `?biz=studio` → 仅返 biz=studio 的 session（squad/leader/mate/studio 内 subagent）。
- `?biz=playground` → 同缺省。
- **向后兼容**：旧 `?bizType=` 参数仍被接受（`biz` 优先，缺 `biz` 才查 `bizType`），但 spec 推荐 `?biz=`（与 Session.biz 字段名对齐）。

> **现存 session lazy 默认 playground**：未写 biz 值的旧 session 视为 playground（不写值；GET 缺省按 playground 过滤）。

### 4.2 `GET /session/:id` — 详情含 bizType/squadId/memberId

沿用 `04-agent-session.md §2.3`，响应 Session 含 §2 新增三字段。纯读无副作用。

### 4.3 `GET /session/:id/children` — subagent 树

沿用 `10-multi-agent.md §3`（v0.0.28）。对 studio 内 subagent session 同样生效（type=subagent, bizType=studio, squadId 跟 parent）。

### 4.4 `GET /session/:id/messages` — studio transcript 可读

沿用 `04-agent-session.md §3.1`，成功响应明确为 `200 + { items: Message[], hasMore: boolean }`。`[v0.0.33.2]` studio session 拆 403 后首次产生真实 transcript；群聊页直接读取 squadChat session transcript。

群聊 a2a 消息 sender 形态：`sender.source='agent'` 且 `sender.agent.ref.type ∈ {'leader','mate'}`，UI 据 `sender.agent.ref.name` 渲染角色名前缀。user 消息仍为 `sender={source:'user'}`。

### 4.5 `POST /session/:id/messages` — studio chat 行为

| 场景 | v0.0.33.1 | `[v0.0.33.2]` |
|------|-----------|----------------|
| `type='squad'` | 403 `studio_chat_not_ready` | `202 { runId, enqueueId }`，进入 SquadChat 路由 loop |
| `type='leader'` | 403 | `202 { runId, enqueueId }`，leader 单聊 |
| `type='mate'` | 403 | `202 { runId, enqueueId }`，mate 单聊 |
| `type='subagent'` | 403 `subagent_readonly` | 仍 `403 subagent_readonly`（只读不变量） |

**请求/响应 schema** 沿用 `04-agent-session.md §3.2`：`PostMessageBody { content: string; providerId?: string; modelId?: string; activate?: boolean }`；成功 `202 + { runId: string, enqueueId: string }`。前端 Studio 通常只发 `{content}`。

**provider/model 解析（v0.0.155 session 中心化）**：`body.providerId/modelId`（如提供）→ `session.{modelId, providerId?}` → `squad.{modelDefault, modelDefaultProviderId?}` → throw。**member.model 已硬删**（A4，INV-A1/A4），不再参与回退链。**provider override 与 model override 可用于测试**；常规 Studio UI 走 session 持久化——`[v0.0.155]` studio member 单聊改 `session.{providerId, modelId}` 持久化（via `PUT /session/:id` body 复合，与 playground 同款，INV-D1）；旧 `[v0.0.63.ui_opt]` member.model PATCH 路径**已废弃**（hire/PATCH member body.model → warn+ignore 非 400）；squad 群聊作 **per-call override** 进 `POST /session/:id/messages` body 的 `providerId/modelId`，**不**改 `squad.modelDefault`/session。squad `modelDefault` 现支持复合 `modelDefaultProviderId`（optional back-compat）。详见 `[P0]model_resolve.md §3/§4`。

**代码路径**：`app/server/src/handlers/session-messages.ts.handleMessagesPost() → app/server/src/agent/agent-manager.ts.deliverTo() → app/server/src/handlers/session-config.ts.buildSessionConfigFromDeps()`。

## 5. SSE 策略

### 5.1 session 变更（复用 session_meta_update）

复用 v0.0.27 `session_meta_update`（topic=`session_meta`，group=`_all`，`04-agent-session.md §4.2`）——**所有 session 变更**（含建 squad 时建的 leader session + 群聊 session + hire member 时建的 mate session）都经此广播，会话列表据此更新 + 树形分组。

### 5.2 squad/member 变更（v0.0.33.1 用 refetch；[v0.0.305] squad 聚合状态走 squad_meta SSE）

squad/member 变更（hire / bench / deploy / edit / charter PUT）**v0.0.33.1 不走 SSE**——单用户操作场景，操作后前端 **refetch `GET /squad/:id`** 拉最新详情（够用）。

> **`[v0.0.305]` `squad_meta` SSE 已实现**（design.md §3.5 的 v4 backlog 落地）：squad 聚合状态（onlineCount/inProgressCount/lastActiveAt）变化实时推送到 `(squad_meta, _all)`——session 状态变化（statusBus 自治订阅）+ member hire/deploy/bench + squad create（handler 落盘后显式 broadcast）。契约见 `11a-squad-endpoints.md §4.5`；技术权威 `specs/tech/squad/[P1]squad_aggregate.md`。

## 6. 错误码汇总

| HTTP | 场景 | error code |
|------|------|------------|
| `400` | body 非法 / 字段缺失 / 校验失败 | （标准 400，无专属 code） |
| `403` | leader 不可 bench | `leader_not_benchable` |
| `403` | POST messages 对 subagent session | `subagent_readonly` |
| `404` | squad / member 不存在 / member 不属于该 squad | （标准 404，无专属 code） |
| `409` | hire 时 name 在 squad 内重复 | `member_name_conflict` |
| `500` | 事务失败（已补偿回滚） | （标准 500） |

> **无 `DELETE /squad` / 无 `DELETE member` / 无 `DELETE charter`**——squad/member 不可删，charter_history append-only（design.md §1.1 + §1.3 锁定）。

## 7. AT 覆盖映射（PRD 8 路径 → API）

| PRD 路径 | API 端点组合 | 验证点 |
|----------|-------------|--------|
| **路径 1（建 squad wizard 事务）** | `POST /squad` → `GET /squad/:id`（断言 memberIds=[leaderId] + leader.sessionId ↔ session.memberId 双向 + session.squadId 填 + 群聊 session.type=squad bizType=studio + 目录骨架全建） | 建队事务一致性；session 三字段填 |
| **路径 2（hire fresh + derive）** | `POST /squad/:id/member`（fresh + derive）→ `GET /squad/:id`（断言 mate member role=mate state=deployed + squad 内 name 唯一 + mate session.type=mate bizType=studio memberId 双向 + workspace 目录建 + squad.memberIds append + derive 模式复制父成员个人 AGENTS.md（非记忆；memory 已团队盘共享）） | hire 事务；derive 独立 + 个人 AGENTS.md 复制 |
| **路径 3（bench/deploy + leader 不可 bench）** | `POST .../member/:mid/bench` body `{reason}` → `GET /squad/:id`（断言 state=benched + benchReason/benchedAt 填 + 通知 user 数据层落地）→ `POST .../member/:mid/deploy`（断言 state=deployed）→ `POST .../leader的mid/bench`（断言 403 `leader_not_benchable`） | 状态机 deployed⇌benched；leader 403 |
| **路径 4（edit member）** | `PATCH /squad/:id/member/:mid`（改 name/skillConfig/intro/workStyle 等）→ `GET /squad/:id`（断言字段更新 + role/state/squadId/sessionId 不变）；**body.model 旧 client 传 → warn+ignore（v0.0.155 起非 400）**；body.tools accept-and-ignore（dead） | 可变字段生效；不可改字段不变；硬删字段（model/tools/systemPrompt）忽略不报错 |
> `[v0.0.155]` 路径 4 可变字段收敛为 `name/skillConfig/intro/workStyle`（member.model 硬删）；前向 `[v0.0.33.3]` systemPrompt 移除（详见 `11a §2.2`）；新增工作项路径见 `11b §4`（UC-1~7 board 读验证）。
| **路径 5（charter 编辑 + history）** | `PUT /squad/:id/charter` body `{patch, reason}` → `GET /squad/:id/charter`（断言字段更新）→ `GET /squad/:id/charter/history`（断言 append-only 倒序 + reason 必填 + triggeredByMessageId 空） | partial patch；history append |
| **路径 6（chat）** | `[v0.0.33.1]` POST studio 断言 403；`[v0.0.33.2]` POST squad/leader/mate 断言 202 + GET messages 含真实 transcript；subagent POST 仍 403 | studio 真聊；subagent 只读；GET `{items,hasMore}` |
| **路径 7（Playground 隔离）** | 建完 squad → `GET /session?bizType=playground`（缺省，断言不含任何 squad/leader/mate/studio-subagent session）+ `GET /session?bizType=studio`（断言含所有 studio session） | bizType 过滤生效；Playground 干净 |
| **路径 8（nav-rail 改造）** | （ET 主覆盖；AT 不直接验 nav-rail） | — |

> **关键说明**：PRD 8 路径中，路径 1-7 的核心动作**全是 HTTP**（建 squad / hire / bench / edit / charter / 占位 chat 403 / bizType 隔离）——AT 直接 curl 全验。路径 8 是纯 UI（ET 覆盖）。
>
> `[v0.0.33.2]` 真聊 AT 必须真 LLM + 真服务；14/16 pass，2 fail 归 BUG-001 多跳 a2a LLM 调度质量 known-issue。

## 8. 文件变更清单（planner/coder 依据）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/router.ts` | 修改 | 新增路由：`POST/GET/GET/:id/PATCH /squad` + `POST /squad/:id/member` + `PATCH/POST deploy/POST bench /squad/:id/member/:mid` + `GET/PUT /squad/:id/charter` + `GET /squad/:id/charter/history`；`GET /session` 加 `bizType` query 分发；`POST /session/:id/messages` 加 studio 403 分支 |
| `app/server/src/handlers/squad.ts` | 新增 | `SquadHandler`：createSquad（调 createSquadService）/ listSquads / getSquad / patchSquad |
| `app/server/src/handlers/member.ts` | 新增 | `MemberHandler`：hireMember（调 createMemberService）/ patchMember / deployMember / benchMember（leader 拒 403） |
| `app/server/src/handlers/charter.ts` | 新增 | `CharterHandler`：getCharter / putCharter（写 charter_history）/ getCharterHistory |
| `app/server/src/handlers/session.ts` | 修改 | `GET /session` 加 bizType query 过滤（缺省 playground）；`POST /messages` 加 studio session 403 `studio_chat_not_ready` 分支；Session 响应序列化加 bizType/squadId/memberId |
| `app/server/src/services/squad-service.ts` | 新增 | `createSquadService`（8 步事务 + 补偿回滚，建 squad+leader member+leader session+群聊 session+目录骨架）+ `createMemberService`（hire fresh/derive，8 步事务） |
| `app/server/src/services/charter-service.ts` | 新增 | `putCharter`（merge + 写 charter_history）+ `getCharterHistory` |
| `app/server/src/session-store.ts` | 修改 | Session schema 加 bizType/squadId/memberId 三字段（持久化，optional）；`listSessions` 加 bizType 过滤参数 |
| `app/server/src/stores/squad-store.ts` | 新增 | `SquadStore`（CrudStore FS engine，root=`data_dir/squads/`，不分片）+ `MemberStore`（按 squadId 分片）+ `CharterHistoryStore`（按 squadId 分片，append-only） |
| `app/server/src/handlers/sse.ts` | 修改 | `SessionMetaView` 序列化加 bizType/squadId/memberId，对齐 GET /session 响应 |
| `app/server/src/agent/session-meta-broadcaster.ts` | 修改 | broadcast 时组装 SessionMetaView 含新三字段（建 squad/hire 时广播 leader/mate session 的 studio meta） |

> **命名统一代码改动清单**（session.type member→mate）见 tech change_log §3，不在本 HTTP spec 文件展开。

## 9. 待定（非阻断）

- **charter PUT 乐观锁**（design.md §6.3）：本版不加 version，并发用 last-write-wins + history append-only 留痕。
- **hire derive overrides 精确字段集**（design.md §6.4）：本版允许 name/tools/skills/model 全可覆盖（`[v0.0.33.3]` systemPrompt 移除，传则 accept-and-ignore）。
- **model 字段形态**（design.md §6.2）：ModelRef(id) 还是直接 provider model id——编码阶段定。
- **GET /squad 列表分页**（design.md §6.5）：本版不分页，squad 数量预期小。
- **bench 通知 user UI 形态**（design.md §6.1）：本版先数据层落地 + 最小可见反馈，复杂形态后定。

## 10. 版本

version: 1.1 `[v0.0.155]`（session 中心化：model 回退链 `bodyOverride → session.{modelId, providerId?} → squad.{modelDefault, modelDefaultProviderId?} → throw`；**member.model 硬删**——hire/PATCH member body.model → warn+ignore 非 400；squad `modelDefaultProviderId` / `summaryModelDefaultProviderId` optional back-compat 复合字段；PUT /session/:id body `{providerId?, modelId?}` 复合）。前向 `[v0.0.33.2]`：studio chat 拆 403（squad/leader/mate POST messages 返 202，subagent 仍 403）；GET messages 明确 `{items,hasMore}`。
version: 1.0 `[v0.0.33.1]`（首版：①§2 Session schema 增量字段 bizType/squadId/memberId + type member→mate 统一 + 在 GET /session/GET /session/:id/session_meta 广播暴露；②§3 引用 `11a-squad-endpoints.md`——squad CRUD（无 DELETE，建队事务 8 步 + 补偿回滚）+ member 管理（hire fresh/derive / edit / deploy / bench，leader 403，无 DELETE）+ charter（GET/PUT/GET history，PUT partial patch + 写 charter_history append-only）；③§4 Session 复用 + 占位 chat 403 `studio_chat_not_ready` + bizType 隔离（GET /session?bizType 缺省 playground）；④§5 SSE 策略（session 变更复用 session_meta_update / squad/member 变更 v0.0.33.1 用 refetch，squad_meta SSE 留 v4）；⑤§7 PRD 8 路径 → API 覆盖映射——路径 1-7 全 HTTP，路径 8 纯 UI（ET）。端点契约主体拆至 `11a-squad-endpoints.md` 以控制单文件 ≤300 行。基于 `states/v0.0.33.1/design.md` §3 + `[P1]data_model.md` + `[P1]squad_definition.md` + `[P0]session_biztype.md`）。
