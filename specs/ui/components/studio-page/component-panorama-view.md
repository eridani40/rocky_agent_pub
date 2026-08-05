---
type: spec
title: component-panorama-view — 全景通用渲染器（kanban/table/bar_chart 装配，受控 view + 归档开关）
priority: P1
status: active
updated: 2026-08-03
since: v0.0.189.dsl_board
---

> **数据流横切**：数据源矩阵 / SSE 透传 / 乐观更新边界 / 多视图原语陷阱见 `_panorama-data-flow.md`。本文件只描述 view 自身职责。
> v0.0.243：事件流面板默认折叠（`collapsed` 初始 true，之前默认展开——减少视觉噪声，用户主动展开看历史）。v0.0.240：toolbar 加 `ArchiveSwitch` 归档开关槽位（仅 `view.filter.archived` 存在时显示）+ view.filter 透传 fetch + 卡片 hover 归档按钮 + 已归档卡片视觉弱化（opacity 0.55）。

## 职责
tab 激活时的**全景工作面板**（渲染当前 view 的渲染原语 + toolbar + 弹层 + 事件流）：
1. 吃 route 注入的 `activeViewId`（route 保证是 schema.views 中合法 view id），从 schema 查找当前 view。
2. 根据 `view.component` 装配对应渲染原语：`kanban` / `table` / `bar_chart`。
3. toolbar 单行模式：左组归档开关（仅 `view.filter.archived` 声明时）+ 右组新建/刷新。
4. **fetch 时透传 `view.filter`**：序列化为 `?filter=k:v,k2:v2`（与 `handleListEntities` 解析对齐）；归档开关 `with_archived` 模式时不传 filter（看全部含归档）。
5. 拖拽改状态（kanban + group_by==states.field 时）→ `POST .../transition`，非法跃迁 toast。
6. 弹层新建/编辑实体 → `component-panorama-entity-modal`。
7. 卡片 hover 显示归档按钮 → `PATCH .../entities/:entity/:id { archived:true }`，乐观从活跃视图移除（archiveMode='active' 时）。
8. 事件流面板（可折叠）展示 `events.jsonl` 投影。
9. SSE 实体变更 → 乐观更新（卡片移动/新增/字段刷新；含 `source='system'` 的自动 transition——task 依赖自动解除走此通道）。

边界：吃父级注入的 parsed schema（落盘的 board.yaml，含 task entity + task_kanban view——后端 `ensureSystemEntities` 兜底）+ 受控 `activeViewId`（不持 activeTab state、不渲 tab 条——tab 条上提 route）；实体数据自己 fetch（`GET entities/:entity?filter=...`）；调实体 CRUD/transition/归档 API；不调 schema 写 API。

## Props
- `squadId: string`
- `schema: PanoramaSchema;            // 落盘的 board.yaml（含 task entity + task_kanban view，后端 ensureSystemEntities 兜底）`
- `activeViewId: string;              // 受控 view id（route 保证合法）`
- `entityEvent?: PanoramaEntityUpdateEvent | null;  // route 透传的 SSE entity_update（乐观更新数据源）`
- `members?: Member[];                // owner 字段软解析字典（task owner=string member id，渲染 join member.name）`
- `onAtLeader?: () => void;           // 透传 entity-modal @ 按钮`

内部 state：
- `data: Record<entityName, Record<string,unknown>[]>`（per-entity 实例缓存）
- `editing: { entity, id? } | null`（弹层编辑/新建目标）
- `archiveMode: 'active' | 'with_archived'`（默认 'active'；仅 `view.filter.archived` 存在时启用）
- `collapsed: 事件流面板折叠态`（默认 true——v0.0.243 改，事件流默认收起减少视觉噪声）
- entityEvent prop 变化 → 乐观更新 data + 事件流追加一行（按 seq 去重——lastSeq ref；未缓存实体不乐观加，下次切 tab 拉取）
- activeViewId prop 变化 → useEffect 重 fetch 对应 entity 数据（带当前 view.filter）
- archiveMode 变化 → 重 fetch（active=带 filter / with_archived=不带 filter）

## 状态 / 交互
### view 解析
- `view = schema.views.find(v => v.id === activeViewId)`；route 保证合法，未找到 return null。
- toolbar 行独立渲染（无 tab 条，tab 条在 route）。

### kanban 渲染（component=kanban）
- 卡片标题 = `interpolate(view.card.title, record)`，badges = card.badges 字段渲染。
- **响应式列宽（v0.0.223）**：列从固定 `w-[240px] shrink-0` 改 `min-w-[200px] flex-1`——窄屏列收窄、宽屏多列平铺，容器 `overflow-x-auto` 兜底（不破坏窄屏可用）。
- **甬道多通道色块（v0.0.223，防色弱）**：列头色从 8×8px 小圆点改四通道编码——① 列顶全宽色带（`h-1 w-full`，bg=statusColor）② 列头底色（statusColor 经 `rgba()` alpha 解析；6 位 hex 转 rgba，非 6 位 transparent 兜底——color-mix 在 jsdom 被丢弃不可测，故用 rgba）③ 状态文字带色（列标题 `style={{color: statusColor}}`）④ 卡片左缘竖条（`border-l-4` + `borderLeftColor: statusColor`）。`statusColor()` 映射本身不动（DSL `display.status_colors` 驱动，缺省灰）。**视觉精修待设计师 demo**（色带高度/色号/几何可能微调）。
- **已归档卡片视觉弱化（v0.0.240）**：`record.archived === true` 时卡片 `opacity-55`（archiveMode='with_archived' 切换时可见，活跃模式被 filter 隐藏不渲染）。
- **卡片 hover 归档按钮（v0.0.240，仅 view.filter.archived 时显示）**：hover 卡片右上角显「归档」icon 按钮 → `PATCH .../entities/:entity/:id { archived:true }`；成功乐观从 data 移除（archiveMode='active' 时下次 fetch 已带 filter 清掉）；预占位布局稳定（禁 `display:none`）。
- `group_by == states.field` → 列可拖拽（dragstart/drop）。
  - 成功 → 乐观移动卡片 + toast。
  - 失败（`panorama_illegal_transition`）→ 卡片回弹 + toast 可读 reason。
- **非状态分组完全不可拖**：`isStateGrouping` false 时卡片 `draggable=false`、列 onDragOver/onDrop 为 undefined（HTML5 DnD 不触发）；同列 drop 早 return 无操作。
- 卡片点击 → 弹 `component-panorama-entity-modal`（mode=edit）。

### table 渲染（component=table）
- columns = view.columns，表头 = `fields[col].label`（兜底字段名；label 可中文，表头样式不做 uppercase）。
- enum 类型列单元格 = display labels：状态机字段走 `display.status_labels`，其他 enum 走 `display.{field}_labels`，均无配置兜底原值；非枚举字段直渲 `String(raw)`。
- sort/limit 由 DSL 声明（前端不覆盖 DSL 排序配置）。
- **sort 对比用 `String()`**：数字字段按字典序排（已知约束，DSL 侧建议用 string 排序字段）；前端不提供交互排序。
- 行点击 → 弹 modal（mode=edit）。

### bar_chart 渲染（component=bar_chart）
- 近 N 天 bucket（`view.bucket.field` + `view.bucket.days`）。
- stack_by 存在 → 分段堆叠 + 图例。
- 纯展示，不可交互（无点击 / 拖拽）。
- **bucket 边界**：按**本地时区天**聚合（`dayKey` 用本地 `getDate/getMonth`，不是 UTC）；近 N 天范围外的 record 不计入；`stack_by` 非 enum 字段时 `stackGroups` 返回空 → 分段不渲（只渲柱子 outline + total 数字）。

### toolbar
- 左组：`ArchiveSwitch` 归档开关（**仅 `view.filter.archived` 声明时显示**——`component-panorama-archive-switch`，segmented `active`/`with_archived`，默认 `active`；切换触发重 fetch）。
- 右组：`+新建` 按钮（按当前 view.entity 派发 → 弹 modal mode=create）+ `刷新` 按钮（重新 fetch data）。
- 归档开关显示条件 = `Object.prototype.hasOwnProperty.call(view.filter, 'archived')`（task system entity view 永远满足；leader DSL entity 声明 `archived` 字段 + view 加 filter 时也显示——通用化）。

### 事件流面板
- 底部可折叠面板（**默认收起 `collapsed=true`**——v0.0.243 改，减少视觉噪声；用户点 toolbar 展开看历史）。
- `GET .../events?limit=20` 拉最近事件。
- SSE 收到 entity_update → 追加一行（按 seq 去重 + 截断 20）。
- 每行展示：seq + summary + type 标记。

### SSE 乐观更新边界（吃 route 透传的 entityEvent prop）
- **seq 去重**：`lastSeq` ref 记最近处理 seq，重复 seq 早 return。
- **未缓存实体不预先 init**：`data[entity]` 不存在时 `return prev;`（避免乱建空列表污染 data，下次切 tab 正常 fetch）。
- 找到 id 替换、未找到 push。
- **拖拽 transition 乐观时机**：`handleTransition` 在 `await` 成功后才 setData 移动卡片 + toast；失败天然不 setData（卡片天然回弹）+ toast 可读 reason。

## 复用关系
被 `component-panorama-route` 渲染（动态 tab 激活时——task system entity + leader DSL view 共用；'more' tab 渲 PanoramaIdle 不走本组件）。
组合：`component-panorama-entity-modal`（弹层）+ `component-panorama-archive-switch`（toolbar 归档开关）+ `component-panorama-kanban` / `component-panorama-table` / `component-panorama-bar-chart` / `component-panorama-events`。

## 视觉基线
- 吃现有 design token（`specs/tech/app/frontend/[P0]design_system.md`），与 squad-board 视觉一致。
- toolbar 高度 28px。
- kanban 列 / 卡片 / table / bar_chart 样式复用 board 已有视觉模式（颜色 = DSL display.status_colors）。
- 无设计稿 → 功能 PASS + token 对齐即验收。
