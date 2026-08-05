# v0.0.97 — enqueue 队列重构：纯 API+SSE 驱动 + cancel 转圈 UX + mention pill

> 类型：API 契约新增 + SSE 消费模型重构 + cancel UX 改版
> 范围：item 6 enqueue 重构（item 1-5 已在 dev1 commit 9f8799c5 直接修复，不在本 worktree 范围）
> 权威 req：`reqs/[done] v0.0.97/req.md` §「enqueue 重构范围」+ `reqs/[done] v0.0.97/enqueue-issue.md`
> 前置概念权威源（PRD 已读对齐）：
> - UI：`specs/ui/components/chat-page/_overview.md §4.11a`（enqueue-view 契约）/ `chat-page/_components.md`（component-enqueue-view 视觉基线）/ `chat-page/mention-pill.md`（MentionRender 复用源）
> - tech：`specs/tech/app/frontend/[P0]chat_area_hooks.md §3`（useMessages ctx.enqueueItems + removeEnqueueItem 命令式方法）/ `specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md`（InboxEntry + 三事件生命周期）/ `[P0]agent_event.md §4.3`（message_enqueued/processed/canceled）
> - API：`specs/api/overall/04-agent-session.md §3.1/§3.2/§3.4`（GET messages / POST messages / POST cancel）

## 0. 决策基线（task.json decisions，本 PRD 不推翻）

| # | 决策 | 理由 |
|---|------|------|
| D1 | enqueue view 完全依赖「读取 API（GET /inbox）+ 后续 SSE 更新」，**不依赖 POST 发射结果、不依赖点击 cancel 即时更新** | 多客户端一致性——一个 session 可能多端展示，A 端 POST/cancel 不应让 A 端 UI 抢跑于 SSE 广播 |
| D2 | 新增后端 `GET /session/:id/inbox`：`InboxStore.peek` 过滤 `kind:'message'` → `[{enqueueId, content: ContentBlock[], enqueuedAt}]`（content 形与 `message_enqueued` SSE 事件一致） | 切 session 时无 SSE replay（inbox 不 sticky），靠 GET seed 才能「切到 running session 看到既有队列」 |
| D3 | 前端 `useMessages` onInit GET inbox → `contentBlocksToPreviewText` seed `enqueueItems`（切 session useLifecycle 重订阅→重拉→新 session 队列展示） | 复用 GET /messages 同款 onInit 模式 |
| D4 | 去掉 POST 乐观加项（`handleSend` 不再 `addEnqueueItem`）+ 去掉 cancel 乐观删项（`handleEnqueueCancel` 不再 `removeEnqueueItem`，只 POST cancel） | D1 推论：队列状态只由「GET seed + SSE 增减」驱动 |
| D5 | cancel UX：`component-enqueue-view` 本地 `canceling: Set<enqueueId>`，点 x→转圈（1s 恢复，转圈期禁点）；移项靠 SSE `enqueued_message_canceled`，不进 store | 转圈=本地瞬态反馈（不污染 store）；移项靠 SSE 保证多端一致 |
| D6 | 排队项渲染 mention pill（`toTextPreview`→`MentionRender`） | user 消息含 `<mention/>` tag 时，排队区与对话区应一致渲染为 pill，而非纯文本 tag 串 |
| D7 | POST 返 enqueueId 保留（无害；前端不用于队列状态）；cancel SSE 已存在（agent_loop），无需补后端 | 现有契约向后兼容；后端零改动 |

## 1. 背景

### 1.1 问题

enqueue 队列当前由「POST 乐观加项 + cancel 乐观删项」补足 SSE 时序窗口，但有两个根因性问题：

1. **多客户端不一致**：一个 session 可能多端展示（同账号多 tab / 多端 dashboard）。A 端 POST `enqueue` 立即在 A 端加项 → B 端要等 `message_enqueued` SSE 才看到，A/B 短暂不一致；A 端点 cancel 立即在 A 端移项 → B 端要等 `enqueued_message_canceled` SSE 才同步移除。乐观更新让 UI 状态脱离了「SSE 广播是真相源」的设计意图。
2. **切 session 时队列丢失**：当前 `enqueueItems` 完全靠 SSE `message_enqueued` 累积。切到某个 running session 时，已在其 inbox 中排队的消息没有 SSE replay（inbox 非 sticky），新订阅者从空开始 → 看不到既有队列。这与「切到任何 session 都看到该 session 真实状态」的用户期望违背（与 GET /messages 拉 transcript 一致性原则）。

### 1.2 用户视角痛点（req.md / enqueue-issue.md）

- 「enqueue message 没返回 enqueue id 那取消怎么办」——担心 POST 不返 id 则取消链路不成立。**已澄清**：cancel 走 SSE 事件路线（`enqueued_message_canceled`），前端从 SSE `message_enqueued` / GET /inbox 拿 enqueueId 渲染，POST 是否返 enqueueId 与 cancel 可用性无关（保留作无害兜底）。
- 排队项里 `<mention/>` 显示为纯文本 tag 串，与对话区 pill 视觉不一致——需统一渲染。
- 切到另一个正在 running 的 session 看不到该 session 的排队队列——需 GET /inbox seed。

## 2. 功能需求

### 2.1 GET /session/:id/inbox（后端新增） [P0]

**描述**：新增只读端点，返回 inbox 中当前所有 `kind:'message'` 条目，供前端切 session 时 seed `enqueueItems`。

**用户故事**：作为对话区用户，当我在 session A 正在 running 时切到 session B（B 也在 running 且 inbox 有排队），我应该立刻看到 B 的排队队列，而不是空白的输入框——让多会话切换的体验与 GET /messages 拉 transcript 一致。

**功能交互细节**：

- **路径**：`GET /session/:id/inbox`
- **响应**：`200` + `{ items: InboxItemView[] }`，其中
  ```typescript
  interface InboxItemView {
    enqueueId: string;
    content: ContentBlock[];   // 与 message_enqueued SSE 同形（[P0]agent_event.md §4.3）
    enqueuedAt: string;        // ISO date（InboxEntry.enqueuedAt）
  }
  ```
- **过滤**：仅返 `kind:'message'` 条目；`kind:'cancel'` 条目不暴露（cancel 是 drain 内部信号，非展示内容）。
- **排序**：按 `enqueuedAt` 升序（与 SSE 到达顺序一致；ULID 字典序 = 入队时间序）。
- **快照语义**：调 `InboxStore.peek(sessionId)` 拿当前快照（不清空、不锁；drain 与 peek 并行无副作用——peek 是只读视图）。

**约束**：

- **无副作用**：纯读，不发事件、不改 inbox 状态、不触发 drain（drain 仍由 agent_loop eager 调度）。
- **content 形对齐 SSE**：`content: ContentBlock[]` 字段必须与 `message_enqueued` 事件 payload 的 `content` 字段完全同形——前端走同一 reducer 入口 `contentBlocksToPreviewText` 处理，不出现 GET vs SSE 两套处理路径。
- **与 GET /messages 边界**：GET /messages 返已落库 transcript（ULID messageId），GET /inbox 返未落库 inbox 句柄（enqueueId，尚未生成 messageId）；两者正交，不重叠。
- **错误**：`404` session 不存在。

### 2.2 useMessages onInit GET /inbox seed enqueueItems [P0]

**描述**：`useMessages` area-hook onInit 在 GET /messages 之后追加 GET /inbox，把响应 seed 进 ctx.enqueueItems（经 `contentBlocksToPreviewText` 把 ContentBlock[] 转预览文本）。

**用户故事**：作为切到 running session 的用户，我应该看到该 session 当前 inbox 中的排队消息（哪怕我刚刚才切过去，没订阅过它的 SSE），跟拉历史 transcript 一样自然。

**功能交互细节**：

- **onInit 顺序**（`chat_area_hooks.md §3` useMessages）：
  1. `GET /messages?limit=50`（既有，拉 transcript 基线）
  2. `GET /inbox`（**新增**，拉 inbox 当前快照）
  3. `subscribe('agent_loop', 'session_id:<sid>_amt:current')` + `subscribe('session_panel', 'session_id:<sid>')`（既有）
  4. 返回 `{ ctx: { ...initialCtx, enqueueItems: inboxItems }, buffer: { runCtx: null } }`
- **content → preview**：复用既有 `contentBlocksToPreviewText(content: ContentBlock[]): string` 工具（前端已存在，将 ContentBlock[] 拍平为预览字符串，含 `<mention/>` tag 的原始形式）。seed 时调一次，把返回字符串塞进 `EnqueueItem.content`（类型仍为 string，与现有 reducer 契约对齐）。
- **幂等**：后续 SSE `message_enqueued` 到达时 reducer 已有 `some(enqueueId)` 去重（`chat-slice-reducer.ts:336` 既有），GET seed 的条目与 SSE 增量不会双计。
- **切 session 行为**：useLifecycle deps 变（sessionId 变）→ onDestroy 旧订阅 → onInit 重走 GET /messages + GET /inbox + subscribe → 新 session 的 enqueueItems 从该 session 的 inbox 快照重新 seed（不残留旧 session 的）。

**约束**：

- **GET /inbox 失败不阻塞**：GET /messages 成功但 GET /inbox 失败时，enqueueItems seed 为空数组（不抛错阻塞整个 hook init），后续 SSE `message_enqueued` 仍可正常加项（降级体验，不破坏主对话流）。
- **enqueuedAt 暂不入 EnqueueItem**：`EnqueueItem` 形状保持 `{ enqueueId, content }`（不扩 `enqueuedAt`），与现有 reducer 契约一致；排序由 GET 响应保证、SSE 到达顺序天然升序。如 arch 决定扩字段（用于 UI 显示入队时刻），见开放点 O3。

### 2.3 去除 POST 乐观加项 + cancel 乐观删项 [P0]

**描述**：前端不再用 POST 发射结果或 cancel 点击即时更新 `enqueueItems`——队列状态只由「GET seed + SSE 增减」驱动。

**用户故事**：作为多端用户（同账号在两个 tab 打开同一 session），当我在 A 端发消息或点取消，B 端应该和 A 端**同一时刻**看到队列变化（都靠 SSE 广播），而不是 A 端抢跑、B 端滞后。

**功能交互细节**：

- **POST `/messages` 后**：`page-chat.handleSend` / `section-member-chat.handleSend` **不再**调 `addEnqueueItem(enqueueId, content)`。POST 响应 `{ runId, enqueueId }` 仅用于：① 关联 SSE run（既有用法）；② 兜底日志/debug（不进 UI state）。队列加项**只**由 SSE `message_enqueued` 驱动（reducer 既有逻辑）。
- **cancel 点击后**：`page-chat.handleEnqueueCancel` / `section-member-chat.handleEnqueueCancel` **不再**调 `removeEnqueueItem(enqueueId)`。仅 POST `/session/:id/messages/:enqueueId/cancel`（fire-and-forget）。队列移项**只**由 SSE `enqueued_message_canceled` / `enqueued_message_processed` 驱动（reducer 既有按 enqueueId 移除逻辑）。
- **本地 canceling Set**（仅 cancel 反馈用，不进 store）：见 §2.4。
- **死代码清理**（req.md item 8）：`useMessages` 的 `addEnqueueItem` 命令式方法（无 caller 后删）+ `removeEnqueueItem` 命令式方法（无 caller 后删）+ `ComponentEnqueueView` 的 `onRemove` prop（从未传过，删）。

**约束**：

- **POST 响应契约不变**：仍返 `{ runId, enqueueId }`（v0.0.13 契约保留，向后兼容；前端不读 enqueueId 用于 UI 状态）。
- **SSE 事件契约不变**：`message_enqueued` / `enqueued_message_processed` / `enqueued_message_canceled` 三事件继续按 `[P0]agent_event.md §4.3` 工作。
- **时序窗口接受**：POST 发送 → SSE `message_enqueued` 到达之间（ms 级），UI 短暂不显示该排队项。理由：(1) 多客户端一致性优先于单端跟手；(2) 窗口极短（同机 SSE ms 延迟）；(3) session idle 时 enqueue→activate→drain→`message_start` 很快，排队项根本不显示（`[P0]agent_event.md §4.3` 修正缘由已说明 idle 时短暂入容器）。

### 2.4 cancel UX：x → 转圈（本地 canceling Set） [P0]

**描述**：用户点排队项的 x 按钮后，x 立即转圈（spinner）作为本地反馈，1s 后恢复 x（可重试）；队列移项靠 SSE `enqueued_message_canceled`，**不**靠点击事件。

**用户故事**：作为点了取消的用户，我需要立刻知道「我点了」（否则以为没点上再点一次 → 重复 POST）；至于队列项什么时候消失，靠后端 SSE 告诉我（ms 级，跟手）。

**功能交互细节**：

- **本地状态**（`component-enqueue-view.tsx` 内 useState）：
  ```typescript
  const [canceling, setCanceling] = useState<Set<string>>(new Set());
  // enqueueId ∈ canceling → 该项的 x 按钮显示 spinner（非 x icon）
  ```
- **点击 x 行为**：
  1. 若 `canceling.has(enqueueId)` → 忽略（转圈期禁点，防重复 POST）。
  2. 否则：`setCanceling(prev => new Set(prev).add(enqueueId))` + 调 `onCancel(enqueueId)`（父组件 POST cancel，fire-and-forget）+ `setTimeout(() => setCanceling(prev => { const next = new Set(prev); next.delete(enqueueId); return next; }), 1000)`。
- **SSE 移项优先于 1s 超时**：若 SSE `enqueued_message_canceled` 在 1s 内到达 → reducer 移除该 EnqueueItem → 该行 unmount → canceling 中的 enqueueId 随 unmount 丢弃（component-enqueue-view 仍在，但该项已不存在，canceling 中残留条目不影响渲染）。
- **1s 内 SSE 未到**：超时回 x（用户可重试点 → 重新进 canceling + 再次 POST；后端 cancel 端点幂等，重复 POST 无副作用，见 `04-agent-session.md §3.4`）。
- **布局稳定性（MANDATORY）**：x 按钮与 spinner 按钮占同一排版槽位（22×22 rounded-md，视觉基线 `_components.md` 已定），出现消失不导致相邻元素位移。用 `visibility`/`opacity` 切换或同尺寸 SVG icon 切换，禁 `display:none` 入常规流。

**约束**：

- **canceling Set 不进 store / 不进 ctx**：纯本地瞬态反馈（`component-enqueue-view` 的 useState），与 `enqueueItems`（store 渲染态）解耦。
- **POST cancel 失败不回滚 canceling**：fire-and-forget，POST 失败用户能在 1s 后重试（重试点 → 再 POST）；不增加复杂度去监听 POST 成败。
- **x 与 spinner 视觉**：x = `X` icon（12px，`_components.md` 已定 `.queue-remove`）；spinner = `Loader2` 或同款旋转 icon（12px，accent 色，`animate-spin`），与 abort-btn 圆环视觉风格接近（区分于 queue-expand chevron）。

### 2.5 排队项渲染 mention pill [P0]

**描述**：`component-enqueue-view` 渲染 `EnqueueItem.content`（string）时，从纯文本预览升级为「mention pill + 纯文本」混合渲染——解析 `<mention ... />` tag → 替换为 `<MentionRender>`（消息区 pill，复用 `component-mention-render.tsx`）。

**用户故事**：作为在排队消息里 @ 了某文件/skill 的用户，我希望排队项显示真实的 @ pill（与对话区一致），而不是看到一串 `<mention type="file" ... />` 原始 tag 文本。

**功能交互细节**：

- **当前现状**：`EnqueueItem.content: string` = `contentBlocksToPreviewText(ContentBlock[])` 拍平结果，含 `<mention ... />` tag 的字符串形式（`message-content.md` 定义）。`component-enqueue-view.toTextPreview(content)` 当前直接渲染该字符串。
- **改造**：`toTextPreview(content)` → `<MentionRender text={content} />`（`component-mention-render.tsx` 已存在，专为解析字符串中的 `<mention/>` tag 并渲染 pill + 混合纯文本设计，消息区已用）。
- **数据契约不变**：`EnqueueItem.content: string` 保持（不扩为 ContentBlock[]；`contentBlocksToPreviewText` 在 useMessages onInit seed + SSE reducer 入口调用，已统一为 string）。
- **降级**：content 中无 `<mention/>` tag → `MentionRender` 渲染为纯文本（既有行为，零回归）。

**约束**：

- **复用而非新写**：`MentionRender` 已在 `mention-pill.md §复用关系` 列为「消息区 pill」组件，本版本扩展其复用范围到排队区，不新建组件。
- **视觉一致**：排队区 pill 与消息区 pill 视觉完全一致（同 `MentionPill` 底层 + 同 Glyph registry），用户感知不到差异。

## 3. 关键用户路径（MANDATORY — 测试最低覆盖要求）

> 每条路径 = 至少一个 AT/ET case 覆盖。testid 契约从 `specs/ui/components/chat-page/_overview.md §7` + `_components.md` 读（不扒代码）。

### 3.1 路径清单

| ID | 路径 | 关键断言（落在用户价值） | 类型 |
|----|------|--------------------------|------|
| **P1** | 发消息 → 排队项出现（GET inbox seed 或 SSE message_enqueued）→ 后端处理 → processed 移项 → 进对话区 | 排队项按 enqueueId 渲染；processed 后从排队区消失、对话区出现对应 messageId 用户气泡；GET /inbox 在切会话 seed 时返该项 | AT + ET |
| **P2** | 排队中点 cancel → x 转圈 → SSE enqueued_message_canceled → 移项（1s 内没 SSE 则回 x 可重试） | x 点击后立即转圈（不重复点击）；SSE 到达后该项消失；1s 内 SSE 未到回 x 可重试点；后端 cancel POST 幂等 | AT + ET |
| **P3** | 切换到另一个 session → 该 session 既有排队队列展示（onInit GET /inbox） | 切到 running session 立刻看到其 inbox 中所有排队项；切回原 session 看到原 session 队列（不残留） | AT + ET |
| **P4** | 排队项含 `<mention/>` → 渲染 mention pill（不是纯文本 tag 串） | 排队项内容区出现 `mention-pill` 节点（DOM 断言）+ 视觉与消息区 pill 一致；无 mention 时降级纯文本 | ET |
| **P5** | 多端一致性——A 端 cancel，B 端靠 SSE 同步移项（不依赖 A 的 cancel API 返回） | A 端点 cancel 后 A 端转圈，B 端未点 cancel 但收到 `enqueued_message_canceled` 后该项消失；A/B 视觉最终一致 | AT（多订阅者 SSE 广播） |

### 3.2 不覆盖项（明确排除 + 理由）

| 排除项 | 理由 |
|--------|------|
| POST `/messages` 响应 `enqueueId` 字段移除 | D7 保留（无害）；只在前端代码层不再用于 UI 状态，契约不变 |
| cancel SSE 后端补发（agent_loop） | D7 已核实：`enqueued_message_canceled` 由 `agentManager.cancel` 在 `removeMessage` 成功时 emit（agent_loop topic），无需补后端 |
| inbox sticky replay（让 SSE 自动回放既有队列） | 改动大（inbox 当前 non-sticky by design，drain 一次性清空），GET /inbox 已满足 seed 需求；YAGNI |
| 群聊（SquadChatPage）enqueue 队列 | 群聊不订 run 态、不显示 enqueue view（`chat_area_hooks.md §5` 表「SquadChatPage」行明示）；本版本范围仅 playground + studio 单聊 |
| subagent readOnly 页 enqueue | readOnly mode 隐藏 input-bar + enqueue-view（`_overview.md §4.3 readOnly mode`），无 enqueue 场景 |
| POST `/messages` 响应时序优化（消除「POST → SSE ms 级窗口」） | 接受此窗口（D1 多端一致性优先）；不在本版本优化 |
| 视觉保真度 compare | 本版本无设计稿（沿用 v0.0.12 既有 `.input-queue` 视觉契约，仅 cancel icon→spinner 一处变化，无需 compare） |

### 3.3 E2E Use Cases（每路径至少一 case，MANDATORY）

| ID | 用户操作链路 | 预期结果 |
|----|--------------|----------|
| UC-P1 | session running 中 → 输入消息 A 回车 → 等 SSE `message_enqueued` → 等 processed | 排队区出现 `enqueue-item-{enqueueIdA}` → 后消失 → 对话区出现 `msg-user-{messageIdA}` |
| UC-P2 | session running 中 → 排队项 A 的 `enqueue-item-{enqueueIdA}-cancel` 被点 → 等待 1s 内 SSE | x 立即转圈（DOM 断言无重复点击）→ SSE 到达 → 排队项 unmount；对话区不出现 A 的用户气泡 |
| UC-P2b | UC-P2 但 mock SSE 延迟 >1s | 1s 后 spinner 回 x → 用户可再次点击 → 第二次 POST cancel 幂等无副作用 |
| UC-P3 | session A running 有 2 条排队 → 切到 session B（B 有 3 条排队）→ 等待 onInit GET /inbox | session A 排队项消失；session B 排队区显示 3 项；切回 A 显示 A 的 2 项（GET /inbox 重拉） |
| UC-P4 | 在输入框 @ 一个 file 提交（含 `<mention type="file" .../>` tag）→ 等 SSE `message_enqueued` → 看排队项 | 排队项内容区出现 `mention-pill` DOM 节点（非纯文本 tag 串） |
| UC-P5 | 模拟两端订阅同 session（两条 SSE connection / 两个 subId）→ 一端发 cancel POST → 两端 SSE 都收到 `enqueued_message_canceled` | 两端排队项都消失；未点 cancel 的一端不依赖另一端的 POST 返回，纯靠 SSE |

## 4. 设计约束 / 不变量（MANDATORY）

| ID | 不变量 | 落实点 |
|----|--------|--------|
| **INV-1** | enqueue view 队列状态唯一真相源 = GET /inbox（seed）+ SSE `message_enqueued`/`processed`/`canceled`（增量） | useMessages onInit GET /inbox；reducer 只认 SSE 三事件加/减项；POST/cancel API 不进 reducer |
| **INV-2** | content 形 GET /inbox 与 SSE `message_enqueued` 完全一致（ContentBlock[]） | 后端 GET /inbox 直接返 `InboxEntry.message.content`（与 emit `message_enqueued` 同源）；前端走同一 `contentBlocksToPreviewText` 入口 |
| **INV-3** | `canceling: Set<enqueueId>` 是 component-enqueue-view 本地瞬态，**不进 store / 不进 ctx / 不进 URL** | useState 局部；卸载即丢；不影响 SSE reducer |
| **INV-4** | x 与 spinner 占同一排版槽位（22×22），切换不导致相邻元素位移 | 同尺寸 SVG icon 切换；禁 `display:none` 入常规流 |
| **INV-5** | 多端一致性：A 端的 POST/cancel 操作不应让 A 端 UI 状态抢跑于 SSE 广播 | POST 响应/ cancel 响应不进 reducer；reducer 只认 SSE |
| **INV-6** | POST `/messages` 响应 `{ runId, enqueueId }` 契约不变（向后兼容） | API spec §3.2 不动；前端只是不再读 enqueueId 用于 UI |
| **INV-7** | cancel POST 幂等：重复 POST 同 enqueueId 无副作用 | 后端既有（`04-agent-session.md §3.4`）；前端 1s 超时后允许重试点 |

## 5. 契约变更面

### 5.1 API 契约（新增）

- **新增** `GET /session/:id/inbox`（`specs/api/overall/04-agent-session.md` 新增 §3.5）：
  - 响应 `{ items: InboxItemView[] }`，`InboxItemView = { enqueueId, content: ContentBlock[], enqueuedAt }`
  - 过滤 `kind:'message'`；按 `enqueuedAt` 升序；只读无副作用
- **不变**：`GET /messages` / `POST /messages`（含响应 `{runId, enqueueId}`）/ `POST /messages/:enqueueId/cancel` / SSE 三事件

### 5.2 数据契约

- **不变**：`Message` / `ContentBlock` / `InboxEntry` / `EnqueueItem`（前端 ctx 形，仍 `{enqueueId, content: string}`）
- **新增**：`InboxItemView`（HTTP 响应形，与 SSE `message_enqueued` payload 字段集对齐——仅缺 `type`/`source`/`role` event 元字段，content 字段完全同形）

### 5.3 UI testid 契约

- **不变**：`enqueue-view` / `enqueue-item-{enqueueId}` / `enqueue-item-{enqueueId}-content` / `enqueue-item-{enqueueId}-cancel`
- **cancel 按钮内容切换**：x icon ↔ spinner icon 在同一 testid 节点内（不加新 testid；ET 断言「转圈态」走 DOM 子结构或 vision check，不强制新 testid）

### 5.4 UI 组件契约（spec delta，arch 阶段落）

- `component-enqueue-view` Props：删 `onRemove?`（死代码，从未传）；显式化 `onCancel`（唯一交互回调）；新增内部 `canceling: Set<enqueueId>` 状态（不暴露为 prop）
- `toTextPreview` 渲染：从纯文本 → `<MentionRender text={content} />`

## 6. 回归面（不能回归的既有行为）

| 既有行为 | 验证方式 |
|---------|---------|
| playground（page-chat）发消息 → 排队项出现/消失 → 进对话区（session running 时排队） | ET-P1 + 现有 playground enqueue ET case |
| studio 单聊（MemberChatPage）enqueue 排队区显示（v0.0.39 接入） | ET 现有 studio 单聊 ET case |
| cancel 排队消息 → 后端不落库、不进对话流（`agent_inbox_enqueue.md §6.3`） | AT-K（既有 enqueue cancel AT）+ ET-P2 |
| session idle 时发消息 → 立即 activate → 不进排队区（`agent_event.md §4.3` 修正缘由） | ET 现有 idle send ET case |
| 切 session 时 useMessages onDestroy/onInit 正确重置（不残留旧 session 状态） | ET-P3 + 现有切 session ET case |
| 排队项 `<mention/>` tag 在对话区 message 渲染为 pill（消息区既有） | ET 现有 mention ET case（仅验证排队区新接入不破坏消息区） |
| POST `/messages` 响应 `{runId, enqueueId}` 契约（向后兼容） | AT 既有 POST /messages schema case |
| SSE 三事件（message_enqueued / processed / canceled）schema 不变 | AT 既有 SSE schema case |

## 7. spec 对齐核对（MANDATORY — 概念 spec delta 清单）

PRD 引用的组件/接口/概念与已有 `specs/ui/` + `specs/tech/` 对照——以下 delta 由 architect 阶段落（PRD 不擅自发明概念）：

### 7.1 需新增的概念 spec（arch 阶段落）

| 层 | 文件 | 新增/修改 | 内容 |
|----|------|-----------|------|
| **api** | `specs/api/overall/04-agent-session.md` | **新增 §3.5** | `GET /session/:id/inbox` 端点（路径/响应 InboxItemView/过滤/排序/错误码） |
| **tech** | `specs/tech/app/frontend/[P0]chat_area_hooks.md §3` | **修改 useMessages onInit** | 在 GET /messages 之后追加 GET /inbox seed enqueueItems（contentBlocksToPreviewText 入口）；删 `addEnqueueItem` / `removeEnqueueItem` 命令式方法（dead code） |
| **tech** | `specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md` | **新增 §10 前端只读 API** | 引用 GET /session/:id/inbox 端点（与 SSE 三事件配合：GET seed + SSE 增量），对齐「enqueue view 队列状态真相源 = GET + SSE」 |
| **ui** | `specs/ui/components/chat-page/_overview.md §4.11a` | **修改 cancel 行为段** | 从「UI 立即乐观移除该项 + 重排」改为「x → 转圈（本地 canceling Set，1s 恢复，禁点）+ 移项靠 SSE `enqueued_message_canceled`」；显式化「不进 store」 |
| **ui** | `specs/ui/components/chat-page/_overview.md §4.11a` | **修改 Props** | 删 `onRemove?`；`onCancel` 为唯一交互回调（保留） |
| **ui** | `specs/ui/components/chat-page/_overview.md §4.11a` | **修改 toTextPreview** | 渲染从纯文本升级为 `<MentionRender text={content} />`（解析 `<mention/>` tag → pill） |
| **ui** | `specs/ui/components/chat-page/_components.md` | **同步** component-enqueue-view 视觉基线 | cancel icon → spinner icon 切换规则；22×22 同槽位（视觉基线已定，仅描述层补充「转圈态」） |
| **ui** | `specs/ui/components/studio-page/member-chat-page.md` | **同步 enqueue 行为** | handleEnqueueCancel 不再调 removeEnqueueItem，仅 POST cancel（与 playground 一致） |

### 7.2 发现的 spec↔设计决策不一致（需 doc-modifier 阶段 5 同步）

| 不一致点 | 现状 spec | 本版设计 | 处置 |
|---------|-----------|---------|------|
| cancel UX | `_overview.md §4.11a` 说「UI 立即按 enqueueId 乐观移除该项 + 重排」 | 改为 x→转圈 + SSE 移项 | doc-modifier 阶段 5 改 spec（本 PRD §2.4 即为新契约） |
| useMessages 命令式方法 | `chat_area_hooks.md §3` 列 `removeEnqueueItem(id)` 命令式方法（乐观移除） | 删除（D4 + dead code） | doc-modifier 阶段 5 改 spec |
| `_components.md` enqueue-view Props | 列 `onRemove?` 但备注「从未传」 | 显式删 | doc-modifier 阶段 5 改 spec |
| `chat_area_hooks.md §3` useMessages onInit | 仅 GET /messages | 追加 GET /inbox | arch 阶段落 delta + doc-modifier 阶段 5 改 spec |
| 排队项 mention 渲染 | `_components.md`/`_overview.md` 描述 `queue-text` 为纯文本（Inter 12.5px） | 改为 `<MentionRender>` 解析（mention 部分变 pill，文本部分仍 Inter 12.5px） | doc-modifier 阶段 5 改 spec |

## 8. 开放点（arch 拍板）

| ID | 开放点 | 备注 |
|----|-------|------|
| **O1** | `InboxStore.peek` 实现细节（内存拷贝 / 视图迭代器 / freeze） | arch 定；PRD 只约束「只读快照、不清空、不锁」 |
| **O2** | `contentBlocksToPreviewText` 是否需重构（当前可能不处理 mention tag 的字符串形式） | coder 检查现有实现；若已支持 → 零改动；若不支持 → 扩展或改用 `MentionRender` 直接接 ContentBlock[] |
| **O3** | `EnqueueItem` 是否扩 `enqueuedAt` 字段（用于 UI 显示入队时刻） | 当前不扩（YAGNI）；如 arch 决定显示「3 秒前」之类时间标签则扩 |
| **O4** | `canceling` Set 1s 超时值是否可调（用户感知 / a11y） | 1s 是初值；如用户反馈太快/太慢可调；spec 不预设最终值 |
| **O5** | POST `/messages` → SSE `message_enqueued` ms 级窗口是否需 loading state（input 区域「发送中…」反馈） | 当前接受窗口（D1）；若用户反馈「点了没反应」再优化；不在本版本范围 |
| **O6** | cancel POST 失败时是否回滚 canceling Set（让用户立即重试） | 当前不回滚（1s 后自动回 x）；fire-and-forget 简单；如 arch 决定监听 POST 成败再定 |
| **O7** | `InboxItemView` 是否暴露 `source` / `role` 字段（与 SSE event payload 完全对齐） | 当前不暴露（user 场景单一）；若未来支持 a2a message 入队展示则扩 |

## 9. 验收标准

- §3.1 路径 P1-P5 各有 AT/ET case 全 pass
- §6 回归面所有项不回归（既有 AT/ET 不挂）
- §7.2 spec 不一致全部由 doc-modifier 阶段 5 同步
- 本文档 §2 五个功能点全部实现 + 通过 code review
