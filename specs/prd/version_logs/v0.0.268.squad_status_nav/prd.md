# v0.0.268 PRD — Squad 成员状态导航

> 版本目录：`specs/prd/version_logs/v0.0.268.squad_status_nav/`
> 需求来源：`reqs/[working] v0.0.268/req.md`
> PRD 边界：产品可感知行为（squad 会话页顶部导航成员状态入口）；实现细节归架构 change_plan

## 1. 背景

### 1.1 现状问题

Studio 中，成员状态（running/idle、presence 工作标记）目前只在 **squad 首页（seats 面板）** 可见：用户进入某个成员/群聊的会话落地页后，看不到 squad 其他成员的实时状态——需要返回首页才能看。

### 1.2 目标

在 **squad 会话页（单聊/群聊落地页）顶部导航** 增加一个常驻的成员状态入口：

- 入口 = squad 图标 + badge（当前 running 成员数，**含 leader**）
- badge 数字随 SSE 实时刷新（running/idle 变化即时更新）
- 点击展开成员状态面板：running 上 / idle 下分区，展示 presence 工作标记，hover 成员行出现「进入对话」icon
- 两级导航语义：squad 首页（成员面板 + 会话列表）↔ 会话落地页；**从任何会话返回永远回 squad 首页**（不逐级回退）

### 1.3 范围

纯前端 Studio 改动（studio 会话页 + 面板 UI + SSE 订阅复用），**无后端 API 变更**——成员状态数据源复用现有 `session_meta _all` SSE 广播（stateMap）与 squad detail（members/currentWork）。

## 2. 核心产品决策（代决）

| # | 决策 | 理由 |
|---|------|------|
| D1 | **入口挂载位置 = 会话页 topbar 左侧**（返回键旁、身份 header 前）：`SectionStudioChat` 的 topbarLeft render-prop 内、身份 header 之前插入 squad 状态入口组件 | 会话落地页顶部导航 = chat topbar；单聊/群聊两形态都显示（squad 上下文一致） |
| D2 | **badge 数字 = running 成员数（含 leader）**：`stateMap[sessionId] ∈ {running, interrupting}` 计为 running；**suspended 不计**（与 seats 面板 isRunning 口径一致，INV-2） | 与现有 `isRunningState` 语义对齐（suspended = loop 已退出等用户回填，不亮 spinner） |
| D3 | **badge 实时性 = SSE 驱动**：复用 `useStudioUnreadMeta` 已订阅的 `session_meta _all` 广播（stateMap），running 变化 → badge 数字即时刷新；**不新增订阅、不新建 topic** | 现有机制已覆盖 studio 全部 session 状态，避免重复订阅/新后端推送 |
| D4 | **面板分区**：running 上 / idle 下；idle = deployed 成员中非 running 者（含 suspended）；**benched 不显示**（非在岗） | 对齐 seats 面板「active 视图只显 deployed」口径 |
| D5 | **presence 文字 = detail 快照**（非 SSE 实时）：面板打开时展示 `member.currentWork.text`，优先；空则 i18n fallback（`studio:seats.status.*`）。presence 文字更新依赖 squad detail 刷新（进入面板时/返回首页时），**不在本版本新增 presence SSE topic** | presence tool 写 currentWork 无 SSE 推送；新增后端推送超出纯前端范围，PRD 边界内不做 |
| D6 | **面板进入对话**：hover 成员行出现「进入对话」icon（无文字），点击 → 切到该成员会话落地页（复用 ChatNode + `studio.member.open-chat` actionKey 语义）；**进入后返回键恒回 squad 首页**（复用 page-studio 现有 onBack） | 两级导航固化：任何会话返回都回首页，不从 chat B 回 chat A |
| D7 | **squad 图标点击 = 展开面板**（单一交互）；返回首页靠现有返回键/首页导航，不在图标上叠加「点击回首页」 | 需求要点 1「导航图标」= 状态入口定位；要点 3「点击展开面板」= 交互；避免双语义混淆 |

## 3. 功能需求

### 3.1 入口：squad 图标 + running badge（顶部导航常驻）

- **位置**：squad 会话页（单聊 + 群聊）topbar 左侧，返回键与身份 header 之间（紧邻返回键右侧）。
- **形态**：`Icon name="squad"`（Studio 图标集已有）+ 右上角 badge 数字。
- **badge 数字**：当前 squad **running 成员数（含 leader）**；0 时不显示数字（仅图标）或显示灰色 0（实现定，视觉不突兀）。
- **布局稳定（MANDATORY）**：badge 出现/消失（0↔非 0）不得导致图标/相邻元素位移——用绝对定位叠加，不占文档流。
- **可访问性**：button 语义 + `aria-label`（如「成员状态，N 个运行中」）+ 键盘可点。

### 3.2 badge 实时更新（SSE）

- 数据源：`useStudioUnreadMeta()` 的 `stateMap`（已订阅 `session_meta _all`，biz='studio' 反向守卫）。
- 数字 = 遍历 `detail.members`（deployed）的 sessionId，`stateMap[sid] ∈ {running, interrupting}` 计数，**含 leader**。
- 成员 session 变化（running ↔ idle）→ SSE 推 `session_meta` → stateMap 更新 → badge 数字即时刷新（无用户操作）。
- **注意订阅粒度**：入口组件只订阅/读取 stateMap 的 squad 成员 sessionId 子集；状态变化不应引发 chat 页其他区域 re-render（selector 精化，架构期定）。

### 3.3 点击展开成员状态面板

- 点击入口图标 → 展开面板（弹层，absolute/fixed 定位，不占文档流；点击外部/Esc 关闭）。
- **面板布局**：
  - **上区「running」**：running 成员行（含 leader），行内 = 头像 + 名字 + role 标识 + presence 文字（`currentWork.text`，空则 i18n fallback「运行中」）。
  - **下区「idle」**：idle 成员行（deployed 非 running），presence 文字同理（空则 fallback「在线/空闲」）。
  - 分区标题（running / idle）+ 各行展示；无成员时不显示该区（或显示空态文案，实现定）。
- **hover 进入对话 icon**：每行 hover 时右侧出现「进入对话」icon（`Icon name="chat"`，无文字），点击进入该成员会话。
- **presence 文字语义**：与 seats 面板 `deriveStatusTextSource` 同源（`currentWork.text` 优先，空 → i18n fallback）；本版本不做 presence 文字 SSE 实时（D5），打开面板时刷新 detail 即可（见 3.4）。
- **视觉区分**：running 行与 idle 行有分区标题 + 弱分隔；presence 文字单行 truncate；样式轻量（不遮挡消息区核心内容）。

### 3.4 数据可得性与刷新

- 面板数据 = `detail.members`（SquadDetail 全字段：name/sessionId/role/state/currentWork）+ `stateMap`（SSE 实时）。
- **数据注入**：page-studio 持有 detail + stateMap + onEnterChat 回调，经 StudioChatRouter → SectionStudioChat → 入口组件下传（detail 缺省时面板显示 loading/空态，不阻塞会话页渲染）。
- **打开面板时刷新 presence**：进入面板触发一次 `reloadDetail`（page-studio 已有方法），确保 currentWork 文字尽量新（fire-and-forget，失败不阻塞面板展示旧快照）。

### 3.5 两级导航固化

- 第一级 = squad 首页（SeatsPanel：成员面板 + 会话列表）；第二级 = 会话落地页（StudioChatRouter）。
- 从面板进入成员对话 = `setMainView({kind:'chat', node})`（切 chat 节点）。
- **返回永远回首页**：任何会话（含面板进入的）返回键 → `setMainView({kind:'seats', squadId})`（page-studio 现有 onBack 已实现，本版本固化：面板进入的对话复用同一 onBack，不引入「回上一会话」语义）。

## 4. 关键用户路径（MANDATORY）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 进入 squad 首页 → 点某成员坐席卡「进入对话」→ 会话落地页 topbar 左侧看到 squad 图标 + running badge 数字 | 入口常驻可见；badge 显示当前 running 成员数（含 leader） |
| UC-2 | 在会话落地页，另一成员开始运行（SSE 推 running）→ badge 数字 +1；运行结束 → 数字 -1 | badge 数字实时刷新，无需刷新页面 |
| UC-3 | 在会话落地页点 squad 图标 → 弹出成员状态面板 | 面板显示：上区 running 成员（presence 文字），下区 idle 成员 |
| UC-4 | 面板中某 running 成员 presence 显示「正在写 PRD」，hover 该行 → 出现进入对话 icon（无文字）→ 点击 | 进入该成员会话落地页；面板关闭 |
| UC-5 | 从面板进入的会话点返回键 | 直接回到 squad 首页（不回到之前看的会话） |
| UC-6 | 点面板外区域 / 按 Esc | 面板关闭，会话页正常使用 |
| UC-7 | 进入 squad 群聊落地页 | 同样看到 squad 图标 + badge + 可展开面板（群聊形态也生效） |
| UC-8 | 所有成员 idle（0 running）→ badge 不显示数字（仅图标） | 入口不突兀；打开面板显示全 idle 列表 |

## 5. 概念对齐 + 新概念

### 概念对齐（复用现有）

| 概念 | 出处 | 复用方式 |
|------|------|---------|
| SSE 订阅（topic/group） | `specs/tech/app/frontend/[P0]sse_client_singleton.md` + `[P0]sse_channel.md` | 复用 `useStudioUnreadMeta` 已订阅的 `session_meta _all`（biz='studio'），不新增订阅 |
| SessionState 六态 + isRunning 口径 | `use-studio-unread-meta.ts` / `use-seats-data.ts`（`isRunningState`：running/interrupting，排除 suspended） | badge 数字 + 分区判定复用同口径 |
| presence 三态派生 + statusText 来源 | `use-seats-data.ts`（`derivePresence` / `deriveStatusTextSource`） | 面板行展示复用派生逻辑（currentWork.text 优先，i18n fallback） |
| ChatNode（sessionId/title/tag/squadId） | `chat-node.ts`（page-studio ↔ chat 路由 ↔ 坐席入口共享） | 面板进入对话组装复用（与 SeatsPanel.buildMemberChatNode 同源） |
| `studio.member.open-chat` actionKey | `component-seat-card.tsx` | 面板 hover icon 复用同 actionKey |
| Icon `squad` / `chat` | `studio-icons.tsx` | 入口图标 + hover 进入对话 icon |
| 两级导航（seats 首页 ↔ chat 落地页） | `page-studio.tsx` mainView 状态机 + onBack | 固化「返回恒回首页」 |

### 新概念

| 概念 | 说明 | 需落 spec |
|------|------|----------|
| **squad 状态入口组件**（新） | `component-squad-status-entry`（或类似命名）：图标 + running badge + 展开面板，挂在 SectionStudioChat topbarLeft | `specs/ui/components/studio-page/component-squad-status-entry.md` |
| **成员状态面板**（新，入口组件内） | running 上 / idle 下分区列表 + hover 进入对话 icon | 同上（可同文件两小节） |

## 6. 边界 / 不做

- **不做 presence SSE 实时推送**：presence 文字 = detail 快照 + 打开面板时刷新；不新增后端 topic/事件（超纯前端范围）。
- **不做 badge 之外的未读/消息数**：badge 只表示 running 成员数（需求明确），不叠加红点/未读。
- **不做面板内直接操作**（bench/deploy/编辑成员）：面板只做状态展示 + 进入对话；成员管理入口仍在首页坐席卡菜单。
- **不做跨 squad**：入口只显示当前 squad 成员（当前 chat 节点所属 squad）。
- **不做 mobile/窄屏重排**：入口在 topbar 固定位置，窄屏不额外处理（现有 topbar 已响应式）。
- **不新增 AT/ET 持久 case**：纯前端确定性 UI（无 LLM 不确定性），UT 覆盖派生逻辑 + 组件渲染；ET 回归既有聊天冒烟。

## 7. 验收口径

**能力不变量**：
1. 会话落地页（单聊+群聊）topbar 常驻 squad 图标 + running badge（含 leader，suspended 不计）。
2. badge 数字随 SSE 实时刷新（另一成员 running/idle 变化 → 数字即时变，不刷新页面）。
3. 点击图标展开面板：running 上 / idle 下，presence 文字展示（currentWork 优先，空 fallback）。
4. 面板行 hover 出现进入对话 icon（无文字），点击进入该成员会话。
5. 从面板进入的会话，返回键恒回 squad 首页。

**回归不变量**：
1. 现有首页（seats 面板）成员状态展示零变化（复用同口径派生）。
2. 会话页正常功能（消息流/输入区/topbar 右侧 usage/compact/clear）零变化；入口不遮挡、不推动布局。
3. `session_meta` 订阅不新增（复用 useStudioUnreadMeta 单例），不破坏现有订阅模型。

**性能护栏**：
- 入口组件对 stateMap 的订阅按 squad 成员 sessionId 子集精化，running 变化不引发 chat 消息区/输入区 re-render。

## 8. spec 对齐备忘

- `specs/ui/components/studio-page/section-studio-chat.md`：topbarLeft 形态表补充「squad 状态入口前置」。
- `specs/ui/components/studio-page/component-seats-panel.md`：`buildMemberChatNode` 复用说明（面板进入对话与坐席卡同源组装）。
- `specs/ui/components/chat-page/section-chat-session.md`：topbarLeft render-prop 契约（入口挂在 studio 版 render-prop 内，SectionChatSession 零改动）。
- `specs/tech/app/frontend/[P0]sse_client_singleton.md`：确认不新增订阅（复用 useStudioUnreadMeta）。
- 新组件 spec：`component-squad-status-entry.md`（入口 + 面板两小节，视觉基线待设计稿/实现期补充）。

## 9. 版本总结

- **产品价值**：squad 会话落地页内随时可见团队实时状态（谁在跑、在做什么），不必返回首页；从会话页直达任意成员对话，返回恒回首页。
- **范围**：纯前端 Studio（chat topbar 入口 + 展开面板 + SSE 复用），无后端 API 变更。
- **关键决策**：badge = running 数（含 leader，SSE 实时）；presence 文字 = detail 快照（打开面板刷新）；面板 hover 进入对话 + 返回恒回首页；入口挂 SectionStudioChat topbarLeft。
- **风险/口子**：presence 文字非 SSE 实时（如需实时需新增后端推送，超本版范围）；detail 刷新与 stateMap 的订阅粒度（selector 精化）归架构期。
