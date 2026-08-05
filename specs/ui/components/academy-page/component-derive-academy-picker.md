# component-derive-academy-picker（派生 academy 二级 select + 继承预览面板）

> 层级: component
> 文件: app/web/src/components/academy-page/component-derive-academy-picker.tsx
> [v0.0.233] 加继承预览面板（清单 + 同名裁决）：选定 student/version 后、派生前展示「将带入」清单 + 同名标 + 覆盖 toggle（PRD `specs/prd/overall/12-academy.md §12.15.5`）。

## 职责
squad 员工派生「从教室派生」mode 下的二级 select 面板（design §7 + §8.10）+ [v0.0.233] 继承预览面板：grid 2 列 ① 教室选择 + ② 学生·版本选择 + copy-note 说明 + foot 来源链 + 取消/派生按钮；选定 student/version 后调 `POST /squad/:id/member/derive-academy/preview` 拉清单，渲染继承预览面板（清单分组 + 同名 amber 标 + 覆盖 toggle + 同名计数提示）。

边界：mode-card 切换在 studio member-create 中（本组件不渲 mode-card，只渲二级面板）；不管 squad 创建/成员创建主流程（归 studio-page/member-create.md）。

## Props
```ts
interface Props {
  squadId: string;  // [v0.0.233] preview endpoint path 参数
  classrooms: Array<{ id: string; name: string; logo: string; logoBg: string; studentCount: number }>;
  students: Array<{
    id: string; name: string; avatarGradient: string;
    latestVersionId: string; latestVersionLabel: string; // 'v2.0'
    disabled?: boolean; disableReason?: string; // '仅初始版 · 内容为空'
  }>;
  selectedClassroomId?: string;
  selectedStudentId?: string;
  selectedVersionId?: string;  // [v0.0.233] 选定版本（latestVersionId）触发 preview
  onPickClassroom: (id: string) => void;
  onPickStudent: (id: string) => void;
  onCancel: () => void;
  onConfirm: (resolution?: DeriveResolution) => void;  // [v0.0.233] 触发 POST /squad/:id/member {mode:'derive_academy', academySource, resolution}
  // DeriveResolution = { skills?: Array<{name, action:'skip'|'overwrite'}>; memory?: Array<{name, action}> }
  /**
   * [v0.0.233] 预览状态上抛（embedded 宿主据此 gate 提交按钮 + 收集 resolution）。
   * 预览 status 或 resolution 任一变化时触发；embedded 模式下宿主凭 ready 收启提交按钮。
   */
  onPreviewStateChange?: (state: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    resolution?: DeriveResolution;
  }) => void;
  confirming?: boolean;
  embedded?: boolean;  // true → 去掉外框/head/foot 按钮组（宿主提供）
}
```

> [v0.0.233] preview 数据走组件内部 hook `useDeriveAcademyPreview(squadId, selectedClassroomId, selectedStudentId, selectedVersionId)`（选定 student/version 后 fetch `/squad/:id/member/derive-academy/preview`），不在 Props 透传——组件自包含预览生命周期。

## 状态 / 交互
- **derive-panel** 容器（max-w 760 + border + `rounded-xl` + bg-surface + overflow-hidden）：
  - **derive-head**（p-13/18 + bottom border + `bg-warm` 13px/600）：「🎓 从教室派生 · 选择来源」。
  - **select-cols** grid 2 列（sel-col p-12 + 之间 1px border）：
    - **左 ① 教室**：`sel-label`「① 教室」11px/600/uppercase + pick-item list（30×30 logo + 13px/500 名 + 11px muted「N 学生」+ sel 态 border-accent）。
    - **右 ② 学生 · 版本**：`sel-label`「② 学生 · 版本」+ pick-item list（30×30 avatar + 13px/500 名 + 11px muted/sage「最新正式版 · 推荐」/「最新正式版」+ 右 `ver-badge-sm` mono 11px/600 版本号；disabled 项 `opacity:.5 + cursor:default`，11px muted 显示 disableReason「仅初始版 · 内容为空」）。
  - **copy-note**（indigo-bg `rounded-md` p-11/14 m-14/16 12px/1.55）：「ℹ️」+「派生 = 把该学生版本的 **system prompt（AGENTS.md）、memory、skills** 复制为新成员初始工作区内容。新成员独立演化，不影响教室里的学生。」。
  - **derive-foot**（p-14/18 + top border）：左 `src-chain`「来源：」+ `src-node` 三段（教室 logo + 名 → 学生 avatar + 名 → 版本徽章），右按钮组：「取消」outline + 「派生为成员 →」primary（[v0.0.233] disabled 直到 preview 加载完成且无 error——避免无裁决提交）。
- **[v0.0.233] 继承预览面板**（select-cols 下方、derive-foot 上方插入；preview pending/error 时不渲染）：
  - **preview-summary**（顶部一行 11px/600）：「将带入 X 项 · 其中 Y 项同名默认保留原 squad」（X = agentsMd.exists?1:0 + skills.length + memory.length；Y = skills/memory sameNameConflict=true 计数）。
  - **清单分组**：
    - **group-agents**（agentsMd.exists 为 true 才渲染）：1 行「AGENTS.md」+ status-badge sage 色「将带入」（无同名开关）。
    - **group-skills**（skills.length > 0 才渲染）：分组 label「SKILLS」+ skills 项行（name + status-badge：!sameNameConflict = sage「新增」/ sameNameConflict = amber「同名 · 保留原 squad」+ 仅 sameNameConflict 项右侧有覆盖 toggle，默认 off）。
    - **group-memory**（memory.length > 0 才渲染）：分组 label「MEMORY」+ memory 项行（同 skills 结构）。
  - **覆盖 toggle**（仅同名项）：默认 off = action 'skip'（保留 squad 原有）；用户点开 on = action 'overwrite'（该项将被学生版本覆盖）；toggle 出现/消失不导致其他项位移（每行预留固定 toggle 槽位）。
  - **可见文案**（E2E）：「将带入 X 项 · 其中 Y 项同名默认保留原 squad」/ 「AGENTS.md」「将带入」/ 「SKILLS」「MEMORY」/ 项名 + 「新增」「同名 · 保留原 squad」/ toggle aria-label「覆盖 {name}」。
- **可见文案**（E2E）：「🎓 从教室派生 · 选择来源」/ 「① 教室」「② 学生 · 版本」/ 教室名 + 「N 学生」/ 学生名 + 「最新正式版 · 推荐」/「最新正式版」/ 版本号 / 「仅初始版 · 内容为空」/ 派生说明 / 「来源：」/ 「取消」「派生为成员 →」。

## 复用关系
- 被 `studio-page/component-new-squad-modal.tsx`（或 member-create）在 mode='derive_academy' 时嵌入（spec 更新归 studio-page/member-create.md 加第 3 mode-card）。
- 数据 hook：复用 `useClassrooms`（academy 侧）+ `useStudentsByClassroom(cid)`（academy 侧）+ [v0.0.233] `useDeriveAcademyPreview(squadId, cid, sid, versionId)`（新 hook，调 `/squad/:id/member/derive-academy/preview`，封装 fetch + loading/error/data state）。

## 视觉基线
- 设计稿来源：`demo/07-squad-derive.html`（select 面板部分）；[v0.0.233] 继承预览面板**无设计稿**——视觉基线由 coder 编码前置定（遵循 `specs/ui/components/_conventions.md §9`），对齐 derive-panel 容器风格（border + rounded-xl + bg-surface）+ status-badge 现有风格 + toggle 复用 `framework/primitives/toggle-switch`。
- 尺寸：derive-panel max-w 760；head p-13/18；sel-col p-12；pick-item p-9/11 + `rounded-lg`；copy-note p-11/14 m-14/16；foot p-14/18。**继承预览面板**：preview-summary p-11/14（同 copy-note 内边距，分隔 select-cols 与 foot 之间）；group label 行 px-14 pt-12 pb-6；项行 px-14 py-9 + `rounded-lg`（与 pick-item 一致）。
- 字体：derive-head 13px/600；sel-label 11px/600/uppercase；pick-item 名 13px/500；副 11px muted/sage；copy-note 12px/1.55；src-node 12.5px/500。**继承预览面板**：preview-summary 11px/600（同 sel-label 字号但不大写，fg-2 色）；group label 11px/600/uppercase muted-2（与 sel-label 一致）；项名 13px/500 fg；status-badge 11px/500（复用 primitive-status-badge 字号口径）。
- 边框：derive-panel border + `rounded-xl`；head bottom border；sel-col 之间 border；pick-item sel 态 border-1.5 accent；foot top border；src-node border + `rounded-md`。**继承预览面板**：preview-summary 顶部 bottom border 分隔 select-cols；group 之间无额外 divider（靠 group label + padding 自然分隔）；项行 hover bg-bg-warm（同 pick-item hover）。
- 配色：pick-item sel bg-accent-light + border-accent；indigo-bg copy-note；ver-badge-sm 黑底白字（old muted-2）；btn-primary 黑底白字。**继承预览面板**：status-badge sage（bg-sage-bg text-sage）=「新增」/「将带入」；amber（bg-gold-bg text-[#b45309]）=「同名 · 保留原 squad」；toggle off 灰（bg-border-strong）/ on accent（沿用 `primitive-toggle-switch` 配色，不重造）；preview-summary error 态用 text-danger 兜底文案。
