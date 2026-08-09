# member-chat-page（已退役 → section-studio-chat + section-chat-session）

> **存根**：本页面（`section-member-chat.tsx`）已删除，Studio 单聊由薄壳 `section-studio-chat.md` + 统一装配层 `chat-page/section-chat-session.md` 承载。

## 契约归属（现状）

| 原本文内容 | 现归属 |
|---|---|
| 身份 header（back + MemberAvatar + name + tag）/ prefill / onBack | `section-studio-chat.md`（薄壳唯一职责） |
| 装配（area-hooks / HITL / enqueue / usage / picker / abort / clear） | `chat-page/section-chat-session.md`（capabilities 门控，接口 `api/overall/04a-session-chrome.md`） |
| chrome 数据（member / tag / squad 默认模型 / effort / approvalMode） | 后端 `GET /session/:id/chrome`（旧 `useStudioChatChrome` 两跳前端拼装已删） |
| 单聊渲染策略：对端固定 actor（a2a 取 `sender.agent.ref` 非 member）+ **a2a→左**（信封折叠，与群聊对齐） | `chat-page/chat-actor-strategy.tsx`（`resolveMemberActorFactory` / `memberSideResolver`，逐行等价迁移 + UT 锁定）；策略选择由 `deriveRenderStrategy(chrome)` 按 `chrome.memberId` 数据驱动 |
| a2a 消息判定陷阱（role='user' 非 'assistant'，必须用 `sender.source`+`agent.ref`） | `chat-actor-strategy.tsx` 谓词 `isA2aInbox`/`isUser` 注释 + `squad-chat-page.md` 存根指向的 tech 权威（`specs/tech/multi_agent/[P1]a2a_protocol.md`） |

设计动机（单聊 a2a 为何→左）：a2a 是第三方旁路投递，以信封折叠展示在左侧（与群聊对齐，v0.0.295 起）；信封内 senderName 标识发送方，避免与 member answer（左）混淆。
