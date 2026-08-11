# v0.0.321 变更计划书 — 团队导出选择器 + leader agent 实名命名修复

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD 权威：`specs/prd/version_logs/v0.0.321-team-export-picker.md`（已验收通过）
> 需求补丁：`reqs/[working] v0.0.321.team-export-picker/req.md`（19:36-19:38 老板追加 leader 实名命名修复，两条路径都要修）

## 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 后端零 API 变更 | 导出选择器复用既有 `GET /squad` + `GET /squad/:id/export`；实名命名纯内部 service 逻辑 | `squad-api.ts L61 listSquads`（GET /squad → SquadSummary[]）；`team-sync-api.ts L36 exportSquad`（`<a href download>` 不经 fetch）|
| 实名 Bug 根因 | copyTemplateFiles 以模板文件名（role）为 key；applyTemplate/import 都 `nameToId.set('leader', ...)` → 产出 `leader-{id}.md`（role 前缀，与其他成员 `coder-{id}.md` name 前缀不一致）| `squad-template-service.ts L162` + `team-sync-import-service.ts L151` 均 `set('leader', ...)`；`copyTemplateFiles L225-227` `destName = \`${role}-${memberId}.md\`` |
| 导出还原现状 | `stripMemberIdSuffix` 正则 `/-[0-9A-HJKMNP-TV-Z]{26}\.md$/` 仅去 ULID 后缀：`Darvin-{id}.md` → `Darvin.md`（非模板 key `leader.md`）→ 导入侧 nameToId miss 保留原名，闭环断裂 | `team-sync-export-service.ts L25/L39-41` + `L141` 打包调用 |
| 闭环修复方向 | 导入侧 copyTemplateFiles 加 `leaderName` 参数：role==='leader' 且 leaderName 提供 → `{leaderName}-{memberId}.md`；导出侧 `restoreAgentFileName(file, leaderName)`：`{leaderName}-{ULID}.md` → `leader.md`；旧 `leader-{id}.md` 走原 strip 也还原 `leader.md`（兼容）| 模板 agents 文件 = `leader.md`（测试 fixture 证实）；buildManifest 已提取 manifest.leaderName（export-service L73-74）|
| 导出选择器挂载 | `section-team-sync.tsx` handleExport L66-70 现直接 `exportSquad(squadId)` → 改为弹 modal；modal 组件新文件（ConfirmModal 61 行纯受控无列表态，不复用）| `section-team-sync.tsx L66-70`；`component-confirm-modal.tsx` 仅 title/body/两按钮 |
| 范式归属 | 导出选择器 = **即时操作 + L3 modal**（列表选择确认），无 SaveBar——与 team_sync 页现状一致（TAB_KV_GROUPS.team_sync = [] 即时操作页）| `section-team-sync.tsx` 头注释 L12-13 |
| 默认选中 | 最近活跃 = 当前 squadId（listStudioSessions 首项）?? listSquads 第一项（后端已 updatedAt desc 排序）| `squad.ts L404-406` 排序；section-team-sync L38-49 squadId state |
| 现有测试基线 | 3 个后端测试文件断言 `leader-{id}.md` → 全部改为 `{leaderName}-{id}.md`；前端已有 section-team-sync.test.tsx | `squad-template-service.test.ts L214`、`team-sync-import-service.test.ts L241`、`team-sync-export-service.test.ts` fixture L52 已是 `Darvin-{id}.md` |

## 设计决策（D 编号）

### D1: 后端 leader 实名命名闭环（两条路径统一）

**文件**：`app/server/src/services/squad-template-service.ts`（修改）+ `app/server/src/handlers/squad.ts`（修改）+ `app/server/src/services/team-sync-import-service.ts`（修改）+ `app/server/src/services/team-sync-export-service.ts`（修改）

**变更**：
- `copyTemplateFiles(srcDir, destDir, nameToId, leaderName?)` — 加可选第 4 参：
  - agents 循环内：`role === 'leader' && leaderName` → `destName = \`${leaderName}-${memberId}.md\``（memberId 仍取 `nameToId.get('leader')`，319-fix 的 `set('leader', id)` 保留）
  - 其余 role 逻辑不变（`{role}-{memberId}.md` 或原名兜底）
- `applyTemplate(dataDir, squadId, slug, deps, leaderMemberId?, leaderName?)` — 加可选第 6 参，透传给 copyTemplateFiles
- `handlers/squad.ts` handleCreateSquad L373 调用 — 追加 `body.leader.name`（L353 已校验非空）
- `team-sync-import-service.ts` importSquadFromTempDir L172 调用 — `copyTemplateFiles(srcDir, destDir, nameToId, manifest.leaderName)`（manifest 必填字段已校验）
- `team-sync-export-service.ts`：
  - 新增 `restoreAgentFileName(fileName, leaderName?)`：
    - `leaderName` 提供且 `fileName.startsWith(\`${leaderName}-\`)` 且 `MEMBER_ID_SUFFIX_RE.test(fileName)` → `'leader.md'`（实名 → 模板 key）
    - 否则 fallback `stripMemberIdSuffix(fileName)`（兼容旧 `leader-{id}.md` → `leader.md`，及普通成员）
  - `exportSquadToZip` L141 打包调用改为 `restoreAgentFileName(file, manifest.leaderName)`

**闭环**：模板 `leader.md` → 创建/导入 `{leaderName}-{memberId}.md` → 导出还原 `leader.md`（新实名 + 旧 leader- 双格式兼容）→ 再导入 `{leaderName}-{memberId}.md`。

**约束**：MUST 两条路径（创建模板导入 + zip 导入）产出同格式 `{leaderName}-{memberId}.md`；MUST 旧 squad（`leader-{id}.md`）导出仍还原 `leader.md`；MUST `nameToId.set('leader', id)` 保留（copyTemplateFiles 内部依赖）；MUST NOT 改 ManifestSchema/manifest 字段。

### D2: 前端导出选择器 modal（纯前端，后端零改动）

**文件**：`app/web/src/components/app-dev-config-page/component-export-team-picker-modal.tsx`（新增）+ `app/web/src/components/app-dev-config-page/section-team-sync.tsx`（修改）+ `app/web/src/i18n/locales/zh-CN/app-dev-config.json`（修改）+ en 同构

**变更**：
- 新组件 `ExportTeamPickerModal`（受控，props：`open / loading / error / squads: SquadSummary[] / selectedId / onSelect(id) / onConfirm() / onCancel() / onRetry()`）：
  - title「选择要导出的团队」；列表行 = 团队名（ellipsis）+ `「N 个成员」` muted；点击行高亮选中
  - 底部「确定」（primary，未选中 disabled）+「取消」（secondary）
  - 4 态：loading（骨架/文案）/ error（失败文案 + 重试按钮）/ empty（无团队文案）/ normal（列表）
  - 列表 max-h 60vh overflow-y-auto
  - 复用既有 Modal 视觉（fixed inset-0 遮罩 + 居中 card，对齐 ConfirmModal 风格）
- `section-team-sync.tsx`：
  - 新增 `ExportPickerState { open, loading, error, squads: SquadSummary[], selectedId: string | null }`
  - `handleExport` L66-70 改为：`setPicker({ open: true, loading: true, ... })` → `listSquads()` 拉列表 → 默认选中 `squadId ?? squads[0].id`（后端已 updatedAt desc）→ 成功关 modal + `exportSquad(selectedId)` + flash
  - busy 防重（picker.open 时导出按钮 disabled）；无 studio 会话但列表有团队 → 默认第一项（PRD 边界）
  - 仅 1 团队仍弹层（PRD 边界：不短路直下）
  - loading/error 态：失败显示重试（重新 listSquads）
- i18n 新增 `team_sync.export_picker.*`：title / loading / load_failed / retry / empty / member_count（`{{count}} 个成员`）/ confirm（确定）/ cancel（取消，或复用 cancel_btn）

**约束**：MUST 复用 `listSquads()` + `exportSquad(squadId)`（零 API 改动）；MUST 默认选中当前 squadId ?? 列表第一项；MUST 确定后 `exportSquad` 仍走 `<a href download>`（不经 fetch）；MUST 无 SaveBar（即时操作 + L3 modal 范式）；MUST 单文件 ≤300 行。

### D3: 测试更新（后端 3 文件 + 前端 1 文件）

**文件**：`app/server/src/services/__tests__/squad-template-service.test.ts` + `team-sync-import-service.test.ts` + `team-sync-export-service.test.ts` + `app/web/src/components/app-dev-config-page/__tests__/section-team-sync.test.tsx`

**变更**：
- squad-template-service.test.ts：L188-189 调用加 leaderName `'Boss'`；L214 断言 `leader-{id}.md` → `Boss-{id}.md`；L217 `leader.md` 不残留断言保留
- team-sync-import-service.test.ts：L241 断言 `leader-${leaderMember.id}.md` → `Darvin-${leaderMember.id}.md`（manifest.leaderName='Darvin'）
- team-sync-export-service.test.ts：新增 `restoreAgentFileName` 用例（`Darvin-{id}.md` → `leader.md`；`coder-{id}.md` → `coder.md`；`README.md` 原样；`leader-{id}.md`（旧格式）→ `leader.md` 兼容）；L52 fixture 已是 `Darvin-{id}.md`，断言导出 zip 内 agents 名为 `leader.md`
- section-team-sync.test.tsx：新增导出选择器用例（点击导出弹 modal / 列表渲染 / 选中后确定调 exportSquad / 取消关闭 / 加载失败重试）

**约束**：MUST 全部现有断言更新到实名格式（不留旧 `leader-` 断言）；MUST 保留兼容性用例（旧格式导出还原）。

## method 级变更表

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束(MUST/MUST NOT) | 参考 | 影响行 |
|----------|----------|-----------|------|----------|---------------------|------|--------|
| server/squad-template | app/server/src/services/squad-template-service.ts | `copyTemplateFiles(srcDir, destDir, nameToId, leaderName?)` | 修改 | 加可选第 4 参；agents 循环 role==='leader' && leaderName → destName=`{leaderName}-{memberId}.md` | MUST memberId 取 nameToId.get('leader')；MUST 其余 role 逻辑不变 | D1 | ~8 |
| server/squad-template | app/server/src/services/squad-template-service.ts | `applyTemplate(..., leaderMemberId?, leaderName?)` | 修改 | 加可选第 6 参；透传 copyTemplateFiles | MUST 不破坏 319 调用（leaderMemberId 可选语义保留）| D1 | ~3 |
| server/handler | app/server/src/handlers/squad.ts | `handleCreateSquad`（L373 applyTemplate 调用） | 修改 | 追加第 6 参 `body.leader.name` | MUST L353 已校验非空；MUST NOT 改其他调用 | D1 | ~1 |
| server/team-sync-import | app/server/src/services/team-sync-import-service.ts | `importSquadFromTempDir`（L172 copyTemplateFiles 调用） | 修改 | 追加第 4 参 `manifest.leaderName` | MUST manifest.leaderName 必填已校验（assertManifestShape）| D1 | ~1 |
| server/team-sync-export | app/server/src/services/team-sync-export-service.ts | `restoreAgentFileName(fileName, leaderName?)` | 新增 | 实名 `{leaderName}-{ULID}.md` → `leader.md`；否则 fallback stripMemberIdSuffix | MUST 兼容旧 `leader-{id}.md`；MUST 普通成员走 strip 原逻辑 | D1 | ~10 |
| server/team-sync-export | app/server/src/services/team-sync-export-service.ts | `exportSquadToZip`（L141 agents 打包） | 修改 | 打包名改用 `restoreAgentFileName(file, manifest.leaderName)` | MUST buildManifest 已产出 leaderName | D1 | ~1 |
| web/team-sync | app/web/src/components/app-dev-config-page/component-export-team-picker-modal.tsx | `ExportTeamPickerModal` | 新增 | 受控选择 modal（open/loading/error/squads/selectedId/onSelect/onConfirm/onCancel/onRetry）；4 态 + max-h 60vh + ellipsis | MUST ≤300 行；MUST 复用 ConfirmModal 视觉 | D2 | ~120 |
| web/team-sync | app/web/src/components/app-dev-config-page/section-team-sync.tsx | `ExportPickerState` + `handleExport` + modal 挂载 | 修改 | handleExport 改弹 modal；listSquads 拉列表；默认选中 squadId ?? 第一项；确定后 exportSquad + flash | MUST 仅 1 团队仍弹层；MUST busy 防重；MUST 无 SaveBar | D2 | ~60 |
| web/i18n | app/web/src/i18n/locales/zh-CN/app-dev-config.json（+en） | `team_sync.export_picker.*` | 新增 | title/loading/load_failed/retry/empty/member_count/confirm | MUST 双语同构 | D2 | ~10 |
| test/server | app/server/src/services/__tests__/squad-template-service.test.ts | applyTemplate 用例 | 修改 | 调用加 `'Boss'`；断言 `Boss-{id}.md`；`leader.md` 不残留保留 | MUST 不留旧 `leader-` 断言 | D3 | ~4 |
| test/server | app/server/src/services/__tests__/team-sync-import-service.test.ts | 导入用例 | 修改 | 断言 `Darvin-{id}.md` | MUST 不留旧 `leader-` 断言 | D3 | ~2 |
| test/server | app/server/src/services/__tests__/team-sync-export-service.test.ts | restoreAgentFileName 用例 | 新增 | 实名还原 / 普通成员 / 原样 / 旧格式兼容 4 例 | MUST 覆盖兼容路径 | D3 | ~15 |
| test/web | app/web/src/components/app-dev-config-page/__tests__/section-team-sync.test.tsx | 导出选择器用例 | 新增 | 弹 modal/列表/选中确定/取消/失败重试 | MUST mock listSquads + exportSquad | D3 | ~40 |

## 范式归属（逐控件）

| 控件 | 范式 | 说明 |
|------|------|------|
| 「导出团队」按钮 | 即时操作（触发弹层） | 不直接下载，先弹选择器（PRD UC-1） |
| 团队选择列表行 | L3 modal 内即时选择 | 点击即选中高亮，无保存语义 |
| 「确定」按钮 | L3 modal 确认（即时操作） | 未选中 disabled；确定即触发 exportSquad 下载 |
| 「取消」按钮 | L3 modal 取消 | 关闭 modal 不下载 |
| 「重试」按钮 | 即时操作 | error 态重新 listSquads |
| 导入侧（既有） | 即时操作 + ConfirmModal | 不属本版本改动，范式不变 |

**总原则**：导出选择器 = **即时操作 + L3 modal**，无 SaveBar、无 page-tab dirty（与 team_sync 页 TAB_KV_GROUPS.team_sync = [] 现状一致）。

## 验证方式

- Task1（后端实名修复）：UT 必须（3 测试文件全绿）；后端无 API 变更 → **不新增 AT**（既有 AT 回归即可）
- Task2（前端导出选择器）：UT 必须（section-team-sync.test.tsx）；UI 改动默认看一眼 ET（1 条：设置页 → 团队同步 → 导出 → 弹选择器 → 选团队 → 下载）
