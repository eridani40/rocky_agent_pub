# v0.0.205.t2_cons 变更计划书 — 整理优化 + 存储模型统一（.rocky 收口 / scope 三层 / memory per-entry）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 权威上游：`states/v0.0.205.t2_cons/context.md`（存储模型定稿）+ `specs/prd/version_logs/v0.0.205.t2_cons/change_log.md`（PRD 4 项定案）。
> 核心设计决策（architect 定）：
> 1. **MemoryScope 全链统一 `'global'|'group'|'session'`**——删 internal(`user|squad|session`)/external 两层映射（`toInternalScope`/`toExternalScope` 死代码删除）；entry frontmatter **不再存 scope**（位置即 scope，读取方按目录 stamp）。
> 2. **memory 三介质统一为 per-entry md 目录存储**（`<ws>/memory/<name>.md` 或 `<ws>/.rocky/memory/<name>.md`），新 `memory-dir-store.ts` 单点实现；旧 `managed-store.ts`/`squad-memory-store.ts`/`user-memory-service.ts` **整文件删除**（锁粒度从单文件多 entry 降为 per-entry 文件锁，替代 UserMemoryService in-process mutex）。
> 3. **group = squad 的共享 ws 根**（`resolveGroupWsDir` 唯一解析点）；`.rocky_squad/` 全量改名 `.rocky/`（state/skills/memory 收口）。（注：原版本含 classroom 作为 group 类型之一，academy 已于 v0.0.208 整体删除，classroom 不再是 group 类型；本文以下 classroom 相关行仅作历史记录。）
> 4. **存量迁移走 MigrationManager 两 handler**（session memory 拆 per-entry + squad `.rocky_squad`→`.rocky`）；**global memory 不迁移**（app_config `user_memory` record 退役不回读 = PRD 定案 4 全删效果）。
> 5. **T1 翻转只改 fork prompt**（`consolidation.md` 加 fork 专属覆盖段），不动共享 `ROUTING_DECISION_PROMPT` 默认 global、不动 `memory_manage.write` 工具默认 scope。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

### 模块 A1 · memory-storage（per-entry dir store 存储核）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory-storage | app/server/src/memory/memory-dir-store.ts | `MemoryScope` type | 新增 | 统一 scope enum `'global'\|'group'\|'session'` 全链唯一命名（替代 managed-store `MemoryScope` + query.ts `InternalScope` + tools/memory.ts 外部映射层） | MUST 工具 schema/HTTP/UI/mapper/inject-quota 同值；MUST NOT 再引入 internal/external 两层映射 | context.md 存储模型定稿；memory index 原则 12 更名 | +6 |
| memory-storage | memory-dir-store.ts | `MemoryEntry` / `MemoryEntryMeta` / `MemoryWriteInput` / `MemoryType` | 新增 | 从 managed-store.ts 迁入类型定义；`MemoryEntry.scope: MemoryScope` 由读取方按目录位置 stamp | frontmatter MUST NOT 落 scope 字段（位置即 scope） | context.md per-entry 模型 | +55 |
| memory-storage | memory-dir-store.ts | `globalMemoryDir(dataDir)` | 新增 | 返 `<dataDir>/memory/`（global 介质根——global ws=数据根本身，资源直接放根不嵌套 `.rocky`） | MUST 仅 join 不 mkdir | context.md 目标存储映射 global 行 | +4 |
| memory-storage | memory-dir-store.ts | `wsMemoryDir(wsDir)` | 新增 | 返 `<wsDir>/.rocky/memory/`（session/squad ws 统一形态，与 `.rocky/skills/` 同构） | 同上 | context.md 映射 | +4 |
| memory-storage | memory-dir-store.ts | `assertEntryName(n)` | 新增 | name 校验：非空 + 无空白控制符 + **无路径分隔符**（name=文件名，旧 managed-store `assertName` 未拦 `/`，per-entry 后必须拦） | MUST 拦 `/`、`\`、`.`、`..`（防逃逸 dir） | 安全原则#5 | +12 |
| memory-storage | memory-dir-store.ts | `parseEntryFile(raw)` / `serializeEntryFile(e)` | 新增 | 单 entry md（frontmatter+body）parse/serialize；兼容读 `intro ?? description`；evolvable 缺省 true；source 缺省 `'agent'`；updatedAt 缺省 `''` | 写侧 MUST 恒显式落 evolvable/source/updatedAt（不走存量默认） | memory_definition §3/§5.1 | +60 |
| memory-storage | memory-dir-store.ts | `listMetas(dir)` | 新增 | 扫 dir 全部 `*.md` 只读 frontmatter（不读 body）→ `MemoryEntryMeta[]`（含 archived 标记） | 目录不存在→`[]`；坏文件 MUST 跳过不抛 | 注入 L0 配额读源（inject-quota） | +25 |
| memory-storage | memory-dir-store.ts | `listEntries(dir, opts)` | 新增 | 同 listMetas 但含 body；`includeArchived` 过滤（默认 false） | 读不持锁 | 对齐旧 listEntries 契约 | +18 |
| memory-storage | memory-dir-store.ts | `readEntry(dir, name)` | 新增 | 读单条全文；未命中抛 Error（message 含 `not found`，query.ts `isNotFoundError` 依赖此锚点）；archived 可读 | 错误文案 MUST 含 `not found` | 对齐旧 readEntry | +15 |
| memory-storage | memory-dir-store.ts | `writeEntry(dir, input, opts)` | 新增 | upsert 单 entry 文件：per-file 锁（`withFileLock` 锁 `<dir>/<name>.md`）内 300 词硬限 + evolvable gate + source/updatedAt 盖戳 + `atomicWriteSync` | MUST mkdir -p dir；MUST NOT 写 frontmatter scope；复用 policy.ts 单点（countWords/WORD_LIMIT/MemoryWordLimitError/MemoryNonEvolvableError/resolvePersistedEvolvable） | memory_definition §5/§5.1；原则 6 | +55 |
| memory-storage | memory-dir-store.ts | `createEntry(dir, input, opts)` | 新增 | 仅新建（name 已存在→抛 `already exists`，承载 UI POST 409 语义）；exists 判定+写同一锁内完成（防 TOCTOU，替代旧 UserMemoryService exists+write 两步） | MUST 锁内 exists 判定 | handlers/memory.ts POST 语义 | +25 |
| memory-storage | memory-dir-store.ts | `archiveEntry(dir, name, opts)` | 新增 | `archived=true` 置标（不删文件）；evolvable gate 锁内原子执行 | 对齐旧 archiveEntry 契约（未命中抛 not found） | +20 |
| memory-storage | app/server/src/memory/managed-store.ts | 整文件 | 删除 | 类型迁 memory-dir-store；`splitEntries/parseEntry/parseMemoryFile/serializeMemoryFile` 迁 `migration/handlers/legacy-memory-format.ts`（frozen）；`assertPerIdName` 迁 group-dir.ts | MUST 全仓 grep 无残留 import（migration 走 legacy-memory-format） | delete-old-code-fully 原则 | -392 |
| memory-storage | app/server/src/memory/squad-memory-store.ts | 整文件 | 删除 | dir store 统一后无独立 squad store（路径 `.rocky_squad/memory.md` 同步废止） | 同上 grep | 同上 | -199 |
| memory-storage | app/server/src/memory/user-memory-service.ts | 整文件 | 删除 | global memory 迁 `<dataDir>/memory/`；app_config `user_memory` record 退役（物理保留不回读 = PRD 定案 4 全删效果）；in-process mutex 由 per-entry 文件锁替代 | MUST NOT 写 global migration；任何路径 MUST NOT 再读 app_config user_memory | PRD 定案 4；context.md findings | -322 |

### 模块 A2 · group-dir（group ws 根唯一解析点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| group-dir | app/server/src/agent/group-dir.ts | `squadWsDir(dataDir, squadId)` | 新增 | 返 `<dataDir>/squads/<squadId>/`；`assertPerIdName` 从 managed-store 迁入本文件（防路径逃逸） | MUST 校验 squadId 无分隔符 | context.md 映射 squad 行 | +12 |
| group-dir | group-dir.ts | `resolveGroupWsDir(dataDir, ref)` | 新增 | `{squadId?}` → squadId → 皆无返 `undefined`（memory/skill/session-config/mapper 四处共享唯一解析点） | session 不会同时属多个 group | context.md scope group 定义 | +14 |

### 模块 A3 · migration（MigrationManager 两 handler，存量有效数据迁移）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| migration | app/server/src/migration/handlers/legacy-memory-format.ts | `splitEntries` / `parseEntry` / `parseMemoryFile` / `serializeMemoryFile` | 新增 | frozen legacy 多 entry 单文件格式 parser（从 managed-store 拷贝，冻结不再演进）；供 2 个旧 handler（memory-source-updated/memory-intro 改 import）+ 2 个新 handler 共用 | MUST 自包含不 import memory/*（managed-store 删除后编译不断） | memory-source-updated.ts 既有「局部复制保持自包含」先例 | +120 |
| migration | app/server/src/migration/handlers/session-memory-per-entry.ts | `sessionMemoryPerEntryMigration` | 新增 | 遍历 sessionStore 全 session：旧 `<dataDir>/sessions/<sid>/session_memory.md` 经 legacy parser 拆 entry → per-entry 写 `wsMemoryDir(session.workspaceDir ?? <dataDir>/workspace)` → 删旧文件；幂等（无旧文件即 skip） | MUST NOT 触碰 app_config user_memory（global 不迁移）；同 ws 两 session 同名冲突=覆盖（一份不阻止） | context.md A.1；runtime-no-ext-policy-write（带版本 marker 只跑一次） | +90 |
| migration | app/server/src/migration/handlers/squad-rocky-dir.ts | `squadRockyDirMigration` | 新增 | 遍历 `<dataDir>/squads/*/`：① `.rocky_squad/memory.md` 拆 per-entry → `.rocky/memory/`；② `.rocky_squad/state/` → `.rocky/state/`；③ `.rocky_squad/skills/` → `.rocky/skills/`；④ 全空后删 `.rocky_squad/`（有残留 warn 保留）；幂等 | squad memory/state/skills 是有效数据 MUST 迁移（区别于 global 全删） | context.md A.1/A.2；findings prod 实测 | +80 |
| migration | app/server/src/migration/handlers/memory-source-updated.ts | import 改向 | 修改 | `../../memory/managed-store` → `./legacy-memory-format`（行为不变） | | | +2/-2 |
| migration | app/server/src/migration/handlers/memory-intro.ts | import 改向 | 修改 | 同上 | | | +2/-2 |
| migration | app/server/src/migration/handlers/index.ts | `handlerRegistry` | 修改 | 注册 `session-memory-per-entry` + `squad-rocky-dir` 两 handler | | | +4 |
| migration | app/server/src/migration/handlers/handlers.yaml | 两条目 | 修改 | 新增两 handler 条目，`versionRange: '<0.0.205'`（本版 release 0.0.205；老版本升级才跑，对齐 v0.0.203 先例 vN 引入用 `<0.0.N`） | | data_model §6 迁移先例 | +8 |

### 模块 A4 · memory-consumers（工具 / UI handler / query / 注入 / tier2）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory-consumers | app/server/src/memory/query.ts | `InternalScope` → `MemoryScope` | 修改 | 删 InternalScope，全文件改用统一 `MemoryScope`；`MemoryQueryDeps` 字段 `sessionId?/squadId?/appConfig?` → `sessionWsDir?/groupWsDir?`（appConfig 删——global 改读 dir）；`readMemoryEntry`/`searchMemory` scope 路由：global→`globalMemoryDir(dataDir)`，session→`wsMemoryDir(sessionWsDir)`，group→`wsMemoryDir(groupWsDir)`；跨 scope 兜底仍只合并 session+global | MUST 保持「跨 scope 不含 group」隔离 invariant（防跨组污染，v0.0.164 用户拍板延续） | context.md scope 三层；PRD 定案 1 隔离 | +36/-42 |
| memory-consumers | app/server/src/tools/memory-manage.ts | `parseScope` / `parseListScope` | 修改 | 对外 scope 集合 `'squad'` → `'group'`；internal 直接同值（删 toInternalScope 调用）；list 'all' = 合并 global+session+group（group 段软取，无 group 静默跳过） | LLM 契约值改 group（与工具描述同步） | context.md scope 三层 | +14/-16 |
| memory-consumers | memory-manage.ts | `resolveSelfGroupWsDir`（替代 `resolveSelfSquadId`/`resolveSquadIdSoft`） | 修改 | 从 `ctx.config.squadId` 经 `resolveGroupWsDir` 取 group ws 根；缺失 → `not_in_group` 错误 | 错误码 `not_in_squad` → `not_in_group`（文案同步，LLM 锚点自修正语义不变） | group 层 | +16/-16 |
| memory-manage.ts | `definition.description` + `inputSchema.scope` | 修改 | scope enum `['global','session','squad','all']` → `['global','session','group','all']`；描述 'squad'→'group'（本 squad 共享）；`not_in_squad`→`not_in_group`；**默认 scope 仍 global 不动** | MUST NOT 改 write 默认 scope（PRD 定案 3 精准路径：工具默认不变，只翻 fork prompt） | PRD 定案 3；context.md T1 | +10/-10 |
| memory-manage.ts | `run` write/archive/list/read 分支 + `probeExistingType` | 修改 | user 分支删 UserMemoryService → dir store（write 用 writeEntry，UI 语义无）；session 分支 `wsMemoryDir(ctx.config.workdir)`（删 dataDir+sid 寻址；workdir 缺失→RUNTIME_ERROR）；group 分支 `wsMemoryDir(resolveSelfGroupWsDir(ctx))`；probeExistingType 三分支同改 dir store listMetas | session 依赖从 sessionId 改 workdir（SessionConfig.workdir 已注入） | per-entry 模型 | +52/-58 |
| memory-consumers | app/server/src/tools/memory.ts | `toInternalScope` / `toExternalScope` / `MemoryScopeExternal` / `withExternalScope` | 删除 | 命名统一后内外同值，映射层成死代码（memory-manage.ts import 同步删） | MUST 全仓 grep 无残留 import | delete-old-code-fully | -40 |
| memory.ts | `run` read/search + `resolveAppConfig` | 修改 | deps 组装改 `sessionWsDir=ctx.config.workdir`、`groupWsDir=resolveGroupWsDir(dataDir,{squadId})`；scope 直通（'group'）；删 resolveAppConfig（global 不再走 appConfig） | | | +20/-26 |
| memory-consumers | app/server/src/handlers/memory.ts | `handleMemoryRoute` | 修改 | 签名加 `sessionStore` 参数（session scope 需 `getSession(sid).workspaceDir` 解析 ws dir；session not found→404；workspaceDir 缺省回退 `<dataDir>/workspace`）；misc-routes 调用点传 `bs.store` | UI 契约不变（GET/POST/PATCH/DELETE 语义逐条保持：POST 409 / PATCH merge / DELETE archive） | session ws 模型；15-memory-ui §3-6 | +28/-8 |
| memory.ts | `handleMemoryList/Create/Update/Delete` | 修改 | user 分支 UserMemoryService → dir store（Create 用 `createEntry` 保 409 语义；exists 预检删——createEntry 锁内判定）；session 分支 dir store + ws dir 解析 | | | +42/-48 |
| memory-consumers | app/server/src/handlers/memory-helpers.ts | `parseScope` | 修改 | 返回 `'global'\|'session'` 直通（UI 边界本版不暴露 group tab） | UI 仍两值，不加 group（PRD IN/OUT 边界） | PRD §4 IN/OUT | +4/-6 |
| memory-consumers | app/server/src/routes/misc-routes.ts | `/memory/*` 分支 | 修改 | `handleMemoryRoute(..., bs.appConfig, bs.store)`（补 sessionStore 实参） | bs.store 已装配 | | +2/-1 |
| memory-consumers | app/server/src/memory/inject-quota.ts | `MemoryScope` / `MemoryGroup` / `deriveGroup` / `GROUP_ORDER` / `selectMemoriesByQuota` | 修改 | scope `'user'→'global'`、`'squad'→'group'`；GROUP_ORDER keys 改 `session-manual/session-agent/group-manual/group-agent/global-manual/global-agent`；`selectMemoriesByQuota(userEntries, sessionEntries, squadEntries, maxN)` → `(globalEntries, sessionEntries, groupEntries, maxN)`，返回 `{global, session, group}` | 分组顺序语义不变（session→group→global，各手/自）；组内 updatedAt 倒序不变 | memory index 原则 13/15 | +22/-22 |
| memory-consumers | app/plugins/builtins/rocky_context/prompt/memory.ts | `readMemorySources` | 修改 | 三源改 dir store：global=`listMetas(globalMemoryDir(dataDir))`（删 UserMemoryService + appConfig 依赖）；session=`listMetas(wsMemoryDir(ctx.config.workdir))`（workdir 缺→空源）；group=`listMetas(wsMemoryDir(resolveGroupWsDir(dataDir,{squadId: ctx.config.squadId})))`（皆缺→空源） | 任一源缺依赖→该源空，不阻塞其他源（既有降级语义不变） | group 层；inject §2 | +32/-32 |
| memory.ts | `MemoryGroupMapper`（原 `MemorySquadMapper`） | 修改 | fragment id `'memory_squad'`→`'memory_group'`；tier=stable / priority=400 不变 | impl id 与 plugin.json/scope yaml 同步改（ScopeConfigValidator 硬校验） | scope group 改名 | +8/-8 |
| memory.ts | `MemoryUserMapper` / `MemorySessionMapper` | 修改 | 读源改 dir store（tier/priority 不变：450 stable / 350 context） | L0 注入契约不变（name+intro 列表） | memory_injection §2 | +12/-14 |
| memory-consumers | app/plugins/builtins/rocky_context/prompt/memory-squad.ts → memory-group.ts | 删除+新增 | re-export 文件改名（manifest 一 impl 一 default 约定） | | | +2/-2 |
| memory-consumers | app/plugins/builtins/rocky_context/plugin.json | `memory_squad` impl 条目 | 修改 | implId `memory_squad`→`memory_group`；impl 路径 `./prompt/memory-group.ts`；description MSG key 改 `impl.memory_group.description` | | | +3/-3 |
| memory-consumers | app/plugins/scopes/default.yaml | system_prompt_mapper impls | 修改 | `memory_squad` → `memory_group`（L94） | MUST 与 plugin.json implId 一致 | | +1/-1 |
| memory-consumers | app/web/src/i18n/locales/zh-CN/plugin-config.json + en/plugin-config.json | MSG key | 修改 | `impl.memory_squad.description` → `impl.memory_group.description`（两语言同步） | i18n-key-add-checklist：两语言 + t() 占位渲染链路核实 | | +2/-2 |
| memory-consumers | app/server/src/agent/consolidation-tier2/global-memory.ts | `consolidateGlobalMemory` | 修改 | `new UserMemoryService(deps.appConfig).list()` → `listEntries(globalMemoryDir(deps.dataDir), {includeArchived:true})` | deps 形状不动（appConfig 字段保留，本函数不再消费） | tier2 §5.3 | +8/-8 |
| memory-consumers | app/server/src/agent/consolidation-tier2/session-memory.ts | `consolidateSessionMemory` | 修改 | `listEntries(deps.dataDir, session.id)` ×2 → `listEntries(wsMemoryDir(session.workspaceDir ?? join(deps.dataDir,'workspace')))` ×2；Skip B 判定同源改 | session record 自带 workspaceDir（sessionStore.listSessions 提供）；fallback 与 session-config 同规则 | tier2 §3/§4 | +10/-8 |
| memory-consumers | app/server/src/prompts/content/routing_decision.md | Step 2 文案 | 修改 | `squad → squad (this squad only...)` → `group → group（本 squad 团队共享；不污染 global 或其他 group）`；**默认 global 不变** | MUST NOT 改默认（共享常量，其他 agent 路径共读）；MUST 与 memory_manage/skill_manage 描述同步措辞 | context.md T1 精准路径 | +4/-4 |

### 模块 A5 · rocky-consolidation（`.rocky_squad/` → `.rocky/` 收口）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| rocky-consolidation | app/server/src/stores/squad-store.ts | `ensureSquadDirSkeleton` | 修改 | 预建目录 `'.rocky_squad/state'` → `'.rocky/state'`；骨架目录列表 `'.rocky_squad'` → `'.rocky'`（L179/L243 两处） | 存量 squad 由 migration handler 平移（A3），本处只管新建 | context.md A.2 | +3/-3 |
| rocky-consolidation | app/server/src/squad/scheduler/scheduler-state.ts | 路径 getter（scheduler.json） | 修改 | `join(root,'squads',squadId,'.rocky_squad','state',...)` → `'.rocky','state',...` | | | +2/-2 |
| rocky-consolidation | app/server/src/squad/scheduler/scheduler-history.ts | 路径 getter + ensureDir（history.jsonl） | 修改 | 同上 ×2 处（L53/L73） | | | +3/-3 |
| rocky-consolidation | app/server/src/squad/budget-state.ts | 路径 getter（budget-state.json） | 修改 | 同上（L42） | | | +2/-2 |
| rocky-consolidation | app/server/src/squad/filewatch/squad-file-watcher.ts | `IGNORED_DIR_NAMES` | 修改 | `'.rocky_squad'` → `'.rocky'`（chokidar 忽略集，L39） | chokidar4-ignored-no-glob：Set 精确名匹配，无 glob | memory chokidar4-ignored-no-glob | +1/-1 |
| rocky-consolidation | app/server/src/squad/filewatch/path-router.ts | 注释同步 | 修改 | 注释 `.rocky_squad` → `.rocky`（行为不变，ignore 已由 watcher Set 承载） | | | +1/-1 |
| rocky-consolidation | app/server/src/services/squad-service.ts | 骨架注释同步 | 修改 | 目录骨架注释 `.rocky_squad/state` → `.rocky/state` | | | +1/-1 |

### 模块 A6 · skill-group（resolver group 层 + GET /skill sessionId 参数）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| skill-group | app/server/src/skills/types.ts | `SkillScope` | 修改 | `'builtin'\|'app'\|'workspace'\|'squad'` → `'builtin'\|'app'\|'workspace'\|'group'` | 全链同步（resolver/handler/session-config/前端类型/UT） | context.md scope 三层 | +2/-2 |
| skill-group | app/server/src/skills/resolver.ts | `resolve` / `resolveAll` / `lookup` | 修改 | 参数 `squadDir?` → `groupDir?`（语义=group ws 根）；扫描路径 `join(squadDir,'.rocky_squad','skills')` → `join(groupDir,'.rocky','skills')`；命中 entry.scope=`'group'` | 合并优先级不变（group > workspace > app > builtin）；groupDir 省略=三层行为不变 | skill_architecture §4 | +14/-14 |
| skill-group | resolver.ts | `squadSkillRoot` → `groupSkillRoot` | 修改 | helper 改名 + 签名改 `(groupWsDir)`（直接 join `'.rocky','skills'`；不再接 dataDir+squadId——调用方先经 `resolveGroupWsDir` 取 ws 根） | export 供测试/未来扩展；全仓 grep 旧名无残留 | | +6/-6 |
| skill-group | app/server/src/handlers/session-config.ts | groupDir 派生（`buildSessionConfigFromDeps` 内 L240 段） | 修改 | `isStudio && studioContext.squadId ? join(dataDir,'squads',squadId) : undefined` → `resolveGroupWsDir(deps.dataDir, {squadId: studioContext?.squadId})`，传 resolver `groupDir` | playground/subagent 仍 undefined | group 层；skill_arch §6.3 | +12/-6 |
| skill-group | session-config.ts | `keepStudioSkill` | 修改 | 恒保留分支 `entry.scope === 'workspace'` → `entry.scope === 'workspace' \|\| entry.scope === 'group'`（group 层=团队共享约定，同 R2 不受 member overlay 影响） | 行为对齐 R2 意图（squad 层本就应恒保留，旧实现漏判落 inherit 分支） | session_config_studio §3.2 | +2/-1 |
| skill-group | app/server/src/handlers/skill.ts | `handleSkillRoute` | 修改 | 签名加 `sessionStore` 参数；misc-routes 调用点传 `bs.store` | | | +6/-2 |
| skill-group | skill.ts | `handleList` | 修改 | 加 query `?sessionId=<sid>`：`sessionStore.getSession(sid)` → workspace=`session.workspaceDir`、groupDir=`resolveGroupWsDir({squadId: session.squadId})` → `SkillResolver.resolve(..., groupDir)`；与既有 `?workspace=` 并存（sessionId 优先） | session not found→404；响应 `SkillEntry.scope` 值域含 `'group'`；workspace 缺省回退 `<dataDir>/workspace` | PRD 定案 1 数据源；api 06 §3 | +32/-4 |

### 模块 A7 · session-ws-copy（session ws 可变复制 `.rocky/`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session-ws-copy | app/server/src/handlers/session-update.ts | `handleSessionUpdate` | 修改 | `switchDir`/`setWorkspaceDir` 成功后：`<oldWs>/.rocky/` → `<newWs>/.rocky/` 递归复制（`fs.cpSync(src, dest, {recursive:true, force:false, errorOnExist:false})`）；oldWs 无 `.rocky` → skip；复制异常 try/catch warn 不阻塞 PUT | MUST best-effort（复制失败不 500）；MUST `force:false` 不覆盖新 ws 既有 `.rocky` 内容（2 session 挤同一 ws=一份不阻止，新 ws 既有文件胜出） | context.md A.5 | +18/-2 |

### 模块 B1 · consolidation-status（T2 状态修复，PRD 定案 2）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| consolidation-status | app/server/src/agent/app-task-lock.ts | `acquire` | 修改 | CAS 前超时接管检查：`cur.status==='running' && cur.startedAt && (Date.now() - Date.parse(startedAt)) > STALE_RUNNING_MS(3_600_000)` → 视为可获取（覆盖写新 running + emit，等价 release+re-acquire 原子一步） | MUST 内存 only 不落盘（重启天然释放已满足，仅同进程 hang 需接管）；超时常量单点 `STALE_RUNNING_MS = 3_600_000` | context.md T2 findings；PRD 定案 2；req 第 1 块 | +16/-2 |
| consolidation-status | app/server/src/handlers/consolidation-status.ts | `handleConsolidationStatus` | 修改 | 签名加 `appTaskLock: AppTaskLock`；响应 = `{...lastResult, status, startedAt}`：lock running→`'running'`；failed→`'failed'`；else `'idle'`（done 归 idle，完成态由 lastResult.lastRunAt 承载）；`startedAt` = lock state.startedAt ?? null | PRD 契约 3 值 `'running'\|'idle'\|'failed'`；读失败仍 500 语义不变 | PRD 定案 2；api 03 §2.7 | +18/-4 |
| consolidation-status | app/server/src/routes/misc-routes.ts | `/consolidation/status` 分支 | 修改 | `handleConsolidationStatus(bs.consolidationAdapter, bs.appTaskLock)` | bs.appTaskLock 已装配（bootstrap.ts:119） | | +2/-1 |

### 模块 B2 · t1-flip（T1 默认 scope 翻转，PRD 定案 3 —— 精准路径）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| t1-flip | app/server/src/prompts/content/consolidation.md | `{{routing_rules}}` 后追加 fork 专属覆盖段 | 修改 | 占位符渲染段之后加一段：「For this consolidation pass, the Step-2 default is flipped: default to **session**; choose **global** only when clearly useful across unrelated projects/sessions; choose **group** only when clearly a squad team rule.」 | MUST NOT 改 `ROUTING_DECISION_PROMPT` 共享常量（memory_manage/skill_manage 描述保持默认 global）；MUST NOT 改 `memory_manage.write` 工具默认 scope（仍 global）；UI 手动新建默认 global 不变 | context.md T1 精准路径；PRD 定案 3 | +6 |

### 模块 B3 · frontend（skills 入口 UI + T2 前端 onInit 修复）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| frontend | app/web/src/components/app-dev-config-page/section-consolidation-config.tsx | `ConsolidationStatus` + `fetchStatus` + `onInit` | 修改 | interface 加 `status: 'running'\|'idle'\|'failed'` + `startedAt: string\|null`；onInit 初始 ctx `isRunning: status.status === 'running'`（不再写死 false） | SSE 驱动迁移逻辑不变（onEvent 不动） | PRD UC-C2；section-consolidation-config.md | +8/-2 |
| frontend | app/web/src/components/chat-page/component-chat-float-menu.tsx | `ComponentChatFloatMenu` | 修改 | 加第 3 菜单项 skills（长期记忆/定时任务**下方**；open 联合加 `'skills'`）+ 恒挂载 `useSkillsCatalog(sessionId)` + 挂 `ComponentSkillsModal`；badge 不挂（skills 无计数需求） | 三处 chat 页复用零改动（props 不变）；数据 hook 恒挂载不随弹层开关 mount/unmount | PRD 定案 1；component-chat-float-menu.md §7 | +28/-3 |
| frontend | app/web/src/components/chat-page/component-skills-modal.tsx | `ComponentSkillsModal` | 新增 | 3 tab（session/group/global，默认 session）+ 卡片列表（渐变星形 logo 38×38 + name + desc 两行省略 + 来源徽标，**只展示无开关**）+ 空态（icon 圆 + muted 文案）+ 遮罩/关闭按钮 | 视觉 token 复用 component-skill-item；MUST NOT 挂 enabled/evolvable toggle/删除/预览；group tab playground 空态 | PRD UC-S1~S7；component-skill-item.md 视觉基线 | +150 |
| frontend | app/web/src/components/chat-page/use-skills-catalog.ts | `useSkillsCatalog` | 新增 | useLifecycle Collection 形：onInit GET `/skill?sessionId=<sid>` → 按 scope 分三组（session=`workspace` / group=`group` / global=`builtin`+`app`，global 组只留 enabled=true=当前会话实际生效）；GET-once 无 SSE；deps=[sessionId] | 对齐 component_architecture §3.10 四方法契约 + lifecycle_data_shapes Collection 形 | PRD 定案 1 数据源；[P0]component_data_map.md | +65 |
| frontend | app/web/src/lib/api-client.ts | `listSkillsBySession(sessionId)` | 新增 | GET `/skill?sessionId=<sid>` → `SkillEntry[]`（与既有 `listSkills` 并列，不改旧函数） | | | +10 |
| frontend | app/web/src/i18n/locales/zh-CN/chat.json + en/chat.json | `floatMenu.skills` + `skillsModal.*` | 修改 | 新 key 两语言同步（菜单 aria-label + tab 名 + 空态文案） | i18n-key-add-checklist：两语言 + t() 占位渲染 | | +14 |

### 模块 C · specs（architect 产出/更新；组件 spec 由 coder 编码前置产出）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| specs | specs/api/overall/03-config-center.md | §2.7 | 修改 | `GET /consolidation/status` 响应加 `status: 'running'\|'idle'\|'failed'` + `startedAt: string\|null`；版本头 1.11.0→1.12.0 注记 | | PRD 定案 2 | +12 |
| specs | specs/api/overall/06-skill.md | §3 | 修改 | `GET /skill` 加 query `?sessionId=`（与 `?workspace=` 并存，sessionId 优先）；`SkillEntry.scope` 值域加 `'group'`（替代 `'squad'`）；版本注记 | | PRD 定案 1；A6 | +14 |
| specs | specs/api/version_logs/v0.0.205.t2_cons/change_log.md | 新增 | API 域版本变更日志（status 字段 + /skill sessionId 参数 + scope 值域 group） | | | +40 |
| specs | specs/ui/components/chat-page/component-skills-modal.md | 新增 | 组件 spec（coder 编码前置产出：定位/Props/3 tab/卡片视觉基线/空态/复用关系） | coder 先 spec 后实现（_conventions.md） | PRD 定案 1 | +90 |
| specs | specs/ui/components/chat-page/component-chat-float-menu.md | 修改 | 菜单项清单加 skills 第 3 项 + 弹层组合关系 + useSkillsCatalog 恒挂载 | coder 编码前置更新 | | +12 |

## 影响面评估

**跨模块**：memory 存储核（A1）→ 消费方（A4）是原子重构（删旧 store 与改全部 consumer 必须同 task 完成，否则编译断）；migration（A3）依赖 A1 的 dir store + wsMemoryDir；A5/A6/A7 相互独立但与 A1 共享 `group-dir.ts`（A2）。B1/B2 与 A 块零文件交集（misc-routes.ts 例外，方法级分工：A4 改 `/memory/*` 行、A6 改 `/skill/*` 行、B1 改 `/consolidation/status` 行，coversMethods 不重叠）。

**破坏性变更**：
1. `memory_manage` 工具 scope 枚举值 `squad`→`group`（LLM 面契约变更；存量 AT case 若断言 squad 值需同步——memory `field-rename-breaks-at-fixtures-uts-miss-it`，coder 须 grep tests/api 同步）。
2. `GET /skill` 响应 `SkillEntry.scope` 值域 `'squad'`→`'group'`（前端 skill-page 若按 scope 过滤需同步核实；coder grep 前端 `scope === 'squad'`）。
3. global memory 介质切换（app_config record 不再回读）——PRD 定案 4 用户已确认全删。
4. memory entry frontmatter 不再落 `scope` 字段（迁移重写后无此字段；读侧 stamp）。

**依赖顺序**：A1+A2（存储核 + group-dir）→ A3（migration）→ A4（consumers）→ A5/A6/A7（可与 A4 同 task 顺序做）；B1/B2 完全独立；B3 前端依赖 A6（/skill sessionId 参数）+ B1（status 字段）。

**UT 影响面（coder 同步，不占本表行）**：`app/server/src/memory/__tests__/`（managed-store/user-memory-service/squad-memory-store/inject-quota UT 全量重写为 dir store + 新命名）、`handlers/__tests__/memory.test.ts`（app_config record 断言改 dir store 断言）、`prompts/__tests__/routing-decision.test.ts`（group 措辞断言）、plugin `prompt/__tests__/memory-quota-squad.test.ts`（改 memory_group）、`skills/__tests__/`（resolver groupDir）、`stores/__tests__/squad-store`、scheduler/budget state 路径断言、`consolidation-status.test.ts`（新字段）、`app-task-lock.test.ts`（超时接管）、migration handlers 既有 UT（import 改向）。**全量 `bun run test` 自检 MANDATORY**（memory `coder-shared-structure-selfcheck-fulltest`：改共享结构必须全量，非只新文件）。

**打包护栏（MANDATORY 自检）**：
- 本版无新第三方依赖（`fs.cpSync` 是 node 内置）——deps 护栏 N/A。
- `consolidation.md` 改动进 asar（builtin prompt 资源，既有打包链路覆盖，无新资源类型）——plugin 资源护栏 N/A（build-plugins copyResources 已含 prompts/content）。
- 无新 runtime env 键——runtime-config 护栏 N/A。
- **路径护栏**：migration handler 与 store 全部经 `dataDir` 入参拼接（`resolveDataDir` 单一展开权威），无相对路径/字面 `~`；`session-update.ts` 复制 `.rocky` 用 session record 的绝对 workspaceDir。packaged 验证点：升级安装后 squad `.rocky_squad`→`.rocky` migration 在真实 dataDir 跑通（state/memory/skills 平移）+ global memory 空态 + memory_manage session scope 落 `<ws>/.rocky/memory/`。

**风险点**：
1. **migration 顺序**：`squad-rocky-dir` 必须先于任何读 squad state/memory 的运行路径完成——MigrationManager 在 bootstrap store-phase 前跑（既有位置 bootstrap.ts:285），天然满足。
2. **session memory 迁移与 fallback ws**：多 session 共享 `<dataDir>/workspace` fallback 时 per-entry 合并=一份不阻止（context.md 定稿接受）；同名覆盖按 migration 遍历序后者胜。
3. **keepStudioSkill 行为修正**（group 层恒保留）改变 member overlay 对 squad skills 的既有表现——对齐 R2 设计意图，属 bug 级修正非回归。
4. **academy-coach yaml memory_group**：原版本给 academy-coach yaml 加 group memory 注入段；academy 已于 v0.0.208 整体删除，此条仅作历史记录。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- spec↔code 偏离（coder 按代码实际调整）→ coder 汇报 orchestrator 记 doc-sync 待办，doc-modifier 阶段 5 统一修 spec
