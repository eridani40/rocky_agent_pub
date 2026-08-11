# v0.0.318 — UI Change Log（配置同步 tab：模型 + 工具配置导入导出）

> 增量变更。全量权威：`specs/ui/components/app-dev-config-page/`（section-config-sync / component-config-tree 组件契约）+ `specs/ui/overall/03-config-center.md`（配置中心页面契约）+ `specs/ui/components/app-dev-config-page/page-app-settings-merged.md`（sidebar tab 装配）。
> 对应 PRD：`specs/prd/v0.0.318-config-sync.md`；技术契约：`specs/tech/version_logs/v0.0.318/change_plan.md` + `change_log.md`。
> 范围：仅应用设置页新增「配置同步」tab；其他板块零变化。**纯前端零后端**（复用 GET/POST /provider、GET/PUT /config/app，无 API 契约变更）。

## §1 组件 spec 更新/新增

### `specs/ui/components/app-dev-config-page/section-config-sync.md`（新增）

配置同步 tab 内容区根组件（`SectionConfigSync`，文件 `section-config-sync.tsx`）：

- **定位**：`page-app-settings-merged` sidebar「用户设置」区 **memory 下方新增 tab「配置同步」**（tabId=`config_sync`，`app-settings-config-defs.ts` 注册：`TabId` union 加 `'config_sync'`、`APP_SETTINGS_TABS` memory 后插入 `{ id:'config_sync', labelKey:'tab.config_sync.label', groups:['config_sync'], inSystemArea:false }`、`TAB_KV_GROUPS.config_sync=[]`）。
- **范式**：**独立操作页**（即时操作，非 A/B/C 配置范式）——**不走 SaveBar / page-tab dirty**；`section-tab-panel.tsx` switch 加 `case 'config_sync': return <SectionConfigSync />`（不进 dirty/saveBar）。
- **三态视图**：`view: 'landing' | 'export' | 'import'`（`section-config-sync-types.ts` 的 `ViewMode`）：
  - **landing**：两个大按钮「导出配置」（`config-sync-export-btn`）/「导入配置」（`config-sync-import-btn`），各自标题 + 副标题说明。
  - **export**：渲染 `<ExportView>`（`section-config-sync-export.tsx`）——挂载时 `GET /provider` → 默认全选 → ConfigTree(mode='export') → 底部「导出」按钮（无选中 disabled）→ `collectExportData` + `triggerDownload` → toast 成功/失败。
  - **import**：渲染 `<ImportView>`（`section-config-sync-import.tsx`）——挂载自动触发文件选择器（`<input type=file accept=".json">`）→ `parseImportFile`（失败显示错误 + 「重新选择文件」）→ `getLocalProviders` + `checkDuplicateLabels` → ConfigTree(mode='import', duplicateLabels) 默认全选 + 重名标签 → 底部「导入」按钮 → **ConfirmModal**（「即将导入 N 个模型配置、M 个工具配置，工具配置将覆盖现有设置。确认导入？」）→ `executeImport` → toast + 刷新。
- **toast**：成功/失败自动消失（4s），`role="status"`。
- **消费方**：`section-tab-panel.tsx`（`case 'config_sync'`）；被组合：`ExportView` / `ImportView` / 共享 `ToastState`/`buildSelectAll`（`section-config-sync-types.ts`）。

### `specs/ui/components/app-dev-config-page/component-config-tree.md`（新增）

配置同步 checkbox 勾选树（`ConfigTree`，文件 `component-config-tree.tsx`）：

- **Props**：`mode: 'export'|'import'`、`providers: {label, protocolId?}[]`、`tools: string[]`、`duplicateLabels?: Set<string>`（仅 import）、`selected: SelectionState`、`onSelectionChange`。
- **SelectionState**（`config-sync-export.ts` 导出）：`providers: Set<string>`（**key=label**，非 id）+ `tools: Set<string>`（key=tabId）。
- **树结构**：两棵固定两层树（非递归文件树）——根 folder「模型配置」（`config-tree-folder-模型配置`）+「工具配置」（`config-tree-folder-工具配置`）→ 叶子（provider label / 工具 tab 名，`config-tree-leaf-{id}`）。
- **checkbox 三态交互**：folder 联动子节点全选/取消（`onToggle(childIds, checked)`）；leaf 独立切换；folder 部分子节点选中 → **indeterminate 半选态**（`ref` 设 `el.indeterminate`）。
- **import 模式重名标签**：`duplicateLabels.has(label)` → 叶子后显示「存在重名」badge（`config-tree-dup-{label}`，amber 底）——**不置灰、不阻止勾选**（老板拍板）。
- **空态**：providers 空 → 「无可导出的模型配置」；工具恒 4 个 tab 叶子。
- **消费方**：`section-config-sync-export.tsx`（mode='export'）+ `section-config-sync-import.tsx`（mode='import'）。

### lib（无 UI 渲染，属数据/能力层，附记）

- `app/web/src/lib/config-crypto.ts`：AES-256-CBC 加解密 + `{v,payload}` 壳 + 类型 `ConfigExportData`/`ProviderExportItem`/`ConfigExportFile`；密钥派生 `SHA-256(KEY_PREFIX + SHA-256(SALT) 截 32 hex)`（**md5→SHA-256 偏离，见 tech change_log §2**）。
- `app/web/src/lib/config-sync-export.ts`：`SelectionState` + `TOOL_TAB_MAP`（工具 tab→group/key）+ `TOOL_TAB_IDS`（4 个工具 tab）+ `collectExportData`（读 provider + 工具 group，剥离 id）+ `triggerDownload`（Blob + `<a>` click，文件名 `rocky_agent_config_YYYYMMDD_HHmmss.json`）。
- `app/web/src/lib/config-sync-import.ts`：`parseImportFile`（JSON 解析 + unwrapExport 解密校验，错误 3 种可读 message）+ `checkDuplicateLabels`（label 精确匹配）+ `executeImport`（逐条 createProvider+createModel + 整 tab putConfigGroup）+ `getLocalProviders`。

## §2 实现核对（doc-modifier 阶段 5）

| 实现文件 | 与 spec 一致性 |
|---|---|
| `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | ✅ `TabId` + `APP_SETTINGS_TABS` memory 后插入 + `TAB_KV_GROUPS.config_sync=[]`，均对齐 D1 |
| `app/web/src/components/app-dev-config-page/section-tab-panel.tsx` | ✅ `case 'config_sync'` → `<SectionConfigSync />`，不进 dirty/saveBar |
| `app/web/src/components/app-dev-config-page/section-config-sync.tsx` | ✅ 三态 view + landing 两入口按钮 + toast 自动消失；98 行 ≤300 |
| `app/web/src/components/app-dev-config-page/section-config-sync-export.tsx` | ✅ 挂载 GET /provider + buildSelectAll 默认全选 + ConfigTree(export) + 导出按钮 disabled 逻辑 + triggerDownload；97 行 ≤300 |
| `app/web/src/components/app-dev-config-page/section-config-sync-import.tsx` | ✅ 文件选择 → parseImportFile（错误提示 + 重新选择）→ checkDuplicateLabels → ConfigTree(import, 重名标签) + ConfirmModal → executeImport + onImported 回 landing；166 行 ≤300 |
| `app/web/src/components/app-dev-config-page/component-config-tree.tsx` | ✅ 两棵两层树 + folder 联动 + leaf 独立 + indeterminate 三态 + import 重名标签 + label 作 key；216 行 ≤300 |
| `app/web/src/components/app-dev-config-page/section-config-sync-types.ts` | ✅ `ViewMode` / `ToastState` / `buildSelectAll` |
| `app/web/src/lib/config-crypto.ts` | ✅ encrypt/decrypt/wrap/unwrap + v 校验 + SHA-256 偏离注释（L48-58） |
| `app/web/src/lib/config-sync-export.ts` | ✅ TOOL_TAB_MAP 对齐 PRD §3.2 + collectExportData 剥离 id + triggerDownload 文件名格式 |
| `app/web/src/lib/config-sync-import.ts` | ✅ parseImportFile 3 错误场景 + checkDuplicateLabels + executeImport 逐条注入/整 tab 覆盖 |
| `app/web/src/i18n/locales/{zh-CN,en}/app-dev-config.json` | ✅ `tab.config_sync.label`（配置同步/Config Sync）+ `config_sync.*` 全部文案中英同步 |

零 code↔spec 偏离（除 tech change_log §2 已记录的 md5→SHA-256 密钥派生偏离，leader 裁决接受）。

## §3 i18n 同步

- `tab.config_sync.label`：zh「配置同步」/ en「Config Sync」
- `config_sync.*`：loading/back/tree(providers 模型配置, tools 工具配置, empty_providers, duplicate_label 存在重名)/export(title/desc/do_export/exporting/success/failed/load_failed)/import(title/desc/do_import/importing/reselect/parse_failed/success/failed/confirm_title/confirm_body/confirm_ok/confirm_cancel)
- `tab.tools.{web_search,web_fetch,see_image,bash}`：工具 tab 叶子名（zh 网络搜索/网络抓取/看图理解/命令行）

## §4 组件删除清单

无（全部新增）。
