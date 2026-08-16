---
type: log
title: Squad KB 变更记录
updated: 2026-08-15
---

# Squad KB 变更记录（ISO 倒序，最新在前）

## 2026-08-15 · v0.0.361（squad reminder 拆半 + queue fanout — squad_workspace 退役）

- **`[P1]squad_reminder_providers.md`**：标题/定位改 2 provider（`squad_workspace` 退役）；§2 改退役注记（逻辑平移 `session_states` mapper + 五链同步：plugin.json/scopes/i18n/计数断言）；§3 squad_agents_status 改动态半（名单归 team_roster，行内仅 name 锚点）；§5 角色矩阵删 squad_workspace 行；§7 injector 改双模式；新增 §7b reminder queue 写入接线表（`squad-states-fanout` 三入口：presence/member_state/task transition，key/audience/写点代码）；§8 边界表同步；frontmatter `updated`。
- **`[P1]prompt_sections.md`**：§1 贡献点总表加 `session_states` mapper 行 + 删 squad_workspace provider 行；§4 表改 2 provider + 拆半注记；§5 格式行改 name 锚点（去 role/sessionId）；§6 生命周期动态变化行改双模式；frontmatter `updated`。
- **`index.md`**：reminder 概念行改（queue 写侧投递 + squad_workspace 退役注记）+ presence 行改拆半口径；frontmatter `updated`。

## 2026-08-13 · v0.0.319（团队同步服务层 spec 补建 — [P1]team_sync.md）

- **新增 `[P1]team_sync.md`**：v0.0.319 团队同步服务层 spec（此前仅存在于 change_plan + change_log，本次补建）——导出链路（buildManifest + exportSquadToZip 白名单 + restoreAgentFileName/stripMemberIdSuffix + symlink skip + RFC 5987 下载头）；导入链路（preview/execute 两阶段 + validateZipEntries 路径安全 + ImportKeyStore 5min TTL take 原子消费 + best-effort hire + finally 清理）；modelDefault 继承（x-session-id → session squad → 系统 fallback）；边界（workspace 不导出/明文 zip/成员名保留/进程内存）。
- **`index.md` 导航**：补「团队同步 / 模板」分组 + team_sync.md 行。
- 详情：`specs/tech/version_logs/v0.0.319/change_log.md` + `specs/prd/v0.0.319-team-sync.md`

## 2026-08-12 · v0.0.340（新团队默认关群聊 + 成员改名信封旧名修复 — 写时全同步 + 读单一源）

- **`[P1]data_model.md §1.1`**：`enableGroupChat` 默认值语义更新——**[v0.0.340] 新建团队默认 false=关**（建队 `squad-service.ts createSquadService` 显式写 false）；存量 squad 无字段读 `?? true`=开（兜底不动，存量不受影响）；管理面板 toggle 可手动开。schema `required:false` + 读取 `?? true` 兜底不变。
- **`[P1]squad_tools.md §2`**：`team.edit` 补 [v0.0.340] 改名写时全同步——`patchMemberService` putMember 成功后同步关联 session.title（判据：改名发生 || title !== patch.name；仅 `titled !== true` 不覆盖自定义名；updateSession 只传 title 不传 titled 保 CAS；失败抛错透传；team.edit 经 `rtc.store` 注入 sessionStore，与 HTTP PATCH 同一 service 单源）。
- **`[P1]prompt_sections.md` + `[P1]squad_reminder_providers.md`**：270 enableGroupChat 门控描述补 [v0.0.340] 新建团队默认 false=关（存量 `!== false` 语义不变）。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① `squad-service.ts:214` `enableGroupChat: false` + 注释同步 ✅；② handlers/squad.ts 存量兜底 `?? true` 未动 ✅；③ `member-mutations.ts` MemberMutationDeps 加 sessionStore（必填）+ patchMemberService 同步块（putMember 成功 → getSession → titled!==true → updateSession(title)）✅；④ 两调用方（handlers/member.ts deps.sessionStore / team-write-actions.ts rtc.store）透传 ✅。
- 详情：`specs/tech/version_logs/v0.0.340-squad-defaults-and-rename/change_plan.md` + `change_log.md`

## 2026-08-09 · v0.0.305（squad 聚合视图 + squad_meta SSE — 团队列表 UI 升级后端）

- **新增 `[P1]squad_aggregate.md`**：squad 聚合视图（onlineCount/inProgressCount/lastActiveAt）计算 + `squad_meta` SSE 广播——`squad-aggregate-service.ts`（纯函数 `aggregateFromViews` + 批量 `computeSquadAggregates` 一次 listSessions 内存聚合避免 N+1 + 单点 `computeSquadAggregate`）+ `squad-meta-broadcaster.ts`（仿 SessionMetaBroadcaster 自治订阅 statusBus，触发集合过滤 + 写路径显式 broadcast + sessionStore 延迟注入破循环）+ `squad-event-types.ts`（SQUAD_META_TOPIC/group + SquadAggregate/SquadMetaUpdateEvent）+ 前端 `use-squad-meta.ts`（page-studio 级单例 + onResumed 断连兜底）。口径与 seats 面板完全一致（直连 session 集合 = squadChat + members[].sessionId，不混 subagent 子会话）。
- **`[P1]data_model.md` 无改动**：3 字段为派生值不落库（squad/member/session 是持久权威源）。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① 聚合口径 `aggregateFromViews` 直连集合 + BUSY_STATES 含 suspended ✅；② 批量入口一次 listSessions 分组、单点入口全量过滤、squad 不存在返 null ✅；③ broadcaster 触发集合 5 类型（无 workspace_file_changed）+ wrap fan-out + 异常吞 ✅；④ handler 写路径 broadcast（hire L131/deploy L179/bench L210/create L390）await 落盘后 + patch/delete 不 broadcast ✅；⑤ SSE 白名单 `sse.ts:19` + bus-phase 注册 + 白名单测试 import 真值 ✅；⑥ 前端 useSquadMeta onInit 只订阅不拉 GET + onEvent applyKeyed set + onResumed reloadSquads ✅；⑦ page-studio getAgg 合并（SSE 优先 GET 兜底）双下发 sidebar/seats ✅。
- 详情：`specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/change_plan.md` + `architecture.md`

## 2026-08-07 · v0.0.282（team.reset — mate 上下文重置）

- **`[P1]squad_tools.md`**：team 工具 6→7 action——§1 收敛原则枚举加 reset / §2 标题改 7 action + action 全表加 `reset` 行（`roleId`，leader/user only：清 transcript+summary+runs+usage 复用 `store.clearSession` 同聊天页链路 + presence currentWork=null + todo removeAll；running 保护 state∈{running,interrupting} 拒绝不 abort；不动 memory/agent md）/ member 只读段补 reset 拒 / 写 action 单源段补 reset（落 team-write-actions.ts runReset，不走 member-mutations，直接调底层 store）。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① runReset 清理链路 L259-262 `rtc.store.clearSession(sid)` → clearSessionStoreOp == 同 POST /session/:id/clear 链路 ✅；② running 保护 L252-255 state∈{running,interrupting}→errorResult 不调 abort ✅；③ presence L264-270 read-modify-write 剥信封 putMember currentWork=null + todo L276-282 removeAll cast 探测缺省 skip ✅；④ memory/agent md grep 0 命中 ✅；⑤ 工具 schema 7 action（enum L36 / TEAM_ACTIONS L26 / WRITE_ACTIONS L29 / dispatch L98 / description L45）四处同步 ✅。

## 2026-08-07 · v0.0.279（squad 团队默认推理强度 effortDefault）

- **`[P1]data_model.md §1.1`**：Squad interface 加 `effortDefault?: 'default'|'low'|'high'|'max'`（[v0.0.279 新增]）——schema `required:false`（存量 squad 无字段=default）+ 读取 `?? 'default'` 兜底（UI 下拉恒有值）+ PATCH `!== undefined` 才写、显式 'default' 也落盘不清空；覆盖链（成员显式 > 团队默认 > 厂商默认）指针 llm_protocol_interface §3.8。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① schema `squad.ts:50` `{ type: 'string', required: false }` ✅；② handler `squad.ts:396-397` 字段级校验 400 先于 404 + `L430` `!== undefined` 落盘（显式 default 也落盘）+ `L269` toDetail 回显 `?? 'default'` ✅；③ session-config `resolveEffort` 纯函数 L107-114（成员 low/high/max → 用之；否则团队 low/high/max → 用之；否则 undefined）+ 调用 L255-260（与 resolveModel 同区，每次 run 现拉无 cache）+ 注入点 L354 ✅；④ 零改动边界（encode / model-resolver / 成员级 picker / createSquad / playground+academy / subagent）git diff 空 ✅。
- 详情：`specs/tech/version_logs/v0.0.279/change_plan.md`（12 行 method 级表）+ `change_log.md`

## 2026-08-07 · v0.0.273（squad_agents_status 统一全员状态块取代 squad_team_status + reachable_agents + mate 退出通知 hook）

- **`[P1]squad_reminder_providers.md`**：§3 `squad_team_status`（leader-only，只列 running）→ `squad_agents_status`（统一全员状态块 `[squad:agents]`，squad/leader/mate/subagent 分派）——三合一（agent 列表 + running/idle + presence）+ **全员列出**（不按 running 过滤，idle 不消失）+ benched 过滤 + 270 门控保留 + 数据源迁移（studioContext → squadContext）；§0 定位 2→3 provider、§1 ReminderCtx 扩展、§5 角色矩阵、§8 边界表同步。
- **`[P1]prompt_sections.md`**：§1 贡献点总表 + §4 system_reminder sections + §5 `reachable_agents` 段 → `squad_agents_status`（统一块派生表 + 全员列出 + bench 过滤 + 270 门控 + 格式）+ §6 生命周期 + §9 plugin.json 注册 + §10 边界表同步。
- **`[P1]data_model.md`**（关联）：`member.currentWork`（presence 数据源）语义不变——`[squad:agents]` 成员行 presence 列读它。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① `squad_agents_status.ts` readSessionType 5 种分派 ✅；② 全员列出（旧 squad_team_status L66 `if (!running) continue` 已删，running+idle 都保留）✅；③ 270 门控 `enableGroupChat !== false` + benched 过滤 ✅；④ 成员行格式与 R8 一致 ✅；⑤ 旧 provider 文件 + 旧测试已删 + plugin.json 删二加一 + 生产代码零残留 ✅。
- 详情：`specs/tech/version_logs/v0.0.273/change_plan.md`（8 裁决 R1-R8）+ `change_log.md`

## 2026-08-06 · v0.0.270（群聊开关 enableGroupChat — schema + 注入门控 + 协作规则段删除）

- **`[P1]data_model.md §1.1`**：Squad interface 加 `enableGroupChat: boolean`（[v0.0.270 新增]，默认 true=开）——schema `required:false`（容忍旧 record 无字段）+ 读取 `?? true` 兜底（缺省=开）；false → agents 注入 SquadChat（reachable_agents squadChatRef 不构造）+ UI 群聊入口隐藏 + send_message('squadchat') 门控返 null（全私聊语义）；squad 实体/session 恒存在，仅控可见性。建队 `squad-service.ts:214` 显式写 `true`（对齐 enableHeartBeat:false 相邻，方向相反默认开）。
- **`[P1]prompt_sections.md §3.1`**：**协作规则（群聊）段无条件删除裁决**（老板 v0.0.270 拍板）——leader.md / mate.md 的「## 协作规则（在群聊里讲话）」段直接删除 + 其他「群聊 @」广播指引改 `send_message` 直连口径；squad_role.ts map() 逻辑不动（handlers 纯 readContent() 文件读取，删文件段即生效——开/关态均不注入，非两态切换）；纪律留团队 AGENTS.md；保留 user 沟通类表述（「user 在群聊提需求」「会话或群聊和 user 对齐」）。
- **api `specs/api/overall/11a-squad-endpoints.md` v1.11**：§1.3 SquadDetail + §1.4 PatchSquadBody 加 `enableGroupChat`（Detail 回显 `?? true` / Patch `!== undefined` 才改，对齐 enableHeartBeat 模式）。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① schema `squad.ts:82` `{ type: 'boolean', required: false }` ✅；② 建队 `squad-service.ts:214` `enableGroupChat: true` ✅；③ handlers 三类型（PatchSquadBody `?: boolean` L111 / SquadSummary L128 / SquadDetail L148 `: boolean`）+ toSummary L168 / toDetail L263 `?? true` + PATCH L411 `!== undefined` ✅；④ reachable_agents L106 `squadChatSid && squad.enableGroupChat !== false ? {...} : null`（一处管 system prompt + system_reminder 两头）✅；⑤ runtime-context resolveSquadAlias 'squadchat' `=== false` 返 null + resolveAgentRefWithSquad fallback 拦截（'squadchat' 解析失败返 null 不直传，coder3 偏离 ① 合理）✅；⑥ leader.md/mate.md 协作规则段删除 + 群聊广播指引改 send_message 直连（保留 user 沟通类 L7/L11/L49）✅；⑦ web squad-types 三类型加字段 + seats-body `detail.enableGroupChat !== false` 才传 onOpenGroupChat/onGroupChatContextMenu（关时不传 → SeatCard 缺省隐藏，零新增分支）+ group-chat-toggle（data-action-key=studio.squad.toggle-group-chat + role=switch + 无本地态切换 + 防双击）✅。
- 详情：`specs/tech/version_logs/v0.0.270/change_plan.md`（method 级契约）+ `specs/tech/version_logs/v0.0.270/change_log.md`；PRD `specs/prd/version_logs/v0.0.270.group_chat_switch/prd.md`

## 2026-08-05 · v0.0.259 panorama_dx（实例写前 coerce + 语义层认 system entity 恒在可引用 + create 幂等）

panorama 创作体验三修——prod 553 次 panorama 调用 / 123 次失败归因后修三类引擎问题（非 DSL 创作面太大）：

1. **coerce（~60% 最大头）**：`chapter_count_done` / `scraped_chapter_end` 等数字字段 agent 声明 `type:string`、create 传 `1928`（number），或反过来——142 处错配里 114 是 string←number、28 是 number<-string，**全是同值类型拧巴**。新增 `coerceRecord(entityDef, record)` 在 create/update 写库前按声明类型无损 coerce（number↔string / boolean←"true","false"），有损/不合法值（`"0x10"`/`"1.0"`/`""`/enum 非法）保留原值交下游 check 报错；纯函数不 mutate 入参。覆盖 create + update 两路（tool `runCreate`/`runUpdate` + http `handleCreateEntity`/`handlePatchEntity`），在 `applyFieldDefaults` 之后、`validateInstance` 之前。配套错误信息增强：`checkString`/`checkNumber`/`checkEnumValue` message 带声明约束原文（type/max/pattern/enum values）+ suggestion 含 `panorama readSchema` / `GET schema` 引导。
2. **system entity 解析（~20%）**：v0.0.243 task 改普通 entity 后，`views` 引用 task 但 `entities` 未声明 task → 语义校验在 system 注入之前跑 → `panorama_unknown_view_entity`。本版本补 v0.0.243 遗漏路径：`validateSemantic` 构造 `entityNames` 集合时追加 `Object.keys(SYSTEM_ENTITY_DEFS)`（纯内存操作），`checkViews` 在 `schema.entities[view.entity]` miss 时 fallback `SYSTEM_ENTITY_DEFS[view.entity]` canonical def 继续下游校验（group_by/columns/filter/template/badges，不能 pass 跳过）。**不改 `injectSystemEntities` 后置时序、不改 `checkSystemEntityImmutable` 抓 leader 改 task**。
3. **create 幂等（~15% + 重试放大）**：re-seed 23 本书 ×2 轮 bulk create 每本撞 `panorama_duplicate_id`——agent 不 query 现存就批量写。改 **skip-if-exists**：id 已存在直接返 `201 {ok:true,id,created:false}`（不写库 / 不 emit / 不触发 afterTaskWrite，idempotent success 语义）；未命中正常建返 `created:true`。短路在 coerce+validate 之前。`validateInstance` create 分支 duplicate check 移除（保留=死代码，违反「不遗留死代码」原则）；`panorama_duplicate_id` 从校验码集合移除。

- **`[P1]panorama_validation.md`**：① frontmatter updated；② §3.5 新增 system entity immutable 校验小节（注明实现于 `validate_system_entity.ts`——既有 spec 概念表达漂移修正）；③ §4 语义层补「system entity 恒在可引用」段（entityNames 追加 + checkViews fallback + 实现行号）；④ §6 表格删 `panorama_duplicate_id` 行 + 表后注「id 唯一性由调用方 skip-if-exists 短路」；⑤ §6.1 新增 coerceRecord 小节（无损 round-trip 守门 + 各类型 coerce 表 + 实现行号）；⑥ §6.2 新增错误信息增强小节（eHint + declared*Constraints helper）。
- **`[P1]panorama_builtin.md`**：① frontmatter updated；② §4 bullets 新增「view 可直接引用 task（无需 entities 声明）」——语义层认 system entity 恒在可引用 + 与 inject 后置时序解耦；引用 validation.md §4 权威。
- **API `specs/api/overall/14-panorama-endpoints.md` v1.5**：① §2.2 POST entities response shape `{ok:true,id}` → `{ok:true,id,created:boolean}`（additive）+ 行为改写为 skip-if-exists 幂等（短路在 coerce+validate 之前 / 命中不 emit/afterTaskWrite）；② §2.2 注明 `panorama_duplicate_id` 不再从 create 路径产出；③ §2.4 PATCH 行为加 coerceRecord（merged 后 coerce）。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① `coerceRecord` 纯函数不 mutate + 严格 round-trip 守门（`String(Number(v))===trimmed` 排 `"0x10"`/`"1.0"`/`"1e3"`/`""`/`"12a"`）+ boolean 仅认字面串（`"True"`/`1`/`0` 不 coerce）+ enum/ref/datetime 不 coerce + null 原值返回 ✅；② `coerceFieldValue` 私有 helper 被 coerceRecord 调用 ✅；③ create skip-if-exists 在 runCreate:33-36 + handleCreateEntity:200-202 两路，命中不 emit/不 afterTaskWrite/不写库 ✅；④ validateInstance create 分支 duplicate check 删除（仅留 line 156-158 注释说明）✅；⑤ validateSemantic:33-36 纳入 SYSTEM_ENTITY_DEFS keys ✅；⑥ checkViews:78 fallback canonical def 继续下游校验（非 pass 跳过）✅；⑦ checkSystemEntityImmutable 仍在 `validate_system_entity.ts`（不动）✅；⑧ validation/index.ts:14 barrel re-export coerceRecord ✅。
- 详情：`specs/tech/version_logs/v0.0.259/change_plan.md`

## 2026-08-04 · v0.0.250 derive_member_agents_md（derive 补齐个人 AGENTS.md 复制 + 清理 inheritMemory dead field）

两件套：① v0.0.232 引入 AGENTS.md 两级读取 + v0.0.233 derive_academy 落点重映射后，**derive（派生自成员）只继承 record 字段、不复制父成员个人 AGENTS.md**——本版本补齐 step7.5 复制；② `inheritMemory` 是 dead field（声明「派生复制父记忆」从未落地，memory 已 v0.0.232 团队盘共享），全栈清理（server schema/service/handler/tool + UT + 前端 UI 级联 + spec）。

- **`[P1]data_model.md`**：§1.2 Member schema 删 `inheritMemory?: boolean`（已删字段不再保留墓志铭注释）；§5 createMemberService step 列表加 **step7.5** 描述——`if (mode==='derive' && deriveFrom && eff.parentMemberId)` → `copyPersonalAgentsMd()` 复制父成员个人 AGENTS.md（路径字面拼 `{parentName}-{parentId}.md → {childName}-{memberId}.md`）；父无/失败 → 静默 no-op（**不触发事务回滚**，子继续用团队级 AGENTS.md 兜底）。step4 注释更新为 derive 复制 AGENTS.md（非记忆）。resolveEffective return 加 `parentName`/`parentMemberId` 透传父信息（零二次 getMember）。
- **`[P1]squad_definition.md`**：§3 删 `inheritMemory?: boolean` + §4 derive bullet 加「复制父成员个人差异 AGENTS.md」描述（父无 → 静默 no-op 不回滚；不碰 skills/memory，团队级仅 derive_academy merge）。派生字段说明加「memory 不复制（已团队盘共享）」。
- **`[P1]squad_tools.md`**：§2 hire action derive 入参从 `{ deriveFrom, inheritMemory, overrides? }` 改 `{ deriveFrom, overrides? }`。
- **`design.md`**：SD1 行 + RoleSpec interface + §5 派生段三处删 `inheritMemory`，改述为「复制父成员个人 AGENTS.md（父无 → no-op）；memory 不复制（已团队盘共享）」。
- **代码↔spec 偏离核实**：① `copyPersonalAgentsMd` 位于 `member-academy-bridge.ts`（复用 fs imports，co-location 零新依赖），spec §5 step7.5 路径 `{squadRoot}/.rocky/agents/{name}-{id}.md` 字面拼与代码 line 292-296 一致 ✅；② step7.5 仅 derive 分支调用（条件 `mode==='derive' && deriveFrom && parentMemberId`）与 spec 一致 ✅；③ derive_academy 走 step7 不调 helper（spec 一致 ✅）；④ 父无 → `existsSync=false` no-op + 复制失败 `catch{}` no-op 不回滚与 spec 一致 ✅；⑤ parent 透传经 `resolveEffective` return（非二次 getMember）与 spec 一致 ✅。
- **API overall**：`11a-squad-endpoints.md` v1.10 Member 接口 + HireMemberBody derive 分支 + step 列表删 inheritMemory，加 step7.5 描述；`11-squad.md` 路径 2 验证点改述「derive 复制父成员个人 AGENTS.md（非记忆）」。
- **PRD overall**：`08-squad-studio.md` v2.2 §8.2 B 行 + §8.3 路径 2 + §8.7 v0.0.169 承接行删 inheritMemory，注明 Derive 区 toggle 已删（dead UI）。
- **UI overall/components**：`06-studio.md` §9 + `components/studio-page/member-create.md` Derive 区描述删 inheritMemory toggle。
- **Academy KB**：`[P1]squad_derive.md` §2.1 CreateMemberInput 删 inheritMemory 字段 + §6 边界表 derive mode 描述改述（加「复制父成员个人 AGENTS.md」）。
- **inheritMemory grep 闭合**：`grep -rn inheritMemory specs/` 排除 version_logs/archive 后仅剩 2 处——均为 overall 文件 header/路径段的版本标注删除注释（`[v0.0.250] ... inheritMemory ... 已删`），遵循 overall 文件既有惯例（类比 `[v0.0.158] summaryModelDefault ... 整删` 注释），无功能性引用残留。
- **app-guide**：`00-app-guide.md` 无 inheritMemory / member-create toggle 提及（Group C dead UI 未渗透到导航手册），跳过。
- 详情：`specs/tech/version_logs/v0.0.250/change_plan.md`

## 2026-08-03 · v0.0.244 member_bench_filter（消费点 bench 过滤 + UI 视图筛选 toggle）

spec `design.md §9.2` 早已写明「UI 隐藏 benched 成员即可（数据层不动）」但从未落地——本版本在**消费点**补上 bench 过滤，分两类：①认知/协作层（`team_roster`/`reachable_agents`/mention search）只看 deployed（reachable 过滤修真 bug：bench 无心跳不运行，列为 `send_message` 对端无意义）；②UI 默认在岗视图（`SeatsPanel` `deriveViewRows` active 分支 `state==='deployed'`）+ roster 头视图筛选 toggle（在岗/全部）让用户按需查下岗 + 复用现有菜单 deploy 恢复。**数据层 `listMembers` 不动、leader team tool 零改（保留管理全视角）**。

- **`[P1]prompt_sections.md §3.2`**：team_roster 加 bench 过滤约束——渲染前在 `readRoster()` 单点过滤 `state !== 'benched'`（duck-typed 容缺失值防旧数据全灭）；数据源与渲染格式不变。
- **`[P1]prompt_sections.md §5`**：reachable_agents 标题去「不变」改「deployed-only」+ 派生表各分支 `all mates`/`peers` 改 `deployed mates`/`deployed peers` + 加 bench 过滤段落（单点 `readMembers()` 过滤，派生表零改自动收缩，修真 bug）。
- **`[P1]squad_tools.md §2`**：① `list` action 入参 `filter?: {state?, type?}` 标 spec-only 未落地（impl `runList` 直接全量无 filter）——已知漂移诚实记录；② member 状态机段「UI 隐藏 benched 即可」改述为「各消费点过滤 benched（数据层不动），team tool list 例外保留全量」。
- **`index.md ④#12`**：新增核心设计原则「bench 过滤分层（消费点过滤，数据层不动）」——认知/协作层/UI 默认/mention 只看 deployed；管理工具 team tool + UI 视图筛选全部保留全量；判据分层（plugin duck-typed `!== 'benched'` vs web 强类型 `=== 'deployed'`，生产等价）。
- **代码↔spec 偏离核实**：① team_roster.ts/reachable_agents.ts 过滤判据 `state !== 'benched'`（duck-typed）与 spec 记录一致 ✅；② web 侧 `deriveViewRows` 严格 `=== 'deployed'`（Member.state 类型必填）与 spec 记录一致 ✅；③ 过滤单点（roster→readRoster / reachable→readMembers / UI→SeatsPanel deriveViewRows）与 spec 记录一致 ✅；④ 零改项（member-provider/squad_team_status/team-tool/squad-store/session-config/seat-card-menu/seat-row）`git diff dev1` = 0 行 ✅；⑤ component-seats-view-switch/body/panel 三组件 spec 由 coder 编码前置产出 + 顺手修既有漂移（seats-body 原 props 漂移/panorama-route 归属），doc-modifier 复核对齐 ✅。
- **UI overall**：`00-app-guide.md §3.2` + `06-studio.md §3.1` 补 roster 头视图筛选 toggle（在岗/全部）入口 + 计数口径（=当前视图行数，跟随视图）。
- 详情：`specs/tech/version_logs/v0.0.244/change_plan.md`

## 2026-08-03 · v0.0.243 task_entity（task 改普通 entity + system 标记 + lazy migration）

task 从 v0.0.240 的「builtin 通道」hack（代码声明 + 不进 schema 响应 + 前端镜像合成 = 一个谎引出的补丁链：get_schema 看不到 task + 前后端双份定义已漂移 + readEffectiveSchema 复杂度）彻底纠正为**普通 entity + system 标记**：task 落盘进 squad schema（和 book 平级，get_schema 可见）+ `system:true` 标记（leader 不可 edit/delete，防 hook/reminder 崩）+ lazy migration（schema-read chokepoint `ensureSystemEntities` 幂等注入）。删 readEffectiveSchema 合并 + 前端镜像 + effective/raw 两套 schema。配套 UI 追加：事件流默认收起 + 「更多」固定 tab 恢复（v0.0.240 删的 PanoramaIdle 引导恢复）。

- **`[P1]panorama_builtin.md`** 改写为「普通 entity + system 标记 + lazy migration」权威：task EntityDef 加 `system:true`；新 `system-entities.ts`（`SYSTEM_ENTITY_DEFS` canonical 注册表 + `injectSystemEntities` define 注入 + `ensureSystemEntities` lazy migration chokepoint）；删 `effective-schema.ts`（readEffectiveSchema 合并废除）+ 删 `BUILTIN_ENTITY_DEFS`/`BUILTIN_VIEWS` 常量；task-hooks `afterTaskWrite(store)` 签名简化（drop squadId/dataDir）；新 `validation/validate_system_entity.ts:checkSystemEntityImmutable`（leader 改 task 字段 → `panorama_system_entity_immutable`）。system 标记三段闭环（parser 不识别 system + check 拒字段漂移 + inject 强制覆盖）+ inject 时序反直觉（`validate → inject → applyMigration`）+ system-wins 冲突策略。
- **`[P1]panorama_dsl.md`**：§4 加 `system?: true` 字段（§4.5）——parser 不识别、仅由 inject 程序化设值。
- **`[P1]panorama_tools.md`**：§2.1 define 加 system entity inject 时序（validate → inject → applyMigration）；§2.2 get_schema 返含 task 的 DSL（不再 null，ensure 兜底）；§4 错误码加 `panorama_system_entity_immutable`。
- **`index.md`**：① panorama 行改 v0.0.243 普通 entity + system 标记；⑤ 导航 panorama_builtin.md 改 v0.0.243 标注。
- **API `specs/api/overall/14-panorama-endpoints.md` v1.4**：GET schema 返含 task 的 DSL（v0.0.240 返纯 leader DSL 不含 builtin，v0.0.243 返含 task）；PUT schema 落盘含 task；validate / PUT 加 `panorama_system_entity_immutable` 错误码；§2.1 task entity 409 例外改述（system ensure 兜底，不再「builtin 前端镜像」）；§2.4 归档字段来源改述（普通 entity 字段，非 builtin 通道）。
- **UI（`specs/ui/components/studio-page/`）**：`component-panorama-idle.md` un-deprecate（v0.0.243 恢复组件——白卡引导 + @leader 按钮 + onAtLeader 回调）；`component-panorama-route.md` 重写 tab 装配（dynamicViews + 固定「更多」tab 永远最右 + activeTab==='more' 渲 PanoramaIdle）+ onAtLeader optional→required + 删 mergeBuiltinSchema/BUILTIN_VIEWS 引用；`component-panorama-view.md` 事件流默认 collapsed=true（v0.0.243 改，之前默认展开）。
- **UI overall**：`00-app-guide.md §3.2` panorama 行改述（task 普通 entity + system 标记，不再「builtin schema 通道 / 代码声明」）；`06-studio.md §4` tab 装配改述（删「无更多 tab / 无 PanoramaIdle」+ 删「前端镜像 builtin 合成」）。
- **代码↔spec 偏离核实**：change_plan §3 决策「schemaOr409 删 BUILTIN 短路」实际代码用 `SYSTEM_ENTITY_DEFS[entity]` 短路（system entity 永远放行）——语义重命名（旧 BUILTIN 概念废，新 SYSTEM 概念立），spec §1.1/§2.1 已对齐代码「system ensure 兜底」表达。其余 6 设计决策（lazy on read / system-wins / system 三段闭环 / define inject 时序 / validate_system_entity 位置 / afterTaskWrite 签名）核实与代码一致。
- 详情：`specs/tech/version_logs/v0.0.243/change_plan.md`

## 2026-08-02 · v0.0.240 squad_task（轻量任务机制 = panorama builtin entity + reminder 注入 + 首页改造）

task = panorama **builtin schema**（首个固定 entity），全景第一个固定「任务」tab；不造专用工具——agent 用通用 `panorama(action, entity=task)` 操作；task 状态走 reminder 注入（挂 SystemReminderPoint，与 squad/member reminder 并列）；依赖全自动（waiting ⇄ todo 后置 hook，source=system）。配套首页 IA 改造（tab 改名 / 4宫格→token 小组件 / 成员计数减队长 / 全景内嵌第二栏）+ panorama 三前置增强（view.filter / 归档 / builtin schema 通道 / field 中文）。

- **新增 `[P1]panorama_builtin.md`**：builtin schema 通道权威——task EntityDef（id/title/description/owner ref member/dependencies/status 4 态/archived boolean）+ StatesDef（todo→[in_progress,waiting] / waiting→[todo] / in_progress→[done] / terminal=[done]）+ task_kanban view（4 列、filter archived:false、display 配死中文）+ readEffectiveSchema() 单一 chokepoint 合并（builtin 优先 + prepend views）+ afterTaskWrite() 自动依赖 hook（source=system）+ 5 条核心不变量（builtin 只在 read 层合并 / effective schema 单一 chokepoint / 自动 transition 不走用户路径 / reminder 复用 SystemReminderPoint / 不造专用工具）。
- **`[P1]panorama_dsl.md`**：§5 加 view.filter 声明（field:value 精确匹配 + 多键 AND，前端 fetch 透传 `?filter=`）+ §5.0 归档约定（entity 声明 archived:boolean + view 加 filter）。frontmatter related 加 panorama_builtin。
- **`[P1]panorama_overview.md`**：§2 概念表加 builtin entity + view.filter 两行；§5 设计原则加 #7（builtin 只在 read 层合并）+ #8（归档靠字段+filter，panorama 无内置 archive）。
- **`[P1]squad_reminder_providers.md`**：新增 §4 `squad_task` provider（角色 filter：leader 全队 / mate owner∪依赖）+ 数据源（SquadContextService.listActiveTasks 新增方法）+ 产出格式（`[squad:tasks]` 标头 + owner_name join + status_label 中文 + 依赖提示）；§5 角色矩阵加 squad_task 行；§8 边界加 task builtin 引用。原 §4-§7 顺移 §5-§8。
- **`index.md`**：① 概念表 panorama 行补 v0.0.240 builtin 标注；⑤ 导航加 panorama_builtin.md 行。
- **API `specs/api/overall/14-panorama-endpoints.md`** v1.3：GET schema 注明 builtin task 由前端镜像合成（DSL 返纯 leader 文本）；GET entities 注明 view.filter 透传 + task entity 永远 defined（409 例外）；PATCH 补归档（普通字段更新）+ task 自动依赖 hook（source=system SSE）；§5.2 新增 v0.0.240 PRD 路径映射。
- **首页改造（UI spec）**：tab「坐席」→「首页」/ 4宫格 SeatStats → token 小组件（点击进 token-stats）/ roster「坐席·N」→「成员·N」（N 减队长）/ PanoramaRoute 从独立路由（`MainView kind=panorama`）改为首页第二栏内嵌（删 onBack + 头部返回键）；TeamEntryRow 整组件废（被 token 小组件取代）。详 `specs/ui/components/studio-page/`（coder 编码前置产出组件 spec）。
- **代码↔spec 偏离核实**：v0.0.237 已删 task/goal/requirement/board 全链路，本版本 task 是全新 builtin entity（与旧 task 工作项无继承关系，命名复用但语义全新）。`component-panorama-route.md` / `component-team-entry-row.md` / `component-panorama-view.md` 三处过时已修。**实现期决策偏离架构 spec（doc-modifier 核实已对齐）**：
  - **owner=string（非 ref→member）**：架构 spec §2.1 标「owner ref → member」；T1 实现 `task-schema.ts:39 owner: { type: 'string' }`——理由：member 不在 panorama DSL entities map（SchemaDef 管理），ref 会触发 `panorama_unknown_ref_target`；reminder 层做软解析（join memberStore 取 name）。前端镜像 `panorama-types.ts:174` 同步对齐 string（避免前端 ref 字段拉 member 404）。spec §2.1 已改齐。
  - **dependencies=string+pattern（非 ref[]）**：架构 spec §2.1 标「ref[] → task max=50」+ 「coder 决策点」开放；T1 实现 `string + pattern`（DSL v1 无 ref[] 类型）+ hook.parseDeps split 解析。**max 不一致（已知）**：server `task-schema.ts:42 max=500`（权威校验）、前端镜像 `panorama-types.ts:175 max=50`（仅渲染，前端不校验）——校验在 server 侧，前端值偏小不影响功能（极少写 50+ 依赖）。spec §2.1 已改齐。
  - **afterTaskWrite 签名**：架构 spec §4 标 `(squadId, store, triggerId)`；实际 `(squadId, store, dataDir)`——dataDir 用于 readEffectiveSchema 展开 panorama_dir，triggerId 不参与扫描（hook 全量重算）。spec §4 已改齐。
  - **i18n 路径**：change_plan 字面 `app/web/src/i18n/locales/plugin-config.json` + task 描述 `app/web/src/locales/{zh,en}/studio.json` 均不精确；实际 = `app/web/src/i18n/locales/{zh-CN,en}/studio.json`（tab/roster/tokenWidget/task.status_labels）+ `app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json`（squad_task.description，中英同步）。无 `_locales/*/messages.json`（plugin 用 `__MSG_*__` 占位解析走 plugin-config）。
- 详情：`specs/tech/version_logs/v0.0.240/change_plan.md`

## 2026-08-02 · squad file watcher 功能整体删除

squad 级后台 file watcher（`squad_filewatch.md` 权威的功能）整体删除——用户从不需要，且它退化成 per-file fs watcher 泄漏数千 fd，是 bash 工具 spawn EBADF 的根因。

- **功能删除**：`app/server/src/squad/filewatch/` 整目录（squad-file-watcher.ts + path-router.ts + 测试）删除；`SquadRuntime` 删 `fileWatchers` Map / `ensureFileWatcher()` / ensureScheduler·stopAll·disposeSquad 中的 watcher 生命周期；`SquadRuntimeDeps.budgetAggregator` 僵尸依赖一并删（仅 watcher 用，bootstrap 同步）。
- **schema/API**：`SquadSchema.enableFileWatch` 字段删（存量 record 残留字段惰性透传，无 migration）；PATCH /squad body + SquadSummary/SquadDetail 回显删 `enableFileWatch`；`SchedulerHistoryEntry.reason` 收窄为 `'heartbeat'`（删 `path` 字段）；`HistoryEntry` 同步收窄，存量 history.jsonl 历史 file-changed 条目读盘时过滤。
- **tick-message**：`TickMessage.reason` 收窄 `'heartbeat'`（删 `path`）；`buildTickUserMessage`（file-watch 唯一调用方）删除；`buildHeartbeatTickMessage` 心跳路径不变。
- **UI**：`component-file-watch-toggle.tsx` 删除；autowork tab 去该开关；`section-auto-work-history` 删 file-changed path 渲染；i18n 删 `studio.fileWatch` 块 + `autoWorkReason.fileChanged`（中英同步）。
- **spec**：`[P1]squad_filewatch.md` 删除（mv soft_deleted）；`index.md`（①②③⑤）/ `[P1]scheduler.md`（§8/§9/§11/§12/§13）/ `[P1]squad_workspace.md`（§5/§9）/ `11a-squad-endpoints.md`（§1.5/§4）同步；`../scheduling/[P1]heartbeat_handler.md` §6（file-watch 复用考量）整节删 + `buildTickUserMessage` 提及清理；`../agent/session/[P0]session_workspace_manager.md` 三处引用清理。
- **保留边界**：session workspace 前台 watcher（`workspace-dir-watcher.ts`，UI 刷新用）不动；前端 workspace `file-changed` reducer 链路是 session 概念，与 squad file-watch 无关，保留。

## 2026-08-02 · v0.0.237 studio squad 体系减法（删 task/goal/requirement/charter/board 全链路，留 todo/panorama/member）

纯减法版本——给 studio squad prompt 体系做减法，无新功能、无 DB migration（全文件型 JSON 存储）。

- **`index.md`**：① 是什么 + 概念表——删 charter/workitem 三层/OKF 双轨/reminder(charter/tasks/board)，加 todo + reminder 改（todo/team_status/workspace），panorama 去掉"与硬编码 board 并列共存" + action 数 7→8；② 边界——去 charter_history entity/工作项三层/工具收敛去 task/goal/requirement；③ schema 路径去 charter_history；④ 原则——删原 #2 OKF 双轨 / #3 工具只碰 store / #4 强约束（task CAS/DAG）/ #9 三态可见性 / #10 统一关联链路 / #11 health 进度 / #12 编辑感知 / #17 board 四面对齐，新增"okf 可选文档组织建议"原则（#2），保留 AgentLoop 零改/system prompt 不落 DB/proactive reactive/inputSchema/static-by-type/SquadChat 转发/team 硬删除/skill overlay/心跳 presence/member service 单源（重新编号 1-11）；⑤ 导航——删 squad_workitems/squad_archive/squad_store_projection 三退役文件行，squad_okf 改"轻量建议"，加 panorama_*.md 行。
- **`[P1]squad_definition.md`**：§0 去 charter 提及；§1 squad 定位去 charter + 加"leader 接需求→拆解→@mate 分配"；§2 Squad interface 删 `charter: Charter` 字段；§5 Charter 整节改写为「角色分工（leader 协调/mate 执行）」；§8/§9/§10 去 charter_history/CharterHistory/charter 投递方式提及。
- **`[P1]squad_tools.md`**：整文件重写——删 §3 task/§4 goal/§5 requirement/§5.6 WorkStatus 三工具章节、§2.1 update_charter 工作流、§2.2 v2 只读细分、§8.5 query detail 读面、§0/§1 强约束（CAS/DAG/状态机）；team 工具表现 8 action → 6 action（去 update_charter/get_charter）；保留 team/agent/presence 三工具 + 通用约定（inputSchema 契约/权限/错误码，去 lastWriteMessageId task/goal/req 部分）。
- **`[P1]squad_workitems.md` / `[P1]squad_archive.md` / `[P1]squad_store_projection.md`**：**三文件退役**（mv 到 `soft_deleted/v0.0.237/`）——工作项三层 / 三态可见性 / store 投影 schema 随 task/goal/requirement/board 全链路删除而失效。
- **`[P1]squad_okf.md`**：整文件重写——OKF 双轨制（md 主面 + store json 投影 + 6 type schema + 字段映射）降级为「okf 文档组织建议」（轻量非强制，type 自由命名，无投影关系）；priority P1→P2。
- **`[P1]squad_workspace.md`**：§1 目录布局——删 charter.md/charter_history/board/ index.md OKF 主面提及，加 `交付/`+`temp/` 轻量建议目录；§2 各目录职责删 charter/charter_history/board 行；§4 可见性去 charter 对 mate 不可见 + board 透明只读，改"工作目录产出读写"；§5 file-watch 去 board 路径；§6 onboarding 去 board/charter 步骤；§7 解散删除——删 charter_history/panorama/board 工作项行（charter_history/charter.md 标"存量残留清理"），保 交付/temp/outputs/reports；§8/§9 去 store 投影/工作项/charter 引用。
- **`[P1]squad_reminder_providers.md`**：整文件重写——删 §2 squad_charter/§3 task/§4 squad_board 三数据变化型 provider + §5 shouldProduce 去重逻辑（三 provider 都删）+ BUG-001 块；保留 squad_workspace + squad_team_status 两 provider（重编号 §2/§3）+ §0 定位 + §1 ReminderCtx（删 listGoals/listRequirements/listTasks/getSquad，留 listMembers + isSessionRunning）+ 角色矩阵 + injector 触发。
- **`[P1]data_model.md`**：§1 标题"三 entity"→"两 entity"；§1.1 Squad schema 删 `charter: {...}` + `lastWriteMessageId?`（charter 用）字段；§1.3 charter_history entity 整节删（§1.4 session 重编号 §1.3）；§3 存储布局——删双轨说明 + charter.md/charter_history/board 目录树 + §3.1 store 投影整节；§4 createSquad 删 charter 入参 + board 骨架；§6/§7 去 CharterHistory/charter 乐观锁提及；§1.2 workStyle 豁免引用"四面对齐 #17"→"agent 工具面显式豁免"，原则 #5/#8 → #3/#6。
- **`[P1]prompt_sections.md`**：§0 头部 + §1 概述——删 charter/squad_charter/squad_tasks/squad_board 提及，贡献点总表去三 provider 行 + 加 squad_workspace/squad_team_status 行；§3.1 squad_role——leader/mate 人设去 task/charter/KR 提及，改"接需求→拆解→@mate 分配"；§4 reminder——删三 provider，留 workspace+team_status；§6 动态变化行去 charter/tasks/board；§8 双轨心智模型整节改写为「工作目录组织建议（okf 轻量）」；§9 plugin.json 注册去三 impl；§10 边界去相关行。
- **`[P1]agent_leader.md` / `[P1]agent_member.md`**：整文件重写——定位去"持 charter/拆 OKR/任务驱动/task"；§2 prompt 链去 charter/tasks/board；§3 tools——leader 去 task/goal/requirement/update_charter，mate 去 task/requirement/goal/get_charter + 加 todo/panorama；§4 context 去 charter/board/task；§6 可见性去 charter/board；§8 升级去 charter.escalation/update_charter；§9 衔接去 charter/squad_workitems。
- **`[P1]squad_filewatch.md`**：标题/定位/§1 监听路径——去 board；§2 start() 注释去 board；§3 路由去 board/ 分支（仅留 reports→leader + outputs→owner）；§4 debounce 举例去 board/tasks；§7 监听范围——删 board/** glob + OKF md+store json 双触发说明，加 交付/temp/** 监听；§9 文件清单 + §10 边界——teamwork-mate skill 引用改 mate.md prompt。
- **`[P1]session_config_studio.md`**：§0 头部参考 + §1 studioContext 数据源 + §3 builtin skill 列表 + §4 leader/mate 取字段 + §7 边界——charter/teamwork-leader/teamwork-mate 提及去除（"四面对齐 #17"→"agent 工具面豁免"，原则 #5/#8 → #3/#6）。
- **`[P1]agent_squad_chat.md`**：§3 tools 去 hire/bench/edit/update_charter/任务管理；§4 context 去 charter/task/workspace；§6 可见性去 charter/board 行（留 panorama）。
- **`[P1]panorama_overview.md`**：定位去"与硬编码看板并列共存"；§1 对比表删 board 列；§3 UI 路由态去 `{kind:'board'}`；§5 原则 2/3 去 board 对比；§6「与现有看板的关系」改写为「与 squad 工作目录的关系」（panorama = 唯一业务数据看板体系）。
- **`[P1]panorama_store.md`**：§1.2 数据隔离 + §2 不建 SchemaDef——去"board OKF md 双轨/不复用 board store"对比提及。
- **`agents_comparison.md`**：整文件重写——对比矩阵删 charter 可见/board 读写/task 视角/goal·requirement·task 工具行，team 改 6 action，加 presence/todo/panorama/工作目录产出行；prompt 链表删 charter/tasks 行；一句话区分改"接需求/拆解/分配/跟进/收交付"。
- **代码↔spec 偏离核实**：charter 字段（handlers/squad.ts:80 `SquadDetail.charter` 类型字段）+ 几处注释 cosmetic 残留（runtime-context.ts:16 / context-types.ts / squad-reminder-deps.ts:78 / migration clean-squad-summary-model-default）为死代码/历史注释，不影响功能——产品代码层面小残留，spec 已对齐代码现状（toDetail 函数体不投影 charter）。
- 详情：`specs/tech/version_logs/v0.0.237/change_plan.md`（L8 文档同步范围 + 偏离章节）

## 2026-08-01 · v0.0.232 团队 workspace 简化（删个人 ws）+ squad_role 文案单盘化

- **`[P1]squad_workspace.md`**：① §1 布局——`workspaces/{memberId}/` 标【已废止·存量保留】，新增根 `AGENTS.md`（团队）+ `.rocky/agents/{名字}-{memberId}.md`（个人差异）；「团队 workspace 简化模型」段：全 squad session workspaceDir 统一指向 `squads/{sid}/`，存量不迁移不清理；② §2 职责表 + §4.1 可见性矩阵（个人工位维度消解）+ §5 workspace 行 + §6 onboarding step2 + §7 dissolve 表述同步。
- **代码配套（change_plan）**：squad-service/member-service workspaceDir 赋值改 `squadRootDir`；squad-store `ensureSquadDirSkeleton` 删 leaderMemberId 参数与 workspaces mkdir 分支、`ensureMemberWorkspaceDir` 整删；derive_academy seed 落点重映射（AGENTS.md→`.rocky/agents/`，skills/memory→团队层）；`prompts/content/squad/{leader,mate}.md` 双盘模型文案重写为单盘（在位干活，删「个人盘→团队盘搬运交付」）。
- 详情：`specs/tech/version_logs/v0.0.232/change_plan.md`


> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-30 · v0.0.223 task reminder 改名收窄（squad_tasks → task）+ squad_board 滤 OKR/req

- **`[P1]squad_reminder_providers.md §3`**：task reminder provider implId `squad_tasks` → `task`（plugin.json + 标头 `[squad:tasks]` → `[task]` 独立 const；文件名 `squad_tasks.ts` + i18n key `squad_tasks.description` 保留降资源漂移）；filter 由 `assignee=me` 扩为 **`assignee=me ∪ assignee=null`**（我认领 ∪ 待认领池，零新 schema 字段/零新 action，无「关注」概念）；shouldProduce 加 `scanPrefix:'[task]'` 覆盖（改名后 dedup transcript 扫描同步）；血缘 join（task.source → requirement → goal）保留。§5/§6/§7 同步（标头例外 + 角色矩阵行改名）。
- **`[P1]squad_reminder_providers.md §4`**：squad_board reminder 产出层**滤掉 goals/requirements 只留 tasks 段**（OKR/req 后端 store/工具 impl 全留，feature gate `__FEATURE_OKR__` 默认关长期保留决策；task 血缘仍 join 显示）；生产侧 BUG-001（不产出 board 块）仍待独立版本修复。
- **配置层连带**：studio-leader/mate/squad profile toolBound 摘 goal/requirement 工具（运行时配置层，非 gate）；`scopes/default.yaml` system_reminder impls `squad_tasks` → `task` 同步（ScopeConfigValidator 启动期校验）。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：`squad_tasks.ts` TASK_HEADER='[task]' + filter `assignee===null||undefined||memberId` + scanPrefix 覆盖与 spec 一致；`squad_board.ts` 仅产 tasks 段与 spec 一致。无偏离。
- 详情：`specs/tech/version_logs/v0.0.223/change_plan.md`（C/D 节）

## 2026-07-26 · v0.0.205.t2_cons（`.rocky_squad/` → `.rocky/` 收口 + group 层 memory/skills 同构）

- **`.rocky_squad/` 全量改名 `.rocky/`**（`.rocky/` = rocky app 数据在对象 ws 里的存放位置）：squad-store 建队骨架 `.rocky/state/`；scheduler-state（scheduler.json）/ scheduler-history（history.jsonl）/ budget-state（budget-state.json）路径全迁；filewatch `IGNORED_DIR_NAMES` `.rocky_squad`→`.rocky`（Set 精确段匹配）。存量 squad 由 MigrationManager `squad-rocky-dir` handler 平移（memory 拆 per-entry + state/skills 复制 + 空后删旧目录）。同步文件：`[P1]squad_workspace.md`（§1 目录树/§2 职责表/§5 持久化/§7 解散删除表/§9）、`[P1]data_model.md §3`、`[P1]scheduler.md`（state 路径群）、`[P1]squad_filewatch.md`（ignored）、`design.md §9.4`、`index.md` 原则 14。
- **group 层资源同构**：squad ws 的 `.rocky/memory/<name>.md`（group scope 记忆 per-entry md）+ `.rocky/skills/`（group 级 skill，合并优先级 group > workspace > app > builtin）——与 classroom ws 同构，解析唯一点 `agent/group-dir.ts resolveGroupWsDir`（详见 `../agent/memory/index.md` 原则 15 + `../agent/skills/index.md` 原则 3）。

详情：`specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md`（模块 A2/A5）

## 2026-07-23 · v0.0.192.delete_cleanup（删除链路修正 — 保留工作产出 + 级联删子孙 session + 清调度）

- **`[P1]squad_workspace.md`**：新增 §7「解散删除边界」——`dissolveSquad` 第④步由 `rmSync(squadRootDir)` 连根删改为 `deleteSquadAdministrativeSubpaths`（与 `ensureSquadDirSkeleton` 同文件对称）。判据 = 用户看得懂的产出留 / 程序才懂的内部数据删（req 决策原则）。**保留** `workspaces/` `outputs/` `reports/` `board/`；**删** `members/` `charter_history/` `panorama/` `.rocky_squad/` 四目录 + `charter.md` `index.md` `log.md` 三文件（均 force:true 幂等）。§8/§9 同步重编号；§9 待定「解散归档策略」标已决（v0.0.192 决，详 §7）。
- **`index.md ④#14`**：team 硬删除原则更新——step② 改 `listSessionsBySquad` 平铺快照（含 spawn children）逐个 `deleteSession`；step④ 改 `deleteSquadAdministrativeSubpaths`（保工作产出）。增加 `squad_workspace.md §7` + `[P1]cron_subsystem.md §8` 引用。
- **代码对齐验证**：`deleteSquadAdministrativeSubpaths`（squad-store.ts:241）实际删/留与 spec 一致 ✅；`dissolveSquad`（squad-dissolve.ts:44）顺序 + listSessionsBySquad 快照 + deleteSquadAdministrativeSubpaths 调用点与 spec 一致 ✅；`handleSessionItem` DELETE 分支级联（handlers/session.ts:233）collectDescendants 先于 deleteSession ✅；每 descendant 均经 `deleteSession` → `onSessionDestroyed`（session-store-core-impl.ts:296）→ boot.ts:259 wire 清内存 cron ✅。无代码偏离 spec。
- **API**：`specs/api/overall/11a-squad-endpoints.md §1.5`（dissolveSquad 行为契约更新：保留工作产出 + 级联删子孙 + onSessionDestroyed 触发）；`specs/api/overall/04-agent-session.md §2.4`（DELETE /session 级联删子孙语义）。
- **关联**：scheduling KB `[P1]cron_subsystem.md §8` 补级联删场景每 descendant 触发 onSessionDestroyed 的说明（机制不变，只让级联路径走多次）；agent/session KB `[P0]session_store.md §4` 补 `collectDescendants` + `listSessionsBySquad` 两个新 facade API 契约。
- 详：`specs/tech/version_logs/v0.0.192.delete_cleanup/change_plan.md`

## 2026-07-22 · v0.0.189.dsl_board Task#7 增量同步（doc-modifier，用户实测诊断 + BUG-001/002/003 修复对齐）

- **`panorama_tools.md`**：action 表 7→8 补 `delete`（entity+id，实例物理删除 + `entity.deleted` 审计事件，HTTP 无端点）；§2.1 define 补 data_safety 闭环（migration/approved 意图 → deferDataSafety 跳 L4；L4 拦截后按 suggestion 重提 approved:true 自动迁移或附 migration 显式控制，narrow_enum 需 mapping）；§2.4 update 补状态机守护（patch 触碰 states.field 且值变化 → 走 transition 校验：合法放行/非法拒绝/同值幂等）；§4 错误码补 `panorama_migration_postcheck`；权限矩阵补 delete 行。
- **`panorama_http.md`**：PUT schema 补 deferDataSafety 语义 + postcheck 错误；POST validate 注明恒跑 L4 预警；PATCH 补状态机守护；§5 错误表补 `panorama_migration_postcheck`。
- **`panorama_validation.md`**：§1.1 补 `ValidationOptions.deferDataSafety` 选项（L4 让位 migration 引擎，v0.0.189 生产实证死路修复）；§5 拦截后路径改写为「按 suggestion 重提 approved:true / 附 migration」。
- **`panorama_migration.md`**：新增 §6.4 迁移后校验（post-validate）+ 回滚——operations 执行后受影响实体逐实例过 validateInstance，不过则全量回滚 + `MigrationPostValidationError`（violations 上限 20、入口截 10；delete_entity 目标跳过）。
- **`specs/api/overall/14-panorama-endpoints.md`** v1.2：PUT 行为补 deferDataSafety + postcheck 步骤与错误；POST validate 恒 L4；PATCH 状态机守护；注明实例删除仅工具 delete action。
- **UI 组件 spec**：`component-panorama-entity-modal.md` v1.3 措辞对齐——PATCH 语义是「走 transition 校验（合法跃迁放行）」非「一律拒绝」（BUG-003 旧措辞）；`component-panorama-view.md` 核对无需改。
- **bugs/**：BUG-003 修法措辞对齐「走 transition 校验」语义（文件名 [fixed] 已由 reviewer 改好）。

## 2026-07-22 · v0.0.189.dsl_board 文档同步（阶段 5 doc-modifier，代码对齐）

实现验证通过后把 panorama 7 份 spec 对齐代码事实（697 UT + AT + ET 全绿后同步）：

- **`panorama_dsl.md`**：§4.3 guard 从字符串表达式改为结构化对象 `{field, op, value}`（op ∈ eq|ne|gte|lte|gt|lt|in|not_in）；§5.5 插值正则改复合式（`{{...}}` 转义优先，捕获组重编号）；§6 护栏删 `panorama_limit_ref_depth`（深度 1 由模板语法结构保证）；§4.2 string.max 删「默认 500」（缺省不限长）+ 非 finite 措辞收窄为 NaN。
- **`panorama_http.md`**：§4.1 SSE topic 设计重写——topic=`panorama`（hub 静态注册类别，单源 bootstrap-bus-phase `PANORAMA_TOPIC`）+ per-squad group 路由键 `panorama:squad:{id}:entity`（hub 不支持动态 per-squad topic；对齐 session_panel 模式）；§5 错误码补 `panorama_migration_mismatch`(400)。
- **`panorama_validation.md`**：错误码表全面对齐实现——专用码 `panorama_missing_label`/`panorama_missing_id_field`/`panorama_missing_ref_entity`/`panorama_missing_view_config` 统一为通用 `panorama_missing_field`（path 定位）；`panorama_invalid_component`→`panorama_invalid_view_component`；补 schema 层 `panorama_{duplicate_enum_value,enum_name_collision,guard_unknown_field,invalid_max,invalid_range,invalid_color}` + 语义层 `panorama_{group_by_not_enum,unknown_sort_field,terminal_has_outgoing}` + transition 层 `panorama_{no_state_machine,unknown_entity}` + warnings（`panorama_warn_{unknown_display_key,missing_column}`、`panorama_meta_default`）。
- **`panorama_validation.md` / `panorama_http.md` / `panorama_migration.md`**：dryRun/validate 口径对齐——Layer 4 在 dryRun 也执行（有 oldSchema+store 时）；validate 端点/dryRun 只返 `ValidationResult`（ok/errors/warnings），不返「完整变更分析」对象。
- **`panorama_store.md`**：接口名对齐实现（listInstances/getInstance/putInstance/deleteInstance/hasId + 便捷写入 4 方法）；counters 文件 `.state/counters.json`（非 panorama-counters.json）；实例顶层 `lastWriteMessageId`；事件 `id/source/messageId` 为顶层字段（非 payload）+ 补 `entity.deleted` + tail 读法语义；补 `.state/` 目录；标注 m3 遗留「写入返回 seq」未实现（留后续版本）。
- **`panorama_migration.md`**：§3.2 补第 7 个 handler `clip`（tighten_constraint，number min/max 截断）+ transform 白名单枚举；§5 审计示例字段名对齐（`migration_strategy`/`affected_instances` + 顶层 source/messageId）。
- **`panorama_tools.md`**：§2.7 events 补 tail 语义；§4 错误码补 `panorama_migration_mismatch`。
- **`panorama_overview.md`**：§2 概念表 meta/team→meta/version；§3 SSE topic 改静态 topic + group 路由键。
- 配套：`specs/api/overall/14-panorama-endpoints.md` v1.1（SSE 订阅方式/409 响应体/PanoramaEvent 字段/migration_mismatch）+ `specs/ui/overall/06-studio.md` SSE 行 + 4 组件 spec（route/view props 对齐 entityEvent 透传、onSchemaUpdate 未采用；modal props 整传 entityDef + refOptions/onToast；idle hue=violet）。

## 2026-07-22 · v0.0.189.dsl_board（Panorama 业务全景 — agent 可搭建的 DSL 看板系统）

- 新增 `panorama_overview.md`（concept）：Panorama 子系统总起——定位（与 board 并列共存、数据隔离、agent 作者）、核心概念（DSL/实体/视图/状态机/校验/迁移/事件流）、边界、设计原则（规则唯一源=DSL / 不建 SchemaDef / SSE 复用现有基建）。
- 新增 `panorama_dsl.md`（interface）：DSL 规范权威——meta/version/entities/views 完整 schema + 6 字段类型集 + 状态机（transitions/terminal/guard）+ card 模板插值（ref 嵌套 + fallback + 编译期校验）+ 护栏。
- 新增 `panorama_store.md`（interface）：存储布局 + 泛化实体 store——`panorama/{board.yaml, entities/{entity}/{id}.json, events.jsonl}` + 不建 SchemaDef（动态实体走泛化 KV + DSL 注册表）+ CrudStore FS engine 复用 + lastWriteMessageId 语义。
- 新增 `panorama_validation.md`（interface）：四层校验引擎——语法（短路）→ schema（收集）→ 语义（收集）→ 数据安全（破坏性判定）+ 实例写校验 + transition 校验 + 错误码表。三路写入共用（决策 6）。
- 新增 `panorama_migration.md`（interface）：迁移引擎——增量自动 / 破坏性须方案 + handler 策略（archive/purge/drop/mapping/default/transform）+ 审计日志 + 用户介入门槛（重大/次要）+ 原子性/幂等/备份。
- 新增 `panorama_tools.md`（interface）：`panorama(action)` 单工具——7 action（define/get_schema/create/update/transition/query/events）+ inputSchema.properties=LLM 参数契约 + 权限矩阵 + 错误码。
- 新增 `panorama_http.md`（interface）：HTTP + SSE 端点——/squad/:id/panorama/* 路由 + SSE topic=panorama:squad:{id}:entity（复用现有 SSE 基建）+ 事件 shape。
- API：新增 `specs/api/overall/14-panorama-endpoints.md`（端点表 + payload + 响应 + 行为 + 错误码，AT 唯一依据）。
- UI：新增 4 组件 spec（component-panorama-route/view/idle/entity-modal）+ 更新 `_overview.md`（MainView 加 panorama 路由态）+ `06-studio.md`（§2.2a 全景路由 + team-entry-row 第三 link）。
- change_plan：`specs/tech/version_logs/v0.0.189.dsl_board/change_plan.md`（10 模块 method 级变更契约）。

详情：`specs/tech/version_logs/v0.0.189.dsl_board/change_plan.md`

## 2026-07-18 · v0.0.169.member_page（hire 扩 workStyle + team.hire 剔除守卫 — 配合成员创建页主区化）

- **`[P1]data_model.md §1.2c/§5`**：`createMemberService`/`HireMemberBody` 加 `workStyle?`——fresh 直传（`trim()` 回写，空串=回写空串无 400，不传=缺省无）；derive 默认复制父 workStyle，`overrides.workStyle` 覆盖（trim 回写，空串=清空）——语义对齐 v0.0.142 PATCH 口径。「仅用户可编辑」四面对齐豁免声明同步：HTTP 面从「仅 PATCH」扩为「PATCH + hire」。
- **`[P1]squad_tools.md §2`**：`team.hire` 补充守卫——derive `overrides` 是裸 object schema 挡不住 LLM 塞 `workStyle`，`team-write-actions.ts runHire()` 服务端显式剔除（抽共享 `dropWorkStyle` helper，`runEdit`/`runHire` 共用），守「workStyle 仅用户可编辑」不变量（原仅 `runEdit` 剔除 patch）。
- **`index.md ④#17`**：workStyle agent 工具面豁免措辞同步——剔除面从 `team.edit` 扩为 `team.edit` + `team.hire`（derive overrides）。
- **不动**：member schema（workStyle 字段 v0.0.142 已存在）/ derive 记忆复制语义 / 事务 8 步 + 补偿回滚。前端配套（创建页主区化 + 编辑页删任务区）见 `specs/ui/overall/06-studio.md` v1.11 + `specs/ui/components/studio-page/member-create.md`。
- 详情：`specs/prd/version_logs/v0.0.169.member_page/change_log.md` + `specs/api/overall/11a-squad-endpoints.md` v1.7 §2.1

## 2026-07-16 · v0.0.158.compact_model_resolve（删「独立 summary 模型」层 — squad schema 字段整删）

- **`[P1]data_model.md §1.1` squad 删两字段**：`summaryModelDefault?: string` + `summaryModelDefaultProviderId?: string` 整删（schema `SquadSchema.fields` 同步）；`modelDefault` + `modelDefaultProviderId` 保留（chat/compact 同链读此字段）。§1.1 说明段更新（原「summaryModelDefault 与 modelDefault 正交独立」段整段替换为「字段族已整删 + 存量由 migration handler 清理」）。
- **`[P1]session_config_studio.md §3` studio session modelId 解析**：`resolveModel` 入参签名去 `task` + `bodyOverride*` 三字段；studio 单链措辞 = `session.{modelId,providerId?} → resolveDefaultModel() → squad.modelDefault → throw`（chat/手动 compact/自动 compact/T1 记忆整理都走此链）；新增「入口收敛」段说明所有 forked run 走 `agentManager.resolveConfigBySid(sid)`。
- **`[P1]squad_store_projection.md` 无需改**（本 spec 不涉字段 schema 细节，只描述 store 映射；字段删由 §1.1 schema 层承担）。
- **不动**：squad 事务 8 步 + 补偿回滚 / squad_charter / squad_tools / squad_workitems / scheduler / heartbeat（本版本改的是「summary 模型」字段族，squad 数据模型 + 事务 + 工具链 + 调度全无变化）。
- 详情：`specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md §G`

## 2026-07-16 · v0.0.155（session 中心化 + ModelRef 复合 — member.model 硬删 + squad 加 providerId 配对字段）

- **`[P1]data_model.md §1.1` squad 加复合字段**：`modelDefaultProviderId?: string` + `summaryModelDefaultProviderId?: string`（与 modelDefault / summaryModelDefault 配对作复合 ModelRef；optional back-compat）。校验：providerId 非空但配套 modelId 空 → 400 `providerId without modelDefault`。SquadDetail response 回显（不省 key）。
- **`[P1]data_model.md §1.2` member.model 硬删（A4 决策）**：Member entity `model` 字段完全删除（不保留 dead）。理由：① resolver 不再读它（A3 → v0.0.155 INV-A1），字段变 dead；② 保留 = 死代码；③ 保留作「新建 session 初始值」引入新链路复杂度不划算（picker 直接 updateSession）。存量 record.model 字段读侧忽略（lazy 无 migration）；写侧永不再落盘。member 退管理概念（name/role/intro/workStyle/tools/skillConfig），运行配置（model/effort/approval）全跟 session。
- **`[P1]data_model.md §5 createMemberService`**：`model?` 入参删除；`overrides` 去 `model?`（与 `squad_tools §2` hire 入参对齐）。
- **`[P1]session_config_studio.md §3 modelId 行`**：studio chat 链从 v0.0.113 修正的 `bodyOverride → sessionModelId → member.model(leader/mate) → squad.modelDefault → throw` 改为 `bodyOverride → session.{modelId, providerId?} → resolveDefaultModel('chat') → squad.modelDefault → throw`（**member.model 已硬删，不再参与链**，session 是 model 唯一运行配置读源，与 effort/approvalMode 同款 INV-A2）。`resolveModel` 入参去 member（INV-A2）。
- **API `specs/api/overall/11-squad.md §4.5`**：provider/model 解析路径改写——`bodyOverride → session.{modelId, providerId?} → squad.{modelDefault, modelDefaultProviderId?} → throw`（**member.model 已硬删**）；hire/PATCH member body.model 旧 client 传 → warn+ignore 非 400；squad `modelDefaultProviderId` / `summaryModelDefaultProviderId` optional back-compat；PUT /session/:id body `{providerId?, modelId?}` 复合（picker 走 session 不走 patchMember，INV-D1）。AT 路径 4 可变字段收敛为 `name/skillConfig/intro/workStyle`。
- **UI `specs/ui/components/chat-page/component-input-model-picker.md`**：§11 字段表升级复合 ModelRef（`session.{modelId, providerId?}` / `squad.{modelDefault, modelDefaultProviderId?}`），member.model 行删除；新增 `defaultModelProviderId?: string` prop（精确显示默认 provider name，消除同名歧义）；§12 新增「v0.0.155 session 中心化 + ModelRef 复合变更」节（写入路径迁移 + default 显示升级 + INV 落实）。
- **新增 UI spec**：`specs/ui/components/chat-page/base-chat-page.md`（page 级 base，骨架 + slot，INV-E1）+ `specs/ui/components/chat-page/base-chat-input-bar.md`（input 级 base，slot + HITL 分流，INV-E2）+ `component-chat-topbar-right.md`（topbar right DRY，三页共用，INV-E4，待补）。
- 详情：`specs/tech/version_logs/v0.0.155/change_plan.md`（段 A-F + INV-A1~A5/B1~B3/C1/D1~D2/E1~E4）

## 2026-07-16 · v0.0.154（member.model 纯 modelId 纠错 — squad KB 零改动 / spec 同步对齐）

- **`[P1]session_config_studio.md §3 modelId 行` 零改动**：v0.0.113 已记 `squad.modelDefault` 纯 modelId + 前端读侧 `parseModelRef` bug 修复（§70 修正记录）；本版本发现 `member.model` 是漏网同款——前端 member-chat 调用点（`component-member-chat-input-bar.tsx`，v0.0.152 从 `section-member-chat.tsx` 拆出）写入侧错配（PATCH body `providerId/modelId` 斜杠）+ 读侧也用 `parseModelRef`（与 v0.0.113 `squad.modelDefault` 读侧同款 bug）。squad KB 本身零改动（resolve 链正确、不涉 squad store/HTTP schema），仅 spec 文档层对齐：picker 写入侧改纯 modelId + 读侧 `findProviderIdByModelId` 反查。
- **跨 spec 对齐**：`specs/ui/components/chat-page/component-input-model-picker.md §11`（PATCH body `{model: '纯 modelId'}` + 读侧反查）+ `specs/api/overall/11-squad.md §4.5`（同款契约）+ `[P0]model_resolve.md §4 原则 3`（权威）三处统一 `member.model` = 纯 modelId 契约。
- 详情：`specs/tech/version_logs/v0.0.154/change_plan.md`

## 2026-07-15 · v0.0.153（BUG-004：readSessionType 'rocky' 归一化修复 — playground standalone identity 正文缺失回归）

- **`squad_reminder_shared.ts readSessionType()`**：加 `k.role==='rocky' → undefined` 归一化分支，对齐同文件 `readSessionKind()` 注释语义（L111：`!sessionType`/standalone 等价 `!kind`（kind 不存在 / `role==='rocky'`））。修前实现直接 `return k.role`，`'rocky'`（truthy）导致唯一反向判定消费方 `identity.ts`（`if (!sessionType)` 判 standalone）落入 else 分支返空——playground 场景 identity.md 正文整段丢失（system prompt 只剩 rules/tool_guidance/skills）。其余 11 个消费方（`rules`/`squad_role`/`squad_charter`/`squad_tasks`/`squad_board`/`squad_workspace`/`squad_team_status`/`reachable_agents`/`parent_task`/`team_roster`）全是正向匹配特定角色字符串，`'rocky'` 与 `undefined` 对这些判断完全等价，无回归。
- **`[P1]prompt_sections.md §2`**：补充实际实现细节 callout——`config.sessionType` 字段已不存在（v0.0.56 起由 `config.kind` 取代），Option A 分流实际读 `readSessionType(ctx)` 派生值；standalone 归一化契约说明。
- 验证：`squad-reminder-providers.test.ts` 新增 6 case 直测归一化（rocky/无kind/isSubagent 优先/leader-mate-squad 不变）；`prompt-studio.test.ts`/`mapper-delegate.test.ts` 补 IdentityMapper 对 `kind.role='rocky'` 落 Rocky 正文回归用例；受影响 6 测试文件共 112 test 全绿。packaged-verifier 复验：playground system prompt 修复前后对照 3568→4117 字符，identity 锚句恢复且居首（priority 1000），rules/tool_guidance/skills 零回归（`states/v0.0.153/verify/packaged-verify.md` §BUG-004 修复复验）。
- 详情：`specs/tech/version_logs/v0.0.153/change_log.md`

## 2026-07-15 · v0.0.152（studio 单聊接入 effort/审批模式 picker + 补审批卡 — squad KB 零改动）

- **`session_config_studio.md §2/§3` 引用核实，零改动**：v0.0.148 起 `buildSessionConfigFromDeps` 已不分 scope 读 `session.effort`/`session.approvalMode`（studio 与 playground 走同一 chokepoint），本版本纯前端补 studio leader/mate 单聊 UI 挂载点（effort/审批模式 picker + 补渲染 `component-pending-approval-card` 修 `need_approval` 悬挂缺陷），**squad KB / server 端零变更**。详见 `specs/ui/components/studio-page/{member-chat-page,component-member-chat-input-bar}.md` + `specs/prd/version_logs/v0.0.152/change_log.md`。

## 2026-07-14 · v0.0.142（member `workStyle` 工作方式字段 — 仅用户可编辑 / 仅注入个人 session）

- **`[P1]data_model.md §1.2` + 新增 §1.2c**：Member 加 `workStyle?: string`（optional）——intro 的孪生字段，但两点差异：① 注入面唯一 = `squad_role` mapper leader/mate 分支（个人 session），MUST NOT 进 team_roster；② 可空无校验（空串=清空，`patchMemberService` `trim()` 后回写不 throw，区别 intro 的空→400）。§1.2c 声明「仅用户可编辑」= 四面对齐 #17 显式豁免（覆盖 store/HTTP/UI 三面，故意不覆盖 agent 工具面）。
- **`[P1]prompt_sections.md §3.1`**：squad_role 契约补 workStyle 追加段——`map()` 仅 leader/mate 分支 build 后追加 `\n\n## 我的工作方式\n\n{ws}`（`readMemberWorkStyle` duck-typed，空则不追加无悬空标题）；MUST NOT 碰 team_roster/members[]。
- **`[P1]session_config_studio.md §4`**：`studioContext.member` 是完整 MemberRecord，新增 schema 字段（workStyle）自动流转，bootstrap 注入逻辑不改；恒指自己 → 天然「仅个人 session」。
- **`[P1]squad_tools.md §2` team.edit**：workStyle 不在 patch 白名单——`TEAM_INPUT_SCHEMA.patch` 裸 object schema 挡不住 LLM 塞入，`runEdit()` 服务端显式剔除 `workStyle` 再 cast（兜底绕过「仅用户可编辑」）。
- **`index.md ④#17`**：exemption 登记 workStyle agent 工具面豁免。
- **API `specs/api/overall/11a-squad-endpoints.md`**：§1.3 `Member` + §2.2 `PatchMemberBody` 加 `workStyle?`（可空/空串=清空/无 400；hire 不含；仅用户可编辑）。
- **UI `specs/ui/components/studio-page/member-panel.md`**：profile Card intro 下方多行 `member-workstyle-input` textarea（复用 TEXTAREA + i18n `workStyleLabel`/`Placeholder`）；testid 保留列表加行。

详情：`specs/tech/version_logs/v0.0.142/change_log.md`

## 2026-07-13 · v0.0.128（team 工具 member 写 action 接入 — 兑现 v3 豁免）

- **`[P1]squad_tools.md §2` team 8-action 全表落地**：`hire / deploy / bench / edit` 4 个 member 写 action 接入 tool 层（`TEAM_ACTIONS` 扩为 8 元素，`index.md ④#17` 豁免消除——member 四面 store/HTTP/UI/tool 全覆盖）。§2.2 标 v0.0.128 已落 + 代码路径（`team-tool.ts → team-write-actions.ts → member-mutations.ts → MemberStore.putMember`）。
- **`[P1]squad_tools.md §2` edit patch 字段修正**：`{ skillConfig?, tools?, model?, heartbeat? }` → `{ name?, skillConfig?, model?, intro? }`（删 dead `tools?` v0.0.48 / `heartbeat?` v0.0.116，加 `intro?`/`name?` 对齐 data_model §1.2 实际可编辑字段）。
- **`[P1]squad_tools.md §2` bench 通知改 final text**：删「系统自动 send_message 通知 user」→ 改「leader 在 caller session final text 告知 user」（v0.0.128 用户裁决，对齐 update_charter §2.1；tool/HTTP 层 bench 只写 state 不发 send_message）。§10 TBD bench 通知项标已决。
- **`[P1]squad_tools.md §2` hire 入参**：deriveFrom/roleId 注明接受 id 或 name（tool 层 `resolveMemberId` 解析，与 query.ref 同语义）；overrides 去 dead tools。
- **`index.md ④` 新增 #18 核心设计原则**：member 写 action 经 service 层单源（member-mutations.ts + createMemberService），HTTP handler 与 agent tool 共享同一业务校验，禁 inline 复制（三路同源 invariant）。
- **`[P1]data_model.md §1.2`**：Member entity 加 `lastWriteMessageId?: ulid`（agent tool 写时填，HTTP 不传 = undefined）。§5 createMemberService overrides 去 dead tools。§7 TBD #3（derive overrides 字段集）/ #4（bench 通知形态）标 v0.0.128 已决。
- **`[P1]squad_store_projection.md §2.2`**：lastWriteMessageId 适用对象从 goal/requirement/task/squad 扩到 + member。

详情：`specs/tech/version_logs/v0.0.128/change_plan.md` + `specs/prd/version_logs/v0.0.128/prd.md`

## 2026-07-11 · v0.0.117（board 数据四面对齐 invariant）

- **`index.md ④#16` 新增核心设计原则「squad/board 实体数据四面对齐」**：字段与 action 须 store ↔ HTTP API ↔ UI（列表+编辑）↔ agent tools（读+写）四面同步覆盖 + 与 spec 一致；单面不覆盖须 spec 显式声明豁免+理由，禁静默单面演进；派生约束「所见即所得」（列表字段编辑视图可编辑）+「承诺即真收」（tool description 承诺参数 inputSchema/handler 真实接收）。教训引用 v0.0.117 审计（Goal description 编辑丢失 / KR.status 三方不可达 / task create 静默丢 priority·deadline）。
- **`[P1]squad_tools.md §0` + `[P1]squad_store_projection.md §0`** 各加一行指向该 invariant（工具写面 / store 面须四面对齐）。
- **`[P1]squad_tools.md`**：① §3/§4/§5 三工具 query 加 `detail?:boolean` 入参（默认 false 精简、true 返长文本+KR 明细，§8.5 新增）；② §4 goal.edit 白名单补 body + KR body/deadline/status（`status` 走状态机校验）；③ §4.1 新增「health 重算共享派生 `applyKrPatchWithHealth` invariant」（agent==HTTP 两通道一致，落 `handlers/board-shared.ts`，复用 `stores/board-store` barrel re-export 的 derive*）；④ §8.5 新增 query detail 读面 + reminder 长文本豁免声明。
- **`[P1]squad_workitems.md §2.2`**：加「两通道 health 重算一致 invariant」（agent goal.edit == HTTP PATCH /krs 复用 `applyKrPatchWithHealth`）。
- **`[P1]squad_reminder_providers.md §5`**：显式声明 reminder 不注入长文本为四面对齐豁免（token 成本，query detail 兜底）。

详情：审计报告 `specs/research/v0.0.117-entity-field-alignment.md` + `specs/tech/version_logs/v0.0.117/change_plan.md`

## 2026-07-11 · v0.0.116（心跳升级 squad 级统一调度 + member presence）— 概念先行 pass

- **心跳粒度 per-member → squad 级**（`data_model.md §1.1a`）：新增 `squad.heartbeatConfig{interval(5/15/30/60,默认15), activeWindows[](多段/不重叠/不跨0点/空=全天), scope{mode:all/whitelist, memberIds}}`；`member.heartbeat` 标 **dead**（schema 留字段停读写）。budget `null=off=不限量` 语义显式化（现有 gate 天然对齐）。调度权威 `../scheduling/[P1]heartbeat_handler.md §0`：一 squad 一 job，队级 gate 后逐成员（scope∩deployed∩非busy）投递**固定心跳提示词**（含 `<EOS>` 出口句，零机制改动）。
- **member presence**（`data_model.md §1.2b`）：`member.currentWork{text,updatedAt}|null` 自由文本每人一条；独立 `presence` 工具（set 覆盖/clear 取消，leader/mate 可用，SquadChat 不需要，`squad_tools.md §6a`）。
- **leader team-status**（`squad_reminder_providers.md §4.6`）：新增 `squad_team_status` reminder provider（leader only），system prompt「团队当前状态」段只列 session 正在 running 的成员 + presence 标记（`prompt_sections.md §3.1/§4`）。
- `squad_autonomy.md §3-§7` 心跳配置/归属/Scheduler 伪码/budget off-on 更新 squad 级；`agent_leader.md`/`agent_member.md` 心跳段改「参与 squad 级」+ presence 工具/维护句。
- **API**：废弃 `PATCH /squad/:id/member/:mid/heartbeat`；squad 心跳配置走 `PATCH /squad/:id`（加 heartbeatConfig）+ GET 回显；presence 走工具写 + `SquadDetail.members[].currentWork` 回显（`11a`）。

详情：`specs/tech/version_logs/v0.0.116/change_log.md`（发布说明 + 设计原则）+ 同目录 `change_plan.md`(+part2)

## 2026-07-11 · v0.0.114.opts（member `intro` 一句话介绍）

- **`Member` 加 `intro` 字段**（`[P1]data_model.md §1.2` + 新增 §1.2a 设计决策 / `[P1]squad_definition.md §3`）：一句话角色介绍，渲染进 Team Roster 花名册行尾。**schema `required=false` + 业务分角色约束**：fresh 建 mate 必填（`member-service resolveEffective` 校验，空→400 `intro required`）/ leader 建队用固定模板 `DEFAULT_LEADER_INTRO='团队负责人，统筹协调与任务分派'`（`squad-service`）/ derive 继承父（`overrides.intro ?? parent.intro`）。schema 宽容是为容忍历史无 intro 的 member record 走 PATCH read-modify-write 不炸。
- **`[P1]prompt_sections.md §3.2 team_roster`**：花名册渲染格式加 intro——`- {name}({role}) (sessionId: {sid}) — {intro}`；intro 随完整 MemberRecord 从 bootstrap→`studioContext.members` 整记录透传流入；缺省优雅降级不显分隔符。
- **`specs/api/overall/11a-squad-endpoints.md`**：`Member` + `HireMemberBody.fresh` 加必填 `intro`（derive overrides.intro 可选）；前端 HireModal fresh 表单 intro input（systemPrompt 从 hire body 移除，后端 seed）；hire 错误补 `fresh 缺 intro → 400`。
- 顺带修 `[P1]squad_definition.md §3/§4` 残留 `systemPrompt`（v0.0.33.3 已在 entity 层移除，概念表未清）。

详情：`specs/tech/version_logs/v0.0.114.opts/change_log.md`

## 2026-07-11 · v0.0.113（成员 skill overlay 重构 + studio modelId resolve 真相修正）

- **`[P1]data_model.md §1.2`**：`Member.skills: string[]`（D4 交集白名单）**推翻重写**为 `skillConfig: { mode:'inherit'|'custom', overrides: Record<string,boolean> }`（不兼容旧数据，用户拍板；旧 `skills` 字段删）。新成员默认 `{mode:'inherit', overrides:{}}`（off/继承全局）。`CreateMemberInput.skills?` → `skillConfig?`；derive 不再复制父 skill 白名单。
- **`[P1]session_config_studio.md §3/§3.2`**：studio skills 取法从 **D4 交集**（`catalog ∩ member.skills`）改 **overlay**——workspace 层恒生效（R2）；builtin/app 层 inherit→全局 enabled、custom→全局叠加 overrides（R1/R3）。旧 D4 缺陷：占位死数据 + 面板保存清空 → 交集恒空。**builtin 与 app 层同治**（角色区分改由 `squad_role` mapper + tool-policy 保证，非 skill 白名单）。代码：`handlers/session-config.ts:buildSessionConfigFromDeps` studio skills 块。
- **spec↔code 修正（modelId）**：`session_config_studio.md §3` modelId 行原写「D5 回退链 ... ?? app_config 默认」为 **stale**——早在 v0.0.89 被 `resolveModel` 取代，**studio 完全不读 `app_config.default_models`**。已对齐到 resolveModel 真相（chat 链 `bodyOverride → sessionModelId → member.model(leader/mate) → squad.modelDefault → throw`）。`session-config.ts:134` 同款 stale 注释一并对齐。`squad.modelDefault` schema `required` 非空、存盘纯 modelId、建队 seed 全局默认——「团队继承全局」= 建队一次性 seed，运行期恒具体值，resolve 恒命中（澄清「对话能 resolve 到默认」）。
- **API 契约**（同步 `specs/api/overall/11a-squad-endpoints.md`）：Member.skills → skillConfig；HireBody / PatchMemberBody `skills?` → `skillConfig?`。影响 member/squad AT。
- 详情：`specs/tech/version_logs/v0.0.113/change_log.md` + `change_plan.md`

## 2026-07-10 · v0.0.111（工作项三态可见性 + team 硬删除 + reminder 团队 workspace）

- **`[P1]squad_archive.md`**：升级为「三态可见性」——§1 新增 `effectiveCancelled` 派生 + cancel 联合检查（`self.status==='cancelled' ∨ 任一祖先 cancelled`，与 `effectiveArchived` 同结构、各看各字段；`board-archive.ts.effectiveCancelled` 为 cancel 级联单一权威，reminder/tools/board-read 三通道复用）；§3 由「UI-Agent 两层规则」升级为**三态×三通道矩阵**（active/archive/cancel × reminder/工具/UI）——cancel 优先级最高（全通道不可见），archive 只隐 reminder+UI 活跃区。§4 dependsOn 降级覆盖 cancel。
- **`[P1]scheduler.md §9`**：新增 `SquadRuntime.disposeSquad(squadId)` per-squad 运行时 teardown 语义（abort 在跑 loop → unregisterHeartbeatJobs → 停 file-watcher → 清 per-squad 状态；幂等；MUST NOT engine.stop）；「squad 不可删 → scheduler 生命周期=进程」表述改为可硬删 + disposeSquad 先于删数据（防潜伏调度）。
- **`[P1]data_model.md §1.1`**：squad「建了永久存活/不可删」→ **可硬删除（解散团队）**：`DELETE /squad/:id` → `dissolveSquad`（disposeSquad→删各会话→deleteSquad→rmSync 办公室目录，顺序不可颠倒）；session+历史物理删不可恢复。§3 `_archived/` 目录说明改为硬删不留痕。`[P1]squad_definition.md §8` + 角色对比表同步（「squad 不可删」→ 可整体硬删；member 仅随 team 解散删）。
- **`index.md`**：④核心设计原则 item 9 升级三态双联合检查 + 新增 item 14（team 硬删 teardown 先于删数据）；概念表 + 导航同步。
- **`[P1]squad_reminder_providers.md`**：新增 §4.5 `squad_workspace` provider（leader+mate 团队盘根路径 `dataDir/squads/squadId`，与个人 `workspace.ts` 并存，静态路径不走 shouldProduce）；§6 角色矩阵 + §12 边界同步。
- **`[P1]squad_tools.md §3`**：三工具 `query` filter `{...archived?, readable?}` → `{...includeArchived?}`；默认滤 `effectiveArchived ∨ effectiveCancelled`，`includeArchived=true` 保留 archive 仍滤 cancel。§0 修正旧「过滤不在工具层做」措辞（v0.0.60 漏实现的现状 bug，v0.0.111 在 runQuery 补齐）。
- **代码-spec 核对**：effectiveCancelled 单一权威被 reminder(filterReadableBoard/isTaskReadable)+3 tool runQuery+board-read 复用 ✅；dissolveSquad 顺序 teardown→deleteSession→deleteSquad→rmSync ✅；abortSession 封装 MODE_KEY_CURRENT ✅；squad_workspace 角色 filter + 缺 dataDir/squadId 返空 ✅。全部一致，无代码偏离 spec。

详情：`specs/tech/version_logs/v0.0.111/change_log.md`

## 2026-07-08 · v0.0.89（squad summaryModelDefault 字段新增）

- **`[P1]data_model.md §1.1`**：`Squad` interface += `summaryModelDefault?: string`（optional，空=回退 `modelDefault`）。**正交独立于 `modelDefault`**——`modelDefault` 是默认会话模型；`summaryModelDefault` 是默认整理（compact）模型。`resolveModel` 在 studio summary 链第 4 行（squad session）/第 6 行（leader/mate session）优先读此字段（详见 `../agent/providers_and_models/[P0]model_resolve.md §3`）。
- **CRUD 语义**（同步 `[P1]squad_store_projection.md` + API 11a-squad-endpoints）：POST body 接受 `summaryModelDefault?: string`（具体 ModelRef → validateModelId 校验，保留字 `default` 放行；空串/undefined=不配）；PATCH body 单独清字段（空串 `""` = 写 undefined，不影响 `modelDefault`）；SquadDetail response **即便 undefined 也回显字段**（不省 key，对齐 v0.0.89 决策 3「无 null 输出」—— JSON.stringify 默认 omit undefined）。
- **代码落点（T3 已 verified）**：`schema_defs/squad/squad.ts` SquadSchema += summaryModelDefault optional（required:false，无校验）；`services/squad-service.ts` CreateSquadInput 透传（service 层镜像 modelDefault 模式补一层 defense-in-depth 校验，与 change_plan D 段「MUST NOT service 层校验」字面冲突但 reasonable——与既有 modelDefault 同款，无副作用）；`handlers/squad.ts` handleCreateSquad + handlePatchSquad 接受字段 + checkModel helper DRY（保 ≤300 行）+ toDetail 回显字段。
- **AT 覆盖**：`tests/api/multi_agent/squad_summary_model` (P9) 4 case：POST 不传→response undefined / POST 具体值→回显 / PATCH 单独清字段不影响 modelDefault / PATCH 保留字 `default` 放行。全绿。

详情：`specs/tech/version_logs/v0.0.89/change_log.md`

## 2026-07-07 · v0.0.86.mention_refactor（看板 @按钮回路签名重构对齐 mention display）

- **看板 @按钮回路签名重构（R3 升级）**：`BoardAtMentionButton` props 从 `(type, path)` 改 `(kind, id, label)`；`onAtMention` 签名 `(payload: BoardMentionPayload {type:'workitem', kind, id, label}) => void`；`useBoardAtMention.onAtMention` 据此构造完整 `MentionAttrs` 含 display 三字段（icon===kind，label=entity.title）—— leader 对话 prefill pill 显 title 而非裸 id（v0.0.68 R3 prefill 缺 display 致 pill 显 `workitem/task/T-0001` 的回归 bug 修）。4 board view caller（goals-view/task-card/requirements-view/tasks-view）+ squad-board prop 类型透传，无逻辑改动。`squad-board.md` Props + testid 表 v0.0.86 行同步；`component-board-at-button.md` 重写 v2.0。
- **不变量**：仅签名对齐 + 补 display；不引入新 API、不改 testid（`squad-board-{entity}-{id}-at-mention` 保留）；不向后兼容（旧 caller 传 path typecheck 红强制迁移）。

详情：`specs/tech/version_logs/v0.0.86.mention_refactor/change_log.md`（模块 3） / `change_plan.md`

## 2026-07-07 · v0.0.85.ui_opt（SquadChat 3 段转发模板 + 删硬编码 router prompt）

- **F3 占位符改代码注入（修 LLM 原样 echo `{squad.name}`）**：F3 real-LLM 验证暴露——squad_chat.md `### 说明` 段的 `{squad.name}` 占位符被 LLM 当字面量原样输出（同模板的中文描述性占位符如 `{sender 标识}` `{一字不差的 user 原文}` LLM 正确理解并填充，但 `xxx.yyy` 点号 brace 看起来像程序 token 被当字面量）。修法：占位符改 `{{squad_name}}`（对齐 `PromptHandler.fillTemplate` 的 `{{identifier}}` 约定），SquadRoleMapper 加载期从 `ctx.config.studioContext.squad.name` 取实际群聊名注入（squad chat session 的 studioContext.squad 必填，bootstrap line 519 已注入）；`SquadChatContentHandler.build` 跑 fillTemplate。LLM 收到的是替换后的字面值，不再 echo 占位符。
- **`[P1]agent_squad_chat.md §2` 补「3 段转发模板」**（F3）：SquadChat 把 user 消息转发给 member 时 content 含 3 段结构化模板——`### 说明`（来自群聊 `{{squad_name}}` + 由 SquadChat router 转发 + 按 needReply 决定是否回复 + 回来源 session）/ `### 原文`（来自 `{sender}`——user 显「user」/ member 显 `{name} ({sid})`，原文一字不差）/ `### 相关上下文`（群聊相关上下文，可概括改写）。**Invariants 不变**：转发仍是 send_message 的 content text blocks（不扩 a2a §5 消息体）；sender 永远是 SquadChat 自己（reply 走 to=sender.agent.ref 必回群聊）；needReply 是顶层字段不进 content（默认 true，v0.0.68 R5 已落地）；squad_chat 红线不变（不改写 user 原文、不创作 answer）。
- **`[P1]agent_leader.md` / `[P1]agent_member.md` 补「收到 SquadChat 转发处理」段**（F3）：收到按「### 说明」段决定是否回复；回复走 `send_message(to=SquadChat)`（即 sender.agent.ref）即回群聊；不接受原文外二次转述。
- **删除 `handlers/session-config.ts` 的 `STUDIO_SQUAD_ROUTER_SYSTEM_PROMPT` 硬编码常量**（F3 消除矛盾）：原 A 路（squad_chat.md mapper 注入）vs B 路（硬编码当 systemPrompt）矛盾——B 路删除后 squad router 的 systemPrompt 由 system-prompt-builder 经 squad_role mapper 注入 squad_chat.md（与 leader.md/mate.md 同链路，对齐架构原则「单一 system prompt 构建链」）。grep 0 残留 + 测试更新（session-config-studio.test.ts 补 squad 同款 systemPrompt='' 占位注释）。
- **needReply 默认 true**：v0.0.68 R5 已实现（send-message-tool.ts schema + normalize `?? true` 兜底），本版纯 spec 同步——`a2a_protocol.md §4.2` 已是 default:true；doc-modifier 阶段 5 同步 subagent_derivation §5。

详情：`specs/tech/version_logs/v0.0.85.ui_opt/change_plan.md`

## 2026-07-05 · v0.0.68.squad_ui_3（看板一等公民手动新建 + 看板 @按钮 → leader 对话预填）

- **看板一等公民手动新建（R1）**：复用 v0.0.60 已有 POST 端点（`/squad/:id/board/{goals\|goals/:gid/krs\|requirements\|tasks}`），后端 API **零变更**；缺口仅在 web 侧（api client create helpers + UI 表单 + empty-state CTA）。`component-board-edit-panel.tsx` 加 `mode:'create'\|'edit'` 复用既有全字段表单；form state + handleSubmit 拆 `use-board-edit-form.ts` hook（保 ≤300 行）。Task 强制先选父 Requirement（D1-b UX 约束，非 schema 约束——API 仍要求 source.requirementId 必填）。
- **看板 @按钮 → leader 对话预填（R3）**：board workitem 卡片（goal/kr/requirement/task）加 `@` 按钮 → 切 leader 单聊 + 输入区 prefill `<mention type="workitem" path="workitem/<kind>/<id>"/>` pill。回路：`component-board-{*-view,task-card}.tsx` → `component-squad-board.tsx` → `component-studio-board-route.tsx` → `page-studio.tsx`（MainView.chat variant 加 `prefill?: MentionAttrs[]`）→ `component-studio-chat-router.tsx` → `section-{squad,member}-chat.tsx` → `component-chat-composer.tsx`（加 `initialContent?: MentionAttrs[]` + `insertMention(attrs)` ref API）。
- **不变量**：复用 v0.0.60 POST 端点（不发明 API）；squad 群聊 ModelPicker per-call override 语义不动（仅显示派生自 squad.modelDefault，R6 修 bug）。
- `[P1]squad_workitems.md` 数据模型零变更（v0.0.60 已含全字段 + 联合归档）；squad_store_projection / squad_tools 等零变更。

详情：`specs/tech/version_logs/v0.0.68/change_log.md` §R1/R3

## 2026-07-04 · v0.0.60.squad_ui_2（看板可编辑 + 联合检查归档 + 统一关联链路 + body/priority/deadline + 动态 health）

- **新增 `[P1]squad_archive.md`**：归档机制拆出独立 spec——联合检查模型（`readable`/`effective_archived` 派生，不落库）+ 祖先链（按 O→KR→Requirement→Task 推导）+ UI/Agent 两层规则分家 + 横向 dependsOn 断链降级 + 恢复语义（聚合自动级联 / 叶子向上检测）+ 编辑感知（下次启动重建，无实时 event）。
- **`[P1]squad_workitems.md`**：§1 Task source 统一为 Requirement（`unified_task_source`，去 kind 二选一）；§2.2 重写 KR health 算法为**进度×时间动态**（无 deadline 回退静态）+ 新增 Goal completion%（KR 算术平均）；§3-§5 各实体 interface 加 `body?`（长正文 markdown）+ `archived/archivedAt?/archivedBy?` + KR/Task 加 `deadline?` + Task 加 `priority`；§3 Requirement `relatedGoalId`→`relatedKRId`（字段废弃）；§5 Task.source 去 kind；§8 看板视图改「列内按 priority→updatedAt 排序」（替代 assignee 分组）+ zone 切换；§10 TBD 划掉（health 阈值 / Goal completion% 算法已定）。
- **`[P1]squad_store_projection.md`**：§1.1-§1.3 各实体 schema 加 `body?`/`priority`(Task)/`deadline`(KR+Task)/`archived`/`archivedAt?`/`archivedBy?`；§1.2 Requirement `relatedGoalId`→`relatedKRId`；§1.3 Task.source 去 kind（统一 `{requirementId}`）；§3 派生字段策略加 `readable`/`effective_archived`/`completionPct`（响应层算不落库）；§4 边界引用 squad_archive.md。
- **`[P1]squad_reminder_providers.md`**：§0 加 v0.0.60 说明（归档项 filter `readable==true` 不进 reminder；编辑感知下次启动重建）；§3 squad_tasks 数据源 filter `readable==true` + dependsOn 降级；§4 squad_board 同；source 血缘链改为统一关联链路。
- **`[P1]squad_tools.md`**：§0 加 v0.0.60 说明（统一 source schema + 新字段 + archive/duplicate action）；§3 task 加 `edit`/`duplicate`/`archive`/`restore` action（duplicate 复制 source/assignee/deadline；status=pending；priority=none；不复制 dependsOn）；§4 goal + §5 requirement 同加 archive/restore + edit patch 含 body/deadline；§4 create_kr/create_objective 加 body?/deadline? 入参；§5 requirement `relatedGoalId`→`relatedKRId`，promote_to_goal 回填链路改 relatedKRId；query 各工具默认 filter `readable==true`。
- **`index.md`**：④核心设计原则加 4 条（archive 联合检查 / 统一关联链路 / health 动态 + Goal completion% / 编辑感知）；workitem 概念表更新；⑤导航加 squad_archive.md。

详情：`specs/tech/version_logs/v0.0.60/change_log.md`

## 2026-07-03 · v0.0.58.cron（调度器抽象到 scheduling/ — SquadScheduler retire）

- **`[P1]scheduler.md`**：顶部加迁移指针；本文保留作 v0.0.33.4 心跳设计**迁移基线**（gate chain + 重启续接 + 持久化 schema）。1s 轮询机制 + SquadScheduler class + tryFire gate chain 全部迁出到 `../scheduling/`（新 KB：`[P0]engine.md` + `[P0]job_registry.md` + `[P1]heartbeat_handler.md`）。
- **`squad-runtime.ts` 内部改造**：`ensureScheduler/reloadSquad/reloadRole/stopAll` 改为 engine.register/unregister heartbeat jobs；对外接口签名不变。
- **`scheduler.json` schema 不动**（v0.0.33.4 落盘数据零迁移，HeartbeatPersistenceAdapter 包装现有 SchedulerStateStore）。
- **回归红线**：详 `../scheduling/[P1]heartbeat_handler.md §4`（6 项 v0.0.33.4 不变量）。

详情：`specs/tech/version_logs/v0.0.58.cron/change_log.md`

## 2026-07-03 · v0.0.56（SessionKind 统一 session 身份维度）

- **`[P1]data_model.md §1.4`**：session 增量字段 type/bizType→role/derivation/biz（必填）；§4 createSquadService 写入路径同步更新。
- **`[P1]session_config_studio.md §2`**：SessionConfig 字段 sessionType/bizType→kind（SessionKind）；§4 studioContext 注入判定从 `session.bizType==='studio' && session.type!=='subagent'`→`isStudioMainSession(kind)`。

详情：`specs/tech/version_logs/v0.0.56-session_type/change_log.md`

## 2026-07-03 · v0.0.56 hotfix（SessionKind 彻底迁移对齐）

- **`[P1]data_model.md`**：narrative 旧字段名订正——§1.4 命名体系注（type→SessionKind）；§2.3 biz lazy 默认→必填；§2.2/§5 session 创建路径 type/bizType→role/biz/derivation。
- **`[P1]session_config_studio.md §3.1`**：tools 取法 `resolveTools(role=...)`→`resolveTools(kind)`（role 由 kind.toolPolicyRole 派生）。

详情：`specs/tech/version_logs/v0.0.56-session_type/change_log.md`（hotfix 节）

## 2026-07-02 · v0.0.48（去 leader/mate tool 可配置 → static-by-type）

- **`data_model.md §1.2`**：Member.tools 标 deprecated/dead（保留 entity 字段避免 migrate；session-config 不再读，旧值不读不写）；§5 `createMemberService` 入参 tools 标 accept-and-ignore（hireBody 同）。
- **`agent_leader.md §3`**：leader 工具集 = `TOOL_POLICY['studio-leader'].bound`（**15 个**，含 3 web 工具；research §10.5 决定点 4）；v0.0.37 `LEADER_DEFAULT_TOOL_NAMES` 三层 wiring retire（被 `resolveTools` 单方法替代）。
- **`agent_member.md §3`**：mate 工具集 = `TOOL_POLICY['studio-mate'].bound`（**15 个**，含 `agent` 工具 — 修 research §8 偏差 #4：旧 `MATE_DEFAULT_TOOL_NAMES` 不含 agent 与 spec 矛盾）；`goal` ❌ 不在 mate bound（mate 不规划）。
- **`session_config_studio.md §3.1`**：tools 取法重写为 static-by-type（不再读 member.tools，改 `resolveTools(role)` 查 policy；mate send_message 保底由 policy 保证）。
- API（11a-squad-endpoints.md §2.1/§2.2）：HireBody 去 tools 字段；PATCH body 带 tools → 忽略并 warn（不返 400，向后兼容）。
- 详见 `specs/tech/version_logs/v0.0.48/change_log.md`。

## 2026-07-01 · v0.0.37（squad 工具 schema 补全 + leader 三层 wiring + OKF 心智模型入 prompt）

- `squad_tools.md §0`：加核心设计原则「`inputSchema.properties` = LLM 参数契约」（`protocol-encode.ts` 原样透传，handler 实读字段必须声明，否则 LLM 只发 action → write 崩）。
- `agent_leader.md §3`：tools 表拆 file/web 行（file ✅ 写 OKF / web ❌）+ 加 skill ✅；加 leader 三层门控一致段（v0.0.37 修 v0.0.33.3 残留——config 改了 schema+exec 没改，抽 `LEADER_DEFAULT_TOOL_NAMES` 单一权威常量三层对齐）。
- `squad_okf.md §1`：加双轨心智模型（OKF=工作目录/过程层，store=汇报PPT/交流层）+ 同步方向按信息来源不按角色（修旧 teamwork 技能「方向相反因角色不同」误判）。
- `prompt_sections.md §8`：重写——两层模型 + 同步方向情境式 + 注 leader.md/mate.md 新增「团队工作结构」段 + teamwork 技能注脚改情境式。
- 真 LLM AT parked（MiniMax-M3 抽风回「你好」no_tool_call）；Part A schema 修复由 `squad-tool-schema.test.ts` UT 兜底。

详情：`specs/tech/version_logs/v0.0.37/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`；`overall.md` 内容按类拆流并入 index 后归档。
- 全部 19 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 inline `[vX.Y]` / `[vX.Y modified]` 噪声，迁移到 frontmatter `since` 或本 log。
- 修正 spec 错误：`squad.json` 实际落 `{root}/squad/{squadId}.json`（CrudStore entity→dir 惯例），非 `squads/{squadId}/squad.json`（`data_model §3` / `squad_okf §1` / `squad_workspace §1` 三处订正）。

## 2026-06-29 · v0.0.33.4（自主性 infra 收官）

- 新增 `scheduler.md`（概念先行，唯一权威）：1s 轮询 + `lastFiredAt` 续接 + gate chain + tickMessage + 多 squad 独立实例。
- 新增 `squad_filewatch.md`（概念先行）：squad 级后台 chokidar watcher on `board/+outputs/+reports/`，路径前缀路由 + 2s debounce + activeWindow 放宽。
- gate chain 顺序定为 `enableHeartBeat → activeWindow → budget → busy → deliverTo`；TBD11 决：busy check 须在 deliverTo 前（防 enqueue 不可撤致 tick 堆积）。
- budget 横向聚合（`Σ team sessions total.total_tokens`）+ Display/Gate null 语义分离 + daily 窗口 baseline-delta。
- SquadSchema 加 `timezone` 字段（TBD4/5 单一 squad timezone；activeWindow + daily 回血都跟它）。
- drift 订正：`SquadRecord` 无 `leaderSessionId`/`memberSessionIds`（各 role sessionId 经 `memberStore.listMembers → member.sessionId` 取）；`getUsageView` 真签名无 `windowStart`。
- `squad_autonomy.md` §5 gate 从 `concurrencySlotAvailable` 改 `isRoleRunning` busy check；§10 五项 TBD 全决议。

详情：`specs/tech/version_logs/v0.0.33.4/change_log.md`

## 2026-06-28 · v0.0.33.3（OKF 双轨 + 工作项三层 + system prompt 不落库）

- 新增 `squad_okf.md`：OKF md 主面（根布局 + 6 type frontmatter + 坏链容忍 + index/log 自动重生成）。
- 新增 `squad_store_projection.md`（从 `data_model §3` 拆出）：store json 投影 schema + ID 生成 + `lastWriteMessageId` + 派生字段策略。
- 新增 `squad_workitems.md`：三层 Goal(KR)/Requirement/Task + 统一 WorkStatus 5 态 + KR/goal health 派生 + 持久化。
- `squad_tools.md` 重定位：工具 = store 同步器 + 强约束兜底（claim CAS / task source 必填 / DAG 写入无环检测 / 状态机非法跃迁拒写），**不碰 OKF**。
- `prompt_sections.md` v2.0：固定规范走 `system_prompt_mapper`（新增 `squad_role` + 留 roster/parent_task），动态上下文走 `system_reminder`（charter/tasks 迁 provider + 新增 squad_board）。
- 新增 `squad_reminder_providers.md`：3 provider + `shouldProduce` 统一去重（角色 filter → `findLastReminder` → `lastWriteMessageId` 比对 → 10 条兜底）。
- `member.systemPrompt` 移除（3 步迁移）；身份正文由 `squad_role` mapper 注入 content fragment（`prompts/content/squad/{leader,mate,squad_chat}.md`）。
- `team(update_charter)` 对话驱动 charter 演化 + `triggeredByMessageId` + charter_history append-only；Squad entity 加 `lastWriteMessageId`（裁决 C1=a）。
- `data_model.md` v1.2：§3 store 投影拆出独立成文；Squad entity 加 `lastWriteMessageId?`。
- 3 技能 builtin seeding（`okf-skill` / `teamwork-leader` / `teamwork-mate`）+ 看板三视图 `GET /squad/:id/board?view=`。

详情：`specs/tech/version_logs/v0.0.33.3/change_log.md`

## 2026-06-28 · v0.0.33.2（4 scope 对话打通）

- 拆 studio 403：squad/leader/mate 进入 AgentLoop；subagent a2a 走统一 config。
- 新增 `session_config_studio.md`：SessionConfig 加 5 字段（sessionType/bizType/squadId/memberId/studioContext）+ studio 分支 5 字段取法表。
- `buildSessionConfigFromDeps()` 加 studio 分支（与 subAgentConfig 并列）；D4 skill 黑白名单 + D5 model 4 级回退链。
- `prompt_sections.md` v1.0：4 system_prompt section mapper（charter/team_roster/parent_task/tasks）+ reachable_agents reminder；Option A 分流（`config.sessionType` 决定零贡献）。
- 工具过滤三层：`member.tools` 实例白名单 / schema 层 `filterToolDefinitionsBySessionType()` / 执行层 `deriveAllowedTools()`。
- SquadChat `<EOS>`：stop seq（Anthropic protocol encode 映射 `stop_sequences`）+ strip 兜底；不新增 StopReason，维持 `no_tool_call → markIdle` 不变量。
- `team` 工具 v2 只读子集（list/query/get_charter）；send_message squad clique（同 squad 互通，跨 squad 拒）；D9 修 subagent identity。

详情：`specs/tech/version_logs/v0.0.33.2/change_log.md`

## 2026-06-27 · v0.0.33.1（CRUD + Studio UI，对话全占位）

- `data_model.md` v1.0：三 entity SchemaDef（squad/member/charter_history）+ 三组双向关联（应用层 service 单点维护）+ CrudStore FS engine 按 squadId 分片。
- `createSquadService` 8 步事务 + 补偿回滚；`createMemberService`（fresh / derive 模式）。
- B 方案命名锁定：`member` entity + `role = leader|mate` + `session.type` 原 `member`→`mate`（避免与 entity 名撞）。
- `squad_definition.md` v0.2：squad **不可删**（无 status/archived/DELETE，推翻 req.md 旧 `_archived`）；leader **不可 bench**（永远 deployed，API 403）；member **不可删**（bench 兜底，无 fire）。
- `enableHeartBeat`（默认 false）替代旧 `autonomyEnabled`；`budget: | null` 占位 v4。
- session 增量字段 `type/bizType/squadId/memberId` 持久化；占位 chat 403（POST studio messages 返 `studio_chat_not_ready`），loop 留 v0.0.33.2。

详情：`specs/tech/version_logs/v0.0.33.1/change_log.md`

## 2026-06-27 · draft 0.1

- `design.md` SD1-SD8 决策锁定：派生（SD1）/ model 可配（SD2）/ SquadChat EOS（SD3）/ 唤醒双模（SD4）/ 心跳归属（SD5）/ budget（SD6）/ 生命周期+总开关（SD7）/ charter 持有语义（SD8）。
