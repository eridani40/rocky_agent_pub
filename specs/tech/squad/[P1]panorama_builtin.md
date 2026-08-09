---
type: concept
title: Panorama task entity（普通 entity + system 标记 + lazy migration）
priority: P1
status: active
updated: 2026-08-05
since: v0.0.243
related: [[P1]panorama_overview.md, [P1]panorama_dsl.md, [P1]panorama_tools.md, [P1]squad_reminder_providers.md]
---

# Panorama task entity（普通 entity + system 标记 + lazy migration）

> 定位：`task` 是 panorama schema 里的**普通 entity**（落盘进 squad schema，和 book 平级，`get_schema` 可见），只是带独立逻辑（hook + reminder）+ system 标记（leader 不可 edit/delete schema）。
> 需求：`reqs/[working] v0.0.243.task_entity/req.md`。
> **历史**：v0.0.240 把 task 做成「builtin 通道」（代码声明 + 不进 schema 响应 + 前端镜像合成），是「一个谎」引出的 hack：get_schema 看不到 task（agent/leader 困惑）+ 前后端双份定义已漂移（dependencies max 后端 500 / 前端 50）+ readEffectiveSchema chokepoint 复杂度。v0.0.243 彻底纠正：task 改普通 entity 落盘 + system 标记 + lazy migration 初始化。

## 1. 是什么

task entity 由系统提供**固定 schema 定义**（`TASK_ENTITY_DEF`），通过**一次性 lazy migration** 写入每个 squad 的 board.yaml（和 book 平级），之后就是普通 entity（落盘、可读、可写实例）。`system: true` 标记防 leader 误改 schema。

| 概念 | 一句话 |
|---|---|
| **task entity（普通）** | 落盘进 squad schema（`board.yaml`），和 book/entity 平级；get_schema 可见（agent 一目了然） |
| **system 标记** | `EntityDef.system?: true`；task entity 标记；leader define 时不可 edit/delete task 的 schema（防 hook/reminder 崩） |
| **lazy migration** | schema 读取 chokepoint 调 `ensureSystemEntities(store)`：没 task entity → 建；已 system → no-op。幂等，首次后纯读 |
| **task 状态机** | 4 态：`todo` / `waiting` / `in_progress` / `done`；waiting=被依赖 block，全自动维护 |
| **依赖自动 transition** | task 写入后的后置 hook：依赖未满足 → todo 转 waiting；依赖全 done → waiting 回 todo（source=`system`） |
| **task reminder provider** | 挂 `SystemReminderPoint`，每轮注入活跃 task 列表（leader 全队 / mate owner∪依赖） |

## 2. task schema（字段 + 状态机 + view）

### 2.1 字段（EntityDef）

| field | type | 约束 | 中文 label |
|---|---|---|---|
| `id` | string | id_field、required | ID |
| `title` | string | required、max=200 | 标题 |
| `description` | string | max=2000 | 描述 |
| `owner` | string | 可空（未指派） | 负责人 |
| `dependencies` | string + pattern | 可空、max=500 | 依赖 |
| `status` | enum[todo, waiting, in_progress, done] | required | 状态 |
| `archived` | boolean | 默认 false | 已归档 |

- **owner = `string`**（**非 ref → member**）：member 由 SchemaDef 管理、不属 panorama DSL entities map；若 owner 声明为 `ref → member`，DSL 校验层会因 entities map 无 `member` entity 报 `panorama_unknown_ref_target`。故 owner 用 plain string 存 member id，由 reminder provider 层做软解析（join `memberStore.listMembers` 取 name）。
- **dependencies = `string` + `pattern`**（DSL v1 字段类型集无 `ref[]`）：用 string 存「逗号/空格分隔的 task id 列表」，pattern 容 `^[a-z0-9_,\s-]+$`。`hook.parseDeps` split `[,\s]+` 解析；task 存在性软校验在 `afterTaskWrite` 内做（依赖 id 查不到 status 视为未满足）。
- `archived` 是普通 boolean 字段——不进状态机、不锁实例；归档 = PATCH `archived:true`（view filter 默认隐藏）。create 时 `applyFieldDefaults` 给未传的 boolean 字段补 false。

> v0.0.243 起**单一来源**：task schema 仅后端 `task-schema.ts` 定义；前端镜像（`panorama-types.ts:BUILTIN_TASK_ENTITY_DEF`）已删（v0.0.240 漂移源——dependencies max 前后端不一致问题彻底消除）。

### 2.2 状态机（StatesDef）

```yaml
states:
  field: status
  initial: todo
  transitions:
    todo: [in_progress, waiting]        # 开始 / 被依赖 block（自动）
    waiting: [todo]                     # 依赖解除（自动）
    in_progress: [done]                 # 完成
  terminal: [done]
```

- `waiting` **只由自动 hook 设置**（依赖未满足且当前 todo → 转 waiting）；用户/agent 不能手动 `transition to:waiting`。
- 拖拽路径：用户拖 task 从 todo → in_progress（合法）；从 waiting → todo（合法，等同强制解除，但 hook 会基于实际依赖重新判定）。**推荐**：UI 层让 waiting 列只读（不可拖），依赖解除由自动 hook 处理。coder 决定 UI 是否锁 waiting 列。

### 2.3 view（task_kanban KanbanViewDef）

```yaml
id: task_kanban
label: 任务
entity: task
component: kanban
group_by: status
columns: [todo, waiting, in_progress, done]
filter: { archived: false }            # panorama_dsl §5 — 默认只看活跃
card:
  title: "{title}"
  badges: [owner, status]
  footer: "依赖 {dependencies}"
```

- 4 列对应 4 状态（等待中单独列，hue-amber 警示色）。
- `filter: { archived: false }` = view.filter（panorama_dsl §5）——任务 tab 默认隐藏归档；UI「活跃/含归档」开关切到「含归档」时前端 override 该 filter。
- `display.status_labels` 配死中文：`todo→未开始 / waiting→等待中 / in_progress→进行中 / done→已结束`。
- `display.status_colors`：`todo→#8b949e / waiting→amber / in_progress→#58a6ff / done→#3fb950`（amber 取品牌色 token）。

## 3. lazy migration 初始化（ensureSystemEntities）

task entity 是**首次访问时落盘**的——squad schema 读取 chokepoint 调 `ensureSystemEntities(store)`，幂等注入：

```typescript
// app/server/src/squad/panorama/builtin/system-entities.ts
export function ensureSystemEntities(store: PanoramaEntityStore): PanoramaSchema {
  let board = store.readBoard();
  if (board === null) {
    // 空 squad（fresh）→ 建最小 schema（task + task_kanban）
    board = { meta: { version: '1.0' }, entities: {}, views: [] };
  }
  if (board.entities.task?.system === true) {
    return board;  // 已 system（已迁移）→ no-op，纯读
  }
  // 注入 canonical system 版本（覆盖任何 leader 同名 task 变体——system-wins，req 决策）
  injectSystemEntities(board);
  store.writeBoard(board);
  return board;
}
```

- **触发点 = lazy on read**：tool/routes 的 schema-read helper（`readSquadSchema`）调它。理由：(a) 单一触发点，无 squad-runtime 跨模块耦合；(b) 自然处理 boot 后新建 squad（boot eager 漏掉新建 squad，需再 wire createSquad）；(c) 幂等廉价（readBoard + 条件 writeBoard，首次后纯读）。req 的「启动时」是行为语义（task entity 恒在），非字面 boot 时刻；lazy 等价达成。
- **冲突策略 = system-wins**（req §migration 边界，architect 选「系统优先」分支）：旧 squad 若已有 leader 手动 DSL define 的同名 `task` entity → migration 覆盖为系统版本（**不迁实例数据**——req 明确无有效 panorama task 数据；旧 `board/tasks/T-XXXX.json` 是 v0.0.237 旧 task-store 残留，忽略）。
- **不破坏性**：本 migration 仅**追加** task entity（additive），不删 leader 的其他 entity / data。符合「运行时启动路径不做破坏性状态迁移」原则（memory `runtime-no-ext-policy-write`——该原则禁的是清用户配置；additive 注入系统 entity 不属此列）。
- **幂等保证**：`task.system === true` 即「已迁移」标记（无需独立 version marker 文件）。

## 4. system 标记机制（防 leader 误改）

`EntityDef.system?: true` 标记系统固定 entity。task entity 落盘时带 `system: true`。leader 通过 `define` / PUT schema 改 schema 时，三段闭环保护：

```
leader 提交 DSL（含或不含 task entity）
   │
   1. parseDsl（validateSchema 内部）：parser 只读固定字段集，不识别 `system`
   │   → leader 在 DSL 写 system:true 会被丢弃（leader 无法自行标记 system）
   │
   2. validateSchema → checkSystemEntityImmutable（在 define/PUT 流程内）：
   │     若 schema.entities.task 存在 且 字段（label/id_field/fields/states/display，不含 system）
   │     与 canonical TASK_ENTITY_DEF 不 deepEqual → error panorama_system_entity_immutable
   │     （leader 试图改 task 字段 → 拒；task 缺失 → pass，inject 兜底）
   │
   3. validate pass 后、applyMigration 之前：injectSystemEntities(parsed.schema)
   │     强制 schema.entities.task = TASK_ENTITY_DEF（canonical system 版本）
   │     → applyMigration 的 oldSchema/newSchema diff 两边都含 task → 不误判 entity_deleted=task
   │     → 落盘必为 canonical，无论 leader 提交什么
   │
   → 落盘 board.yaml（task 带 system:true）
```

- **inject 时序关键（反直觉）**：**validate 先 → inject 后**（在 validate 与 applyMigration 之间）。反序（inject 先于 validate）会让 checkSystemEntityImmutable 看到 canonical → trivially pass → 失去防 leader 改 task 能力；inject 后于 applyMigration 会让 diff 看到 newSchema 缺 task → 误判 `entity_deleted:task` 触发破坏性迁移。

- **leader 工作流**：读 get_schema（看到 task）→ 改自己的 entity → PUT（task 自然在 DSL 里，不变）→ validate pass（task 字段与 canonical 一致）→ inject no-op → 落盘。leader 不需「保护 task」，系统自动保。
- **leader 试图改 task**：PUT 时 task 字段与 canonical 不一致 → validate 阶段 `panorama_system_entity_immutable` 错误（path=`entities.task`，suggestion「移除该 entity 定义或改名」）。leader 须从 DSL 中移除 task（让 inject 兜底）或把自己的 entity 改名。
- **leader 试图删 task**：PUT 时 DSL 不含 task → validate pass（omission 不报错）→ inject 注入 canonical task → 落盘仍有 task。删不掉。
- **只防 schema 面**：system 保护仅作用于 `define` / PUT schema（schema 面）。task 的**实例**（create/update/transition task 数据）全员可写——task 是普通 entity，数据面不锁。
- **view 可直接引用 task（无需 entities 声明）**：语义层（`validateSemantic`）把 system entity 当**恒在可引用**——leader 提交的 DSL 即便 `entities` 没写 task，`views` 里 `entity: task` 也合法，下游（group_by/columns/filter/template/badges）用 canonical `SYSTEM_ENTITY_DEFS.task` 校验。机制：`validateSemantic` 构造 entityNames 集合时追加 `Object.keys(SYSTEM_ENTITY_DEFS)`，`checkViews` 在 schema.entities miss 时 fallback canonical def 继续下游校验（不能 pass 跳过——否则字段漂移静默通过）。**与 inject 后置时序解耦**——仅扩解析可见性集合（纯内存），不动注入时序、不改 `checkSystemEntityImmutable` 抓 leader 改 task schema。详见 `[P1]panorama_validation.md §4`。

## 5. effective schema → readSquadSchema（chokepoint 重命名）

v0.0.240 的 `readEffectiveSchema`（DSL + builtin 合并）废除。task 真在 board.yaml，读取不需合并。schema-read chokepoint 改名 `readSquadSchema(store)`，职责简化为「ensure + read」：

```typescript
// tool/routes 各自的 schema-read helper（原 effectiveSchema）
function readSquadSchema(...): PanoramaSchema {
  return ensureSystemEntities(store);  // lazy migration + read（合一）
}
```

- **不再有 effective vs raw schema 两套区分**：只有一种 schema（落盘的 board.yaml，含 task）。
- **替换点**：`panorama-tool-actions.ts:effectiveSchema` / `panorama-routes-impl.ts:effectiveSchema` 改名 `readSquadSchema`，内部改调 `ensureSystemEntities`。
- **校验层透明**：validateInstance / validateTransition 接收 readSquadSchema 返回的 schema（含 task），天然支持 task 字段/状态机校验——无需改校验引擎本身。

## 6. 依赖自动 transition（task-hooks）

**触发**：`create` / `update`（patch 含 dependencies 或 status）/ `transition`（todo→done 触发依赖该 task 的 waiting 任务解除）写完 task 后，调 `afterTaskWrite(store)`。

```typescript
// app/server/src/squad/panorama/builtin/task-hooks.ts
export function afterTaskWrite(store: PanoramaEntityStore): void {
  const schema = store.readBoard();
  if (!schema?.entities.task) return;  // 防御守卫（ensure 后 task 必在；冷启动极端场景兜底）
  const tasks = store.listInstances('task');
  for (const t of tasks) {
    const deps = parseDeps(t.dependencies);
    const allDone = deps.every(d => tasks.find(x => x.id === d)?.status === 'done');
    const cur = t.status;
    if (deps.length > 0 && !allDone && cur === 'todo') {
      store.transitionInstance('task', t.id, 'status', cur, 'waiting', { source: 'system' });
    } else if (allDone && cur === 'waiting') {
      store.transitionInstance('task', t.id, 'status', cur, 'todo', { source: 'system' });
    }
  }
}
```

- **签名 = `(store)`**：v0.0.243 简化（原 `(squadId, store, dataDir)`）——不再需 `readEffectiveSchema`，直查 `store.readBoard()`。
- **幂等**：已是目标态的 task 不动（同值跳过，防事件洪水）。
- **source=system**：区分 agent / drag / system；事件流 + reminder 都用此判定。SSE 推送复用既有 `panorama_entity_update` 中枢（`source: 'agent'|'drag'|'api'|'system'`），不在 hook 内单独 emit。
- **环依赖保护**：parseDeps 不递归解析传递依赖（仅直接依赖），天然无环风险。
- **位置**：`panorama-tool-data-actions.ts:runCreate/runUpdate/runTransition` + `panorama-routes-impl.ts:handleCreateEntity/handlePatchEntity/handleTransition` 在 entity==='task' 时调用。

## 7. task reminder provider（squad_task）

详见 `[P1]squad_reminder_providers.md §4`。v0.0.243 不动 reminder 实现：

- 实现：`app/plugins/builtins/rocky_context/reminder/squad_task.ts`（`SquadTaskReminderProvider` default export）。
- 角色 filter：leader → 全队活跃 task；mate → `owner == self.memberId` ∪ `dependencies 含 owner==self.memberId 的 task`；SquadChat/subagent/standalone → 不产出。
- 数据源：`squadContext.listActiveTasks(squadId, viewerMemberId | null)`（boot.ts wire 到 PanoramaEntityStore：`listInstances('task')` filter `archived=false` + 角色 filter）。
- 产出格式：`[squad:tasks] 待办任务（{role} 视角）：\n- {title}（{owner_name}，{status_label}）{依赖提示}`。
- 去重：每轮直接产出，交 dedup reducer 收敛。

## 8. 与现有子系统的关系

```
panorama task entity（本 spec）
   │
   ├── ensureSystemEntities()  ← lazy migration chokepoint（schema-read 触发）
   │     ↑ readSquadSchema（tool/routes 各自 helper）
   │     ↑ runDefine/execDefine（define 流程 injectSystemEntities）
   │
   ├── checkSystemEntityImmutable()  ← validateSchema Layer 2 之后
   │     防 leader define 改 task schema
   │
   ├── afterTaskWrite() hook  ← task 写后置
   │     ↑ runCreate/runUpdate/runTransition + HTTP handle*Entity
   │
   └── squad_task reminder provider
         ↑ context-ingest-pipeline runReminderProviders 链
         ↑ SquadContextService.listActiveTasks（boot.ts wire PanoramaEntityStore）
```

## 9. 边界

| 管 | 不管（→ 别处） |
|---|---|
| task entity schema 定义（system 标记 + 字段 + 状态机 + view）+ lazy migration 注入 + system-protect 校验 + task-hooks 自动 transition + reminder provider contract | DSL board.yaml 读写（→ panorama_store）、DSL 字段类型集扩展（→ panorama_dsl） |
| task 作为**首个 system entity**的机制（inject + validate + ensure） | 其他 system entity（后续版本按需扩，复用本机制：加 SYSTEM_ENTITY_DEFS 条目 + task-schema 同位文件） |
| reminder 角色过滤口径 + 产出格式 | reminder 注入时序/EP 契约（→ system_reminder EP） |
| readSquadSchema 单一 read chokepoint | 校验引擎本体（schema 喂进去即可，引擎无须改） |

## 10. 设计原则（不变量）

1. **task 是普通 entity**——落盘进 squad schema（board.yaml），和 book 平级；不再有 builtin 通道（v0.0.240 hack 废除）；不再有 effective vs raw schema 两套；不再有前端镜像。
2. **lazy migration 单一 chokepoint**——所有 schema 读取走 `ensureSystemEntities(store)`（lazy 触发）；define 流程走 `injectSystemEntities`（write 前注入）。两条路径都保证 task entity 恒在。MUST NOT 绕过直读 `readBoard()`（否则 task entity 在冷启动未触达 squad 上不可见）。
3. **system 标记三段闭环**——(a) parser 不识别 `system` 字段（leader 无法自行标记）+ (b) `checkSystemEntityImmutable` 校验（leader 提交 task 字段与 canonical 不一致 → 拒）+ (c) `injectSystemEntities` 强制覆盖（leader 变体被 canonical 覆盖）。三段缺一则有 leader 误改 task schema 的口子。
4. **自动 transition 不走用户路径**——`afterTaskWrite` 用 `source='system'` 直调 `transitionInstance`，**不**调 `runTransition`/`validateTransition`（避免 self-loop：hook 触发 transition → transition 后置 hook 再跑）。状态机设计保证 waiting⇄todo 合法（hook 不会触发 illegal_transition）。
5. **task reminder 复用 SystemReminderPoint**——不另起通道；与 squad_workspace/squad_agents_status 并列，瞬时值型（不走 shouldProduce，每轮产出交 dedup）。
6. **不造 task 专用工具**——agent 用通用 `panorama(action, entity='task')` 操作；task 语义靠 schema（states/transitions/fields）+ hook（自动依赖）+ reminder（感知）三件套约束，不靠工具封装。
7. **单一来源**——task schema 仅后端 `task-schema.ts` 定义；前端不镜像（v0.0.240 漂移教训）。

## 11. agent 可发现性（认知入口）— v0.0.242 补 / v0.0.243 强化

task 是 **squad 专属概念**（团队任务），**认知入口在 squad 侧，不在 panorama 工具描述**：

| 通道 | 是否提 task | 说明 |
|---|---|---|
| `panorama-tool.ts` 工具描述 | **不提**（保持通用） | panorama = 通用看板读写工具，描述不绑定 task；task 是 squad 概念，不污染通用工具 |
| `leader.md` / `mate.md`（squad prompt） | ✅ 讲清 | task=团队工作（全景看板 task 表）、操作=`panorama(entity='task')`、task vs todo 边界、防幽灵 |
| `squad_task` reminder | ✅ 入口提示 | 产出末尾附「team task = 全景看板 task 表，用全景工具操作」 |
| `get_schema` 响应 | ✅ **task 在 DSL 内**（v0.0.243 修） | agent 调 `panorama(action='get_schema')` 直接看到 task entity 定义——修 v0.0.240 的认知割裂（agent 看不到 task 在哪） |
| `squad_chat.md` | 不提 | SquadChat 是路由器，不操作 task |

**防幽灵**（v0.0.242）：旧 `task` 独立工具（`task.create`/`task.query`）已于 v0.0.237 删除——squad prompt 明写「旧工具已废，team task 统一走 `panorama(entity='task')`」。

**task vs todo 定位**（产品口径）：
- **task = 团队工作**（squad 共享、跨 session 的任务状态，全景看板 task 表）
- **todo = 当前 session 手头正在做的工作**（session 级、个人执行追踪）

> 教训 v0.0.242 + v0.0.243：
> - v0.0.240 task 重生只建了**后端机制**（builtin schema + hook + reminder），没建 **agent 认知** → agent 不知道 task 怎么用、还在调旧 `task.create` 幽灵。v0.0.242 补三通道（squad prompt + reminder + spec）认知入口。
> - v0.0.240 builtin 通道让 get_schema **看不到 task**（schema 只 book，task 在前端镜像合成）——agent 一目不了然，leader-39 困惑实证。v0.0.243 改普通 entity（task 落盘进 schema），get_schema 直接返含 task 的 DSL，认知割裂从源头修。**task 认知归属 squad，panorama 工具保持通用，schema 必须可见**。

---

## 附：v0.0.240 builtin 通道遗产（已废，仅作教训记录）

v0.0.240 引入的「builtin 通道」设计已被 v0.0.243 废除。原设计要点（仅作历史教训）：

- ~~readEffectiveSchema 合并 chokepoint~~（v0.0.243 改 readSquadSchema = ensure + read）
- ~~BUILTIN_ENTITY_DEFS / BUILTIN_VIEWS 常量~~（v0.0.243 删；task-schema 直定义，前端不镜像）
- ~~前端 mergeBuiltinSchema 合成~~（v0.0.243 删；后端单一来源）
- ~~「builtin 只在 read 层合并、不写盘」不变量~~（v0.0.243 反转：task 写盘，read 层纯读）

**教训**：一个「谎」（task 不进 schema 响应）引出一串补丁（前端镜像合成 + read 合并 + effective/raw 两套）。彻底纠正 = 让 task 真的进 schema（普通 entity + system 标记），单一代码路径，无双份定义漂移风险。
