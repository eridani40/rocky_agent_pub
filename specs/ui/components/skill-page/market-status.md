# market-status（deriveMarketStatus 纯函数）

> 层级: helper（非渲染组件；纯函数）
> 文件: app/web/src/components/skill-page/market-status.ts
> 市场卡/详情状态区状态机的单一来源（PRD §4）。

## 职责
给定一个市场 ref + 已安装 skill 列表（+ 可选 detailHash/installing），派生出状态区应渲染的态。**同源判定 = ref 精确匹配 marketRef**（非同名，PRD §3.3 / invariant#5）；**可更新惰性**（无 detailHash 不返回 updatable/upToDate，invariant#6）。
边界：纯函数，不渲染、不请求、不持状态。渲染归 `component-market-item`（列表三态）/ `component-market-detail-modal`（含可更新态）。
