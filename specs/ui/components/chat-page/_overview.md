# 会话区（Chat Page）UI Spec — v0.0.12

> 层级: page（含 2 section + 多 component）
> 本文是会话区的**概念权威源**：定义布局、组件、数据视图模型、绑定规则、视觉基线。PRD/编码对齐本文。
> **数据流/后端交互细节**（GET seed / SSE 事件链 / enqueue 状态机 / 双通道 reducer / 发消息三态分支）见 `_data-flow.md`——本文 §0/§2/§5 是一句话摘要，链路真相源以该文为准。

## 0. 设计意图（一句话）
左侧 56px 图标导航 + **220px 会话列表栏** + 右侧会话交互区；消息按顺序流式呈现，user 右深底气泡 / agent 左 accent-surface 气泡（支持 markdown）；**消息流中连续的工具调用合并成一个弱化胶囊（视图层合并，与消息边界无关）**，点开包裹各调用、再点开看参数/结果（KV 表格态，禁止 JSON/代码块）；推理文本（thinking）**不展示**；run 进行中消息流尾部贴一个随阶段切换文案的 on-message spinner（替代原输入框左上方浮动胶囊），随流式增长，run 结束即消失。
对话区**只渲染服务端 SSE 消息**（`message_start` 的 messageId = 服务端 ULID，唯一来源）——**移除客户端乐观插入**（消除 id 双轨制，根治 BUG-006）。发送 → enqueue →（idle 立即 activate / running 排队）→ 服务端 `message_start` 渲染 user 气泡。**running 且 pending 队列非空时**输入框上方显示 **enqueue-view 排队区**（`message_enqueued` 建 / `enqueued_message_processed` 移）。`chat-send` **一直存在**（删 `runActive` disabled），running 时其**左侧显示红色中断按钮**（调 `POST /session/:id/abort`）。running 状态来源：GET /session/:id（`state`/`running`/`currentRunId`）+ SSE `session_status_update`。

## 1. 布局（四栏：nav-rail + conv-panel + chat-detail + ws-panel）
> 新增右侧第 3 栏 ws-panel（workspace 面板，可收起/可调宽）。原两栏（conv-panel + chat-detail）不变；nav-rail 是 framework 既有不算业务栏。详见 `component-workspace-panel.md`。
- **nav-rail（56px）**：既有 `framework/nav-rail`。会话图标 `nav-playground` 激活（由 `nav-chat` 改名而来。
- **conv-panel（220px）**：新增 `section-conversation-list`。
- **chat-detail（flex-1）**：`section-chat-session`（统一装配层，含空态分支；契约见 `section-chat-session.md`）。
- **ws-panel（新增，232-560 默认 272 / 收起 36px）**：`section-workspace-panel`（见 `component-workspace-panel.md`）。在 `<SectionChatSession>` 之后追加 `<SectionWorkspacePanel>`；宽度 + 收起态 localStorage per session 持久化；拖宽手柄 `.ws-resize` 在面板左 -2px。ws-panel tab bar 收敛为仅「工作区」（memory/cron tab 迁悬浮菜单）。
- **右缘 overlay 层**（`component-chat-right-overlay`）：chat-detail 右缘贴边悬浮的绝对定位层，纵向承载悬浮菜单（`component-chat-float-menu`，上）+ 历史 query minimap（`component-history-minimap`，下），脱离正文流、不推动消息流/输入区。三处 chat root（playground / studio 单聊 / studio 群聊）各挂一处。 overlay 由 （堆顶）改 （纵向铺满消息区 wrapper）→ minimap 在菜单下方剩余空间纵向居中；定位基准从 section 根改为**消息区 wrapper**（，input-bar 在 wrapper 外）；消息区 `ComponentMessageStream` 根  → （右侧 80px reserve 让位悬浮 overlay）。 层次属性（z-index / pointer-events gate / portal 规矩）收敛到 `_layering.md` 单一权威——overlay 属 L1 floating-chrome，详见 `component-chat-right-overlay.md §3/§4` + `_layering.md`。

## 2. 数据视图模型（对齐真实 Message）
UI **不发明新模型**，消费真实 `Message`（`specs/tech/agent/message`）。渲染规则是本 spec 的核心约束：
**渲染规则（MANDATORY）**：
1. **消息按顺序**：`Message[]` 按 `createdAt` 升序逐条渲染为 message-row。
2. **user 消息** → 右侧深底气泡（`TextBlock.text`）。
2a. **user 消息来源徽标**：当 `sender.source==='user' && sender.channel && sender.channel.type !== 'client'`（即从 IM 渠道如飞书入站）时，user 气泡**下方**渲一行 muted 小字「来自 {type}」（i18n `chat:origin.from`，如「来自 feishu」）。web client 直发（无 channel）/ `type==='client'` **不渲染**徽标（避免「来自 client」噪声）。`flatten` 只派生原始 `type`（`message-flatten.ts` user-text `name` 字段），「来自」前缀 + i18n 由渲染层（`component-message-stream.tsx` user 侧）拼（单一职责）。数据源：live SSE `message_start.origin` 经 reducer 写 `sender.channel`（slim `{type,instanceId}`，不含 PII）+ history `GET /messages` 后端全量 `sender.channel` 两路一致。
3. **assistant 消息** → 左侧；其 `content[]` 按序产出 view-element：`TextBlock` → answer 气泡（markdown）；`ToolCallBlock` → tool-call-item（call + §4 绑定的 result）；`ReasoningBlock` → **跳过不渲染**。
4. **tool_result 绑定 tool_call**：先扫所有 `role='tool'` 消息，建 `Map<toolCallId, ToolResultBlock>`。tool-batch 内每个 tool-call-item 用 `ToolCallBlock.id` 查这个 map，把结果塞进该项的「结果」区。**result 永远附着到对应 call**（req 硬约束）。
5. **tool-batch = 视图层连续合并（MANDATORY）**：先把整个有序消息流**拍平**为 view-element 序列，然后任意连续的 tool-call-item 合并为一个 tool-batch 胶囊（req：「一次不管几个工具调用，只产出一个胶囊」）。**遇到非 tool 元素（answer 文本 / user 消息）即断开、开新 batch**；**与消息边界无关**——跨多条 assistant 消息但位置连续的 tool_call 并入同一 batch（req：「所有连续的 tool 放一起，是视图上的合并」）。例：assistant 消息 `[text, callA, callB]` → `[answer, batch{A,B}]`；下一条 assistant 消息紧接着是 `callC`（无 text）→ C 并入同一 `batch{A,B,C}`。
6. **part 以 `messageId + toolCallId/text-index` 为 key**（非数组 index）——SSE 乱序/增量更新不抖动（沿用 [[chat-message-part-key]] 原则）。
7. **run finish（MANDATORY，req2）**：UI 订阅事件流，按 runId 记录每个 run 的结束态——`run_end` 事件的 `stopReason`+ 若该 run 期间收到 `error` 事件则记其 error payload。**仅最近一次 run（last run）**在其末条消息下方渲染 finish reason（冷读 seed 恢复见 `_data-flow.md §3.6`）；历史 run 不重复渲染（req2：「针对最后一个 run」）。
7a. **last run finish 显示前提（MANDATORY）**：仅当 **`sessionRunning === false`**时才渲染 last run finish（规则7）；**running 中不渲染 finish**（此时由 on-message spinner 表达进行态，§0，finish 隐藏避免与「生成中」叠加）。即 finish 渲染条件 = `lastRunFinish != null && sessionRunning === false`。切会话/重开恢复时 GET /session 若已 running，则 finish 不渲染直到 session 转 idle/interrupted/error。
8. **answer 气泡链接可点击 + 按 target 分发（MANDATORY）**：answer 气泡 markdown 的 `[文本](target)` 渲染为可点击 `<a>`（`cursor-pointer` + 常驻下划线），点击按 target 类型分发——web scheme（http/https/mailto 等）→ 系统默认浏览器（Electron `shell.openExternal`，不在 app 内导航）；本地路径属 12 内置格式（`isBuiltinEditable`）→ app 内弹**只读** viewer（`ComponentChatLinkViewer` 挂 `ComponentModalMdEditor` readOnly=true；workspace 相对路径走 HTTP `readWorkspaceFile`，绝对路径/`~`/`file://` 走 Electron `shell:readFileText` IPC）；其它本地路径（图片/pdf/代码/未知）→ 系统默认应用（`shell.openPath`）；危险协议（javascript:/vbscript:/data:）由 `isDangerousScheme` 拦截降级纯文本不可点。分发单一权威 = `lib/link-target.ts`（classifyLinkTarget + openLinkTarget）；onLocalViewer 回调经 `ChatLinkHandlerContext` 透传（无 Provider 的消费方——md-editor viewer / skill 预览 / feishu doc——12 格式本地链接降级系统打开，不弹内置 viewer）。组件契约见 `component-chat-link-viewer.md`；IPC 契约见 `specs/tech/app/package/[P0]package_structure.md §4.4`。user 气泡（MentionRender）不动。

## 3. 组件清单（分层）
| 层 | 组件 | 职责 |
|---|---|---|
| section | `section-conversation-list` | 220px 会话列表栏：header + 滚动列表 |
| section | `section-chat-session` | 会话交互区根（统一装配层，capabilities 门控）：topbar + messages + loading + input；空态分支；见 `section-chat-session.md` |
| section | `section-workspace-panel` | 右侧第 3 栏 workspace 面板：收起/调宽 + tab + 文件树 + 切换目录 + 刷新（见 `component-workspace-panel.md`） |
| component | `component-chat-topbar` | 标题 +  model-tag 仅 readOnly 渲染 / **非 readOnly 分支不再挂模型选择器** |
| component | `component-conversation-item` | 单条会话：title + time，active/hover；**有 subagent 时挂 subagent-tree + twisty** |
| component | **`component-subagent-tree`** | parent 派生的 swarm 展开树（三段：running / 分割线「非运行中 (N)」 / terminated 灰显）；独立 spec `component-subagent-tree.md` |
| component | `component-message-list` | 有序消息流，自动滚底 |
| component | `component-message-row` | **三区对称**：左头像列(w-9) + 内容列 + 右头像列(w-9)，双边对称（推翻单侧头像） |
| component | `component-bubble-user` | user 深底气泡 |
| component | `component-bubble-answer` | agent accent-surface 气泡（markdown） |
| component | **`component-chat-link-viewer`** | chat 链接只读 viewer 挂载层（12 格式本地链接 → `ComponentModalMdEditor` readOnly 强制；含 `ChatLinkHandlerProvider` 注入 onLocalViewer；Context 在 `chat-link-handler-context.ts` 纯 TS 独立文件）；独立 spec `component-chat-link-viewer.md` |
| component | **`component-scroll-guide-bubble`** | 滚动引导气泡（v0.0.262）：用户不在消息流底部时浮动显示（生成中「新消息」/ 空闲「回到底部」），点击平滑滚底；absolute 不占文档流；独立 spec `component-scroll-guide-bubble.md` |

## 4. 各组件契约
### 4.1 section-conversation-list（180-400 默认 220，可拖）
- ** 宽度持久化**：全局 localStorage key `conv-panel-width`（非 per-session，区别于右栏 ws-*；裁决 P2）。读 `clamp[180,400]` 缺省 220 坏值兜底；写 try/catch 吞异常。模式对齐 `workspace-storage`。
- **header**：；左 `conv-header-title`（11px/600 mono uppercase muted-2「会话列表」）；右 `conv-new-btn`。
- ** 右键浮层菜单（复制 Session ID）**：顶层会话项（conv-item）右键 →  + 浮层定位 `(clientX, clientY)`；点 copy-id → `navigator.clipboard.writeText(sessionId)` + 关闭。浮层打开时挂 window `click`/`contextmenu`/`keydown(Escape)` 关闭监听器，且**延迟一拍注册（`setTimeout(0)`）**——否则打开菜单的**同一次 contextmenu 事件**冒泡到 window 时会立刻触发 close，菜单一开就关；cleanup 里 `clearTimeout` + `removeEventListener`。与 studio sidebar 模式平行（studio ，见 `studio-sidebar.md`）——两者为并行实现，未来可抽共用组件。i18n `chat:convPanel.copySessionId`。
- **[v0.0.231] 右键菜单加「置顶 / 取消置顶」项**：置顶项在「复制 Session ID」**之上**；已置顶会话该项文案为「取消置顶」（按 contextMenu sessionId 查 sessions[] 的 pinned 派生）。点击 → `PUT /session/:id {pinned: !current}`（fire-and-forget，同改名路径）→ 后端写 + metaBroadcaster.broadcast → `session_meta` 广播 → 列表 reducer 统一比较器归位（多端一致，**不做乐观本地更新**）。i18n `chat:convPanel.pin` / `chat:convPanel.unpin`。**仅 playground 顶层会话**：subagent 树内子项、academy/studio 列表无此项。
- **[v0.0.231] 列表统一排序契约（MANDATORY，补落 doc 缺口）**：列表顺序 = **置顶组在前、非置顶组在后，同组内按 `updatedAt` 倒序**（最新在上）。排序是列表的**常驻属性**，由前端会话列表 store（chat-slice）**单一比较器**统一计算（`compareSessionsForList`：先 pinned 降序、同组内 `updatedAt desc`，Array.sort 稳定排序），**所有写路径收敛到同一排序**：`setSessions`（GET /session 全量 / 新建 / 删除后重拉）+ `applySessionMetaEvent`（session_meta 广播 upsert）都在写入前重排。**即时归位**：新建会话（updatedAt 最新 → 非置顶组顶部）/ 会话收到新消息（run 推进 updatedAt → 组内浮顶）/ 置顶切换（**pinned-only 更新不刷 updatedAt**——置顶是纯标记，只改分组归属：置顶 → 进置顶组按原 updatedAt 落位；取消置顶 → 回非置顶组按**原对话时间**归位，可能不在顶部。用户裁决 2026-08-01）/ 刷新重拉——都立即自动归位，无需手动刷新。**重排不动状态**：active 选中 / unread 红点 / running spinner / suspended「?」/ subagent 展开树行为不变（React key=s.id 位置移动不重挂载）；subagent 顶层过滤（page-chat topSessions）不受影响。后端 `GET /session` 返回顺序契约不变（仍 updatedAt desc）——置顶分组纯前端展示层归位。
### 4.2 component-conversation-item
  - （新增）：派生自 Session.unread。true → 渲染未读红点；false → 不渲染。
  - （**新增**）：派生自 Session.titled。仅作 conv-item 内部判定（编辑态 save 时 PUT body 携带 `titled:true` 同步置 true）；渲染层不读此字段（标题文本永远来自 `title` prop）。
  - `activeSubId?: string`（新增）：当前选中 subagent sessionId（subagent-tree 高亮用）。
  - **[v0.0.231] pinned（派生，非 prop）**：派生自 `Session.pinned`（`s.pinned === true`）。true → 渲染 pin 图标 + 置顶背景；false → 无。
- **视觉**：；hover ；active  + title 。title 13px/500 ellipsis；time 11px mono muted。
  - **[v0.0.231] pinned 视觉基线**：
    - **pin 图标**：置顶 item **最右侧常驻**（非 hover 才显），非置顶无。`PinIcon`（chat-page/icons.tsx，12px，`text-muted` token），**absolute 定位**于 title 行区（`top-2 right-2`）——脱离布局流，**出现/消失零 reflow**（布局稳定铁律：不推动 title/time/相邻 item）；title 行在 pinned 时加 `pr-5` 让位（仅该元素自身 padding，title 略早 truncate，不推其他元素）。与 unread 红点（`top-2 right-[18px]`，v0.0.231 由 right-2 统一起见左移）、running spinner / suspended「?」（title 左侧槽位）**错位共存、互不遮挡**。
    - **背景加重（token，INV-2 禁字面 hex）**：pinned 非 active → 常态 `bg-bg-warm`（比非置顶常态白底深一档，一眼区分两组）；**active 态仍是最强视觉**——active（任意分组）→ `bg-[var(--surface-3)]`（比 bg-warm 更深一档，统一替换原 bg-accent-surface，保证 pinned+active 叠加时不丢失选中指示）；hover 非 active 仍 `hover:bg-bg-warm`（pinned 项 hover 无额外变化，可接受）。
    - **无组头/分隔线**：两组之间不引入组标题或分隔线 UI，分组边界靠 pin 图标 + 背景区分。
  - **running spinner + suspended「?」指示器（与未读红点错位共存）**：
    - 数据：派生自 `session.state`。**suspended 排除 running**（INV-2：loop 已退出等用户回填，亮「?」非 spinner）。
    - `conv-item-{id}-suspended-mark` = 「?」标记（12px accent 色），`state==='suspended'` 渲染（表「等用户回答」）。

### 4.5 滚动（useMessageScrollPagination + 引导气泡）— 滚动 hook 权威章节

> 滚动逻辑的权威章节（代码注释引用本节的既有锚点；v0.0.262 起成文）。实现：`app/web/src/components/chat-page/use-message-scroll-pagination.ts` + `component-message-stream.tsx` + `component-scroll-guide-bubble.tsx`。

**滚动 hook（`useMessageScrollPagination`）**：ComponentMessageStream 的滚动副作用唯一 owner——onScroll（near-bottom 追踪 + loadMore 触发）、自动滚底、prepend 位置保持、sticky-bottom 门控。

- **返回签名**：`{ onScroll, nearBottom, scrollToBottom }`（v0.0.262 扩展，新增字段向后兼容——既有调用方解构 `{ onScroll }` 照常）。
  - `onScroll`：挂到滚动容器；内部 near-bottom 追踪（`scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_THRESHOLD(120px)`）写 ref（effect 门控）+ state（气泡消费，setState 值去重防滚动事件风暴）；仅 `hasMore && !isLoadingMore && scrollTop < LOAD_MORE_THRESHOLD(120px)` 触发 loadMore。
  - `nearBottom`：是否在底部附近（初始 true——新会话首条消息到达即滚底语义）。
  - `scrollToBottom(behavior = 'auto')`：编程滚底（`el.scrollTo({ top: el.scrollHeight, behavior })`）+ 同步 `nearBottom=true`（点击气泡滚底后即时消失；编程 scrollTo 不触发 scroll 事件，需显式同步）。

- **autoScroll 触发语义 = 内容变化（v0.0.262 跟丢修复核心）**：`autoScrollDeps` 由 caller 传内容签名 `${rows.length}:${textLenSum}`（行数 + text 长度和；tool-batch 无 text 跳过；useMemo 基于已构建 rows 纯计算）→ 新消息到达 **OR** 既有消息内容增长（流式 `text_block_delta` 更新同一条消息，rows.length 不变但 textLenSum 变）都触发滚底。旧依赖 `rows.length` 单维度只在行数变化时触发，是流式生成跟丢根因。
- **rAF 合并节流**：hook 内 `cancelAnimationFrame + requestAnimationFrame`（每帧最多一次滚底，流式 delta 防抖），effect cleanup `cancelAnimationFrame`（组件卸载/依赖再变不留悬空回调）。

**Invariants（MUST NOT 破坏）**：
1. **自动滚底只在「消息内容变化/run 状态变化」触发**（v0.0.262 起 = 内容签名，流式 delta 同 rows.length 内容增长也触发）；loadMore 前插绝不触发（`isLoadingMore=true` 跳过）。
2. loadMore 完成后下一帧跳过一次自动滚底（`wasLoadingMoreRef` 防滚回底）。
3. prepend 后视觉保持原顶部条目位置（`prevHeight = scrollHeight - scrollTop` 技巧，useLayoutEffect DOM paint 前捕获+恢复）。
4. sticky-bottom 门控：仅 `nearBottomRef.current=true`（用户在底部附近）才滚；用户向上翻看历史不强制拉回。读「上一刻用户位置」——新内容长高前 scroll 事件已把当前位置记入 ref。
5. onScroll 始终挂载（不管 hasMore）：内部同时做 near-bottom 追踪（始终）+ loadMore 触发（仅 hasMore）。

**滚动引导气泡（`component-scroll-guide-bubble.tsx`）**：用户不在底部（`nearBottom=false`）且会话非空时，消息流可视区底部浮动显示——生成中「新消息」/ 空闲「回到底部」，点击平滑滚底。显隐 = `!nearBottom && hasMessages`（runActive 只决定文案不决定显隐）；absolute 定位不占文档流（布局稳定性 MANDATORY）；visible 用 opacity/pointer-events 过渡不 unmount（动画平滑）。挂载点 = ComponentMessageStream 内部 scroll 容器外包 relative wrapper（scroll div className 原样保留，BaseChatPage 骨架零改动）。组件契约见 `component-scroll-guide-bubble.md`。

## 5. 关键交互
1. **新建会话**：点 `conv-new-btn` → 创建空会话并选中 → chat-detail 显示 empty-state（欢迎 hero，见 `component-empty-state.md`）。**等价入口**：empty-state 内 mascot / ＋角标 / CTA 三处点击均触发同一 `onNewConversation` → page-chat `handleCreate`（与 conv-new-btn 同 handler）；active 空会话 / 无 active 会话均可触发（无 active 会话时 input-bar 不渲，empty-state 是唯一入口，避免死页）。
2. **发消息（重做 / ChatComposer 迁移）**：`chat-composer-editor` 输入 → `chat-send`/Enter → POST /messages（enqueue）→ **不再乐观插入 user 气泡**。按 session 状态分支（design §3.1 / 板块 4.3）：
   - **idle / interrupted / error**：enqueue 后立即 activate 新 loop → state=running（SSE session_status_update）→ loop drain → `message_start(user)` 渲染 user 气泡（messageId = 服务端 ULID）→ loading-status 出现（thinking）→ assistant 流式增量（answer 追加 / tool_call 入 batch / tool_result 绑定）→ `run_end` → loading 消失，末条消息下方渲染 run-finish（§2 规则7）。
   - **running**：enqueue 排队（返 already_activated，不启动新 loop）→ **enqueue-view 显示该 pending 项**（enqueue-item-{enqueueId}）→ 当前 run 结束 drain 处理 → `message_start(user)` 渲染 + `enqueued_message_processed` 移出队列 → 继续 run。
   - **interrupting**：enqueue 后 activate 循环等待（poll），abort 收尾完成后新 loop drain 处理（design 板块 4.3 case3）。
2b. **取消排队消息（新增 / 重构，design 板块 3.4）**：running 时 enqueue-view 中某条 `enqueue-item-{enqueueId}-cancel` 被点 → **X 立即转 spinner（本地 canceling Set，禁点防重复）** → POST `/session/:id/messages/:enqueueId/cancel`（202，fire-and-forget，不监听成败）→ 后端同步 removeMessage + emit `enqueued_message_canceled`（或 cancel 来晚追加 cancel 条目作 drain 兜底）→ 前端按 enqueueId 出列（**移项靠 SSE，不进 store**，多端一致）；1s 后回 X（cancel 幂等可重试）。**竞态**：原 message 已先一步 processed → cancel 来晚 → 前端收到 `enqueued_message_processed` 也按 enqueueId 出列（幂等）。
3. **中断（ESC + 红钮双触发统一动作）**：running 时两个入口任一触发同一「中断动作」——
   - **ESC（焦点门控）**：焦点在输入区 + 非 @ popover + 非 HITL pending + `sessionRunning` → ESC 触发（`component-chat-session-input.tsx` window capture-phase listener）；焦点不在输入区时 ESC 无反应（红钮兜底入口）
   - **红钮（任意焦点位置兜底）**：点 `chat-abort`（任意焦点都触发）
   - **统一动作 handler**（`handleInterrupt`）：snapshot enqueueItems → 逐条 `cancelEnqueue`（fire-and-forget，移项靠 SSE `enqueued_message_canceled`）→ `composerRef.applyInterrupt(items)`（注入排队内容到输入区**开头**保留 mention pill + 焦点管理两分支：wasFocused→相对原内容偏移不变 / !wasFocused→焦点到末尾）→ `onAbort()` = POST /session/:id/abort（abort/cancel 既有端点零改，编排详情见 `_data-flow.md §3.3` + `chat-composer.md`「中断注入」节）
   - abort 后端 4 步收尾（loop 退出 / partial 持久化 / clearReplay）→ state→interrupting（abort-btn 禁用）→ state→interrupted + `run_stop(interrupted)` → run-finish 渲染「已中断」（§2 规则7，stopReason=interrupted）+ loading 消失 + abort-btn 消失（running=false）。
4. **工具调用合并展示**：assistant 消息里若干 tool_call → 一个折叠 tool-batch 胶囊；点开 → 面板包裹各 tool-call-item；点某 item → 展开其参数+结果 KV。

## 视觉基线
- 圆角：气泡 ；loading/空态 icon 圆 。
- 配色（银灰化）：user 气泡  黑底白字（regulation 02 §6，从旧 ）；answer 白底 `bg-surface + border-border` 尖角左上（不再 accent-surface）；agent avatar = MemberAvatar hash palette 8 色（不再 accent 渐变，`MemberAvatar` 按 identity hash 派生）；status: done=`--success`、running=`--warning`、err=`--danger`（不再 sage/gold/#DC2626 硬编码）；KV key=muted 右对齐、value=mono fg-2。abort-btn 走 `var(--danger)`（hover 加深 20%）；enqueue-view 状态点 `var(--warning)`（不再 gold）+ 文案 muted。run-finish error 走 `var(--danger)` ⚠️ icon + displayReason 一行（不再字面 `#DC2626`）。conv-item 未读红点 `var(--danger)`。subagent identity indigo 保留但走 palette 8 色之一（violet/blue 分配），废旧 `--color-indigo` 硬编码；terminated `opacity: 0.4`。**INV-2**：字面 hex 归零，全走 token/tailwind utility。
- 字体（两族分工）：标题 Inter 14/600；正文 13.5px；mono（time/meta/model-tag/KV value/tool 文案/loading/**msg-time**）JetBrains Mono；avatar 走 （**Playfair Display 全站下线** INV-4，brand 改 `--brand-grad`）。regulation 01 §2。
- 尺寸：conv-panel 220px、nav 56px、avatar 28px（sm）/ 32px（md）/ 48px（lg，regulation 02 §3）、send 32px、消息列 max-w 820（user 600）。hero-orb 80×80 `--brand-grad` + `ChatIcon` 36px 白色；eyebrow mono 11px muted-2；hero-sub 14px muted 400px；CTA h46 primary（黑主按钮 + PlusIcon 16px）；quick-row 3 chip（`--hue-blue/-green/-violet` dot），无 mascot/wave/floaty 动画（INV-3）。详见 。
