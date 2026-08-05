## 4. PRD ↔ ui/tech spec 对齐核对

> 本节核对 PRD 引用的组件/布局/数据概念/topic 与已有 spec 一致（不发明概念），并列出**发现的 spec ↔ design-decisions 冲突**交 orchestrator 裁决。design-decisions 是用户确认的法律，冲突处以它为准，但**旧 spec 需要架构阶段更新**（否则 spec 静默过时 = 下游被误导，违反 CLAUDE.md 原则 12）。

### 4.1 引用概念一致性（PRD 未发明概念）

| PRD 引用 | 已有 spec 出处 | 一致？ |
|---|---|---|
| topic `agent_loop` / `session_panel` / `session_meta` + 各 event 类型 | `sse_channel.md` §9/§10 + `component-inventory.md §1.2` | ✅ 一致（照搬现有 topic/event，无新增） |
| `session_panel` 承载 status_update / usage_update / summary_task_update / messages_cleared / workspace_* / read_update | `sse_channel.md` §9/§10 | ✅ 一致 |
| `agent_loop` 可 replay、`session_panel`/`session_meta` 不 replay | `sse_channel.md` §10.7 + index.md ④原则 6 | ✅ 一致（用于说明 P6 流式 replay 粘住不回归） |
| 组件/testid：`conv-new-btn` / `conv-item-{id}` / `conv-item-{id}-unread-dot` / `chat-abort` / `chat-run-spinner` / `tool-batch` / `usage-trigger` 等 | `chat-page/_overview.md` §4/§7 | ✅ 一致（引用现有 testid，无新增） |
| Studio testid：`squad-chat-*` 族 / `squad-tree-board-{squadId}` / member/leader/mate 节点 | `studio-page/_overview.md` §2/§4a | ✅ 一致 |
| `ComponentMessageStream` 共享渲染内核 + 4 策略 hook | `component_architecture.md §3.3` + index.md ④原则 7 | ✅ 一致 |
| `ComponentRunStateBar` / `ComponentRunStateAbortSlot` 共享 UI 组装层 | `component_architecture.md §3.5` + 原则 9 | ✅ 一致 |
| session/run 两层状态分离（stop 圆环 = session 层 / on-message spinner = run 层） | `component_architecture.md §3.7` + `sse_channel.md §9.1` + 原则 10 | ✅ 一致 |
| `SectionWorkspacePanel` 消费 `store.lastWorkspaceEvent`（store 扇出枢纽） | `component_architecture.md §3.4` + `component-inventory.md §2.4` | ✅ 一致 |
| useLifecycle「禁裸 setInterval / 禁 new SseClient / poll 必须 justification」 | `component_architecture.md §3.10`（6 禁忌）+ index.md 原则 16 | ✅ 一致（本版把这些禁忌落到全部剩余 hook） |

### 4.2 发现的冲突（⚠️ 交 orchestrator 裁决 + 架构阶段更新 spec）

> 这些是**已有 spec 与 design-decisions（法律）矛盾**处。PRD 已按法律写；但旧 spec 若不更新会误导 coder。**建议：以 design-decisions 为准，架构阶段由 architect 更新对应 tech spec；orchestrator 确认。**

#### 冲突 C1（重大）：`useSessionRunState` 引擎「不迁」 vs design-decisions「必迁 + 拆解」

- **旧 spec 立场**：`component_architecture.md §3.4/§3.8` 把 `useSessionRunState` 定义为「playground + 单聊共用的 run 态引擎」，§3.10 迁移映射表明确标 **`useSessionRunState` / `usePageChatMount` / `useModelRestore` = 不迁**（「已是引擎/已符合生命周期模式」）；`component-inventory.md §5.3` 同列「不迁」。
- **design-decisions 立场（法律）**：§1「范围 = 全部迁移，含对话区引擎……拆 `useSessionRunState` monolith → area-hooks（`useMessages`/`useRunState`/`useUsage`/`useSummary`）」。
- **PRD 采用**：按法律——引擎必迁、拆 area-hooks（§2.2）。
- **待 orchestrator 裁决**：确认「引擎拆解」推翻旧 spec §3.4「不迁」判定。裁决后 **architect 必须重写 `component_architecture.md §3.4`**（引擎 → area-hooks）+ 更新 §3.10 迁移映射表（去掉「不迁」误导）。`usePageChatMount` 本 PRD 按法律纳入统一（design-decisions §1「usePageChatMount 统一」），`useModelRestore` 仍不迁（design-decisions 迁移地图 + §2.4）。

#### 冲突 C2（重大）：useLifecycle 契约方法名 — 旧 `init/destroy/refresh/poll` vs 新四方法 `onInit/onDestroy/onTick/onEvent`

- **旧 spec 立场**：`component_architecture.md §3.10` 现定义 `useLifecycle<TCtx>({ init, destroy, refresh?, poll?, deps })`——`init` 返回 ctx、`refresh` 仅轮询、`poll` 配置对象、**无 `onEvent`（SSE 帧不进契约，靠 init 内自己 subscribe + 手写 handler）**。
- **design-decisions 立场（法律）**：§2「按用户定义的**四方法重构 `useLifecycle`**」——`onInit(api)` / `onDestroy(ctx)` / `onTick(ctx)` / `onEvent(ctx,event,from)` + `reload()`；且新增 ①ref-latest 不变量（§3）+ ②数据三形标准化（§4）+ 控制模型（§5，useLifecycle 持 ctxRef+setCtx 句柄不外发，回调是纯函数返回新 ctx）。**onEvent 进契约**（SSE 帧到 → useLifecycle 调纯函数 onEvent 返回新 ctx，写回 ctxRef + setCtx）。
- **PRD 采用**：按法律——四方法 + ①ref-latest + ②三形 + 控制模型（§1.3、§2.2）。
- **待 orchestrator 裁决**：确认这是对 §3.10 useLifecycle 契约的**重新设计**（不是小改）。裁决后 **architect 必须重写 `component_architecture.md §3.10`**（四方法契约 + ref-latest 不变量 + 三形 reducer + 控制模型），这是 design-decisions §10 交付物①「契约 spec 落 §3.10 契约权威源」的明确要求。**这是本版本引入的新概念，必须先落 tech spec 再进编码**（概念先行原则）。

#### 冲突 C3（一致性提示，非矛盾）：迁移地图 §分版本计划 vs design-decisions §1「一次做完」

- **迁移地图立场**：`component_refactor_plan.md §分版本计划` 把引擎放 v0.0.95、左侧列表放 v0.0.96、useModelRestore/replay 放「后续」。
- **design-decisions 立场（法律）**：§1「不分版本，v0.0.94 一次做完」。
- **PRD 采用**：一次做完（§2.1 已注明迁移地图分版本计划作废）。迁移地图**仅作起点参考**（design-decisions §7：组件列表是地图不是法律）。
- **待 orchestrator 裁决**：确认 v0.0.94 范围 = 全部迁移（含引擎），非分版本。这决定任务规划的工作量（引擎拆解是高风险大头）。

### 4.3 架构阶段需重点定的开放点（PRD 无法定，交 architect）

> 以下是重构中影响正确性/范围的技术决策点，PRD 层无法拍板，需 architect 在 tech spec + change_plan 中定，orchestrator 确认。

1. **O1 — BudgetMeter 数据源：SSE 接线 vs onTick 兜底（语义匹配存疑）**
   - design-decisions §6 + 迁移地图：`session_usage_update` 已存在 → BudgetMeter 改接 SSE（「最易」）。
   - **但存疑**：`session_usage_update` 是**per-session** 用量（group=`session_id:<sid>`），而 `BudgetMeter` 是 **squad team-level 预算**（`GET /budget/usage?squadId`，跨该 squad 全部 session 累计）。单个 session 的 usage 帧 ≠ team 累计预算。**architect 需核实**：squad 级是否有对应聚合 topic/事件；若无，SSE 接线是否真能驱动 team budget 刷新，还是**必须退 `onTick` 兜底**（design-decisions §6 允许：「没 topic 又不加的 → onTick 轮询兜底」）。若走 SSE 需确认「接已存在 topic」的语义成立，否则如实退兜底 + justification。**不加新后端 topic（design-decisions §6 硬约束）。**

2. **O2 — `useMessages` 多订阅在四方法契约下的 onEvent switch 落地**
   - design-decisions §3/§8：`useMessages` = `agent_loop`（流式累积）+ `session_panel`(messages_cleared) 多订阅，onEvent 按 `from.topic` switch。`agent_loop` 保留 `applyAgentEventToMessages`（part 级，不套 applyCrud）；`session_panel`.messages_cleared 清空。architect 定 onEvent 内 topic 分发 + ctxRef 写回时机（配合 ①ref-latest 不丢帧）。

3. **O3 — session_panel fan-out 到 4 个 area-hook 的订阅关系重理**
   - `session_panel` 拆后被 `useRunState`(status) / `useUsage`(usage) / `useSummary`(summary) / `useMessages`(messages_cleared) **各订一份**（各 subId，fan-out，design-decisions 迁移地图：debuggability > efficiency，已接受）。architect 确认单例 SseClient + 定向投递（`sse_channel_multipub.md §3.9`）支持同 topic 多 subId，且 `session_panel` 不 replay（快照）下各 area-hook 靠 onInit GET 拿初值。
   - workspace_* 事件的扇出（引擎 `session_panel` → `store.lastWorkspaceEvent` → `SectionWorkspacePanel` 消费）在拆 area-hook 后由**谁**转发 store？（原引擎 monolith 转发；拆后 workspace_* 归哪个 area-hook 的 onEvent 转 store）——architect 定（迁移地图 §备注「对话区引擎迁后 fan-out 关系要重新理清」）。

4. **O4 — `reload()` 命令式口子在各 mutation 后的接线点**
   - design-decisions §2/§5：`reload()` 是唯一命令式口子（POST/PUT/DELETE 后主动调触发 re-init）。architect 定各写操作（发消息不需要—走 SSE；但改名/删会话/board CRUD/member 保存/cron CRUD/squad mutation）后哪些调 reload、哪些靠 meta 广播被动刷新（如 usePageChatMount 靠 session_meta 被动，不需 reload；SquadBoard 乐观 patch + reload 取真值）。

5. **O5 — PageConnector（config 页）是否纳入本版范围**
   - `component-inventory.md §6` + 迁移地图：PageConnector（5s poll）标「本次范围外/后续补」，但迁移地图 §分版本计划 v0.0.94 又列了它。design-decisions §1「全部迁移」主要指两个动态页（Playground/Studio）+ 引擎。**orchestrator 需明确**：本版是否含 config 页的 PageConnector（若含，走 `onTick` 兜底 + justification，不加新 topic）。PRD 暂列为「候选，待确认」（§2.3）。

6. **O6 — StudioSidebar 懒缓存 detailCache 迁 useLifecycle 的触发时机**
   - `StudioSidebar` 懒缓存是「展开 squad 行时才 GET /squad/:id」——非 mount 即拉。architect 定 useLifecycle 的 deps/onInit 如何表达「懒触发」（可能 deps 含 expanded 状态，或保留组件级触发 + hook 只管单条 detail 生命周期）。
