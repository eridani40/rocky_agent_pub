---
type: interface
title: memory_manage 工具
priority: P0
status: active
updated: 2026-08-02
since: v0.0.21
---

# memory_manage 工具

> 主文档：`index.md`（① 是什么）。memory 定义见 `[P0]memory_definition.md`。注入见 `[P0]memory_injection.md`。一级整理触发见 `[P0]consolidation_tier1.md`。

> **实现落点**：`app/server/src/tools/memory-manage.ts`（工具 dispatch + evolvable gate 入参）+ `memory-manage-scope.ts`（scope 解析/group ws 寻址助手）+ `app/server/src/memory/memory-dir-store.ts`（三介质读侧 + parse/serialize + 共享类型）+ `memory-dir-write.ts`（write/create/archive + per-entry 文件锁 + atomicWrite）+ `app/server/src/memory/policy.ts`（`INTRO_CHAR_LIMIT`/`BODY_CHAR_LIMIT` 字符硬限 + `MemoryCharLimitError` + evolvable gate 错误/opts）+ `app/server/src/memory/query.ts`（read 共享单源）。

## 1. 概述

`memory_manage` 是 agent 管理 memory 的**写侧** tool（write / archive / list / read）。agent 通过它写入/更新/归档 memory entry，支撑 self evolution。

**纯读/管理分离**：对话中按需**读正文**改走独立 `memory` 纯读工具（read/search，见 `[P0]memory_tool.md`，对称 `skill`/`skill_manage`）。`memory_manage` 保留写侧（write/archive/list）+ read（其读取实现与 `memory` 工具**共享** `query.readMemoryEntry`，不新造）。

**核心原则**：**write 新建不审批**——memory 新建由 agent 自主完成，无人工 gate。**进化性写受 evolvable gate**（更新既有 `evolvable=false` 条目 / archive → 拒绝，见 §5.1）；正文受 **字符硬限**（intro ≤50 / body ≤500，§5）。安全靠 evolvable 治理 + 归档不删 + 可回滚 + 整理（二级，P1）。

## 2. 接口定义（scope 全链统一 3 值 global/group/session）

**scope 全链统一命名**：工具 input `scope` 取值 `global` | `group` | `session`（对齐 skill）；底层存储/query/mapper 同值直通，**无 internal/external 映射层**。

| scope（tool input/output） | 存储介质 |
|---|---|
| `global` | `<dataDir>/memory/<name>.md`（dir store；全局一份） |
| `group` | `<groupWs>/.rocky/memory/<name>.md`（groupWs 经 `resolveGroupWsDir` 解析：squad=`<dataDir>/squads/<sid>/`） |
| `session` | `<session.workspaceDir>/.rocky/memory/<name>.md`（ws 取自 `ctx.config.workdir`） |

**[v0.0.238] scope 必填（去默认 global）+ 按 biz 校验可用 scope**：write/archive 不传 scope → `[invalid_input]` + `scopeRequiredErrorText(biz)`（列本 biz 可用层 + 语义 + 示例）；传了当前 biz 不可用 scope（如 studio 传 session / playground 传 group）→ `[invalid_input]` + `scopeUnavailableErrorText(biz, scope)`。可用表来自单源 `biz-scope-rules.ts AVAILABLE_SCOPES_BY_BIZ`（playground=session/global、studio=group/global、academy=session/group/global）。biz 由 `resolveBizScopeKind(ctx.config)` duck-type 读 `ctx.config.kind.biz`，缺省 `'playground'`。read 保留缺省 `'global'`（读侧宽容），list 已必填（含 `'all'`）。

```typescript
interface MemoryManageTool {
  /** 写入/更新一条 entry（upsert：同 name 则更新）。scope 默认 "global"。 */
  write(input: {
    scope?: "global" | "group" | "session";
    // session scope 的 ws（ctx.config.workdir）、group scope 的 groupWs（resolveGroupWsDir）均由工具从 ctx.config 自动取，不接受调用方传。
    entry: {
      name: string;
      intro: string;                    // 一句话摘要（原 description 改名消歧 JSON-schema 关键字）；读侧兼容旧 description（intro ?? description）
      type: MemoryType;
      body: string;                       // intro ≤50 / body ≤500 字符硬限（§5，超限拒绝）
      why?: string;
      howToApply?: string;
      // payload **不含** evolvable（agent 不碰治理元字段；新建自动 true，见 §5.1）
    };
  }): void;

  /** 归档 entry（不删除，移 archive，可恢复）。evolvable=false 拒绝（§5.1）。 */
  archive(input: { scope?: "global" | "group" | "session"; name: string }): void;

  /** 列出 entry（metadata 级，不含全文）。meta 含 evolvable。 */
  list(input: { scope: "global" | "group" | "session" | "all" }): MemoryEntryMeta[];

  /** 读单条 entry 全文（共享 memory 工具 query.readMemoryEntry；非注入路径） */
  read(input: { scope?: "global" | "group" | "session"; name: string }): MemoryEntry;
}

type MemoryType = "user" | "feedback" | "project" | "reference";
// MemoryEntryMeta 含 evolvable: boolean；MemoryEntry 亦含 evolvable。
```

> **写/读源按 scope 分流（统一 dir store）**：三介质同构，路径解析不同：
> - `global` → dir store 读写 `<dataDir>/memory/`（`globalMemoryDir(dataDir)`）
> - `group` → dir store 读写 `<groupWs>/.rocky/memory/`（`wsMemoryDir(resolveSelfGroupWsDir(ctx))`；groupWs 由 `ctx.config.squadId` / `ctx.config.sessionContext?.classroomId` 经 `resolveGroupWsDir` 解析，squadId 优先）
> - `session` → dir store 读写 `<workdir>/.rocky/memory/`（`wsMemoryDir(ctx.config.workdir)`；workdir 缺失 → RUNTIME_ERROR）
> - `all`（list only）→ 合并 global + group（软取，无 group 静默跳过该段）+ session

> **group ws 寻址自动完成（对齐 session 寻址先例）**：group scope 的 ws 由工具从 `ctx.config.squadId`（studio session）经 `resolveGroupWsDir` 自动取，**input schema 不暴露 squad_id**。**无 group 会话**（squadId 缺）显式写 scope='group'（write/archive/read/显式 list 'group'）→ **`[invalid_input] not_in_group`**（不静默降级 global、不写 orphan）。list 'all' 是软取（缺 group 静默跳过 group 段合并，仅返 global + session）。跨 scope 读/搜（scope 未指定）**严格不含 group 兜底**——跨组读会污染其他团队数据，group 必须显式指定。

## 3. action 语义

| action | 用途 | 备注 |
|--------|------|------|
| `write` | 写入或更新（upsert，同 name 更新） | intro >50 / body >500 字符 **hard error**（§5）；更新既有 `evolvable=false` 条目 → 拒绝（§5.1）；新建自动 `evolvable=true`；**origin 盖 source='agent'**（agent 路径写入即 agent 资产，见 §6.1） |
| `archive` | 归档（不删，可恢复） | 过时/矛盾时用；`evolvable=false` 条目 → 拒绝（§5.1）；archive 保留既有 source/updatedAt（非 write 路径不刷戳） |
| `list` | 列 metadata（name/intro/type/**evolvable** + source/updatedAt） | 不返回全文，控 token |
| `read` | 读单条全文 | 共享 `memory` 工具 `query.readMemoryEntry`；agent 显式查阅用（注入是 native 自动，不经此） |

## 4. 触发时机（与 skill_manage 工具共享）

- **时机 A · session 内实时**：agent 判断有值得记的（纠正/决策/偏好），随时调 `memory_manage.write` / `skill_manage.create` / `skill_manage.patch`。
- **时机 B · compact 时机**：整理 fork（见 `consolidation_tier1.md` §时机 B）从完整对话提炼，**直接调** `memory_manage` / `skill_manage` 工具落盘（不审批）。

## 5. 正文长度硬限（v0.0.238 起字符口径取代 300 词）

**[v0.0.238] 长度口径统一为字符数**：

- `intro`：trim 后 ≤ **50 字符**（PRD §14.2.4）；超限 → hard error。
- `body`：trim 后 ≤ **500 字符**（取代旧 300 词）；超限 → hard error。

`write` 时单点 `app/server/src/memory/policy.ts` 计数（`INTRO_CHAR_LIMIT` / `BODY_CHAR_LIMIT` 常量，trim 后 `str.length`，中英文统一按字符计）；超限 → `MemoryCharLimitError { field: 'intro'|'body'; current; limit }`，message `memory <field> exceeds <limit> chars (current: <n>)`，**条目不落盘**。dir store 写侧 `writeLocked` 内执行，覆盖 agent 工具 + UI HTTP 两条写路径（单点强制）。`memory-manage.ts` 与 `handlers/memory.ts` catch `MemoryCharLimitError` → `[invalid_input]` / HTTP 400（携 field/current/limit）。

- **存量豁免**：只卡本次写入的新 body/intro，不追溯既有条目；由 T1（§consolidation_tier1）按新标准逐步收敛。
- **旧 300 词口径退役**：`WORD_LIMIT` / `countWords` / `MemoryWordLimitError` 删除（不留死代码）；`memory_definition §5` 与 `15-memory-ui §4.2` 同步订正为字符口径。
- **UI 同款**（PRD「应加，对人对 agent 一致」）：服务层 `writeLocked` 单点 → UI POST/PATCH 写 memory 同样硬限。

### 5.1 evolvable 强制规则（agent 工具路径）

```
write(name) 命中已存在 entry → if entry.evolvable === false → REJECT   // 更新既有（进化性写）
write(name) name 不存在        → 允许（新建），自动 evolvable=true       // 等价 skill create
archive(name)                  → if entry.evolvable === false → REJECT
```

- **进化性写** = 更新既有条目（write upsert 命中已存在）+ archive。命中 `evolvable=false` → `[invalid_input] memory "<name>" is non-evolvable`（对齐 skill `skill_manage_tool §4`）。
- **新建不 gate**：write 新建（name 不存在）总允许，自动设 `evolvable=true`（agent 资产）。
- **agent 不碰 evolvable 元字段**：write payload **不含** `evolvable`；既有条目更新时保留原 `evolvable`（gate 已确保为 true）。
- **gate 在 store 写侧原子执行**（read → 校验 evolvable → write，全程持 per-entry 文件锁，防 TOCTOU）：`memory-dir-write.ts writeEntry/archiveEntry` 加 `enforceEvolvable` 入参（agent 传 true；UI 传 false/省略）。
- **UI 路径不受 gate**：`/memory/*` HTTP 全字段可编辑（含 `evolvable` true↔false），见 `15-memory-ui.md` + §9。存量默认见 `memory_definition.md §5.1`。
- **[BUG-001] `write` 更新既有条目时 `type` 可省（继承既有）**：`§2` write 入参虽标 `type: MemoryType`，但**更新既有条目**（name 命中已存在）时可省略 `type`——工具边界（`memory-manage.ts probeExistingType`）探测既有条目的 `type` 继承之。理由：真 LLM 更新记忆常只传 `{name,intro,body}`，若在工具边界因缺 `type` 抢先拦成 `entry.type invalid`，则进化性写永远抵达不了 service 层 evolvable gate（BUG-001：non-evolvable 条目被误报为 type 错误而非 `non-evolvable`）。**创建**（无既有条目）仍要求显式 `type`（无可继承来源）。gate 判定（evolvable）**先于**载荷 type 校验，确保 gate 生效。

## 5.2 路由提示词（v0.0.238 scope 必填 + 按 biz 可用表）

`memory_manage` tool description 内嵌**两步决策**路由规则（single source `app/server/src/prompts/routing-decision.ts ROUTING_DECISION_PROMPT`，与 `skill_manage` description + consolidation fork prompt + consolidation-tier2 prompt **4 处同源**）：

- **第一步（skill vs memory）**：一套要照着执行的步骤/方法（how-to）→ **skill**；会改变后续判断的事实/偏好/约束/教训（what & why）→ **memory**；项目代码/架构事实 → 都不写（归 specs/代码）；进展快照/里程碑/当前状态/一次性成就/情绪波动/短期上下文 → **都不写**（Do NOT write 反例清单）。
- **第二步（[v0.0.238] scope 必填无默认 + 按 biz 可用表）**：scope 语义（session=仅本会话 / group=本团队共享 / global=跨项目全局）；写入**必须显式指定 scope**（无默认）；当前 biz 可用表（playground→session/global；studio→group/global；academy→三层）；传错或不传会被工具拒并按 biz 引导。

见 `consolidation_tier1.md §6`（fork prompt 落点）+ `../skills/[P0]skill_manage_tool.md §11` + `biz-scope-rules.ts`（可用表数据源 + 错误文案函数）。

## 6. 设计决策

- **不审批**：self evolution 哲学，agent 自主写 memory。
- **upsert 语义**：同 name 更新而非重复创建，天然去重。
- **archive 不 delete**：永不自动删，矛盾/过时靠归档 + 整理。
- **list 只回 metadata**：控 token，全文走 read 或 native 注入。
- **write 是唯一持久化入口**：强制走工具 = 强制结构化 + 容量检查（对应 memory_definition §4 封装）。
- **session/group 寻址自动完成**：scope=session 的 ws 由工具从 `ctx.config.workdir`（调用方 session 自己的工作目录）自动取；scope=group 的 ws 经 `resolveGroupWsDir`（`ctx.config.squadId` / `ctx.config.sessionContext?.classroomId`）自动取。**input schema 不暴露 sessionId/workspaceDir/squadId/classroomId**。session/group memory 本质 = 调用方自己的记忆——系统通过 ctx 权威知道调用方上下文，不交给 LLM 传长 ULID（易混淆 memberId/sessionId，曾致数据 orphan、UI 读不到）。global scope 无寻址（全局一份 `<dataDir>/memory/`）。UI 端点（`/memory/session?sessionId=`，见 `15-memory-ui.md`）是另一条路径，仍显式带 sessionId——UI 是用户行为，需用户/前端指定查哪个 session；本条只约束 agent 工具路径。
- **origin 盖 source='agent' + updatedAt=now（写侧盖戳）**：`memory_manage.write` 在 dir store 写侧（`memory-dir-write.ts writeEntry/createEntry`）调起时传 `source:'agent'`（agent 路径写入即 agent 资产）；create 盖 source + 刷新 `updatedAt=now`；update（命中既有条目）保留既有 source（**origin 不可变**）+ 刷新 `updatedAt=now`。archive 非 write 路径不刷戳（保留既有 source/updatedAt）。理由：source 是 originator 标签用于注入配额分组（`memory_injection.md §2.2`），不可在 update 时被改换；updatedAt 是组内排序依据，每次写必须刷新。UI 路径对偶（`POST/PATCH /memory/*`）origin=user，见 `15-memory-ui.md §4/§5`。

### 6.1 source/updatedAt 落盘契约

| 字段 | create | update（命中既有） | archive |
|------|--------|-------------------|---------|
| `source` | 盖为入参 `opts.source ?? 'agent'`（agent 路径 = 'agent'） | **保留既有 source**（origin 不可变） | 保留既有 source |
| `updatedAt` | 刷新为 `new Date().toISOString()` | 刷新为 `new Date().toISOString()` | 保留既有 updatedAt（archive 非 write 路径） |

落点：`MemoryWriteOpts` 加可选 `source?: 'user'|'agent'`（`app/server/src/memory/policy.ts`，与 evolvable 同 opts 载体，**MUST NOT 删既有 evolvable 字段**）。三介质统一 dir store 写侧（`memory-dir-write.ts`）共用此 opts。

## 7. 注册范围 + 并发写：原子串行化（v0.0.51 v2 新增）

### 7.1 注册范围（已实现，`TOOL_POLICY`）

`memory_manage` + `skill_manage`（写侧）注册给 3 角色（user_memory 跨 session / 跨 agent 全局共享，这些 agent 都可写）：`playground-rocky` / `studio-leader` / `studio-mate`。`subagent` / `studio-squad` 不绑（subagent 不应主动整理 memory/skill，避免派生递归）。

**纯读 `memory` 工具（`memory_tool.md §7`）注册给 4 角色——上述 3 + `subagent`（注入翻转后 L0 只带 name+intro，任何被注入 memory L0 的角色都需 `memory` 工具读正文 L1）。

落点 `app/server/src/agent/tool-policy.ts TOOL_POLICY`（源码单源，改 bound = 改源码经版本评审）。见 `../tools/[P0]tool_policy.md` + `specs/api/overall/14-self-evolution-tool-ref.md §5`。

### 7.2 并发写：原子串行化（per-entry 文件锁，三介质统一）

`memory_manage` 的写操作（write / archive）必须**原子串行化**——三介质统一 **per-entry 文件锁**（`withFileLock` 锁 `<dir>/<name>.md`，`memory-dir-write.ts` 内部）：

| scope | 介质 | 锁策略 |
|-------|------|--------|
| `global` | `<dataDir>/memory/<name>.md` | per-entry 文件锁（不同 entry 互不阻塞；同 entry 串行） |
| `group` | `<groupWs>/.rocky/memory/<name>.md` | 同上 |
| `session` | `<session.workspaceDir>/.rocky/memory/<name>.md` | 同上 |

- **锁粒度 = 单 entry 文件**：per-entry md 模型下天然无需整库 mutex——并发写**不同 entry**（即使同 scope 同 dir）互不阻塞；同一 entry 的 read-modify-write 由 per-file 锁串行防 TOCTOU。`createEntry` 的 exists 判定 + 写在同一锁内完成（防 TOCTOU 竞建）。
- 锁范围：写操作全期持锁（read → modify → write），读 (list/read) + native 注入不持锁。
- 锁实现：复用项目已有 `withFileLock`。

**理由**：旧模型单文件多 entry 需要整文件锁（session/squad）或 in-process mutex（app_config record）；per-entry 后锁粒度随介质自然细化，三介质一套机制。

## 8. 待定（P1）

- 矛盾检测（新 entry 与旧矛盾时自动降权/归档旧条目）
- content_type 半衰式衰减
- 批量整理接口（供二级整理 fork 用）

## 9. 与 UI 端点的边界（正交分离）

**结论**：agent 改 memory（本文 `memory_manage` 工具）与 UI 改 memory（HTTP `/memory/*` 端点）是**两条独立路径**，API 入口、调用语义、契约范围完全分离，**仅共享底层 dir store + per-entry 文件锁**。

| 路径 | 主体 | 入口 | 共享底层 |
|---|---|---|---|
| `memory_manage` 工具（本文） | agent（LLM tool_use） | tool_use 调用，ctx.config 注入 dataDir/workdir/squadId/sessionContext | 三介质统一 `memory-dir-store.ts`/`memory-dir-write.ts`（per-entry 文件锁） |
| `POST/PATCH/DELETE /memory/*`（UI） | 用户（HTTP） | `specs/api/overall/15-memory-ui.md` | 同上（global/session 两 scope；session 经 sessionStore 解 workspaceDir） |

**正交性约束（不变量）**：
1. **API 入口独立**——UI 行为不混入 agent 工具调用语义；反之亦然。`memory_manage` 工具 input schema 不暴露 HTTP 语义（method/path）；UI 端点不暴露 tool_use 语义。
2. **共享锁串行化跨路径并发写**——agent 写 + UI 写同时到达底层 store 时，由相同 per-entry 文件锁串行化，保证不撕裂。
3. **scope 分流一致**——两条路径 scope 同值直通（无映射层）：global→`<dataDir>/memory/`；session→`<session.workspaceDir>/.rocky/memory/`。UI 边界本版只暴露 global/session 两值（group 不进 UI）；agent 工具另有 group。
4. **evolvable gate 只在 agent 路径**——`memory_manage` 对进化性写强制（§5.1）；UI `/memory/*` 不 gate，可改 `evolvable`（PATCH body 携带）。字符硬限**两路径都强制**（dir store 写侧单点，PRD 路径 E）。
5. **UI 端点契约**：见 `specs/api/overall/15-memory-ui.md`（GET/POST/PATCH/DELETE，scope global/session，独立 request/response shape，不复用 tool input/output）。

> 设计原则见 `index.md` ④ 第 7 条（UI 端点与 agent 工具正交）。
