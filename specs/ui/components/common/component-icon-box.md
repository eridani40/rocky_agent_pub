# component-icon-box

> 层级: primitive
> 文件: app/web/src/components/common/component-icon-box.tsx

## 职责
彩色浅底图标盒 primitive：**32px（可 22/24/34 缩放）圆角 md** 方块，浅底 `--hue-*-bg` + 主色 `--hue-*` 线性图标。用于 skill / plugin / model / provider / 团队入口 / 坐席卡统计等**同一实体恒同色**的图标场景。
边界：纯展示、无交互；不依赖任何业务 store；颜色走 token 不硬编码。

## Props
- hueBy?: string
- hue?: HuePaletteName
- icon?: ReactNode
- fallbackText?: string
- size?: IconBoxSize
- testId?: string
- className?: string

## 状态 / 交互
- 纯展示，无交互。
- 色决策优先级：`hue` 显式 > `hueBy` hash > `rose` 兜底。
- hash 走 `lib/hue-hash.ts` 的 `hashHueName(id)`（INV-5 单一 hash 单例，禁止重复实现）。
- 内容优先级：`icon` > `fallbackText` > 空。
- `data-hue={paletteName}` attribute 供 e2e 断言 palette 名（避免 style 字符串比较脆性）。

## 视觉基线
- 设计稿来源： `.icon-box`（rose/orange/amber/green/teal/blue/violet/pink 8 色变体） + `_gallery.html` icon-box 节。
- 字体：；fallbackText 用 base 字号（size 档决定）。
- 尺寸：22 = 22×22 rounded-md；24 = 24×24 rounded-md；32 = 32×32 rounded-md（默认）；34 = 34×34 rounded-lg。
- 边框/圆角：（22/24/32）/ （34）；无外边框。

## 复用关系
- 被组合: `component-skill-item` (skill logo) / `component-member-skill-filter` (sk
- 组合: `lib/hue-hash.ts`（hash 单例 + 8 色 palette 名）
