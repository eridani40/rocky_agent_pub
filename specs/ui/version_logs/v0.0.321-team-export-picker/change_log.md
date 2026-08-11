# v0.0.321 — UI Change Log（团队导出选择器）

> 增量变更。全量权威：`specs/ui/components/app-dev-config-page/section-team-sync.md`（组件契约）+ `specs/ui/components/app-dev-config-page/component-export-team-picker-modal.md`（新增组件契约）。
> 对应 PRD：`specs/prd/version_logs/v0.0.321-team-export-picker.md`；技术契约：`specs/tech/version_logs/v0.0.321/change_plan.md` + `change_log.md`。
> 范围：仅 team_sync 页导出流程改弹选择器 + i18n 文案；**纯前端零 API 契约变更**（复用 GET /squad + GET /squad/:id/export）。

## §1 组件 spec 更新/新增

### `specs/ui/components/app-dev-config-page/section-team-sync.md`（修改）

- **导出流程重写**（§4 landing 态 + §5 可见文案 + §6 复用关系）：点「导出团队」不再直下当前团队，改弹 `ExportTeamPickerModal` 选择器——`listSquads()` 拉全量 → 默认选中 `squadId`（在列表内）?? 列表第一项 → 点确定 `exportSquad(selectedId)` 下载 zip → flash「导出成功」。
- **导出按钮 disabled 语义变化**：`!squadId`（无 studio 会话禁用）→ `busy || picker.open`（不再因无 squadId 禁用——无 studio 会话仍可弹层选其他团队，`no_squad_hint` 文案同步改「仍可点导出团队从列表选择其他团队」）。
- **竞态守卫**：`exportGenRef` 代数（打开/取消/确定三路径递增），取消后旧 `listSquads` resolve 不重弹 modal。

### `specs/ui/components/app-dev-config-page/component-export-team-picker-modal.md`（新增）

受控 modal 组件契约（`ExportTeamPickerModal`，文件 `component-export-team-picker-modal.tsx`，139 行）：

- **props**：`open / loading / error / squads: SquadSummary[] / selectedId / onSelect(id) / onConfirm() / onCancel() / onRetry()`
- **4 态**：loading（`export-picker-loading`「加载中…」）/ error（`export-picker-error` 失败文案 + `export-picker-retry-btn`「重试」）/ empty（`export-picker-empty`「没有可导出的团队」）/ normal（`export-picker-list` 列表，行 = 团队名 ellipsis + 「{{count}} 个成员」muted，点击高亮）
- **底部**：「取消」（`data-action-key=common.confirm-modal.cancel`）+「确定」（`export-picker-confirm-btn`，primary，`!selectedId || loading` disabled）
- **视觉**：fixed inset-0 遮罩 + 居中 card（对齐 ConfirmModal）；列表 `max-h-[60vh] overflow-y-auto`
- **范式**：即时操作 + L3 modal，无 SaveBar（team_sync 页 `TAB_KV_GROUPS.team_sync = []`）
- **消费方**：`section-team-sync.tsx`（`ExportPickerState` 状态 + `handleExport`/`handlePickerConfirm`/`closeExportPicker`/`handlePickerRetry`）

## §2 实现核对（doc-modifier 阶段 5）

| 实现文件 | 与 spec 一致性 |
|---|---|
| `app/web/src/components/app-dev-config-page/component-export-team-picker-modal.tsx` | ✅ 新增 139 行，4 态 + 受控 + 视觉对齐 ConfirmModal |
| `app/web/src/components/app-dev-config-page/section-team-sync.tsx` | ✅ handleExport 弹选择器 + exportGenRef 竞态守卫（三路径递增）+ 按钮 disabled 语义 |
| `app/web/src/i18n/locales/{zh-CN,en}/app-dev-config.json` | ✅ `team_sync.export_picker.*` 7 key 双语 + `no_squad_hint` 文案更新 |

**实现偏离**：`openExportPicker` 的默认选中比 change_plan D2 多一层防御（`squadId` 不在列表 → 第一项，空列表 → null）——review MINOR-1 补强，语义不变。

## §3 i18n 同步

- `team_sync.export_picker.title`：zh「选择要导出的团队」/ en「Select a team to export」
- `team_sync.export_picker.loading`：「加载中…」/「Loading…」
- `team_sync.export_picker.load_failed`：「团队列表加载失败」/「Failed to load team list」
- `team_sync.export_picker.retry`：「重试」/「Retry」
- `team_sync.export_picker.empty`：「没有可导出的团队」/「No teams to export」
- `team_sync.export_picker.member_count`：「{{count}} 个成员」/「{{count}} members」
- `team_sync.export_picker.confirm`：「确定」/「Confirm」
- `team_sync.no_squad_hint`：改「当前会话不属于任何团队。仍可点「导出团队」从列表选择其他团队。」/「This session is not in any team. You can still click "Export Team" to pick one from the list.」

## §4 组件删除清单

无（全部新增/修改）。
