# component-usage-panel

> 层级: component（挂于 `chat-page` topbar 右侧）
> 视觉契约: `reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html` §143-258（usage / topbar-right / usage-ring / usage-panel / ctx-stack / ctx-legend / cum-table）
> 本文是 usage-panel 的概念权威源：定义子组件构成、数据契约、三态交互、视觉基线、按钮状态绑定。PRD/编码对齐本文。
> 数据源: `usage` prop（纯展示）。父级 `useUsage` area-hook 提供：`onInit GET /session/:id/usage` 拉基线 + `subscribe(session_panel)` 收 `session_usage_update` 全量 replace。

## 消费方

- **唯一入口：`components/chat-page/section-chat-session.tsx`**（topbarRight，`caps.usage` 单门控；`onCompact`/`onClear` props 透传）。
- ~~`components/chat-page/component-chat-topbar-right.tsx`~~（已退役删除，v0.0.326）。

## 0. 设计意图（一句话）
topbar 右侧一个紧凑的 token 用量圆环（环内叠百分比整数）+ 点击展开完整面板（context window 进度条 3 分段 + 累积消耗表格三分区行）；浮层 head 右侧挂 CompactBtn/ClearBtn；compact 按钮状态绑定 summaryTask，clear 按钮 hover danger 色 + 确认 modal。

## 3. 三态交互
### 3.1 收起态（默认，v0.0.326 重写）
- 显示：`UsageRing` 36×36 圆环，**环内叠百分比整数**（`Math.round(pct*100)`%，9px bold mono `text-fg-2`，绝对定位居中）。
- **无**「已用/总」文字、**无** chevron 展开按钮、**无** hover tooltip——整环 `role="button"` onClick toggle（Enter/Space 键盘等价），容器 `w-9 h-9 rounded-lg` hover `bg-bg-warm`。
### 3.2 展开态（`.open`）
- 点整环 → `.open` → 浮层（300px 宽，左下展开 `top-full right-[48px]` 避让右侧 float-menu）→ 内容区：大环 52×52 stroke 6 + 已用/总 + 占用率、3 分段进度条、3 图例、累积消耗表格。
- 点 panel 内部不关闭（`onClick={e => e.stopPropagation}`）；点 panel 外部（document mousedown）→ 关闭。

## 视觉基线
### 4.2 UsageRing（SVG，CSS §550-561）
| 维度 | 值 |
|---|---|
| size | 收起 36×36 stroke 4 / 展开大号 52×52 stroke 6 |

## 5. 浮层 head 按钮区（v0.0.326）
- head 左 = 标题（`usage.title`）+ `{total} context` 副行；**head 右 = CompactBtn / ClearBtn**（`size='sm'` = h-7 w-7 紧凑档）。
- **props 契约（透传自 section-chat-session）**：
  - `onCompact?: (() => void) | null`：`caps.compact` 开时透传；null → 不渲染 CompactBtn。
  - `onClear?: (() => void) | null`：`caps.clear && !readOnly` 时透传；null → 不渲染 ClearBtn。
  - `summaryTask?: SummaryTaskStatus | null`：CompactBtn disabled+spinner 绑定（status=running）。
  - `sessionBusy?: boolean`：兼容签名保留，内部忽略（任何 session.state 都可点 compact）。
- **CompactBtn**：`summaryTask.status==='running'` → disabled + 9px spinner；idle/done/failed 可点（CompressIcon）。
- **ClearBtn**：hover `bg-[var(--danger-bg)]` + `text-[var(--danger)]`（TrashIcon）；点击由 caller 弹 clear-confirm-modal。
