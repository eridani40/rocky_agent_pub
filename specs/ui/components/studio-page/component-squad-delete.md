# component-squad-delete

> 层级: component（危险操作区 + 二次确认弹层）
> 文件: app/web/src/components/studio-page/component-squad-delete.tsx

## 职责
管理 tab 底部「危险操作区」：team 硬删除（解散）入口。删除按钮 → 打开二次确认弹层（复用 `component-modal-shell`）→ 用户须**输入完整队名匹配**才启用「确认删除」→ 确认后 `await onDelete()`，期间弹层保持 loading，父级发 `DELETE /squad/:id`（硬删：member session + 历史 + 调度全物理清，不可逆、无回收站）。边界：仅渲染 UI + 上抛，不含 API 调用；队名匹配校验在本组件（防误删）。

## Props
- squadName: string;              // 当前队名（二次确认须精确输入匹配）
- onDelete: () => Promise<boolean>; // 确认删除 → 父级发 DELETE /squad/:id；返回 true=成功（本组件关弹层）/ false=失败（保持打开可重试）

## 状态 / 交互
- 本地 `open` 弹层开关 + `confirmText` 输入态 + `submitting` 态（删除请求 in-flight：弹层不可关 + 确认按钮 disabled/spinner/文案切换）。
- 删除按钮常驻底部危险操作区（红色描边/danger 语义）；点击 `setOpen(true)`。
- 确认 → `matched` 时 `await onDelete()`，期间**弹层保持打开 + 确认按钮 loading（spinner + 「解散中…」文案）+ 不可关闭**（遮罩点击 / X / cancel 均失效，cancel 同时 HTML disabled）。
  - `onDelete` resolve **true（成功）→ 关弹层**（父级负责刷新 + 切走选中 + toast）。
  - `onDelete` resolve **false（失败）→ 弹层保持打开、loading 复位**，用户可重试（父级已 toast 失败原因）。

## 视觉基线
- **危险操作区**：管理 tab 底部  分隔 + 小标题（mono uppercase muted，「危险操作 / Danger Zone」）+ 一句 danger 说明（不可逆）+ 删除按钮 `btn-danger`。
- **弹层**：`component-modal-shell` widthPx=420；body 警示文案 + 队名回显 + 输入框（提示「输入队名 <name> 确认」）。confirmLabel 用 `FIELD_LABEL.replace(' uppercase', '')`（v0.0.315 修复：FIELD_LABEL 含 uppercase 导致 squadName 被强制大写，用户无法精确输入匹配原队名）。
- **布局稳定性**：确认按钮的启用/禁用只切 `disabled` + opacity（不改尺寸/不条件渲染按钮），避免布局位移（memory component-size-must-not-change-on-state）。

## 复用关系
- 数据链路: `page-studio` 提供 `onDelete` → `squad-api.deleteSquad(id)` → 成功后移除 squads

## 消费方

- `app/web/src/components/studio-page/component-manage-tab.tsx`
