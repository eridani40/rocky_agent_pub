# v0.0.237 变更计划书 — studio squad 减法

> 架构期冻结的 method 级契约。行 = 函数/符号。coder 按此实现，reviewer 按此查偏离。
> 偏离记入 `change_log.md`。**本版本性质：纯减法 + prompt 改写，无新功能**。

## 背景与边界

**做什么**：给 studio（=所有 squad，全局共用 leader.md/mate.md）做 prompt 体系减法——
1. 删 task/okr(goal)/requirement 的存储 + tool + prompt + reminder + skill + HTTP + 前端，**保留 todo**
2. 删 charter（随 task 一起删）
3. 删 OKF 双轨制（OKF=工作目录 / store=汇报PPT）强制描述；okf 方法降级为建议（okf-skill 留）
4. workspace 内容管理由「5 类强管」精简为轻量建议（建议用 okf + 区分 交付/temp）
5. team tool 只摘 charter 部分（get_charter/update_charter），留 6 个成员管理 action
6. panorama 独立体系，零改动

**关键事实（已 grep 核实）**：
- 全文件型 JSON 存储，**无 DB migration**（只删文件 + 字段）
- task/team 仅 studio-leader + studio-mate 绑定（profile toolBound），全局删安全
- academy 的 `manage-task`/`manage-classroom`/`academy_task_status` 是 academy 板块独立链路，**不动**
- squad_chat.md 零 task/charter 提及，**不动**
- `squad-workitem-shared.ts` 的 `getCurrentMessageId` 被 panorama-tool-actions.ts 引用 → **不能整文件删，需先迁移 getCurrentMessageId**

**路径基准**：worktree 根 = `worktrees/v0.0.237-studio-subtraction/`，下文路径相对根。

---

## L1 · 工具注册与 profile

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools_registry | app/server/src/tools/registry.ts | defaultTools() | 修改 | 数组移除 `goalTool`/`requirementTool`/`taskTool` 三项；删对应 import (L44-46) | MUST 保留 `teamTool`/`todoTool`/`panoramaTool`/`manageTaskTool`/`manageClassroomTool`；删后 defaultTools 不得再引用三个工具名 | registry.ts L93-119 | +0/-4 |
| tools_team | app/server/src/agent/tools/team-tool.ts | TEAM_ACTIONS / WRITE_ACTIONS 常量 | 修改 | 两常量数组摘 `get_charter`/`update_charter`（TEAM_ACTIONS 留 6；WRITE_ACTIONS 留 5） | MUST 留 list/query/hire/deploy/bench/edit； enum 闭合（dispatch switch 全覆盖） | team-tool.ts L27,30 | +2/-2 |
| tools_team | app/server/src/agent/tools/team-tool.ts | teamTool.definition.description | 修改 | description 文本删 get_charter/update_charter 两句 + intro 去掉 "and charter" | schema description 与 enum 闭合一致 | team-tool.ts L38-49 | +1/-3 |
| tools_team | app/server/src/agent/tools/team-tool.ts | run() dispatch + get_charter 实现 | 修改 | 删 `if (action==='update_charter')` 分支 + 删整个 get_charter action 函数；errorResult 文案去掉两 action 名 | MUST NOT 留死分支 | team-tool.ts L97,154-160 | +0/-15 |
| tools_team | app/server/src/agent/tools/team-write-actions.ts | TEAM_INPUT_SCHEMA (action enum) | 修改 | enum 摘 `update_charter` | 闭合：dispatch 留 5 写 action | team-write-actions.ts schema 段 | +1/-1 |
| tools_team | app/server/src/agent/tools/team-write-actions.ts | runUpdateCharter() | 删除 | 整函数 + charter_history append 调用 | MUST 同步删 import（CharterHistoryStore 等） | team-write-actions.ts | +0/-40 |
| tools_task | app/server/src/agent/tools/task-tool.ts | taskTool（整文件） | 删除 | 删整文件 | 删后 registry 不再 import | task-tool.ts | +0/-300 |
| tools_task | app/server/src/agent/tools/task-tool-actions.ts | 整文件 | 删除 | 删整文件 | — | task-tool-actions.ts | +0/-全 |
| tools_goal | app/server/src/agent/tools/goal-tool.ts + goal-tool-actions.ts | 整文件 ×2 | 删除 | 删整文件 | — | — | +0/-全 |
| tools_requirement | app/server/src/agent/tools/requirement-tool.ts + requirement-tool-actions.ts | 整文件 ×2 | 删除 | 删整文件 | — | — | +0/-全 |
| tools_shared | app/server/src/agent/tools/squad-workitem-shared.ts | getCurrentMessageId() | 修改（迁移） | 把 `getCurrentMessageId` 迁到 panorama 或 runtime-context；删本文件其余所有 export（KrInput/LEGAL_WORK_TRANSITIONS/isLegalWorkTransition/isWorkStatus/parseKrs/isLeaderOrUser/resolveCallerMemberId/detectDagCycle/BoardCtx/readBoardCtx） | **MUST NOT 断 panorama**：panorama-tool-actions.ts:11 引用必须改为新位置；建议直接 inline `rtc.currentMessageId`（1 行） | squad-workitem-shared.ts L194；panorama-tool-actions.ts L11,51 | +1/-200 |
| profile | app/plugins/session-types/studio-leader.parent.main.yaml | toolBound 列表 | 修改 | 删 `- task` 行 | 留 team/todo/presence/panorama/send_message | L8 | +0/-1 |
| profile | app/plugins/session-types/studio-mate.parent.main.yaml | toolBound 列表 | 修改 | 删 `- task` 行 | 留 team/todo/presence/panorama/send_message | L8 | +0/-1 |

## L2 · 存储层（store + schema）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| storage_board | app/server/src/stores/board-store.ts | 整文件 | 删除 | 删整文件 | — | — | +0/-全 |
| storage_board | app/server/src/stores/board-shared.ts | 整文件 | 删除 | 删整文件（Goal/Requirement/Task/Kr 类型源头） | 删前确认无残留 import | — | +0/-全 |
| storage_board | app/server/src/stores/board-archive.ts | 整文件 | 删除 | 删整文件 | — | — | +0/-全 |
| storage_board | app/server/src/stores/goal-store.ts / requirement-store.ts / task-store.ts | 整文件 ×3 | 删除 | 删整文件 | — | — | +0/-全 |
| storage_okf | app/server/src/stores/okf-helper.ts | ensureOkfSkeleton() / regenerateIndex() / 整文件 | 删除 | 纯属 board/charter 投影，随删（squad-service 不再调） | 删前 squad-service 先摘 import | okf-helper.ts L119,182,192 | +0/-240 |
| storage_squad | app/server/src/stores/squad-store.ts | CharterHistoryStore 类 + CharterHistoryEntity 类型 | 删除 | 删 class（L128-）+ type（L33）+ 对应 schema import | 留 SquadStore/MemberStore | squad-store.ts L33,128-160 | +0/-40 |
| storage_squad | app/server/src/stores/squad-store.ts | ensureSquadDirSkeleton() | 修改 | dirs 数组去 `board`、`charter_history`；留 outputs/reports/members/panorama/.rocky | 建队仍能跑 | squad-store.ts L170-180 | +0/-2 |
| storage_squad | app/server/src/stores/squad-store.ts | dissolveSquad*()（清理函数） | 修改 | 删 dirs/files 清单中 `charter_history`、`charter.md`；留 outputs/reports（用户产出铁律） | MUST NOT 删用户产出（outputs/reports） | squad-store.ts L222-226 | +0/-2 |
| schema_squad | app/server/src/agent/schema_defs/squad/squad.ts | SquadSchema.charter 字段 | 修改 | 删 `charter: { type:'json', required:true }`（L54）+ charterId 注释段（L56-57） | required:true 删后建队不再要求 charter | squad.ts L51-57 | +0/-7 |
| schema_squad | app/server/src/agent/schema_defs/squad/charter_history.ts | 整文件 | 删除 | 删整文件 | — | — | +0/-全 |
| schema_squad | app/server/src/agent/schema_defs/squad/index.ts | re-export | 修改 | 摘 `charter_history` 导出 | 闭合 | index.ts | +0/-1 |

## L3 · HTTP / handler / service

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| http_charter | app/server/src/services/charter-service.ts | 整文件（validatePatch/putCharter/getCharterHistory） | 删除 | 删整文件 | — | — | +0/-126 |
| http_charter | app/server/src/handlers/charter.ts | handleCharterRoute() + 整文件 | 删除 | 删整文件 | — | — | +0/-138 |
| http_board | app/server/src/handlers/board.ts / board-read.ts / board-write.ts / board-write-goal.ts / board-write-req.ts / board-write-task.ts / board-write-shared.ts / board-shared.ts | 整文件 ×8 | 删除 | 删全部 board handler 文件 | — | — | +0/-全 |
| http_routes | app/server/src/routes/squad-routes.ts | handleCharterRoute 分支 | 修改 | 删 import（L22）+ dispatch 分支（L69-70） | — | squad-routes.ts L22,68-70 | +0/-5 |
| http_routes | app/server/src/routes/squad-routes.ts | handleBoardRoute 分支 | 修改 | 删 import（L23）+ dispatch 分支（L74-75） | — | squad-routes.ts L23,72-75 | +0/-5 |
| svc_squad | app/server/src/services/squad-service.ts | createSquad() charter 链 | 修改 | 删 `normalizeCharter`（L101）+ `charter` 字段（L72,233）+ Charter 类型 import（L55,72）；input.charter 入参去 | 建队不再写 charter | squad-service.ts L29,55,72,101,150,233,249 | +0/-12 |
| svc_squad | app/server/src/services/squad-service.ts | ensureOkfSkeleton 调用 | 修改 | 删 import（L29）+ 调用（L249 附近）+ 注释 | okf-helper 删后必须摘 | L29,244-249 | +0/-3 |
| svc_squad | app/server/src/services/squad-service.ts | 注释（teamwork skill 引用） | 修改 | L200 注释去 `teamwork-leader` 提及（cosmetic） | — | L200 | +1/-1 |

> **测试文件清理（coder 跟随 import 图，全文删除）**：`stores/__tests__/{board-store,board-health,okf-skeleton}.test.ts`、`services/__tests__/charter-service.test.ts`、`handlers/__tests__/{board,board-write,board-write-goal-echo,board-write-task1}.test.ts`、`agent/tools/__tests__/{task-tool,task-tool-v117,goal-tool,goal-tool-v117,requirement-tool,requirement-tool-v117,query-detail}.test.ts`、`mention/providers/__tests__/workitem-provider.test.ts`。
> **需手术式编辑（非整删）**：`squad-store.test.ts`（去 charter_history 断言）、`squad-service.test.ts`（去 charter 断言）、`squad-dissolve.test.ts`（去 charter_history/charter.md 断言）、`squad-tool-schema.test.ts` + `squad-tool-visibility.test.ts`（去 task/goal/requirement case，留 team/todo）。

---

## L4 · Context / 装配 / reminder 数据源

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ctx_runtime | app/server/src/agent/tools/runtime-context.ts | AgentToolRuntimeContext.boardStore / charterHistoryStore 字段 | 修改 | 删两可选字段（L129,134）+ BoardStore/CharterHistoryStore import（L28-31） | type 闭合；team/todo 工具不读这两字段 | runtime-context.ts L125-134 | +0/-12 |
| ctx_ingest | app/server/src/agent/context-ingest-pipeline.ts | squad_charter/squad_tasks/squad_board provider 接线 | 修改 | 去对三个 provider 的注册/调用引用 | 与 L5 provider 文件删除同步 | context-ingest-pipeline.ts L14,71 | +0/-行 |
| ctx_reminder_deps | app/server/src/agent/squad-reminder-deps.ts | SquadReminderDeps.boardStore 字段 + listGoals/listRequirements/listTasks mapper | 修改 | 删 boardStore 字段（L30-31）+ 三 mapper（L77-82） | 留 SquadStore（getSquad 用于... 仅 team-status）；若 getSquad 仅 charter 用则一并摘 | squad-reminder-deps.ts L19-99 | +0/-15 |
| ctx_bootstrap | app/server/src/bootstrap-agent-phase.ts | BoardStore + CharterHistoryStore 装配 | 修改 | 删两 import（L36-37）+ 两实例化（L262-263）+ 两 ctx 注入（L321-322）+ reminder deps 的 boardStore 注入（L416） | todo 工具不依赖 boardStore | bootstrap-agent-phase.ts L36-37,260-263,321-322,410-416 | +0/-12 |
| ctx_bootstrap_main | app/server/src/bootstrap.ts | boardStoreForMention（mention 装配） | 修改 | 删 BoardStore import（L72）+ 实例化（L306）+ 传参（L311） | 与 mention WorkItemProvider 删除同步 | bootstrap.ts L71-72,303-311 | +0/-6 |
| mention | app/server/src/mention/providers/workitem-provider.ts | WorkItemProvider（整文件） | 删除 | 删整文件（@task/@goal/@requirement provider） | — | — | +0/-全 |
| mention | app/server/src/mention/bootstrap-mention.ts | registerMentionProviders() | 修改 | 删 boardStore 入参（L38）+ WorkItemProvider import（L18,23）+ register 调用（L58） | 留 MemberProvider/SkillProvider/FileProvider | bootstrap-mention.ts L18,23,31,38,58 | +0/-6 |
| ctx_types | app/server/src/agent/context-types.ts | （charter/team_roster 注释） | 修改 | 仅注释 cosmetic 微调；**无字段删除**（grep 未发现 charter 实际字段，定位结论 L201,273 偏离） | — | context-types.ts L7,79 | +0/-0 |

## L5 · Reminder provider + skill

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| reminder_reg | app/plugins/builtins/rocky_context/plugin.json | [task] / [squad:charter] / [squad:board] 三个 system_reminder 注册项 | 删除 | 删 implId=task（L336-340）/ squad_charter（L330-334）/ squad_board（L342-346）三个 block | **MUST NOT 删** `[todo]`(L318)/`[squad:team-status]`(L354)/`[squad_workspace]`(L348)/`[reachable_agents]`/`[env]`/`[time]`/`[workspace]`/`academy_*` | plugin.json L330-346 | +0/-18 |
| reminder_prov | app/plugins/builtins/rocky_context/prompt/squad_charter.ts | 整文件 | 删除 | 删整文件 | — | — | +0/-全 |
| reminder_prov | app/plugins/builtins/rocky_context/prompt/squad_tasks.ts | 整文件 | 删除 | 删整文件 | — | — | +0/-全 |
| reminder_prov | app/plugins/builtins/rocky_context/prompt/squad_board.ts | 整文件 | 删除 | 删整文件 | — | — | +0/-全 |
| reminder_shared | app/plugins/builtins/rocky_context/prompt/squad_reminder_shared.ts | 整文件 | 删除 | 仅被上述 3 provider 使用，随删 | 留 reminder/env.ts 等不依赖本文件的 provider | — | +0/-全 |
| skill_dir | app/plugins/builtins/skills/teamwork-leader/ | 整目录 | 删除 | 删整目录 | — | — | +0/-全 |
| skill_dir | app/plugins/builtins/skills/teamwork-mate/ | 整目录 | 删除 | 删整目录 | — | — | +0/-全 |
| cosmetic | app/server/src/squad/filewatch/path-router.ts:44 | 注释 | 修改 | 去 `teamwork-mate skill` 提及（cosmetic） | — | L44 | +1/-1 |
| cosmetic | app/server/src/handlers/session-config.ts:253 | 注释 | 修改 | 去 `teamwork-leader/teamwork-mate` 提及 | — | L253 | +1/-1 |
| cosmetic | app/server/src/handlers/skill-list.ts:64 | 注释 | 修改 | 注释 `含随 app 发版的内置 skill（okf/teamwork-*）` 去 teamwork-* | — | L64 | +1/-1 |

---

## L6 · Prompt 内容改写（核心）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| prompt | app/server/src/prompts/content/squad/leader.md | 整文件正文 | 修改（大改） | (a) 删「## 团队工作结构（task）」「## 怎么管理：OKF=工作目录，store=汇报PPT」整节（双轨制）+ task vs todo 对比段；(b) 「## 你的工作」改写为「接需求 → 拆解 → @mate 分配 → 跟进 → 收交付」，工具链 todo/team/presence/send_message；(c) 删「管 charter」+「charter.escalation」；(d) 「## 工具权限」去 task/team.update_charter；(e) 「## 团队工作目录结构与维护」+「## 更多文件管理要求（以outputs为例）」**整两节**（5 类强管）替换为 ≤10 行轻量建议：建议用 okf 组织（方法见 okf-skill）+ 区分 `交付/`（最终成果）与 `temp/`（草稿/试错），命名建议带日期版本，**不强制**结构 | MUST 保留：评估优先/适度反思/持续学习/sooner rather than later 等成功基因段（L175-192）+ presence 说明 + send_message 协作规则；MUST NOT 再出现 task/charter/board/双轨/看板 字样 | leader.md 全文；req #1#2#3 | +60/-130 |
| prompt | app/server/src/prompts/content/squad/mate.md | 整文件正文 | 修改（大改） | 同 leader 同口径：(a) 删 task 工作结构 + 双轨制节 + task vs todo；(b) 「## 不创建 task / 不改 charter / 不越权」红线段改写为「不越权」（保留：不擅自做重大决策/不清楚就问）；(c) 工具清单去 task；(d) 目录结构 5 类强管节替换为同 leader 的轻量建议 | MUST 保留：接 leader 分配/自己推进自己汇报/认领后干活/没落文件=没交付/peer 协作 | mate.md 全文；req #1#2#3 | +50/-110 |
| prompt | app/server/src/prompts/content/squad/squad_chat.md | — | 不变 | 零提及 task/charter/board，**不动** | — | grep 确认 | 0 |
| prompt_mapper | app/plugins/builtins/rocky_context/prompt/squad_role.ts | 文件头注释 | 修改 | 注释 L8,12 去「charter/board/tasks」「不创建 task/不改 charter」字样（cosmetic，不改逻辑） | mapper 逻辑零改（仍按 role 选 3 个 md） | squad_role.ts L8,12 | +2/-2 |

## L7 · 前端（studio-page）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| fe_board | app/web/src/components/studio-page/component-squad-board.tsx + component-board-*.tsx（约 18 个） + board-types.ts + board-utils.ts + use-board-*.ts（at-mention/create/duplicate/edit-form[+test]） + component-board-at-button.tsx | 整文件（约 26 个） | 删除 | 删全部 board 组件/工具/hook/类型文件 | 删前 page-studio + panorama-route 先摘 import | studio-page 目录 ls | +0/-全 |
| fe_charter | app/web/src/components/studio-page/component-charter-editor.tsx | 整文件 | 删除 | 删整文件 | — | — | +0/-全 |
| fe_page | app/web/src/components/studio-page/page-studio.tsx | handleSaveCharter / useBoardAtMention / useBoardCreate 接线 | 修改 | 删 `handleSaveCharter`（L88 解构 + L183 onSaveCharter prop）+ `useBoardAtMention`（L36 import + L143）+ `useBoardCreate` 引用 + MainView 类型若有 board 变体 | MUST 保 panorama/member/member-create/seats/chat 路由 | page-studio.tsx L36,88,143,183 | +0/-8 |
| fe_panorama | app/web/src/components/studio-page/component-panorama-route.tsx + component-panorama-*.tsx | goals/requirements/tasks 三固定 tab | 修改 | v0.0.196 把看板三视图并入 panorama 前 3 tab；删这三 tab + 其依赖的 board 组件引用；panorama 仅留动态 views | panorama 主体（动态 views）保留；HTTP 调 /squad/:id/board/* 全删 | component-panorama-route.tsx | +0/-行 |
| fe_types | app/web/src/components/studio-page/squad-types.ts | SquadDetail.charter 字段 + Board 相关类型 | 修改 | 删 charter 4 字段（goals/workingStyle/collaboration/escalation）+ Board*/Goal/Requirement/Task 类型 | type 闭合（所有引用处同步） | squad-types.ts | +0/-行 |
| fe_archived | app/web/src/components/studio-page/_archived_board-*.tsx.disabled | — | 不变 | 已 .disabled，留软删状态 | — | — | 0 |

> **coder 注意**：前端 board 已被 v0.0.196 部分软删（并入 panorama tab），实际引用面比目录文件数小。**先 grep 真实 import 关系再删**，避免误删仍被 panorama 引用的 board 组件（如 selector/editor 被 panorama 复用）。

---

## L8 · 文档同步（doc-modifier 阶段 5，coder 不动）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| docs | specs/tech/squad/** + specs/api/overall/*squad* + specs/prd/overall/*studio* | — | 修改 | 由 doc-modifier 同步：删 task/goal/requirement/charter/board 工具/store/HTTP 章节；okf 双轨制描述改为建议；workspace 5 类强管改为轻量建议；team tool action 表去 get_charter/update_charter | 必须验证代码 == spec 一致 | 全局原则 12 | — |

---

## 偏离定位结论的点（architect 核实记录）

1. **`squad-workitem-shared.ts` 不能整文件删**：`getCurrentMessageId` 被 `panorama/tool/panorama-tool-actions.ts:11` 引用（panorama 留）。方案：迁移该 1 行函数到 panorama 或 runtime-context，再删整文件。定位结论未提此约束。
2. **`bootstrap-agent-phase.ts` 路径**：定位结论写 `agent/bootstrap-agent-phase.ts`，实际在 `app/server/src/bootstrap-agent-phase.ts`（src 根，非 agent/ 子目录）。
3. **`bootstrap.ts` 也需改**：定位结论未提，但 `bootstrap.ts:72,306,311` 实例化 BoardStore 给 mentionRegistry，必须随 WorkItemProvider 删除一起摘。
4. **okf-helper 函数名**：定位结论写「okf-helper.ts:214-239 charter.md 投影」，实际投影在 `ensureOkfSkeleton` 函数内（L214-239 是其 charter.md 段），okf-helper 整文件纯 board/charter 投影，随删。
5. **context-types.ts L201,273**：定位结论声称有 charter 字段，grep 仅在 L7,79 找到 charter（且为注释）。**无字段删除**，仅 cosmetic 注释。coder 复核后若确实无字段则跳过。
6. **`okf-helper` 的 `ensureOkfSkeleton` vs 定位结论的 `writeOkfRoot`**：函数名是 `ensureOkfSkeleton`（squad-service.ts:29 import），不是 writeOkfRoot。
7. **前端 board 真实引用面**：v0.0.196 已把看板并入 panorama 前 3 tab，board 组件实际还有 panorama 引用（selector/editor 可能复用）。coder 删前必须 grep 真实 import 图，不能按目录文件名盲删。
8. **squad-role.ts mapper 逻辑不动**：定位结论未明确，但 squad_role.ts 仅按 role 选 3 个 md 文件（逻辑零依赖 task/charter），改注释即可，不动分支。

## 影响估算

- 后端删除文件：约 30 个（含测试）
- 后端修改文件：约 18 个
- 前端删除文件：约 27 个（含 .disabled 不动）
- 前端修改文件：约 4 个
- prompt 改写：2 个（leader.md/mate.md 各大改一版）
- **净代码减量**：预计 -3500 ~ -4500 行（纯减法版本）
