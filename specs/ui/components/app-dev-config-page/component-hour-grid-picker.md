# component-hour-grid-picker

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-hour-grid-picker.tsx

## 职责
时间条件**弹层内容组件**（v0.0.347 模型路由 UI v2，决策⑫/⑬）：24 格（0-23）小时网格 + header + footer。草稿态隔离——所有格子操作只改内部 `draft`，**确定前零写回**；确定 = 1-23 格校验通过才 `onConfirm`；清除定时 = `onClear`（hours 置 []，等价全天）。弹层开合由父级（component-plan-item-row）条件渲染管理，每次打开以 `value` 重置草稿基线。
**背景**：v1 inline 受控组件（onChange 即时写回 + accent 选中色 + 清空=全天按钮）已被 UI v2 改版替代；`normalizeHours` 输出语义零变化（0-23 白名单去重升序，[] = 全天）。自研缘起（决策⑧）：react-availability-grid 0.2.1 硬限制无法渲染「每天重复 24 小时格」，兜底自研。

## Props
- value: number[]                        // 打开弹层时的基线（既有 timeCondition.hours；无配置 = [] 全灰）
- onConfirm: (hours: number[]) => void   // 确定回调（1-23 格校验通过才触发；输出去重升序白名单）
- onClear: () => void                    // 清除定时回调（语义 = 全天可用，hours 置空/移除 timeCondition 由父级处理）

## 导出（纯函数，供测试 + 时钟 icon tooltip 共用）
- normalizeHours(raw): number[]                       // 0-23 白名单（去重 + 升序 + 越界过滤）
- hoursToRanges(hours): Array<[number, number]>       // 连续小时合并段（[21,22,23] → [[21,24]]）
- formatRanges(ranges): string                        // 段列表 → "21:00-24:00"（多段逗号分隔，24 补零）
- fmtHours(hours): string                             // 组合便捷函数（footer 与 tooltip 共用）

## 状态 / 交互
- 草稿态：`draft` state（useState(value) 初始化）；`error: 'errEmpty' | 'errFull' | null`（任何格子操作清除上次校验错误）
- 格子点击 toggle + 拖拽连续段/多段加选操作 draft（mousedown 起点 mode select/unselect → mouseenter 扩段 → applyRange 闭区间）；mouseup 由 grid 与 **document mouseup 兜底**双清拖拽态（拖出网格松开后 dragRef 残留会误判继续扩段——review Minor 修复）
- **视觉语义翻转（决策⑬）**：默认全灰（bg-surface-2 = 关）→ 选中变深（bg-fg text-bg = 该小时可用）
- header：「选择可用小时（拖拽连续段 / 点击单格）· 深色 = 该小时可用」（demo 文案逐字）
- footer：左 = errEmpty/errFull 错误或 `fmtHours(draft)` 实时时段（未选 =「未选择」）+ 右「清除定时」「确定」
- 确定 = 1-23 格校验：0 格 errEmpty「至少选择 1 个小时」/ 24 格 errFull「全选 = 全天可用，直接清除定时即可」，报错不关闭不回调；合法才 onConfirm(sorted)
- 拖拽冲突防御（决策⑭）：格子 onMouseDown preventDefault+stopPropagation；容器 draggable=false + DnD 三事件 preventDefault+stopPropagation（防格子拖选把行/弹层拖走）

## v2 已退役交互
- v1 inline 受控 onChange 即时写回（改草稿隔离）
- 「清空=全天」按钮（改 footer「清除定时」）
- 格子 hover tooltip「02:00-03:00」（改 footer 实时已选时段）
- accent 选中色（改 bg-fg 深色翻转）

## 复用关系
- 被组合：`component-plan-item-row`（col-time 弹层；fmtHours 供时钟 icon tooltip）

## 消费方
- app/web/src/components/app-dev-config-page/component-plan-item-row.tsx
- app/web/src/components/chat-page/component-quota-provider-card.tsx（额度弹层 item 行时间段文本——跨 feature 同源 import，区间文本全仓唯一实现）
- 纯函数导出被单测引用（hoursToRanges/formatRanges/fmtHours/normalizeHours）
