# section-config-layout

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-config-layout.tsx

## 职责
三栏 config 布局（app/dev/合并设置页共用）：左 group 列表（自渲染以匹配 ET 锚点 `group-item-{groupId}`）+ 右 配置区（KV 模式 = 每 key 一张 `component-key-card`；或 page 注入的自定义节点）。v0.0.317 起 group 底部 save-bar 已废弃，统一走 tab 级 SaveBar（`page-app-settings-merged` 底部渲染 `common/component-save-bar`）。
**数据源**：REST CRUD 无 SSE——本 section 是纯展示布局，不直接调 API；KV group 加载/保存由 page（`page-app-settings-merged` + `useAppSettingsConfig` + `app-settings-persist.ts`）持有，save 走 `PUT /config/app` body={group,key,data}。
边界：
- 不持 key 编辑态本地副本（`onKeyChange` 即时上抛由 page/hook 维护）；保存态（dirty/saving/saved）由 page 维护并经 `dirtyOf`/`savingOf`/`savedOf` 传入。
- group 切换由 `onSelectGroup` 上抛。

## Props
- groupId: string
- keys: KeyInfo[];                 // KV 形态；自渲染 group（providers/observability/p...
- saveMode?: 'group' | 'item';     // 'group'(默认)=整组延迟保存(底部 save-bar)；'item'=逐项...
- entryKind?: 'group' | 'system-toggle';  // 'group'(默认)=普通项；'system-toggle'=分割...
- systemExpanded?: boolean;        // 当前是否展开（按钮文案 + chev rotate + data-expanded）
- onSystemToggle?: () => void;     // 点击 toggle 展开/收起
- groups: GroupInfo[];             // 全部 group（含 system-toggle sentinel 条目）
- selectedGroup: string;           // 当前选中 groupId
- onSelectGroup: (groupId: string) => void
- onSaveGroup: (groupId: string) => void
- onKeyChange: (groupId: string, key: string, next: unknown) => void
- dirtyOf: (groupId: string) => boolean;   // page/hook 维护，按 groupId 查
- savingOf: (groupId: string) => boolean
- savedOf?: (groupId: string) => boolean;  // BUG-011「已保存」1.5s flash 反馈

## 状态 / 交互
- 纯展示 + 转发：选 group → 右侧渲染其配置区（`renderGroupArea` 优先，否则 KV key-card 网格）；key 编辑 → `onKeyChange`；点保存 → `onSaveGroup`。
- group 保存独立：底部 save-bar 仅 `saveMode='group'`（默认）渲染；`saveMode='item'` 的 group（providers/observability/plugin）无底部条。
