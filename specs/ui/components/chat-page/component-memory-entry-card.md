# component-memory-entry-card

> 层级: component
> 文件: app/web/src/components/chat-page/component-memory-entry-card.tsx（或 common/，按 coder 决定——chat/studio/app-settings 三处复用）
> 本文是单 memory entry 卡的**概念权威源**：渲染字段 + testid + 操作回调 + 视觉基线（待 coder 按设计稿填）。

## 消费方

- `components/app-dev-config-page/section-user-memory.tsx`
- `components/chat-page/component-memory-modal.tsx`

## 1. 定位 + 设计意图
单 memory entry 卡片，**被三处复用**：
- chat 右侧 ws-panel 长期记忆 tab（`section-memory-panel`，session scope）
- studio leader/mate 右侧 tab 区域（`section-right-tabs` → 长期记忆 tab，session scope）
- 应用设置「全局长期记忆」group（`section-user-memory`，user scope）
渲染 entry 全字段（name/type/intro/body/why/howToApply），支持编辑/归档操作。受控组件，所有操作回调给父。

## Props
- name: string
- intro: string;        // 一句话摘要
- type: 'user' | 'feedback' | 'project' | 'reference'
- body: string
- why?: string
- howToApply?: string
- evolvable: boolean;   // 是否允许 agent 自动进化（后端 list 恒返回；存量缺省 true）
- archived?: boolean
- updatedAt?: string
- entry: MemoryEntry
- onEdit: (entry: MemoryEntry) => void;        // 触发父弹编辑 modal
- onArchive: (name: string) => void;            // 触发父调 DELETE 归档
- testIdPrefix: 'memory-session' | 'memory-user' | 'squad-memory'

## 3. 状态 / 交互
- 卡片默认**折叠**（只显示 name + type badge + intro 一行省略）
- 点卡片或展开按钮 → **展开**显示 body + why/how（如存在）
- 点 edit 按钮 → `onEdit(entry)`（父弹 modal）
- 点 archive 按钮 → `onArchive(entry.name)`（父调 DELETE 归档）。**是否加确认层由承载容器决定，卡片本身只透传回调**：session 弹层容器（`component-chat-float-menu` 记忆弹层）= **单击直接执行、不加确认**（归档非硬删可恢复）；**全 app 禁 `window.confirm`**（无原生确认弹窗）。卡片不自持确认 UI，无确认 testid。
- archived=true 的卡片 opacity 0.6 + 显示「已归档」badge
- 卡片 hover → 边框 `var(--border-strong)` + edit/archive 按钮 opacity 0→1

## 复用关系
- 被组合：`section-memory-panel`（chat 右侧，prefix=memory-session）+ `section-right-tabs
