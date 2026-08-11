# component-market-item

> 层级: component
> 文件: app/web/src/components/skill-page/component-market-item.tsx
> 市场搜索结果卡（区别于本地 `component-skill-item`）。

## 职责
单个市场 skill 结果卡。展示：icon-box（hash 色）+ name + ref（作者/来源行，mono）+ 安装量 installs（能力门控）+ 右下**状态区**（可安装按钮 / 安装中 / 已安装 badge）。受控组件：点卡→打开详情，点安装→回调父。
边界：不渲染 description（search 不返回，详情 modal 才有）、version、stars、分类（skills.sh 未声明，能力门控）；不持有安装态（installingRef 由父传）；不弹详情 modal（透传 onOpenDetail 给父）。
## Props
- item: MarketItem;                 // { ref, name, description?, stats? }
- status: 'installable' | 'installing' | 'installed';  // 父用 deriveMarketStatus...
- showInstalls: boolean;            // 能力门控：capabilities.stats 含 'installs' 才 true
- onOpenDetail: (ref: string) => void
- onInstall: (ref: string) => void

## 状态 / 交互
- 点卡片主体 → `onOpenDetail(item.ref)`。
- 点「安装」按钮 → `onInstall(item.ref)`（stopPropagation，不触发 onOpenDetail）。
- `status==='installing'` → 按钮禁用 + 文案「安装中…」。
- `status==='installed'` → 状态区渲染「已安装」badge，无按钮。
- **布局稳定性**：状态区尺寸固定，按钮/badge 切换不导致卡片其余元素位移（_conventions §11）。

## 复用关系
- 被组合：`section-skill-market`
- 组合：icon-box（regulation 04）；badge（regulation 02）；图标内联 SVG 来源行段：`.mkt-card` :42-
- **font**：name `.mkt-name` 13.5px/600 `var(--fg)`；ref `.mkt-author` 11px `var(-
- **color**：卡底 `var(--surface)`；icon-box 浅底 `--hue-*-bg` + 主色 `--hue-*`（同 ref ha
- **双主题**：全 token（银灰）。

## 消费方
- `app/web/src/components/skill-page/section-skill-market.tsx`
