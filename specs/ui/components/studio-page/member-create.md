# member-create

> 层级: section
> 文件: app/web/src/components/studio-page/section-member-create.tsx
> 数据源: `POST /squad/:id/member`（父级 `onSubmit` → page-studio `handleHireSubmit` 触发，含 skills 补齐）；候选父成员 + skills catalog 由 props 传入；无 SSE。

## 职责
成员创建页：**占用主区**（非弹层/抽屉），左上「返回」回**首页 seats**。
- 模式切换 Fresh / Derive（choice-cards 二选一）。
- **Fresh**：profile Card（name 必填单行 / intro 必填单行 / workStyle 可空多行）+ skills Card（inherit/custom switch + `component-member-skill-filter`）。
- **Derive**：父成员选择卡（本 squad 内非 leader 成员，choice-cards）+ 可选覆盖 name/intro/workStyle（**skills 继承父，不暴露 skills Card**，与原弹层一致）。
- 底部**常驻**操作条：取消（btn-secondary）+ 创建（btn-primary）——创建语义，**非**编辑页 dirty 才出现的悬浮 FAB；创建中防重复提交。

## Props
- detail: SquadDetail;                                // derive 父列表（非 leader 成员）
- onBack: () => void;                                 // 返回 / 取消 → 回首页 seats
- onSubmit: (body: HireMemberBody) => Promise<void>;  // page-studio 包装：handleH...

## 状态 / 交互
- mode `'fresh'|'derive'`；name / intro / workStyle 两模式共用 state（fresh=必填基线；derive=可选覆盖，留空=继承父）。
- derive 专属：deriveFrom；父列表为空（仅 leader）时提示先用 Fresh（`member-create-derive-empty`）。
- skills（仅 Fresh）：`member-create-skills-mode-switch`（off=inherit / on=custom 展开筛选器）；筛选器**始终挂载 + CSS 折叠**（复用 `component-member-skill-filter`，布局稳定）。
- **valid**：Fresh = name+intro trim 非空；Derive = 选中父成员。不满足时 `member-create-submit` disabled。
- **提交 body 组装**（11a §2.1含 workStyle）：
- **布局稳定（MANDATORY）**：skills switch off↔on、筛选器展开/收起不得导致其他 Card 位移（高度过渡/预留，禁 display:none 跳动）；底部操作条常驻不引起位移。

## 视觉基线
- **布局**：主区 flex column + `animate-[fadeIn]`；内容  居中，Card 间 ，底部留白 。
- **section 卡片**：；标题  + 图标。
- **底部操作条**：常驻 flex 右对齐 gap-2；取消 `btn-secondary` + 创建 `btn-primary`（accent + plus 图标，disabled `opacity-40`）。

## 复用关系
- 被组合: `page-studio`（`MainView { kind:'member-create' }` 态；seat-add-card → onHir
