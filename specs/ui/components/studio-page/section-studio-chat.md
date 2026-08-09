# section-studio-chat（Studio 单/群聊薄壳）

> 层级: section
> 文件: app/web/src/components/studio-page/section-studio-chat.tsx
> since: v0.0.216 · 取代 section-member-chat / section-squad-chat（两文件删除）
> 会话能力权威: specs/ui/components/chat-page/section-chat-session.md；接口权威: specs/api/overall/04a-session-chrome.md

## 职责

Studio chat 的**身份薄壳**（≤100 行）：只负责单/群两形态的身份 header + 透传，全部会话能力
（HITL/enqueue/usage/minimap/两 picker/abort/群聊渲染策略）由内嵌的 `SectionChatSession` 按
`chrome.capabilities` 自给（群聊无 stop / 无两 picker = 后端 `studio_group` capabilities 驱动，
本组件零分支——v0.0.152 裁决保持）。

**边界（不做什么）**：
- 不挂任何 area-hooks / handler / HITL 接线（base-chat-page.md 消费方必备能力清单第 4 条）。
- 不自拉 chrome——`chrome` 由 StudioChatRouter 注入（router 需 chrome 定 workspaceSemantic，
  经 prop 下传防双拉；引用稳定 = useChatChrome ctx state 对象）。
- 不管三栏布局 / SectionRightTabs（归 component-studio-chat-router.tsx）。

## Props

```ts
interface SectionStudioChatProps {
  sessionId: string;
  /** router 已拉的 chrome（注入 SectionChatSession 防双拉；须稳定引用） */
  chrome: SessionChromeView;
  /** 看板 @ 按钮 prefill（mount-time 注入为 pill） */
  prefill?: MentionAttrs[];
  /** 存在即渲返回键（回坐席面板） */
  onBack?: () => void;
}
```

## 状态 / 交互（单/群两形态，chrome.memberId 数据驱动）

对端 member = `chrome.members.find(m => m.id === chrome.memberId)`：

| 形态 | 判定 | topbarLeft | backActionKey |
|---|---|---|---|
| 单聊 | member 命中 | **MemberAvatar(sm，纯展示不可点) + member.name + `chrome.tag`** | `studio.member-chat.back` |
| 群聊 | memberId 空 / member 缺失兜底 | **缺省 ChatSessionTopbarLeft（chrome.title=squad 名 + tag）** | `studio.group-chat.back` |

- **topbarLeft 恢复 268 前形态（v0.0.269）**：`SquadStatusEntry` 已删除——团队状态入口从 topbar 挪到 chat 右上浮菜单（`component-chat-float-menu.md` 第 4 项「团队状态」→ `ComponentSquadStatusModal`）。单聊 = MemberAvatar + name + tag（v0.0.216 原形态）；群聊 = 显式 `<ChatSessionTopbarLeft chrome={chrome}/>`（readOnly 缺省取 chrome.readOnly，与 SectionChatSession defaultTopbarLeft 行为等价——原 undefined 走缺省，现显式）。
- 空态文案：`studio:chat.emptyHint`（经 emptyStateSlot 注入）。
- rootTag='main' + fadeIn（与旧两页一致）；key={sessionId} remount 由 router 保证。
- 发送按钮 actionKey 统一 `chat.message.send`（旧 `studio.message.send` 随壳退役）。

## 可观测节点

无本组件新增 testid——顶栏/输入区/消息流节点全部继承 SectionChatSession 及其子组件契约
（chat-topbar-back-btn / base-chat-input-bar / component-message-stream 各自 spec）。
团队状态入口/弹层 testid 见 `component-squad-status-modal.md`（squad-status-modal / squad-status-row-{memberId}）。

## 复用关系

- 组合：SectionChatSession（唯一 child）+ MemberAvatar + 缺省 ChatSessionTopbarLeft（群聊）。
- 消费方：component-studio-chat-router.tsx（唯一）。
