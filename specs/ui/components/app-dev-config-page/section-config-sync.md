# section-config-sync（应用设置 配置同步 tab）

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-config-sync.tsx
> 相关: section-config-sync-export.tsx / section-config-sync-import.tsx / section-config-sync-types.ts / component-config-tree.tsx
> 本文是应用设置「配置同步」tab 右栏配置区的**概念权威源**。

## 1. 定位 + 设计意图

`section-config-sync` 是 `page-app-settings-merged` 的 sidebar「用户设置」区 **memory tab 紧邻下方新增 tab「配置同步」**（tabId=`config_sync`）选中后右栏渲染的配置区。提供**模型 provider + 工具（web_search/web_fetch/see_image/bash）配置的一键导入导出**，实现跨机器配置同步。

**范式 = 独立操作页（即时操作）**：导入导出是「下载文件/上传文件」类即时操作，**不是配置编辑**——因此：
- **不走 SaveBar**：`TAB_KV_GROUPS.config_sync = []`（`app-settings-config-defs.ts`），不进 KV dirty
- **不进 page-tab dirty**：`section-tab-panel.tsx` switch `case 'config_sync'` 直接渲染，无 dirty 跟踪
- 自管 state（view 三态 + toast），无需保存/取消

**与 `section-user-memory`（全局长期记忆 tab）的关系**：同层级相邻 tab（memory 下方），各自独立 section，无共享组件。

## 2. tab 注册（app-settings-config-defs.ts）

- `TabId` union 加 `'config_sync'`
- `APP_SETTINGS_TABS` 在 memory 后插入 `{ id: 'config_sync', labelKey: 'tab.config_sync.label', groups: ['config_sync'], inSystemArea: false }`
- `TAB_KV_GROUPS` 加 `config_sync: []`（自渲染，不进 KV dirty）
- `SYSTEM_TABS` 不含 config_sync（用户设置区，非系统收起区）

## 3. 三态视图（ViewMode: 'landing' | 'export' | 'import'）

根组件 `SectionConfigSync` 持 `view` state + `toast` state（4s 自动消失，`role="status"`，成功绿/失败红）。

### landing 态（默认）
两个大按钮（flex-col 卡片式，hover 高亮）：
- **「导出配置」**（`config-sync-export-btn`）→ `setView('export')`；副标题「将模型和工具配置导出为加密文件」
- **「导入配置」**（`config-sync-import-btn`）→ `setView('import')`；副标题「从加密文件导入模型和工具配置」

### export 态 → `<ExportView>`（section-config-sync-export.tsx）
- 挂载时 `GET /provider`（`loadProvidersAndProtocols`）→ `buildSelectAll(全部 label, TOOL_TAB_IDS)` **默认全选**；失败 toast「加载配置失败」
- 渲染 `<ConfigTree mode="export" providers tools selected onSelectionChange>`
- 底部「导出」按钮（`config-sync-do-export`）：**无任何选中项 disabled**；点击 → `collectExportData(selected)` + `triggerDownload(data)` → toast「导出成功，N 个模型配置、M 个工具配置」
- 顶部「返回」（`config_sync.back`）→ 回 landing

### import 态 → `<ImportView>`（section-config-sync-import.tsx）
1. 挂载自动触发文件选择器（隐藏 `<input type="file" accept=".json">`，`config-sync-file-input`）
2. 选文件 → `parseImportFile(file)`：
   - 失败 → 错误提示区（`config-sync-parse-error`）+「重新选择文件」链接；不进树形页
   - 成功 → `getLocalProviders()` + `checkDuplicateLabels(providers, local)` → `buildSelectAll(文件 providers label, 文件 tools 中 TOOL_TAB_IDS 交集)` 默认全选
3. 渲染 `<ConfigTree mode="import" providers tools duplicateLabels selected onSelectionChange>`
4. 底部「导入」按钮（`config-sync-do-import`）：无选中 disabled → 点击弹 **ConfirmModal**（`component-confirm-modal`）：
   - title「确认导入」/ body「即将导入 {{providerCount}} 个模型配置、{{toolCount}} 个工具配置，工具配置将覆盖现有设置。确认导入？」/ ok「确认导入」/ cancel「取消」
5. 确认 → `executeImport(parsedData, selected)` → toast「导入成功：N 个模型配置、M 个工具配置」→ `onImported()` 回 landing（配置页自动刷新）

## 4. 可见文案（E2E 定位契约）

| 文案 | 位置 | testid |
|------|------|--------|
| 配置同步 | sidebar tab 名 | tab-tree-item-config_sync |
| 导出配置 / 将模型和工具配置导出为加密文件 | landing 按钮 | config-sync-export-btn |
| 导入配置 / 从加密文件导入模型和工具配置 | landing 按钮 | config-sync-import-btn |
| 加载中… | 数据加载 | — |
| 返回 | export/import 顶部 | — |
| 导出 / 导出中… | export 底部按钮 | config-sync-do-export |
| 导入 / 导入中… | import 底部按钮 | config-sync-do-import |
| 重新选择文件 | import 错误后链接 | — |
| 即将导入 N 个模型配置、M 个工具配置，工具配置将覆盖现有设置。确认导入？ | ConfirmModal | — |
| 导出成功，N 个模型配置、M 个工具配置 / 导入成功：N 个模型配置、M 个工具配置 | toast | — |

## 5. 复用关系

- 被组合：`section-tab-panel.tsx`（`case 'config_sync'`，`page-app-settings-merged` 的 sidebar 装配）
- 组合：`ExportView` / `ImportView` / `component-config-tree`（`ConfigTree`）/ `common/component-confirm-modal`（`ConfirmModal`）
- 共享类型：`section-config-sync-types.ts`（`ViewMode` / `ToastState` / `buildSelectAll`）
- 数据能力：`lib/config-crypto` / `lib/config-sync-export` / `lib/config-sync-import`（见 tech change_log）

## 6. 视觉基线

- 无设计稿（新增功能，PRD 定义交互）→ 视觉基线在组件 spec 内定，与 app-dev-config 页既有风格对齐
- landing 按钮：`px-5 py-4 rounded-lg border border-border hover:border-accent hover:bg-bg-warm transition-colors`；标题 `text-[15px] font-semibold text-fg` + 副标题 `text-[12px] text-muted`
- 底部操作按钮：`px-5 py-2 rounded-md text-sm bg-accent text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed`
- toast：`mb-4 px-4 py-2 rounded-md text-[13px]` 成功 `bg-green-500/15 text-green-600` / 失败 `bg-red-500/15 text-red-600`
- 字体 weight 仅 400/600（收敛，禁 serif/mono）
