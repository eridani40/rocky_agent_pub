---
type: spec
title: component-panorama-route — 全景 tab host（task 首项 + DSL 动态 tab + 固定「更多」tab；首页第二栏内嵌）
priority: P1
status: active
updated: 2026-08-03
since: v0.0.240
---

> **数据流横切**：数据源矩阵 / SSE 中枢设计 / schema 三态语义 / 乐观更新边界 / 测试陷阱见 `_panorama-data-flow.md`。本文件只描述 route 自身职责。
> v0.0.243 改造：恢复「更多」固定 tab（永远在最右）+ PanoramaIdle 引导（v0.0.240 删的组件恢复）；schema loader 删 null 分支合并（后端 `ensureSystemEntities` 保证 DSL 恒含 task，前端不再 `mergeBuiltinSchema` 合成——前端镜像废除，后端单一来源）。v0.0.240：原独立路由态改首页第二栏内嵌。

## 职责
首页第二栏「项目全景」的**统一 tab host + 状态分发器**：
1. 加载 squad 的 panorama schema（`GET /squad/:squadId/panorama/schema`，返 DSL 文本——v0.0.243 起恒含 task entity + task_kanban view，后端 `ensureSystemEntities` lazy 兜底）→ 前端 `parsePanoramaDsl`（最小结构守卫，不再合成 builtin——后端返 schema 已含 task）。
2. 统一 tab 装配：**DSL `schema.views` 动态 tab**（后端 inject 保证 `task_kanban` 恒在 views 首项）+ **固定「更多」tab 永远在最右**（`PANORAMA_MORE_TAB_ID = 'more'`，不依赖 schema）。
3. 统一 tab 条：动态 + 固定「更多」共用一条 tab 条、同一种视觉样式（`-mb-px border-b-2` + 激活 `border-b-fg font-semibold text-fg`）。
4. 按 activeTab 受控分发：动态 tab → `<PanoramaView activeViewId={activeTab}>`（受控 view）；`'more'` → `<PanoramaIdle onAtLeader={onAtLeader}>`（白卡引导，提醒让 leader 搭看板）。
5. 订阅 SSE（`topic="panorama"` + `group="panorama:squad:{squadId}:entity"`），收到 `panorama_schema_update` 重拉 schema + 重建 tab 装配；`panorama_entity_update` 透传 view。

边界：持 `activeTab` state（唯一 tab 状态源，默认 = `schema.views[0]?.id`，'more' 不作默认）；子组件 PanoramaView/PanoramaIdle 受控不持；渲 tab 条 + 按 activeTab 分发；管 schema 三态 + tab 装配合法性（schema 变化后校验 activeTab 仍合法——动态 view 或固定 'more'，否则回落 defaultTab）；不直调实体 CRUD；**无独立头部 / 返回键**（内嵌首页第二栏，由外层 SeatsPanel 提供容器与「项目全景」栏标题）。

## Props
- `squadId: string`
- `onAtLeader: () => void`       // **required**（v0.0.243 改）——idle「更多」tab 的 @leader 引导按钮用；链路：PanoramaIdle → PanoramaRoute → SeatsPanel → page-studio handler（找 leader member，建群聊 ChatNode，setMainView chat + prefill mention）

内部 state：
- `schema: PanoramaSchema | null | undefined`（undefined=loading；null=空态——理论不出现，后端 ensure 兜底恒返含 task 的 DSL；实际仅 loading / loaded 两态）
- `error: string | null`
- `entityEvent: PanoramaEntityUpdateEvent | null`（SSE entity_update 透传 view）
- `activeTab: string`（默认 = `schema.views[0]?.id`；'more' 不作默认；schema 变化后校验 activeTab 仍属 dynamicViews 或 === 'more'，否则回落 defaultTab）

## 状态 / 交互
### 加载流程
1. mount → `GET /squad/:squadId/panorama/schema` → parse DSL → setSchema（后端 ensure 保证 DSL 恒含 task，前端不再合并）。
2. loading → 渲加载占位（整区，tab 条不渲染）。
3. error → 渲错误态 + 重试按钮（整区，`data-action-key="studio.panorama.retry"`）。
4. 否则渲染统一 tab host（动态 views + 固定「更多」tab）。

### 统一 tab 装配
- 动态 tab：`dynamicViews = schema?.views ?? []`（`task_kanban` 恒在首项，后端 `injectSystemEntities` prepend 保证）；label = `view.label`（task tab = 「任务」）。
- 固定「更多」tab：永远在 tab 条最右（`PANORAMA_MORE_TAB_ID = 'more'`），label = `studio:panorama.tabs.more`。**不依赖 schema**——schema 即使为空也保留此 tab（用户原话：永远在最右，提醒用户可以用这个功能）。
- DSL view id 撞 `task_kanban`：后端 inject 强制覆盖 leader 变体（system-wins），前端 single-source 直渲 schema.views，不会双显。

### tab 分发
- activeTab = 动态 view id → 渲 `<PanoramaView squadId schema activeViewId={activeTab} entityEvent>`（统一渲染原语 + entity-modal）。
- activeTab = `'more'` → 渲 `<PanoramaIdle squadId onAtLeader={onAtLeader}>`（白卡引导：去群聊 @leader 让 leader 搭看板）。
- task tab 激活时，PanoramaView 据 `view.component='kanban'` + `group_by='status'` 渲 4 列 kanban（todo/waiting/in_progress/done）；toolbar 显示归档开关（`ArchiveSwitch`，仅 `view.filter.archived` 存在时——见 `component-panorama-view.md §toolbar`）。

### 单实例语义
- 动态 tab 间切换 = 同一 PanoramaView 实例受控 activeViewId 变更（per-entity data 缓存保持，view useEffect 重 fetch 对应 entity）——保留缓存避免每次切 tab refetch。
- 切到 'more' 不卸载 PanoramaView 缓存（条件渲染并行，切回动态 tab 缓存仍在）。

### SSE 订阅
- mount → `POST /sse/subscribe { topic: "panorama", group: "panorama:squad:{squadId}:entity" }`（subscribe 失败不阻塞 UI）。
- `panorama_schema_update` → 重新 `GET schema` + parse + 校验 activeTab。
- `panorama_entity_update` → `setEntityEvent` 透传 view（含 source='system' 的自动 transition 事件——乐观更新数据）。
- unmount → `POST /sse/unsubscribe`。

**为什么 route 订阅 SSE 而 view 不订**（核心中枢设计）：避免 tab 切换时 subscribe/unsubscribe 抖动 + 漏事件窗口；schema_update 只 route 关心；entity_update route 不自消费，放 state 透传当前挂载的 view（详见 `_panorama-data-flow.md §3`）。

## 复用关系
- 被 `component-seats-panel.tsx` 第二栏内嵌渲染（首页 IA，无独立路由态 / 无 onBack）。
- 组合：`component-panorama-view`（动态 tab 受控嵌入——task + 其他 view 共用）+ `component-panorama-idle`（'more' tab 引导卡）+ `component-panorama-archive-switch`（toolbar 归档开关，仅 view.filter.archived 时）。

## 视觉基线
- 无独立头部（内嵌首页第二栏，外层提供栏标题「项目全景」）。
- tab 条：`border-b` 分隔，按钮 `-mb-px border-b-2 px-3 py-1.5 text-[12.5px]`；激活 `border-b-fg font-semibold text-fg`，未激活 `border-b-transparent text-muted hover:text-fg-2`。
- task tab label「任务」（TASK_VIEW_DEF.label 配死中文，后端落盘）；「更多」tab label = i18n `studio:panorama.tabs.more`。
- 无设计稿 → 功能 PASS + token 对齐即验收。
