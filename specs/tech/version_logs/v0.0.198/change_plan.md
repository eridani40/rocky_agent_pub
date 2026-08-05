# v0.0.198 变更计划书 — Skill 页 UI 优化（安装弹层 + 来源筛选）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（ui-skill / i18n / ui-spec） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 设计概要（architect 决策）

### 弹层实现策略：条件渲染（不用 display:none）

`page-skill` 持有 `installExpanded` state，`{installExpanded && <DropZone .../>}` 条件渲染。

- 收起态彻底卸载 drop-zone（含内部 file input ref），dragOver 落不到不可见元素，条件渲染简单干净
- PRD §2.1 "不用 display:none" 的考量（保留 drop 事件挂载）在条件渲染下不适用——收起态本就不该接 drop
- **安装成功自动收起**：`handleInstall` try 成功分支末尾 `setInstallExpanded(false)`（强约束 PRD D3）

### 「+」按钮：`actionSlot` 通用槽

`component-skill-tabs` 加 `actionSlot?: React.ReactNode` 通用右槽（`ml-auto self-center`），page-skill 把「+」按钮塞进去。
- 不为单一按钮在 tabs 组件里塞业务语义（`expanded`/`onToggleInstall`）
- `+` 按钮 = `bg-fg text-surface-2` 圆方块（light 深底浅图标 / dark 自动反色），尺寸与 tab 高度齐平（约 26-28px）
- expanded 时旋转 45°（+ → ×）提供「再点收起」视觉语义

### 来源筛选：纯函数 + 受控组件

新建 `component-skill-source-filter.tsx`（受控 + 纯函数 filter）：
- 受控：`active: SkillSourceFilter` + `onChange: (f) => void`，组件本身不持有状态
- 纯函数：导出 `filterSkillsBySource(skills, filter)`，page-skill 用 useMemo 派生 visibleSkills
- 4 类映射严格对齐 PRD §2.2 表：`builtin→scope==='builtin'` / `market→Boolean(marketRef)` / `rocky→productionMethod==='consolidation'` / `all→passthrough`
- Rocky tab 用 `PrimitiveTooltip` 挂 hover（复用 `component-skill-item.tsx:17` 同款），文案 `来自于 Rocky 的自我迭代和进化`

### 文件体量预估（单文件 ≤300 行门禁）

| 文件 | 当前行数 | 预估 |
|------|---------|------|
| page-skill.tsx | 232 | ~280（+state×2 / +useMemo / +actionSlot JSX / +source-filter JSX / +弹层包装）|
| component-skill-tabs.tsx | 70 | ~85（+actionSlot prop + 渲染槽位）|
| component-skill-source-filter.tsx | — | ~120（新文件，含 4 个 tab + tooltip + 纯函数 + filter type）|

均未超 300。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-skill | app/web/src/components/skill-page/component-skill-source-filter.tsx | SkillSourceFilter | 新增（type） | 来源筛选 union type：`'all' \| 'builtin' \| 'market' \| 'rocky'`；4 类标识符 | MUST 与 PRD §2.2 来源映射表一一对应；MUST NOT 引入第 5 类 | PRD v0.0.198 §2.2；`specs/api/overall/06-skill.md §8 SkillEntry` | +1 |
| ui-skill | app/web/src/components/skill-page/component-skill-source-filter.tsx | filterSkillsBySource | 新增（纯函数） | `filterSkillsBySource(skills: SkillEntry[], filter: SkillSourceFilter): SkillEntry[]`；switch filter：`'builtin'→scope==='builtin'` / `'market'→Boolean(marketRef)` / `'rocky'→productionMethod==='consolidation'` / `'all'→原数组` | MUST 纯函数无副作用；MUST NOT 改原数组（返回新 filter 结果）；MUST NOT 调用 API；`'all'` 必须 passthrough 原数组（不拷贝 OK，调用方不 mutate） | PRD §2.2 来源映射；SkillEntry 字段 api-client.ts:531-548 | +12 |
| ui-skill | app/web/src/components/skill-page/component-skill-source-filter.tsx | ComponentSkillSourceFilter | 新增（组件） | 受控来源筛选 tab 条；4 个选项（全部/内置/市场/Rocky）+ Rocky hover tooltip；视觉与 `component-skill-tabs` 同色系（accent 激活 + token 边框）；紧凑高度不抢占列表视觉权重 | MUST 受控（不持有状态）；MUST 用 `PrimitiveTooltip` 挂 Rocky hover（复用 common/primitive-tooltip）；MUST 用 i18n key（skill ns `sourceFilter.*`）；MUST NOT 自己实现 tooltip（已存在 primitive）；激活态 accent 文字 + 底 2px accent 下划线（对齐 tabs 视觉） | PRD §2.2；`app/web/src/components/common/primitive-tooltip.tsx`；`component-skill-item.tsx:17`（PrimitiveTooltip 用法） | +80 |
| ui-skill | app/web/src/components/skill-page/component-skill-tabs.tsx | SkillTabsProps.actionSlot | 新增（prop） | 加 `actionSlot?: React.ReactNode`；用于父级塞「+」按钮等右槽元素 | MUST NOT 把按钮业务语义（expanded/onToggleInstall）下沉到 tabs；actionSlot 是通用槽（`ml-auto self-center`）；MUST NOT 影响既有 tabs 渲染（不传 actionSlot 时行为不变） | PRD §2.1（按钮位置 tab 栏最右 ml-auto） | +3 |
| ui-skill | app/web/src/components/skill-page/component-skill-tabs.tsx | ComponentSkillTabs (render) | 修改 | flex 容器末尾渲染 `{actionSlot && <div className="ml-auto self-center">{actionSlot}</div>}`；保持现有 tab map 不动 | MUST 保持 `border-b border-border mb-[18px]` 栏底线视觉；actionSlot 槽内元素垂直居中且不继承 tab 下划线 | spec `component-skill-tabs.md` §视觉基线 | +5 |
| ui-skill | app/web/src/components/skill-page/page-skill.tsx | PageSkill (state) | 修改 | 新增 2 个 useState：`installExpanded: boolean`（默认 false）/ `sourceFilter: SkillSourceFilter`（默认 'all'） | MUST 默认值（`false` / `'all'`）；MUST NOT 用 ref 持状态（要驱动重渲染） | PRD §2.1 / §2.2 | +3 |
| ui-skill | app/web/src/components/skill-page/page-skill.tsx | visibleSkills (派生) | 新增（useMemo） | `useMemo(() => filterSkillsBySource(skills, sourceFilter), [skills, sourceFilter])`；传给 SectionSkillList 替代原 `skills` | MUST 用 useMemo 避免每渲染重算；MUST 切 sourceFilter 时 list 重算（依赖项含 sourceFilter） | 设计概要 §来源筛选 | +4 |
| ui-skill | app/web/src/components/skill-page/page-skill.tsx | handleInstall | 修改 | try 成功分支末尾加 `setInstallExpanded(false)`（install 成功 → 弹层收起，强约束） | MUST 在 `await installSkill()` + `await refresh()` 成功后调 `setInstallExpanded(false)`；MUST NOT 在失败分支收起（失败保留展开让用户看到 error）；MUST NOT 删除现有 setUploading/setError/refresh 逻辑 | PRD D3 强约束；UT 覆盖此路径 | +2 |
| ui-skill | app/web/src/components/skill-page/page-skill.tsx | render (tabs actionSlot) | 修改 | `<ComponentSkillTabs ...>` 加 `actionSlot={<button onClick={() => setInstallExpanded(v => !v)}>+</button>}`；按钮 aria-label 走 i18n `install.addAria`；expanded 时旋转 45°（className `transition-transform rotate-45`） | MUST「+」按钮 token 配色（light `bg-fg text-surface-2` / dark 自动反色）；MUST 旋转 45° 提供「再点收起」语义；MUST 始终占固定空间（不随 expanded 切换位移，PRD §6 布局稳定性） | PRD §2.1 / §6；memory `css-pointer-events-inherits-dom-not-position`（无 modal 不涉及 portal） | +10 |
| ui-skill | app/web/src/components/skill-page/page-skill.tsx | render (drop-zone 条件渲染) | 修改 | 把 `<ComponentSkillDropZone onInstall={handleInstall} uploading={uploading} />` 改为 `{installExpanded && (<div className="relative mb-[22px]"><ComponentSkillDropZone ... /><button onClick={() => setInstallExpanded(false)} aria-label={t('install.closeAria')} className="absolute top-2 right-2 ...">×</button></div>)}` | MUST 用条件渲染（不用 display:none / visibility）；MUST 保留 drop-zone 原有 `onInstall={handleInstall} uploading={uploading}` props；MUST 在 tab !== 'manage' 时不渲染（弹层仅 manage tab 有）；MUST NOT 修改 `component-skill-drop-zone.tsx` 内部实现 | PRD §2.1；设计概要 §弹层实现策略 | +8 |
| ui-skill | app/web/src/components/skill-page/page-skill.tsx | render (source-filter) | 修改 | manage tab 分支内、drop-zone（或弹层）下方、列表上方插 `<ComponentSkillSourceFilter active={sourceFilter} onChange={setSourceFilter} />`；`<SectionSkillList skills={visibleSkills}>` 改用派生数组 | MUST 仅在 tab==='manage' 渲染；MUST NOT 在 market tab 渲染筛选条；MUST SectionSkillList 接收 `visibleSkills`（filtered）而非全量 `skills` | PRD §2.2（筛选条在「我的」列表上方） | +5 |
| i18n | app/web/src/i18n/locales/zh-CN/skill.json | sourceFilter.* | 新增（key） | 加 `sourceFilter.{all:"全部", builtin:"内置", market:"市场", rocky:"Rocky", rockyTooltip:"来自于 Rocky 的自我迭代和进化"}` + `install.{addAria:"安装 Skill", closeAria:"关闭安装区"}` | MUST 中英两份同步（zh-CN + en）；MUST NOT 修改既有 key；rockyTooltip 文案逐字对齐 PRD D6 | PRD D6；memory `i18n-key-add-checklist`（双确认：资源+占位符） | +9 |
| i18n | app/web/src/i18n/locales/en/skill.json | sourceFilter.* | 新增（key） | 加 `sourceFilter.{all:"All", builtin:"Built-in", market:"Market", rocky:"Rocky", rockyTooltip:"From Rocky's self-iteration and evolution"}` + `install.{addAria:"Install skill", closeAria:"Close install zone"}` | MUST 与 zh-CN 同结构同 key；MUST NOT 修改既有 key | PRD D6 | +9 |
| ui-spec | specs/ui/components/skill-page/component-skill-source-filter.md | (整文件) | 新增 | **coder 编码前置产出**。职责/Props（active/onChange）/状态/复用/视觉基线（同 tabs 色系 + Rocky tooltip）/testid 策略（无，按 v0.0.197 瘦身后规范） | MUST 按 `specs/ui/components/_conventions.md` 章节模板；MUST 引用 PrimitiveTooltip 复用；MUST 声明 filterSkillsBySource 纯函数契约 | `_conventions.md`；`component-skill-tabs.md`（同色系参考） | +50 |
| ui-spec | specs/ui/components/skill-page/component-skill-tabs.md | Props 章节 | 修改 | **coder 编码前置产出**。加 `actionSlot?: React.ReactNode` prop 说明（右槽位，ml-auto self-center；调用方塞「+」按钮）；更新复用关系（被 page-skill 通过 actionSlot 塞按钮） | MUST 与代码同步（actionSlot prop 存在）；MUST NOT 推翻既有 tabs/active/onChange/disabled props | 现有 component-skill-tabs.md | +6 |
| ui-spec | specs/ui/components/skill-page/page-skill.md | 状态/交互 章节 | 修改 | **coder 编码前置产出**。文档化：新增 `installExpanded`/`sourceFilter` state；弹层触发模型（+ 按钮 toggle / 取消按钮 / 安装成功自动收起）；visibleSkills 派生 + filterSkillsBySource 调用 | MUST 与代码 state 派发对齐；MUST 记录「安装成功自动收起 = 强约束」（PRD D3） | 现有 page-skill.md；PRD D3 | +20 |

## 影响面评估

### 跨模块
- **ui-skill**: 3 个 tsx（1 新建 + 2 修改）
- **i18n**: 2 个 json（中英对齐新增 key）
- **ui-spec**: 3 个 md（1 新建 + 2 修改）

### 破坏性变更
- **零**。drop-zone / list / item / tabs 既有 props 全保留；既有 i18n key 全保留；SectionSkillList 接口不变（仅调用方传入数组从全量变 filtered）。

### 依赖顺序
- 纯前端，无 SDK/protocol 层依赖
- 实现顺序（coder 内部）：先建 source-filter 组件（含纯函数）→ 改 tabs（加 actionSlot）→ 改 page-skill（串起来）→ 加 i18n key → 补组件 spec

### 风险点
1. **安装成功自动收起 UT 覆盖**：UT 须验「handleInstall 成功分支调 setInstallExpanded(false)」+ 「失败分支不调」（PRD §3 UT-only 路径）
2. **i18n key 漏加**：`sourceFilter.*` 与 `install.{addAria,closeAria}` 必须中英同步，否则渲染 `【资源 sourceFilter.rocky 不存在】`（memory `i18n-key-add-checklist`）
3. **source-filter 与 market tab 共存**：market tab 不应显示筛选条（PRD §2.2 末段），coder 须在 manage 分支内渲染

### 不在本版本范围
- 后端 API 变更（GET /skill / install / toggle / delete / preview / market 全不动）
- 分页（已砍，PRD v0.1 note）
- skill 卡片视觉重构（`component-skill-item` 自身不变，仅接收 filter 后列表）
- 来源筛选多选交集（当前是单选精确匹配）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 合理偏离（如发现更优实现）：向 orchestrator 汇报偏离项 + 理由 + 影响范围，由 orchestrator 裁决
