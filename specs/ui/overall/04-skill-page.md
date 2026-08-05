# 04 Skill 管理页

> 视觉权威源：reqs/v0.0.21/easy-opc-skill-v10.html
> 组件 spec：specs/ui/components/skill-page/
> API 契约：specs/api/overall/06-skill.md

## 1. 入口

- nav-rail 底部独立入口「SKILLS」（四角星图标），hover tooltip「Skill」
- 点 → 主区渲染 `<PageSkill />`

## 2. 页面结构

```
page-skill (main, h-full min-h-0 overflow-y-auto flex flex-col)
├── 页头：标题「Skill 管理」(20px/700) + mono 副标题（shrink-0 + 底分隔线）
├── config-body 容器 (max-width 880px, flex-1)
│   ├── tab 栏「我的 (manage，默认) / 市场 (market)」+ tab 栏最右「+」按钮 [v0.0.198]
│   │   （component-skill-tabs 受控；「+」按钮走 actionSlot 通用右槽，ml-auto self-center）
│   ├── [manage tab] 安装弹层（条件渲染，默认收起）[v0.0.198]
│   │   └── installExpanded=true 时挂载：
│   │       ├── 外层 relative div（承接右上角 × 按钮绝对定位）
│   │       ├── component-skill-drop-zone（1.5px dashed 边框 / 图标 + 标题 + mono 提示 + 两按钮）
│   │       └── 右上角 × 关闭按钮（absolute top-2 right-2，token 配色）
│   ├── [manage tab] 来源筛选条 [v0.0.198]（component-skill-source-filter，仅 manage tab 渲染）
│   │   └── 4 单选项「全部 / 内置 / 市场 / Rocky」radiogroup（Rocky 挂 PrimitiveTooltip）
│   ├── [manage tab] skill 列表（受来源筛选派生：visibleSkills = filterSkillsBySource(skills, sourceFilter)）
│   │   ├── 空态：「还没有已安装的 Skill」（仅 visibleSkills 为空时）
│   │   └── skill 卡片 × N（同下）
│   └── [market tab] section-skill-market（市场搜索/详情/安装，全下沉 section）
├── [按需] 预览弹层（820×560 双栏 modal）
│   └── 同前
└── [按需] 删除确认弹层（420 宽）
    └── 同前

skill 卡片（component-skill-item）：
├── 渐变星形 logo（固定，不支持自定义）
├── 名称 + 来源徽标「市场」(marketRef 非空) /「本地」[v0.0.167] + badge「已启用」(sage) /「已禁用」(bg-warm)
├── 描述（2 行省略）
├── 启用开关（复用 primitive-toggle-switch）
├── 自进化开关（复用 primitive-toggle-switch，触发 PATCH /skill/:name/governance；builtin 只读 no-op）
├── 「预览」按钮
└── 删除按钮（trash 图标）
```

[v0.0.198] 两处改造：
- **安装区弹层化**：drop-zone 从常驻展开改为**条件渲染弹层**（不用 display:none），由 `page-skill` 持 `installExpanded` state；默认 false 收起；「+」按钮 / 「×」按钮 / 安装成功三处可收起
- **来源筛选条**：列表上方加 4 单选项（all/builtin/market/rocky），纯 filter（全量已在 page-skill state）；切来源 tab 直接重算 visibleSkills

## 3. 交互流（与 API 对齐）

1. **导航**：点 nav-rail「SKILLS」→ page-skill 挂载 → `GET /skill` 取列表（全量，不分页）
2. **安装弹层展开** [v0.0.198]：点 tab 栏最右「+」按钮（actionSlot）→ `setInstallExpanded(v => !v)` toggle；`installExpanded=true` 时挂载 drop-zone + × 按钮；再点「+」旋转 45°（+→×）或点「×」关闭 → `setInstallExpanded(false)`
3. **安装** [v0.0.198]：拖拽 file/folder/zip 到 drop-zone（或点「选择文件」/「选择文件夹」）→ `POST /skill/install` multipart → 刷新列表 → **成功分支末尾自动 `setInstallExpanded(false)` 收起弹层（强约束 PRD D3）**；失败保留展开让用户看到 error
4. **来源筛选切换** [v0.0.198]：点任一选项（all/builtin/market/rocky）→ `setSourceFilter(f)`；`visibleSkills = useMemo(filterSkillsBySource(skills, sourceFilter), [skills, sourceFilter])` 派生重算；列表渲染 visibleSkills 而非全量。映射（PRD §2.2）：
   - `all` → passthrough 原数组
   - `builtin` → `scope === 'builtin'`（随 app 发版）
   - `market` → `Boolean(marketRef)`（市场 tab 安装）
   - `rocky` → `productionMethod === 'consolidation'`（Rocky 自我迭代/进化产物；hover tooltip「来自于 Rocky 的自我迭代和进化」）
5. **启用开关**：点击 → 乐观翻转 + `PATCH /skill/:name` body `{enabled}` → 失败回滚
6. **自进化开关**：点击 → builtin 直接 no-op（治理元字段只读）/ 否则乐观翻转 + `PATCH /skill/:name/governance` body `{scope, evolvable}` → 失败回滚（agent 不碰治理元字段，UI 一定能改）
7. **预览**：点「预览」→ `GET /skill/:name/tree`（整树扁平数组，前端转嵌套）→ 打开预览弹层（默认全展开 dir + 选首个文件）→ 点树文件 → `GET /skill/:name/file?path=` 懒取内容
8. **删除**：点删除按钮 → 打开删除确认弹层 → 点「确认删除」→ `DELETE /skill/:name`（物理删除）→ 关闭 + 刷新
9. **市场 tab**：渲染 `section-skill-market`（capabilities 门控 / 搜索 / 详情 / 一键安装）；安装成功后 refresh「我的」使来源徽标即时生效

## 4. 视觉基线（设计稿对照，vision_check compare 依据）

- **layout**：page 占满主区（h-full min-h-0 overflow-y-auto flex flex-col）；header padding 24/32/18 + 底分隔线 shrink-0；body padding 20/32/40, max-width 880px；drop-zone 弹层 mb-[22px]
- **font**：title 20px/700 -0.02em；sub 12px JetBrains Mono muted；body 14px Inter；tab 13px/600；source-filter 12px/600 [v0.0.198]
- **color**：卡底 surface-2；logo `linear-gradient(135deg, accent, #C25E3F)`；badge enabled sage-light+sage / disabled bg-warm+muted；**[v0.0.198] 「+」按钮 `bg-fg text-surface-2` token 配色（light 深底浅图标 / dark 自动反色）**；来源筛选激活 accent / 非激活 muted-2
- **border**：卡 1px border rounded-10px；hover border-strong；drop-zone 1.5px dashed border-strong（hover/dragOver accent + 4px accent-light 阴影圈）；modal 1px border-2 rounded-14px + 大阴影；tab 栏底线 1px；tab/filter 选项底 2px 下划线（激活 accent / 非激活 transparent，`-mb-px` 压栏底线）
- **[v0.0.198] 「+」按钮视觉**：26×26px rounded-[7px] 方块，内嵌 14×14 SVG plus 图标（`M12 5v14M5 12h14`），`hover:opacity-85` + `transition-all duration-150`；expanded 时 className 追加 `rotate-45`（+ → × 提供「再点收起」语义）；shrink-0 始终占固定空间（不随 expanded 切换位移）
- **[v0.0.198] 弹层 × 按钮**：24×24px rounded-[6px]，12×12 SVG `M18 6L6 18M6 6l12 12`；`text-muted-2 hover:text-fg hover:bg-bg-warm`；absolute top-2 right-2（外层 relative div 承接）

## 5. 注意

- skill 标识用 `name`（kebab-case，= 目录名 = frontmatter name），即 id；同名 app/workspace 共存时 scope 区分
- 预览树 API 返回扁平数组（每项含 path），前端 `buildFileTree` 转嵌套 + dir 在前字母序
- 安装走后端（multipart POST /skill/install），不前端解压
- badge + toggle 都保留（badge 只读状态文字 / toggle 操作开关，不冗余）

## 6. chat 悬浮菜单 skills 入口（只读观测，区别于本页） [v0.0.205.t2_cons]

除本管理页外，chat 区右上悬浮菜单有第 3 个图标项「skills」（在长期记忆/定时任务下方）——**与本页职责正交**：

| | 本页（nav-rail「SKILLS」） | chat 悬浮菜单 skills 弹层 |
|---|---|---|
| 职责 | **管理**：安装/启停/删除/治理/市场 | **观测**：只看当前会话实际可见的 skills |
| 数据视角 | 全局（app + workspace 层安装列表） | 当前会话（`GET /skill?sessionId=<sid>` resolver 四层合并结果） |
| 操作 | 开关/删除/预览/安装 | **只读无开关**（不挂 enabled/evolvable toggle、无预览/删除） |
| 分组 | 来源筛选条（全部/内置/市场/Rocky） | 3 tab「会话/团队/全局」（session=workspace 层 / group=团队层 / global=builtin+app 且只留 enabled=当前生效） |

- 弹层形态：3 tab（默认「会话」）+ 卡片列表（复用 component-skill-item 视觉 token：渐变星形 logo + name + desc 两行省略 + 来源徽标）+ 空态；playground 会话「团队」tab 恒空（无 squad/classroom）。
- 弹层每次打开刷新一次（本页装完新 skill → 回会话重开弹层「全局」tab 可见）。
- 组件契约：`specs/ui/components/chat-page/component-chat-float-menu.md` + `component-skills-modal.md`；操作路径见 `00-app-guide.md §3.1/§3.3`。
