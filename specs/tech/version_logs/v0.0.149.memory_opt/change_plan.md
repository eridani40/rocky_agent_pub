# v0.0.149.memory_opt 变更计划书 — 限制 skill/memory 注入数量 + 会话 config tab

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/version_logs/v0.0.149.memory_opt/change_log.md`（4 需求 + 5 路径，产品决策已确认）。
> 行 = 一个函数/符号；列 = 模块 / 文件 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 影响行。

## 0. 架构师技术决策（A/B/C/D — PRD 留给 architect 的开放点）

### A. memory 两 mapper 协同共享配额（四类全局 selection）

**结论**：新增纯函数 `selectMemoriesByQuota(userEntries, sessionEntries, maxN)`（`app/server/src/memory/inject-quota.ts`）。`MemoryUserMapper` 与 `MemorySessionMapper` 各自从 `ctx` 读**两源**（user 经 `UserMemoryService.list`、session 经 `listMetas`，两 mapper 都读两源——metadata 级无 body，开销小），调用同一纯函数得同一划分 `{ user, session }`，各自只输出本 scope 的切片为本 tier 的 fragment（memory_user 仍 stable、memory_session 仍 context）。

**为何不破坏 tier 语义**：selection 是纯函数无共享可变态；两 mapper 仍各自贡献自己的 fragment、tier 不变（reducer/builder 无感知）。同一输入 → 同一输出 → 无分歧。四类顺序（session手动→session自动→全局手动→全局自动）+ 组内 updatedAt 倒序 + 总量取前 N 全在纯函数内闭环。

### B. 时间字段决策（skill / memory 的 updatedAt）

- **memory**：`updatedAt` 为 **entry 级字段**（两介质多 entry 共享一个 record/md，无 per-entry mtime）。新增 `source: 'user'|'agent'` + `updatedAt: string(ISO)` 到 entry schema。**migration 统一补 `updatedAt = new Date().toISOString()`**（无 per-entry 创建时间存在，PRD 允许用 migration 执行时刻）；写侧（write/create/update）刷新 `updatedAt = now`。
- **skill**：新增 frontmatter `updatedAt: string(ISO)` + `SkillEntry.updatedAt?`。`skill_manage` create/patch + UI governance PATCH 刷新 `updatedAt = now`；builtin skill 在源 frontmatter 内带固定 `updatedAt`（随发版）。缺 updatedAt（legacy）→ 排序按 epoch 0（组内最末），组内 tiebreak name 升序保确定。**无 skill migration**（文件型；缺失仅排末，下次编辑自动盖戳）。

### C. 注入截断落点（不新增 reducer，用户决策）

- skills mapper 内：读 `appConfig.get('session','default')?.maxSkillInject ?? 50`（经既有 `resolveAppConfig(ctx)`），按派生分组（见下）+ 组内 updatedAt 倒序，跨组按优先级连续取前 N。
- memory 两 mapper 内：读 `appConfig.get('session','default')?.maxMemoryInject ?? 50`，交纯函数 `selectMemoriesByQuota`。
- **skill 是 stable tier，数量变会破 prompt cache**（预期内，本版本目的就是控量；记一笔，不额外缓存）。
- 不新增 PromptCtx 字段、不新增 reducer：配额读 appConfig，截断在 mapper/纯函数内。

### D. migration 实现（对齐 migrateWebSearchProviderId 范式）

新增 `migrateMemorySourceUpdatedAt(appConfig, dataDir): Promise<void>`（`app/server/src/memory/migrate-memory-source-updated.ts`）。marker = per-entry 字段缺失：`source` 缺 → 补 `'agent'`（PRD：存量=agent）；`updatedAt` 缺 → 补 `now`（ISO）。两介质：(1) `appConfig.get('user_memory','default').entries[]` 回写；(2) 遍历 `dataDir/sessions/*/session_memory.md`（parseMemoryFile → 补 → serializeMemoryFile → atomicWriteSync，仅当有字段变更才写）。调用点：`bootstrap.ts` L360 `migrateWebSearchProviderId` 之后。catch warn 不 throw（不阻塞 bootstrap）。幂等：二次运行所有 entry 已有两字段 → no-op。

## 1. 变更清单（method 级 — 行 = 函数/符号）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory_data | app/server/src/memory/managed-store.ts | MemoryEntryMeta | 修改 | 加 `source:'user'\|'agent'` + `updatedAt:string` 两字段 | MUST 同步 parseEntry/listMetas 产出；存量缺省 source='agent' | memory_definition §3；PRD 需求3 | +4 |
| memory_data | app/server/src/memory/managed-store.ts | MemoryEntry | 修改 | 同上（继承 Meta，无额外字段，body/why/how 不变） | — | memory_definition §3 | +0 |
| memory_data | app/server/src/memory/managed-store.ts | parseEntry() | 修改 | frontmatter 读 `source`（缺→'agent'）+ `updatedAt`（缺→''）；写入返回 entry | MUST 存量 source 缺省 agent（非 user） | memory_definition §3；PRD §3 | +6 |
| memory_data | app/server/src/memory/managed-store.ts | serializeEntry() | 修改 | 始终显式写 `source`+`updatedAt` 到 frontmatter（避免下次走存量默认） | MUST 写侧不落空 | memory_definition §3 | +3 |
| memory_data | app/server/src/memory/managed-store.ts | listMetas() | 修改 | 返回值带 source/updatedAt（透传 parseEntry） | — | memory_injection §2 | +2 |
| memory_data | app/server/src/memory/managed-store.ts | writeEntry() | 修改 | opts 增 `source`；create 盖 source、update 保留既有 source；始终刷新 `updatedAt=now` | MUST NOT 改已存在 entry 的 source（origin 不可变）；300 词硬限+evolvable gate 不动 | memory_definition §5/§5.1；memory_manage_tool §6 | +8 |
| memory_data | app/server/src/memory/user-memory-service.ts | UserMemoryEntry | 修改 | 加 `source` + `updatedAt` | — | memory_definition §3 | +3 |
| memory_data | app/server/src/memory/user-memory-service.ts | UserMemoryRecord.entries 形状 | 修改 | record entries[] 元素加可选 source?/updatedAt?（读侧兼容） | — | app_config §3.5 | +2 |
| memory_data | app/server/src/memory/user-memory-service.ts | list()/read() | 修改 | 返回值带 source/updatedAt（存量缺省 source='agent'） | — | — | +6 |
| memory_data | app/server/src/memory/user-memory-service.ts | write() | 修改 | opts 增 `source`；create 盖、update 保留；刷新 updatedAt=now（mutex 内） | MUST NOT 改既有 source；enforceEvolvable/defaultEvolvable 不动 | memory_definition §5.1 | +8 |
| memory_data | app/server/src/memory/policy.ts | MemoryWriteOpts | 修改 | 加可选 `source?: 'user'\|'agent'`（与 evolvable 解耦，同一 opts 载体） | MUST NOT 删既有 evolvable 字段 | memory_definition §5.1 | +2 |
| memory_tool | app/server/src/tools/memory-manage.ts | write 分支 | 修改 | writeOpts 增 `source:'agent'`（agent 路径 origin=agent） | MUST agent write 一律 source=agent | memory_definition §3；PRD §3 | +2 |
| memory_http | app/server/src/handlers/memory.ts | handleMemoryCreate (POST) | 修改 | UI 新建传 `source:'user'`（userSvc.write/writeEntry opts） | MUST UI POST origin=user | PRD §3 | +2 |
| memory_http | app/server/src/handlers/memory.ts | handleMemoryUpdate (PATCH) | 修改 | UI 更新不传 source（保留既有 origin）；service 内刷新 updatedAt | MUST NOT PATCH 改 source | — | +1 |
| memory_inject | app/server/src/memory/inject-quota.ts | selectMemoriesByQuota() | 新增 | 纯函数：入(userEntries, sessionEntries, maxN) → `{user, session}`；按四类(session手动→session自动→全局手动→全局自动) + 组内 updatedAt 倒序 + 跨类取前 N 后按 scope 拆分；输出各组保持 selection 顺序 | MUST 纯函数无副作用；MUST maxN<=0 → 两 slice 均 []；tier 不在此函数关心 | PRD 需求2；memory_injection §2/§3 | +45 |
| memory_inject | app/plugins/builtins/rocky_context/prompt/memory.ts | MemoryUserMapper.map() | 修改 | 读两源（appConfig+dataDir/sessionId）；调 selectMemoriesByQuota(.,., maxMemoryInject)；formatL0 输出 user 切片（stable tier 不变） | MUST 两源都读以保两 mapper 同输入；空切片→不贡献 fragment | 决策 A；memory_injection §2 | +12 |
| memory_inject | app/plugins/builtins/rocky_context/prompt/memory.ts | MemorySessionMapper.map() | 修改 | 读两源；调同一纯函数；formatL0 输出 session 切片（context tier 不变） | MUST 与 user mapper 调用同一函数+同输入 | 决策 A | +10 |
| memory_inject | app/plugins/builtins/rocky_context/prompt/memory.ts | resolveAppConfig/resolveDataDir/resolveSessionId | 修改 | 复用既有 helper（user mapper 也需 dataDir/sessionId 读 session 源） | — | — | +0 |
| skills_inject | app/server/src/skills/types.ts | SkillEntry | 修改 | 加 `updatedAt?: string`（ISO） | — | skill_definition §2 | +2 |
| skills_inject | app/server/src/skills/resolver.ts | parseSkill() frontmatter 解析 | 修改 | 读 `updated`/`updatedAt` frontmatter → SkillEntry.updatedAt（缺=undefined） | MUST 容忍字段缺失（legacy/builtin） | skill_definition §2 | +3 |
| skills_inject | app/server/src/skills/resolver.ts | SkillEntry 产出 | 修改 | 透传 updatedAt（合并层 workspace>app>builtin 保留命中层 updatedAt） | — | — | +1 |
| skills_inject | app/plugins/builtins/rocky_context/prompt/skills.ts | SkillsMapper.map() | 修改 | 读 maxSkillInject（appConfig.get('session','default')?.maxSkillInject ?? 50）；按派生分组(system=scope==='builtin' / agent=source==='agent' / else user) + 组内 updatedAt 倒序(缺=epoch0, tiebreak name升序) + 跨组 system→user→agent 取前 N；catalog 行顺序=selection 顺序 | MUST 分组键派生：scope==='builtin'→system（spec↔code 漂移：SkillEntry.source 无 'system'，必看 scope）；MUST NOT 只靠 source | PRD 需求1；决策 B；skills/types.ts(source 无 system) | +22 |
| skills_inject | app/plugins/builtins/rocky_context/prompt/skills.ts | readSkillEntries() | 修改 | 读出 updatedAt（透传 resolver）；返回结构加 updatedAt + scope（分组用） | — | — | +6 |
| skills_write | app/server/src/tools/skill-manage.ts | CREATE_GOVERNANCE | 修改 | 加 `updated`(ISO now)（create 盖戳） | — | skill_definition §6.3 | +1 |
| skills_write | app/server/src/tools/skill-manage.ts | executeCreate() | 修改 | fm 构造含 updated（随 source/production_method 一起） | MUST create 必盖 updated | — | +1 |
| skills_write | app/server/src/tools/skill-manage.ts | executePatch() | 修改 | 合并 frontmatter 时刷新 `updated=now`（保留其他字段） | MUST patch 刷新 updated | — | +3 |
| skills_write | app/server/src/skills/governance.ts | writeGovernance() | 修改 | UI 改 evolvable 时同刷 `updated=now`（外科式替换不破坏其他字段） | MUST 保留字节序前提下加 updated 行 | skill_definition §8 | +3 |
| migration | app/server/src/memory/migrate-memory-source-updated.ts | migrateMemorySourceUpdatedAt() | 新增 | 入(appConfig, dataDir)：user_memory entries[] 补 source(缺→'agent')/updatedAt(缺→now) 回写；遍历 sessions/*/session_memory.md 同补（parse→补→serialize→atomicWrite，仅变更才写）；marker=per-entry 字段缺失；幂等 | MUST catch warn 不 throw；MUST 仅缺字段才补（非破坏）；MUST NOT 清其他字段 | app_config §3.6 范式；PRD §3；memory runtime-no-ext-policy-write | +60 |
| migration | app/server/src/bootstrap.ts | migrateMemorySourceUpdatedAt 调用 | 修改 | L360 `migrateWebSearchProviderId(appConfig)` 之后 `await migrateMemorySourceUpdatedAt(appConfig, dataDir)` + 注释 | MUST 在 AppConfigService 初始化后、路由挂载前 | bootstrap L355/L360 范式 | +4 |
| config | （无代码改动） | session group | 新增 | app_config 新 group `session`(key='default', data={maxSkillInject?,maxMemoryInject?})；纯数据，AppConfigService 通用 KV 直读，无 service 代码 | MUST 缺失回退 50（消费方 ?? 50）；属可选覆盖调参组(§3.14) | app_config §3.14；PRD 需求4.2 | +0 |
| ui_config | app/web/src/components/app-dev-config-page/app-settings-config-defs.ts | TabId | 修改 | 加 `'session'` | — | page-app-settings-merged tab 映射 | +1 |
| ui_config | app-settings-config-defs.ts | GroupDef.groupId | 修改 | union 加 `'session'` | — | — | +1 |
| ui_config | app-settings-config-defs.ts | KV_GROUPS | 修改 | 加 session group def（keys: maxSkillInject/maxMemoryInject，type 'number'） | MUST key 名对齐后端 data 字段 | PRD §4.2 | +8 |
| ui_config | app-settings-config-defs.ts | APP_SETTINGS_TABS | 修改 | models.groups `['providers','default_models','llm_request']`→`['providers']`；新增 session tab（排 general 后第二位，groups=`['session','default_models','llm_request']`，inSystemArea:false） | MUST session 排第二；MUST models 只剩 providers | PRD §4.1/§4.3 | +4/-1 |
| ui_config | app-settings-config-defs.ts | TAB_KV_GROUPS | 修改 | session:`['session','default_models','llm_request']`；models→`[]`（providers 自渲染不入 KV dirty） | — | — | +2/-1 |
| ui_config | app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx | showSaveBar 判定 | 修改 | 加 `\|\| selectedTab==='session'`；移除 `'models'`（models 仅剩 providers 自渲染独立 save） | MUST models 不再显 page save bar | page-app-settings-merged 保存交互 | +1/-1 |
| ui_config | app/web/src/components/app-dev-config-page/section-tab-panel.tsx | switch(selectedTab) | 修改 | 加 `case 'session'`：渲染 SectionSessionConfig + 复用 SectionDefaultModelsAndRequest（default_models+llm_request，prop 注入同 models 旧分支） | MUST 复用既有 SectionDefaultModelsAndRequest（不改其契约） | page-app-settings-merged 复用关系 | +14 |
| ui_config | app/web/src/components/app-dev-config-page/section-session-config.tsx | SectionSessionConfig | 新增 | 两 number input（maxSkillInject/maxMemoryInject，testid `key-number-session-maxSkillInject`/`key-number-session-maxMemoryInject`，受控 value+onChange，默认 50）+ group title | MUST 单文件 ≤200 行；MUST testid 对齐 key-number-* 模式 | section-default-models-and-request §testid；_conventions.md | +60 |
| ui_config | app/web/src/components/app-dev-config-page/use-app-settings-config.ts | load/save/dirty/cancel | 修改 | session group 纳入 KV load(GET /config/app/session) + save(PUT 整组) + dirty(shallowDiff) + cancel；default_models/llm_request 随 tab 迁移（已按 groupId 工作，TAB_KV_GROUPS 映射即可） | MUST session 缺失 record → draft 默认 {maxSkillInject:50,maxMemoryInject:50} | PRD §4.2 缺失回退50 | +18 |
| ui_spec | specs/ui/components/app-dev-config-page/section-session-config.md | （ui spec 文件） | 新增 | coder 编码前置产出（先 spec 后实现）：两 number input 契约 + testid + 视觉基线（无设计稿，复用 key-number 形态） | MUST coder 编码前产出 | _conventions.md；PRD §4.2 | — |
| ui_spec | specs/ui/components/app-dev-config-page/page-app-settings-merged.md | tab→group 映射表 | 修改 | 加 session 行（label/会话，groups=session/default_models/llm_request）；models 行 groups 改 providers；testid tab-tree-item-session + group-item-session | — | PRD §4 | +2/-1 |

## 2. 文件级变更清单（feature 级叙事 — 设计粒度）

- **F1 memory entry 字段落盘两介质 + 写入路径盖戳**：managed-store.ts（Meta/Entry/parse/serialize/list/writeEntry）+ user-memory-service.ts（Entry/record/list/read/write）+ policy.ts（opts+source）+ memory-manage.ts（write 盖 source=agent）+ handlers/memory.ts（POST source=user / PATCH 不改 source）。依赖顺序：policy → managed-store/user-memory-service → tool/handler。
- **F2 migration**：migrate-memory-source-updated.ts（新）+ bootstrap.ts（调用点）。依赖 F1（entry 形状定下才能迁）。
- **F3 memory 两 mapper 协同截断**：inject-quota.ts（新纯函数）+ memory.ts（两 mapper 读两源+调纯函数）。依赖 F1（source/updatedAt 在 entry 上）。
- **F4 skills mapper 分组截断**：types.ts（updatedAt）+ resolver.ts（parse/透传）+ skills.ts（map/readSkillEntries 分组+截断）+ skill-manage.ts（create/patch 盖 updated）+ governance.ts（盖 updated）。
- **F5 config session group**：纯数据（app_config），无后端代码；mappers 直读 `appConfig.get('session','default')`。
- **F6 UI tab 重组 + session section**：app-settings-config-defs.ts（TabId/groupId/KV_GROUPS/APP_SETTINGS_TABS/TAB_KV_GROUPS）+ page-app-settings-merged.tsx（showSaveBar）+ section-tab-panel.tsx（+session case）+ section-session-config.tsx（新）+ use-app-settings-config.ts（load/save/dirty）+ section-session-config.md（新 ui spec，coder 前置产出）。

## 3. 符号核对结论（spec↔code 漂移，coder 注意）

1. **SkillEntry.source 无 'system'**（`skills/types.ts`：`source?: 'user'|'agent'`；resolver L89 builtin 落 source='user'）。PRD 分组 system(builtin)/user/agent 必须派生：`scope==='builtin'→system`，`source==='agent'→agent`，否则 `user`。**不得只读 source**。skill_definition §2/§6.2 spec 写 source 含 system 属概念表达，代码 enum 闭合性不含——按代码派生。
2. **skill 无 updatedAt 字段**（types.ts/resolver/frontmatter 均无）——本版本新增，属真实新增（非漂移）。
3. **memory entry 无 source/updatedAt**（managed-store/user-memory-service 均无）——本版本新增。
4. **handlers/memory.ts POST→`{defaultEvolvable:false}`、PATCH→`{setEvolvable}`** 已确认是 UI 写入点；source opt 经此注入。
5. **migrateWebSearchProviderId(appConfig)** 单参；migrateMemorySourceUpdatedAt 需 `(appConfig, dataDir)`（session memory 遍历要 dataDir）——签名不同，对齐范式不照抄签名。
6. **SectionDefaultModelsAndRequest 可直接复用**（已 export，props=defaultModelsDraft+llmRequestDraft+onChange），session tab case 直接渲染。
7. **showSaveBar 当前含 'models'**：models tab 迁走 default_models/llm_request 后仅剩 providers（自渲染独立 save），需移除 'models' 加 'session'。

## 4. UI spec 结构变更方向（coder 编码前置产出 ui spec 文件，非本 change_plan 落）

- `page-app-settings-merged.md` tab 树：general → **session(新, 排第二)** → models → tools → memory → observability → plugin。session tab 映射 groups={session, default_models, llm_request}；models tab 映射 groups={providers}。
- 新 `section-session-config.md`：group `session`，两 number input（maxSkillInject/maxMemoryInject），testid `key-number-session-maxSkillInject`/`key-number-session-maxMemoryInject`，默认 50，随 tab page-tab 级 save-bar 保存（非独立 save）。复用 key-number-* 视觉形态（无设计稿）。
- `section-default-models-and-request.md`：仅文档注 tab 归属改会话 tab（文件/testid/契约不变）。

## 5. 影响面评估

- **跨模块**：memory(skills 同构扩字段) → migration → 注入 mapper(config 直读) → config(纯数据) → UI tab 重组。底层（entry schema/services）先于上层（mapper/UI）。
- **破坏性**：memory entry schema 加字段（读侧存量兼容、写侧盖戳）；skill stable tier 数量变破 prompt cache（预期内）。无 API 契约 breaking（entry 增字段为 additive）。
- **风险点**：(1) skill 分组派生依赖 scope（漂移点，coder 勿只读 source）；(2) 两 mapper 读两源需 dataDir/sessionId 在 user mapper 可得（已在 ctx.config，既有 resolveDataDir/resolveSessionId 复用）；(3) migration 遍历 sessions/ 开销（bootstrap 一次性，仅变更才写盘，可接受）。
- **无偏离 PRD**：4 项技术决策（A/B/C/D）均服务已确认产品决策，不改产品语义。

## 6. 反馈回路

coder 实现偏离本表（改不在表里的文件 / 动未声明符号 / 破约束列）→ 退 coder；同一 task 退回 2 次仍违反 → 升级退 architect。spec↔code 漂移（如 SkillEntry.source 无 system）coder 按代码实际派生 + 汇报，doc-modifier 阶段 5 统一修 spec。
