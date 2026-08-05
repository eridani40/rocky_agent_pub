# squad-chat-page（已退役 → section-studio-chat + section-chat-session）

> **存根**：本页面（`section-squad-chat.tsx`）已删除，Studio 群聊由薄壳 `section-studio-chat.md` + 统一装配层 `chat-page/section-chat-session.md` 承载。

## 契约归属（现状）

| 原本文内容 | 现归属 |
|---|---|
| 身份 header（squad 名 + 群聊 tag） | 缺省 `ChatSessionTopbarLeft`（chrome.title=squad 名，建队时写入；`section-studio-chat.md` 形态表） |
| 群聊能力形态（无 stop / 无两 picker / 无 enqueue / 无 cron） | 后端 `studio_group` capabilities 静态表（`api/overall/04a-session-chrome.md §4`）；`useRunState`/`useSummary` 走 `enabled=false` 零订阅（旧 INV-E3「不挂 hook」的等价承接） |
| 白名单渲染（只显 human user + a2a inbox，mute SquadChat 自身 assistant `<EOS>` 占位与 tool） | `chat-page/chat-actor-strategy.tsx`（`groupMessageFilter` / `resolveGroupActor`，逐行等价迁移 + UT）；由 `deriveRenderStrategy(chrome)` 按 `capabilities.groupRender` 启用 |
| a2a 判定陷阱（a2a 的 role='user' 非 'assistant'——判定必须用 `sender.source==='agent'` + `sender.agent.ref`，裸按 role 判会错） | `chat-actor-strategy.tsx` 谓词注释；a2a 协议权威 `specs/tech/multi_agent/[P1]a2a_protocol.md` |
| 哑路由语义（SquadChat agent 只派发不创作 answer；角色回复全是 a2a inbox 消息） | `specs/tech/squad/[P1]agent_squad_chat.md`（权威） |
| 窄输入区 max-w-760 | `component-chat-session-input.tsx`（`caps.groupRender` 驱动） |

设计动机（群聊 a2a 为何→左）：群聊里 a2a = 「他人发言」，与 user 各占一侧（区别于单聊 a2a→右）；渲染层 mute 不是后端不产——transcript 里 `role='assistant'` 的 `<EOS>` 占位仍存在，读 transcript / 写测试不要假设它不存在。
