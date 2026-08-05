# v0.0.94 组件生命周期重构 + 数据源标准化 — PRD

> version: 1.0 · 引入版本 v0.0.94 · 类型：**纯架构重构（标准化 + 组件化），不加任何新用户功能** · 最后更新：2026-07-08
> 权威输入：`reqs/[done] v0.0.94.component_refactor/design-decisions.md`（用户确认的设计决策，是本 PRD 的**法律**）+ `req.md`（原始诉求）+ `component_refactor_plan.md`（迁移地图，非法律）+ `specs/research/component-inventory.md`（现状清单，权威）。
> 概念权威源（本 PRD 必须对齐，不发明概念）：`specs/tech/app/frontend/[P0]component_architecture.md`（§3.10 useLifecycle 契约 / §3.4 run 态引擎）+ `specs/tech/app/frontend/[P0]sse_channel.md`（topic/event 语义 + replay 配置）+ `specs/ui/components/chat-page/_overview.md` + `specs/ui/components/studio-page/_overview.md`（组件/testid/布局契约）。
> **本 PRD 不新增 §3 功能章节**（无用户可感知新功能，符合 prd-spec-rules §增量更新规则「内部重构可简化」）。核心价值 = 定义「重构后哪些现有用户路径必须不回归」+「为什么重构」。全量 §3 功能定义仍在 `specs/prd/overall/03-llm-chat.md`（Playground）+ `08-squad-studio.md`（Studio），本次不改其功能语义。

## 目录

| 章节 | 文件 | 说明 |
|------|------|------|
| §1 目标 + 动机 | 本文 | 为什么重构：数据同步可靠；核心 = 标准化 + 组件化；明确不加新功能 |
| §2 范围 | 本文 | 全部迁移含对话区引擎；迁移对象清单（按三形分类） |
| §3 关键用户路径（MANDATORY） | [1-key-user-paths.md](1-key-user-paths.md) | 重构后必须不回归的现有核心路径 = 回归测试最低覆盖契约 |
| §4 PRD ↔ ui/tech spec 对齐核对 | [2-spec-alignment.md](2-spec-alignment.md) | 引用概念一致性核对 + 发现的 spec↔design-decisions 冲突（交 orchestrator 裁决） |
| §5 验收标准 | [3-acceptance.md](3-acceptance.md) | 功能不回归 + 契约达标 + 数据标准化 |

---

## 1. 目标 + 动机

### 1.1 核心目标：标准化 + 组件化（不是加功能）

现状：Playground（chat-page）+ Studio（studio-page）两个动态页的数据 hook **各写各的生命周期**——有的裸 `setInterval` 轮询（cron 60s / budget 30s / connector），有的独立 `new SseClient()` 违反单例（`useStudioUnreadMeta`），有的把 5 个区域数据（messages / runState / usage / summary / workspace）揽进一个 `useSessionRunState` monolith。数据「怎么来、怎么更新、怎么清理」没有统一契约 → 同步不可靠、难维护、易漏帧/漏清理。

本版本**把所有持有数据的 hook 统一到一套 lifecycle 契约**（四方法 `onInit` / `onDestroy` / `onTick` / `onEvent`），让：

- **每个组件原子化**：一个 hook 恰好持一形一块数据（不再一个 hook 揽 5 个区域）。
- **依赖最小数据**：hook 只订它自己需要的 topic、只读它自己需要的 API。
- **数据变了它自己干净地变**：SSE 帧到 → `onEvent` 按数据形调标准 reducer 更新自己那块；不靠别的 hook 人为触发（如原「run 结束 → 手动刷 usage」拆成 usage 变了后端直接推 `session_usage_update` 给 `useUsage`）。

### 1.2 明确不加新功能（MANDATORY 边界）

**本版本零新用户功能、零新页面、零新交互、零 API 契约变更。** 用户能看到的一切（会话列表、发消息流式回复、run 态、usage、三 tab、subagent 树、squad 群聊/单聊、看板、预算、红点）在重构前后**行为完全一致**。唯一目标是把这些功能背后的数据管理机制标准化。

- **`BudgetMeter` 接已存在的 topic 不算契约变更**（`session_usage_update` 早已在 `session_panel` 上发，只是没接线，见 §4）。
- **不碰 SSE 基建**：`event_sse_review` B 类（orphan subId / catch-up / authz 等）本版**不做**，只在 spec 标「未来扩展点」（design-decisions §6：SSE 基建扎实，A 类问题靠本次组件契约系统性治理即可）。

### 1.3 为什么「数据同步可靠」是核心价值

重构前的数据同步问题（用户可感知的隐患，非当下必现 bug）：

1. **漏帧风险**：流式累积（`agent_loop` 一秒几十帧 `text_delta`）若拿 React 快照而非最新 ref，帧 2 会读到帧 1 未 commit 的 stale 值 → 累积覆盖丢字。现状引擎靠手写 `sliceRef.current` 扛；本版把「ref-latest 不变量」升为契约默认（design-decisions §3），每个 area-hook 白嫖不用各自记得写。
2. **漏清理风险**：裸 `setInterval` / 独立 `SseClient` 未在 unmount 幂等清理 → 切页面残留定时器 / 僵尸订阅。本版统一走 `effect.startTimer` → `onTick` + `effect.subscribe` → useLifecycle 自动回收。
3. **同步靠人为触发的脆弱耦合**：原 `useSessionRunState` monolith 里「run 结束手动刷 usage」等跨区域触发，一旦漏接就静默不同步。拆 area-hooks 后各区域自治（各订自己 topic），耦合靠事件流自然解开。

---

## 2. 范围

### 2.1 范围 = 全部迁移，含对话区引擎（用户拍板）

design-decisions §1 定论：**不分版本，v0.0.94 一次做完全部迁移**，包括最难的对话区引擎（拆 `useSessionRunState` monolith → area-hooks；`SquadChatPage` / `MemberChatPage` 同源 area-hooks）。

> **注意 — 与 `component_refactor_plan.md §分版本计划` 的冲突**：迁移地图把引擎放 v0.0.95、左侧列表放 v0.0.96。**以 design-decisions §1 为准（法律）**：v0.0.94 一次做完。迁移地图仅作起点参考，其分版本计划作废。此冲突已在 §4 列出交 orchestrator 确认。

### 2.2 迁移对象清单（按 design-decisions §4 数据三形分类）

所有数据 hook 的 ctx 收敛成三形，`onEvent` 按形调标准 reducer。下表按「三形 + 流式特例」列全部迁移对象（现状取自 `component-inventory.md`）：

| 数据形 | reducer | 迁移对象（hook / 组件） | 页面 | 订阅 topic | 读取 API | 现状 |
|---|---|---|---|---|---|---|
| **list**（`Collection<T>`，有序 + 按 id 索引） | `applyCrud`：upsert/delete/replace(by key) | `usePageChatMount`（会话列表） | Playground 左栏 | `session_meta`(_all) | GET /session | 已符合模式，套契约 |
| | | `SectionCronPanel`（cron 列表） | Playground cron tab | 无（`onTick` 兜底） | GET /session/:sid/cron | 60s 裸 setInterval → `onTick` |
| | | `useMemoryCrud`（记忆列表） | Playground memory tab | 无 | GET /memory/:scope + CRUD | ✓ v0.0.92 已迁 useLifecycle |
| | | `SectionWorkspacePanel`（文件树） | Playground workspace tab | 无（消费 store.lastWorkspaceEvent，引擎转发） | GET /workspace/tree | ✓ v0.0.92 已迁 |
| | | `StudioSidebar`（squad 懒缓存 detailCache） | Studio 左栏 | 无 | GET /squad/:id（懒缓存） | useState detailCache → useLifecycle |
| | | `SquadBoard`（board goals/req/tasks） | Studio board | 无 | GET /board + 乐观 patch + reload | GET-once + 乐观 patch → useLifecycle |
| **单个**（`Snapshot<T>`，一个对象/标量） | replace 或字段 patch | `useUsage`（token 用量） | 对话区（三页共享） | `session_panel`(usage_update) | GET /usage | 从引擎拆出独立 hook |
| | | `useRunState`（running/idle/interrupting） | 对话区（三页共享） | `session_panel`(status_update) | GET /session | 从引擎拆出独立 hook |
| | | `useSummary`（compact 任务状态） | 对话区（三页共享） | `session_panel`(summary_task_update) | 无 | 从引擎拆出独立 hook |
| | | `BudgetMeter`（squad 预算用量） | Studio autowork tab | **`session_usage_update`（已存在，接线）** / 次选 `onTick` 兜底 | GET /budget/usage?squadId | 30s 裸 setInterval → SSE 优先（见 §4 开放点） |
| **kv**（`KeyedMap<K,V>`，点查 map） | set/delete/clear(by key) | `useStudioUnreadMeta`（studio 红点 `Record<sid,bool>`） | Studio 左栏 | `session_meta`(_all) | 无（点击 POST /session/:id/read） | ⚠️ 违规独立 SseClient → 单例 + 契约 |
| | | `useSubagentChildren`（`childrenByParent`） | Playground 左栏 | 无（命令式 per-call） | GET /session/:id/children | ✓ v0.0.92 已迁 |
| **流式特例** | `applyAgentEventToMessages`（part 级累积，**保留自己 reducer 不套 applyCrud**） | `useMessages`（消息流，**多订阅**） | 对话区（三页共享） | `agent_loop` + `session_panel`(messages_cleared) | GET /messages | 从引擎拆出；多订阅 onEvent 按 topic switch |

**对话区引擎拆解**（design-decisions §1 + 迁移地图 §对话区引擎拆解）：
- 原 `useSessionRunState` monolith → `useMessages` / `useRunState` / `useUsage` / `useSummary` 四个 area-hook（`useWorkspace` 即 v0.0.92 已迁的 `SectionWorkspacePanel` 消费路径）。
- 每个 area-hook 只订**一个** topic（`useMessages` 例外：多订阅 `agent_loop` + `session_panel`.messages_cleared）→「多 topic 难点」根本不存在。
- `SquadChatPage`（群聊）/ `MemberChatPage`（单聊）/ Playground `page-chat` **三页同源** compose 这些 area-hook，不再各自起引擎。

### 2.3 轮询 → SSE 专项（SSE 优先 + onTick 兜底）

design-decisions §6：**能 SSE 优先 SSE**，`onTick` 是没 SSE 时的兜底。禁裸 `setInterval`，所有轮询走 `effect.startTimer` → `onTick`（带 justification）。

| 组件 | 现状 | 方案（design-decisions §6） |
|---|---|---|
| `BudgetMeter` | 30s poll | `session_usage_update` topic 已存在 → 接 `onEvent`（不算加后端 topic）；次选保 poll+justification（**开放点见 §4**） |
| `SectionCronPanel` | 60s poll | 没 topic 又不加（nextFireAt 漂移）→ `onTick` 60s 兜底 + justification |
| `PageConnector`（范围外，config 页） | 5s poll | 没 topic 又不加（connector 状态）→ `onTick` 兜底 + justification（本次是否纳入见 §4） |

### 2.4 明确不迁（无数据生命周期）

以下按 design-decisions §7 原子化原则判定无数据生命周期，**不迁**：
- `useModelRestore`（useLayoutEffect + token 守卫，迁反而退化）
- `useSubagentRunRefresh` / `useMemberPanelHandlers` / `useBoardAtMention` / `useBoardEditForm` / `useBoardCreate` / `useBoardDuplicate`（per-event / mutation / form / UI hook）
- `useMessageScrollPagination`（纯 UI 滚动）+ 所有纯展示组件（props 驱动，如 `ComponentMessageStream` / `SquadPanel` / `ComponentMemberCard`）
- **翻页/分页（loadMore）不进契约**：组件自身管（design-decisions 迁移地图备注 + 用户确认）。如 messages loadMore、SquadBoard 分页。

---

## 3. 关键用户路径

见 [1-key-user-paths.md](1-key-user-paths.md)。这是本 PRD 的核心交付——重构后必须不回归的现有核心路径，= 回归测试最低覆盖契约。

## 4. PRD ↔ ui/tech spec 对齐核对

见 [2-spec-alignment.md](2-spec-alignment.md)。

## 5. 验收标准

见 [3-acceptance.md](3-acceptance.md)。
