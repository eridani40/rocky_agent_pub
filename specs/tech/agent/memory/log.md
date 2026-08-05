---
type: log
title: Memory KB 变更记录
updated: 2026-08-04
---

# Memory KB 变更记录（ISO 倒序，最新在前）

## 2026-08-04 · v0.0.247 存储数量硬上限（补 v0.0.238 注入配额存储侧缺口）

- **`memory_definition.md §5.2`（新增）**：各 scope active 条目数硬限 global50/group30/session20（与注入配额同值同源，复用 `app_config.session` 三 key `maxMemoryInject`/`maxMemoryInjectGroup`/`maxMemoryInjectSession`；`MemoryStoreQuotas` 独立 type 概念解耦）。位置 = `writeLocked` 服务层单点（agent `writeEntry` upsert + UI `createEntry` 两路覆盖）。
- **6 不变量**：① 只在 create 触发（`!existing` 分支；update/archive 不查——archive 自锁）② archived 不计入（`listEntries({includeArchived:false})`）③ evolvable=false 计入但错误文案如实告知 ④ count+check+write 在 dir 级虚拟锁 `path.resolve(dir,'.quota.lock')` 内原子（防 TOCTOU race；嵌套 entry 外/dir 内无死锁）⑤ `MemoryWriteOpts.store` 可选注入（缺省不查向后兼容）⑥ 溢出 `MemoryQuotaExceededError` 硬拒绝 + 引导 archive 腾位（永不自动删）。
- **新增符号**：`memory/store-quota.ts`（`MemoryStoreQuotas`/`DEFAULT_MEMORY_STORE_QUOTAS`/`resolveMemoryStoreQuotas`/`countActiveEntries`/`checkMemoryStoreQuota`）+ `policy.ts` `MemoryQuotaExceededError` + `MemoryWriteOpts.store` 可选字段。handlers/memory `quotaTo400` HTTP 400 映射；memory-manage `[invalid_input]`。
- **app_config §3.15 同步**：存储侧 `resolveMemoryStoreQuotas` 读同组 key 同默认值（注入配额与存储硬限共用），概念解耦独立 type。
- **存量不追溯**：现存超限条目不强制清理，靠硬拦截驱动收敛。
- 详情：`specs/tech/version_logs/v0.0.247/change_plan.md`（memory 子系统 + 6 核心不变量）+ `specs/prd/overall/14-prompt-quality-governance.md §14.2.5`。

## 2026-08-02 · v0.0.238 注入分层配额 20/30/50 + 写侧 scope 必填/按 biz 校验 + 长度字符口径 + T1 整理者化

- `memory_injection.md §2.2` 注入配额：从「三源共享 maxMemoryInject=50（6 类跨组连续取前 N）」改为**按 scope 分层独立配额**（session ≤20 / group ≤30 / global ≤50，各 scope 独立 slice）；层内顺序（manual→agent + updatedAt 倒序 + name 升序）不变；层间不再共享总量。app_config：`maxMemoryInject` 语义转为 global 层；新增 `maxMemoryInjectGroup`(30)/`maxMemoryInjectSession`(20)。biz 对齐可用层靠物理同址去重天然保证（studio session 源=空 / playground group 源=空），无注入侧额外代码。
- `memory_manage_tool.md §2` write/archive：**scope 必填无默认 + 按 biz 校验**（可用表来自 `biz-scope-rules.ts`；biz 由 `resolveBizScopeKind(ctx.config)` 读 kind.biz 缺省 playground；read 保留缺省 global 读侧宽容）。
- `memory_manage_tool.md §5` 长度口径：300 词 → **字符口径**（intro ≤50 字符 / body ≤500 字符，trim 后 str.length）；落 dir store `writeLocked` 服务层单点（覆盖 agent 工具 + UI HTTP 两路径——PRD「应加，对人对 agent 一致」）。`policy.ts` 删 `countWords`/`WORD_LIMIT`/`MemoryWordLimitError`，新增 `INTRO_CHAR_LIMIT`/`BODY_CHAR_LIMIT`/`MemoryCharLimitError`。handlers/memory HTTP 400 映射同步。
- `consolidation_tier1.md` T1 整理者化：toolBound 扩 `[skill_manage, memory_manage, read, write, edit, glob, grep]`；指令加 5 条整理标准 + 红线（禁删角色定位/铁律、不删文件、memory 只 archive、skill 只 disable、evolvable=false 不动）；`{{agents_paths}}`/`{{scope_table}}` 占位符按主 session kind/biz 渲染（路径复用 agent_profile 单源，academy OUT 固定行）；删 fork-override 默认翻 session 段（被 scope 必填取代）。
- `memory_manage_tool.md §5.2` 路由提示词 Step 2 重写（scope 必填 + 全 biz 静态可用表；4 处同源含 consolidation-tier2-handler）。
- `consolidation_tier2.md §6` tier2 prompt 加 `{{write_scope}}` 占位符（偏离 change_plan 最小补丁）：scope 必填后 tier2 的 memory_manage/skill_manage 调用由 LLM 发起，须在 prompt 显式告知该传哪个 scope（全局块='global'/单 session 块='session'）；handler 从 `ctx.vars.write_scope` 读，三 run caller 各传值。
- `memory_definition.md §5` 长度口径：300 词（`countWords`/`WORD_LIMIT`/`MemoryWordLimitError`）整体退役，改为字符口径（intro ≤50 / body ≤500 字符，trim 后 `str.length`）；新增 `INTRO_CHAR_LIMIT`/`BODY_CHAR_LIMIT`/`MemoryCharLimitError`。

详情：`specs/tech/version_logs/v0.0.238/change_plan.md`（C-D-E-F 节）+ `specs/prd/overall/14-prompt-quality-governance.md` §14.2。

## 2026-08-01 · v0.0.232 squad session/group 记忆介质同址去重

- **`[P0]memory_injection.md` §2.3（新增）**：squad session 的 workspaceDir=squads/{sid} 后 session 源与 group 源物理同址——`readMemorySources` 同址跳过 session 源（防 memory_session/memory_group 双注入同一批条目）；语义=D5「memory 只留团队级」。写侧/查询侧不改（自然同址）；存量旧 session 不同址行为不变（无迁移）。
- 详情：`specs/tech/version_logs/v0.0.232/change_plan.md`


## 2026-07-28 · v0.0.208 academy 板块整体删除（影响：group scope 去 classroomId 维度）

- **`[P0]memory_definition.md §2`** + **`[P0]memory_manage_tool.md §2/§6`** + **`index.md` 原则 15/16**：`group` scope 收窄为仅 squad（classroom 作为 group 类型删除）；`resolveGroupWsDir(dataDir, {squadId?})` 去 classroomId 形参；group 寻址仅 `ctx.config.squadId`（去 sessionContext.classroomId 分支）。HTTP API `15-memory-ui.md` 同步去 academy 引用。

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-26 · v0.0.205.t2_cons（存储模型统一：.rocky 收口 + scope 三层 + per-entry md）

- `index.md` ④ 新增原则 16（`.rocky/` 收口哲学 + 迁移策略 + session ws 复制 + T1 默认翻转）+ **旧原则就地修订为现状**：原则 6（锁→per-entry 文件锁统一三介质，app_config mutex 退役）、原则 7（共享底层→dir store）、原则 8（介质→三层同构 per-entry md：global=`<dataDir>/memory/`、session/group=`<ws>/.rocky/memory/`，frontmatter 不落 scope）、原则 9（session 寻址 sessionId→workdir）、原则 12（scope 命名→全链统一 `global|group|session`，删 internal/external 两层映射）、原则 13（四类→六类引用）、原则 15（squad→group：resolveGroupWsDir 唯一解析点 + not_in_group + memory_group mapper）；① 概念表 + 实现状态同步（managed-store/squad-memory-store/user-memory-service 已整删）。
- `.rocky_squad/` → `.rocky/` 收口（squad-store 骨架 + scheduler-state/history + budget-state + filewatch IGNORED）；classroom 新增 group 层 `<dataDir>/academy/classrooms/<cid>/.rocky/`（memory + skills，coach 经 sessionContext.classroomId 解析）。
- `memory-dir-store.ts`（读侧）+ `memory-dir-write.ts`（写侧）新建统一三介质；global 迁出 app_config **不迁移**（全删重来，PRD 定案 4）；session/squad 存量走 MigrationManager 两 handler（session-memory-per-entry + squad-rocky-dir）；T1 fork-2 prompt 默认翻 session（consolidation.md 覆盖段，共享常量与工具默认 global 不动）；session ws 可变复制 `.rocky/`。
- 子文件同步：`[P0]memory_definition.md` §2/§3/§6（三介质表 + per-entry 模型）、`[P0]memory_manage_tool.md` §2/§6/§7.2/§9（scope 表 + 寻址 + 锁）、`[P0]memory_tool.md` §2/§5/§6（MemoryScope 直通 + 错误表）、`[P0]memory_injection.md` §2/§2.2（三 mapper 读源 dir store + 6 类分组键）、`[P0]consolidation_tier1.md` §6（fork 专属覆盖段默认翻 session + 路由第二步 3 值）、`[P0]consolidation_tier2.md` §3/§4/§5（读源改 dir store + sideRun workdir + 锁描述）。

详情：`specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md`（method 级契约）+ `states/v0.0.205.t2_cons/context.md`（存储模型定稿）

## 2026-07-25 · v0.0.204 收尾（fork-2 纯 directive 同 fork-1 契约）

- **`[P0]consolidation_tier1.md §注记/§4/§6`**：fork-2 对齐 runKind='consolidate' 表达（modeKey=memory_extract 退役）；§6 ConsolidationHandler.build 改纯 directive（不读 vars 只填 routing_rules；consolidation.md 删 serialized_transcript 占位——v0.0.51 遗留违例修复，对话历史由 snapshot 经旁路 buffer 唯一承载，与 fork-1 summary 同契约）；防递归改述 consolidate 基座 scope（noop_post_compact）。

## 2026-07-17 · v0.0.164.memory_opt（memory scope 加 squad + routing 强化 + tier2 质量段 + AppTaskLock）

- **`[P0]memory_definition.md §2/§3`**：entry scope enum 从 `user|session` 扩为 `user|session|squad`（对外映射 `global|squad|session`）；type 说明澄清 project = 项目内需 agent 长期遵循的规则/约束，**不是**进展快照/里程碑。§2 加第三种介质（per-squad md `<dataDir>/squads/<squadId>/.rocky_squad/memory.md`，与 skill squad ws 目录同处 `.rocky_squad/` 内部命名空间，与 workspace `.rocky/` 前缀区分）；§6 设计决策同步扩到「3 scope + 三介质」表述。
- **`[P0]memory_manage_tool.md §2/§5.2/§7.2`**：scope 对外 enum 扩为 3 值（`global|session|squad`，list 支持 `all` 合并 3 scope）；squad scope 的 `squadId` 从 `ctx.config.squadId` **自动填**（对齐 v0.0.77 sessionId 自动填先例，input schema 不暴露 squad_id）；**无 squad 会话 scope='squad' → `[invalid_input] not_in_squad`**（用户拍板 2026-07-17，不静默降级 global、不写 orphan）；§5.2 路由提示词第二步扩到 3 值（global/squad/session）+ Do NOT write 反例清单一句话；§7.2 锁策略表加第三种介质（squad = per-file lock on 上述 md 路径，与 session per-file lock 同款范式）。
- **`[P0]memory_tool.md §2/§5/§6`**：`MemoryScopeExternal` 扩 3 值；read/search 跨 scope 兜底**严格不含 squad**（防跨 squad 数据污染 invariant）；errors 表加 `[invalid_input] not_in_squad` 分支；§6 边界翻译加 squad scope 分支说明。
- **`[P0]memory_injection.md §2/§2.1/§2.2`**：注入 mapper 从 2 个（memory_user/memory_session）扩到 3 个（新增 **memory_squad**，tier=stable priority=400 介于 user 与 session 之间）；三 mapper 协同（各自读三源 → 调新签名 `selectMemoriesByQuota(userEntries, sessionEntries, squadEntries, maxN)` 得同一划分 → 各自输出本 scope 切片）；分组从 4 类扩为 **6 类**（`GROUP_ORDER` 6 值按用户拍板顺序：session 手 → session 自 → **squad 手 → squad 自** → global 手 → global 自）。
- **`[P0]consolidation_tier2.md §6/§7`**：Phase 3 前插入「Phase 2.5 · Quality review」段——判据引用 `{{routing_rules}}`（复用 `routing_decision.md` 单一源，防漂移），对每条 `source='agent'` entry 判 3 类质量问题（过程快照 → archive / scope 选错 → 建议调整或 archive / 已被覆盖 → archive 旧的），evolvable=false 依旧 read-only 铁律不动。§7 加 `AppTaskLock` 接入（cron `fire()` + 手动 `POST /consolidation/run` 都过 acquire('tier2_consolidation') 撞车静默跳过；catch 分支必须 markFailed 释放锁）。§9 边界加「不在 tier2 中做 scope 物理迁移」（scope-picked-wrong 只 archive 让 agent 下轮 rewrite）。
- **`index.md ①/④`** 概念表加 squad_memory 行；原则 15：memory scope 3 值 + 6 类注入配额（squad 层夹中间）+ 无 squad 会话拒绝语义。
- **`routing_decision.md`（三处共享单一源）** 加反例清单（进展/状态/成就/情绪/短期不写）+ project type 澄清 + scope 加 squad 规则；memory_manage + skill_manage + tier1/tier2 fork prompt 自动同步生效。
- **debt 备忘**：本版本涉及文件 dev1 基线已 >300 行且 T1 追加最小可行必要：`managed-store.ts` 393 行（T1 +26，parse/serialize export + assert helper export）、`memory-manage.ts` 380 行（T1 +60，squad 分支 write/archive/list/read + notInSquadError + resolveSelfSquadId/Soft helper）。建议后续版本拆分（如把 squad-memory-store 相关 assert 迁到独立 policy 模块）。

详情：`specs/tech/version_logs/v0.0.164.memory_opt/change_log.md` + `change_plan.md`

## 2026-07-15 · v0.0.151.t2_consolidate（二级整理天级落地：consolidation_tier2 [P1]→[P0]）

- **`[P0]consolidation_tier2.md`**（[P1]→[P0] 转正，全篇改写）：新增 app 级天级调度任务（复用 `SchedulerEngine`，`Job.type='consolidation'`，daily cron，boot-time-only 注册）；三段严格串行（全局 skill→全局 memory→各 session memory，session 间也串行）；双重 skip（无新对话/session memory 为空零 LLM 调用）；容量上限（global skill/memory ≤100，session memory ≤30，`source='agent'` 计数，`evolvable` 正交不豁免）；执行载体 = 独立 `agentManager.forkedRun` 调用（synthetic SessionConfig/ContextSnapshot，不走 `buildSessionConfigFromDeps`，天然无 skill 注入）；context 供给 = 预组装注入（session memory 全文+summary，无 disable 开关，无历史读工具）；prompt 4 阶段（Orient/Gather/Consolidate/Prune）独立于 tier1 `consolidation.md`；不新增互斥锁（既有存储层锁+engine per-job inFlight 已足够）；`lastFiredAt` 几乎每次 fire 都推进（与 cron/heartbeat gate-fail-not-advance 的既定偏离，文档化例外）。
- **`index.md ④`** 新增原则 14（tier2 落地一句话）+ ⑤ 导航表 tier2 行状态更新。
- 新增 `../../scheduling/[P1]consolidation_job.md`（调度层：job payload/handler/持久化/boot 装配，详见该 KB log）。
- `[P0]app_config.md §3.16`：新增 `consolidation` group schema。

详情：`specs/tech/version_logs/v0.0.151.t2_consolidate/change_plan.md`

## 2026-07-15 · v0.0.149.memory_opt（entry 加 source/updatedAt + 注入分组配额 + migration）

- **`[P0]memory_definition.md §3`**：entry schema 新增 `source:'user'|'agent'`（user=UI 手动 / agent=memory_manage create；存量=agent）+ `updatedAt:ISO`（组内排序依据，存量按 migration 执行时刻补）；§5.1 注 evolvable 不参与 source 推断。
- **`[P0]memory_injection.md §2/§3`**：memory_user + memory_session 两 mapper 注入加「四类分组（session手动→session自动→全局手动→全局自动）+ 组内 updatedAt 倒序 + 总量上限前 N（默认50）」；两 mapper 经共享纯函数 `selectMemoriesByQuota`（`memory/inject-quota.ts`）协同共享配额，各自仍按本 tier 贡献 fragment（stable/context 不变）。
- **migration**：`migrateMemorySourceUpdatedAt(appConfig, dataDir)`（bootstrap L360 后，对齐 migrateWebSearchProviderId 范式）——两介质（user_memory entries[] + sessions/*/session_memory.md）补缺失 source/updatedAt，marker=per-entry 字段缺失，幂等非破坏。
- **配额源**：`app_config` 新 group `session`（key=default，data={maxSkillInject?,maxMemoryInject?}，缺失回退50）。

详情：`specs/tech/version_logs/v0.0.149.memory_opt/change_plan.md`

## 2026-07-11 · v0.0.114.opts（memory entry `description` → `intro` 全链路改名）

- **一句话摘要字段 `description` → `intro`**（语义不变，消歧 JSON-schema 关键字 `description`）：全链路改名——存储层（`managed-store.ts` frontmatter / `user-memory-service.ts` app_config record entry）、写侧工具 schema（`memory-manage`）、纯读工具（`memory` search 回 name+intro）、L0 注入（`prompt/memory.ts formatL0` 输出 `- name: intro`）、HTTP handler（`handlers/memory.ts` + `memory-helpers.ts`）、前端（`memory-api.ts` + editor-modal/entry-card）+ i18n。
- **兼容读**：所有读侧兜底 `intro ?? description`（`parseEntry` / `readIntro` / `coerceEntryInput` / `mergeEntry` / `memory-manage` write payload），容忍存量 frontmatter/record；**写侧只落 intro**。
- **testid 不改名**：memory editor `-editor-description` / entry card `-entry-{name}-desc` 保留（数据字段改名不牵动 E2E 观测契约）。
- **一次性迁移脚本 `app/server/src/memory/migrate-memory-intro.ts`**（对应 `[P0]memory_definition.md §3` 兼容读）：把存量落盘 `description` 迁到 `intro`——覆盖 session memory（per-session md frontmatter，重序列化 + `.pre-intro.bak` 备份）+ user memory（app_config `user_memory/default` entries[].description→intro）。**非破坏（值经 intro 保留）/ 幂等（已迁则跳过，可重跑）/ 不进 bootstrap（手动 `bun run` CLI）/ 覆盖 test·dev·prod 三环境 dataDir（homedir 展开，禁字面 ~）**。
- 更新 `[P0]memory_definition.md §3/§5/§6`、`[P0]memory_manage_tool.md §2/§3`、`[P0]memory_injection.md §1/§3/§5`、`[P0]memory_tool.md §1/§3`、`index.md ①④⑤`。

详情：`specs/tech/version_logs/v0.0.114.opts/change_log.md`

## 2026-07-10 · v0.0.112（长期记忆增强：按需加载 + evolvable + 300 词硬限 + 路由提示词 + scope 统一）

- **`index.md ④` 原则 4 翻转**：`whole-file 整体注入` → **L0（name+description）注入 + 按需读正文**（progressive disclosure，对齐 skill L0/L1）。新增原则 11（evolvable 治理）+ 12（300 词硬限 + scope 统一命名）。
- **新增 `[P0]memory_tool.md`**：`memory` 纯读工具（read 单条正文 / search 关键词全字段匹配回 name+desc），对称 `skill`；read 与 `memory_manage.read` 共享 `query.readMemoryEntry`；§4 说明 memory 有 L0 仍加 search 的理由（session context tier 被裁 + search 匹配正文）。
- **`[P0]memory_injection.md`**：§1/§3 翻转为 L0 注入（formatL0，session mapper 改 listMetas 不读 body）；§5 budget_truncate 语义弱化注记（保 L0 索引完整，behavior 不变）。
- **`[P0]memory_definition.md`**：entry schema 加 `evolvable`（§3）；§5 file-total soft-warn 退役 → per-entry 300 词硬限（存量豁免）；§5.1 evolvable 治理（agent 受限/UI 全开，存量默认 true——刻意分歧 skill）；scope 对外统一命名注记。
- **`[P0]memory_manage_tool.md`**：§2 scope 对外 global/session + 默认 global（映射表）；§5 300 词硬限；§5.1 evolvable gate（进化性写=更新既有+archive，service 层 enforceEvolvable）；§5.2 路由提示词（单一常量 ROUTING_DECISION_PROMPT 三处同源）；§9 正交约束加 evolvable/300 词。
- **`[P0]consolidation_tier1.md §6`**：fork-2 prompt 模板 + 两步路由规则落地（consolidation.md `{{routing_rules}}` 占位符 ← ROUTING_DECISION_PROMPT）。

详情：`specs/tech/version_logs/v0.0.112.memory/change_log.md` + `change_plan.md`

## 2026-07-06 · v0.0.80.t1（fork-2 sibling 双发 + 纯生产者原则 + tier1 锁接入）

- **`[P0]consolidation_tier1.md` 顶部「实现落点」注记**：补 v0.0.80.t1 触发模式重构段——旧「compact 完成 → post-compact handler 顺序链」退役；fork-2 与 summary 在 tryCompact 胶水内 sibling 双发；handler 内部 acquire `'tier1_consolidation'` 锁。
- **§4 与 compact 的协作**：顺序链图改为 sibling 双发图（tryCompact 谓词 true → deep clone → void runSummarySibling + void runConsolidationSibling 并发派发）；EP 注册仍在 `context_post_compact`，仅调用方式从「compact 成功后串行」改为「tryCompact 胶水直接并发派发」。
- **§5 失败隔离**：补「两 sibling 互不阻塞、各自锁失败各自静默跳过（fire-and-forget）」。
- **§6 待定**：补「fork-2 acquire tier1_consolidation 锁（实接，spec `../session/[P0]session_task_lock.md §6`）」。
- **`index.md` ④ 加第 10 条原则**：compact 时机 sibling 双发 + 纯生产者（不碰消费侧 re-assemble/setSystem/notifyUsageChanged）。
- 触发点迁移到 callLLM 前 + summary 纯生产者原则的详情见 `../context/log.md`（同版本块）。

详情：`specs/tech/version_logs/v0.0.80.t1/change_log.md`

## 2026-07-05 · v0.0.77（memory_manage 工具 sessionId 自动填充）

- **`memory_manage` session scope 的 sid 改由 `ctx.config.sessionId` 自动填充**，input schema 移除 `sessionId` 入参（v0.0.55 引入的入参回退）。
- 起因：v0.0.55 让 agent（LLM）传 sessionId 写 session memory，agent 误传 memberId（长 ULID 混淆），数据写进幽灵目录 `<dataDir>/sessions/<memberId>/`（无 transcript，非真 session），UI 按真实 session 查永远读不到 → "memory 写入成功但 UI 一个也看不到"。
- 修正逻辑：session memory = 调用方自己的 session 记忆，系统通过 `ctx.config.sessionId` 权威知道调用方 session，工具自动取，不交给 LLM 传。UI 端点（`/memory/session?sessionId=`，`15-memory-ui.md`）是另一条路径，仍显式带 sessionId（用户/前端指定查哪个 session）——只约束 agent 工具路径。
- 同期 hotfix（已先 commit 到 dev1）：vite dev proxy 漏配 `/memory` 致 web 端 `/memory/*` 全返 index.html、`req()` 静默把 HTML 当 body、`r.entries ?? []` → 空数组无报错——user + session 两个 scope 都因此 UI 全空。`/skill`/`/squad`/`/mention` 同类漏配的第 4 次。
- 文档：`memory_manage_tool.md` §2（接口去 sessionId）+ §6（新原则「sessionId 自动填充」）；`index.md` ④ 第 9 条新增。

## 2026-07-03 · v0.0.55（memory UI 端点 + 存储架构修正 — UI 路径正交 + 介质分流）

- `[P0]memory_definition.md §2/§5/§6`：**存储架构修正**（user→app_config 唯一介质 / session→per-session md）。user memory 唯一存储 = `app_config` record（group=`user_memory`, key=`default`，存储 + UI tab + 注入 + 工具写全走）；session memory 落 `<dataDir>/sessions/<sid>/session_memory.md`（与 session 生命周期绑定，带 sessionId 维度）。修正 v0.0.51 两 memory 都放 `dataDir/memory/` 且 session 共享的设计。
- `[P0]memory_manage_tool.md §2/§7`：所有 session-scope action 加 `sessionId` 必填参数；user-scope action 不接受 sessionId。并发锁分介质：user = in-process async mutex in `UserMemoryService`；session = per-file lock on per-session path。
- `[P0]memory_manage_tool.md §9`（新增）：UI 端点 vs agent 工具的边界（两条路径正交，仅共享底层存储服务 + 锁机制；user 共享 UserMemoryService / session 共享 ManagedStore per-file lock）。
- `[P0]memory_injection.md §2`：`MemoryUserMapper` 改读 `ctx.appConfig` 经 `UserMemoryService.list()`；`MemorySessionMapper` 改读 per-session（`ctx.config.sessionId` + ManagedStore sessionId 参数化）。PromptCtx 加 `appConfig?: AppConfigService`。
- `[P0]memory_definition.md §4`：封装原则补「UI 走 HTTP 端点」（与 agent 走工具并列）。
- `index.md`：④ 新增第 7 条原则「UI 端点与 agent 工具正交」+ 第 8 条原则「介质分流（存储架构修正）」；第 6 条原则锁机制按介质分流重写。
- API：新建 `specs/api/overall/15-memory-ui.md`（GET/POST/PATCH/DELETE `/memory/:scope`）。
- UI：新建 chat-page `section-memory-panel.md` + `component-memory-entry-card.md`；app-dev-config-page `section-user-memory.md`（user scope）。
- 实现层（task）：`app/server/src/handlers/memory.ts` 新建（user→UserMemoryService / session→ManagedStore+sid 分流）；`memory/user-memory-service.ts` 新建（封装 AppConfigService CRUD + in-process mutex）；`memory/managed-store.ts` 所有 API 加 sessionId 必填 + 路径改 `sessions/<sid>/session_memory.md`；`memory/migrate-v0.0.55.ts` 启动 lazy 把旧 `dataDir/memory/user_memory.md` 迁到 app_config record（重命名 .legacy 标识完成）；`prompt/memory.ts` mapper 改读源；`PromptCtx` 加 `appConfig`；`tools/memory-manage.ts` scope 分流（user→UserMemoryService / session→ManagedStore+sid）。

详情：`specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`

## 2026-07-03 · v0.0.51 实现完成（long term memory — 7 task 全落地）

- `memory_manage` 工具落地（`app/server/src/tools/memory-manage.ts`，4 action 全实现：write upsert / archive 不删 / list metadata / read 全文）。落盘走 managed-store（`app/server/src/memory/managed-store.ts`，per-file 锁串行化 + atomicWrite + soft-warn 容量）。
- 一级整理 fork-2 落地（`app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts`，`memory_skill_consolidation` handler）：fire-and-forget 调 `ctx.consolidationRunner`，allowed tools=`[skill_manage, memory_manage]`，modeKey=`memory_extract`，maxIter=10，复用 session model + CompactCtx + ConsolidationHandler prompt 模板；forked scope 防递归 noop impl 一并落地。
- `memory_user`/`memory_session` system_prompt_mapper impl 落地（`app/plugins/builtins/rocky_context/prompt/memory.ts`）：memory_user priority=450 tier=stable / memory_session priority=350 tier=context；whole-file 注入 + managed-store 受管读取 + archived 跳过 + 空文件不贡献 fragment。
- 验证：UT 4106 passed；AT 6 case PASS（governance + memory_manage write/list_read + skill_manage create/mutable_enforce/patch）；post_compact AT 不可行（compact 黑盒难观测）→ UT 15 覆盖（runner wire + 防递归 + fire-and-forget 异常隔离）。
- 各 detail 文件加「实现落点」注记 + frontmatter `updated`→2026-07-03；index.md 实现状态从「spec 完善，待实现」改为「v0.0.51 已实现」。

详情：`specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md`（§实现完成段）

## 2026-07-03 · v0.0.51 v2（long term memory — fork-2 model resolve + 输入澄清 + 写锁 + session_memory 归档占位）

- `consolidation_tier1.md §3`：补 fork-2 输入澄清——snapshot 已含本次 session 的 memory/skill 工具调用记录，fork-2 据此做本次去重；不额外注入历史已落盘 memory；跨 compact 周期去重交 P1 二级整理。`§6 待定`：移除「fork-2 用什么 model」一项（已 resolve 为复用 session 当前 model，优化留后续版本）。
- `memory_definition.md §7 待定`：补 session_memory 归档/提升策略待 P1 设计（session 结束时是否提炼到 user_memory、何时清空）。
- `memory_manage_tool.md §7`（新增）+ `§8`（原 §7 重编号）：§7.1 注册范围确认（所有 agent）+ §7.2 并发写锁（per-file 文件锁序列化，保证跨 agent 并发写不撕裂 user_memory/session_memory 结构；读+注入不持锁）。
- `index.md`：④ 新增第 6 条原则（写操作原子串行化）。

详情：`specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md`（§v2 修订段）

## 2026-07-02 · v0.0.51（long term memory — consolidation + injection spec 完善）

- `consolidation_tier1.md`：重写 fork-2 契约——移除 MemoryOp/SkillOp 接口，forked agent 直接调 skill_manage/memory_manage 工具落盘。toolsConstraint 从 NO_TOOLS 改为 [skill_manage, memory_manage]。fork-2 通过 post-compact ext point（`context_post_compact`）触发，不直接在 compact 流程里。memory + skill 在一个 forked agent 里（不是两个独立 fork）。forked agent 先判断是否有整理工作，没有就输出。只做 tier 1，tier 2 仍为 P1 占位。
- `memory_injection.md §2`：memory_user/memory_session mapper 从 no-op 占位升级为实际 impl（spec 完善，待实现）。
- `memory_manage_tool.md §4`：时机 A/B 更新引用 skill_manage（不再是 roadmap）。
- `index.md`：实现状态从「前瞻设计，代码未落地」改为「spec 完善，待实现」；③ skills 关系从「skill_ops → skill_manage，roadmap」改为「直接调 skill_manage，v0.0.51 spec 完善」；导航更新。

详情：`specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`；`overview.md` 内容按类拆流并入 index 后归档 `soft_deleted/`。
- 全部 5 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 inline `[vX.Y]` 噪声（`[v0.0.21]` / `[v0.0.18]` 注记）+ 顶部 `> version:` blockquote + 尾部 `## 版本` 段，迁移到 frontmatter `since` 或本 log。
- 订正：`memory_injection.md` §2 mapper impl id 统一为 `memory_user`/`memory_session`（对齐 `../context/[P0]extension point and implementations.md` §3.4 `rocky_context` manifest 的 impl 命名）。

## 2026-06-22 · v0.0.21（skill 移出，memory 板块定形）

- skill 子系统移出到独立 `../skills/`（memory 板块重编号 1-4：定义 / 一级整理 / 二级整理 P1 / native 注入）。
- 新增 `memory_definition.md`：2 scope 文件（user/session）+ frontmatter type（user/feedback/project/reference）+ 容量上限 + 封装原则（v0.1）。
- 新增 `memory_manage_tool.md`：write/archive/list/read + 不审批 + upsert 语义（v0.1）。
- 新增 `consolidation_tier1.md`：compact 时机双 fork（fork-1 summary + fork-2 整理）+ 时机 A 实时（v0.1）。
- 新增 `consolidation_tier2.md`：P1 占位——离线深度整合方向（merge/prune/矛盾解决/容量回收 + skill Curator 状态机 + 安全网）。
- 新增 `memory_injection.md`：native 注入复用 system_prompt mapper（memory_user=stable / memory_session=context）+ whole-file 不检索（v0.1）。
- 注记：fork-2 `skill_ops` → `skill_manage` 属 agent self-evolution roadmap，v0.0.21 不实现（skill 工具纯读）。

详情：`specs/tech/version_logs/v0.0.21/change_log.md`
