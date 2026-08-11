# section-team-sync（应用设置 团队同步 tab）

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-team-sync.tsx
> 相关: lib/team-sync-api.ts / lib/squad-api.ts / common/component-confirm-modal.tsx / component-export-team-picker-modal.tsx
> 本文是应用设置「团队同步」tab 右栏配置区的**概念权威源**。

## 1. 定位 + 设计意图

`section-team-sync` 是 `page-app-settings-merged` 的 sidebar「用户设置」区 **memory tab 之后新增 tab「团队同步」**（tabId=`team_sync`）选中后右栏渲染的配置区。提供**当前团队配置导出 zip / 从 zip 导入建新团队**，实现跨机器团队配置迁移（AGENTS.md + 成员定义 + 技能 + 记忆 + 模板 + 命令 + 权限配置）。

**范式 = 独立操作页（即时操作）**：导出/导入是「下载文件/上传文件」类即时操作，**不是配置编辑**——因此：
- **不走 SaveBar**：`TAB_KV_GROUPS.team_sync = []`（`app-settings-config-defs.ts`），不进 KV dirty
- **不进 page-tab dirty**：`section-tab-panel.tsx` switch `case 'team_sync'` 直接渲染，无 dirty 跟踪
- 自管 state（view 三态 + flash toast + busy），无需保存/取消

**与 `section-config-sync`（配置同步 tab，v0.0.318）的关系**：同层级相邻 tab（merge 后 config_sync 在 memory 与 team_sync 之间），各自独立 section；config_sync 管模型/工具配置，本组件管团队级配置（成员 + 规则 + .rocky 全套）。

## 2. tab 注册（app-settings-config-defs.ts）

- `TabId` union 加 `'team_sync'`
- `APP_SETTINGS_TABS` 在 memory 后插入 `{ id: 'team_sync', labelKey: 'tab.team_sync.label', groups: ['team_sync'], inSystemArea: false }`
- `TAB_KV_GROUPS` 加 `team_sync: []`（自渲染，不进 KV dirty）
- `SYSTEM_TABS` 不含 team_sync（用户设置区，非系统收起区）

## 3. squadId 来源（ET 修复后实现细节）

挂载时 `listStudioSessions()`（`GET /session?biz=studio`，按 updatedAt desc）→ `items.find(s => s.squadId)` 取**最近活跃带 squadId 的 studio 会话** → `squadId` + `activeSessionId`。

**不用 useChatStore**（playground 专属 store，`chat-slice.ts:183` 拒纳 biz=studio 会话 → studio 团队会话 squadId 永远 undefined → 导出按钮永远 disabled，ET blocking 根因）。修复见 `specs/tech/version_logs/v0.0.319/change_log.md §3.2`。

**语义保持**（PRD §2.1）：无任何 studio 会话 → `no_squad_hint` 提示（**[v0.0.321] 不再禁用导出按钮**——仍可点「导出团队」弹选择器从全量列表选其他团队）；有团队会话 → 导出可用。

## 4. 三态视图（ViewState: 'landing' | 'importing'）

根组件 `SectionTeamSync` 持 `view` state + `busy` + `flash`（3s 自动消失，studio 页同款最小可见反馈，fixed bottom 居中）。

### landing 态（默认）
- desc 文案 + 两按钮：
  - **「导出团队」**（`team-sync-export-btn`，`busy || picker.open` disabled）→ **[v0.0.321] 弹导出选择器** `ExportTeamPickerModal`（`component-export-team-picker-modal.tsx`）：`listSquads()` 拉全量 → 默认选中 `squadId`（在列表内）?? 列表第一项（后端 updatedAt desc）→ 点「确定」`exportSquad(selectedId)`（lib/team-sync-api，`<a href download>`）→ flash「导出成功，浏览器开始下载 zip 文件」
  - 选择器 4 态：loading（`export-picker-loading`）/ error + 重试（`export-picker-error` + `export-picker-retry-btn`，重新 `listSquads`）/ empty（`export-picker-empty`，确定 disabled）/ normal（`export-picker-list` 列表，行点击高亮，`{{count}} 个成员`）
  - **竞态守卫**：`exportGenRef` 代数——打开（`++gen`）/ 取消（`gen++` 作废在途）/ 确定（`gen++` 关闭）三路径递增；try/catch 双分支 resolve 前 `gen !== exportGenRef.current` 则丢弃（取消后旧请求不重弹 modal）
  - **「导入团队」**（`team-sync-import-btn`）→ 触发隐藏 `<input type="file" accept=".zip">`（`team-sync-file-input`）
- 无 squad 提示（`team-sync-no-squad-hint`「当前会话不属于任何团队。仍可点「导出团队」从列表选择其他团队。」）+ 导入完成提示（`team-sync-imported-hint`「导入完成，请到团队列表查看新团队。」）

### importing 态（导入两阶段）
**step1 文件选择 → preview**：
1. 选 `.zip` 文件 → `previewImport(file)`（POST /squad/import?step=preview）
2. 成功 → manifest 信息卡（`team-sync-preview`）：团队名 / Leader / 成员（N 人）+ 成员名列表
3. **新团队名输入框**（`team-sync-name-input`，预填 manifest.name，必填）
4. 重名警告（`team-sync-dup-warning`「已存在同名团队，导入后会有两个同名团队」，`listSquads()` 比对，**提醒不阻止**）
5. 失败 → flash 错误信息（`import_invalid`「请选择有效的团队导出文件（.zip）」或后端 message），停留 landing
- 「取消」（`team-sync-cancel-btn`）→ 回 landing

**step2 确认 → execute**：
1. 点「导入」（`team-sync-confirm-import-btn`，`!importName.trim()` disabled）→ 弹 **ConfirmModal**（`common/component-confirm-modal`）：
   - title「确认导入」/ body「即将创建团队「{name}」，包含 N 个成员。确认导入？」/ ok「导入」/ cancel「取消」
2. 确认 → `executeImport(importKey, name, activeSessionId?)`（POST /squad/import?step=execute）→ flash「导入成功：团队「{name}」已创建（N 个成员）」+ 导入完成提示

**重名检测时机**：文件选择后 + 团队名输入变更时实时 `listSquads()` 比对（失败静默不阻断导入）。

## 5. 可见文案（E2E 定位契约）

| 文案 | 位置 | testid |
|------|------|--------|
| 团队同步 | sidebar tab 名 | tab-tree-item-team_sync |
| 导出当前团队配置为 zip，或从 zip 导入创建新团队（含 AGENTS.md、成员定义、技能、记忆、模板、命令、权限配置）。 | landing desc | — |
| 导出团队 | landing 按钮 | team-sync-export-btn |
| 导入团队 | landing 按钮 / importing 确认按钮 | team-sync-import-btn / team-sync-confirm-import-btn |
| 当前会话不属于任何团队。仍可点「导出团队」从列表选择其他团队。 | 无 squad 提示 | team-sync-no-squad-hint |
| 选择要导出的团队 | 导出选择器 title | export-picker-modal |
| 加载中… | 选择器 loading | export-picker-loading |
| 团队列表加载失败 / 重试 | 选择器 error + 重试 | export-picker-error / export-picker-retry-btn |
| 没有可导出的团队 | 选择器 empty | export-picker-empty |
| {name}（{{count}} 个成员） | 选择器列表行（点击高亮） | export-picker-list / export-picker-item-{id} |
| 确定 / 取消 | 选择器底部按钮 | export-picker-confirm-btn / data-action-key=common.confirm-modal.cancel |
| 导出成功，浏览器开始下载 zip 文件 | flash | team-sync-toast |
| 请选择有效的团队导出文件（.zip） | 文件无效 | — |
| 团队名 / Leader / 成员（N 人） | manifest 信息卡 | team-sync-preview |
| 新团队名称 | 输入框 label | team-sync-name-input |
| 已存在同名团队，导入后会有两个同名团队 | 重名警告 | team-sync-dup-warning |
| 即将创建团队「{name}」，包含 N 个成员。确认导入？ | ConfirmModal | — |
| 导入成功：团队「{name}」已创建（N 个成员） | flash | team-sync-toast |
| 导入完成，请到团队列表查看新团队。 | 导入完成提示 | team-sync-imported-hint |

## 6. 复用关系

- 被组合：`section-tab-panel.tsx`（`case 'team_sync'`，`page-app-settings-merged` 的 sidebar 装配）
- 组合：`common/component-confirm-modal`（`ConfirmModal`，导入确认）/ `component-export-team-picker-modal`（`ExportTeamPickerModal`，[v0.0.321] 导出选择器）
- 数据：`lib/team-sync-api`（`exportSquad` / `previewImport` / `executeImport`）+ `lib/squad-api`（`listSquads` / `listStudioSessions`）

## 7. 视觉基线

- 无设计稿（新增功能，PRD 定义交互）→ 视觉基线在组件 spec 内定，与 app-dev-config 页既有风格对齐
- 主按钮：`px-4 py-1.5 rounded-md text-sm bg-accent text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed`
- 次按钮：`px-4 py-1.5 rounded-md text-sm border border-border text-fg-2 hover:bg-bg-warm disabled:opacity-50`
- 输入框：`px-3 py-1.5 rounded-md border border-border bg-surface text-sm text-fg`
- 信息卡：`rounded-lg border border-border p-4 bg-surface`
- flash toast：`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-fg text-surface px-4 py-2 text-[13px] shadow-lg`
- 字体 weight 仅 400/600（收敛，禁 serif/mono）
