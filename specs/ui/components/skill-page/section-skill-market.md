# section-skill-market

> 层级: section
> 文件: app/web/src/components/skill-page/section-skill-market.tsx
> skill 页「市场」tab 内容区。承接 v0.0.166 市场后端（capabilities/search/detail/install）。

## 职责
Skill 市场内容区容器（`page-skill` 的 `tab==='market'` 分支渲染）。挂载先调 `GET /skills/market/capabilities` 做能力协商；据结果渲染搜索框 + 结果网格。持有市场搜索/详情/安装状态，把已安装 skill 列表（含 marketRef/installedHash）透传给卡片算同源态。
边界：不管「我的」tab（那是现有 drop-zone + section-skill-list）；单卡视觉/交互下沉 `component-market-item`；详情/安装动作下沉 `component-market-detail-modal`；不持有已安装列表（由 page 传入，装完调 `onInstalled` 回 page refresh）。
## Props
- installedSkills: SkillEntry[];   // 来自 page（已安装列表，含 marketRef/installedHash）
- onInstalled: () => void;         // 安装成功后回调（page 调 refresh，刷新「我的」+ 同源态）

## 状态 / 交互
- ：搜索框受控；回车 / 防抖（~400ms）触发 `searchMarket(query)`。
- 安装：`installMarketSkill(ref)` → 成功 `onInstalled` + 本地把该 ref 标已安装（乐观，回调 refresh 兜底）。
- 空 query 行为按后端实际（skills.sh q 必填 → 空 q 显示引导空态）。

## 复用关系
- 被组合：`page-skill`（`tab==='market'` 分支） 来源行段：`.main-header` 搜索框 :83-86、`.tabs-ba
- **layout**：市场区 = 顶部搜索框行 + 结果网格。搜索框 `.search-box` 宽 280px，`height 32px`，左内嵌 14p
- **font**：搜索框 input 13px Inter；空/错误态 13px `JetBrains Mono` `var(--muted)`。
- **border**：搜索框 `1px solid var(--border-2)` + `radius-md`，focus = `--border-str
- **color**：区背景透明（承 page body）；卡底 `var(--surface)`。
