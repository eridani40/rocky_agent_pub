## 3. 关键用户路径（MANDATORY = 回归测试最低覆盖契约）

> **本节是本 PRD 的核心。** 这是纯重构版本——没有新功能，唯一验收门槛是「重构后所有现有核心路径行为不回归」。下列路径 = 回归测试的最低覆盖要求：每条路径至少一个 E2E/API case（design-decisions §9：主体 UT + 关键路径 ET，引擎动最核心路径 chat 流式故 ET 值得保）。
> **每条路径标注**：它依赖的**数据形**（list / 单个 / kv / 流式）+ **订阅 topic**，作为下游架构/测试映射依据（哪个 area-hook 承载、哪个 topic 驱动）。
> topic/event 语义权威源：`specs/tech/app/frontend/[P0]sse_channel.md`（`agent_loop` 流式可 replay；`session_panel` 快照不 replay，含 status/usage/summary/messages_cleared/workspace/read；`session_meta` `_all` 广播）。testid 权威源：`specs/ui/components/{chat-page,studio-page}/`。

### 3.1 Playground（chat-page）路径

| 路径 | 操作序列 | 依赖数据形 | 订阅 topic | 承载 hook（重构后） |
|---|---|---|---|---|
| **P1 会话列表加载** | 打开 Playground → 左栏 conv-panel 加载出会话列表（含 unread 红点/title/state） | list（`Collection<Session>`） | `session_meta`(_all) | `usePageChatMount` |
| **P2 新建会话** | 点 `conv-new-btn`（或空态 CTA/mascot） → 建新会话 → 列表出现新行 + 自动选中 | list | `session_meta`(_all) | `usePageChatMount`（reload / meta 推送） |
| **P3 切换会话** | 点另一会话行 → 主区切到该会话 transcript + run 态 + usage | 流式 + 单个 | `agent_loop` + `session_panel` | `useMessages` / `useRunState` / `useUsage` / `useSummary`（切 sid → re-init） |
| **P4 改名会话** | active 会话点 title → 编辑态 → Enter/blur 保存 → 列表显示新 title | list | `session_meta`(_all) | `usePageChatMount`（PUT 后 meta 广播刷新） |
| **P5 删除会话** | 会话行删除操作 → 列表移除该行 | list | `session_meta`(_all) | `usePageChatMount` |
| **P6 发消息→流式文字回复** | 输入消息 → send → user 气泡出现 → agent 左侧气泡流式逐字增长 → run 结束 | 流式（part 级累积） | `agent_loop` | `useMessages`（`applyAgentEventToMessages` 保留自己 reducer，ref-latest 不丢帧） |
| **P7 发消息→工具调用回复** | 发触发工具的消息 → 消息流出现 tool-batch 胶囊 → 点开看 call + 结果 KV | 流式 | `agent_loop` | `useMessages` |
| **P8 run 态切换（running/idle/interrupting）** | run 中 → send 左侧显红色 abort 圆环（running）→ 点 abort → interrupting 减速 → idle | 单个（`Snapshot<SessionStatus>`） | `session_panel`(status_update) | `useRunState`（权威源 = session_panel，非 agent_loop 派生） |
| **P9 usage 更新** | run 结束 → topbar usage 圆环/面板 token 数刷新 | 单个（`Snapshot<SessionUsageView>`） | `session_panel`(usage_update) | `useUsage`（独立 hook，后端直推，不再靠 useMessages 触发） |
| **P10 workspace tab** | 右栏切 workspace tab → 文件树加载；agent 改文件 → 树刷新/stale 标记 | list（tree）+ 消费 store 扇出 | 无（消费 `store.lastWorkspaceEvent`，引擎 `session_panel` workspace_* 转发） | `SectionWorkspacePanel`（✓ 已迁，扇入关系保留） |
| **P11 memory tab** | 右栏切 memory tab → 记忆条目列表加载 → 增/删/改条目 | list（`Collection<MemoryEntry>`） | 无 | `useMemoryCrud`（✓ 已迁，CRUD 后 reload） |
| **P12 cron tab** | 右栏切 cron tab → 定时任务列表加载 → nextFireAt 定时刷新 | list（`Collection<CronJobSummary>`） | 无（`onTick` 60s 兜底） | `SectionCronPanel`（60s poll → `onTick`） |
| **P13 subagent 树展开** | 会话行有 subagent → 点行展开 → running/terminated 分段树 → 点子项进只读页 | kv（`childrenByParent`） | 无（命令式 per-call） | `useSubagentChildren`（✓ 已迁） |

**E2E Use Cases（Playground）**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-P1 | 打开 Playground → 等待左栏会话列表渲染 | 用户看到会话列表（至少 1 行 conv-item）；有未读的行显示红点，重构前后一致 |
| UC-P2 | 打开 Playground → 点 conv-new-btn | 列表新增一行并自动选中，主区进入空态/新会话（无残留旧会话消息） |
| UC-P3 | 有多会话时点击另一会话行 | 主区 transcript 切换为该会话的历史消息，run 态/usage 同步为该会话（不串话、无旧消息残留） |
| UC-P4 | active 会话点 title → 改名 → Enter | 列表该行显示新 title，布局无位移（编辑 input 与 span 同槽位） |
| UC-P6 | 新会话输入「你好」→ send | user 气泡右侧出现；agent 左侧气泡流式逐字增长（不丢字/不覆盖），run 结束气泡完整 |
| UC-P7 | 发一条会触发工具的消息 → send | 消息流出现 tool-batch 胶囊，点开看到 call 参数 + 结果 KV（result 附着到对应 call） |
| UC-P8 | run 进行中观察 send 区 → 点 abort | running 时 send 左侧显红色圆环 abort；点后转 interrupting（减速）→ 最终 idle，abort 消失 |
| UC-P9 | 发消息完整跑完一个 run | topbar usage 圆环/面板 token 数在 run 结束后刷新为新值 |
| UC-P10 | 切 workspace tab → 触发一次 agent 写文件的操作 | 文件树加载出目录；agent 改文件后树反映变化（刷新或 stale 标记） |
| UC-P11 | 切 memory tab → 新增一条记忆 → 保存 | 记忆条目列表出现新条目；删除后列表移除 |
| UC-P12 | 切 cron tab | 定时任务列表加载渲染（有则显 job 卡片，空则空态），无裸 setInterval 报错 |
| UC-P13 | 点有 subagent 的会话行 | 展开 subagent 树（running/terminated 分段）；点子项进入只读页面 |

### 3.2 Studio（studio-page）路径

| 路径 | 操作序列 | 依赖数据形 | 订阅 topic | 承载 hook（重构后） |
|---|---|---|---|---|
| **S1 squad 列表加载** | 打开 Studio → 左栏 sidebar 加载 squad 列表 | list（`Collection<SquadSummary>`） | 无 | `PageStudio`（GET /squad） |
| **S2 squad 懒缓存** | 展开某 squad 行 → 懒加载该 squad detail（成员/charter/预算） | list（detailCache，按 squadId 索引） | 无 | `StudioSidebar`（懒缓存 detailCache → useLifecycle） |
| **S3 群聊流式（SquadChatPage）** | 点群聊节点 → 进群聊 → 发消息 → 流式回复（多成员 a2a 白名单渲染） | 流式 | `agent_loop` + `session_panel` | `SquadChatPage` compose area-hooks（`useMessages` 群聊策略） |
| **S4 单聊流式（MemberChatPage）** | 点 leader/mate 节点 → 进单聊 → 发消息 → 流式回复（a2a→右侧别） | 流式 | `agent_loop` + `session_panel` | `MemberChatPage` compose 同源 area-hooks |
| **S5 board CRUD** | 点 board 节点 → 看板加载 goals/req/tasks → 编辑/新建/归档实体 → 乐观更新 + reload 取真值 | list（`Collection`×3：goals/req/tasks） | 无 | `SquadBoard`（乐观 patch + reload） |
| **S6 budget 展示** | 进 autowork tab → 预算表显示 consumed/limit/remaining → 用量变化时刷新 | 单个（`Snapshot<BudgetUsage>`） | `session_usage_update`（接线目标）/ 次选 `onTick` | `BudgetMeter`（30s poll → SSE 优先，见 §4 开放点） |
| **S7 member panel summary/compact** | 进 member panel memory section → summary 加载 → 点 compact → 完成后 summary 刷新 | 单个（`Snapshot<SummaryResponse>`） | 无 | `MemberPanelMemory`（✓ 已迁，compact 后 reload 命令式） |
| **S8 unread 红点** | 后台 session 完成 → 左栏对应节点出现红点 → 点该节点 → 红点清除 | kv（`Record<sid,bool>`） | `session_meta`(_all) | `useStudioUnreadMeta`（违规独立 SseClient → 单例 + 契约） |

**E2E Use Cases（Studio）**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-S1 | 打开 Studio → 等待左栏 sidebar 渲染 | 用户看到 squad 列表；默认选中第一个 squad |
| UC-S2 | 展开某个 squad 行 | 该 squad 的成员/子节点（board/群聊/leader/mate）加载出现（懒缓存生效，二次展开不重拉） |
| UC-S3 | 进群聊 → 发一条消息 → send | 群聊消息流出现 user 消息 + 成员流式回复；a2a 白名单渲染正确（sender 前缀/侧别不回归） |
| UC-S4 | 进 leader/mate 单聊 → 发一条消息 → send | 单聊流式回复逐字增长；a2a inbox 消息渲染在右侧（sideResolver 不回归） |
| UC-S5 | 进 board → 编辑一个 task（或新建）→ 保存 | 看板实体乐观更新即时反映，reload 后取真值一致；切 active/archive zone 数据正确 |
| UC-S6 | 进 autowork tab → 观察预算表 | 预算表显示 consumed/limit/remaining 数值；用量变化后刷新（SSE 接线或 poll 兜底均可，值正确即可） |
| UC-S7 | 进 member panel memory → 点 compact | compact 触发后 summary 内容刷新（无一次性 setTimeout 残留副作用） |
| UC-S8 | 触发一个后台 session 完成 → 观察左栏节点 → 点该节点 | 完成的 session 节点出现未读红点；点击后红点清除（单例订阅，不再违规 new SseClient） |

### 3.3 跨页共享内核不回归（对话区引擎拆解的隐含契约）

对话区引擎从 monolith 拆成 area-hooks 后，**三页（Playground / 群聊 / 单聊）同源** compose area-hooks。以下共享内核在重构中**不动**，但其与 area-hook 的接线必须不回归（`component_architecture.md §3.3/§3.5`）：

- `ComponentMessageStream`（共享渲染内核，4 策略 hook）：三页复用，数据层零分叉。
- `ComponentRunStateBar` / `ComponentRunStateAbortSlot`（共享 UI 组装层）：引擎字段（loading/enqueue/abort）→ UI，防某消费方漏接（单聊曾漏 enqueue）。
- 拆 area-hook 后，`ComponentRunStateBar` 消费的 `sessionRunning`/`enqueueItems` 来自 `useRunState`；on-message spinner 的 `runActive`/`loadingPhase` 来自 `useMessages`——两层状态分离（`§3.7` session 层 vs run 层）不回归。

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-X1 | Playground 与 Studio 单聊分别发消息 | 两页流式渲染一致（同一 `ComponentMessageStream` 内核）；单聊排队区 enqueue 与 Playground 一致（不漏接） |
| UC-X2 | 单聊 run 中切走再切回 | spinner/run 态恢复（`agent_loop` replay 粘住 + area-hook re-init GET 校正），不卡死、不丢帧 |
