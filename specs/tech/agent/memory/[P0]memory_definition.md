---
type: concept
title: Memory 定义（结构化）
priority: P0
status: active
updated: 2026-08-04
since: v0.0.21
---

# Memory 定义（结构化）

> 主文档：`index.md`（① 是什么）。memory_manage 工具见 `[P0]memory_manage_tool.md`。注入见 `[P0]memory_injection.md`。

## 1. 概述

memory 是 agent 的**结构化、封装的记忆资源**——跨 session 沉淀的用户偏好、事实、决策、教训。支撑 agent 越用越懂用户/项目。

**两个核心约束**：
- **结构化**：markdown + frontmatter，type 分类，可 diff 可审计。
- **封装**：memory 文件**不是普通文件**——agent 不能直接 Read/Edit，只能通过 `memory_manage` 写、通过 native 注入读（见 §4）。保证结构一致 + 写入受容量约束。

## 2. 三个 scope + 三种存储介质（per-entry md dir store 同构）

| scope | 存什么 | 稳定性 | 存储介质 |
|-------|--------|--------|--------------------------|
| `global` | 跨 session 稳定的长期偏好、事实、feedback 教训 | 跨 session 稳定（全局一份） | `<dataDir>/memory/<name>.md`（global ws=数据根本身，资源直接放根不嵌套 `.rocky`） |
| `group` | 团队（squad）内共享的规则/角色行为约束，仅本 group 生效 | group 级（per-group，跨 group 内多 session 稳定） | `<groupWs>/.rocky/memory/<name>.md`（groupWs 经 `agent/group-dir.ts resolveGroupWsDir` 唯一解析：squad=`<dataDir>/squads/<sid>/`） |
| `session` | 当前工作上下文、进行中的决策 | session 级（per-session） | `<session.workspaceDir>/.rocky/memory/<name>.md` |

> **per-entry md 模型**：每 entry 一个独立 md 文件（frontmatter + body），三介质同构统一 `app/server/src/memory/memory-dir-store.ts`（读侧 + 共享类型/parse）+ `memory-dir-write.ts`（写侧）单点实现。**frontmatter 不落 scope**（位置即 scope，读取方按目录 stamp）。旧模型（单文件多 entry：app_config record / `sessions/<sid>/session_memory.md` / `.rocky_squad/memory.md`）废止；存量经 MigrationManager 两 handler 迁移（session 拆 per-entry + squad `.rocky_squad`→`.rocky` 平移），global **不迁移**（app_config `user_memory` record 退役不回读 = 全删重来）。
>
> **scope 命名全链统一 `global|group|session`**：工具 schema / HTTP / UI / mapper / inject-quota / query 同值，**无 internal/external 两层映射**（旧内部 enum `user|squad` 与 `toInternalScope`/`toExternalScope` 映射层废止）。
>
> **介质选择理由**：
> - **per-entry dir store**：每条记忆一个文件 = 锁粒度降到单 entry（并发写不同 entry 不互斥）、单文件不再随条目数膨胀、`listMetas` 扫目录读 frontmatter 即得 L0（name+intro）无需解析整文件；三介质同构共享一套 store 实现（旧三 store 各写一套）。
> - **global 放 `<dataDir>/memory/`（根不嵌套）**：global ws = 数据根本身（多环境隔离已在 dataDir 层），资源直接放根。旧 app_config record 介质废止——app_config 是用户配置值域不是记忆体，记忆体量增长会拖垮配置 record；迁出后与 session/group 同构。
> - **session/group 放 `<ws>/.rocky/memory/`**：`.rocky/` = rocky app 数据在对象 ws 里的存放位置（ws 在哪它在哪），与 `.rocky/skills/`、`.rocky/state/` 同构；session ws 可变（改 workspaceDir 时旧 ws `.rocky/` 复制到新 ws，force:false 不覆盖）。
>
> **group 缺失时的语义**：agent 工具的 group scope 寻址自动完成（`ctx.config.squadId` / `ctx.config.sessionContext?.classroomId` → `resolveGroupWsDir`，input schema 不暴露 id）。无 group 会话（两者皆缺）显式 scope='group' → **`[invalid_input] not_in_group`**（不静默降级 global、不写 orphan）。跨 scope 兜底（scope 未指定）**严格不含 group**——跨组读/搜会污染其他团队数据；跨 scope 兜底只合并 session + global 两源。

## 3. 结构化格式

每条 memory 是一个 entry = **一个独立 md 文件**（`<dir>/<name>.md`，frontmatter + body）：

```yaml
---
name: prefer-real-llm-tests         # 唯一 slug（= 文件名，校验无路径分隔符）
intro: api/e2e 测试不接受 mock，必须真 LLM   # 一句话摘要（v0.0.114 由 description 改名）
metadata:
  type: feedback                    # user | feedback | project | reference
source: agent                       # 'user'=UI 手动写 / 'agent'=memory_manage 自动写；存量=agent
updatedAt: 2026-07-15T10:30:00Z     # 最后修改时间（ISO 8601）；组内排序依据
evolvable: true                     # 是否允许 agent 自动进化（见 §5.1）
# 注意：frontmatter 不落 scope——位置即 scope（所在目录决定），读取方按目录 stamp
---

api/e2e 测试必须用真 LLM + 真服务，agent 实际写数据并查真落库。

**Why:** mock-LLM 让工具/协议测试全绿却掩盖真实 LLM 才暴露的 bug。
**How to apply:** 任何涉及工具/协议的验证，禁止 mock-LLM 全绿即发布。
```

> **一句话摘要字段 `description` → `intro`**（语义不变，纯改名）：原字段名 `description` 与 JSON-schema 关键字 `description` 撞名（工具 inputSchema 里同名易忽略、混淆），改为 `intro` 消歧。全链路——存储层（`memory-dir-store.ts parseEntryFile`）、工具 schema（`memory_manage` / `memory`）、L0 注入、HTTP API request/response、前端 UI 全用 `intro`。
> **兼容读**：所有读侧兜底 `intro ?? description`，容忍存量 frontmatter 仍写 `description`。**写侧只落 `intro`**。旧落盘格式由 `migration/handlers/legacy-memory-format.ts`（frozen parser）承接解析，迁移后即为新格式。
>
> **entry schema `evolvable: boolean`**（同 skill 语义，见 §5.1）：写进 entry md frontmatter。**存量兼容**：缺 `evolvable` 字段的既有 entry 解析时**默认 `true`**（见 §5.1「存量默认」）。
>
> **entry schema `source: 'user'|'agent'` + `updatedAt: string(ISO)`**（注入配额分组排序依据，见 `memory_injection.md §2/§3`）：
> - **`source`** = originator 标记：`'user'` = UI 手动入口写入（`POST/PATCH /memory/*`）；`'agent'` = `memory_manage` 工具自动写入。**存量 entry 统一标 `'agent'`**；**写侧 origin 不可变**——update 保留既有 source，不覆盖。
> - **`updatedAt`** = 最后修改时间（ISO 8601 string）。组内排序靠 entry 内 `updatedAt` 字段（不依赖文件 mtime）。写侧（create/update）刷新 `updatedAt = now`。读侧兼容未加引号的 ISO 时间戳（js-yaml 会解析成 Date 对象，`readUpdatedAt` 统一 `toISOString()`）。
> - **写侧恒显式落 evolvable/source/updatedAt**（`serializeEntryFile` 不走存量默认）；读侧缺省：缺 source → `'agent'`；缺 updatedAt → `''`（排序排末）。

### type 枚举语义

| type | 含义 | 强制 Why/How |
|------|------|-------------|
| `user` | 用户是谁（角色/专长/偏好） | 否 |
| `feedback` | 用户给的纠正/工作方式指导 | **是** |
| `project` | 项目内 agent 长期遵循的规则/约束（**非**进展快照/里程碑/进行中工作——那些属于当前状态不进 memory，见 `routing_decision.md` "Do NOT write" 反例清单） | **是** |
| `reference` | 外部资源指针（URL/dashboard/ticket） | 否 |

## 4. 封装原则（v0.1 先行定义）

- **写**：只能通过 `memory_manage`（write/update/archive）。**禁直接 Edit**。
- **读/进入 context**：通过 native 注入（见 `memory_injection.md`），系统自动组装。**禁 agent 直接 Read 当数据用**。
- **理由**：保证 frontmatter 结构一致 + 容量上限强制 + 注入可控。若 agent 能随意 Edit，结构/容量/注入都失控。

> v0.1 先这么定；后续若需更灵活访问再评估。

## 5. 长度硬限（字符口径）

**intro ≤50 字符 / body ≤500 字符**（trim 后 `str.length`，中英文统一按字符计），写入侧（`memory_manage.write` / UI `POST`·`PATCH`）创建/更新时超限 **hard error 拒绝**。

- **计数口径（单点 `policy.ts INTRO_CHAR_LIMIT`/`BODY_CHAR_LIMIT`）**：trim 后 `str.length`（CJK 字符与 ASCII 字符均计 1），intro > 50 或 body > 500 拒绝。单点实现 `app/server/src/memory/policy.ts`（`MemoryCharLimitError` 携 `field`/`current`/`limit`），落 dir store `writeLocked` 服务层单点（覆盖 agent 工具 + UI HTTP 两路径——PRD「应加，对人对 agent 一致」）。handlers/memory HTTP 400 映射（`charLimitTo400`）。
- **只卡 intro + body**：name/intro/body 各自独立检查；超限返回明确错误（含 field + 当前计数 + 上限）。
- **存量豁免（grandfather）**：只卡**本次写入/更新的新正文**；已存在的超长记忆不追溯报错（不扫既有条目）。
- **旧口径退役**：v0.0.112 的「per-entry 300 词硬限（`countWords`/`WORD_LIMIT`/`MemoryWordLimitError`）」整体删除（被字符口径取代）。file-total soft-warn 不变（v0.0.112 已退役）。

### 5.1 evolvable 治理（v0.0.112，同 skill 语义）

memory entry 引入 `evolvable: boolean`——**只约束 agent 自动进化路径**，UI 用户永远全字段可编辑。

- **agent 路径受限**（`memory_manage`）：**进化性写** = ①`write` upsert 命中**已存在** entry（更新既有）② `archive`。命中 `evolvable=false` 既有条目 → **拒绝**（`[invalid_input] memory "<name>" is non-evolvable`，对齐 skill）。write **新建**（name 不存在）不受 gate（等价 skill create）。
- **UI 全开**：`/memory/*` HTTP 不受 gate——用户可改正文、type、把 `evolvable` false↔true、归档/恢复。**无 lock、不置灰、不防呆**（对齐 skill §8）。`evolvable` 由 UI PATCH body 显式携带修改；agent 工具 payload **不含** `evolvable`（不碰治理元字段）。
- **默认值按来源**：agent 工具 `write` 新建 → `evolvable=true`（agent 资产，可被后续整理改）；UI `POST` 新建 → `evolvable=false`（用户资产，防 agent 擅改）。
- **存量默认**：既有 entry 无 `evolvable` 字段 → 解析视为 **`true`**（保留 v0.0.111 前「无 gate、agent 可写任意 memory」的行为，避免既有记忆被冻结）。**刻意分歧 skill**（skill 缺省 false）：skill create 时总写 evolvable，无真·存量缺口；memory 有真·存量缺口，默认 false 会冻结所有既有记忆的 agent 演化 → 选 true 保状态一致。
- **evolvable 不参与 source 推断**——evolvable 只管「是否可进化」（本文 §5.1），不滥用做来源判定。source 是独立的 originator 标签字段（§3），与 evolvable 正交：同一 entry 可同时 `source='user', evolvable=false`（用户手写 + 不许 agent 改）或 `source='agent', evolvable=true`（agent 写 + 可继续演化）。注入配额分组（`memory_injection.md §2`）按 `scope × source` 派生六类键，不读 evolvable。

### 5.2 存储数量硬上限（create 路径配额）

**各 scope active 条目数硬限**：global ≤50 / group ≤30 / session ≤20（与注入配额 §`memory_injection.md §2.2` 同值同源，复用 `app_config.session` group 三 key：`maxMemoryInject`/`maxMemoryInjectGroup`/`maxMemoryInjectSession`；存储侧 `resolveMemoryStoreQuotas` 读同 key 同兜底）。补 v0.0.238 注入配额只截「注入 prompt 条数」不限「磁盘存储条数」的缺口——存储只增不减会导致某 squad group memory 堆到 72 条。

- **位置 = writeLocked 服务层单点**（`memory-dir-write.ts`，与字符硬限同位置）：agent 工具（`writeEntry` upsert）+ UI HTTP（`createEntry` forbidExisting）两路径同款强制。
- **溢出 = `MemoryQuotaExceededError` 硬拒绝**（`policy.ts`，携 `scope`/`current`/`limit`/`nonEvolvableCount` 四字段）；message 形态 `memory <scope> quota exceeded (<current>/<limit>); archive N 旧条目腾位后再写`（N = current-limit+1，min 1）。HTTP 400 映射（`quotaTo400`）；agent 工具 `[invalid_input]`。
- **核心不变量**（贯穿实现）：
  1. **只在 create 触发**——`writeLocked` 锁内 `!existing` 分支查配额；`update`（existing）路径与 `archiveEntry` **不查**（archive 是减少 active，被自己拦会自锁）。
  2. **archived 不计入**——`countActiveEntries` 调 `listEntries(dir, {includeArchived:false})`（复用 store 扫描 + 坏文件跳过，不手写 readdir）。
  3. **evolvable=false 计入配额**（防全标 false 绕过），但溢出错误文案如实附 `（其中 X 条 evolvable=false 无法 archive，需手动处理）`——守「永不自动删」+ v0.0.151「如实反映」立场。
  4. **count + check + write 原子**——嵌套 dir 级虚拟锁 `path.resolve(dir, '.quota.lock')`（仅 create 分支），count+check+write 全在 dir 锁内串行，防并发 TOCTOU race；嵌套顺序固定 entry 锁（外）→ dir 锁（内），全路径一致无死锁。
  5. **MemoryWriteOpts.store 可选注入**——`{scope, appConfig}` 缺省（undefined）= 不查配额（向后兼容存量 caller / UT 直调 writeLocked）。
  6. **值同源概念解耦**——`MemoryStoreQuotas` 独立 type（不复用 `MemoryInjectQuotas`）：注入截 prompt 条数 / 存储挡写入，语义不同未来可拆 key 互不影响。
- **存量不追溯**：现存超限条目不强制清理，靠硬拦截驱动收敛（每次写新被拒→被迫 archive→逐步压到上限内）。

## 6. 设计决策

- **3 scope（global/group/session）**：覆盖跨 session 稳定（global）+ 团队内共享（group = squad 或 classroom）+ session 级三类，注入入口清晰（三 mapper 协同见 `memory_injection.md §2`）。
- **三介质同构 per-entry dir store**：global=`<dataDir>/memory/`（global ws=数据根本身不嵌套）；session/group=`<ws>/.rocky/memory/`（`.rocky/` = rocky app 数据在对象 ws 里的存放位置，与 skills/state 同构）。统一 `memory-dir-store.ts`/`memory-dir-write.ts` 单点实现——旧三 store（app_config record / per-session md / per-squad md 三套实现）废止，锁粒度从「单文件多 entry」降为 per-entry 文件锁。
- **结构化 frontmatter + Why/How**：feedback/project 强制可执行（不只是归档，而是防回归规则）。frontmatter 不落 scope（位置即 scope，读侧按目录 stamp）。
- **封装**：memory 是受管资源非普通文件——三介质统一经 dir store 读写（不裸 Read/Edit/KV），保证结构/容量/注入一致。
- **长度字符口径**：逼密度、写结论不写流水；intro ≤50 / body ≤500 字符硬拒（per-entry），存量豁免。
- **evolvable 治理**：agent 受限（进化性写 gate）/ UI 全开，复刻 skill；存量默认 true 保状态一致（§5.1）。
- **不审批（写新建）**：write 新建不审批（self evolution），靠 evolvable gate（既有条目）+ 归档 + 整理兜底。
- **存储数量硬限（补 v0.0.238 注入配额存储侧缺口）**：create 路径查 active 条目数（archived 不计），超 group30/global50/session20 硬拒（错误引导 archive 腾位）；count+write 在 dir 级虚拟锁内原子（防 race）。值跟注入配额同源、概念解耦（独立 type）。详见 §5.2。

## 7. 待定

- entry 分隔符（§ vs markdown heading）最终定
- ~~容量上限具体值~~（intro ≤50 / body ≤500 字符硬限，file-total 退役）
- 是否引入 content_type 半衰式衰减（P1，二级整理）
- **session memory 归档 / 提升策略**：session 结束时 session 级 memory 的 entry 是否提炼提升到 global、何时清空、是否随 session 持久化保留——待 P1 设计。当前仅约定 session 级介质存在 + 容量上限，session 生命周期的归档策略未定。
