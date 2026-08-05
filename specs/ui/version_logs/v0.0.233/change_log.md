# v0.0.233 — UI Change Log（From Classroom 派生：继承预览面板 + 同名裁决）

> 增量变更。全量权威：`specs/ui/components/academy-page/component-derive-academy-picker.md` + `component-derive-academy-preview-panel.md`（组件契约）+ `specs/ui/overall/00-app-guide.md §3.3`（操作路径）。
> 对应 PRD：`specs/prd/version_logs/v0.0.233/change_log.md`（§12.15）；技术契约：`specs/tech/version_logs/v0.0.233/change_plan.md` + `specs/api/version_logs/v0.0.233/change_log.md`。
> 范围：仅 studio member-create From Classroom 流程；其他板块零变化。无设计稿（预览面板部分）→ 视觉基线在组件 spec 内定，视觉保真 compare 跳过。

## §1 组件 spec 更新

### `specs/ui/components/academy-page/component-derive-academy-picker.md`（修改）

加继承预览面板契约：
- **Props 扩**：`squadId`（preview endpoint path 参数）+ `onConfirm: (resolution?) => void`（携带裁决结果）+ `onPreviewStateChange?`（预览 status / resolution 上抛，embedded 宿主凭 ready gate 提交按钮）。
- **预览生命周期**：组件内部 hook `useDeriveAcademyPreview(squadId, cid, sid, versionId)` 自包含（选定三字段后才发请求；不透传 Props）；三态 `idle/loading/ready/error`；source 切换竞态 cancelled 防护。
- **继承预览面板**（select-cols 下方、derive-foot 上方插入；preview ready 才渲染）：清单分组（AGENTS.md / skills / memory）+ 同名 amber 标 + 覆盖 toggle（仅同名项）+ preview-summary「将带入 X 项 · 其中 Y 项同名默认保留原 squad」。
- **派生按钮** disabled 直到 preview ready 且无 error（避免无裁决提交）。
- **视觉基线**：继承预览面板无设计稿，对齐 derive-panel 容器风格（border + rounded-xl + bg-surface）+ status-badge 现有风格 + toggle 复用 `primitive-toggle-switch`；尺寸/字号/边框/配色四维度字段已落。

### `specs/ui/components/academy-page/component-derive-academy-preview-panel.md`（新增）

从 picker 拆出的纯展示子组件（保 picker ≤300 行）：
- **Props**：`data: PreviewResult`（11a §2.5 schema）+ `toggles: Record<string,boolean>`（同名项 toggle 状态，key=`${kind}:${name}`）+ `onToggle(key)`。
- **职责**：渲染清单分组 + 同名 amber 标 + 覆盖 toggle；不拉数据（picker 透传）、不产 resolution（picker 持 toggle 状态）。
- **固定槽位不位移**：每行右侧预留 toggle 槽位（不同名项 invisible 占位，对齐 _conventions §11）。
- **可见文案**（E2E 定位）：「将带入 X 项 · 其中 Y 项同名默认保留原 squad」/ 「AGENTS.md」「SKILLS」「MEMORY」/ 项名 + 「新增」「同名 · 保留原 squad」/ toggle aria-label「覆盖 {name}」+ action-key `academy.derive.toggle-overwrite`。

### `specs/ui/overall/00-app-guide.md §3.3`（修改）

「派生到 Studio」操作路径补预览步骤：二级 select（教室 → 学生·版本）→ **继承预览面板**（列 AGENTS.md + skills + memory + 标同名项，同名默认保留可逐项改覆盖）→ 复制为新成员初始工作区（AGENTS.md → 个人差异；skills/memory → 团队盘共享）。「照手册从 nav-rail 点到 From Classroom 派生功能 + 看到预览步骤」成立。

## §2 实现核对（doc-modifier 阶段 5）

| 实现文件 | 与 spec 一致性 |
|---|---|
| `app/web/src/components/academy-page/component-derive-academy-picker.tsx` | ✅ Props 签名（squadId / onConfirm(resolution?) / onPreviewStateChange）+ 预览面板嵌入 + 派生按钮 disabled 逻辑对齐 spec；287 行 ≤300 |
| `app/web/src/components/academy-page/component-derive-academy-preview-panel.tsx` | ✅ 纯展示 Props（data/toggles/onToggle）+ 固定槽位 invisible 占位 + status-badge sage/amber 配色 + toggle 复用 primitive-toggle-switch；136 行 ≤300 |
| `app/web/src/components/academy-page/use-derive-academy-preview.ts` | ✅ 三态 idle/loading/ready/error + source 切换 cancelled 竞态防护 + 三字段齐全才发请求；colocate 在 academy-page 目录（项目约定，change_plan 写 hooks/ 路径偏离已记录 context.md） |
| `app/web/src/lib/squad-api.ts` | ✅ `previewDeriveAcademy()` client + `PreviewRequest/PreviewItem/PreviewResult` 类型与 11a §2.5 schema 对齐 |
| `app/web/src/components/studio-page/squad-types.ts` | ✅ `HireMemberBody` derive_academy 分支加 `resolution?: DeriveResolution` + `ResolutionItem`/`DeriveResolution` 类型与 11a §2.1 / tech derive_preview_conflict §3.1 对齐 |

零 code↔spec 偏离。
