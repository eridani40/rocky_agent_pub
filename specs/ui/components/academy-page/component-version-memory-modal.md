# component-version-memory-modal（版本 memory 只读 modal）

> 层级: component
> 文件: app/web/src/components/academy-page/component-version-memory-modal.tsx
> 引入: [v0.0.219]

## 职责
只读展示某学生**版本工作区** `.rocky/memory/` 下的 md 文件条目（文件名 + 字节数 + 前 ~200 字符 preview），由 `MemoryEntrySummary[]`（api `18-academy §1.8`）驱动。

边界：**只读**（版本资产快照，非 session 级可写）；不发请求（`memory` 由 `section-student-detail` 在打开时从 `VersionContent.content.memory` 装入 target）；不持久化。

> **不复用 `useMemoryCrud`（硬约束）**：`useMemoryCrud`（chat-page `component-memory-modal`）是 **session 级** memory 读写 API（增/删/编辑 memory entry）。版本 memory 是**工作区目录里已有的 md 文件快照**（非 session 实时 state），结构也不同（`MemoryEntrySummary = { name, size, preview }`，非 `MemoryEntry` 的 name/type/intro/body/why/howToApply 结构化字段）。混用会错把版本 md 当 session entry 写、或读到空 session 工作区。两条通道彻底分开。

## Props
```ts
interface VersionMemoryTarget {
  /** 版本工作区 .rocky/memory/*.md 摘要列表（resolveVersionContent 读侧） */
  memory: MemoryEntrySummary[];
  /** 版本 label（modal 标题用，如 'v1.0'） */
  versionLabel: string;
}

interface Props extends VersionMemoryTarget {
  open: boolean;
  onClose: () => void;
}

// MemoryEntrySummary = { name: string; size: number; preview: string }
//（来自 app/web/src/lib/academy-api.ts，对齐后端 ResolvedVersionContent.memoryEntries）
```

## 状态 / 交互
- **L3 modal 不变式（硬约束）**：走 `<Portal>` 挂 overlay-root + Portal 根节点显式 `pointer-events-auto`——见 `_conventions.md §13`（漏第二条则整弹层按钮全不可点）。
- **modal shell**：480px（max 92vw）/ max-h 76vh / `rounded-xl` + shadow-lg；背景 `rgba(10,10,10,.4)` 遮罩。
- **modal-head**：title「长期记忆 · v{versionLabel}」15px/600 + 副「{count} 个条目 · 只读」+ ✕ 关闭。
- **modal-body**（flex-1 overflow-y-auto p-16/20）：
  - 空列表显「暂无记忆条目」居中 muted。
  - 非空：垂直堆叠 `memory-entry-card`（复用 chat-page 样式：每条 = 🧠 mono `name`（.md 文件名）+ muted `{size}B` + `preview` 前 ~200 字符 mono 13px/1.6 截断）。
- **modal-foot**：「关闭」outline 按钮（无「保存」/「新增」——只读）。
- **可见文案**（E2E）：「长期记忆 · v{versionLabel}」/ 「{count} 个条目 · 只读」/ 「暂无记忆条目」/ 「关闭」/ 每条目 name + size + preview。

## 复用关系
- 被 `section-student-detail` 组合，target 由该 section 在 Memory 卡「查看」时组装（`onOpenMemoryModal`）。
- **样式复用 chat-page**（银灰 token + memory-entry-card 视觉），**不复用 `useMemoryCrud` / `component-memory-modal`**（那是 session 级读写，结构不同，见上硬约束）。
- modal state 归 `page-academy`。

## 视觉基线
- 设计稿来源：`demo/10-version-chat.html` 的 memory 浮层 + chat-page memory modal 同款（银灰 token）。
- 尺寸：modal 480px；head p-14/20；body p-16/20；entry-card p-10/12 + gap 10。
- 字体：modal-title 15px/600；entry name mono 12.5px/600；preview mono 13px/1.6；size 11px muted。
- 边框：modal `rounded-xl` + shadow-lg；head/foot border；entry-card border + `rounded-md`。
- 配色：与 chat-page memory-entry-card 一致（surface 底 + border + bg-warm head）；无 edit/archive 按钮（只读）。
