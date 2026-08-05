# v0.0.56 API Change Log — SessionKind 统一 session 类型维度（重构·行为保持）

> version: 1.0 · 2026-07-03
> PRD 权威：`specs/prd/version_logs/v0.0.56-session_type/change_log.md`
> Tech 权威：`specs/tech/agent/session/[P0]session_kind.md`

---

## 1. 修改端点

### 1.1 `GET /session` + `GET /session/:id` — Session 响应 schema 变更（`04-agent-session.md` + `10-multi-agent.md`）

**删除字段**：

| 删除字段 | 说明 |
|---|---|
| `type` | 旧 `SessionType: 'rocky'\|'leader'\|'mate'\|'squad'\|'subagent'` — 被 `role` + `derivation` 取代 |
| `scope` | 旧 `'session'\|'subagent'` — v0.0.48 后已废，工具可见性走 derivation + policy |
| `subAgentConfig.parentRole` | 派生结果持久化 — role 已带 bloodline role |

**新增字段**：

| 新增字段 | 类型 | 说明 |
|---|---|---|
| `role` | `'rocky' \| 'leader' \| 'mate' \| 'squad'` | 会话角色（subagent 存 parent.role，是 bloodline role） |
| `derivation` | `'main' \| 'subagent'` | 派生层级（main=顶层，subagent=被派生的子 agent） |
| `biz` | `'playground' \| 'studio'` | 业务分区（替代 `bizType`；值语义不变）。**注**：`bizType` 字段保留一期过渡（值从 `biz` 同步），后续版本删除。 |

**字段映射（前端迁移指引）**：

| 旧判定 | 新判定 |
|---|---|
| `session.type === 'subagent'` | `session.derivation === 'subagent'` |
| `session.type === 'leader'` / `'mate'` / `'squad'` | `session.role === 'leader'` / `'mate'` / `'squad'` |
| `session.type === 'rocky'` / `!session.type`（standalone） | `session.role === 'rocky'` |
| `session.scope === 'subagent'` | `session.derivation === 'subagent'` |
| `session.bizType === 'studio'` | `session.biz === 'studio'`（或 `bizType` 过渡字段） |
| `session.type && session.type !== 'subagent' && session.type !== 'rocky'`（studio 判定） | `session.role !== 'rocky' && session.biz === 'studio' && session.derivation === 'main'` |

**`GET /session` 过滤参数**：

- `?bizType=playground` → `?biz=playground`（过渡期兼容旧参数 `bizType`，后端同时接受两者）

### 1.2 `POST /session` — CreateSession 请求体变更

| 字段 | 操作 | 说明 |
|---|---|---|
| `type` | **删** | 改传 `role` + `derivation` |
| `scope` | **删** | derivation 表达 |
| `role` | **新增** | `'rocky'\|'leader'\|'mate'\|'squad'`；必填（顶层 standalone = `'rocky'`） |
| `derivation` | **新增** | `'main'\|'subagent'`；必填 |
| `biz` | **新增** | `'playground'\|'studio'`；必填（与 `bizType` 同语义，过渡期兼容旧参数） |

### 1.3 其他端点 — 仅响应字段变化

以下端点**行为不变**，仅响应体 Session shape 按 §1.1 变更：

- `POST /session/:id/messages`（202 → SSE 返回 session 状态字段含新字段）
- `POST /session/:id/compact`（compact 后 session 响应含新字段）
- `POST /session/:id/abort`
- `PUT /session/:id`
- `DELETE /session/:id`
- `GET /session/:id/children`
- `GET /session/:id/usage`
- `GET /session/:id/messages`
- `POST /session/:id/read`

### 1.4 SSE `session_meta` 事件 — SessionMetaView 变更

`session_meta` 广播的 `SessionMetaView` payload 同步 §1.1 字段变更（删 `type`/`scope`，加 `role`/`derivation`/`biz`）。

### 1.5 SSE `session_panel` 事件 — 关联 session 信息

`session_panel` event data 中含 session 类型信息的位置同步变更（如有）。

---

## 2. 前端消费点迁移

| 文件（web/src/） | 旧代码 | 新代码 |
|---|---|---|
| `components/chat-page/section-chat-detail.tsx` | `session.type === 'subagent'` → readOnly | `session.derivation === 'subagent'` |
| `store/chat-slice.ts` | `session.bizType === 'studio'` → 拒纳 | `session.biz === 'studio'` |
| `components/studio-page/section-member-chat.tsx` | `session.type === 'mate'`（编译期常量）| `session.role === 'mate'` |
| `components/studio-page/section-squad-chat.tsx` | `session.type === 'squad'`（编译期常量）| `session.role === 'squad'` |

---

## 3. AT 落点（配合 PRD §5 P1-P5 路径）

| 路径 | AT case | 涉及端点 | 关键断言 |
|---|---|---|---|
| P1（playground standalone） | `session_kind/P1_tc1` | POST /session → POST /session/:id/messages | 验证响应 `role='rocky', derivation='main', biz='playground'` |
| P2（playground spawn subagent） | `session_kind/P2_tc1` | spawn → GET /session/:child_id | 验证 child `derivation='subagent', role='rocky'`，无 `agent` 工具 |
| P3（studio 建队三角色） | `session_kind/P3_tc1` | 建 squad → GET /session 三次 | 验证三 session 各自 `role/biz=studio/squadId/memberId` 正确 |
| P4（studio mate spawn → capByParent） | `session_kind/P4_tc1` | mate spawn → GET /session/:child_id | 验证 child `role='mate', derivation='subagent'`，工具 = subagent.bound ∩ mate.bound |
| P5（list sessions 按 biz 分区） | `session_kind/P5_tc1` | GET /session?biz=* | 验证 biz 隔离 + subagent 不出现在顶层列表 |

---

## 4. 文件级变更清单（API 契约相关）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `specs/api/overall/04-agent-session.md` | 修改 | §2.1 CreateSessionBody 删 `type`/`scope`，加 `role: Role`/`derivation: Derivation`/`biz: BizType`；§2.2 GET /session 响应删 `type`/`scope`，加 `role`/`derivation`/`biz`；全响应 shape 示例同步 |
| `specs/api/overall/10-multi-agent.md` | 修改 | §2 Session schema 增量字段：`type`→`role`+`derivation`，`scope` 删；§2.1 字段语义表更新 |
| `specs/api/overall/11-squad.md` | 修改 | squad/leader/mate session 字段从 `type`→`role`+`derivation` |
| `specs/api/overall/15-memory-ui.md` | 修改 | 如有 session type 引用，同步更新 |
| `specs/api/overall/02-llm-chat.md` | 修改 | SSE 事件 payload 中 session type 字段同步 |
| `app/server/src/handlers/session.ts` | 修改 | CreateSession handler 请求体验证：删 `type`/`scope` 校验，加 `role`/`derivation`/`biz` 校验（4 条规则）+ 4 条校验规则 inline |
| `app/server/src/handlers/session-config.ts` | 修改 | Session 响应序列化：`type`→`role`+`derivation`，`scope` 删；GET /session?bizType → `biz` 过渡兼容 |
| `app/web/src/components/chat-page/` | 修改 | 前端所有 `session.type`→`session.role`/`session.derivation`（见 §2 表） |
| `app/web/src/store/chat-slice.ts` | 修改 | `session.bizType`→`session.biz` |

> coder 实现时，API handler 层需同时接受旧 `type`/`scope`/`bizType` 参数一期（过渡），内部转换到新字段后写入 store。响应只返新字段。

---

## 5. 版本

> 本文为 v0.0.56 架构阶段产出（API 契约设计）。实现阶段 coder 据此 + `[P0]session_kind.md` 编码。阶段 5 doc-modifier 同步 overall API 文档。
