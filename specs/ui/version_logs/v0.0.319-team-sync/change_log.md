# v0.0.319 — UI Change Log（团队同步 tab：导出/导入团队配置）

> 增量变更。全量权威：`specs/ui/components/app-dev-config-page/section-team-sync.md`（组件契约）+ `specs/ui/overall/03-config-center.md`（配置中心页面契约）+ `specs/ui/components/app-dev-config-page/page-app-settings-merged.md`（sidebar tab 装配）。
> 对应 PRD：`specs/prd/v0.0.319-team-sync.md`；技术契约：`specs/tech/version_logs/v0.0.319/change_plan.md` + `change_log.md`。
> 范围：仅应用设置页新增「团队同步」tab；其他板块零变化。**纯前端零 API 契约变更**（复用 GET /session?biz=studio、GET /squad、POST /squad/import 两阶段）。

## §1 组件 spec 更新/新增

### `specs/ui/components/app-dev-config-page/section-team-sync.md`（新增）

团队同步 tab 内容区根组件（`SectionTeamSync`，文件 `section-team-sync.tsx`）：

- **定位**：`page-app-settings-merged` sidebar「用户设置」区 **memory 之后新增 tab「团队同步」**（tabId=`team_sync`，`app-settings-config-defs.ts` 注册：`TabId` union 加 `'team_sync'`、`APP_SETTINGS_TABS` memory 后插入 `{ id:'team_sync', labelKey:'tab.team_sync.label', groups:['team_sync'], inSystemArea:false }`、`TAB_KV_GROUPS.team_sync=[]`）。
- **范式**：**独立操作页**（即时操作，非 A/B/C 配置范式）——**不走 SaveBar / page-tab dirty**；`section-tab-panel.tsx` switch 加 `case 'team_sync': return <SectionTeamSync />`（不进 dirty/saveBar）。
- **squadId 来源（ET 修复后实现细节）**：挂载时 `listStudioSessions()`（`GET /session?biz=studio`，按 updatedAt desc）→ `items.find(s => s.squadId)` 取**最近活跃带 squadId 的 studio 会话** → `squadId` + `activeSessionId`。**不用 useChatStore**（playground 专属 store，chat-slice.ts:183 拒纳 biz=studio 会话 → squadId 永远 undefined，ET blocking 根因，见 tech change_log §3.2）。
- **三态视图**：`view: {kind:'landing'} | {kind:'importing'; importKey; manifest}`：
  - **landing**：desc 文案 + 两按钮「导出团队」（`team-sync-export-btn`，`!squadId` disabled）/「导入团队」（`team-sync-import-btn`，触发隐藏 file input）+ 无 squad 提示（`team-sync-no-squad-hint`）+ 导入完成提示（`team-sync-imported-hint`）。
  - **导出**：`exportSquad(squadId)`（lib/team-sync-api，`<a href download>`）→ flash「导出成功，浏览器开始下载 zip 文件」。
  - **importing（导入 step1）**：选文件 → `previewImport(file)`（POST /squad/import?step=preview）→ manifest 信息卡（团队名/Leader/成员 N 人列表）+ 新团队名输入框（预填 manifest.name，`team-sync-name-input`）+ 重名警告（`team-sync-dup-warning`「已存在同名团队，导入后会有两个同名团队」，`listSquads()` 比对，提醒不阻止）+ 取消按钮（回 landing）。
  - **importing（导入 step2）**：确认 modal（`ConfirmModal`「即将创建团队「{name}」，包含 N 个成员。确认导入？」）→ `executeImport(importKey, name, activeSessionId?)`（POST /squad/import?step=execute）→ flash「导入成功：团队「{name}」已创建（N 个成员）」+ 导入完成提示。
- **重名检测**：文件选择后 + 团队名输入变更时实时 `listSquads()` 比对（失败静默不阻断）。
- **flash toast**：studio 页同款最小可见反馈（`team-sync-toast`，fixed bottom 居中，3s 自动消失，无全局 toast 框架）。
- **消费方**：`section-tab-panel.tsx`（`case 'team_sync'`）；被组合：`common/component-confirm-modal`（`ConfirmModal`）；数据：`lib/team-sync-api`（`exportSquad`/`previewImport`/`executeImport`）+ `lib/squad-api`（`listSquads`/`listStudioSessions`）。

## §2 实现核对（doc-modifier 阶段 5）

| 实现文件 | 与 spec 一致性 |
|---|---|
| `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | ✅ `TabId` + `APP_SETTINGS_TABS` memory 后插入 + `TAB_KV_GROUPS.team_sync=[]` |
| `app/web/src/components/app-dev-config-page/section-tab-panel.tsx` | ✅ `case 'team_sync'` → `<SectionTeamSync />`，不进 dirty/saveBar |
| `app/web/src/components/app-dev-config-page/section-team-sync.tsx` | ✅ 三态视图 + squadId 来源 listStudioSessions（ET 修复后）+ 重名检测 + ConfirmModal + flash toast |
| `app/web/src/lib/team-sync-api.ts` | ✅ `exportSquad`（a[href] download）+ `previewImport` + `executeImport`（coder2 拆分防 squad-api.ts 超 300 行） |
| `app/web/src/lib/squad-api.ts` | ✅ `listStudioSessions`（GET /session?biz=studio）+ `listSquads`（重名比对） |
| `app/web/src/i18n/locales/{zh-CN,en}/app-dev-config.json` | ✅ `tab.team_sync.label`（团队同步/Team Sync）+ `team_sync.*` 全部文案中英同步 |

**实现偏离（ET blocking 修复）**：squadId 来源弃 `useChatStore` 改 `listStudioSessions`（change_plan D7 未指定来源实现；PRD §2.1「仅当当前 session 属于某个 squad 时显示此 tab」语义保持——无 studio 会话 → 导出 disabled + 提示）。详见 tech change_log §3.2。

## §3 i18n 同步

- `tab.team_sync.label`：zh「团队同步」/ en「Team Sync」
- `team_sync.*`：desc / export_btn（导出团队）/ import_btn（导入团队）/ cancel_btn / no_squad_hint / export_success / import_invalid / import_failed / preview_team / preview_leader / preview_members（成员（N 人））/ name_label（新团队名称）/ dup_warning / confirm_title / confirm_body / confirm_ok / import_success / imported_hint

## §4 组件删除清单

无（全部新增）。
