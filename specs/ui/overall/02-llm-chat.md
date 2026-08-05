# LLM Chat UI（Playground 个人对话）

> 管什么：Playground（个人对话）view 的页面级结构——路由、布局、chat 主界面要点、theme 机制。
> 不管什么：HTTP 端点契约（→ `specs/api/overall/02-llm-chat.md`）；设计 token 原值（→ `specs/ui/regulation/01-tokens.md`）；组件级契约（→ `specs/ui/components/chat-page/_overview.md`）；配置中心（→ `03-config-center.md`）。

## 1. 概述

web 渲染层：React 19 + Tailwind + Zustand + Vite 单页应用，内存路由（无 URL router），主区视图由 Zustand store `currentView` 决定。

一句话：**左窄图标栏（~56px nav-rail）+ 右主区（chat 或设置页）；chat 流式渲染 thinking 折叠 + answer 文本；设置为三合一合并页（app config + dev config + 插件）**。

### 1.1 路由（前端 in-memory，无 URL router）

| `currentView` | 主区渲染 | 入口（nav-rail 图标） |
|---|---|---|
| `"chat"` | `ChatPage` | 点「Playground」图标（对话气泡，hover tooltip「Playground」） |
| `"settings-app"` | 设置合并页 | 点「应用设置」图标（齿轮，hover tooltip「应用设置」） |

> 插件/dev 配置已合并入 settings-app 页内 tab（三合一，详见 `03-config-center.md`）。nav-rail 完整契约见 `specs/ui/components/framework/nav-rail.md`。

## 2. 布局：AppShell

三栏外壳：nav-rail（56px）+ 板块 sidebar（Playground = session 列表）+ main 区（详见 `00-app-guide.md §1`）。

- **激活态**：当前 `currentView` 对应图标有视觉强调；激活态变化**不得**导致相邻图标位移（固定占位 / `visibility:hidden`，禁 `display:none`）。
- **hover tooltip**：绝对定位或 portal，**不占 sidebar 流式空间**。
- **布局稳定性（硬约束）**：任何元素出现/消失不导致相邻元素位移。

> **MigrationErrorModal**：AppShell 启动期拉取 `migrationErrors`，非空时渲染迁移错误 modal（走 Portal）：聚合提示「N 个迁移失败，详情见日志」+ 主按钮「确定」+ 次按钮「打开日志目录」。组件 spec 见 `specs/ui/components/framework/migration-error-modal.md`；数据契约见 `specs/api/overall/01-counter.md §6`（GET /bootstrap/status）。

## 3. ChatPage（chat 主界面）

**UI 契约权威 = `specs/ui/components/chat-page/_overview.md`**（三栏布局 + Message 模型 + 工具调用合并 + loading 阶段 + 空态 + run finish reason）。页面级要点：

- **Rocky 品牌**：agent message 头像 = Rocky icon 图（28×28 rounded-lg），agent 名标 = `Rocky`；user 头像/名标不动。契约见 `specs/ui/components/chat-page/brand-rocky.md`。
- **消息渲染**：对话区只渲染服务端 SSE `message_start`（无客户端乐观插入）；流式 thinking 折叠 + answer 文本追加。
- **run 态两层分离**：session 层（GET /session + SSE `session_panel`）驱动**停止按钮**（圆环动画 + 中心实心方框，interrupting 减速 2.5s）；run 层（SSE `agent_loop`）驱动 **on-message spinner**（贴流式尾部，phase∈thinking/answering/tool_calling/tool_executing）。两层独立互不耦合；切走切回 spinner 恢复靠 agent_loop bus 的 sticky slot replay（`run_start`/`run_end` 事件 sticky-exclusive 写入，clearReplay 不清）。权威 `specs/tech/agent/event/[P0]event_bus.md §4.3`。
- **排队（enqueue）**：`session.running && pending 非空` 时输入框上方显示排队悬浮区；send 按钮始终可点（running 时走 enqueue 排队）。
- **finish_reason 显示规则**：last run finish 仅在 `sessionRunning===false` 时渲染；error 形态 = ⚠️ icon + `error.displayReason` 一行 + hover/focus tooltip 显 `error.detail`；非 error stopReason（✓已完成 / max_iterations / doom_loop / require_approval / interrupted）保持「分隔线 + muted/gold/sage mono 文案」形态。`RunFinish.error` 契约 = `{category: LlmErrorCategory, displayReason, detail?, code?}`。
- **未读红点**：conv-item 在 `unread && !active` 时右上角显 7px 红点；数据源 = `Session.unread` 持久化字段（产生 = session 层 SessionUnreadRuntime 订阅状态机 completion 信号 + CAS）；消除 = 进入会话 `GET /session/:id` + `POST /session/:id/read`。会话列表订阅 `session_meta` 广播 topic（group `_all`）实时刷新整行（红点/running/title 等）。
- **WorkspacePanel**：chat-page 布局含第 4 栏 ws-panel（可收起为 36px 窄栏 + 可拖宽 [232,560] 默认 272 + per-session 持久化），内含「工作区」tab + 路径栏 + lazy 加载文件树（顶层 GET tree + 展开拉子目录 + watch event 局部刷新）。
- **subagent 展开树 + 只读页面**：parent conv-item 有 subagent 时挂 twisty + 三段树（running / 分割线「非运行中 (N)」/ terminated 灰显）；subagent identity = indigo dot 11×11。点 subagent 子项切到 subagent session → 只读模式：隐藏输入区，保留消息流 + context usage + 「子AGENT · 只读」badge。
- **@ mention**：三处输入区统一 ChatComposer（Tiptap pill-aware 编辑器）；输入 `@` 唤起 MentionPopover（多 tab：Files / Skills + 搜索）；选中生成 MentionPill（inline 圆角胶囊，`@` 前缀 + type icon）；发送时序列化为 `MessageContent[]` 结构化数组（`text` + `mention` 混合）。pill 删除 = 光标邻接 Backspace/Delete 整颗删。组件权威 `specs/ui/components/chat-page/{chat-composer,mention-popover,mention-pill}.md`。
- **共享渲染内核 ChatStream**：`component-message-stream.tsx` 参数化为三视图（playground / studio 单聊 / studio 群聊）共享内核，差异收敛到 4 个可选策略 hook：`resolveActor(msg)`（头像+名字）、`messageFilter(msg)`（消息级白名单）、`blockFilter(block, msg)`（block 级过滤；默认 `DEFAULT_BLOCK_FILTER` 隐藏 `isSystemReminder=true` 的 text block，LLM 零侵入——`encodeContentBlock` 只读 `b.text`）、`sideOfMessage(msg)`（左右侧判定；a2a inbox `sender.source='agent'` → assistant 侧）。Playground 不传策略 hook（默认行为）。权威 `specs/tech/app/frontend/[P0]component_architecture.md §3.3`。

## 4. 设置页

app / dev / plugin 配置统一为三栏 + tab 结构，契约详见 `03-config-center.md`。

## 5. Theme 机制

theme 由 app_config `appearance.theme` 决定，控制 `<html>` 根元素 `data-theme` 属性，Tailwind 经 CSS 变量切换色板。token 权威源 `specs/ui/regulation/01-tokens.md`。

**首屏初始化**（`lib/theme-init.ts`）：`initThemeFromConfig()` GET `/config/app?group=appearance&key=theme` → `applyTheme(theme)` 设 `<html data-theme>`；`main.tsx` 入口在 **React 首屏渲染前 await**，确保首次 paint 即正确 theme（无闪烁）。未配置 fallback = `light`。设置页切换复用 `applyTheme()` + PUT 持久化。

## 6. 边界

| 零件 | 归属 |
|---|---|
| Playground 页面级契约（路由 / 布局 / run 态要点） | 本文 ✅ |
| chat 组件级契约（消息流 / 输入区 / model picker 等） | `specs/ui/components/chat-page/` |
| 设置页契约 | `03-config-center.md` |
| nav-rail | `specs/ui/components/framework/nav-rail.md` |
| HTTP 端点 | `specs/api/overall/02-llm-chat.md` |
| Studio chat（群聊/单聊策略） | `06-studio.md §7` |
