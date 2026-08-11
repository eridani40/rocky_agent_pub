---
type: change_log
title: v0.0.321 — 团队导出选择器 + leader agent 实名命名修复
version: v0.0.321
date: 2026-08-10
related_prd: specs/prd/version_logs/v0.0.321-team-export-picker.md
related_change_plan: specs/tech/version_logs/v0.0.321/change_plan.md
grounded: change_plan D1/D2 + coder2/coder3 实现 + code-reviewer2 复审（MAJOR-1 竞态守卫）
---

# v0.0.321 — 团队导出选择器 + leader agent 实名命名修复

> 一句话：**「导出团队」从「直下当前团队」改为「弹选择器选团队再下载」**（复用 GET /squad + GET /squad/:id/export）；同时修复 **leader agent 文件命名**——模板/导入产出 `{leaderName}-{memberId}.md`（实名，与其他成员 `{name}-{memberId}.md` 前缀一致），导出还原 `leader.md`（兼容旧 `leader-{id}.md`）。**零 API 契约变更**（api change_log 已记录）。

## 1. 变更总览

**后端（4 文件修改，纯内部 service 逻辑）**：

| 模块 | 文件 | 说明 |
|------|------|------|
| 模板服务 | `app/server/src/services/squad-template-service.ts` | `applyTemplate` 加可选第 6 参 `leaderName?`、`copyTemplateFiles` 加可选第 4 参 `leaderName?`——`role==='leader' && leaderName` 时产出 `{leaderName}-{memberId}.md`（不再 `leader-{id}.md`），其余 role 不变 |
| 创建 handler | `app/server/src/handlers/squad.ts` | `handleCreateSquad` 调用 `applyTemplate` 追加 `body.leader.name` |
| 导入服务 | `app/server/src/services/team-sync-import-service.ts` | `importSquadFromTempDir` 调用 `copyTemplateFiles` 追加 `manifest.leaderName` |
| 导出服务 | `app/server/src/services/team-sync-export-service.ts` | 新增 `restoreAgentFileName(fileName, leaderName?)`：实名 `{leaderName}-{ULID}.md` → `leader.md`（模板 key）；否则 fallback `stripMemberIdSuffix`（兼容旧 `leader-{id}.md` 与普通成员）；`exportSquadToZip` 打包调用改用它 |

**前端（1 新增 + 1 修改 + 2 i18n）**：

| 模块 | 文件 | 说明 |
|------|------|------|
| 导出选择器 | `app/web/src/components/app-dev-config-page/component-export-team-picker-modal.tsx`（新建，139 行） | 受控 modal（`ExportTeamPickerModal` + `ExportPickerState` 类型）：4 态（loading / error+重试 / empty / 列表）+ 列表行点击高亮 + 底部确定/取消 |
| 页面 | `app/web/src/components/app-dev-config-page/section-team-sync.tsx` | `handleExport` 改为弹选择器（`openExportPicker`：`listSquads()` 拉全量 → 默认选中 `squadId`（在列表内）?? 第一项 → 确定 `exportSquad(selectedId)` 下载）；`exportGenRef` 代数守卫（打开/取消/确定三路径递增，防取消后旧 resolve 重弹 modal）；导出按钮 `disabled={busy || picker.open}` |
| i18n | `app/web/src/i18n/locales/{zh-CN,en}/app-dev-config.json` | `team_sync.export_picker.*`（title/loading/load_failed/retry/empty/member_count/confirm）+ `no_squad_hint` 文案改「仍可点导出团队从列表选择其他团队」 |

## 2. 编码阶段修复（review 后追加，commit 记录）

### 2.1 取消竞态代数守卫（commit ac2de2f3c，review MAJOR-1）

**现象**：打开选择器 → loading 中取消 → 在途 `listSquads()` resolve 后 `setPicker({open:true,...})` 会把已关闭的 modal 重新弹回。

**修复**：`exportGenRef`（`useRef(0)`）代数守卫——三路径递增：
- **打开**（`openExportPicker`）：`const gen = ++exportGenRef.current`，try/catch 双分支 resolve 前 `if (gen !== exportGenRef.current) return`（过期请求丢弃）
- **取消**（`closeExportPicker`，含取消按钮）：`exportGenRef.current++` + 关闭
- **确定**（`handlePickerConfirm`）：`exportGenRef.current++` + 关闭 + flash

modal 无 × / 遮罩点击 / ESC 关闭（与 ConfirmModal 视觉一致），关闭路径只有取消 + 确定两条，均已递增 → 无遗漏路径。UT 新增「取消竞态：loading 中取消 → listSquads 慢 resolve 不重弹 modal」用例（真实 deferred 时序覆盖）。

### 2.2 squadId 防御（commit ac2de2f3c，review MINOR-1）

默认选中逻辑补防御：`squadId` 在列表内才用它（最近活跃），不在列表（团队已删）→ 列表第一项，空列表 → null（确定 disabled）。与 change_plan D2「`squadId ?? squads[0].id`」一致，细化边界。

## 3. 验收结果

| 环节 | 结果 | 证据 |
|------|------|------|
| Task 1 后端 review | **PASSED** | `states/v0.0.321/verify/review/code-review-task1.md` |
| Task 2 前端 review（首轮） | MAJOR-1 + MINOR-1 | `states/v0.0.321/verify/review/code-review-task2.md` |
| Task 2 前端复审 | **PASSED**（修复完整，无遗留） | `states/v0.0.321/verify/review/code-review-task2-r2.md` |
| UT | 后端 42/42 + services 回归 165/165；前端 15/15（export-picker 9 + section-team-sync 6） | review 报告独立复核 |
| ET | **pass**（`team_export_picker` 1 条 4 步全 pass：弹 modal → 列表 → 默认高亮 → 选团队 → 确定下载 zip → 取消不下载） | `states/v0.0.321/verify/e2e/report.md` |

## 4. 相关文档

- API 契约：`specs/api/version_logs/v0.0.321/change_log.md`（**零 API 契约变更**：复用 GET /squad + GET /squad/:id/export；实名修复纯服务层内部逻辑）
- UI 组件契约：`specs/ui/components/app-dev-config-page/section-team-sync.md`（导出选择器流程）+ `specs/ui/version_logs/v0.0.321-team-export-picker/change_log.md`
- agent 文件命名规则：`specs/tech/squad/[P1]squad_templates.md`（agent 文件命名/改名映射段，leader 实名特例）
