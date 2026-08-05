# chat-page 组件群 spec

> 层级: page（page-chat）+ section（conv-panel / chat-detail）+ component（message-stream / tool-batch / tool-call-item / loading-status / empty-state / run-finish / **subagent-tree** / **chat-link-viewer**（+ `chat-link-handler-context` 纯 TS Context 断循环依赖））+ common primitive（primitive-bubble / primitive-markdown-view）
> 文件: app/web/src/components/chat-page/*.tsx + app/web/src/components/common/primitive-*.tsx
> 视觉契约: reqs/v0.0.8/easy-opc-chat-v9a.html（§9 口径）+ reqs/v0.0.8/image.png + **reqs/v0.0.28/easy-opc-squad-v10.html**（subagent-tree 视觉契约）
> 数据权威: specs/ui/components/chat-page/_overview.md（本目录 _overview.md 是会话区概念权威源）
