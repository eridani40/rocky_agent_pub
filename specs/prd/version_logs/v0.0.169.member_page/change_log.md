# v0.0.169.member_page — squad 新增成员改主区创建页（复用编辑页逻辑）+ 编辑页删任务区

> 类型：UI 交互改版（弹层→主区页面）+ API 字段扩展（hire 加 workStyle）+ 编辑页删减
> 前置概念权威源（PRD 已读对齐）：
> - UI：`specs/ui/components/studio-page/member-panel.md`（编辑页 section 结构/表单逻辑复用源）/ `hire-member-form.md`（原弹层契约，本版软删）/ `component-seats-body.md`（seat-add-card 触发点）
> - API：`specs/api/overall/11a-squad-endpoints.md §2.1`（HireMemberBody）+ §2.2（PatchMemberBody workStyle 语义，v0.0.142）

## 0. 决策基线（用户裁决，本 PRD 不推翻）

| # | 决策 | 理由 |
|---|------|------|
| D1 | 保留 Fresh / Derive 双模式 | 与原弹层能力对齐，不缩减用户可用路径 |
| D2 | hire API 扩 `workStyle?`：fresh 直传；derive 默认复制父 workStyle，`overrides.workStyle` 可覆盖 | 与 v0.0.142 PATCH workStyle 语义对齐（trim 回写、空串=空串、无 400） |
| D3 | 创建成功 / 取消均回 squad 首页坐席网格 | 与 member-panel「返回统一回首页 seats」（v0.0.168）一致 |
| D4 | 原 `component-hire-modal` 弹层彻底软删 | 唯一入口 = seat-add-card → onHire，无其他触发点 |

## 1. 背景与目标

### 1.1 问题
- squad 首页「+ 新增成员」卡触发的是弹层（component-hire-modal），字段能力弱于成员编辑页（无 workStyle、无 skills 覆盖入口），弹层与编辑页两套表单逻辑并存、体验割裂。
- 成员编辑页含「当前任务」占位 section（`member-section-tasks` + 占位 banner），长期无实际功能，占用主区视觉面积。

### 1.2 目标
1. 新增成员从弹层改为**主区创建页**，复用 member-panel 的 section 结构与表单逻辑（profile Card + skills Card）。
2. 创建时即可填写 workStyle（fresh）/ 覆盖 workStyle（derive），与编辑页能力拉齐。
3. 编辑页删除任务区，只保留「姓名介绍」+「skills」两 section。

## 2. 功能需求

### 2.1 F1：主区成员创建页（替换 hire 弹层） [P0]

**描述**：点击首页坐席网格末尾「+ 新增成员」虚线卡（`seat-add-card`），主区切换为成员创建页（占用主区，非弹层/抽屉），复用 member-panel 的 section 结构。
**用户故事**：作为 squad 管理员，我希望在主区页面里创建新成员并一次配好 profile/skills/workStyle，以便创建后无需再进编辑页补配置。

#### 页面结构与字段语义
- **模式切换**：Fresh / Derive 二选一（选项卡片，沿用原弹层 choice-cards 交互）。
- **profile Card**（复用 member-panel profile section）：name（单行 input）/ intro（单行 input）/ workStyle（多行 textarea，可空）。
- **skills Card**（复用 member-panel skills section）：`member-skills-mode-switch`（off=inherit 继承全局 / on=custom 展开 `component-member-skill-filter` 逐项 toggle）。**skills 覆盖仅 Fresh 模式暴露**；Derive 模式继承父成员 skillConfig，不展示 skills Card（与原弹层一致）。
- **Derive 专属**：父成员选择（本 squad 内非 leader 成员，选项卡片）+ `inheritMemory` toggle + 可选覆盖 name/intro/workStyle。
- **valid 规则**：Fresh = name + intro 非空；Derive = 选中父成员。不满足时提交按钮 disabled。
- **提交按钮常驻**：创建语义——页面底部/顶栏常驻「创建」+「取消/返回」（**非**编辑页 dirty 才出现的悬浮保存 FAB）；创建中防重复提交。
- **取消/返回**：回 squad 首页坐席网格，不创建任何数据。
- **创建成功**：回 squad 首页坐席网格，坐席网格出现新成员坐席卡。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 首页 → 「+ 新增成员」卡 → 创建页（Fresh）→ 填 name/intro/workStyle → 提交 | 回首页坐席网格，出现新坐席卡；新成员 workStyle 已落库 |
| UC-2 | 首页 → 创建页切 Derive → 选父成员 + inheritMemory → 覆盖 name → 提交 | 回首页，新坐席卡出现；配置复制父成员 + name 覆盖生效 |
| UC-3 | 首页 → 创建页 → 不填 name/intro → 提交按钮 | 提交按钮 disabled，无法提交 |
| UC-4 | 首页 → 创建页 → 取消/返回 | 回首页坐席网格，无新成员产生 |

### 2.2 F2：成员编辑页删除任务区 [P0]

**描述**：member-panel 删除「当前任务」section（`member-section-tasks` + `member-tasks-placeholder-banner`），编辑页只保留两个 section：姓名介绍（name/intro/workStyle）+ skills（inherit/custom switch + skill-filter）。其余交互（左上返回回首页、dirty 悬浮保存 FAB、PATCH 仅传改动字段）不变。
**用户故事**：作为 squad 管理员，我希望编辑页只呈现可配置的内容，以便不被无功能的占位区干扰。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-5 | 首页 → 坐席卡菜单 → 编辑 → 编辑页 | 仅见「姓名介绍」+「skills」两 section，无任务区 |
| UC-6 | 编辑页改 name → 悬浮保存出现 → 保存 | PATCH 成功，悬浮消失，返回首页后坐席卡名称更新 |

## 3. API 语义（11a §2.1 扩展）

`POST /squad/:id/member` body 加 `workStyle?`（对齐 §2.2 PATCH workStyle 语义，v0.0.142）：

- **fresh**：`workStyle?: string` 直传；`trim()` 后回写；**可空**——提供空串 = 回写空串（无 400，区别 intro）；不传 = 缺省空。
- **derive**：默认**复制父成员 workStyle**；`overrides.workStyle` 覆盖（空串 = 清空）。
- 其余契约不变：fresh 仍 name+intro 必填（intro 空 → 400）；derive 仍 deriveFrom + inheritMemory 必填；409 name 冲突；201 + `{ member, sessionId }`。

## 4. 关键用户路径（MANDATORY）

- **P1**：squad 首页 → 「+ 新增成员」卡 → 主区创建页（Fresh）→ 填 name/intro/(workStyle)/(skills 开关) → 提交 → 回首页见新坐席卡
- **P2**：首页 → 创建页切 Derive → 选父成员 + inheritMemory + 可选覆盖 name/intro/workStyle → 提交 → 回首页见新坐席卡
- **P3**：首页 → 创建页 → 返回/取消 → 回首页（无创建）
- **P4**：坐席卡菜单 → 编辑 → 编辑页（无任务区，仅 姓名介绍 + skills 两 section）→ 保存 → 回首页

## 5. 对齐声明

- 引用的组件契约与 `specs/ui/components/studio-page/member-panel.md`（profile/skills section、skills switch、skill-filter、布局稳定规则）、`component-seats-body.md`（seat-add-card）、`hire-member-form.md`（Fresh/Derive 双模式、derive 父列表/inheritMemory/overrides 语义）一致；本版不发明新组件概念。
- 创建页复用 member-panel section 结构 = 对既有概念的组合复用；hire-member-form 由「弹层契约」重写为「主区创建页契约」属既有组件的改版（ui spec 由 coder 按本 PRD 更新，非 PRD 新发明）。
- API 语义与 `specs/api/overall/11a-squad-endpoints.md §2.1/§2.2` 一致；`workStyle` 字段概念已存在（v0.0.142），本版仅扩展 hire 入口，不发明新数据概念。
- 布局稳定规则沿用 member-panel：skills switch off↔on、筛选器展开/收起不得导致其他 section 位移（预留空间/高度过渡，禁 display:none 跳动）；创建页按钮常驻或 hover 出现均不得引起相邻元素位移。

## 6. 非目标（Out of Scope）

- 不改 member 数据模型（workStyle 字段已存在）；不改 derive 记忆复制语义；不改坐席网格布局；不新增 AT/ET 持久 case（普通 feature，验证 = 冒烟集回归 + UT，用户铁律）。
