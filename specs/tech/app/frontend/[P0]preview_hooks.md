---
type: spec
title: 预览区 hooks（use-preview-collapsed 门三态 + use-preview-tabs tab 状态机）
priority: P0
status: active
updated: 2026-08-11
since: v0.0.320
related: [[P0]component_architecture.md, [P0]chat_area_hooks.md]
---

# 预览区 hooks（use-preview-collapsed + use-preview-tabs）

## §1 概述

- **管什么**：预览区（`section-preview-area`，详见 `specs/ui/components/chat-page/section-preview-area.md`）的两个状态 hook——`use-preview-collapsed.ts`（门三态 + per session 持久化 + 旧 collapsed 桥接）与 `use-preview-tabs.ts`（多 tab 状态机 + dirty/conflict 守卫）。两者由 `preview-area-provider.tsx` 单例实例化（Provider 上移 page-chat / studio-chat-router 顶层包整行，Task 3 偏离），经 `preview-area-context.ts` 下传消费方（SectionPreviewArea / SectionWorkspacePanel / ComponentMessageStream 兄弟节点）。
- **不管什么**：三栏宽度引擎（→ `[P0]component_architecture.md §3.13`）；文件读写 IPC/HTTP 契约（→ `specs/api/overall/04-agent-session.md §2.6.7`）；渲染形态（→ `specs/ui/components/chat-page/section-preview-area.md`）。
- **范畴一句话**：门三态 = 「预览区显隐」的语义状态（谁被遮、怎么恢复）；tabs = 「打开哪些文件」的内存状态机（不持久化）。

## §2 use-preview-collapsed —— 门三态 hook（v0.0.329 门模型重写）

**文件**：`app/web/src/components/chat-page/use-preview-collapsed.ts`。参考：`specs/tech/version_logs/v0.0.329/change_plan.md` D1。

### 2.1 职责

- **门三态**：`DoorState = 'center' | 'left' | 'right'`。center（默认）= 2/3 共存；right = 门滑最右，preview 被遮、chat 占满门框（= 旧 collapsed=true 路径）；left = 门滑最左，chat 被遮、preview 占满门框（chatCollapsed 引擎分支）。
- **per session localStorage 持久化**：key `pv-door-<sid>`，值 `'center'|'left'|'right'`，缺省 `'center'`。读写函数 `readPvDoor` / `writePvDoor` 导出（try/catch 静默，隐私模式/配额满兜底）。
- **旧 collapsed 语义桥接（旧消费方零改）**：
  - `collapsed` 派生 = `door !== 'center'`；
  - `setCollapsed(v)` 桥接 `setDoor(v ? 'right' : 'center')`（use-preview-tabs 调用零改语义）；
  - 迁移：`pv-door` 缺省时读旧 `pv-collapsed-<sid>`，`'1'`（旧收起）→ `'right'`，坏值兜底 center；写 door 时同步旧 key（`door !== 'center'` → `'1'`）保旧消费方兼容。
- **sessionId 变化重读门态**（v0.0.329 blocking 修复，commit c6d08e9a9）：`useEffect(() => setDoorState(readPvDoor(sessionId)), [sessionId])`——root 挂载 `sid=''` → 点进会话 sid 变化，若不重读门态会固化为 root 的 center，切会话不恢复各自持久化门态。

### 2.2 接口

```ts
type DoorState = 'center' | 'left' | 'right';
function readPvDoor(sid: string): DoorState;   // 迁移 + 坏值兜底
function writePvDoor(sid: string, v: DoorState): void;  // 同步写旧 pv-collapsed
function usePreviewCollapsed(sessionId: string): {
  door: DoorState;            // 当前门态
  setDoor(v: DoorState): void; // 设置 + localStorage 持久化
  collapsed: boolean;          // 派生 = door !== 'center'
  setCollapsed(v: boolean): void; // 桥接 = setDoor(v ? 'right' : 'center')
};
```

## §3 use-preview-tabs —— tab 状态机（纯内存，不持久化）

**文件**：`app/web/src/components/chat-page/use-preview-tabs.ts`。参考：`specs/tech/version_logs/v0.0.320/change_plan.md` D4。

### 3.1 职责

- **tabs + activeTabId 状态机**：id = `${source}:${path}` 唯一；openTab / activateTab / closeTab 带编辑态守卫（mode='edit' 拦截 → dirtyPending modal）；saveTab expectedVersion（409 → conflictPending modal）；读失败 error pill 可重试；递增 reqId 屏蔽过期响应。
- **打开文件自动回居中**：openTab/activateTab 成功后 `setCollapsed(false)`（v0.0.329 = `setDoor('center')`）——收起/门非居中态打开文件自动展开。
- **tabs 纯内存、跨会话共享、不持久化**（老板确认语义）：打开的文件 tabs 在 Provider 生命周期内共享（page-chat / studio-chat-router 顶层），**跨会话切换不重建**（Provider 不随 sessionId remount，仅 hook 参数变化）；**刷新/重启后 tabs 清空**（无 localStorage 持久化，与门态 `pv-door-<sid>` 持久化形成对比）。sessionId 仅用于 workspace 源 HTTP 读写（readFileContent / saveWorkspaceFile）。

### 3.2 与门态的关系

- 解构 `usePreviewCollapsed(sessionId)` 的 `{ collapsed, setCollapsed, door, setDoor }` 透传（Provider value 经 context 下传）。
- door=left 时 chat 槽条件不渲染（middleWidth 0），tabs 状态机不受影响——回 center 后 preview 原样恢复。

## §4 边界

| 零件 | 归属 |
|---|---|
| use-preview-collapsed / use-preview-tabs | 本文件（`chat-page/use-preview-*.ts`） |
| PreviewAreaProvider / PreviewAreaContext | `preview-area-provider.tsx` / `preview-area-context.ts`（装配 + 下传，详见 `specs/ui/components/chat-page/section-preview-area.md §2`） |
| makeTab / neighborId / readFileContent / readRockyShell | `preview-tabs-{types,io}.ts`（纯数据/IO 辅助） |
| 门三态渲染分支（center 双把手 / left / right） | `section-preview-area.tsx`（消费 door 决定渲染） |
| 门态驱动布局（chatCollapsed → 引擎） | `use-three-col-layout.ts` + `layout-width-engine.ts`（`[P0]component_architecture.md §3.13`） |
