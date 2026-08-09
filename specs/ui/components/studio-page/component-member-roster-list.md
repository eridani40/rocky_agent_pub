---
type: spec
title: component-member-roster-list — 统一成员列表组件（三分区 running/idle/benched）
priority: P1
status: active
updated: 2026-08-08
since: v0.0.288
---

> 文件: app/web/src/components/studio-page/component-member-roster-list.tsx
> since: v0.0.288（从 component-squad-status-modal.tsx 抽出 PanelRowView + 分区渲染 → 独立文件）
> 消费方：chat 弹层 `component-squad-status-modal.tsx`（showBenched=false）+ 首页 `component-seats-body.tsx` 成员卡（showBenched=view==='all'）

## 职责

统一成员列表组件：chat 弹层和首页成员列表共用同一套组件 + 数据派生 + 展现逻辑（一改全改——老板强制 D2）。

**PanelRowView**（单行渲染）：整行 button 进对话 + hover chat icon + 防套娃 + 三分区 variant 灰度策略。
**MemberRosterList**（分区渲染）：按 running/idle/benched 三分区分组渲染，showBenched 控制是否渲染 benched 区。

## Props

```ts
interface MemberRosterListProps {
  rows: PanelRows;                  // 三分区派生结果（derivePanelRows 返回值）
  currentMemberId?: string;         // 防套娃（弹层=chrome.memberId，首页=undefined 全显 icon）
  onEnterChat: (memberId: string) => void;
  showBenched: boolean;             // false=弹层/在岗（running+idle）；true=全部（三分区含 benched）
}
```

```ts
// PanelRowView（export 供单测）
interface PanelRowViewProps {
  row: PanelRow;
  currentMemberId?: string;
  onEnterChat: (memberId: string) => void;
  variant?: 'running' | 'idle' | 'benched';   // 三元（替代旧 isIdle 二元）
}
```

## 三分区灰度策略

| variant | 行 opacity | 文字色 | avatar/色块 | 动态标识 |
|---|---|---|---|---|
| `running` | —（正常） | `text-fg` | 正常 | `SpinnerRing` size=sm（accent 旋转环） |
| `idle` | `opacity-[0.85]` | `text-fg-2` | avatar `opacity-70` + badge `bg-bg-warm/50` | — |
| `benched` | `opacity-[0.55]` | `text-muted-2` | avatar `grayscale opacity-50` + badge `bg-bg-warm/50` | — |

**benched 比 idle 更灰**（D2/F7）：opacity 更低（0.55 vs 0.85）+ 文字更淡（muted-2 vs fg-2）+ avatar 灰度滤镜（grayscale + opacity-50 vs opacity-70）。

### Leader 行反色高亮（v0.0.292 新增）

**设计目标**：leader = 页面视觉重心，通过反色整行高亮从所有行中脱颖而出。**优先级最高**——`row.isLeader === true` 时反色样式覆盖 variant 灰度策略（leader 恒反色，不受 running/idle/benched 灰度影响）。

| 元素 | Leader 行 className |
|------|-------------------|
| 行根 button | `group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors bg-fg hover:bg-fg/90` |
| avatar span | 无额外样式（保持原色——avatar 角色色在黑底上保持辨识度） |
| 名字 span | `truncate text-[12.5px] font-medium text-surface` |
| badge span | `shrink-0 rounded-xs px-1 py-px font-mono text-[10.5px] font-semibold bg-white/15 text-white/80` |
| SpinnerRing | 保持 accent 旋转环（running 时，leader 在 running 分区首位） |
| presence 文字 | `block truncate text-[11px] text-white/60` |
| hover chat icon | `shrink-0 text-white/70 opacity-0 group-hover:opacity-100 transition-opacity` |

**关键点**：
- Leader 行**恒显反色底**（`bg-fg`，不靠 hover）——进页面第一眼定位 leader
- Leader 行 hover 仅微调底色 `bg-fg → bg-fg/90`，无位移
- Leader avatar **保持原色不反色**（角色色色块在黑底上辨识度更好）

## 状态 / 交互

- **分区渲染**：running（上）→ idle（中）→ benched（下，showBenched=true 时）。每区分区标题 `running · N` / `idle · N` / `benched · N`（N>0 才渲染区标题+行；N=0 跳过该区）。
- **空态**：三区全空 → `seats.emptyMembers` 居中 muted 占位。
- **行交互**：整行 `<button>` 点击 → `onEnterChat(row.member.id)`；hover → 右侧 `Icon name="chat"` opacity 0→1 切换（保留占位防位移）；防套娃行（`row.member.id === currentMemberId`）不渲染 icon。
- **role badge**：`row.isLeader ? t('role.leader') : t('role.mate')`（leader/mate badge 区分——队长无独立卡片，入行内 badge）。
- **presence 文字**：`statusTextSource.kind === 'currentWork'` → currentWork.text；否则 → `t('seats.status.{presence}')` i18n fallback。单行 truncate。

## 复用关系

- **从 `component-squad-status-modal.tsx` 迁出** PanelRowView（旧 isIdle 二元 → variant 三元）；modal 改为 import MemberRosterList + showBenched=false 委托渲染。
- **消费 `PanelRows` + `PanelRow`** 类型（`squad-status-utils.ts` derivePanelRows 返回值——三分区含 benched）。
- **复用 `MemberAvatar`**（common/member-avatar sm 无名）+ `SpinnerRing`（common/spinner-ring sm）+ `Icon`（studio-icons chat）。

## 可观测节点

- 行：`data-testid="squad-status-row-{memberId}"`（弹层和首页共用同 testid）。

## 视觉基线

- 分区标题：`text-[11px] font-medium uppercase tracking-wide text-muted` + `px-1 pb-1`。
- 行：`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2`。
- 成员名：`text-[12.5px] font-medium truncate`（running text-fg / idle text-fg-2 / benched text-muted-2）。
- badge：`shrink-0 rounded-xs px-1 py-px font-mono text-[10px] text-muted`（running bg-bg-warm / idle+benched bg-bg-warm/50）。
- presence 文字：`block truncate text-[11px] text-muted`。
- hover chat icon：`shrink-0 text-fg-2 opacity-0 group-hover:opacity-100 transition-opacity`（Icon name="chat" size=14）。
