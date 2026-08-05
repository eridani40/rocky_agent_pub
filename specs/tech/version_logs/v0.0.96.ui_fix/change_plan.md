# v0.0.96.ui_fix 变更计划书 — UI/架构修复三件套（usage 格式 / loading 双源兜底 / studio chat 自给）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（如 ui-usage / ui-loading / ui-studio-chat / ui-types） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 开放点最终裁决（arch 拍板）

| ID | 裁决 | 理由 |
|----|------|------|
| O1 | **不动「已用/总」概览**（k 格式沿用） | 用户痛点在展开面板累积消耗区，不动 spec `component-usage-panel.md §4.3` 现有 k 格式 |
| O2 | **独立文件 `lib/format-traffic.ts`** | 纯函数可单测、无副作用、未来 ws-panel/其他流量展示可复用；不入 lib/providers.ts（语义不同） |
| O3 | **不加 client cache**（接受重复拉 GET /squad） | YAGNI；squad detail 体积小，chat 期间不变（非高频）；如未来加 SWR 走独立 hook |
| O4 | **单 hook `useStudioChatChrome`，走 useLifecycle** | 与 useRunState/useMessages 同族（genRef+abort+deps 重订阅），一致性优于裸 useEffect；未来加 SSE 订阅零结构变更 |
| O5 | **保留 onOpenMember + prefill 纯回调** | chat 不应自管「进 member 面板」的页面级路由；prefill 是 mount-time 注入 |
| O6 | **群聊一并自给** | router 统一脱 detail，避免群聊/单聊数据源分裂；群聊仅多查 1 次 GET /session（拿 squadId），与单聊对称 |
| O7 | **组件内部 union（父已传 sessionRunning）** | ComponentMessageStream 已有双 prop 且父组件早已分别传 runActive+sessionRunning（核对代码 page-chat:267/271、member-chat:208/209）；仅组件内 spinner 门控扩为 `runActive \|\| sessionRunning`，父组件零改动。比原「父注入 union」更小更对（不污染 ComponentToolBatch runActive） |

## 变更清单

### Feature 1：usage 面板固定尺寸 + formatTraffic util

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-usage | app/web/src/lib/format-traffic.ts | formatTraffic | 新增 | 纯函数：`n<1000`→原值字符串；`1000≤n<1e6`→`K`；`1e6≤n<1e9`→`M`；`1e9≤n<1e12`→`B`；`n≥1e12`→`T`（均 1 位小数 toFixed(1)）；边界：0/负数/NaN→`String(n)` | MUST 纯函数无副作用；MUST NOT 四舍五入（toFixed 自带 round）；MUST 边界 0/负/NaN 返原值字符串防 `-1.5K` 丑态 | PRD §2.1；O2 裁决 | +28 |
| ui-usage | app/web/src/lib/format-traffic.test.ts | (test suite) | 新增 | UT：各量级（123/1234/1234567/1234567890/1e12）+ 边界（0/-1/NaN/Infinity）+ K/M/B/T 切换点（999.5/999.95K 等） | MUST 覆盖 K/M/B/T 4 临界 + 3 边界；MUST 真断言非 console.log | PRD §2.1；原则 9（不跳测试） | +35 |
| ui-usage | app/web/src/components/chat-page/component-usage-panel.tsx | CumCells | 修改 | 累积消耗表格 input/output/cache/total 单元格：`fmtNum(row.input)` → `formatTraffic(row.input)`（input/output/total 三列）；cache 列保留百分比（不动）。引入 import { formatTraffic } | MUST 仅改累积消耗区 4 列值；MUST NOT 改收起态「已用/总」概览（fmtK 沿用）；MUST NOT 改 cache 列（百分比语义） | PRD §2.1；O1 裁决；`component-usage-panel.md §4.7` | +6/-5 |
| ui-usage | app/web/src/components/chat-page/component-usage-panel.tsx | cum-table 容器 className | 修改 | 累积消耗表格 grid：标签列固定宽 `grid-cols-[96px_minmax(56px,1fr)_minmax(48px,1fr)_minmax(56px,1fr)_minmax(56px,1fr)]`（标签列宽 + 4 值列 minmax 防折行）+ 标签列 `whitespace-nowrap` + 值列 `tabular-nums` 防数字切换抖动 | MUST 列宽固定防折行；MUST 值列 tabular-nums 等宽数字防 K→M 切换左右跳；MUST NOT 改 panel 容器宽度（280px 沿用） | PRD §2.1；`component-usage-panel.md §4.6`（width 280px） | +3/-2 |

### Feature 2：气泡双源兜底（runActive || sessionRunning）

> **orchestrator 修正（核对代码后）**：`ComponentMessageStream` 已有 `runActive` + `sessionRunning` 双 prop（`component-message-stream.tsx:46-48`），且**两个父组件早已分别传这两个 prop**（page-chat.tsx:267/271、section-member-chat.tsx:208/209）。故**不需要改父组件**——仅在组件内部把 spinner 门控从 `runActive` 扩到 `runActive || sessionRunning`。architect 原方案的「父组件注入 union 作 runActive」**错误**：会污染 `<ComponentToolBatch runActive={runActive}>`（:275，tool-batch 进度须用精确 runActive 非 union）且与组件内 union 双重叠加。修正后仅 1 文件 1 行，更小更对。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-loading | app/web/src/components/chat-page/component-message-stream.tsx | (on-message spinner 渲染条件 :290) | 修改 | 第 290 行 `{runActive && <ComponentLoadingStatus phase={loadingPhase ?? 'thinking'} />}` 改为 `{(runActive \|\| sessionRunning) && <ComponentLoadingStatus phase={loadingPhase ?? 'thinking'} />}`。sessionRunning 已是 prop（行 48，默认 false），父组件早已传（page-chat:271 / member-chat:209），无需改父。 | MUST NOT 新增/改 props（runActive + sessionRunning 已在 MessageStreamProps）；MUST NOT 改 `<ComponentToolBatch runActive={runActive}>`（:275 保持精确 runActive）；MUST NOT 改 run-finish 条件（:293 `!sessionRunning && lastRunFinish` 不变）；phase 兜底 thinking（仅 sessionRunning 触发时 loadingPhase=null 显默认「思考中」）；MUST NOT 改 page-chat.tsx / section-member-chat.tsx（已传 sessionRunning）；MUST NOT 改 SquadChatPage（群聊不订 useRunState，不在范围） | PRD §2.2；`component-message-stream.tsx:46-48`（双 prop）+ :275（tool-batch runActive 不可污染）+ :290（spinner）+ :293（run-finish）；`chat_area_hooks.md §5`（SquadChatPage 不订 run 态） | +1/-1 |

### Feature 3：studio chat 自给化（useStudioChatChrome + router 脱 detail + props 收敛）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-types | app/web/src/components/chat-page/types.ts | Session interface | 修改 | Session interface 补两个字段：`squadId?: string;` + `memberId?: string;`（API spec `11-squad.md §2` 第 50-51 行已声明，前端类型漏定义；本版本 useStudioChatChrome 靠此编译过） | MUST 对齐 API spec（已有契约）；MUST 标 optional（playground session 无此字段）；doc-sync 已记 PRD §7 | PRD §7 spec 漂移；`specs/api/overall/11-squad.md §2`（行 50-51）；原则 13 | +2 |
| ui-studio-chat | app/web/src/components/studio-page/use-studio-chat-chrome.ts | useStudioChatChrome | 新增 | chat 自给 chrome hook：`useStudioChatChrome(sessionId) → { chrome: StudioChatChrome \| null, loading, error }`。走 useLifecycle（deps:[sessionId]，genRef 守卫）；onInit 内 getSession→squadId/memberId→getSquad→定位 member（单聊）/ undefined（群聊）；返 `{ member?, squad, squadModelDefault, tag, isGroup }` | MUST 走 useLifecycle（与 useRunState 同族）；MUST onInit 两段 await 间各 signal.aborted 校验（不变量②）；MUST NOT 订 SSE（纯 GET-once）；memberId 空=群聊；单聊 member 缺失（squad.members 无匹配）→ 群聊兜底 + dev warn | `[P0]component_data_map.md §6`；PRD §2.3；O4 裁决；原则 7（fire-and-forget .catch 防回灌） | +60 |
| ui-studio-chat | app/web/src/components/studio-page/use-studio-chat-chrome.ts | StudioChatChrome interface | 新增 | 类型：`{ member?: Member; squad: SquadDetail; squadModelDefault: string; tag: string; isGroup: boolean }` | MUST member 仅单聊有（群聊 undefined）；MUST 派生 isGroup（= !memberId） | `[P0]component_data_map.md §6.2` | +8 |
| ui-studio-chat | app/web/src/components/studio-page/use-studio-chat-chrome.ts | buildTag (helper) | 新增 | 内部纯函数：单聊 tag = `${squad.name} · ${member.role}`；群聊 tag = `${squad.name} · 群聊`（i18n key 走 chat:usage.tag.group 或硬编码「群聊」，coder 定） | MUST 单聊用 member.role（leader/mate）；MUST 群聊显式「群聊」字面 | PRD §2.3 功能交互 | +6 |
| ui-studio-chat | app/web/src/components/studio-page/section-member-chat.tsx | MemberChatPageProps | 修改 | 删 `member`/`squadId`/`squadModelDefault`/`tag` 四个 prop；保留 `sessionId`/`onOpenMember`/`prefill?` | MUST props 仅留 sessionId + 纯交互回调；MUST NOT 删 onOpenMember（进 member 面板路由归父）；MUST NOT 删 prefill（看板 @ 按钮预填） | PRD §2.3；O5 裁决 | -4 行（interface） |
| ui-studio-chat | app/web/src/components/studio-page/section-member-chat.tsx | MemberChatPage (function body) | 修改 | 函数开头调 `const { chrome, loading, error } = useStudioChatChrome(sessionId)`；loading 期间渲 chat-loading 占位（替代 router 兜底）；chrome 到位后从 chrome 取 member/squad/tag/squadModelDefault/squadId（= chrome.squad.id）替换原 prop 解构 | MUST chrome=null+loading=true 渲 loading 占位（不自管 error UI，简单 spinner）；MUST chrome.error 时也显 loading（GET 失败不阻塞 ET，dev console warn）；patchMember 的 squadId/member.id 改从 chrome 取 | PRD §2.3；O6 裁决 | +25/-12 |
| ui-studio-chat | app/web/src/components/studio-page/section-squad-chat.tsx | SquadChatPageProps | 修改 | 删 `squadModelDefault`/`tag`/`title` 三个 prop；保留 `sessionId`/`prefill?` | MUST props 仅留 sessionId + prefill；MUST NOT 保留 title（topbar 标题从 chrome.squad.name 派生） | PRD §2.3；O6 裁决 | -3 行 |
| ui-studio-chat | app/web/src/components/studio-page/section-squad-chat.tsx | SquadChatPage (function body) | 修改 | 函数开头调 `const { chrome, loading } = useStudioChatChrome(sessionId)`；loading 占位；chrome 到位后从 chrome 取 squad/tag/squadModelDefault；title 改 `chrome.squad.name`（或 i18n「群聊」字面） | MUST 群聊 chrome.member=undefined（不取 member 字段）；MUST squadModelDefault 从 chrome.squad.modelDefault | PRD §2.3 | +18/-10 |
| ui-studio-chat | app/web/src/components/studio-page/component-studio-chat-router.tsx | StudioChatRouterProps | 修改 | 删 `detail: SquadDetail \| null` prop；保留 `node: ChatNode`/`prefill?`/`onOpenMember` | MUST router 完全脱 detail（不再用 detail 判 isGroup）；MUST NOT 把 detail 透传给 SquadChatPage/MemberChatPage（chat 自给） | PRD §2.3；PRD §2.3 router 脱 detail | -1 行 |
| ui-studio-chat | app/web/src/components/studio-page/component-studio-chat-router.tsx | StudioChatRouter (function body) | 修改 | 删 `isGroup`/`memberForChat`/chat-loading 兜底三路分支；统一渲染：群聊分支删（isGroup 从 chat 内部自查）；member 分支删；chat-loading 占位删（chat 自管 loading）。简化为：`<MemberChatPage key={node.sessionId} sessionId={node.sessionId} onOpenMember={...} prefill={prefill} />`（router 无法仅凭 node 判群聊/单聊，故**统一挂 MemberChatPage**——MemberChatPage 内部 chrome 自查后 if (isGroup) 渲 SquadChatPage 视觉）<br><br>**修正**：router 需根据 chrome.isGroup 决定挂 MemberChatPage 还是 SquadChatPage（两种 chat 视觉差异大：单聊有 abort/enqueue/MemberAvatar，群聊无）。**方案**：router 自身也调 useStudioChatChrome(node.sessionId) 拿 isGroup，loading 期间渲占位，chrome 到位后挂对应 Page。 | MUST router 调 useStudioChatChrome 与 Page 内 chrome 是两份独立 instance（接受重复拉，O3）；MUST key={node.sessionId} 保留（view 稳定性，原注释）；MUST NOT 保留 chat-loading 兜底（chat 自管 loading）；**MUST 用 chrome.isGroup 决定挂哪个 Page**（视觉差异决定不可统一） | PRD §2.3 router 脱 detail；O6 裁决（群聊一并自给） | +12/-25 |
| ui-studio-chat | app/web/src/components/studio-page/page-studio.tsx | (StudioChatRouter 调用点) | 修改 | 调用 `<StudioChatRouter>` 处删 `detail={detail}` prop 透传（router 不再需要 detail）；其余 prop（node/prefill/onOpenMember）不变 | MUST 删 detail prop；MUST NOT 改 page-studio 自身 detail state 管理（仍持 detail 管 squad 面板/看板，方案 A 接受重复拉） | PRD §2.3 取舍（方案 A）；O3 裁决 | +1/-1 |

### Feature 4：router 调 useStudioChatChrome 与 Page 内重复——架构备注（非任务行）

> router 与 Page 各调一次 useStudioChatChrome → 同 sessionId 触发 2× GET /session + 2× GET /squad（router + Page）。接受（O3 YAGNI）。如未来优化：把 chrome 提到 page-studio 层一次性传给 router+Page（回退到旧透传模式但 chrome 由 page-studio 自查非父选中态）。本版不做。

## 影响面评估

### 跨模块影响

- **chat-page**：types.ts（Session 加字段，对齐 API spec，向后兼容）；component-message-stream.tsx（spinner 条件 `runActive || sessionRunning` 双源，父组件零改）；component-usage-panel.tsx（formatTraffic + 列宽）。
- **studio-page**：新增 use-studio-chat-chrome.ts；section-member-chat.tsx + section-squad-chat.tsx props 收敛 + 函数体改 chrome 自给；component-studio-chat-router.tsx 脱 detail + 自调 chrome；page-studio.tsx 删 detail 透传。
- **lib**：新增 format-traffic.ts + 测试。

### 破坏性变更

- **MemberChatPage/SquadChatPageProps 签名变**：删多个 prop。所有 caller 必须同步改（router 是唯一 caller，同步改）。
- **StudioChatRouterProps 签名变**：删 detail prop。page-studio.tsx 是唯一 caller，同步改。
- **无 API 契约变更**（PRD §4 已确认；前端 Session 加字段是对齐已有 API spec，非新契约）。

### 依赖顺序（底层先于上层）

1. types.ts Session 加字段（编译基础，无依赖）
2. lib/format-traffic.ts（独立，无依赖）
3. use-studio-chat-chrome.ts（依赖 1）
4. section-member-chat.tsx / section-squad-chat.tsx（依赖 2+3）
5. component-studio-chat-router.tsx（依赖 3+4）
6. page-studio.tsx（依赖 5）
7. component-message-stream.tsx / component-usage-panel.tsx（独立，可并行；page-chat.tsx 不改）

### 风险点

- **router 与 Page 重复调 chrome**：同 sessionId 拉 2× GET（router + Page）。接受（O3），但需 ET 验证切 chat 不卡（GET /squad 体积小，本地 dev < 50ms）。
- **chrome.member 缺失兜底**：单聊 session.memberId 非空但 squad.members 无匹配（理论不应发生，数据不一致时）→ 群聊兜底 + dev warn。coder 须落 warn 日志便于诊断。
- **气泡 sessionRunning 滞留**：run_end 后 sessionRunning 滞留约一个 GET 延迟（useRunState run_end GET 校正），气泡多停一瞬。**已知代价（接受，PRD §2.2 明示）**。
- **router isGroup 决策**：router 必须用 chrome.isGroup 决定挂 MemberChatPage 还是 SquadChatPage（视觉差异：单聊有 abort/enqueue/MemberAvatar，群聊无）。如统一挂 MemberChatPage 会导致群聊错误显示停止按钮。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计

## doc-sync 待办（PRD §7 + 本计划发现，doc-modifier 阶段 5 处理）

1. `chat-page/types.ts` Session 加 `squadId?`/`memberId?` 字段（**coder 实现**，但 spec 漂移由 doc-modifier 阶段 5 在 `04-agent-session.md §2.3` 响应 schema 显式补 TypeScript interface 对齐——后端已返，仅前端类型漏定义）。
2. `chat-page/_overview.md §4.10` 明化「spinner 可见性 = runActive || sessionRunning（双源兜底）」。
3. `studio-page/_overview.md` 补「chat 自给化后 router 不再 detail 门控」（顺带记录抖动 race 治理）。
4. `member-chat-page.md` / `squad-chat-page.md` Props 章节更新（删 member/squadId/squadModelDefault/tag/title，仅留 sessionId + 回调）。
5. `component-usage-panel.md §4.3` 补 K/M/B/T 格式规则（仅累积消耗区；概览 k 格式不动）。
6. `[P0]component_data_map.md §2` 已在本版本同步加 useStudioChatChrome 行（架构期已做）。
