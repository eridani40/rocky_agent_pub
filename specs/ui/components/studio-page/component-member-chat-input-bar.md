# component-member-chat-input-bar（已退役 → component-chat-session-input）

> **存根**：本组件（`component-member-chat-input-bar.tsx`）已删除，Studio 单聊输入区由统一输入区 `chat-page/component-chat-session-input.tsx` 承载（契约见 `chat-page/section-chat-session.md` 门控矩阵 + `chat-page/base-chat-input-bar.md`）。

- 按钮行（审批 picker → effort picker → model picker → send → stop）、HITL 卡分流、enqueue 排队区、发送错误行：全部内置统一输入区，按 `chrome.capabilities` 逐项门控。
- model 选择写路径统一为 `PUT /session/:id`（session 落库；旧「改 member.model 走 PATCH member」路径随本组件退役）。
- send actionKey 统一 `chat.message.send`。
