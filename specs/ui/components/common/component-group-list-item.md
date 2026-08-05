# component-group-list-item

> 层级: component
> 文件: app/web/src/components/common/component-group-list-item.tsx

## 职责
单个 group 列表项：展示 groupId + 选中态视觉 + 可选 count 徽章。是 `section-group-list` / `section-config-layout` 的最小单元。
边界：只管展示一项 + 转发 onSelect；不感知列表全貌、不持有选中状态（受控，active 由父级比对得出）。

## Props
- groupId: string
- active: boolean;        // 是否当前选中（由父级 groupId === selected 计算）
- onSelect: () => void;   // 点击该项
- testIdPrefix?: string;  // 默认 group-list-item；app-dev config 用 group-item 保 E...
- count?: number;         // 右侧 count 徽章（如 group 的 key 数量）；undefined/0 不显示

## 状态 / 交互
- 点击 → `onSelect`
- active：左侧 3px×20px 竖条（绝对定位居中，右侧圆角，仅 active 渲染）+
- 竖条绝对定位脱离文档流，切换 active 不位移
- count > 0 时右侧显示等宽数字徽章
- 项：（设计 9/12px），（8px），13px/500
- 非激活： ## 复用关系
- 被组合：`section-group-list`
- 组合：无
