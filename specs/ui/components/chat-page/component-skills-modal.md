# component-skills-modal（skills 弹层，3 tab 只读）

> 层级: component
> 文件: app/web/src/components/chat-page/component-skills-modal.tsx
> （被 `component-chat-float-menu` 承载，v0.0.205.t2_cons 新增；PRD 定案 1）
> `catalog` prop 下传，与 float-menu 恒挂载的 `useSkillsCatalog` 同一实例 —— **不在本组件内重新调用 hook**。

## 消费方

- `components/chat-page/component-chat-float-menu.tsx`

## 职责
展示「当前会话实际可见的 skills」的只读弹层：3 tab（session/group/global，默认 session）+ 卡片列表（渐变星形 logo + name + desc + 来源徽标）。**只展示，无开关**——不挂 enabled/evolvable toggle、无预览/删除按钮（避免与 SKILLS 全局管理页职责重叠，管理走全局页）。
边界：不持有数据（catalog 由父传入）；不做写操作；不展示被 enabled 覆盖掉的 global 下游版本（global 组只留 enabled=true）。

## Props
- catalog: SkillsCatalog（`use-skills-catalog.ts` 返回：`{groups:{session,group,global}, loading, error, refetch}`）
- onClose: () => void

## 数据源映射（useSkillsCatalog 已分好组，本组件只渲染）
- session tab = resolver `workspace` 层（当前 session ws `.rocky/skills/`），不过滤 enabled
- group tab = resolver `group` 层（squad/classroom 团队 ws `.rocky/skills/`），不过滤 enabled；playground 无 group → 空态
- global tab = resolver `builtin`+`app` 层且 **enabled=true**（当前会话实际生效的全局继承集合）
- 弹层每次挂载（打开）调一次 `catalog.refetch()`（PRD UC-S7：全局页装完新 skill 回会话重开弹层可见）；hook 本体恒挂载于 float-menu 不随开关 mount/unmount。

## 状态 / 交互（含可见文案 —— E2E 定位契约）
- 本地 state `tab: 'session'|'group'|'global'`，默认 `'session'`；重开回 session 默认态。
- tab 栏：`role="tab"` + `aria-selected`，激活 accent 下划线 / 非激活 muted（视觉同 `component-skill-tabs` token）。
- 卡片（只读）：IconBox 渐变星形 logo（hueBy=skill.name，size=34）+ name（13.5px/600）+ 来源徽标（scope 文案）+ desc（12px muted-2 两行省略）。
- 空态（当前 tab 无 skill）：icon 圆 + muted 文案，沿用 memory/cron 空态风格。
- 关闭：遮罩点击 / 右上关闭按钮 → `onClose()`。
- 可见文案（chat ns，key=`skillsModal.*`）：
  - 标题：`skillsModal.title`（zh「技能」/ en「Skills」）
  - tab：`skillsModal.tab.session|group|global`（zh「会话/团队/全局」· en「Session/Group/Global」）
  - 来源徽标：`skillsModal.scope.workspace|group|builtin|app`（zh「工作区/团队/内置/应用」· en「workspace/group/builtin/app」）
  - 空态：`skillsModal.empty.session|group|global`（group 空态 zh「无团队层 skills（playground 会话不属于 squad/classroom）。」）
  - loading：`skillsModal.loading`；错误：`role="alert"` 展示 error 文本。

## 复用关系
- 被组合：`component-chat-float-menu`（第 3 菜单项 skills 的弹层）。
- 组合：`common/component-icon-box`（logo）+ `lib/portal`（L3 modal 脱离 overlay pointer-events 链，同 component-memory-modal）。
- 视觉 token 复用 `skill-page/component-skill-item`（卡片布局/字体/badge 风格），**不 import skill-page 组件**（跨页面目录不逆向依赖；tab 栏视觉 token 同 `component-skill-tabs`，内联实现）。
- 数据 hook：`use-skills-catalog.ts`（父传入，不自建）。

## 视觉基线
- 无设计稿，走 token（同 `component-memory-modal` 遮罩/卡片壳：fixed inset-0 + `--z-modal` + 520px 宽 rounded-[14px] bg-surface shadow-2xl）。
- 卡片：flex 横排 gap 14px，padding 14px 16px，rounded-[10px] bg-surface-2 border border-border（hover border-border-strong）；logo 34×34 shrink-0；name 行 flex gap 8px（name + 徽标同行）；desc `-webkit-line-clamp:2`。
- 来源徽标：10px/600 font-mono tracking-[0.03em] rounded px-[7px] py-[2px]；workspace/group=sage 底（bg-sage-light text-sage），builtin/app=bg-warm 底（bg-bg-warm text-muted）。
- 列表：单列垂直滚动，padding/gap 与 memory 弹层 entry 列表一致（px-[22px] pb-5，gap 8px）。
