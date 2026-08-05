---
type: spec
title: panorama 数据流（横切：数据源矩阵 + SSE 中枢 + 三态语义）
priority: P1
status: active
updated: 2026-07-24
since: v0.0.189.dsl_board
---

# panorama 数据流（横切）

> 横切规范：涉及 `component-panorama-route` + `component-panorama-view` + `component-panorama-entity-modal` 三方的数据流、SSE 中枢设计、schema 三态语义、乐观更新边界、测试/排障陷阱。各组件 spec 仅描述自身职责，数据流的「为什么这样」集中在此。

## 1. 数据源矩阵

| 数据 | 来源 | 类型 | 消费者 |
|------|------|------|--------|
| schema DSL 文本 | `GET /squad/:squadId/panorama/schema` → `{dsl: string}`（v0.0.243 起恒含 task，永不 null） | REST（mount 一次 + schema_update 触发重拉） | route |
| schema 变更通知 | SSE `panorama_schema_update` | SSE | route |
| 实体实例列表 | `GET .../entities/:entity` | REST（切 tab / refresh / modal 打开预拉 ref） | view |
| 实体新建 | `POST .../entities/:entity` | REST | view.handleSubmit |
| 实体编辑 | `PATCH .../entities/:entity/:id` | REST（dirty patch） | view.handleSubmit |
| 状态跃迁 | `POST .../entities/:entity/:id/transition` | REST（非法 400 + reason） | view.handleTransition |
| 事件流 | `GET .../events?limit=20` | REST（mount / refresh） | view |
| 实体变更通知 | SSE `panorama_entity_update` | SSE（route 订阅 → 透传 view） | route → view（entityEvent prop） |

SSE 通道：`topic='panorama'` + `group=panoramaGroup(squadId)` = `panorama:squad:{squadId}:entity`，frame.data = `PanoramaSseEvent` union（schema_update / entity_update）。

## 2. schema 三态语义

route 持 `schema: PanoramaSchema | null | undefined`，三态对应三种 UI：

| state | 含义 | UI |
|-------|------|----|
| `undefined` | loading（首次 mount / squadId 切换 / schema_update 重拉中） | 整区加载占位，**tab 条不渲** |
| `null` | 理论不出现（v0.0.243 后端 `ensureSystemEntities` 兜底恒返含 task 的 DSL）；保留空态分支作防御 | 仍渲 tab 条；动态 views 为空 → 「更多」tab 追加，点击进 `<PanoramaIdle>`（空态引导） |
| `PanoramaSchema` | 工作态（已 parse DSL） | 完整 tab host：动态 views（task_kanban 首项）+ 固定「更多」tab |

**关键约定**：API 返回的是 DSL **文本**（`{dsl: string}`，v0.0.243 起恒含 task entity），route 用 `parsePanoramaDsl` YAML parse 后变 `PanoramaSchema` 对象。parse 失败（YAML 结构不合法）走 error 分支（`setSchema(undefined) + setError`），渲错误态 + 重试按钮——不与「未定义」混淆。

## 3. SSE 中枢设计：route 订阅 + view 受控透传

**核心决策**：SSE 在 route 层订阅**一次**，view 不自己订阅。

**why**：
1. **避免 tab 切换 subscribe/unsubscribe 抖动**——动态 tab 可能频繁切换，每次 mount/unmount 都 subscribe/unsubscribe 会制造 SSE 通道抖动 + 漏事件窗口；route 持久订阅，tab 切换只切 view 实例。
2. **schema_update 只 route 关心**（要重拉 schema + 重建 tab 装配 + 校验 activeTab）——view 拿到也没用，它吃 parsed schema prop。
3. **entity_update route 不自消费**——route 不知道当前激活 view 关心哪个实体，所以 `setEntityEvent` 放 state 透传给当前挂载的 view（view 通过 useEffect 监听 entityEvent prop 变化做乐观更新）。

**陷阱（route 切非动态 tab 时 entityEvent 残留）**：切到固定 tab / more tab 时 view 卸载，但 route state 里的 entityEvent 不清。切回动态 tab view 重挂载，`lastSeq` ref 重置为 -1，useEffect 会消费残留事件。**影响范围有限**（非 bug）：
- data 走 `if (!list) return prev;` 守卫——未缓存实体不动；
- events 列表可能追加一行 stale summary，下次 fetchEvents / refresh 覆盖；
- 拖拽 transition 的乐观更新不会被这残留触发（transition 走 handleTransition，不走 entityEvent 链）。

## 4. view 乐观更新边界

`useEffect(entityEvent)`：
- **seq 去重**：`lastSeq` ref 记最近处理 seq，重复 seq 早 return。
- **未缓存实体不预先 init**：`data[entity]` 不存在时 `return prev;`（避免乱建空列表污染 data，下次切 tab 正常 fetch）。
- 找到 id 替换、未找到 push；events 同步追加一行（按 seq 去重 + 截断 20）。

**拖拽 transition 的乐观时机**：`handleTransition` 在 `await transitionPanoramaEntity(...)` 成功**后**才 setData 移动卡片 + toast；失败（400 `panorama_illegal_transition`）天然不 setData → 卡片天然回弹（kanban UI 状态未变）+ toast 可读 reason。

## 5. 多视图原语边界

- **kanban**：仅 `group_by == states.field` 时列可拖（`isStateGrouping`）；**非状态分组完全不可拖**——卡片 `draggable=false`、列 onDragOver/onDrop 为 undefined（HTML5 DnD 不触发）。同列 drop 早 return 无操作。
- **table**：sort/limit 由前端按 DSL 声明应用（`applyDslOrder`），**不提供交互排序**。注意 sort 用 `String()` 对比——数字字段会按字典序排（已知约束，DSL 侧建议数字排序另想办法或用 string 字段）。
- **bar_chart**：bucket 按本地时区天聚合（`dayKey` 用本地日期 `getYesterday/getDate`，不是 UTC）；近 N 天范围外的 record 不计入；`stack_by` 非 enum 字段时 `stackGroups` 返回空数组 → 分段不渲（只渲柱子 outline）。

## 6. 实体弹层数据流（component-panorama-entity-modal）

- **modal 不拉数据、不调 API**：schema + 实例快照 + ref 选项由父 view 注入；保存回调 `onSubmit` 由父按 mode 调 POST/PATCH。
- **ref 字段选项数据来源**：父 view 在 modal 打开时 `useEffect(editing)` 检查 `entityDef.fields`，对 `ref` 类型字段未缓存的目标实体预拉（`fetchEntity(fdef.entity)`）→ 注入 `refOptions`。
- **edit 模式 status 字段只读**（why）：状态变更走 transition（拖拽 / 跃迁端点），服务端 PATCH 也过 transition 校验——锁死状态字段避免用户在 modal 改 status 被 server 拒（400 `panorama_illegal_transition`）。
- **字段控件 6 类**（DSL FieldDef union）：string→text / number→number / boolean→checkbox / enum→ChoiceCards(≤4)|Dropdown(>4)（禁原生 select，`_conventions §10`）/ ref→Dropdown（nullable）/ datetime→datetime-local。

## 7. 读 transcript / 写测试注意

- **SSE stub**：测试需 stub `getSseClient()`（sse-singleton）；subscribe 失败 catch 静默不阻塞 UI（断言 UI 仍渲染）。
- **schema_update 后 activeTab 校验**：schema 变化导致 activeTab 不合法时回落 'goals'（测试 schema 删 view 后 activeTab 应回落）。
- **拖拽失败必检 reason**：toast 文本应含 server 返回的可读 reason（`PanoramaApiError.message` 取 body.reason / message / error 中最可读字段）。
- **kanban 不可拖场景**：非状态分组断言卡片 `draggable=false`、列无 onDragOver（drop 不触发）。
- **mount schema=null vs parse error**：API null → 渲 tab 条 + 「更多」tab；parse 抛错 → 渲错误态 + 重试。两者不混淆。
