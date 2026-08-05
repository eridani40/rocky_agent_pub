# page-skill

> 文件: app/web/src/components/skill-page/page-skill.tsx

## 职责
Skill 页根。组合：header（标题 + sub desc）、tab 栏（两 tab「我的（manage）」+「市场（market）」）、按激活 tab 渲染内容区。挂载时从**后端 skill API** 取已安装 skill 列表。
- **manage tab（我的）**：drop-zone（拖拽/选择安装）+ skill list 区块（空态 + 多卡）——**现有交互不变**，仅 `component-skill-item` 加来源 badge。
- **market tab（市场）**：渲染 `section-skill-market`（搜索 + 结果 + 详情 + 安装，承 v0.0.166 市场后端）。市场逻辑全下沉 section，本页不持有市场 state（文件体量护栏）。
**数据源**：REST CRUD 无 SSE——已安装 skill：`GET /skill`（双层合并）、`POST /skill/install`（multipart）、`PATCH /skill/:name`（toggle enabled）、`PATCH /skill/:name/governance`（toggle evolvable）、`DELETE /skill/:name`（物理删）、`GET /skill/:name/tree` + `GET /skill/:name/file?path=`（预览懒取）；市场端点下沉 `section-skill-market`（`/skills/market/*`）。操作后乐观更新 + 失败 refetch 兜底。
边界：不在此页管理 provider/model/plugin（各自有页）；skill 内容预览/删除确认下沉到 modal 子组件；市场 fetch/state 下沉 `section-skill-market`；tab 激活逻辑由本页持有。
## 状态 / 交互
- `skills: SkillItem[]`，挂载取列表；install/toggle/delete 后乐观更新（失败靠下次 GET 刷新）。tab 切换不卸载已加载列表（skills state 常驻本组件）
- `tab`，默认 `'manage'`
- `loading / error`：列表加载态
- [v0.0.198] `installExpanded: boolean`（默认 `false`）：drop-zone 弹层展开状态。「+」按钮 toggle / 取消「×」按钮关闭 / **安装成功自动收起（强约束，PRD D3）**——`handleInstall` 成功分支末尾调 `setInstallExpanded(false)`；失败分支保留展开（让用户看到 error）。弹层用**条件渲染**（`{installExpanded && <div className="relative mb-[22px]"><DropZone/><×按钮/></div>}`）而非 display:none（收起态彻底卸载，对齐 memory `user-prefers-simple-direct-refactor-no-defensive-checks`）
- [v0.0.198] `sourceFilter: SkillSourceFilter`（默认 `'all'`）：来源筛选激活项；仅 manage tab 内渲染筛选条，market tab 不渲染；切换不丢失（state 在本组件）
- [v0.0.198] `visibleSkills`（useMemo 派生）：`filterSkillsBySource(skills, sourceFilter)`；传给 `<SectionSkillList>` 替代原 `skills` 全量

## 复用关系
- 被组合：`app-shell`（view `skill` 路由到此页）
- 组合（manage tab）：`component-skill-tabs` / [v0.0.198] `component-skill-source-filter` / `component-skill-drop-zone`（弹层包装）/ `section-skill-list`
- 组合（market tab）：`section-skill-market`
- [v0.0.198] `component-skill-tabs` 通过 actionSlot 接收「+」安装按钮

## 视觉基线
来源行段：`.config-area` :44-48、`.config-header` :45-47、`.config-body` :48、`.config-title/.config-desc` :46-47、整体结构 :412-420。
- **layout**：page 占 config-area 全高（flex 1，，纵向 flex）。header 区 `padding 24px 32px 18px` + 底 `border-bottom 1px var(--border)`，`flex-shrink 0`。body 区 `padding 20px 32px 40px`，`max-width 880px`，内容左对齐。tab 栏 → drop-zone → list 自上而下纵向排列。
- **font**：标题 `config-title` 20px/700，`letter-spacing -0.02em`，`var(--fg)`；sub desc `config-desc` 12px、`JetBrains Mono`、`var(--muted)`、`margin-top 3px`。body 默认 14px Inter。
- **border**：header 底分隔线 `1px solid var(--border)`；body 内区块各自带边框（见各子组件）。整体无外框。
