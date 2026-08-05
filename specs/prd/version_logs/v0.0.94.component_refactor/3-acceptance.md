## 5. 验收标准

> 本版本是纯重构——验收 = **功能不回归**（用户视角零差异）+ **契约达标**（机制标准化）+ **数据标准化**（三形落地）。三者缺一不可。

### 5.1 功能不回归（关键路径全绿 — 首要门槛）

- §3 全部关键用户路径（Playground P1–P13 + Studio S1–S8 + 跨页 X1–X2）对应的 E2E/API case **全绿**（design-decisions §9：UT 为主 + 关键路径 ET；引擎动最核心路径故 chat 流式 ET 必保）。
- **PRD 关键用户路径任意 case fail = 阻塞合并**（CLAUDE.md 合并门禁：不论 vision/dom/api）。
- 重构前后**用户可见行为完全一致**：会话列表/流式/工具调用/run 态/usage/三 tab/subagent 树/群聊/单聊/看板/预算/红点——逐项无差异。
- 无 API 契约变更 → 免 AT（design-decisions §9；`BudgetMeter` 接已存在 topic 不算契约变更）。如架构阶段 O1 定论需碰后端聚合，则该点补 AT。

### 5.2 契约达标（所有目标 hook 上四方法 + 无裸资源）

- **所有 §2.2 目标 hook 上 `useLifecycle` 四方法契约**（`onInit` / `onDestroy` / `onTick` / `onEvent`）——不再各写各的 useEffect 生命周期。
- **无裸 `setInterval`**：全部轮询走 `effect.startTimer` → `onTick`，每个 `onTick` 带 justification（cron / budget 兜底 / connector 如纳入）。grep `setInterval` 在目标组件内归零（useLifecycle 内部实现除外）。
- **无 `new SseClient()`**：`useStudioUnreadMeta` 违规独立实例修掉，统一 `getSseClient()` 单例 + subId 路由（`component_architecture.md §3.10` 6 禁忌 + 原则 16）。grep `new SseClient` 在业务 hook 内归零。
- **ref-latest 不变量为契约默认**（design-decisions §3）：`onEvent`/`onTick` 收到 `ctxRef.current`（永远最新），返回新 ctx 由 useLifecycle 同步写回 ref + setCtx。流式 area-hook（`useMessages`）不再靠各自手写 `sliceRef`。
- **控制模型**（design-decisions §5）：useLifecycle 持 ctxRef + setCtx 句柄不外发；回调是纯函数（旧数据 + 事件 = 新数据，return 新值，不碰 setState/订阅回收）。

### 5.3 数据标准化（三形落地）

- **每个 hook 恰好持一形一块数据**（design-decisions §4）：不再有一个 hook 揽 5 个区域（`useSessionRunState` monolith 拆完）。
- **数据按三形分类 + 调标准 reducer**：
  - list → `Collection<T>` + `applyCrud`（upsert/delete/replace by key）：会话列表 / cron / memory / board / squad detailCache。
  - 单个 → `Snapshot<T>` + replace/字段 patch：usage / runState / summary / budget。
  - kv → `KeyedMap<K,V>` + set/delete/clear by key：unread `Record<sid,bool>` / childrenByParent。
  - **流式特例**：`useMessages` 保留 `applyAgentEventToMessages`（part 级累积，不套 applyCrud），spec 里标明（design-decisions §4）。
- **对话区三页同源**：Playground `page-chat` / `SquadChatPage` / `MemberChatPage` compose 同一套 area-hook（`useMessages`/`useRunState`/`useUsage`/`useSummary`），不再各自起引擎。

### 5.4 交付物核对（design-decisions §10）

架构 + 编码完成后核对：

1. **契约 spec** — 四方法 + ①ref-latest + ②三形标准化 + 控制模型，落 `component_architecture.md §3.10`（契约权威源，重写）。→ architect（冲突 C2）
2. **全组件迁移方案表** — 组件 → 契约映射（本 PRD §2.2 三形表 + 迁移地图精修，按 design-decisions §7 原则重推）。→ architect（change_plan.md）
3. **参考例子** — 每形一个（Collection / Snapshot / KeyedMap）+ `useMessages` 流式特例。→ coder
4. **全组件代码迁移** — 含对话区引擎，全部上 useLifecycle 四方法。→ coder

### 5.5 spec 一致性（doc-modifier 阶段）

- **旧 spec 更新到位**（否则 spec 静默过时误导下游，CLAUDE.md 原则 12）：
  - `component_architecture.md §3.10` 重写为四方法契约（不再是 `init/destroy/refresh/poll`）。
  - `component_architecture.md §3.4` 引擎条目更新为 area-hooks 拆解（去「不迁」误导）+ §3.10 迁移映射表更新。
  - `component-inventory.md §5.3` 「不迁」清单更新（引擎移出「不迁」）。
- **代码 == spec 契约**：doc-modifier 验证实现走四方法 + 三形 + 单例，无静默偏离（如某 hook 仍裸 setInterval 而 spec 声明走 onTick）。

### 5.6 非门槛（明确排除）

- **不追求 100% 视觉像素还原**：本版无设计稿（reqs/ 无 *.html 原型），视觉保真度比对本项省略（CLAUDE.md：无设计稿时跳过）。UI 视觉沿用现状，只要功能不回归即可。
- **SSE 基建 B 类问题不做**（design-decisions §6）：orphan subId / catch-up / authz 等只在 spec 标「未来扩展点」，不在本版验收。
- **全局 store 释放（G3）不做**：`chat-slice` 跨页不释放是既有设计（`component-inventory.md §4.1`），本版不改（design-decisions 迁移地图 §6 禁忌：不把「store 不释放」当「组件已清理」，但也不在本版解决 store 释放）。
