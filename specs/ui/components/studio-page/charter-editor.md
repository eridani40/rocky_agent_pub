# charter-editor

> 层级: component
> 文件: app/web/src/components/studio-page/component-charter-editor.tsx

## 职责
charter 编辑器（嵌管理 tab）：4 字段（goals/workingStyle/collaboration/escalation）独立 textarea + reason 输入 + 保存（PUT /squad/:id/charter，仅改动字段作 partial patch）+ 变更历史折叠（GET history 倒序）。边界：保存上抛父级；历史懒加载；未改动或 reason 空时保存 disabled。

## Props
- detail: SquadDetail
- onSaveCharter: (patch: CharterPatch, reason: string) => Promise<void>

## 状态 / 交互
- 本地 charter 4 字段态 + reason；`patch` = 仅与 `detail.charter` 不同的字段（partial）；`dirty` = patch 非空。
- 保存可点条件：`dirty && reason.trim`（reason 必填。保存后清 reason + 刷新已展开历史。
- 历史折叠：点击 toggle 懒加载 `getCharterHistory(squadId)`，时间倒序列表。

## 视觉基线
- **reason**：单行 `input`（同输入基线）；有改动但 reason 空时 `field-hint` 提示。
- **保存按钮**：`btn-primary`（accent 实底），disabled 时 `opacity-40`。

## 复用关系
- 被组合: `component-manage-tab`（squad-panel 管理 tab）
- 组合: `studio-icons` / `studio-styles`
