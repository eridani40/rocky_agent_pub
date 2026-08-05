# v0.0.247 变更计划书 — memory/skill 存储数量硬上限（补 v0.0.238 注入配额存储侧缺口）

> **method 级 review 合同**。架构期冻结：planner/coder 按本表实现，code-reviewer 按本表查偏离。coder 不改本文件；事后偏差写进 `change_log.md`。
>
> 版本主题：v0.0.238 注入配额只截断 prompt 注入条数、不限磁盘存储；本版补存储侧硬上限。阈值/位置/口径/触发边界见 `reqs/[working] v0.0.247/req.md` 用户拍板。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（memory / skill / handlers-memory / tool-memory / tool-skill） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（class/interface/type/const 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法依赖/对齐的 spec 位置（路径+章节 / 项目原则 / memory 条目） |
| 预计影响行 | +N / -M |

## 核心不变量（贯穿全表，reviewer 优先核对）

1. **只在 create 触发**：`writeLocked` 锁内判 `!existing`（agent writeEntry upsert + UI createEntry 都覆盖）；`update`（existing）路径与 `archiveEntry` 不查配额——否则 archive 自锁。
2. **archived 不计入 / disabled 不计入**：memory 用 `listEntries({includeArchived:false})`；skill 用 `SkillResolver.resolve` filter `enabled===true`（与 L0 catalog 同口径）。
3. **builtin skill 不计**：用户/agent 只能写 app/workspace/group 三层（executeCreate 物理不会进 builtin 层）。
4. **evolvable=false 计入配额**（防绕过），但溢出错误文案如实带「其中 X 条 evolvable=false 无法 archive」。
5. **count + write 原子**：嵌套 dir 级锁（仅 create 分支），顺序固定 entry 锁（外）→ dir 锁（内），无死锁。
6. **fire-and-forget 不变**：`chat() 返回 Promise<void>` 等架构原则不动；本版只加写入拦截。

## 变更清单 — memory 子系统

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory | app/server/src/memory/policy.ts | MemoryQuotaExceededError | 新增 | 存储配额溢出错误类：携 `scope`（'global'\|'session'\|'group'）、`current`、`limit`、`nonEvolvableCount`；message 形态 `memory <scope> quota exceeded (<current>/<limit>); archive X 旧条目腾位`（其中 evolvable=false 占 Y 条时附提示）。同 MemoryCharLimitError 模式 | MUST 继承 Error + 设 name；MUST 携 scope/current/limit/nonEvolvableCount 四字段供上层映射；MUST NOT 在构造期做 IO | policy.ts MemoryCharLimitError 现有模式；req.md「溢出行为」「evolvable=false 张力」 | +35 |
| memory | app/server/src/memory/store-quota.ts | MemoryStoreQuotas | 新增 | 存储配额类型 `{ global:number; group:number; session:number }`（语义清晰，区别于注入配额 MemoryInjectQuotas；值结构同） | MUST NOT 复用 MemoryInjectQuotas（概念解耦：未来拆 key 互不影响） | inject-quota.ts MemoryInjectQuotas 对照 | +5 |
| memory | app/server/src/memory/store-quota.ts | DEFAULT_MEMORY_STORE_QUOTAS | 新增 | 默认值 `{global:50, group:30, session:20}`（与 v0.0.238 注入配额同值同源） | MUST 与 DEFAULT_MEMORY_QUOTAS（memory.ts mapper）同值 | req.md「阈值跟注入配额同值」；memory.ts L45 | +1 |
| memory | app/server/src/memory/store-quota.ts | resolveMemoryStoreQuotas() | 新增 | 读 app_config `session` record 的 `maxMemoryInject`/`maxMemoryInjectGroup`/`maxMemoryInjectSession`（与 mapper resolveMemoryQuotas 同 key 同兜底逻辑），返 MemoryStoreQuotas。appConfig null/字段非 finite → 各层独立回退默认 | MUST 读同组 key（值同源）；MUST 与 mapper resolveMemoryQuotas 同兜底分支；MUST 接收 AppConfigService\|null（caller duck-typed 传） | memory.ts resolveMemoryQuotas L151-175；app_config §3.14 | +28 |
| memory | app/server/src/memory/store-quota.ts | countActiveEntries() | 新增 | `countActiveEntries(dir): number` —— 调 `listEntries(dir,{includeArchived:false}).length`；dir 不存在返 0。只数未 archived 的 active 条目 | MUST 用 listEntries includeArchived:false（含 archived 过滤）；MUST NOT 手写 readdir（复用 store 既有扫描 + 坏文件跳过） | memory-dir-store.ts listEntries L202 | +8 |
| memory | app/server/src/memory/store-quota.ts | checkMemoryStoreQuota() | 新增 | `checkMemoryStoreQuota(dir, scope, quotas, opts?)`：count = countActiveEntries(dir)；超 `quotas[scope]` → throw MemoryQuotaExceededError（带 evolvable=false 计数——opts.evolvableFalseCount 可选，从 listMetas filter 统计）；未超 no-op | MUST 在 caller 持 dir 锁时调用（count 原子性靠 caller）；MUST throw MemoryQuotaExceededError（不返 Result）；evolvable=false 计数列同 listMetas filter evolvable===false && !archived | req.md「溢出行为」「evolvable=false 张力」 | +25 |
| memory | app/server/src/memory/memory-dir-write.ts | writeLocked() | 修改 | 锁内现有逻辑后：若 `!existing`（create 分支，覆盖 createEntry forbidExisting=true + writeEntry upsert 新建两路）→ 嵌套 `withFileLock(quotaLockPath(dir))`（dir 级锁，虚拟 path 作 file-lock Map key）→ count + check + write 全部在 dir 锁内完成。existing 分支（update）不加 dir 锁，原 write 逻辑不变 | MUST 仅 `!existing` 分支查配额（不变量#1）；MUST count+write 同在 dir 锁内（防 race window）；MUST 嵌套顺序固定 entry 锁外/dir 锁内（无死锁）；MUST NOT 在 archiveEntry 路径加配额；dir 锁 key MUST 稳定（`path.resolve(dir,'.quota.lock')`）；MUST 透传 storeOpts（scope+appConfig）由 caller 注入 | file-lock.ts withFileLock L41（按 path.resolve 作 Map key，不需真文件）；req.md「位置 memory writeLocked」 | +28/-3 |
| memory | app/server/src/memory/memory-dir-write.ts | MemoryWriteOpts (扩展) | 修改 | interface 加 `store?: { scope:'global'\|'session'\|'group'; appConfig: AppConfigService\|null }`（可选；未传 = 不查配额，向后兼容存量 caller 如 UT 直接 writeLocked） | MUST 可选（不破坏存量 UT）；MUST 在 writeLocked 仅 create 分支消费 | policy.ts MemoryWriteOpts L64 | +5 |
| memory | app/server/src/memory/memory-dir-write.ts | writeEntry() / createEntry() | 修改 | 签名不变（仍接收 opts）；opts.store 透传给 writeLocked。注释更新：标注 store 字段语义 | MUST NOT 改签名（向后兼容）；store 缺省时不查配额 | memory-dir-write.ts L102/L114 | +4/-2 |
| handlers-memory | app/server/src/handlers/memory.ts | quotaTo400() | 新增 | 字符映射 helper `charLimitTo400` 同模式：`if (e instanceof MemoryQuotaExceededError) return json(400,{error:e.message})`；非该错误重新抛 | MUST 返 400（同 charLimit 模式）；MUST 透传 e.message（含 evolvable=false 提示） | handlers/memory.ts charLimitTo400 L45 | +6 |
| handlers-memory | app/server/src/handlers/memory.ts | handleMemoryCreate() | 修改 | createEntry 调用补 `{defaultEvolvable:false, source:'user', store:{scope, appConfig}}`；catch 链追加 `quotaTo400(e)`（在 charLimitTo400 前/后均可，instanceof 互斥） | MUST 传 store.scope（按 scopeParam 推 global/session）；MUST 从 ctx 或 resolveAppConfig 取 appConfig 注入；MUST NOT 走 500（配额错是 400 用户错误） | handlers/memory.ts handleMemoryCreate L114 | +8/-2 |
| tool-memory | app/server/src/tools/memory-manage.ts | run() write 分支 | 修改 | writeOpts 加 `store:{scope, appConfig}`（scope 已在上下文，appConfig 从 ctx.config.appConfig duck-typed 取）；catch 链追加 `MemoryQuotaExceededError → invalid(err.message)`（同 MemoryCharLimitError 分支） | MUST 传 scope（来自 parseWriteScope）；MUST 从 ctx.config.appConfig 取（duck-typed 同 mapper）；MUST invalid 返回（不返 RUNTIME_ERROR） | memory-manage.ts write 分支 L165-195；memory.ts resolveAppConfig 模式 | +12/-3 |

## 变更清单 — skill 子系统

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| skill | app/server/src/skills/policy.ts | SkillQuotaExceededError | 新增 | skill 存储配额溢出错误类：携 `scope`（'global'\|'session'\|'group' 对外值）、`current`、`limit`、`nonEvolvableCount`；message 形态 `skill <scope> quota exceeded (<current>/<limit>); disable X 旧 skill 腾位`（含 evolvable=false 提示） | MUST 继承 Error + name='SkillQuotaExceededError'；MUST 携四字段 | memory/policy.ts MemoryQuotaExceededError 对照；req.md「溢出行为」 | +30 |
| skill | app/server/src/skills/store-quota.ts | SkillStoreQuotas / DEFAULT_SKILL_STORE_QUOTAS | 新增 | 类型 `{global,group,session}` + 默认 `{50,30,20}`（与 mapper DEFAULT_SKILL_QUOTAS 同值） | MUST 与 skills.ts DEFAULT_SKILL_QUOTAS 同值 | skills.ts L37 | +6 |
| skill | app/server/src/skills/store-quota.ts | resolveSkillStoreQuotas() | 新增 | 读 app_config `maxSkillInject`/`maxSkillInjectGroup`/`maxSkillInjectSession`，返 SkillStoreQuotas。同 resolveSkillStoreQuotas 兜底分支 | MUST 读同组 key；MUST 接收 AppConfigService\|null | skills.ts resolveSkillQuotas L158-182 | +28 |
| skill | app/server/src/skills/store-quota.ts | countActiveSkillsInScope() | 新增 | `countActiveSkillsInScope(scope:'app'\|'workspace'\|'group', dataDir, workspaceDir, groupWsDir, enabledStore)`：调 `SkillResolver.resolve(dataDir, ws, enabledStore, builtinSkillRoot(), groupWsDir)` → filter `e.scope===scope && e.enabled===true` → length。builtin scope 不计（filter 排除） | MUST 用 resolver.resolve（不手扫 dir——保持与 L0 catalog 一致）；MUST filter enabled===true（disabled 不计，对齐 memory archived 语义）；MUST NOT 含 builtin（executeCreate 物理不进 builtin） | resolver.ts resolve L192；req.md「builtin 不计」；开放点见下 | +20 |
| skill | app/server/src/skills/store-quota.ts | checkSkillStoreQuota() | 新增 | count + 比较 + 超限 throw SkillQuotaExceededError（含 evolvable=false 计数：从 filter 后 entries 统计 evolvable===false） | MUST throw（不返 Result）；evolvable=false 计数同口径 | memory/store-quota.ts checkMemoryStoreQuota 对照 | +18 |
| tool-skill | app/server/src/tools/skill-manage-actions.ts | executeCreate() | 修改 | 签名增加 `appConfig: AppConfigService\|null` 末参；在 withFileLock(skillMdPath) 锁内 existsSync 检查后：嵌套 `withFileLock(quotaLockPath(scopeRootDir))` → countActiveSkillsInScope + checkSkillStoreQuota → mkdirSync+atomicWriteSync（write 在 dir 锁内）。try/catch SkillQuotaExceededError → errorResult `[INVALID_INPUT] <msg>` | MUST count+write 同在 dir 锁内；MUST 嵌套顺序固定 entry 锁外/dir 锁内；MUST 把 scope（内部 'app'\|'workspace'\|'group'）映射到对外 'global'\|'session'\|'group' 喂 checkSkillStoreQuota；MUST catch 转 invalid_input（不抛 HTTP——skill 走工具路径）；MUST NOT 在 executePatch 加配额（update 路径） | skill-manage-actions.ts executeCreate L156；toExternalSkillScope L38；file-lock.ts withFileLock | +32/-5 |
| tool-skill | app/server/src/tools/skill-manage.ts | run() case 'create' | 修改 | 调 executeCreate 传 ctx.config.appConfig（duck-typed 取，同 memory 模式）；其余 action 分支不动 | MUST 仅 create 分支传 appConfig；MUST NOT 改其他 action 签名 | skill-manage.ts L113；memory-manage.ts appConfig 取法 | +3/-1 |

## 变更清单 — UT

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory | app/server/src/memory/__tests__/store-quota.test.ts | （新文件） | 新增 | resolveMemoryStoreQuotas 兜底（无 appConfig/字段非 finite/正常值）；countActiveEntries（含 archived 过滤、dir 不存在返 0）；checkMemoryStoreQuota（未超 no-op、超限 throw + 错误字段、evolvable=false 计数文案） | MUST 纯函数 UT（不 IO）；MUST 覆盖 evolvable=false 计数分支 | policy.test.ts 模式；inject-quota.test.ts 模式 | +120 |
| memory | app/server/src/memory/__tests__/memory-dir-write.test.ts | （新文件） | 新增 | writeLocked create 路径超配额被拒；update 路径（writeEntry existing）不触发；archiveEntry 不触发（不自锁）；并发两 create 不同 name（Promise.all）→ 第二个被拒（dir 锁原子性）；evolvable=false 计入 + 文案 | MUST 用真临时 dir + 多文件 fixture；MUST 验并发原子（Promise.all） | memory-dir-store.test.ts 现有模式 | +140 |
| memory | app/server/src/memory/__tests__/policy.test.ts | describe('policy — MemoryQuotaExceededError') | 修改 | 加 MemoryQuotaExceededError 单测：四字段 + message 形态 + evolvable=false 提示 | MUST 加在现有 describe 后 | policy.test.ts MemoryCharLimitError describe 模式 | +25 |
| skill | app/server/src/skills/__tests__/store-quota.test.ts | （新文件） | 新增 | resolveSkillStoreQuotas 兜底；countActiveSkillsInScope（含 disabled 过滤、builtin 排除、scope 过滤）；checkSkillStoreQuota（超限 throw + evolvable=false 计数） | MUST 用真临时 dir + enabledStore fixture | skills/__tests__ 现有模式 | +120 |
| skill | app/server/src/tools/__tests__/skill-manage.test.ts | quota cases | 修改 | executeCreate 超 limit 拒绝；executePatch 不触发；disabled 不计入；evolvable=false 计入 + 文案；并发原子 | MUST 端到端（executeCreate 真调）+ mock appConfig | 现有 skill-manage UT 模式 | +80 |

## 影响面评估

**跨模块**：memory（policy + 新 store-quota + writeLocked + handler + tool）+ skill（policy + 新 store-quota + executeCreate + tool）+ 4 个 UT 文件。**无破坏性 API 变更**：MemoryWriteOpts.store 可选（向后兼容）；executeCreate 加末参（caller 仅 skill-manage.ts 一处已列）；新错误类不影响现有 catch（上层主动 instanceof 才捕获）。

**依赖顺序**：policy.ts 错误类 → store-quota.ts 函数 → writeLocked/executeCreate 改造 → caller（handler/tool）传参 → UT。两子系统完全独立可并行。

**风险点**：
1. **dir 锁 key 命名**：用虚拟路径 `path.resolve(dir, '.quota.lock')`（file-lock.ts Map key，不需真文件）。coder 需确认 withFileLock 对虚拟路径 OK（已核对 file-lock.ts L45 仅 path.resolve 作 key，不需 existsSync）。
2. **count 性能**：每次 create 扫 dir（listEntries / resolver.resolve），50 条规模可接受（写频率低，YAGNI 不缓存）。
3. **嵌套锁顺序**：固定 entry 锁（外）→ dir 锁（内，仅 create 分支），全路径一致 → 无死锁。archiveEntry 走独立 withFileLock(filePath) 不嵌套 dir 锁，与 create 不互锁（archive 不增条目数，count 偏差方向保守拒绝，可接受）。
4. **skill disabled 计数**（开放点 1，见下）。

## 开放点（须报 orchestrator 裁决，coder 不自决）

1. **skill disabled 是否计入配额**：本表定 `disabled 不计入`（对齐 memory archived + L0 catalog enabled filter 口径，需 enabledStore）。备选：`disabled 计入`（简化，仅数 dir，不查 enabledStore）。**architect 倾向不计入**（语义对称 + 与注入侧 catalog 同口径）；如 orchestrator 选"计入"，countActiveSkillsInScope 改为 `scanLayer(scopeRoot).length` 不查 enabledStore，影响行 -5。
2. **MemoryStoreQuotas vs 复用 MemoryInjectQuotas**：本表定新类型（语义清晰，未来拆 key 互不影响）。备选：复用 MemoryInjectQuotas（少 5 行 interface 重复）。**architect 倾向新类型**（概念解耦优先于少几行）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破核心不变量、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- 开放点 1/2 偏离须先报 orchestrator 确认再实现（核心约束不可擅自偏离）
