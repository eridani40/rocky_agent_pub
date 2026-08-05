# component-scope-switcher

> 层级: component
> 文件: app/web/src/components/plugin-config-page/component-scope-switcher.tsx
> 状态: **总纲（架构师定）**——精确视觉基线由 coder 编码前置（先 spec 后实现）补全

## 职责
扩展点 tab 顶层的 **scope 切换器**。展示当前选中 scope，下拉切换查看不同 scope 的配置。
：**配置只读化**——scope 列表代码声明（`app/plugins/scopes/*.yaml`），运行时不可增删。
- 切换 scope 功能**保留**（只读查看不同 scope 配置）
- `onCreate` / `onDelete` props 保留签名（noop），避免父级 props 接线改动
边界：只管 scope 维度的切换交互；不渲染 EP/impl 详情（由下方 `section-ext-point-area` 负责）；不判断激活态。

## Props
- scopes: { id: string; name: string; description?: string }[]
- currentScopeId: string
- onSelect: (scopeId: string) => void
- onCreate: (id: string, name: string, description?: string) => void
- onDelete: (scopeId: string) => void

## 状态 / 交互
- **当前 scope 显示**：左侧标签「Scope」+ 当前 scope name（粗体）+ description 副文本（muted，无则不渲染）。
- **下拉切换**：点当前 scope name 展开 dropdown，列所有 scope（id + name），点选触发 `onSelect`。default 始终在首位 + 标「基线」badge。
- **不可创建/删除**：dropdown 中无「+ 新建 scope」按钮；非 default 项不渲染删除 icon。
- **布局稳定性（MANDATORY）**：dropdown 出现/消失**不得导致其他元素位移**——dropdown 用绝对定位脱离常规流，下方 EP 区不受影响；切换 scope 时切换器自身位置固定（不重排）。

## 视觉基线
- **容器**：与下方 EP 区上下间距 ，padding 与 page-plugin-config 主区一致（ 内）。
- **「Scope」标签**：（与 EP header 副文本同语系）。
- **当前 scope name**：，hover 时 （terracotta 强调色，与既有 EP type-tag 同色系）。
- **default badge**：。

## 复用关系
- 被组合：`page-plugin-config`（扩展点 tab 顶层，section-ext-point-area 之上）
- 组合：无（自含 dropdown）
