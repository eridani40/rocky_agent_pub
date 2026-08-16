---
type: interface
title: Squad Reminder Provider 详细
priority: P1
status: active
updated: 2026-08-15
since: v0.0.33.3
related: [[P1]panorama_builtin.md, [P1]data_model.md, [P1]prompt_sections.md]
---

# Squad Reminder Provider 详细（squad_agents_status / squad_task）

> 定位：定义 `squad_agents_status`（[v0.0.273] 统一全员状态块；v0.0.361 拆半——名单归 team_roster，本 provider 只出状态行）+ `squad_task`（[v0.0.240] 活跃 task 列表）两个 squad `system_reminder` provider 的**产出格式 + 角色 filter + 数据源**，以及 ReminderCtx 扩展 + 角色注入矩阵。`squad_workspace` 已于 v0.0.361 退役（§2）。
> 参考：`reqs/v0.0.33.3/req7`（reminder 机制）/ `req8`（统一机制）/ `req11`（provider 详细，权威）；`../agent/context/[P0]system_reminder.md`（system_reminder EP + SystemReminder 契约）；`[P1]prompt_sections.md`（贡献点总表 + 固定/动态归属）；`[P1]panorama_builtin.md §5`（task reminder provider 挂载点）。
> 哲学：动态上下文不进 system prompt（破 cache），由 reminder 在 ingest 时流式注入；两个 provider 都是**瞬时值**型——不走 shouldProduce 变化检测，每轮直接产出，交 dedup reducer 收敛（不引 `lastWriteMessageId`）；v0.0.361 起增量轮由 reminder queue 承接状态变化行。

---

## 0. 定位

- 2 个 squad provider（EP=`system_reminder`，注册 `rocky_context/plugin.json`）：`squad_agents_status`（动态半）/ `squad_task`；`squad_workspace` 已退役（§2——静态半迁 system prompt `session_states` mapper）。
- 每个 provider 按 `config.sessionType` 决策产出。
- 复用现有 system_reminder ingest 链（req7 §3）：`contextEngine.ingest` → `applyIngestPipeline` → `system_reminder_injector`（priority 400）跑 provider 链 → 聚合 reminder 追加 text block 到末尾触发 message（`metadata.isSystemReminder=true`）→ `appendMessages` 落库（写一次冻结进 transcript，assemble 只读回）。
- **数据源**：`squad_agents_status` 用 `squadContext`（`listMembers` + `isSessionRunning` + `getSquad`）；`squad_task` 用 `squadContext.listActiveTasks`。都不读 okf md、不依赖 store workitem。
- **不走 shouldProduce 变化检测**：路径静态 / 状态是运行时瞬时值——每轮直接产出，dedup reducer 收敛（不引 `lastWriteMessageId`，不扫 transcript）。

> 注：squad 此前还有 `squad_charter` / `task` / `squad_board` 三个数据变化型 provider（走 shouldProduce），已随 charter/task/goal/requirement/board 工作项链路于 v0.0.237 一并移除。`todo` reminder provider 是 session 级独立 provider（非 squad 范畴，见 `specs/api/overall/20-todo.md`）。

---

## 1. ReminderCtx 扩展（前提）

现有 `ReminderCtx = { config: SessionConfig }`（`rocky_context/types.ts`），provider 拿不到 squad 上下文。扩展加：

```typescript
interface ReminderCtx {
  config: SessionConfig;            // 现有（含 sessionType/squadId/memberId，req6 方案 A）
  squadContext?: {                  // 封装 service（可测 + 不暴露 raw store）
    listMembers(squadId): Member[];            // roster（squad_agents_status 用；含 currentWork/state）
    isSessionRunning(sessionId): boolean;      // squad_agents_status running 判定
    getSquad(squadId): Squad;                  // enableGroupChat/squadChatSessionId 门控
  };
}
```

- `config.squadId/memberId` 已由 req6 方案 A 落进 SessionConfig（`[P1]session_config_studio.md`），provider 据此过滤。
- 非 squad session（`!sessionType` / `!squadId`）→ 所有 squad provider 返空。
- `readSessionType(ctx)` helper（`squad_reminder_shared.ts`）跨 provider 共用，按 sessionType 分类返回。

---

## 2. `squad_workspace` provider（v0.0.111 引入，v0.0.361 退役）

**已退役**：静态路径型内容不再走 reminder——逻辑平移进 system prompt `session_states` mapper（`app/plugins/builtins/rocky_context/prompt/session_states.ts` 的「团队盘」小节，仅 squad session 输出；路径推算 `path.join(dataDir, 'squads', squadId)` 语义不变）。五链同步：plugin.json EP 条目删除 + scopes yaml 清残留 + i18n 双 locale key 删除 + 计数断言修正。同批退役通用 `env` / `workspace` provider（time 平移 injector 时间固定段，见 `../../agent/context/[P0]system_reminder.md §3`）。

---

## 3. `squad_agents_status` provider（[v0.0.273] 统一全员状态块，取代 `squad_team_status` + `reachable_agents`）

- **角色 filter**（`readSessionType` 分派，R7）：squad / leader / mate → 产出统一块；subagent → `[parent]`（可达性拓扑保持，reachable 语义迁移）；standalone（`!sessionType`）→ `[]`。
- **职责**：统一全员状态块 `[squad:agents]`——**动态半**（v0.0.361 拆半）：running/idle 状态 + presence 标记（`member.currentWork`），行内仅保留 name 作锚点；成员名单（name+role+sessionId）归 system prompt `team_roster` mapper 承载（a2a 寻址 sessionId 由 roster 提供，不丢）。取代旧 `reachable_agents`（有可达性无状态）+ `squad_team_status`（只列 running）两个 provider（老板 2026-08-07 拍板「统一设计」）。
- **全员列出（核心修复）**：逐 member 查 running 但**不过滤**——running + idle 都保留（旧 `squad_team_status` L66 `if (!running) continue` 跳过非 running 已删）。**presence 有但 run 不在跑 = 卡住可见**（老板核心诉求）。
- **数据源**：`squadContext`（`listMembers` 返回 MemberEntity 含 name/role/sessionId/currentWork/state + `isSessionRunning` + `getSquad` 取 enableGroupChat/squadChatSessionId）；subagent 读 `config.agentToolContext.parent`（canonical AgentRef）。provide 为 async（isSessionRunning await）。
- **分派表**（可达性派生表迁移）：
  ```
  squad    → leader + 全部 mate（群聊路由对端；squad 自身即 squadchat 不含自己）
  leader   → SquadChat（enableGroupChat 门控）+ 全部 mate（不含 leader 自己）
  mate     → SquadChat（门控）+ leader + peers（peer = 同 squad 其他 mate，不含自己）
  subagent → [parent]（拓扑硬约束仅 parent）
  standalone（!sessionType）→ []
  ```
- **关键保留**：**benched 过滤**（`state !== 'benched'`；state 缺失按 deployed 兼容旧数据，readMembers 单点过滤）；**270 enableGroupChat 门控**（`enableGroupChat !== false`，undefined=旧 record=开；**[v0.0.340] 新建团队默认 false=关**；SquadChat 行随门控显隐，成员私聊不受影响）；**mate 对端可达性不丢**（name + sessionId 仍输出，a2a 语义不变）。
- **产出格式**（成员行 = name 锚点 + 动态状态；role/sessionId 归 team_roster 不重复）：
  ```
  [squad:agents] 团队当前状态：
  - SquadChat (squad, sessionId: {sid}) · 群聊        ← [v0.0.270] enableGroupChat=false 或空 squad 时不渲染
  - {name} · {running|idle} · presence: {text|(无 presence)}
  - ...
  （无可见成员时：「当前无成员」——连 SquadChat 行也不发，空 squad 无成员可协作）
  ```
  subagent parent 行（可达性保持，无 squad 状态可查）：`[squad:agents] 当前可达：\n- {name} ({type}, sessionId: {sid})`。
- **不做变化检测/去重**（同 §2）：running 态是运行时瞬时值、每轮可能变，每轮直接产出，交 dedup reducer 收敛。
- 代码：`app/plugins/builtins/rocky_context/reminder/squad_agents_status.ts`（`SquadAgentsStatusReminderProvider` default export class extends ContextImplBase，构造器 `(implId, cfg)`，id='squad_agents_status' tier='info'）+ `plugin.json` `system_reminder` EP 注册（`implId=squad_agents_status`；旧 `reachable_agents` + `squad_team_status` 条目已删）。
- **[v0.0.273] 数据源迁移**：旧 `reachable_agents` 的 `config.studioContext`（静态注入）→ `ctx.squadContext`（动态查询，bootstrap `setSquadReminderDeps` 注入 leader/mate/squad；subagent 不注入走 agentToolContext.parent）。旧 provider 文件 + 旧测试已删除。

---

## 4. `squad_task` provider（[v0.0.240]，活跃 task 列表注入 leader/mate）

- **角色 filter**：leader + mate → 产出（按视角过滤）；SquadChat / subagent / standalone → 不产出（`readSessionType(ctx) ∉ {leader, mate}` 返 `[]`）。
- **职责**：每轮注入活跃 task 列表，让队员感知待办——leader 看全队、mate 看归自己 + 自己 block 的。
- **数据源**：`squadContext.listActiveTasks(squadId, viewerMemberId | null)`（SquadContextService 新增方法，boot.ts wire 到 PanoramaEntityStore：`listInstances('task')` filter `archived=false` + 角色 filter）。viewerMemberId：
  - **leader**（viewerMemberId=null）→ 全队活跃 task
  - **mate**（viewerMemberId=self）→ `owner == self` ∪ `dependencies 含 owner==self 的 task`（即我负责的 + 我在 block 别人的）
- **过滤口径实现**（service 层）：
  ```
  active = tasks.filter(t => !t.archived)
  if viewerMemberId == null: return active                    // leader
  return active.filter(t =>
    t.owner === viewerMemberId ||                             // 我负责
    tasks.some(dep => t.dependencies.includes(dep.id) && dep.owner === viewerMemberId)  // 我 block 别人
  )
  ```
- **产出格式**：
```
[squad:tasks] 待办任务（{role} 视角）：
- {title}（{owner_name}，{status_label}）{依赖提示}
- ...
（无活跃 task 时：「当前无待办任务」）
```
  - `{owner_name}` = owner ref 指向 member 的 name（member 不在 panorama store，service 层 join `memberStore.listMembers`）；owner=null 显「未指派」。
  - `{status_label}` = task display.status_labels 映射（未开始/等待中/进行中/已结束，配死中文）。
  - `{依赖提示}` = waiting 状态显「（等 N 项）」（N=未 done 依赖数）；其他状态空。
- **不做变化检测/去重**（同 §2/§3）：task 列表瞬时值、每轮可能变，每轮直接产出，交 dedup reducer 收敛。
- 代码：`app/plugins/builtins/rocky_context/reminder/squad_task.ts`（`SquadTaskReminderProvider` default export class extends ContextImplBase）+ `plugin.json` `system_reminder` EP 注册（`implId=squad_task`，order 在 squad_workspace / squad_agents_status 之后）。
- **依赖扩展**：`SquadReminderDeps` 加 `panoramaEntityStoreFactory`（或 `dataDir + new PanoramaEntityStore`），`SquadContextService` 加 `listActiveTasks(squadId, viewerMemberId)`；`makeSquadContextService` 实现（详见 `[P1]panorama_builtin.md §5` + change_plan）。

---

## 5. 角色注入矩阵

| provider | leader | mate | SquadChat | subagent |
|---|---|---|---|---|
| `squad_agents_status`（动态半） | 全员状态行（SquadChat 门控）+ running/idle + presence | 全员状态行（门控 + 不含自己）+ running/idle + presence | 全员状态行（不含 SquadChat 自身） | `[parent]` |
| `squad_task`（[v0.0.240]） | 全队活跃 task | owner∪依赖我的 task | — | — |

> `squad_workspace` 行已删（v0.0.361 退役，§2）——团队盘路径归 system prompt `session_states` mapper。

---

## 6. 产出格式约定

- 每条 reminder 用 `[squad:类型]` 标头（如 `[squad:agents]`），便于 transcript 扫描定位。
- text block 追加到触发 message（req7 §3，沿用现状，**不新增独立 message**，时序紧贴）。
- tier：squad data 用 `info`（现有 reminder tier 体系，`SystemReminder.tier='info'|'warn'`）。

---

## 7. injector 触发（双模式）

- 触发条件（v0.0.274 放宽后现状）：末尾 message `role==='user' || role==='tool' || sender.source==='agent'`（a2a）都跑 provider 链；assistant/system 不触发。
- v0.0.361 双模式：full 轮（run 首轮/summary 重建后）跑动态 provider 链全量 + `queueClearAll`；incremental 轮只出 injector 时间固定段 + `queueDrain` 增量行（`../../agent/context/[P0]system_reminder.md §4`）。

## 7b. reminder queue 写入接线（squad-states-fanout，v0.0.361）

增量轮的 reminder 变化行由**写侧主动投递**进 per-session reminder queue（`app/server/src/agent/system-reminder-queue.ts:ReminderQueueStore`，`{DATA_DIR}/sessions/{sid}/reminder_queue.json`；同 key 重写删旧追加尾，drain 拿锁按序读+清空）。fanout 模块 `app/server/src/squad/squad-states-fanout.ts` 三入口：

| 入口 | key | value（已渲染行） | audience | 写点代码 |
|---|---|---|---|---|
| `fanoutStates`（presence 工具） | `presence:{memberId}` | `[squad:agents] {name} presence: {text}` / `presence 已清除` | 全员 + SquadChat（逐 session 失败隔离） | `agent/tools/presence-tool.ts` |
| `notifyMemberState`（state machine） | `member_state:{sessionId}` | `[squad:agents] {name} → {state}` | 全员 + SquadChat | `agent/session-state-machine.ts` |
| `notifyTaskTransition`（task transition） | `task:{taskId}` | `[task] {id}「{title}」→ {中文状态}（owner: {ownerName}）` | leader ∪ owner ∪ dependencies[].owner（写侧过滤，不含 squadChat） | `squad/panorama/tool/panorama-tool-data-actions.ts` + `squad/panorama/http/panorama-routes-impl.ts`（两入口同调，不重复实现） |

- **todo 工具**（session 级，非 fanout）：`agent/tools/todo-tool.ts` 写 `todo:{itemId}`，仅本 session。
- **失败语义**：逐 session `.catch()` 隔离 + 外层 try/catch 静默——reminder 是 best-effort 通知，绝不阻断工具返回/状态迁移。
- queue 实例 per-call new（write 临界区纯同步 JS，多实例不交错）；消费侧 injector `queueDrain` 拼进 incremental 轮 reminder，full 轮 `queueClearAll` 作废 pending。

---

## 8. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| 2 squad provider（squad_agents_status 动态半 + squad_task 活跃 task 列表）产出格式 + 角色 filter + ReminderCtx 扩展 + 角色矩阵 + queue 写入接线（§7b） | 本文 ✅ |
| session states 静态段（env / workspace / 团队盘路径三小节，承接退役的 squad_workspace 静态半） | `../../agent/context/[P0]system_prompt.md §4`（`session_states` mapper 行） |
| reminder queue store（reminder_queue.json 读写锁语义）+ injector 双模式消费 | `../../agent/context/[P0]system_reminder.md §4` |
| task system entity（task entity 字段/状态机/view 定义 + system 标记 + lazy migration + 自动依赖 hook） | `[P1]panorama_builtin.md` |
| 个人 workspace 路径（个人盘根，非 squad；通用 `workspace` provider 已随 v0.0.361 退役） | `../../agent/context/[P0]system_prompt.md §4`（`session_states` mapper 工作目录小节） |
| todo reminder provider（session 级 todos，非 squad 范畴） | `specs/api/overall/20-todo.md` |
| 固定 vs 动态归属 + 贡献点总表 + 生命周期 | `[P1]prompt_sections.md` |
| SystemReminder / system_reminder EP / ReminderCtx 基础契约 | `../agent/context/[P0]system_reminder.md` |
| Squad / Member entity（SchemaDef） | `[P1]data_model.md §1.1/§1.2` |
| `member.currentWork`（presence 数据源） | `[P1]data_model.md §1.2b` + `[P1]squad_tools.md §4` |

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
