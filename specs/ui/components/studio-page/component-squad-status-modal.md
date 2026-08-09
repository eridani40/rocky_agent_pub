# component-squad-status-modal（Squad 成员状态弹层 — v0.0.269 自 entry 改造）

> 层级: component
> 文件: app/web/src/components/studio-page/component-squad-status-modal.tsx
> since: v0.0.269（改造自 v0.0.268 component-squad-status-entry）
> 数据源权威: specs/api/overall/11a-squads.md（SquadDetail.members/currentWork）+ specs/tech/app/frontend/[P0]sse_channel.md §10（session_meta 广播）
> 派生复用: squad-status-utils.ts（deriveRunningCount / derivePanelRows / buildMemberChatNode）+ squad-status-context.ts（数据注入）+ **[v0.0.288] MemberRosterList**（行渲染委托——PanelRowView 迁出到独立文件 `component-member-roster-list.tsx`）
> 挂载: component-chat-float-menu.tsx（第 4 项「团队状态」→ openModal='squad-status'）

## 职责

chat 右上浮菜单「团队状态」按钮点击后的**成员状态弹层**（L3 modal）：running 上 / idle 下分区，
presence 工作标记，hover 行出现「进入对话」icon；**防套娃**——当前查看 chat 会话所属 member
那一行不显示进入对话 icon。

**v0.0.288 变更**：PanelRowView 迁出到 `component-member-roster-list.tsx`（统一组件），弹层改为 import `MemberRosterList` + `showBenched=false` 委托渲染（弹层天然无 benched）。弹层文件从 216 行减到 ~150 行。

**边界（不做什么）**：
- 不新增 SSE 订阅（数据经 SquadStatusContext 注入，复用 page-studio 已订阅的 session_meta _all）。
- 不做成员管理（bench/deploy/编辑——归首页坐席卡菜单）。
- 不做 presence SSE 实时推送（presence 文字 = detail 快照，打开弹层时 refreshDetail 刷新）。
- 不做多 squad 面板（只显示当前 squad 成员）。

## Props

```ts
interface ComponentSquadStatusModalProps {
  /** 关闭弹层（浮菜单 setOpen(null)） */
  onClose: () => void;
  /** 当前查看 chat 会话所属 member id（studio 单聊 = chrome.memberId；群聊/其他 = undefined）——防套娃判定 */
  currentMemberId?: string;
}
```

## 数据注入（SquadStatusContext）

`useSquadStatus()` 读 Context（float-menu 在 chat 树内，page-studio chat 分支 Provider 天然包裹）：
- `detail`：squad 详情（members 含 sessionId/role/state/currentWork）；null = 未就绪 → 弹层 loading/空态
- `memberStateMap`：仅 squad 成员 sessionId 子集的 stateMap（值比较稳定引用）
- `onEnterChat`：进入对话回调（组装 ChatNode → setMainView chat）
- `refreshDetail`：打开弹层时刷新 detail（presence 尽量新；fire-and-forget 失败不阻塞旧快照）

无 Provider → float-menu 按钮不渲染（fail-safe，弹层不会打开）。

## 渲染

```
┌────────────────────────────────────────┐
│ 团队状态                    [×]        │  ← 标题 + 关闭
│ running · 2                            │
│ [avatar] 名字 (role)  presence  [chat] │  ← hover 显示 chat icon（currentMemberId 行不显示）
│ [avatar] 名字 (role)  presence  [chat] │
│ idle · 1                               │
│ [avatar] 名字 (role)  presence  [chat] │
└────────────────────────────────────────┘
```

- L3 modal base（`_layering.md` §3A）：`<Portal>` 到 overlay-root + `pointer-events-auto`；遮罩点击/Esc 关闭 + 右上关闭按钮（同 todo/cron modal 壳）。
- **打开弹层时触发一次 `refreshDetail()`**（fire-and-forget，presence 尽量新）。

## 面板内容（v0.0.288 委托 MemberRosterList）

- **分区渲染委托 `MemberRosterList`**（`showBenched=false`——弹层天然无 benched，只渲 running+idle 两区）：`derivePanelRows` 返三区但 MemberRosterList 内部按 showBenched 跳过 benched 区。
- 分区口径不变：running = `isRunningState`（running/interrupting）/ idle = 非 running 含 suspended；benched 不显示（showBenched=false）。
- 行渲染逻辑（PanelRowView）迁出到 `component-member-roster-list.tsx`，弹层不再本地定义——统一组件消费方一致（chat 弹层 ≡ 首页列表）。
- hover 行 → 右侧出现 `Icon name="chat"`（opacity 切换保留占位，不位移）→ 点击 `onEnterChat(buildMemberChatNode(memberId))`。

## 防套娃（v0.0.269 D9，MANDATORY）

- `row.member.id === currentMemberId` → **不渲染进入对话 icon**（行内容保留——用户已在其中，
  点进入=原地跳转无意义）。
- 群聊（currentMemberId undefined）→ 无自己行，全部显示 icon。
- Studio 首页/Playground/Academy（无当前 chat 上下文）→ 无自己行，全部显示 icon。

## 可观测节点

- 弹层根：`data-testid="squad-status-modal"`。
- 行：`data-testid="squad-status-row-{memberId}"`。

## 视觉基线

- L3 modal 壳同 todo modal（Portal + border-border-2 + bg-surface + shadow-2xl）；宽度窄于 720px（~420px，成员列表不宽）。
- 分区标题 text-[11px] uppercase muted；行 hover bg-surface-2。

## 复用关系

- 组合：Portal + CloseIcon + MemberAvatar + Icon(squad/chat) + useSquadStatus + squad-status-utils。
- 挂载：component-chat-float-menu.tsx（openModal='squad-status'）。
- 删除：v0.0.268 component-squad-status-entry.tsx（topbar 入口拆解：按钮逻辑并入 float-menu，面板逻辑迁本组件）。
