---
type: interface
title: Squad Reminder Provider 详细
priority: P1
status: active
updated: 2026-08-02
since: v0.0.33.3
related: [[P1]panorama_builtin.md, [P1]data_model.md, [P1]prompt_sections.md]
---

# Squad Reminder Provider 详细（squad_workspace / squad_team_status / squad_task）

> 定位：定义 `squad_workspace`（静态路径型，v0.0.111）+ `squad_team_status`（[v0.0.116] running 成员 + presence）+ `squad_task`（[v0.0.240] 活跃 task 列表）三个 squad `system_reminder` provider 的**产出格式 + 角色 filter + 数据源**，以及 ReminderCtx 扩展 + 角色注入矩阵。
> 参考：`reqs/v0.0.33.3/req7`（reminder 机制）/ `req8`（统一机制）/ `req11`（provider 详细，权威）；`../agent/context/[P0]system_reminder.md`（system_reminder EP + SystemReminder 契约）；`[P1]prompt_sections.md`（贡献点总表 + 固定/动态归属）；`[P1]panorama_builtin.md §5`（task reminder provider 挂载点）。
> 哲学：动态上下文不进 system prompt（破 cache），由 reminder 在 ingest 时流式注入；这三个 provider 都是**静态/瞬时值**型——不走 shouldProduce 变化检测，每轮直接产出，交 dedup reducer 收敛（不引 `lastWriteMessageId`）。

---

## 0. 定位

- 2 个 squad provider（EP=`system_reminder`，注册 `rocky_context/plugin.json`）：`squad_workspace` / `squad_team_status`。
- 每个 provider 按 `config.sessionType` 决策产出。
- 复用现有 system_reminder ingest 链（req7 §3）：`contextEngine.ingest` → `applyIngestPipeline` → `system_reminder_injector`（priority 400）跑 provider 链 → 聚合 reminder 追加 text block 到末尾触发 message（`metadata.isSystemReminder=true`）→ `appendMessages` 落库（写一次冻结进 transcript，assemble 只读回）。
- **数据源**：`squad_workspace` 用 `config.squadId + config.dataDir` 推路径；`squad_team_status` 用 `squad members` ∩ session running + `member.currentWork`。两者都不读 okf md、不依赖 store workitem。
- **不走 shouldProduce 变化检测**：路径静态 / running 态是运行时瞬时值——每轮直接产出，dedup reducer 收敛（不引 `lastWriteMessageId`，不扫 transcript）。

> 注：squad 此前还有 `squad_charter` / `task` / `squad_board` 三个数据变化型 provider（走 shouldProduce），已随 charter/task/goal/requirement/board 工作项链路于 v0.0.237 一并移除。`todo` reminder provider 是 session 级独立 provider（非 squad 范畴，见 `specs/api/overall/20-todo.md`）。

---

## 1. ReminderCtx 扩展（前提）

现有 `ReminderCtx = { config: SessionConfig }`（`rocky_context/types.ts`），provider 拿不到 squad 上下文。扩展加：

```typescript
interface ReminderCtx {
  config: SessionConfig;            // 现有（含 sessionType/squadId/memberId，req6 方案 A）
  squadContext?: {                  // 封装 service（可测 + 不暴露 raw store）
    listMembers(squadId): Member[];            // roster（team_status 用；reachable_agents 也复用）
    isSessionRunning(sessionId): boolean;      // team_status running 判定
  };
}
```

- `config.squadId/memberId` 已由 req6 方案 A 落进 SessionConfig（`[P1]session_config_studio.md`），provider 据此过滤。
- 非 squad session（`!sessionType` / `!squadId`）→ 所有 squad provider 返空。
- `readSessionType(ctx)` helper（`squad_reminder_shared.ts`）跨 provider 共用，按 sessionType 分类返回。

---

## 2. `squad_workspace` provider（v0.0.111，leader+mate 团队盘根路径）

- **角色 filter**：leader + mate → 产出；SquadChat / subagent / standalone → 不产出（`readSessionType(ctx) ∉ {leader, mate}` 返 `[]`；无 squadId 天然返空）。
- **数据源**：`config.squadId`（leader/mate 必有）+ `config.dataDir`（session 通用）→ `path.join(dataDir, 'squads', squadId)` = 团队盘根（等价 `squad-store.ts.squadRootDir`）。任一缺 → `[]`。
- **产出格式**：单条 `[{ id:'squad_workspace', tier:'info', content:'Team workspace: <团队根>' }]`，配合 system prompt「团队盘」outputs/reports/交付/temp 规范（`squad_workspace.md`）。
- **与个人 workspace 并存**：个人盘由通用 `reminder/workspace.ts`（个人 ws provider）继续注入，两条**各司其职**——`squad_workspace.ts` 只管团队根，**不塞进 workspace.ts**（单一职责）。
- **不做变化检测/去重**：路径静态（不随 store 变），每轮直接产出，交 dedup reducer 收敛。
- 代码：`app/plugins/builtins/rocky_context/reminder/squad_workspace.ts`（`SquadWorkspaceReminderProvider` default export，构造器 `(implId, cfg)`）+ `plugin.json` `system_reminder` EP 注册（`implId=squad_workspace`，i18n key `__MSG_...squad_workspace.description__`）。

---

## 3. `squad_team_status` provider（[v0.0.116]，leader 团队当前状态）

- **角色 filter**：**leader → 产出**；mate / SquadChat / subagent / standalone → 不产出（`readSessionType(ctx) !== 'leader'` 返 `[]`）。
- **职责**：leader system prompt 新增「团队当前状态」段——**只展示 session 正在 running 的成员及其 presence 标记**（`member.currentWork`，可能为空）。「活跃用户」= session `state==='running'` 的成员；睡着（idle）的成员不展示。
- **数据源**：`squad members`（`squadContext.listMembers(squadId)`）∩ **session 正在 running** 的成员 + 各自 `member.currentWork`（`data_model.md §1.2b`）。running 判定：`session.state==='running'`（`squadContext.isSessionRunning(sessionId)`）。
- **产出格式**：
```
[squad:team-status] 团队当前状态（活跃成员）：
- {memberName}（{role}）：{currentWork.text}  （或「（未标记）」若 currentWork=null）
- ...
（无 running 成员时：「当前无成员在活跃工作」）
```
- **不做变化检测/去重**（同 §2）：running 态是运行时瞬时值、每轮可能变，每轮直接产出，交 dedup reducer 收敛。
- 代码：`app/plugins/builtins/rocky_context/reminder/squad_team_status.ts`（`SquadTeamStatusReminderProvider`）+ `plugin.json` `system_reminder` EP 注册（`implId=squad_team_status`）。

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
- 代码：`app/plugins/builtins/rocky_context/reminder/squad_task.ts`（`SquadTaskReminderProvider` default export class extends ContextImplBase）+ `plugin.json` `system_reminder` EP 注册（`implId=squad_task`，order 在 squad_workspace / squad_team_status 之后）。
- **依赖扩展**：`SquadReminderDeps` 加 `panoramaEntityStoreFactory`（或 `dataDir + new PanoramaEntityStore`），`SquadContextService` 加 `listActiveTasks(squadId, viewerMemberId)`；`makeSquadContextService` 实现（详见 `[P1]panorama_builtin.md §5` + change_plan）。

---

## 5. 角色注入矩阵

| provider | leader | mate | SquadChat | subagent |
|---|---|---|---|---|
| `squad_workspace`（v0.0.111） | 团队盘根路径 | 团队盘根路径 | — | — |
| `squad_team_status`（[v0.0.116]） | running 成员 + presence | — | — | — |
| `squad_task`（[v0.0.240]） | 全队活跃 task | owner∪依赖我的 task | — | — |
| `reachable_agents`（现有，不在本 spec 范围） | 派生表 | 派生表 | 派生表 | `[parent]` |

---

## 6. 产出格式约定

- 每条 reminder 用 `[squad:类型]` 标头（如 `[squad:team-status]`），便于 transcript 扫描定位。
- text block 追加到触发 message（req7 §3，沿用现状，**不新增独立 message**，时序紧贴）。
- tier：squad data 用 `info`（现有 reminder tier 体系，`SystemReminder.tier='info'|'warn'`）。

---

## 7. injector 触发扩展（req7 §8.4）

- 现 injector 只对末尾 `role==='user'` 追加（`system_reminder_injector.ts`）。
- squad a2a message（`source==='agent'`）也需触发 reminder → **扩条件**：末尾 message `role==='user' || source==='agent'` 都跑 provider 链。

---

## 8. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| 3 squad provider（squad_workspace 静态路径 + squad_team_status running 成员 + squad_task 活跃 task 列表）产出格式 + 角色 filter + ReminderCtx 扩展 + 角色矩阵 | 本文 ✅ |
| task system entity（task entity 字段/状态机/view 定义 + system 标记 + lazy migration + 自动依赖 hook） | `[P1]panorama_builtin.md` |
| 个人 workspace（个人盘根路径，非 squad） | `reminder/workspace.ts`（通用 provider，与 squad_workspace 并存） |
| todo reminder provider（session 级 todos，非 squad 范畴） | `specs/api/overall/20-todo.md` |
| 固定 vs 动态归属 + 贡献点总表 + 生命周期 | `[P1]prompt_sections.md` |
| SystemReminder / system_reminder EP / ReminderCtx 基础契约 | `../agent/context/[P0]system_reminder.md` |
| Squad / Member entity（SchemaDef） | `[P1]data_model.md §1.1/§1.2` |
| `member.currentWork`（presence 数据源） | `[P1]data_model.md §1.2b` + `[P1]squad_tools.md §4` |

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
