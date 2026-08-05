---
type: index
title: Memory 子系统总起
priority: P0
updated: 2026-08-04
---


# Memory 子系统总起

## ① 是什么

memory 子系统负责 agent **长期记忆**：定义、管理（`memory_manage` 工具）、整理（一级实时 + 二级离线 P1）、native 注入 context。memory 是**封装资源**（md + frontmatter），agent 不直接 Read/Edit，只走 `memory_manage` 写 + native 注入读。与 `../skills/` 共同支撑 agent self evolution——skill 衍生（一级整理 fork-2 直接调 `skill_manage` 工具）已落地。

> **实现状态**：`memory_manage` 工具（`app/server/src/tools/memory-manage.ts` + scope 助手 `memory-manage-scope.ts`，write/archive/list/read 全 action 落地）+ **per-entry md dir store 统一三介质**（`app/server/src/memory/memory-dir-store.ts` 读侧 + `memory-dir-write.ts` 写侧；global=`<dataDir>/memory/`、session/group=`<ws>/.rocky/memory/`，frontmatter 不落 scope=位置即 scope）+ 一级整理 fork-2（`app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts`，allowed tools=[skill_manage, memory_manage]，fork prompt 默认 scope=session）+ `rocky_context` memory system_prompt_mapper 三 impl（`memory_user`(stable 450) + `memory_group`(stable 400) + `memory_session`(context 350)）全部落地。存量迁移走 MigrationManager 两 handler（session-memory-per-entry + squad-rocky-dir）；global 旧介质 app_config `user_memory` record 退役不回读（不迁移）。旧 `managed-store.ts`/`squad-memory-store.ts`/`user-memory-service.ts` 已整删。post_compact AT 不可行（compact 触发链路黑盒不可观测），UT 覆盖。

| 核心概念 | 一句话 |
|---|---|
| **memory** | 结构化封装记忆资源（每 entry 一个 md 文件：frontmatter + body），`type=user\|feedback\|project\|reference` |
| **global memory** | 全局跨 session 稳定记忆（stable tier 注入，cache 友好）；介质 = `<dataDir>/memory/<name>.md`（global ws=数据根本身，不嵌套 `.rocky`） |
| **group memory** | group（squad 或 classroom）级共享记忆（stable tier priority=400）；介质 = `<groupWs>/.rocky/memory/<name>.md`，groupWs 经 `resolveGroupWsDir` 唯一解析 |
| **session memory** | session 级工作上下文（context tier 注入，超预算可裁）；介质 = `<session.workspaceDir>/.rocky/memory/<name>.md` |
| **memory**（纯读） | read（单条正文 L1）/ search（关键词全字段匹配，回 name+intro），与 memory_manage 分离，对称 `skill` |
| **intro**（一句话摘要） | entry 的一句话摘要字段，原名 `description`，改名消歧 JSON-schema 关键字；读侧全链路兼容旧 `description`（`intro ?? description`） |
| **source / updatedAt** | entry 的 originator 标签（`'user'`=UI 手动 / `'agent'`=memory_manage 自动；存量=agent）+ 最后修改时间（ISO 8601 string，组内排序依据；frontmatter 内字段，不依赖文件 mtime） |
| **memory_manage** | write/archive/list/read 写侧工具，**不审批**（self evolution）；evolvable 治理 + 字符硬限（intro ≤50 / body ≤500）；write 盖 source='agent' + 刷 updatedAt=now |
| **一级整理（笔）** | session 级实时收集：时机 A 随时调 manage / 时机 B compact 后通过 post-compact ext point 触发 fork-2（直接调工具落盘，fork prompt 默认 scope=session） |
| **二级整理（编辑）** | 离线深度整合（merge/prune/矛盾解决/容量回收），天级调度（见 `consolidation_tier2.md`） |
| **native 注入** | system_prompt mapper 自动注入 **L0（name+intro）**（正文按需读，cache 友好） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| memory 定义（结构化格式 + 封装 + 容量上限） | skill 定义/存储/治理/写工具（→ `../skills/`） |
| memory_manage 工具（write/archive/list/read，不审批） | ContextEngine ingest/assemble/compact（→ `../context/`） |
| 一级整理（compact 时机双 fork + ops 落盘） | forked agent 机制（→ `../agent_interface_and_loop/`） |
| 二级整理方向（P1 占位） | plugin EP / mapper 扩展点契约（→ `../../plugin_system/`） |
| native 注入入口（复用 system_prompt mapper） | system_prompt builder 三阶段（→ `../context/[P0]system_prompt.md`） |

## ③ 与系统的关系

```
                  ┌── context/         (native 注入目标：system_prompt mapper = memory_user/memory_session impl)
                  │
   memory KB ─────┼── skills/          (skill 衍生：一级整理 fork-2 直接调 skill_manage 工具落盘，v0.0.51 spec 完善)
   (本目录)        │
                  ├── agent_interface_and_loop/  (forked agent + manage tool 挂载在 loop)
                  │
                  ├── session/         (session_memory 与 session 生命周期绑定)
                  │
                  └── observability/   (整理 / 注入过程可观测)
```

**对外协作点**：
- memory 文件受管读取（非裸文件 Read），落 `app/server/src/agent/`（memory 受管层）。
- 注入 mapper 落 `rocky_context` builtin plugin（`system_prompt_mapper` EP 的 `memory_user`/`memory_session` impl，见 `../context/[P0]extension point and implementations.md` §3.4）。
- compact 时机双 fork 复用 `context_compact` 基础设施（搭便车，不新增调度）。

## ④ 核心设计原则（跨文件不变量）

1. **self evolution 不审批**——memory 写入无人工 gate，安全靠「整理 + 归档不删 + 可回滚」。→ `memory_definition.md` §4 + `memory_manage_tool.md` §3
2. **笔/编辑分离**——一级（session 级实时收集，容忍噪声）与二级（离线深度整合）解耦到不同时间尺度。→ `consolidation_tier1.md` §1
3. **memory 是封装资源，不是普通文件**——只能 manage 写、native 注入读；agent 不直接 Read/Edit（保证结构/容量/注入一致）。→ `memory_definition.md` §4
4. **[v0.0.112 翻转] L0 注入（name+intro）+ 按需读正文，不整文件注入**——注入侧只带每条 memory 的 `name + intro`（L0，对齐 skill catalog；`intro` v0.0.114 由 `description` 改名），正文经 `memory` 纯读工具按需读（L1）。翻转 v0.0.21~v0.0.111 的「whole-file 整体注入」冻结不变量：条目再多也不撑爆上下文（progressive disclosure）。search 兜底定位被 budget_truncate 裁掉的 session 记忆 + 匹配正文。→ `memory_injection.md §3` + `memory_tool.md`
5. **载体 = markdown + frontmatter**——无隐藏数据库，可 diff 可审计。→ `memory_definition.md` §3
6. **写操作原子串行化（per-entry 文件锁）**——`memory_manage` 写操作（write/archive）经 per-entry 文件锁串行化（`withFileLock` 锁 `<dir>/<name>.md`，三介质统一；`createEntry` 锁内 exists 判定防 TOCTOU）。读操作 + native 注入不持锁。→ `memory_manage_tool.md §7.2`
7. **UI 端点与 agent 工具正交**——UI 改 memory（HTTP `/memory/*`）与 agent 改 memory（`memory_manage` 工具）是两条独立路径，**共享底层 dir store**（`memory-dir-store.ts`/`memory-dir-write.ts`，三介质同构），跨路径并发写由 per-entry 文件锁串行化。两条路径在 API 入口、调用语义、契约范围上完全独立；UI 行为不混入 agent 工具调用语义。→ `memory_manage_tool.md §9` + `specs/api/overall/15-memory-ui.md`
8. **介质三层同构（per-entry md dir store）**——每 entry 一个 md 文件（frontmatter + body）；**frontmatter 不落 scope**（位置即 scope，读侧按目录 stamp）：global = `<dataDir>/memory/<name>.md`（global ws=数据根本身，资源直接放根不嵌套 `.rocky`）；session = `<session.workspaceDir>/.rocky/memory/<name>.md`；group = `<groupWs>/.rocky/memory/<name>.md`（groupWs = squad 或 classroom 共享 ws，见原则 15）。三介质统一 `memory-dir-store.ts` 单点实现（旧单文件多 entry 模型废止）；app_config `user_memory` record 退役不回读。→ `memory_definition.md §2`
9. **session/group 寻址由工具自动完成，input schema 不暴露 id**——`memory_manage` session scope 的 ws 取自 `ctx.config.workdir`（调用方 session 自己的工作目录）；group scope 的 ws 经 `resolveGroupWsDir(dataDir, {squadId: ctx.config.squadId, classroomId: ctx.config.sessionContext?.classroomId})` 解析。session/group memory = 调用方自己的记忆，系统通过 ctx 权威知道，**input schema 不暴露 sessionId/workspaceDir/squadId**（不交给 LLM 传长 ULID，易混淆致数据 orphan）。UI 端点是另一条路径，仍显式带 sessionId。→ `memory_manage_tool.md §6「寻址自动完成」`
10. **[v0.0.80.t1] compact 时机 sibling 双发 + 纯生产者**——fork-2 整理 agent 不再是 compact 成功后的串行后续，而是与 summary 并发的 sibling：`tryCompact` 谓词 true 后 deep clone snapshot ONCE → `void runSummarySibling + void runConsolidationSibling` 双发，各自 acquire 自己的锁（`compact` / `tier1_consolidation`），互不阻塞、各自静默跳过；compact/forked 是**纯生产者**（产 summary + accumulateUsage write；不碰消费侧 re-assemble/setSystem/notifyUsageChanged，usage 推送归正规 assemble 管线）。→ `consolidation_tier1.md §4/§5` + `../context/[P0]context_compact_detail.md §2c.1.0`
11. **[v0.0.112] evolvable 治理（agent 受限 / UI 全开）**——memory entry 引入 `evolvable`（同 skill 语义）：只挡 agent 自动进化路径（`memory_manage` 对 `evolvable=false` 既有条目的**进化性写** = 更新既有条目（write upsert 命中已存在）+ archive → 拒绝，错误码 `[invalid_input] non-evolvable`）；UI 路径不受 gate（用户对自己 dataDir 资产完全控制权，无置灰、不防呆）。默认值按来源：agent 工具 write 新建=true / UI POST 新建=false；**存量（无 evolvable 字段）→ 视为 true**（保留 v0.0.111 前无 gate 的 agent-可写行为，避免既有记忆被冻结——与 skill 默认 false 的刻意分歧）。→ `memory_definition.md §5.1` + `memory_manage_tool.md §5`
12. **正文 300 词硬限（存量豁免）+ scope 全链统一命名 `global|group|session`**——单条正文 >300 词（CJK 逐字 + 非 CJK 分词，单点 `countWords`）在写入侧（agent write / UI POST·PATCH）**hard error 拒绝**，只卡本次写入新正文（存量豁免）；file-total soft-warn 退役（OUT，只做 per-entry 硬限）。scope 全链（工具 schema / HTTP / UI / mapper / inject-quota / query）统一三值 `global|group|session`，**无 internal/external 两层映射**（旧 `user|squad` 内部命名与 `toInternalScope`/`toExternalScope` 映射层废止）；create/write 默认 global。→ `memory_definition.md §5` + `memory_manage_tool.md §5.1/§2`
13. **entry 加 source/updatedAt + 注入总量配额（分组排序截断）**——entry schema 新增 `source:'user'|'agent'`（originator 标签，存量=agent）+ `updatedAt:ISO`（组内排序依据，存量由 migration 补 now）；写侧 create 盖 source + update 保留既有 source（**origin 不可变**）+ 刷新 updatedAt=now；archive 不刷戳。注入配额（PRD §2）：六类分组（session 手/自 → group 手/自 → global 手/自，见原则 15）+ 组内 updatedAt 倒序 + 跨类取前 N（默认50，`app_config.session.maxMemoryInject`）。**三 mapper 协同共享同一总量配额**：纯函数 `selectMemoriesByQuota`（`memory/inject-quota.ts`），memory_user + memory_group + memory_session 各自读三源后调同一函数得同输入同输出划分，各自只输出本 scope 切片（tier 不变，reducer/builder 无感）。截断在 mapper/纯函数内闭环，不新增 reducer。**evolvable 不参与 source 推断**（两字段正交）。→ `memory_definition.md §3/§5.1` + `memory_injection.md §2.1/§2.2` + `memory_manage_tool.md §6/§6.1`
14. **[v0.0.151.t2_consolidate] 二级整理天级落地（tier2 不再 P1 占位）**——独立于 tier1 的 app 级天级调度任务（复用 `SchedulerEngine`，job type='consolidation'），三段严格串行（全局 skill→全局 memory→各 session memory）+ 双重 skip（无新对话/session memory 为空零 LLM）+ 容量上限收敛（`source='agent'` 计数，`evolvable` gate 不豁免）+ 独立 `agentManager.forkedRun` 执行载体（无 skill 注入，synthetic SessionConfig/ContextSnapshot，不走 `buildSessionConfigFromDeps`）。不与 tier1 共享 runner，也不新增互斥锁（既有存储层锁 + engine per-job inFlight 已足够）。→ `consolidation_tier2.md` 全篇 + `../../scheduling/[P1]consolidation_job.md`
15. **group 层 = squad 共享 + 6 类注入配额 + 无 group 会话拒绝**——scope 第三层 `group`：squad ws `<dataDir>/squads/<sid>/`（`agent/group-dir.ts resolveGroupWsDir` 唯一解析点，皆无返 undefined）；group 寻址从 `ctx.config.squadId` 自动填（input schema 不暴露）；**无 group 会话显式 scope='group' → `[invalid_input] not_in_group` 拒绝报错**（不静默降级 global、不写 orphan——用户拍板延续）。跨 scope 兜底（scope 未指定）**严格不含 group**（防跨组污染隔离 invariant）。注入配额 6 类（`GROUP_ORDER`：session 手/自 → **group 手/自** → global 手/自，group 层夹中间——比 global 贴当前团队场景、比 session 稳定）；第三 mapper `memory_group`（tier=stable priority=400 介于 memory_user 450 与 memory_session 350 之间），三 mapper 协同（各自读三源 → 调 `selectMemoriesByQuota(globalEntries, sessionEntries, groupEntries, maxN)` 得同一划分 → 各自输出本 scope 切片，reducer/builder 无感）。→ `memory_definition.md §2/§3` + `memory_manage_tool.md §2/§6/§7.2` + `memory_injection.md §2/§2.1/§2.2`
16. **`.rocky/` 收口 + 存量迁移策略 + session ws 可变复制 + T1 默认翻转**——① **`.rocky/` = rocky app 使用的、该对象相关数据的存放位置；它在对象的 ws 里，ws 在哪它在哪**（global=`<dataDir>/` 根不嵌套；session=`<session.workspaceDir>`；squad=`<dataDir>/squads/<sid>/`）；memory/skill/state 统一收口 `.rocky/`（squad 旧 `.rocky_squad/` 废止），业务实体（transcript/board 等 CrudStore entity）不动。② **迁移策略分介质**：global memory 迁出 app_config **不迁移**（`user_memory` record 退役不回读 = 全删重来）；session/squad 存量走 MigrationManager 两 handler（`session-memory-per-entry` 拆 per-entry + `squad-rocky-dir` 平移 `.rocky_squad`→`.rocky`）。③ **session ws 可变复制**：改 workspaceDir 时旧 ws `.rocky/` 复制到新 ws（`cpSync force:false` 不覆盖新 ws 既有内容，2 session 挤同一 ws=一份不阻止）。④ **T1 fork-2 prompt 默认 scope 翻转 session**（`consolidation.md` fork 专属覆盖段；共享 `ROUTING_DECISION_PROMPT` 与 `memory_manage.write` 工具默认 global 不动，UI 手动新建默认 global 不变）。→ `states/v0.0.205.t2_cons/context.md` 存储模型定稿 + `specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md`
17. **[v0.0.247] 存储数量硬上限（补 v0.0.238 注入配额存储侧缺口）**——注入配额只截 prompt 条数、不限磁盘条目（曾致某 squad group memory 堆到 72 条）；本版在 `writeLocked` create 分支（`!existing`）加各 scope active 条目数硬限（global50/group30/session20，与注入配额同值同源——复用 `app_config.session` 三 key；独立 `MemoryStoreQuotas` type 概念解耦）。**6 不变量**：① 只在 create 触发（update/archive 不查，否则 archive 自锁）② archived 不计入（`listEntries({includeArchived:false})`）③ evolvable=false 计入（防绕过）但错误文案如实告知无法 archive ④ count+write 在 dir 级虚拟锁 `path.resolve(dir,'.quota.lock')` 内原子（防 TOCTOU race；嵌套 entry 外/dir 内无死锁）⑤ `MemoryWriteOpts.store` 可选（缺省不查，向后兼容）⑥ 溢出 `MemoryQuotaExceededError` 硬拒绝 + 引导 archive 腾位（永不自动删）。→ `memory_definition.md §5.2` + `specs/tech/version_logs/v0.0.247/change_plan.md`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **定义 / 工具** | | |
| `memory_definition.md` | memory 结构化格式（3 scope + per-entry md + frontmatter type + Why/How + evolvable + 字符硬限 intro ≤50 / body ≤500 + scope 全链统一命名） | [link]([P0]memory_definition.md) |
| `memory_tool.md` | memory 纯读工具（read/search，L1 按需读，对称 skill） | [link]([P0]memory_tool.md) |
| `memory_manage_tool.md` | memory_manage 写侧工具（write/archive/list）+ evolvable gate + 字符硬限 + 路由提示词 + scope 全链统一命名 | [link]([P0]memory_manage_tool.md) |
| **整理** | | |
| `consolidation_tier1.md` | 一级整理（session 级「笔」）：时机 A + 时机 B（compact 后通过 post-compact ext point 触发 fork-2，直接调 skill_manage/memory_manage 工具落盘） | [link]([P0]consolidation_tier1.md) |
| `consolidation_tier2.md` | **[v0.0.151.t2_consolidate]** 二级整理（天级离线「编辑」）：三段严格串行（全局 skill→全局 memory→各 session memory）+ 双重 skip + 容量收敛，sideRun 独立执行载体 | [link]([P0]consolidation_tier2.md) |
| **注入** | | |
| `memory_injection.md` | native 注入 context（复用 system_prompt mapper + [v0.0.112] L0 注入 name+intro，正文按需读） | [link]([P0]memory_injection.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
