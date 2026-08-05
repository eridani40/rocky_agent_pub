# v0.0.33.1 技术变更日志 — Squad CRUD + Studio 管理（对话全占位）

## 概述

本版本立 squad 层「数据 + 存储 + 管理」骨架：新增 3 个 entity（squad / member / charter_history）+ session 加 bizType/squadId/memberId 字段 + 命名统一（session.type member→mate）+ 建 squad/hire member 事务 service + 占位 chat 403。**agent loop 完全不接**，所有 chat 入口返 403 `studio_chat_not_ready`。

**权威概念源**（引用，不抄正文）：
- `specs/tech/squad/[P1]data_model.md` — entity SchemaDef + 双向关联 + 存储布局 + 建队事务
- `specs/tech/squad/[P1]squad_definition.md` — Squad/Member/Charter 概念 + 角色语义 + SquadChat EOS
- `specs/tech/agent/session/[P0]session_store.md` — Session interface（含增量字段）
- `specs/tech/agent/session/[P0]session_biztype.md` — bizType 二分 + 隔离规则
- `states/v0.0.33.1/design.md` — 系统设计（实体 + API + 存储 + 流程 + 命名清单 §5）

**API 契约**：`specs/api/overall/11-squad.md`（框架）+ `specs/api/overall/11a-squad-endpoints.md`（端点主体）+ `specs/api/version_logs/v0.0.33.1/change_log.md`。

**父版本**：v0.0.33（squad 启动）；**地基依赖**：v0.0.28（multi_agent session schema）+ v0.0.27（session_meta_update SSE）+ CrudStore FS engine（v0.0.18）。

---

## 1. 新增 entity（3 个，引用 data_model.md §1）

### 1.1 squad（file engine，不分片，不可删）

权威 SchemaDef 见 `[P1]data_model.md §1.1`。关键字段：id（ULID）/ name / modelDefault / leaderId + memberIds[] + squadChatSessionId（双向关联）/ charter embedded（4 定性字段）/ budget + enableHeartBeat（占位 v4，存但不生效）/ 信封。

**特性**：无 status / 无 archived / 无 DELETE 端点——建了永久存活。

### 1.2 member（file engine，按 squadId 分片）

权威 SchemaDef 见 `[P1]data_model.md §1.2`。关键字段：id / squadId + sessionId（双向）/ name（squad 内唯一）/ **role: `"leader" | "mate"`**（B 方案）/ systemPrompt + tools + skills + model / state: `"deployed" | "benched"` + benchReason + benchedAt / heartbeat（占位 v4）/ deriveFrom + inheritMemory（hire 时一次性）。

**特性**：全 agent（无 human）；leader 永远 deployed（不可 bench，API 403）；member 不可删（bench 兜底，无 fire）。

### 1.3 charter_history（file engine，按 squadId 分片，append-only）

权威 SchemaDef 见 `[P1]data_model.md §1.3`。关键字段：id / squadId / patch（partial，4 字段子集）/ reason / triggeredByMessageId（v1 UI 编辑=空；v3 对话驱动=消息 id）/ createdAt。

**特性**：append-only（每次 PUT /charter 写一条，不重写）。

---

## 2. session 改动（引用 data_model.md §1.4 + session_biztype.md）

权威 Session interface 见 `[P0]session_store.md §2`。本版增量：

| 字段 | 取值 | 语义 |
|------|------|------|
| `type` | `"squad" \| "leader" \| "mate" \| "subagent"` | **member→mate 统一**（B 方案，避免与 member entity 撞名） |
| `bizType?` | `"playground" \| "studio"` | 新增（optional，空=playground）；studio session 显式 studio；现存 lazy 默认 playground |
| `squadId?` | string | 新增；所有 studio session 带（单向 → squad） |
| `memberId?` | string | 新增；仅 leader/mate session（双向 member.sessionId） |

**bizType 传递规则**（`session_biztype.md §1`）：
- squad/leader/mate session = `studio`（建 squad/hire 时显式写）。
- subagent 跟 parent（parent=studio → subagent=studio）。
- 现存 session lazy 默认 `playground`（不写值；GET /session 缺省按 playground 过滤）。

---

## 3. 命名统一代码改动清单（design.md §5，编码阶段执行）

**session.type `'member' → 'mate'` 机械替换**（B 方案锁定）。v0.0.33.1 chat 全占位，session.type 运行时不被使用 → 改字面量零运行时风险。全量 typecheck + test 必须绿。

### 3.1 代码文件（9 个，已核实路径存在）

| 文件 | 改动点 |
|------|--------|
| `app/server/src/message/types.ts` | a2a 对端 type 字面量 `member → mate` |
| `app/server/src/agent/session-store-types.ts` | 2 处 type 字面量 |
| `app/server/src/agent/inbox-enrich.ts` | enrich 时 type 判断字面量 |
| `app/server/src/agent/session-event-types.ts` | type 字面量 |
| `app/server/src/agent/tools/types.ts` | 多处 type 字面量 |
| `app/server/src/agent/tools/runtime-context.ts` | 多处 type 字面量 |
| `app/server/src/agent/schema_defs/session.ts` | SchemaDef enumValues `member → mate` |
| `app/web/src/components/chat-page/types.ts` | 前端 type 字面量 |
| `app/web/src/components/chat-page/section-chat-detail.tsx` | 前端 type 判断字面量 |

### 3.2 spec 文件（14 个）

| 目录 | 文件数 | 改动 |
|------|--------|------|
| `specs/tech/multi_agent/` | 5（[P1]a2a_protocol / [P1]subagent_derivation / [P1]subagent_templates / design / overall） | type=member 字面量 → mate |
| `specs/tech/squad/` | 9（[P1]data_model / [P1]squad_definition / [P1]agent_leader / [P1]agent_member / [P1]agent_squad_chat / [P1]squad_autonomy / [P1]squad_tools / [P1]squad_workitems / [P1]squad_workspace） | 同步 type=member → mate + B 方案命名（已在 data_model/squad_definition 落地，其余 7 文件编码阶段核对） |

> **执行时机**：编码阶段（coder 任务内）。机械替换 + enumValues + 测试字面量同步。spec 文件由 doc-modifier 阶段 5 统一核对（data_model + squad_definition 已 0.2 版对齐 B 方案，其余按需补）。

---

## 4. 存储布局（引用 data_model.md §3）

```
data_dir/
├── sessions/...                          ← 现有（session + transcript，FS 分片）
└── squads/{squadId}/                     ← squad「办公室」（建 squad 即建）
    ├── squad.json                        ← squad record（CrudStore，含 charter embedded）
    ├── members/{memberId}.json           ← member records（file + 按 squadId 分片落此）
    ├── charter_history/{historyId}.json  ← charter 变更（file + 按 squadId 分片，append-only）
    ├── board/                            ← v3 才写（v1 建空目录占位）
    ├── outputs/                          ← v3 才写
    ├── reports/{daily,tasks,goals}/      ← v3 才写
    ├── workspaces/{memberId}/            ← 每 hire 自动建（member 专属工作目录）
    └── .rocky_squad/state/               ← v4 scheduler state
```

**CrudStore FS engine 配置**（`[P0]fs_crud_store_engine.md`）：
- squad entity：root=`data_dir/squads/`，**不分片**（每 squad一个 `{squadId}.json`）。
- member / charter_history entity：root=`data_dir/squads/`，**按 squadId 分片**落 `squads/{squadId}/members/`、`/charter_history/`。

**无 `_archived/` 目录**——squad 不可删（design.md §1.1）。req.md 旧版 `DELETE /squad → _archived` 已推翻，不实现。

**放弃 spec 原 `.rocky_squad/charter.md` + `members.yaml` 可读文件名**（design.md Q3=A）——全走 store `{id}.json`；可读视图需要时由工具导出。

---

## 5. 建 squad / hire member 事务 service（引用 data_model.md §4/§5）

### 5.1 createSquadService（data_model.md §4）

8 步事务 + 补偿回滚（best-effort，反向顺序）：
1. 生成 squadId + 建 squad record（charter embedded，memberIds=[]，leaderId 暂空，enableHeartBeat=false）。
2. 建 leader member（role=leader, state=deployed, squadId）。
3. 建 leader session（type=leader, bizType=studio, squadId, memberId, parentSessionId=null）。
4. 回填 member.sessionId + squad.leaderId。
5. 建 squadChat session（type=squad, bizType=studio, squadId, parentSessionId=null）。
6. 回填 squad.squadChatSessionId + append squad.memberIds=[leaderId]。
7. 建目录骨架（squads/{squadId}/{members,charter_history,board,outputs,reports/{daily,tasks,goals},workspaces/{leaderMemberId},.rocky_squad/state}）。
8. 任一步失败 → 补偿删除已建 record + 目录（反向顺序）。

**一致性保证**：建完 member.sessionId + session.memberId 双向；squad.leaderId + member.squadId 双向；session.squadId 单向；squad.memberIds 含 leaderId。

### 5.2 createMemberService（data_model.md §5）

hire fresh / derive 两模式，8 步事务 + 补偿回滚：
1. resolve effective 配置（fresh 直用 / derive 从父 member 复制 + overrides 覆盖）。
2. 校验 name 在 squad 内唯一（a2a 寻址要求）。
3. 建 member record（role=mate, state=deployed, squadId, deriveFrom/inheritMemory 一次性记）。
4. 建 member session（type=mate, bizType=studio, squadId, memberId, parentSessionId=null）；inheritMemory=true 时复制父 member session 长期记忆（transcript + summary）。
5. 回填 member.sessionId。
6. append squad.memberIds。
7. 建 workspace 目录（squads/{squadId}/workspaces/{memberId}/）。
8. 任一步失败 → 补偿回滚（反向顺序）。

**derive 后两 member 完全独立**——无后续联动（仅 hire 时一次性复制配置 + 可选记忆）。mate 不可改 role 为 leader。

---

## 6. 双向关联（3 组，应用层 service 单点维护，引用 data_model.md §2）

一致性由 createSquadService / createMemberService 等 service 层单点保证，**无 DB 外键、无 trigger**。

| 关联 | 双向字段 |
|------|---------|
| squad ⇄ member | `squad.leaderId + squad.memberIds[]` ↔ `member.squadId` |
| member ⇄ session | `member.sessionId` ↔ `session.memberId`（仅 leader/mate） |
| session ⇄ squad | `session.squadId`（单向，所有 studio session 带） |

---

## 7. 占位 chat 实现策略（POST messages 403，不接 LLM）

**v0.0.33.1 agent loop 完全不接**——POST /session/:id/messages 对 studio session（bizType=studio）直接返 `403 studio_chat_not_ready`，**不进 AgentManager.activate、不调 LLM、不写 transcript**。

**实现位置**：`app/server/src/handlers/session.ts` 的 POST /messages handler，在 session 解析后加分支：
```
if (session.bizType === 'studio') {
  return 403 { error: 'studio_chat_not_ready' };
}
// 现有 playground 路径不变
```

**GET /messages 仍可读**——占位 chat 不阻塞用户查看历史 transcript（如有）。

**v0.0.33.2 接通后**：移除此 403 分支，studio session 接入 agent loop（type=squad/leader/mate 各自的 agent loop 路径，详见后续版本 spec）。

---

## 8. 文件变更清单（引用 11-squad.md §8 + 本文件 §3）

### 8.1 新增文件

| 文件 | 内容 |
|------|------|
| `app/server/src/handlers/squad.ts` | SquadHandler：createSquad / listSquads / getSquad / patchSquad |
| `app/server/src/handlers/member.ts` | MemberHandler：hireMember / patchMember / deployMember / benchMember（leader 403） |
| `app/server/src/handlers/charter.ts` | CharterHandler：getCharter / putCharter（写 history）/ getCharterHistory |
| `app/server/src/services/squad-service.ts` | createSquadService（8 步事务）+ createMemberService（hire fresh/derive） |
| `app/server/src/services/charter-service.ts` | putCharter（merge + 写 charter_history）+ getCharterHistory |
| `app/server/src/stores/squad-store.ts` | SquadStore（不分片）+ MemberStore（按 squadId 分片）+ CharterHistoryStore（按 squadId 分片，append-only） |

### 8.2 修改文件

| 文件 | 改动 |
|------|------|
| `app/server/src/router.ts` | 新增 squad/member/charter 路由 + GET /session 加 bizType query + POST /messages 加 studio 403 分支 |
| `app/server/src/handlers/session.ts` | GET /session 加 bizType 过滤（缺省 playground）；POST /messages 加 studio 403；Session 响应序列化加 bizType/squadId/memberId |
| `app/server/src/session-store.ts` | Session schema 加 bizType/squadId/memberId（持久化，optional）；listSessions 加 bizType 过滤参数 |
| `app/server/src/handlers/sse.ts` | SessionMetaView 序列化加 bizType/squadId/memberId |
| `app/server/src/agent/session-meta-broadcaster.ts` | broadcast 时组装 SessionMetaView 含新三字段 |

### 8.3 命名统一（§3.1 的 9 个代码文件）

见本文件 §3.1（编码阶段机械替换 session.type `member → mate`）。

---

## 9. 风险点 / 设计注意（引用 PRD §8）

- **数据字段一次到位**：v2/v3/v4 字段（charter / heartbeat / budget / enableHeartBeat）v1 必须有占位，否则后续 schema migration 成本高。
- **目录骨架一次建对**：board/outputs/reports 子目录建队即建（空），v3 才真写，避免 v3 补建逻辑。
- **bizType 三处必须都覆盖**：session 字段 + GET /session 过滤 + UI 路由分离，任一漏则 Playground 列表被污染。
- **leader 不可 bench 双层拒**：API 返 403 + UI 隐藏按钮。
- **charter_history append-only 并发**：写并发用追加而非整体重写。
- **占位 chat 不报错**：POST messages 返 403（非 500），前端 banner 兜底，不让用户以为坏了。
- **命名统一零运行时风险**：v0.0.33.1 chat 全占位，session.type 运行时不被使用 → 改字面量安全；全量 typecheck + test 必须绿。

---

## 10. 待定（非阻断，编码阶段细化）

- **model 字段形态**（design.md §6.2）：ModelRef(id) 还是直接 provider model id。
- **charter PUT 乐观锁**（design.md §6.3）：本版不加 version，并发 last-write-wins + history append-only 留痕。
- **hire derive overrides 精确字段集**（design.md §6.4）：本版允许 name/systemPrompt/tools/skills/model 全可覆盖。
- **bench 通知 user UI 形态**（design.md §6.1）：本版先数据层落地 + 最小可见反馈，复杂形态后定。

---

## 12. 命名统一 spec 落地（doc-modifier 阶段 5 核实）

`session.type 'member' → 'mate'` B 方案在 spec 层落地完整核实（design.md §5 清单 + 派生 spread）：

| 目录 | 文件 | 改动 |
|------|------|------|
| `specs/tech/squad/` | `[P1]agent_member.md` | `session.type = "member"` → `"mate"`（+B 方案注） |
| `specs/tech/squad/` | `design.md` | RoleSpec `type:"leader"\|"member"` → `role:"leader"\|"mate"`；2 处 session.type 复用表 member→mate |
| `specs/tech/squad/` | `overall.md` | §4 session.type `member`→`mate` + 新增 §5 v0.0.33.1 落地状态段 |
| `specs/tech/multi_agent/` | `[P1]a2a_protocol.md` | §6 注释 + 现状对齐段 + version 注 3 处 `squad/leader/member` → `squad/leader/mate` |
| `specs/tech/multi_agent/` | `[P1]subagent_derivation.md` | §3.1 全局主 session 表 member→mate |
| `specs/tech/multi_agent/` | `[P1]subagent_templates.md` | §1 type enum 注 member→mate |
| `specs/tech/multi_agent/` | `design.md` | 早期草稿注 + 废弃 SessionType 注 2 处 member→mate（决策日志正文 O4 保留作 v0.0.28 历史决策记录） |
| `specs/tech/agent/message/` | `[P0]agent_message_interface.md` | AgentRef type enum member→mate |
| `specs/tech/agent/agent_interface_and_loop/` | `[P0]agent_inbox_enqueue.md` | §2.5 注释 member→mate |
| `specs/api/overall/` | `10-multi-agent.md` | §2 type enum + §2.1 取值表 member→mate（v0.0.28 spec 增量同步 B 方案） |

> **决策日志保留原则**：`specs/tech/multi_agent/design.md §9 O4` 记录 v0.0.28「已定 type=squad\|leader\|member\|subagent」是历史决策点，保留原文不改写历史；当前权威 enum 在 `[P1]subagent_derivation.md §2` + `[P0]session_store.md §2`（已 `mate`）。

> **代码层 9 文件机械替换**（design.md §5）由 coder 编码阶段完成（已落 code review report：清查通过，唯一残留是 `schema_defs/squad/member.ts` 文档注释「mate 原 type=member」无活跃字符串比较）。

---

## 13. 文档同步落地（doc-modifier 阶段 5）

- **API spec 笔误修正**（`specs/api/overall/11a-squad-endpoints.md`）：§2.1 name 冲突 `400`→`409 member_name_conflict`；§2.2 PATCH 响应 `200 + Member` → `200 + { member: Member }`。详见 PRD version_log §11。
- **BUG-004 known-issue**：视觉保真偏差属 UI 层，产品决策记 PRD version_log §10；tech/api spec 无变更（视觉偏差不涉及技术契约）。
- **概念 spec 落地状态**：`specs/tech/squad/overall.md` §5 新增段标注 v0.0.33.1 落地状态（CRUD/Studio 管理 UI 实跑 / agent loop / 心跳 / 工作项留后续版本）。

---

## 11. 版本

version: 1.0 `[v0.0.33.1]`（首版技术变更日志：①§1 新增 3 entity（squad 不分片不可删 / member 按 squadId 分片 / charter_history append-only），SchemaDef 引用 data_model.md；②§2 session 加 bizType/squadId/memberId 三字段 + type member→mate 统一；③§3 命名统一代码改动清单（9 代码文件 + 14 spec 文件，编码阶段执行，零运行时风险）；④§4 存储布局（data_dir/squads/{squadId}/ 目录树 + CrudStore FS engine 配置 + 无 _archived）；⑤§5 建 squad/hire member 事务 service（8 步 + 补偿回滚，引用 data_model.md §4/§5）；⑥§6 双向关联 3 组（应用层 service 单点维护，无 DB 外键）；⑦§7 占位 chat 实现策略（POST messages 对 studio session 返 403 studio_chat_not_ready，不接 LLM，handler 加分支）；⑧§8 文件变更清单（6 新增 + 5 修改 + 9 命名统一）；⑨§9 风险点。权威概念源：[P1]data_model.md + [P1]squad_definition.md + [P0]session_store.md + [P0]session_biztype.md + states/v0.0.33.1/design.md）。
