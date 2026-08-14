# v0.0.301 — a2a 信封消息去掉左侧发送者头像

> 编码期对 change_plan 的偏离记录（frozen 契约不改，偏离记此）。

## 偏离：`avatar: null` → invisible 包裹

**change_plan 原契约**：`resolveGroupActor()` / `resolveMemberActorFactory()` 的 a2a inbox 分支 `avatar` 返回值改为 `null`（PRD §3.1 双分支设计）。

**实际实现**：`chat-actor-strategy.tsx` L73 / L116 返回 `w-9 shrink-0 invisible` 包裹原 MemberAvatar 对象，而非 null。理由：保留原对象 + 外层 `w-9` 列宽（与 MemberAvatar md 尺寸一致），使信封行位置 100% 保真、不贴左，且未来恢复头像只需去掉包裹类。渲染侧（component-message-stream.tsx）零改动，原「avatar=null 自动不渲染」分支未触发。

**spec 同步**：`specs/ui/components/chat-page/section-chat-session.md`（member 单聊 / 群聊 a2a 消息渲染两条）已按实现记录「原 MemberAvatar 对象 invisible 包裹」；PRD v0.0.301 为历史版本日志不改写（其 §3.1 avatar:null 描述与实现偏离以此记录为准）。
