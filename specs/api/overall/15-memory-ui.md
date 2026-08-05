# Memory UI HTTP API（v0.0.55 · v0.0.112 modified · v0.0.149 modified · v0.0.205.t2_cons modified · v0.0.238 modified — UI 专用 memory 端点）

> version: 3.3 · 引入版本 v0.0.55 · 最后更新 2026-08-02（v0.0.238：长度硬限 300 词 → intro ≤50 字符 / body ≤500 字符（`MemoryCharLimitError` → HTTP 400 `charLimitTo400`）；落 dir store `writeLocked` 服务层单点覆盖 UI + agent 两路径。v0.0.205.t2_cons：存储介质统一 per-entry md dir store；scope 全链统一 `global|group|session`；并发锁统一 per-entry 文件锁。HTTP 端点契约（请求/响应形状）零变更。v0.0.149：entry schema 加 `source`/`updatedAt`；v0.0.112：scope path 对外统一 `global`/`session` + entry schema 加 `evolvable`）
> 管什么：HTTP 端点 `/memory/*`——UI 专用 memory entry CRUD（GET 列表 / POST 新建 / PATCH 更新 / DELETE 归档），path `:scope` = `global` | `session`（UI 层保持 2 值不扩 group），handler 按 scope 路由到 per-entry md dir store：**global → `<dataDir>/memory/`** / **session → `<session.workspaceDir>/.rocky/memory/`**（sessionId 经 sessionStore 解 workspaceDir，缺省回退 `<dataDir>/workspace`）。**group 层不在本 UI API 范围**——group memory 是 agent 场景下 studio session 自动路由的记忆，UI 无直接 CRUD 入口（UI 层无 group tab 或 group-picker）。
> 不管什么：agent 通过 `memory_manage` 工具改 memory（非 HTTP，见 `14-self-evolution-tool-ref.md`）；memory 注入 system prompt（见 `specs/tech/agent/memory/[P0]memory_injection.md`）。
> **本文件是 AT（API Test）memory UI 域的唯一依据**：api-verifier 黑盒 curl，不读代码。
> 技术契约权威：`specs/tech/agent/memory/[P0]memory_definition.md` §2/§3（三介质 per-entry dir store + source/updatedAt）+ `[P0]memory_manage_tool.md` §9（UI 端点 vs agent 工具正交）。

## 1. 概述

UI 改 memory 是**用户对自己长期记忆的可见可控路径**——session 级在会话右侧「长期记忆」tab（PRD §2.1，per-session），global 级在应用设置「全局长期记忆」tab（PRD §2.2，`<dataDir>/memory/` 全局一份）。

**为什么独立端点（不复用 `memory_manage` 工具）**：

- `memory_manage` 是 agent 工具（LLM tool_use），其调用语义、上下文依赖、契约范围与 HTTP 端点完全不同。
- UI 改 memory 是**用户行为**，不是 agent 行为——逻辑上不能走 agent 工具调用语义。
- 两条路径**正交**：共享底层 dir store（`memory-dir-store.ts`/`memory-dir-write.ts`，三介质同构），但 API 入口独立。

**与 agent `memory_manage` 工具的边界**：

| 路径 | 主体 | 入口 | 共享底层 |
|------|------|------|------------------------------|
| UI 端点（本文） | 用户 | HTTP `/memory/*` | 三介质统一 dir store（global→`<dataDir>/memory/`／session→`<ws>/.rocky/memory/`） |
| Agent 工具 | LLM agent | `memory_manage` tool_use | 同上（跨路径并发写由 per-entry 文件锁串行化） |

## 2. 数据模型（entry schema）

每个 memory entry 形态（对齐 `memory_definition.md §3`）：

```typescript
interface MemoryEntry {
  name: string;              // 唯一 slug（同 scope 内）
  intro: string;             // [v0.0.114] 一句话摘要（原 description 改名消歧 JSON-schema 关键字）；读侧兼容旧 description
  type: 'user' | 'feedback' | 'project' | 'reference';
  body: string;              // 正文（intro ≤50 字符 / body ≤500 字符硬限，POST/PATCH 超限 400）
  why?: string;              // type=feedback/project 强制
  howToApply?: string;       // type=feedback/project 强制
  evolvable: boolean;        // [v0.0.112] 是否允许 agent 自动进化。UI POST 新建默认 false；
                             //   UI 可自由改（PATCH body 携带 true↔false，无 lock、不置灰）。
                             //   缺字段的存量 entry 读取时默认 true（见 memory_definition §5.1）
  source: 'user' | 'agent';  // [v0.0.149] originator：UI 写入='user' / agent 工具写入='agent'；存量=agent。
                             //   origin 不可变：PATCH 不改 source（保留既有 origin）。
                             //   注入配额分组依据（memory_injection §2.2 四类分组 scope × source）
  updatedAt: string;         // [v0.0.149] 最后修改时间 ISO 8601 string（service 落盘值，非响应层合成）。
                             //   create/update 刷新为 now；archive 保留既有 updatedAt。
                             //   存量由 migration 补 now；组内排序依据（注入配额）
  archived?: boolean;        // 是否归档（list 默认不返归档；GET ?includeArchived=true 返全）
}
```

> **[v0.0.114] 字段 `description` → `intro`**（request/response 全改）：一句话摘要字段改名消歧 JSON-schema 关键字。handler（`handlers/memory.ts` + `memory-helpers.ts coerceEntryInput/mergeEntry`）**读侧兼容旧 `description`**（`intro ?? description`），写侧只落 `intro`；frontend `memory-api.ts` 同步用 `intro`。POST/PATCH 缺 `intro`（且无旧 `description` 兜底）→ `400 entry.intro required`。
>
> **[v0.0.112] scope 对外统一命名**：所有端点 path `:scope` = `global` | `session`。scope 全链同值直通（无 internal/external 映射）；handler 按 scope 路由：`global`→`<dataDir>/memory/` dir store；`session`→`<session.workspaceDir>/.rocky/memory/` dir store。frontend `memory-api.ts` scope 同步改 `global`/`session`。
>
> **[v0.0.149] entry schema 加 `source`/`updatedAt`（落盘两介质 + POST/PATCH 响应改用 service 落盘值）**：
> - **`source` 字段**（`'user'|'agent'`，落盘值；非响应层合成）：**UI POST origin=user**（handler `memory.ts handleMemoryCreate` 显式传 `source:'user'` 给 dir store createEntry）；**UI PATCH 不传 source**（保留既有 origin，**origin 不可变**）；**DELETE archive 保留既有 source**（archive 非 write 路径不刷戳）。agent `memory_manage` 路径对偶 origin=agent（见 `14-self-evolution-tool-ref.md`）。读侧缺省 `'agent'`（`memory-dir-store.ts parseEntryFile`）。落盘统一 dir store（`memory-dir-write.ts serializeEntryFile` 始终显式写 source）。
> - **`updatedAt` 字段**（ISO 8601 string，**service 落盘值**）：**[v0.0.149 关键订正]** POST/PATCH 响应里的 `updatedAt` 改用 service 层落盘的真实值（`{ entry: written }`，`written.updatedAt = new Date().toISOString()`），**不再在 HTTP 响应层临时合成 `updatedAt: nowIso()`**——消除「落盘值≠响应值」双戳（此前 L125/139/184/205 的 nowIso 合成退役）。DELETE 的 `archivedAt` 仍用 `nowIso()`（不变）。存量 entry 缺 updatedAt → migration 补 now；读侧缺省 `''`。
> - **存量**：旧介质（app_config record / `sessions/*/session_memory.md`）上的 source/updatedAt 补齐 migration 属历史版本事项（详见 `specs/api/version_logs/v0.0.149.md`）；当前介质为 per-entry md，迁移由 MigrationManager `session-memory-per-entry` handler 拆旧格式时保留原戳。
> - **正交**：`source` 与 `evolvable` 正交（evolvable 不参与 source 推断）；`updatedAt` 与 DELETE `archivedAt` 不同（archive 不刷 updatedAt）。

## 3. `GET /memory/:scope` — 列 entry

### 3.1 请求

- path：`:scope` = `global` | `session`（v0.0.112；全链同值直通）
- query：
  - `sessionId`（scope=session **必需**）：目标 session id
  - `includeArchived`（可选，缺省 `false`）：是否含归档 entry

### 3.2 响应

- `200 OK` · `{ "entries": MemoryEntry[] }`

```json
{
  "entries": [
    {
      "name": "prefer-real-llm-tests",
      "intro": "api/e2e 测试不接受 mock",
      "type": "feedback",
      "body": "api/e2e 测试必须用真 LLM + 真服务...",
      "why": "mock-LLM 掩盖真实 bug",
      "howToApply": "禁止 mock-LLM 全绿即发布",
      "evolvable": false,
      "source": "user",
      "updatedAt": "2026-07-15T10:30:00Z",
      "archived": false
    }
  ]
}
```

### 3.3 错误

| HTTP | 触发 | 响应体 |
|------|------|--------|
| `400` | scope=session 缺 sessionId；scope 值非法 | `{ "error": "<原因>" }` |
| `404` | sessionId 对应 session 不存在 | `{ "error": "session not found" }` |

## 4. `POST /memory/:scope` — 新建 entry

### 4.1 请求

- path：`:scope` = `global` | `session`
- body：

```typescript
interface CreateMemoryBody {
  sessionId?: string;          // scope=session 必需
  entry: {
    name: string;              // 唯一 slug（同 scope 内已存在 → 409）
    intro: string;             // [v0.0.114] 一句话摘要（原 description；读侧兼容旧 description）
    type: 'user' | 'feedback' | 'project' | 'reference';
    body: string;              // intro >50 / body >500 字符 → 400
    why?: string;              // type=feedback/project 强制（缺 → 400）
    howToApply?: string;       // type=feedback/project 强制
    // evolvable 可选：UI POST 新建缺省 false（用户资产）
  };
}
```

### 4.2 响应

- `201 Created` · `{ "entry": MemoryEntry }`（含 `evolvable` + `source` + `updatedAt`；UI POST 新建 `evolvable=false` + `source='user'`；**[v0.0.149] `updatedAt` 为 service 落盘值，非响应层合成**）
- `400 Bad Request` · `entry.intro` >50 字符 或 `entry.body` >500 字符（`{ "error": "memory <field> exceeds <limit> chars (current: <n>)" }`）；缺 why/howToApply（type=feedback/project）
- `409 Conflict` · 同 scope 同 name 已存在（`{ "error": "entry already exists", "name": "..." }`）

## 5. `PATCH /memory/:scope/:name` — 更新 entry

### 5.1 请求

- path：`:scope` = `global` | `session` / `:name`（name 是 entry slug）
- body：partial entry（除 name 外字段都可改）。**[v0.0.112] UI 全字段可编辑**（含 `evolvable`，无 gate、无置灰）。

```typescript
interface UpdateMemoryBody {
  sessionId?: string;          // scope=session 必需
  entry: {
    intro?: string;            // [v0.0.114] 原 description 改名；读侧兼容旧 description
    type?: 'user' | 'feedback' | 'project' | 'reference';
    body?: string;             // intro >50 / body >500 字符 → 400
    why?: string;
    howToApply?: string;
    evolvable?: boolean;       // [v0.0.112] UI 可改 true↔false（不受 gate）；省略=保留原值
  };
}
```

### 5.2 响应

- `200 OK` · `{ "entry": MemoryEntry }`（含 `evolvable` + `source`（**保留既有 origin，PATCH 不改**）+ `updatedAt`（**[v0.0.149] service 落盘值，刷新为 now，非响应层合成**））
- `400 Bad Request` · `entry.intro` >50 或 `entry.body` >500 字符；merge 后 type=feedback/project 缺 why/howToApply
- `404 Not Found` · name 不存在（`{ "error": "entry not found" }`）

## 6. `DELETE /memory/:scope/:name` — 归档 entry

> **不真删**（对齐 `memory_manage.archive` 语义）：标记 `archived: true`，可恢复（PATCH 再改回 `archived: false` 或重新 POST）。

### 6.1 请求

- path：`:scope` = `global` | `session` / `:name`
- query：`sessionId`（scope=session 必需）
- **不受 evolvable gate**（UI 全开，与 agent `memory_manage.archive` 的 gate 正交）

### 6.2 响应

- `200 OK` · `{ "ok": true, "archivedAt": "<ISO8601>" }`
- `404 Not Found` · name 不存在

## 7. 与 system prompt 注入的关系

memory 写入**不立即触发 system prompt 重建**——下个 session 启动 / 下次 compact 后的 fork-2 整理时，新内容自动出现在 `memory_user`（stable tier）或 `memory_session`（context tier）注入（见 `memory_injection.md`）。

> AT 验证「新 session system prompt 含新 entry」：新建 session → GET 该 session 的 system prompt fragment（或 GET `/session/:id/messages` 看首条 system message）→ 断言含 entry name/body。

## 8. 服务层实现契约（per-entry md dir store）

> path scope `global`/`session` 全链同值直通（无 internal/external 映射），handler 按 scope 路由到 dir store（`memory-dir-store.ts` 读 / `memory-dir-write.ts` 写）：

```
GET /memory/global         → listEntries(globalMemoryDir(dataDir), { includeArchived })          → 返 entries（<dataDir>/memory/）
GET /memory/session?sid=X  → listEntries(wsMemoryDir(session.workspaceDir ?? <dataDir>/workspace), { includeArchived }) → 返 entries（<ws>/.rocky/memory/）

POST /memory/global        → createEntry → name 已存在 409 | created（锁内 exists 判定，defaultEvolvable:false）
POST /memory/session?sid=X → 同上（ws dir 经 sessionStore.getSession(sid).workspaceDir 解析；session not found → 404）

PATCH /memory/global/:name        → readEntry → 404 | writeEntry(merged, {setEvolvable})  → updated（UI 全开，无 enforceEvolvable）
PATCH /memory/session/:name?sid=X → 同上（ws dir 解析同 GET）

DELETE /memory/global/:name        → readEntry → 404 | archiveEntry(name)  → ok（无 enforceEvolvable）
DELETE /memory/session/:name?sid=X → 同上
```

**强制点**：
- 对外 `global` 走 `<dataDir>/memory/`（`globalMemoryDir(dataDir)`）；对外 `session` 走 `<session.workspaceDir>/.rocky/memory/`（`wsMemoryDir(ws)`，sessionId 经 sessionStore 解 workspaceDir，缺省回退 `<dataDir>/workspace`）。写操作 per-entry 文件锁（`withFileLock` 锁 `<dir>/<name>.md`，与 agent 工具共享锁路径）。
- **长度字符硬限在 dir store 写侧单点强制**（`writeLocked`：intro >50 或 body >500 字符 → throw `MemoryCharLimitError` → handler `charLimitTo400` 返 400），覆盖 UI + agent 两路径（PRD「对人对 agent 一致」）。
- **[v0.0.112] UI 路径不传 `enforceEvolvable`**（UI 全开，不 gate）；POST 新建 `defaultEvolvable:false`；PATCH `setEvolvable` 携带用户改动（省略=保留原值）。agent 工具路径传 `enforceEvolvable:true`（见 `memory_manage_tool.md §5.1`）。
- **[v0.0.149] UI POST origin=user / PATCH 不改 source**：handler `memory.ts handleMemoryCreate` 显式传 `source:'user'`（dir store createEntry opts）；`handleMemoryUpdate` 不传 source（保留既有 origin，**origin 不可变**）；archive 保留既有 source（非 write 路径不刷戳）。dir store 写侧（`memory-dir-write.ts`）create 盖 source + 刷 updatedAt=now；update 保留既有 source + 刷 updatedAt=now；archive 不动 source/updatedAt。**POST/PATCH 响应改用 store 落盘的 `written` 对象**（含真实落盘 source/updatedAt，非响应层合成）。
- handler 层（`handlers/memory.ts` + `memory-helpers.ts parseScope`）按 scope 路由；scope=session 必需 sessionId。

## 9. testid（UI 用，对齐 PRD §2.1/§2.2）

UI 端点本身无 testid；消费端点的 UI 组件 testid：

- session memory tab（chat 右侧）：`memory-session-list` / `memory-session-entry-{name}` / `memory-session-edit-btn` / `memory-session-new-btn`
- user memory group（应用设置）：`memory-user-list` / `memory-user-entry-{name}` / `memory-user-edit-btn` / `memory-user-new-btn`

详见 `specs/ui/components/chat-page/section-memory-panel.md` + `specs/ui/components/app-dev-config-page/section-user-memory.md`。

## 10. 与 `memory_manage` 工具的边界（正交分离）

| 路径 | 主体 | scope 字段 | 受什么约束 |
|------|------|-----------|-------------------------------|
| `POST/PATCH/DELETE /memory/*`（本文） | 用户（UI） | path 参数 `global` \| `session` | 无 evolvable gate（全开）；intro ≤50 / body ≤500 字符硬限；global→`<dataDir>/memory/`／session→`<ws>/.rocky/memory/`（统一 dir store） |
| `memory_manage` 工具（`14-self-evolution-tool-ref.md`） | LLM agent | tool input `scope`（**必填无默认 + 按 biz 校验**，v0.0.238） | evolvable gate（进化性写）；intro ≤50 / body ≤500 字符硬限；共享底层 dir store + per-entry 文件锁 |

**底层 dir store 是单一入口**（三介质同构）：
- global：UI 端点 + agent 工具共享 `<dataDir>/memory/`；session：共享 `<session.workspaceDir>/.rocky/memory/`。写操作统一 per-entry 文件锁（`withFileLock` 锁 `<dir>/<name>.md`）串行 read-modify-write。

## 11. AT 落点

| 路径（PRD §3） | case | 断言重点 |
|---|---|---|
| 路径 1（session memory 查看/编辑） | `tests/api/memory/session_memory_crud_tc1/` | GET 列表 → POST 新建 → PATCH 更新 → 查真落盘 `<session.workspaceDir>/.rocky/memory/<name>.md`（per-entry md）+ 新 session system prompt `memory_session` fragment 含新内容 |
| 路径 2（user memory 查看/编辑） | `tests/api/memory/user_memory_crud_tc1/` | POST global memory entry（type=feedback）→ 查真落盘 `<DATA_DIR>/memory/<name>.md`（per-entry md，global 介质根）+ 新 session system prompt `memory_user` fragment 含新 entry |

> 详细 AT case 由 api-test-designer 按 test-plan 设计，断言基于本契约（不看代码）。

## 12. 不在范围（OUT）

- memory 检索排序/相关度（`memory.search` 仅全字段包含匹配，无排序）—— P1
- session memory 归档/提升策略（session 结束是否提炼到 global memory）—— P1
- **file-total 容量硬限**——per-entry **intro ≤50 / body ≤500 字符硬限（IN，见 §2/§4.2/§5.2）**；文件总长硬限/软告警 OUT（原「memory 容量上限硬拒 OUT」条款订正：per-entry 字符硬限现为 IN）。
