# component-export-team-picker-modal（团队导出选择器 modal）

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-export-team-picker-modal.tsx
> 相关: section-team-sync.tsx / lib/squad-api.ts（listSquads）/ lib/team-sync-api.ts（exportSquad）
> 本文是「团队同步」tab 导出选择器弹层的**概念权威源**。

## 1. 定位 + 设计意图

[v0.0.321] 新增受控 modal：点「导出团队」后弹**简版团队列表**（`listSquads()` 全量），选一个团队 → 确定 → 父级 `exportSquad(selectedId)` 下载 zip。

**为什么弹层**：此前导出直下当前团队（`squadId`），无 studio 会话时按钮直接 disabled——用户无法导出其他团队。改选择器后：
- 无 studio 会话（`squadId=null`）仍可弹层，从全量列表选任意团队导出（`no_squad_hint` 仅提示不阻断）
- 仅 1 个团队也弹层（不短路直下，交互一致）

**范式 = 即时操作 + L3 modal**：无 SaveBar / 不进 page-tab dirty（team_sync 页 `TAB_KV_GROUPS.team_sync = []` 即时操作页）。**受控组件**（`open` 由父级 `section-team-sync` 管理），无 × / 遮罩点击 / ESC 关闭（与 ConfirmModal 视觉一致，关闭路径只有取消 + 确定两条）。

## 2. Props 契约

| prop | 类型 | 说明 |
|------|------|------|
| `open` | `boolean` | 是否显示（false 时返回 null） |
| `loading` | `boolean` | 拉取列表中（显示 loading 态） |
| `error` | `string \| null` | 拉取失败文案（显示 error + 重试） |
| `squads` | `SquadSummary[]` | 团队列表（`GET /squad`，后端 updatedAt desc） |
| `selectedId` | `string \| null` | 当前选中项（null → 确定 disabled） |
| `onSelect(id)` | `(id: string) => void` | 行点击选中 |
| `onConfirm()` | `() => void` | 确定（父级 `exportSquad` + 关闭 + flash） |
| `onCancel()` | `() => void` | 取消（父级作废在途请求 + 关闭） |
| `onRetry()` | `() => void` | 重试（重新 `listSquads`） |

配套导出状态类型 `ExportPickerState`（`section-team-sync.tsx` 持有）：`{ open, loading, error, squads, selectedId }`。

## 3. 四态渲染

1. **loading**（`export-picker-loading`）：「加载中…」居中
2. **error**（`export-picker-error`）：失败文案 + 「重试」按钮（`export-picker-retry-btn`）
3. **empty**（`export-picker-empty`）：「没有可导出的团队」（确定 disabled）
4. **normal**（`export-picker-list`）：`<ul>` 列表，行 = 团队名（truncate ellipsis）+ 「{{count}} 个成员」muted；点击行高亮选中（`export-picker-item-{id}`）

底部按钮恒显：「取消」（`data-action-key=common.confirm-modal.cancel`）+「确定」（`export-picker-confirm-btn`，primary，`!selectedId || loading` disabled）。

## 4. 竞态守卫（父级 exportGenRef）

`section-team-sync.tsx` 持 `exportGenRef`（`useRef(0)`）代数守卫，三路径递增：
- **打开**（`openExportPicker`）：`const gen = ++exportGenRef.current`，try/catch 双分支 resolve 前 `gen !== exportGenRef.current` 则丢弃
- **取消**（`closeExportPicker`）：`gen++` 作废在途 `listSquads`（不重弹 modal）
- **确定**（`handlePickerConfirm`）：`gen++` + 关闭 + flash

**默认选中**：`squadId`（当前团队，在列表内）?? 列表第一项（后端 updatedAt desc）?? null（空列表）。

## 5. 可见文案（E2E 定位契约）

| 文案 | 位置 | testid |
|------|------|--------|
| 选择要导出的团队 | modal title | export-picker-modal |
| 加载中… | loading 态 | export-picker-loading |
| 团队列表加载失败 / 重试 | error + 重试 | export-picker-error / export-picker-retry-btn |
| 没有可导出的团队 | empty 态 | export-picker-empty |
| {name}（{{count}} 个成员） | 列表行 | export-picker-list / export-picker-item-{id} |
| 确定 | 底部主按钮 | export-picker-confirm-btn |
| 取消 | 底部次按钮 | data-action-key=common.confirm-modal.cancel |

## 6. 复用关系

- 被组合：`section-team-sync.tsx`（`ExportPickerState` + `handleExport`/`handlePickerConfirm`/`closeExportPicker`/`handlePickerRetry`）
- 数据：`lib/squad-api`（`listSquads`）+ `lib/team-sync-api`（`exportSquad`，父级调用）
- 视觉对齐：`common/component-confirm-modal`（fixed inset-0 遮罩 + 居中 card 同款）

## 7. 视觉基线

- 遮罩：`fixed inset-0 z-50 flex items-center justify-center bg-black/40`
- 卡片：`rounded-lg bg-surface border border-border p-6 max-w-md w-full mx-4 shadow-lg`
- title：`text-[15px] font-semibold text-fg mb-2`
- 列表：`max-h-[60vh] overflow-y-auto flex flex-col gap-1 mb-4`；行选中 `border-accent bg-accent/10 text-fg`，未选中 `border-transparent hover:bg-bg-warm text-fg-2`
- 主按钮：`px-4 py-1.5 rounded-md text-sm bg-accent text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed`
- 次按钮：`px-4 py-1.5 rounded-md text-sm border border-border text-fg-2 hover:bg-bg-warm`
- 字体 weight 仅 400/600（收敛，禁 serif/mono）
