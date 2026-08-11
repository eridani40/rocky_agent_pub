# v0.0.316 — 配置面板统一保存按钮

> PRD: `specs/prd/v0.0.316-unified-save.md` | change_plan: `specs/tech/version_logs/v0.0.316/change_plan.md`
> 4 个配置面板从「混合即时生效 + 多独立 save」统一为「一 tab 一 save，dirty 高亮，点保存统一提交」。

## P0: 管理 tab — GroupChatToggle 受控化 + ManageTab dirty 扩展

`component-group-chat-toggle.tsx`：从「自管 PATCH + pending/error」改为纯受控上报。Props 从 `{squadId, enableGroupChat, onPatch}` 改为 `{enableGroupChat, onChange}`；去掉 error banner / pending 态。

`component-manage-tab.tsx`：新增 `enableGroupChat` draft state，dirty 判定追加 `enableGroupChat !== detail.enableGroupChat`；save() 合并 PATCH 追加 `enableGroupChat`。保持现有 BTN_PRIMARY 风格（不引入 TabSaveBar）。

## P1: 自动工作 tab — 3 子组件受控化 + AutoworkTab dirty 管理者

`component-autowork-tab.tsx`：从「纯容器」提升为「dirty 管理者」。持 3 个独立 draft useState（enableHeartBeat / heartbeatConfig / budget，D2：不合并为单一对象）；dirty 派生（三字段各自 !== detail 对应字段，复合对象 JSON.stringify 比较）；save() 一次 PATCH 合并 3 字段；cancel() draft 回 detail 原值；useEffect `[detail]` 同步外部变化。底部新增统一保存/取消按钮（BTN_PRIMARY 风格）。

3 个子组件改受控：
- `component-squad-autonomy-toggle.tsx`：Props 从 `{squadId, enableHeartBeat, onPatch}` 改为 `{enableHeartBeat, onChange}`；去掉 pending/error。
- `section-heartbeat-config.tsx`：Props 从 `{squadId, enableHeartBeat, heartbeatConfig, members, timezone, onSave}` 改为 `{enableHeartBeat, heartbeatConfig, members, timezone, onChange}`；三子控件（interval/activeWindows/scope）改 draft 后汇总为一个 heartbeatConfig 对象上报；去掉 save/reset 按钮 + pending/error。
- `component-budget-meter.tsx`：Props 从 `{squadId, budget, onSaveBudget, savePending}` 改为 `{squadId, budget?, onChange?}`；budgetOn 从 useState 改为派生 `budget != null`；limitValue 派生 `budget?.limit ?? DEFAULT_LIMIT`；去掉 save 按钮 + savePending。usage 轮询（useLifecycle）不变。

## P2: 工具 tab — 4 section forwardRef + useTabDirtyAggregator hook

4 个 section（`section-web-search-config.tsx` / `section-web-fetch-config.tsx` / `section-see-image-config.tsx` / `section-bash-config.tsx`）：`forwardRef` 包装 + `useImperativeHandle` 暴露 `{ save, reset }`；内部 GET/draft/save 逻辑不变；去掉底部 save/reset toolbar JSX；新增 `onDirtyChange` prop + `useEffect(() => onDirtyChange?.(dirty), [dirty])` 声明式 dirty 上报。

`use-tab-dirty-aggregator.ts`（新增 hook，D4-revised）：`handles` ref Map 仅管 save/reset（命令式）；`dirtyMap` useState 管 dirty（声明式，触发 re-render）；`reportDirty(key, dirty)` callback 上报；`isDirty()` = dirtyMap 有任一 true；`saveAll()` = 遍历 dirty section `Promise.allSettled` 并行；`resetAll()` = 同步遍历。section 侧 ref 只暴露 `{ save, reset }`（去掉 isDirty，改由 onDirtyChange 上报）。

`page-app-settings-merged.tsx`：工具 tab dirty/save/cancel 改为消费 aggregator（`isDirty()` OR KV group dirty；`saveAll()` + KV group save）。

## P3: 可观测性 tab — observability section 受控化

`observability-config/section-observability.tsx`：`forwardRef` + useImperativeHandle 暴露 `{ save, reset }` + `onDirtyChange`。detail 编辑从即时 persist 改为攒 draft（ref.save 时 persist）；list toggle/delete 保留即时（操作类，同 deploy/bench 性质，D5）。

## fix: aggregator dirty 上报机制重设计（方案 B → D1-revised / D4-revised）

原 D1/D4 设计（ref 遍历 isDirty 模式）有架构级缺陷：ref 不触发 re-render，section 内部 dirty 变化无法通知 page。修复：dirty 走 `useState` 声明式上报（section → `onDirtyChange` callback → page setState → re-render）；save/reset 走 ref（命令式，不需触发 re-render）。SectionSaveHandle 接口去掉 `isDirty`（改由 onDirtyChange 上报）。
