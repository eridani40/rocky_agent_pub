---
type: concept
title: Session bizType（playground | studio 二分）
priority: P0
status: active
updated: 2026-07-03
since: v0.0.33.1
---

# Session bizType（业务类型二分：playground | studio）

> 定位：定义 session 的**业务类型二分**——`playground`（现有个人对话）vs `studio`（squad 团队管理场景的 session），以及两者**列表隔离 / 传递 / 缺省默认**规则。Session interface 字段定义在 `[P0]session_store.md §2`，本文展开概念。
> 参考：`states/v0.0.33.1/design.md` §1.3 / §3.4（bizType 字段 + GET /session 过滤）；`[P0]session_store.md §2`（Session interface）；`specs/tech/squad/[P1]data_model.md`（squad/leader/mate session）。

---

## 1. 为什么需要 bizType

v0.0.33.1 引入 squad 团队管理后，session 列表会混入三类新 session：

- `squad`（SquadChat 群聊 session）
- `leader`（leader member 的 session）
- `mate`（mate member 的 session）
- studio 内派生的 `subagent` session

这些 session 与用户**个人对话**（Playground，原"会话"）是**两种业务场景**：

| | **playground**（个人对话） | **studio**（团队管理） |
|---|---|---|
| 用户视角 | Playground tab，跟 agent 1:1 聊 | Studio tab，管理 squad / member / charter |
| session 来源 | 用户手动建 / SDK 建 | 建 squad / hire member 时系统自动建 |
| 包含 type | 顶层 standalone（type 不填）+ playground 内 subagent | squad / leader / mate + studio 内 subagent |
| chat 行为 | 正常 agent loop（v0.0.x 既有） | v0.0.33.1 **全占位**（POST messages 返 403，v0.0.33.2 上线） |

**问题**：如果不区分，squad 一旦建立，Playground 的会话列表会瞬间多出 N+2 个 session（squadChat + leader + N mate），污染用户个人对话视图。

**解决**：session 加 `bizType` 字段，GET /session 缺省按 bizType 过滤，Playground 列表只看 playground session。

---

## 2. biz 字段定义（[v0.0.56] bizType→biz，必填；详见 `[P0]session_store.md §2`）

```typescript
interface Session {
  // ...现有字段...
  biz: 'playground' | 'studio';   // [v0.0.56] 必填（旧 bizType?: optional 空=playground 已删除）
}
```

- **[v0.0.56] 必填字段，无 lazy 默认**：数据迁移一次性消除旧 optional 行为，所有 session 显式写 `biz`。
- 取值：
  - `'playground'`：个人对话 session（顶层 standalone + playground 内 subagent）。
  - `'studio'`：squad 团队管理场景 session（squad / leader / mate + studio 内 subagent）。

> 概念类型名 `BizType` 不变（`app/shared/src/types/session-kind.ts`），仅 Session interface 字段名 `bizType`→`biz`。

---

## 3. 隔离规则

### 3.1 GET /session 缺省过滤

```
GET /session                    → 缺省 bizType=playground（Playground 列表干净）
GET /session?bizType=studio     → 仅 studio session
GET /session?bizType=playground → 显式 playground（同缺省）
GET /session?bizType=all        → 全部（管理/调试用，可选）
```

- **缺省 = playground**：用户切到 Playground tab 看不到任何 squad 相关 session。
- Studio tab 内的 session 列表走 `bizType=studio`（由 Studio UI 显式带）。

### 3.2 bizType 传递规则

| 场景 | 子 session bizType |
|---|---|
| playground session 派生 subagent | **跟 parent = playground** |
| studio session（squad/leader/mate）派生 subagent | **跟 parent = studio** |
| 建 squad（createSquadService） | squad / leader session 显式 `bizType=studio` |
| hire mate（createMemberService） | mate session 显式 `bizType=studio` |

- **传递规则 = 跟 parent**：subagent 永远跟 parent 的 bizType，不独立选择。
- **squad/leader/mate session 显式建**：service 层（createSquadService / createMemberService）建 session 时显式写 `bizType=studio`。

### 3.3 现存 session lazy 默认

- **不跑 migration**——现存 session（v0.0.33.1 之前的）**不写 bizType 值**。
- **读取时 lazy 默认**：`session.bizType ?? 'playground'`（空值视为 playground）。
- 这样现存 session 自动归 playground，Playground 列表行为不变；新 studio session 显式写 studio。

---

## 4. [v0.0.56] biz 与 role 的校验规则（替代旧 bizType↔type 表）

> **[v0.0.56]** 旧 `bizType/type` 字段已删除（被 `biz/role/derivation` 取代）。旧关系表降级为**写入时校验规则**（字段仍独立存储，不互相派生）。

| 校验规则 | 触发条件 | 行为 |
|---|---|---|
| `role ∈ {leader, mate, squad}` ⇒ `biz='studio'` | createSession / spawn | throw `ValidationError` |
| `derivation='subagent'` ⇒ `parentSessionId` 必填 | spawn | throw `ValidationError` |
| `biz='studio'` ⇒ `squadId` 必填 | createSession（仅主 session；subagent 不强制） | throw `ValidationError` |
| `role ∈ {leader, mate}` ⇒ `memberId` 必填 | createSession（仅主 session；subagent bloodline 不强制） | throw `ValidationError` |

- **校验不涉及字段派生**：biz / role / derivation 三个维度各自独立写入，校验只检查一致性约束。
- **subagent 的 biz 跟 parent.biz**（传递规则不变 —— 见 §3.2）。
- **顶层 playground（role='rocky', biz='playground', derivation='main'）** 不触发任何规则。

---

## 5. 与其他字段的关系

| 字段 | 与 bizType 关系 |
|---|---|
| `type` | 角色维度；type∈{squad,leader,mate}⇒bizType=studio（见 §4） |
| `squadId` | studio session 必带（关联 squad）；playground session 无 |
| `memberId` | 仅 leader/mate session 带（bizType=studio 子集）；squad/subagent/standalone 无 |
| `parentSessionId` | 仅 subagent 有；bizType 跟 parent（§3.2） |
| `status` (active/archived) | 与 bizType 正交，两套列表都按 status 过滤 |

---

## 6. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| bizType 字段定义 + 隔离规则 + 缺省策略 + 传递规则 | 本文 ✅ |
| Session interface（bizType/squadId/memberId 字段位置） | `[P0]session_store.md §2` |
| squad / leader / mate session 创建（显式写 bizType=studio） | `specs/tech/squad/[P1]data_model.md §4/§5` |
| GET /session 端点（bizType 过滤参数） | 架构阶段产出 `specs/api/overall/` |
| Studio / Playground UI 列表隔离 | `specs/ui/overall/06-studio.md` + `02-llm-chat.md` |

---

## 7. 待定（架构/PRD 阶段细化，非阻塞）

- **GET /session?bizType=all** 是否暴露给前端（管理/调试用），还是仅后端调试。
- **Studio 内 subagent 列表展示**：subagent 跟 parent bizType=studio，但 Studio UI 是否需要把 subagent 也列在 squad 树下（design.md 提到 squad 树含"各自 subagents"）。

---

## 8. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
