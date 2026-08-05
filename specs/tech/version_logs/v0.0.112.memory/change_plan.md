# v0.0.112 变更计划书 — 长期记忆增强（按需加载 + evolvable + 300 词硬限 + 路由提示词 + scope 统一）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 上游：`specs/prd/overall/09-memory.md` + `specs/prd/version_logs/v0.0.112.memory/change_log.md`。tech 契约：`specs/tech/agent/memory/*` + `specs/tech/agent/skills/*`。API：`14-self-evolution-tool-ref.md` + `15-memory-ui.md`。

## 核心不变量（钉死，MUST NOT 违反）

1. **scope 映射只在边界**：对外 `global`/`session`（tool input/output + HTTP path + UI）；底层 service enum 不变（memory: `user`/`session`；skill: `builtin`/`app`/`workspace`）。映射发生在工具/handler/UI 边界，**MUST NOT 改底层 service 签名的 scope 枚举 / 存储路径**。
2. **300 词硬限单点**：唯一计数函数 `policy.countWords`，在 service write 层强制（覆盖 agent + UI 两路径），**MUST NOT 多处重复计数口径**。只卡本次写入新 body（存量豁免）。
3. **evolvable gate 只挡 agent 进化性写**：`memory_manage` 更新既有 `evolvable=false` + archive → 拒绝；UI 路径 **MUST NOT** gate（全开）。gate 在 service 层原子执行（enforceEvolvable 入参）。
4. **read 单点共享**：`memory` 工具 read + `memory_manage.read` **MUST** 共用 `query.readMemoryEntry`（不新造第二份读源）。
5. **注入只 L0**：mapper **MUST NOT** 注入 body/why/howToApply，只 name+description。
6. **路由提示词单一常量**：`ROUTING_DECISION_PROMPT` 单一源，三处引用（**MUST NOT** 复制粘贴措辞）。
7. **不改产品源码之外范围**：只做 5 需求，**MUST NOT** 扩范围（skill UI/HTTP 06/06a 保 app/workspace，不动）。

## 变更清单（行 = 函数/符号）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory-policy | app/server/src/memory/policy.ts | `countWords(text)` | 新增 | 单点计数：正则抽 CJK 逐字计 1 + 剩余去标点后 `split(/\s+/)` 每词计 1；返回总数 | MUST 唯一计数实现；只算传入 text（caller 只传 body） | memory_definition §5；不变量#2 | +18 |
| memory-policy | app/server/src/memory/policy.ts | `WORD_LIMIT` | 新增 | `const WORD_LIMIT = 300` | MUST 单一常量 | memory_definition §5 | +1 |
| memory-policy | app/server/src/memory/policy.ts | `MemoryWordLimitError` | 新增 | Error 子类（带 current count），service throw / boundary 映射 | MUST 携当前计数供错误文案 | memory_manage_tool §5 | +6 |
| memory-policy | app/server/src/memory/policy.ts | `MemoryNonEvolvableError` | 新增 | Error 子类（带 name），进化性写 gate 命中时 throw | — | memory_manage_tool §5.1 | +5 |
| memory-policy | app/server/src/memory/policy.ts | `MemoryWriteOpts` | 新增 | interface `{ enforceEvolvable?; defaultEvolvable?; setEvolvable? }`（write/archive 共用） | MUST 覆盖三语义：gate/新建默认/UI 显式改 | memory_definition §5.1 | +8 |
| memory-service | app/server/src/memory/user-memory-service.ts | `UserMemoryEntry` | 修改 | 加 `evolvable: boolean` 字段 | — | memory_definition §3 | +1 |
| memory-service | app/server/src/memory/user-memory-service.ts | `UserMemoryService.write` | 修改 | 签名加 `opts?: MemoryWriteOpts`；lock 内：countWords(body)>300 throw；enforceEvolvable && 既有.evolvable===false throw；persistedEvolvable = setEvolvable ?? (既有 ? 既有.evolvable : defaultEvolvable ?? false)；删 soft-warn | MUST 300 词 + gate 在 mutex 内原子；新建默认 evolvable 由 opts 决定；MUST NOT 让 agent 改 evolvable（agent 不传 setEvolvable） | memory_manage_tool §5/§5.1；不变量#2,#3 | +22/-8 |
| memory-service | app/server/src/memory/user-memory-service.ts | `UserMemoryService.archive` | 修改 | 签名加 `opts?: { enforceEvolvable? }`；enforceEvolvable && 既有.evolvable===false throw MemoryNonEvolvableError | MUST gate 在 mutex 内 | memory_manage_tool §5.1 | +5/-1 |
| memory-service | app/server/src/memory/user-memory-service.ts | `UserMemoryService.list` `read` | 修改 | 输出映射 `evolvable: e.evolvable ?? true`（存量缺省 true） | MUST 存量缺省 true（保 agent-可写） | memory_definition §5.1 | +4 |
| memory-service | app/server/src/memory/user-memory-service.ts | `CAPACITY_APPROX_LIMIT` + soft-warn 块 | 删除 | 删 record 序列化 soft-warn（file-total 退役） | MUST 删净不留死码 | memory_definition §5 | -8 |
| memory-service | app/server/src/memory/managed-store.ts | `MemoryEntry` `MemoryEntryMeta` | 修改 | 各加 `evolvable: boolean` | — | memory_definition §3 | +2 |
| memory-service | app/server/src/memory/managed-store.ts | `writeEntry` | 修改 | 签名加 `opts?: MemoryWriteOpts`；lock 内 countWords>300 throw + evolvable gate/默认（同 UserMemoryService.write 语义）；删 softWarnCapacity 调用 | MUST 300 词 + gate 在 file-lock 内原子；与 UserMemoryService.write 语义一致 | memory_manage_tool §5/§5.1；不变量#2,#3 | +18/-4 |
| memory-service | app/server/src/memory/managed-store.ts | `archiveEntry` | 修改 | 加 `opts?: { enforceEvolvable? }`；gate 命中 throw | MUST gate 在 lock 内 | memory_manage_tool §5.1 | +5/-1 |
| memory-service | app/server/src/memory/managed-store.ts | `listMetas` | 修改 | meta 加 `evolvable`（parseEntry 已带，默认 true） | — | memory_manage_tool §2 list | +1 |
| memory-service | app/server/src/memory/managed-store.ts | `listEntries` | 新增 | 返完整 MemoryEntry[]（默认仅 active；opts.includeArchived）——供 search + UI list 复用 parseMemoryFile | MUST 复用 parseMemoryFile，不重复解析 | memory_tool §3；15-memory-ui §8 | +12 |
| memory-service | app/server/src/memory/managed-store.ts | `parseEntry` | 修改 | 解析 frontmatter `evolvable`；缺失 → **true**（存量默认） | MUST 缺省 true（分歧 skill，见 §5.1） | memory_definition §5.1 | +2 |
| memory-service | app/server/src/memory/managed-store.ts | `serializeEntry` | 修改 | frontmatter 写入 `evolvable`（始终写，避免下次解析走默认） | MUST 显式写 evolvable | memory_definition §3 | +1 |
| memory-service | app/server/src/memory/managed-store.ts | `softWarnCapacity` + `CAPACITY_LIMIT` | 删除 | 删 session file-total soft-warn（退役） | MUST 删净；UT 若 spy 该函数需同步移除 | memory_definition §5 | -12 |
| memory-query | app/server/src/memory/query.ts | `readMemoryEntry(opts)` | 新增 | 按内部 scope('user'/'session'/undefined) 读单条：user→UserMemoryService.read；session→readEntry(dataDir,sid)；undefined→先 session 后 user；均未命中 throw not-found | MUST 供 memory 工具 + memory_manage.read 共享（不变量#4） | memory_tool §2；memory_manage_tool §2 read | +26 |
| memory-query | app/server/src/memory/query.ts | `searchMemory(opts)` | 新增 | 按内部 scope 取 active 全文（user: UserMemoryService.list / session: listEntries）→ keyword 大小写不敏感子串匹配 name/description/type/body/why/howToApply → 返 MemoryEntryMeta[]（不含 body） | MUST 不返 body；无排序 | memory_tool §3；不变量#5 | +28 |
| memory-tool | app/server/src/tools/memory.ts | `memoryTool` | 新增 | Tool 单例 name=`memory`；definition schema：action=read/search + scope enum `global`/`session`(可选) + name/keyword；run：外部 scope→内部（global→user）+ 取 dataDir/sessionId(ctx)/appConfig → 调 query.readMemoryEntry / searchMemory；返回时 scope 回显 external | MUST 只读（不写、不校验 evolvable/300）；read 走 query（不变量#4）；search 不返 body（不变量#5） | memory_tool §2-§6 | +85 |
| memory-tool | app/server/src/tools/memory.ts | `toInternalScope` `toExternalScope` | 新增 | memory scope 边界映射 global↔user / session↔session | MUST 仅边界用 | 不变量#1 | +8 |
| memory-manage | app/server/src/tools/memory-manage.ts | `toInternalScope`(复用/新增) | 新增 | 对外 global/session → 内部 user/session（可复用 memory.ts 导出或本地小函数） | MUST 与 memory.ts 同映射 | 不变量#1 | +6 |
| memory-manage | app/server/src/tools/memory-manage.ts | `memoryManageTool.definition` | 修改 | description 内嵌 ROUTING_DECISION_PROMPT + 默认 global 引导；scope schema enum 改 `['global','session']`(write/archive/read 可选) / `['global','session','all']`(list)；entry schema 不加 evolvable（agent 不碰） | MUST scope 默认 global；payload 不含 evolvable；引用单一常量 | memory_manage_tool §2/§5.2；不变量#6 | +22/-12 |
| memory-manage | app/server/src/tools/memory-manage.ts | `run` write 分支 | 修改 | scope 默认 global + map 内部；调 service.write 传 `{enforceEvolvable:true, defaultEvolvable:true}`；catch MemoryWordLimitError/MemoryNonEvolvableError → `errorResult('[invalid_input] ...')` | MUST enforceEvolvable=true（agent 路径）；新建 evolvable=true；错误码 invalid_input（不用 INTERNAL——枚举无此值） | memory_manage_tool §5/§5.1；ToolErrorCode | +14/-4 |
| memory-manage | app/server/src/tools/memory-manage.ts | `run` archive 分支 | 修改 | scope map；service.archive 传 `{enforceEvolvable:true}`；non-evolvable → `[invalid_input]` | MUST gate；non-evolvable=invalid_input | memory_manage_tool §5.1 | +6/-2 |
| memory-manage | app/server/src/tools/memory-manage.ts | `run` list 分支 | 修改 | scope map；meta 含 evolvable + scope 回显 external | — | memory_manage_tool §2 | +4/-2 |
| memory-manage | app/server/src/tools/memory-manage.ts | `run` read 分支 | 修改 | 改调 `query.readMemoryEntry`（scope map 后传内部）替代内联 read；scope 回显 external | MUST 走 query（不变量#4） | memory_manage_tool §2 read | +6/-10 |
| memory-injection | app/plugins/builtins/rocky_context/prompt/memory.ts | `formatL0` | 修改 | 替换 `formatEntries`：只输出 header + `- <name>: <description>` 列表 + 末尾「Use the \`memory\` tool to read a memory's full body by name.」；不输出 body/why/howToApply | MUST 不含正文（不变量#5） | memory_injection §3 | +14/-22 |
| memory-injection | app/plugins/builtins/rocky_context/prompt/memory.ts | `MemoryUserMapper.map` | 修改 | 用 UserMemoryService.list 取 name+description → formatL0 | MUST L0 only | memory_injection §2/§3 | +2/-2 |
| memory-injection | app/plugins/builtins/rocky_context/prompt/memory.ts | `MemorySessionMapper.map` | 修改 | 改用 `listMetas`（不再 readEntry 读全文）→ 过滤 !archived → formatL0 | MUST 不读 body（性能 + L0） | memory_injection §2/§3 | +4/-6 |
| memory-injection | app/plugins/builtins/rocky_context/prompt/memory.ts | `readSessionMemoryForInjection` | 删除 | 删（不再需读全文注入） | MUST 删净 | memory_injection §3 | -18 |
| memory-ui-http | app/server/src/handlers/memory-helpers.ts | `parseScope` | 修改 | 外部 `global`/`session` → 内部 `user`/`session`（返回内部值供 handler 分流不变） | MUST 边界映射（不变量#1）；旧 `user` 值不再接受 | 15-memory-ui §2/§8 | +4/-2 |
| memory-ui-http | app/server/src/handlers/memory-helpers.ts | `coerceEntryInput` `mergeEntry` | 修改 | 透传 `evolvable`（POST 缺省不设由 handler 传 defaultEvolvable:false；PATCH 携带 setEvolvable） | MUST UI 可改 evolvable | 15-memory-ui §4/§5 | +6 |
| memory-ui-http | app/server/src/handlers/memory.ts | `handleMemoryCreate` | 修改 | write 传 `{defaultEvolvable:false}`（无 enforceEvolvable）；catch MemoryWordLimitError → 400 | MUST UI 不 gate；300 词→400 | 15-memory-ui §4.2；不变量#3 | +8/-3 |
| memory-ui-http | app/server/src/handlers/memory.ts | `handleMemoryUpdate` | 修改 | write 传 `{setEvolvable: partial.evolvable}`（省略=保留）；catch 300 词→400 | MUST UI 全开可改 evolvable | 15-memory-ui §5；不变量#3 | +8/-3 |
| memory-ui-http | app/server/src/handlers/memory.ts | `handleMemoryList` | 修改 | session 分支改用 `listEntries`（替代 listMetas+逐条 readEntry）；返 entries 含 evolvable | — | 15-memory-ui §8 | +4/-8 |
| memory-ui-http | app/server/src/handlers/memory.ts | `handleMemoryDelete` | 修改 | archive 不传 enforceEvolvable（UI 全开） | MUST UI 不 gate | 15-memory-ui §6.1 | +1 |
| routing-prompt | app/server/src/prompts/routing-decision.ts | `ROUTING_DECISION_PROMPT` | 新增 | 两步决策文案常量（第一步 skill/memory/都不写；第二步 global/session）——单一源 | MUST 唯一源，三处引用（不变量#6） | memory_manage_tool §5.2 | +20 |
| routing-prompt | app/server/src/prompts/handlers/consolidation-handler.ts | `ConsolidationHandler.build` | 修改 | fillTemplate 加 `routing_rules: ROUTING_DECISION_PROMPT` 变量 | MUST 引用单一常量 | consolidation_tier1 §6 | +2 |
| routing-prompt | app/server/src/prompts/content/consolidation.md | Step 2 路由段 | 修改 | 手写 Step 2 路由列表替换为占位符 `{{routing_rules}}` | MUST 不再手写路由（防漂移） | consolidation_tier1 §6；不变量#6 | +1/-6 |
| skill-tool | app/server/src/tools/skill-manage.ts | `toInternalSkillScope` `toExternalSkillScope` | 新增 | global↔app / session↔workspace；builtin→global（输出回显） | MUST 仅边界 | skill_manage_tool §2；不变量#1 | +10 |
| skill-tool | app/server/src/tools/skill-manage.ts | `parseNameScope` | 修改 | scope 入参改识别 `global`/`session`（缺省 global→app；session→workspace）替代 `app`/`workspace` | MUST 默认 global（对齐现 parseNameScope 默认 app 语义） | skill_manage_tool §2 | +4/-2 |
| skill-tool | app/server/src/tools/skill-manage.ts | `skillManageTool.definition` | 修改 | description 内嵌 ROUTING_DECISION_PROMPT + 默认 global + session=项目级消歧；inputSchema scope enum 改 `['global','session','all']` | MUST 引用单一常量；写清 session≠单会话 | skill_manage_tool §2/§2.1/§11；不变量#6 | +16/-6 |
| skill-tool | app/server/src/tools/skill-manage.ts | `executeList` | 修改 | scopeFilter 外部→内部映射；`toMeta` 输出 scope 回显 external | MUST 输出 external scope | skill_manage_tool §2 | +4/-2 |
| skill-tool | app/server/src/tools/skill-manage.ts | `executeRead` `executeCreate` `executePatch` `executeSetEnabled` | 修改 | explicitScope 外部→内部；JSON 输出 scope 回显 external（toExternalSkillScope） | MUST 输出 external | skill_manage_tool §2 | +8/-4 |
| skill-tool | app/server/src/tools/skill.ts | `skillTool.run` | 修改 | 输出 payload.scope 映射 external（app→global/workspace→session/builtin→global） | MUST 输出 external | skill_architecture §3 | +3/-1 |
| tool-registry | app/server/src/tools/registry.ts | `defaultTools` | 修改 | import + push `memoryTool`（注册进默认集） | MUST 保注册序 | memory_tool §7 | +2 |
| tool-policy | app/server/src/agent/tool-policy.ts | `TOOL_POLICY` | 修改 | 给 `playground-rocky`/`studio-leader`/`studio-mate`/`subagent` bound 各加 `'memory'`（对齐 `skill` 读工具 4 角色） | MUST 对齐 skill 读工具范围；studio-squad 不加 | memory_tool §7；tool_policy | +4 |
| ui-memory | app/web/src/lib/memory-api.ts | `MemoryScope` `MemoryEntry` `list/write/patch/archiveMemory` | 修改 | scope 类型 `'user'`→`'global'`；URL `/memory/${scope}`；MemoryEntry 加 `evolvable` | MUST scope 对外 global/session；coder 编码前置产/更新组件 spec | 15-memory-ui §2/§3 | +8/-4 |
| ui-memory | app/web/src/components/chat-page/component-memory-editor-modal.tsx | evolvable 编辑控件 | 修改 | 加 evolvable 开关字段（**无置灰、不防呆**，全字段可编辑） | MUST 无 lock/置灰（PRD §9.2.3 UC-M4） | 15-memory-ui §5；PRD §9.2.3 | +20 |
| ui-memory | app/web/src/components/chat-page/component-memory-entry-card.tsx | evolvable 展示 | 修改 | 卡片透出 evolvable 标记 | — | PRD §9.2.3 | +6 |
| ui-memory | app/web/src/components/chat-page/section-memory-panel.tsx · use-memory-crud.ts | scope vocab | 修改 | scope `'session'` 语义不变；对接 memory-api 新 scope 类型 | MUST 不破坏 session tab | 15-memory-ui | +4/-2 |
| ui-memory | app/web/src/components/app-dev-config-page/section-user-memory.tsx | scope `'user'`→`'global'` | 修改 | useMemoryCrud('global')；文案对齐「全局长期记忆」 | MUST scope global | 15-memory-ui §2 | +3/-3 |
| ui-memory | app/web/src/components/studio-page/component-member-panel-memory.tsx | scope vocab | 修改 | 对接 memory-api 新 scope 类型（member 会话 memory） | MUST 不破坏 studio 面板 | 15-memory-ui | +3/-3 |

## 影响面评估

- **跨模块**：memory service（policy/user-memory-service/managed-store/query）→ memory 工具（memory.ts 新 + memory-manage 改）→ 注入 mapper（memory.ts plugin）→ UI HTTP（memory.ts/memory-helpers）→ 前端（memory-api + 4 组件）；skill 侧仅工具边界（skill-manage/skill）；registry + tool-policy 接线；routing 常量三处引用。
- **破坏性变更**：(1) HTTP `/memory/:scope` path `user`→`global`（前端 + AT/E2E case 同步更新）；(2) memory/skill 工具 input scope enum 改 global/session（AT case 用旧值需更新）；(3) 注入内容从整文件→L0（依赖注入正文的既有 agent 行为改走 `memory` 工具，见 memory_injection §3 注记）。
- **依赖顺序**：底层先行——`policy.ts`（countWords + errors + opts）→ `user-memory-service`/`managed-store`（消费 opts）→ `query.ts`（消费 service）→ 工具/handler（消费 query + service）→ registry/policy 接线 → 前端。routing 常量先于三处引用。
- **风险点**：(1) evolvable 存量默认 true（分歧 skill 的 false）——UT 须覆盖「无字段既有 entry agent 可写」；(2) 300 词 gate 在 mutex/lock 内原子，UT 须验 TOCTOU 不撕裂；(3) scope 边界映射遗漏（尤其输出回显 external）会致前端/agent 看到内部 enum；(4) 删 softWarnCapacity/CAPACITY_LIMIT 需同步清 UT spy；(5) packaged 无关（无新第三方依赖、无 plugin 新增、无 runtime env 新键）。

## 开放决策（交 orchestrator 裁决）

1. **evolvable 存量默认 = true**（本 spec 定）：保留 v0.0.111 前 agent 可写任意 memory 的行为，避免既有记忆被冻结。刻意分歧 skill（缺省 false）。若 orchestrator 认为应保守 false（全存量冻结、用户 opt-in），需回改 memory_definition §5.1 + parseEntry + UserMemoryService.list/read。
2. **进化性写 gate 边界 = 更新既有 + archive**（本 spec 定）：write 新建（name 不存在）不 gate（等价 skill create）。list/read/search 纯读不 gate。
3. **`memory` 读工具 4 角色 bound**（含 subagent，对齐 `skill`）：若只想对齐 `memory_manage` 3 角色（不含 subagent），需删 subagent 行——但 subagent 被注入 memory L0 却无 `memory` 读工具会读不到正文，故本 spec 选 4 角色。
4. **skill UI/HTTP（06/06a）+ 管理页 scope 未统一**（保 app/workspace，bounded）：本版本仅统一 skill_manage/skill 工具。若要求 skill UI 也全统一 global/session，需扩 06/06a spec + skill 管理 UI（范围外，建议后续版本）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
