---
type: spec
title: chat 统一装配层（SectionChatSession + useChatChrome + capabilities 门控）
priority: P0
status: active
updated: 2026-07-29
since: v0.0.216
related: [[P0]chat_area_hooks.md, [P0]component_data_map.md, [P0]component_architecture.md]
---

# chat 统一装配层（SectionChatSession + /session/:id/chrome）

## §1 概述

- **管什么**：chat 区域的**统一装配层**——`section-chat-session.tsx`（自给型会话区，7 页唯一接入点）+ `use-chat-chrome.ts`（chrome 数据 hook）+ `chat-actor-strategy.tsx`（chrome 驱动的消息渲染策略）+ 与后端 `GET /session/:id/chrome` 的分工契约。
- **不管什么**：area-hooks 内部结构（→ `[P0]chat_area_hooks.md`）；useLifecycle 机制（→ `[P0]component_architecture.md §3.10`）；chrome 接口字段/capabilities 静态表权威（→ `specs/api/overall/04a-session-chrome.md`）；组件 props/文案（→ `specs/ui/components/chat-page/section-chat-session.md`）。
- **范畴一句话**：把「7 处 chat 页面各写一遍的装配代码」收敛成一个自给组件——页面只给 sessionId，能力差异全部由后端 chrome 数据表达。
- **与外界如何交互**：`section-chat-session.tsx` 被 7 个页面（page-chat / studio router 薄壳 / academy 4 处）import；内部 compose 既有 area-hooks + `getSessionChrome()`（lib/chat-api）；写路径走既有 POST/PUT session 端点。

## §2 设计原则（跨文件不变量）

1. **能力缺省全开**——SectionChatSession 内置全部会话能力（HITL 两卡/abort/两 picker/model picker/enqueue/usage/minimap/悬浮菜单），关闭是例外且只能来自后端 capabilities。**如果不这样**：每加一个能力要逐页接线，漏接即再现「长得一样功能不一样」。
2. **前端零 kind 分支**——组件内禁止 `biz==='academy'` 类字面判断；渲染差异只依 chrome 的 `capabilities` / `members` / `readOnly` / `defaultModel` 数据驱动。kind→数据源/能力的映射是**后端静态表**（api 04a §3/§4）。**如果不这样**：kind 差异散落前端，新 kind 要改 N 处。
3. **readOnly = 前端 prop ∪ chrome.readOnly**——与既有 forceReadOnly 行为逐项等价（badge + model-tag + usage + CompactBtn 保留；ClearBtn/输入区隐藏）。chrome.readOnly 唯一判定源 = `derivation === 'subagent'`。
4. **enabled 门（防无意义订阅）**——`useRunState` / `useSummary` 增加 `opts.enabled`（缺省 true）；`enabled=false`（capabilities.runState=false，即群聊）时 onInit 不 subscribe、不 GET，零 SSE 零网络。恒挂 hook（React 规则）但订阅按能力门控——群聊保持 v0.0.155 INV-E3「不订 run 态」语义不回归。
5. **minimap/usage 内置，禁止父级回收 messages**——`onMessagesChange` 仅保留给 training-observe（消息驱动任务刷新，后端无 training.* SSE）；version-chat 旧「onMessagesChange 回收 messages 到父级建 minimap」路径删除（防双 useMessages 双订阅）。
6. **chrome 可注入防双拉**——宿主已持 chrome（studio router 需 chrome 定 workspaceSemantic）时经 `chrome` prop 下传，SectionChatSession 跳过自拉；其余页面缺省自拉。

## §3 useChatChrome 拆解行（component_data_map 对齐基线）

| hook | 数据形 | 订阅 topic | 读 API | 触发 | 契约草案 |
|---|---|---|---|---|---|
| `useChatChrome(sessionId)` | Snapshot\<SessionChromeView\> | 无（不订 SSE） | GET /session/:id/chrome | GET-once（deps:[sessionId] 重拉） | onInit: getSessionChrome（genRef+signal.aborted 守卫）；onEvent/onTick: 无；setEffort/setApprovalMode/setModel: mutate 乐观 + fire-and-forget PUT /session/:id（'default' 哨兵→body {modelId:'default'}），不 reload |

- 取代 `useStudioChatChrome`（studio 专用，删除）与 `useModelRestore`（playground 专用，删除；token 竞态守卫由 useLifecycle abort + genRef 等价承担）与 academy chat col 内联 getSession model effect。
- 与 area-hooks 分工不变：run 态/messages/usage 仍归各 area-hook（`[P0]chat_area_hooks.md`），chrome 只管静态装饰数据。

## §4 关键代码路径

- 装配：`section-chat-session.tsx.SectionChatSession()` → `use-chat-chrome.ts.useChatChrome()` → `lib/chat-api.getSessionChrome()` → `handlers/session-chrome.ts.handleSessionChrome()` → `services/session-chrome.ts.buildSessionChrome()`。
- 群聊渲染策略：`buildSessionChrome()` 置 `capabilities.groupRender=true` + `members[]` → `chat-actor-strategy.tsx`（自 studio squad-chat-helpers 迁移）派生 messageFilter / resolveActor / sideResolver → ComponentMessageStream。
- 运行时模型（academy gap 修复）：`bootstrap-agent-phase.setResolveConfig` → `buildSessionConfigFromDeps()` → `model-resolver.resolveModel({sessionType:'academy', classroom})`（链 = session → classroom.defaultModel → throw，**v0.0.230 收窄去 app 默认兜底**，与 `academy-session-model.ts` 创建链等价）。

## §5 边界

| 零件 | 归属 |
|---|---|
| SectionChatSession / useChatChrome / chat-actor-strategy / component-chat-session-input / component-chat-session-topbar-left（缺省身份 header `ChatSessionTopbarLeft`，titleOverride 口子供宿主注入实时标题） | 本文件（实现 `chat-page/`） |
| chrome 接口 shape / kind 数据源映射 / capabilities 静态表 | `specs/api/overall/04a-session-chrome.md` |
| area-hooks（useMessages/useRunState/useUsage/useSummary/fanout） | `[P0]chat_area_hooks.md` |
| 列宽持久化 `common/use-persistent-width.ts` | `[P0]component_architecture.md`（common 层） |
| 消费方必备能力清单（验收断言） | `specs/ui/components/chat-page/base-chat-page.md` |
