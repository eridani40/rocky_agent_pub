---
type: index
title: Squad 子系统总起
priority: P1
updated: 2026-08-13
---

# Squad 子系统总起

## ① 是什么

squad = **一个自主协作单元**——在 multi_agent 地基之上，加「团队/角色定义 + 自主性 infra（scheduler 心跳 + budget）+ 共享工作目录」。一个 squad = 1 leader member + N mate member + 1 SquadChat session（哑路由）+ budget（可空）+ 共享工作目录。**AgentLoop 本体零改**，差异落在 SessionConfig / prompt mapper / 工具 / store / scheduler 五处。

| 核心概念 | 一句话 |
|---|---|
| **squad** | 自主协作单元（1 leader + N mate + SquadChat + budget） |
| **member** | 团队成员 entity（含 leader+mate，`role` 字段区分；全 agent 无 human）；`intro` 一句话介绍渲染进 Team Roster 花名册（fresh 必填/leader 固定模板/derive 继承父，见 `data_model.md §1.2a`） |
| **leader** | 协调者 member（接需求→拆解→@mate 分配→跟进→收交付，hire/bench，**不做实质工作**） |
| **mate** | 执行者 member（接 leader 分配、自己推进自己汇报、有业务工具、可 spawn sub-agent） |
| **todo** | mate/leader 的轻量任务清单（独立 TodoStore，session 级 todos.json，不耦合 squad entity） |
| **SquadChat** | 哑路由 session（`type=squad`），reactive only，`<EOS>` 静默结束当前 run |
| **enableGroupChat** | [v0.0.270] 群聊可见性开关（`squad.enableGroupChat: boolean`）：**[v0.0.340] 新建团队默认 false=关**；存量 squad 无字段读 `?? true`=开（不受影响）。false → squad_agents_status 不渲染 SquadChat 行 + UI 群聊入口隐藏 + `send_message('squadchat')` 门控返 null（全私聊语义）；squad 实体/session 恒存在，仅控可见性。schema `required:false` + 读取 `?? true` 兜底。权威 `data_model.md §1.1` + `../multi_agent/[P1]a2a_protocol.md §3` |
| **reminder** | 动态上下文 provider（todo / squad_agents_status / squad_workspace / squad_task），`shouldProduce` 去重 + `lastWriteMessageId` 变化检测 |
| **scheduler** | [v0.0.116] squad 级统一心跳——一 squad 一 job，到点整队按 scope 逐成员 `deliverTo` 固定心跳提示词（proactive）；配置 `squad.heartbeatConfig`（权威 `../scheduling/`） |
| **presence** | [v0.0.116] 成员当前工作标记（`member.currentWork` 自由文本，`presence` 工具 set/clear）；squad_agents_status 统一块展示 running/idle + presence（[v0.0.273] 三合一，取代旧 leader-only team-status） |
| **panorama** | [v0.0.189] 业务全景（Panorama）——squad leader 用 DSL 搭建的业务数据看板（kanban/table/bar_chart）；DSL 驱动四层校验 + 迁移 + 泛化实体 store（不建 SchemaDef）；agent 工具 `panorama(action)` 单工具 8 action。[v0.0.243] task 普通 entity + system 标记：task 落盘进 squad schema（和 book 平级，get_schema 可见），system:true 标记 + lazy migration（ensureSystemEntities chokepoint）+ 自动依赖 transition + reminder 注入（不造专用工具）|

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| squad/member entity + 建队/hire 事务 | sub-agent 派生 / spawn_agent / send_message / deliverTo（→ `../multi_agent/`） |
| 工具收敛（team/**todo**/**panorama**/presence）+ store 投影 | AgentLoop 本体 / prompt builder EP（→ `../agent/`） |
| prompt section 分工（mapper vs provider）+ squad_role fragment | session store / session.type / bizType / usage（→ `../agent/session/`） |
| 自主性 infra（scheduler + budget） | CrudStore FS engine / sharding（→ `../persistence/`） |
| 三角色 agent 契约（SquadChat / leader / mate） | system_prompt_mapper / system_reminder EP 契约（→ `../agent/context/`） |
| 工作目录轻量组织建议（okf + 交付/temp 区分） | HTTP API 端点（→ `specs/api/overall/11*`）/ UI 组件（→ `specs/ui/`） |

## ③ 与系统的关系

```
                         ┌── agent/loop           (AgentLoop 本体，零改；studio 4 scope 共用)
                         │
   squad KB  ────────────┼── multi_agent          (spawn_agent/send_message/deliverTo/重激活/abort 级联)
   (本目录)              │
                         ├── agent/session        (session.type=squad|leader|mate|subagent, bizType, squadId, memberId, usage)
                         │
                         ├── persistence          (CrudStore FS engine + sharding)
                         │
                         └── agent/context        (system_prompt_mapper / system_reminder EP)
```

**对外协作点**：
- schema 落 `app/server/src/agent/schema_defs/squad/{squad,member}.ts`（SchemaDef 权威）。
- prompt section 落 `app/plugins/builtins/rocky_context/prompt/`（mapper + provider 双 EP）+ `app/server/src/prompts/content/squad/{leader,mate,squad_chat}.md`（squad_role content fragment）。
- scheduler 落 `app/server/src/squad/`，由 `squad-runtime.ts` 在 bootstrap wire + trap 清理。
- 4 scope 接 loop 的单 chokepoint = `app/server/src/handlers/session-config.ts.buildSessionConfigFromDeps()`。

## ④ 核心设计原则（跨文件不变量）

1. **AgentLoop 本体零改**——studio 4 scope 共用单一 loop，差异由 SessionConfig 5 字段 + mapper 分流 + 工具裁剪 + a2a 校验消化。→ `session_config_studio.md`
2. **okf 是可选文档组织建议，非强制结构**——squad 工作目录不再强制 5 类骨架 / 双轨投影；okf 方法（`okf-skill`）作为 agent 组织知识的轻量建议（建议用 okf + 区分 `交付/` 最终成果与 `temp/` 草稿/试错，命名带日期版本），agent 工具不依赖 okf 文件结构。→ `squad_okf.md` + `squad_workspace.md §1`
3. **system prompt 不落 DB**——`member.systemPrompt` 移除；人设走 `squad_role` mapper content fragment（随代码走、可 git diff）。→ `prompt_sections.md §3.1/§7`
4. **proactive 仅 gate，reactive 恒开**——budget/enableHeartBeat 只限心跳 activate；消息到达必响应，不受 budget/autonomy 限制。→ `squad_autonomy.md §2`
5. **工具 inputSchema = LLM 参数契约**——`protocol-encode.ts` 原样透传 `properties`，handler 实读字段必须在此声明，否则 LLM 不发 → write 崩；schema-handler 一致性由 UT 防回归。→ `squad_tools.md §0`
6. **[v0.0.48] leader/mate 工具集 static-by-type**——工具上限不再由 `Member.tools` config 驱动；改查单一权威源 `TOOL_POLICY['studio-leader'|'studio-mate'].bound`（`tool-policy.ts`），由 `resolveTools(role)` 单方法 resolve。`Member.tools` entity 字段标 dead（保留避免 migrate，不读不写）；API PATCH/hire 带 tools 字段 accept-and-ignore（不返 400，warn）。三层门控一致（config/schema/exec 查同一份 policy）。→ `agent_leader.md §3` + `agent_member.md §3` + `session_config_studio.md §3.1` + `data_model.md §1.2`
7. **[v0.0.85] SquadChat 转发 3 段模板 + `{{squad_name}}` 代码注入（修 LLM 原样 echo）**——SquadChat 把 user 消息转发给 member 时 `send_message` content 必须按字面 `###` 标题分 3 段（说明 / 原文 / 相关上下文），让接收方好解析 + AT 可逐段断言。群聊名占位符必须用 `{{squad_name}}`（对齐 `PromptHandler.fillTemplate` 的 `{{identifier}}` 约定）由 SquadRoleMapper 加载期从 `ctx.config.studioContext.squad.name` 注入——**LLM 会把 `{xxx.yyy}` 点号 brace 当字面量 echo**（同模板中文描述性占位符如 `{sender 标识}` LLM 正确理解，但点号 brace 看起来像程序 token 被当字面量），必须代码替换；`SquadChatContentHandler.build` 跑 `fillTemplate`。**红线不变**：转发仍是 send_message content text blocks（不扩 a2a §5）；sender 永远是 SquadChat 自己；needReply 是顶层字段不进 content（默认 true）；不改写 user 原文 + 不创作 answer。`STUDIO_SQUAD_ROUTER_SYSTEM_PROMPT` 硬编码常量删除（squad router systemPrompt 走 `''` 占位由 builder 经 squad_role mapper 注入，与 leader/mate 同链路）。→ `agent_squad_chat.md §2.1` + `prompt_sections.md §3.1`
8. **[v0.0.111] team 硬删除 teardown 先于删数据（防潜伏调度）**——`DELETE /squad/:id` → `dissolveSquad` 编排：① `disposeSquad`（per-squad 运行时 teardown：abort 在跑 loop + 注销 heartbeat jobs + 清 per-squad 状态）→ ② 按 `squadId` 平铺快照全量 squad session（含 spawn children，`listSessionsBySquad`）逐个 `deleteSession`（子孙 + parent 都触发 `onSessionDestroyed` → 内存 cron 注销）→ ③ deleteSquad（删 squad record）→ ④ `deleteSquadAdministrativeSubpaths`（只删管理性子路径：members/charter_history/panorama/.rocky + charter.md，**保留 outputs/reports**）。**顺序不可颠倒**——先停内存调度再删数据，否则删完 timer/job 仍照点 fire 烧钱（潜伏调度）。硬删不可逆（session+历史物理删）。→ `squad_workspace.md §7`（解散删除边界）+ `data_model.md §1.1` + `scheduler.md §9` + `[P1]cron_subsystem.md §8`
9. **[v0.0.113] 成员 skill = overlay 快照（废弃 D4 交集白名单）**——`member.skills: string[]`（白名单，与全局 catalog 取交集）**推翻重写**为 `member.skillConfig: { mode:'inherit'|'custom', overrides: Record<string,boolean> }`（不兼容旧数据）。resolve 语义：workspace 层恒生效（R2）；builtin/app 层 inherit→全局 enabled、custom→全局叠加 overrides（R1/R3）。旧 D4 缺陷：占位死数据（planning/testing 白名单 catalog 无对应）+ 面板保存即把白名单覆盖为占位子集 → 交集恒空 → 成员失全部 skill。overlay 让 off=纯继承、on=局部覆盖、新增 skill 自动跟全局。**角色区分不再靠 skill 白名单**（leader/mate 都 inherit 全局 builtin），由 `squad_role` mapper（#3）+ tool-policy（#6）保证。→ `session_config_studio.md §3.2` + `data_model.md §1.2` + PRD `2-member-skills-mechanism.md`
10. **[v0.0.116] 心跳升级 squad 级统一调度 + member presence**——心跳粒度 per-member → **squad 级**：`member.heartbeat` 标 dead，新增 `squad.heartbeatConfig{interval(5/15/30/60,默认15), activeWindows[](多段/不重叠/不跨0点/空=全天), scope{all/whitelist}}`；一 squad 一 heartbeat job，到点整队一次，gate（killswitch→activeWindows→budget(null=off=不限量)）通过后**逐成员**（scope∩deployed∩非busy）投递**固定心跳提示词**（含 `<EOS>` 出口句，**`<EOS>` 零机制改动**——只写文案，成员无工具调用自然结束）。benched 不唤醒；scope=whitelist 新增成员不自动纳入；SquadChat 无心跳。**member presence**（`member.currentWork` 自由文本，每人一条 set 覆盖/clear 取消）：独立 `presence` 工具（leader/mate 可用）；leader system prompt 新增「团队当前状态」段（`squad_team_status` reminder，只列 session running 成员 + presence——[v0.0.273] 被 `squad_agents_status` 统一块取代：全员列出 + running/idle + presence 三合一）。→ `../scheduling/[P1]heartbeat_handler.md §0` + `data_model.md §1.1a/§1.2b` + `squad_tools.md §6a` + `squad_reminder_providers.md §4.6`
11. **[v0.0.128] member 写 action 经 service 层单源（HTTP/tool 三路同源 invariant）**——member 的 deploy/bench/patch 业务逻辑抽共享 service `services/member-mutations.ts`（+ hire 复用 `createMemberService`），HTTP handler（`handlers/member.ts`）与 agent tool（`team-write-actions.ts`）双入口调同一 service，**禁 inline 复制业务校验**（name 唯一/model 合法/leader 不可 bench/intro trim）。tool 层经 `resolveMemberId` 解析 id-or-name（与 `query.ref` 同语义），service 层纯 id。→ `squad_tools.md §2` + `data_model.md §5`
12. **bench 过滤分层（消费点过滤，数据层不动）**——member 状态机 `deployed ⇌ bench`（bench=下岗停心跳），「看不见 bench」在**各消费点**实现，不在数据层 `MemberStore.listMembers`（它恒返全量）：① 认知/协作层（`team_roster`/`squad_agents_status`/mention search）只看 deployed（squad_agents_status 过滤修真 bug——bench 无心跳不运行，列为 `send_message` 对端无意义）；② UI 默认在岗视图（`SeatsPanel` `deriveViewRows` active 分支 `state==='deployed'`）+ roster 头视图筛选 toggle（在岗/全部）让用户按需查下岗 + 复用菜单 deploy 恢复；③ **管理工具 team tool `list` 保留全量**（leader 管理全视角 + `team deploy` 恢复能力）。判据分层：plugin duck-typed 侧 `state !== 'benched'`（容缺失值防旧数据全灭）；web 强类型侧 `state === 'deployed'`（Member.state 类型必填 enum 闭合，两判据生产等价）。→ `prompt_sections.md §3.2/§5` + `squad_tools.md §2` + `design.md §9.2`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **概念 / 定义** | | |
| `squad_definition.md` | squad/member 概念 + member 派生 + SquadChat EOS（SD1/2/3/8） | [link]([P1]squad_definition.md) |
| `design.md` | 决策日志（SD1-SD8 + §9 后续决议 + rationale） | [link](design.md) |
| `agents_comparison.md` | 三角色对比矩阵 + 通信拓扑 + prompt 链对照 | [link](agents_comparison.md) |
| **数据 / 存储** | | |
| `data_model.md` | squad/member SchemaDef + 双向关联 + 存储布局 + 建队/hire 事务 | [link]([P1]data_model.md) |
| `squad_okf.md` | okf 文档组织建议（根布局 + 6 type frontmatter + 坏链容忍，轻量非强制） | [link]([P1]squad_okf.md) |
| `squad_workspace.md` | squad 目录结构（团队办公室）+ onboarding + workspace 可见性 | [link]([P1]squad_workspace.md) |
| **工具** | | |
| `squad_tools.md` | 工具收敛（team/todo/panorama/presence action-based） | [link]([P1]squad_tools.md) |
| **Prompt / Session** | | |
| `prompt_sections.md` | prompt section 分工（mapper 固定 vs provider 动态）+ 生命周期 | [link]([P1]prompt_sections.md) |
| `session_config_studio.md` | SessionConfig 5 字段 + studio 分支取法表 | [link]([P1]session_config_studio.md) |
| `squad_reminder_providers.md` | todo/squad_workspace/squad_agents_status/squad_task provider + shouldProduce 去重 | [link]([P1]squad_reminder_providers.md) |
| **自主性 infra** | | |
| `squad_autonomy.md` | 唤醒双模 / 心跳归属 / budget / enableHeartBeat 总开关 | [link]([P1]squad_autonomy.md) |
| `scheduler.md` | 1s 轮询 + 重启续接 + gate chain + tickMessage（scheduler 唯一权威） | [link]([P1]scheduler.md) |
| **角色 agent** | | |
| `agent_squad_chat.md` | SquadChat 哑路由 agent（prompt 链 / 仅 send_message / `<EOS>`） | [link]([P1]agent_squad_chat.md) |
| `agent_leader.md` | Leader 协调者 agent（接需求/分配/跟进/管理工具/心跳/无业务工具） | [link]([P1]agent_leader.md) |
| `agent_member.md` | Mate 执行者 agent（接分配/自己推进/业务工具+spawn/心跳） | [link]([P1]agent_member.md) |
| **业务全景** | | |
| `panorama_*.md` | Panorama DSL 看板（独立子体系，8 份 spec） | [link]([P1]panorama_overview.md) |
| `panorama_builtin.md`（v0.0.243） | task 普通 entity + system 标记 + lazy migration（首个系统固定 entity + 自动依赖 hook + reminder） | [link]([P1]panorama_builtin.md) |
| **聚合视图 / SSE** | | |
| `squad_aggregate.md`（v0.0.305） | squad 聚合视图（onlineCount/inProgressCount/lastActiveAt）+ `squad_meta` SSE 广播（squad-aggregate-service + squad-meta-broadcaster + useSquadMeta） | [link]([P1]squad_aggregate.md) |
| **团队同步 / 模板** | | |
| `team_sync.md`（v0.0.319） | 团队同步服务层：导出 zip（buildManifest + exportSquadToZip）/ 两阶段导入（validateZipEntries 路径安全 + ImportKeyStore 5min TTL）/ modelDefault 继承 | [link]([P1]team_sync.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
