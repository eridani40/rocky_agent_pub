# v0.0.268 tech change log — Squad 成员状态导航

> 对应需求：`reqs/[working] v0.0.268/req.md`（用户可感知的行为改动 → 走完整 PRD）。
> PRD：`specs/prd/version_logs/v0.0.268.squad_status_nav/prd.md`。
> 权威契约：`specs/tech/version_logs/v0.0.268/change_plan.md`（method 级 14 行表，frozen）。
> 新组件 spec：`specs/ui/components/studio-page/component-squad-status-entry.md`（架构期已建）。

## 变更摘要

### 需求与动机

Studio 中，成员状态（running/idle、presence 工作标记）只在 **squad 首页（seats 面板）** 可见：用户进入某个成员/群聊的会话落地页后，看不到 squad 其他成员的实时状态——需要返回首页才能看。需求：在 squad 会话页（单聊/群聊）顶部导航增加常驻成员状态入口（squad 图标 + running badge + 展开面板 + 两级导航「返回永远回首页」）。

### 方案（3 口子架构期裁决，详见 change_plan「架构期裁决」）

1. **入口 + 面板新组件 spec**（决策①）：`component-squad-status-entry.md`（入口图标+badge 小节 + 面板 running/idle 分区小节 + 视觉基线 + testid）。
2. **stateMap 订阅 selector 精化 = SquadStatusContext + memberStateMap 值比较稳定引用 + StudioChatRouter memo 阻断**（决策②）：入口组件**不新增 SSE 订阅**（sse-client subscribe 每次生成新 subId + POST——自订阅会新增 subscriber，违反「不新增订阅」铁律）；数据经 page-studio 已订阅的 useStudioUnreadMeta 派生 memberStateMap（只含 detail.members sessionId 子集，useMemo 值比较返 lastRef 稳定引用——非成员 SSE 引用不变）→ SquadStatusContext.Provider 下传 → 入口组件 useContext 读子集；StudioChatRouter React.memo + onBack useCallback 阻断「page-studio SSE re-render → chat 树级联」（现状缺陷）；成员 SSE 时仅入口组件 re-render（Context 消费者自 re-render 不级联父/兄弟），chat 消息区/输入区零 re-render。
3. **badge 0 态 = 不显示数字（仅图标）**（决策③）：不突兀 + 对齐「0 running 不亮」语义；避免「灰色 0」歧义（可能误读为未读数）；aria-label 0 时仅「成员状态」。

### T1 — Squad 成员状态导航核心（commit 90ab05653 + C1 修复 f3ec92b4a）

- **`squad-status-context.ts` NEW（42 行）**：`SquadStatusContextValue`（`{ detail, memberStateMap, onEnterChat, refreshDetail }`）+ `SquadStatusContext`（createContext null）+ `useSquadStatus()`（无 Provider 返 null fail-safe——入口组件据此不渲染，不炸）。
- **`squad-status-utils.ts` NEW（116 行）**：`buildMemberChatNode(detail, memberId, t)`（从 SeatsPanel 抽公共 helper，tag 规则 leader → tagLeader / mate → tagSingle + squadId，member 不存在返 null）+ `deriveRunningCount(detail, memberStateMap)`（deployed 成员 isRunningState 计数**含 leader**，suspended/benched 不计——对齐 seats isRunning 口径）+ `derivePanelRows(detail, memberStateMap)`（running/idle 分区，benched 过滤，行 = member/isLeader/presence/statusTextSource，复用 use-seats-data 同源派生）。全部纯函数无副作用。
- **`component-squad-status-entry.tsx` NEW（187 行）**：入口 = squad 图标 + running badge（**0 态不显示数字**，绝对定位 `-right-0.5 -top-0.5` 叠加不占文档流）+ 面板（running 上 / idle 下分区 + presence 文字 + hover chat icon **opacity 保留占位**不位移 + 整行 button）+ 外部点击/Esc 关闭 + 打开 refreshDetail fire-and-forget + detail null → loading + 无 Provider fail-safe 不渲染。testid 全对齐（squad-status-entry / squad-status-panel / squad-status-row-{memberId}）。
- **`page-studio.tsx`（275 → 295 行）**：chat 分支包 `<SquadStatusProvider detail stateMap onEnterChat reloadDetail selectedSquadId>`（仅 chat，seats 不包）；onBack 改 useCallback（`handleChatBack`，deps chatBackSquadId 派生值 + fallbackToSeats）；onEnterChat = `handleSquadEnterChat` useCallback（setMainView chat 语义，与 SeatsPanel 传参一致）。
- **`component-studio-chat-router.tsx`（130 行）**：导出改 `memo(StudioChatRouterImpl)`——props（node/prefill/onBack）引用稳定 → **page-studio SSE re-render 不级联 chat 树**；内部 useChatChrome 订阅不受影响；key={sessionId} remount 保留。
- **`section-studio-chat.tsx`（91 行）**：topbarLeft 恒渲染——单聊 = SquadStatusEntry + MemberAvatar+name+tag；群聊 = SquadStatusEntry + 显式 ChatSessionTopbarLeft（readOnly 缺省 chrome.readOnly，与 SectionChatSession defaultTopbarLeft 等价）。
- **`component-seats-panel.tsx`（217 行）**：buildMemberChatNode 改调 squad-status-utils 公共 helper（DRY，行为逐字节一致，签名保留 caller 零改动）。
- **i18n**：`studio:squadStatus.ariaLabel`（成员状态）/ `ariaLabelRunning`（成员状态，{{count}} 个运行中）双语同步。
- **测试**：squad-status-utils.test.ts（13 用例）+ component-squad-status-entry.test.tsx（14 用例）+ squad-status-provider.test.tsx（8 用例，锁定「非成员 SSE 引用不变」验收点）+ section-studio-chat.test.tsx 断言更新（topbarLeft 恒渲染）。**studio-page + i18n 全量 572/572 passed（51 文件）+ tsc -b app/web exit 0**。

## 设计决策

- **不新增 SSE 订阅（铁律）**：入口组件若自调 useStudioUnreadMeta 会触发 sse-client subscribe 新 subId + POST /sse/subscribe = 新增 subscriber，违反「不新增订阅」铁律。正解 = SquadStatusContext 注入——page-studio 已订阅 `session_meta _all`（biz='studio' 反向守卫），memberStateMap 派生只取成员子集，非成员 SSE 值比较返 lastRef 稳定引用 → memo 阻断级联。
- **memberStateMap 值比较稳定引用**：遍历 detail.members sessionId → stateMap[sid]（undefined 不进）；键集相同 + 每键同值 → 返 lastRef（跳过 re-render）；成员增删（deploy/bench）时 detail 变 → 键集变 → 返新对象（入口 re-render 可接受）。
- **StudioChatRouter memo + onBack useCallback**：node/prefill 来自 mainView state（SSE 不 setMainView → 引用稳定）；onBack 必须 useCallback（deps 只含 chatBackSquadId 派生值 + fallbackToSeats，不含每次变的对象）——否则 memo 失效。key={sessionId} remount 语义不受影响（memo 是 props 比较，key 变化强制 remount）。
- **badge 0 态不显示数字**：不突兀 + 对齐「0 running 不亮」语义；避免「灰色 0」误读为未读数；aria-label 0 时仅「成员状态」；绝对定位叠加保证 0↔非 0 无位移（布局稳定 MANDATORY）。
- **presence 文字 = detail 快照（非 SSE 实时）**：presence tool 写 currentWork 无 SSE 推送；新增后端推送超出纯前端范围（PRD 边界）；打开面板触发一次 refreshDetail（reloadDetail fire-and-forget，失败不阻塞旧快照展示）。
- **两级导航固化**：第一级 = squad 首页（SeatsPanel）；第二级 = 会话落地页（StudioChatRouter）。面板进入对话 = `setMainView({kind:'chat', node})`；返回键复用 page-studio 现有 onBack（恒 `setMainView({kind:'seats', squadId})`），不引入「回上一会话」语义。

## 代码↔spec 核实（doc-modifier 阶段 5 — 逐项比对 change_plan + 代码）

| # | change_plan 契约 | 代码实现 | 一致 |
|---|---|---|---|
| 1 | SquadStatusContextValue interface（detail/memberStateMap/onEnterChat/refreshDetail） | `squad-status-context.ts:22-31` 四字段齐全 | ✅ |
| 2 | SquadStatusContext + useSquadStatus()（无 Provider fail-safe） | `squad-status-context.ts:34-42` createContext(null) + useSquadStatus 返 null | ✅ |
| 3 | buildMemberChatNode（tag leader→tagLeader / mate→tagSingle + squadId；不存在返 null） | `squad-status-utils.ts:35-51` 与 SeatsPanel 组装逐字节一致（测试 L160 断言同源） | ✅ |
| 4 | deriveRunningCount（deployed isRunningState 计数含 leader；suspended/benched 不计） | `squad-status-utils.ts:61-71` 遍历 members + isRunningState | ✅ |
| 5 | derivePanelRows（running/idle 分区；benched 过滤；statusTextSource 复用） | `squad-status-utils.ts:97-116`；偏离 1 等价：PanelRow 加 presence 字段（fallback 键依赖） | ✅ |
| 6 | SquadStatusEntry（badge 0 态 / 绝对定位 / 面板分区 / hover chat icon / Esc+外部点击 / refreshDetail / testid） | `component-squad-status-entry.tsx`（187 行）全部对齐 | ✅ |
| 7 | memberStateMap 派生 useMemo（值比较返 lastRef） | `squad-status-provider.tsx:53-69` 逐字一致（C1 拆分迁移） | ✅ |
| 8 | onBack useCallback（deps 稳定） | `page-studio.tsx:142-148` handleChatBack（deps chatBackSquadId + fallbackToSeats） | ✅ |
| 9 | chat 分支包 Provider（仅 chat） | `page-studio.tsx:209-226` SquadStatusProvider 仅包 chat 分支 | ✅ |
| 10 | StudioChatRouter React.memo | `component-studio-chat-router.tsx:128` `export const StudioChatRouter = memo(StudioChatRouterImpl)` | ✅ |
| 11 | topbarLeft 恒渲染（单聊/群聊都前置入口） | `section-studio-chat.tsx:43-70` 两分支都 `<SquadStatusEntry/>` 前置 | ✅ |
| 12 | seats-panel buildMemberChatNode 改调公共 helper | `component-seats-panel.tsx:20,88-89` 委托 squad-status-utils（DRY） | ✅ |
| 13 | utils UT（派生纯函数全用例） | `squad-status-utils.test.ts` 13 用例（deriveRunningCount 5 / derivePanelRows 4 / buildMemberChatNode 4） | ✅ |
| 14 | entry UT（badge 0 态 / 面板分区 / hover / 交互 / fail-safe） | `component-squad-status-entry.test.tsx` 14 用例 + `squad-status-provider.test.tsx` 8 用例 | ✅ |

**偏离记录（等价合理，非静默）**：
- **偏离 1：PanelRow 加 presence 字段**（change_plan 行 5 契约未列）→ 等价合理：spec §行内容「空 → i18n fallback `studio:seats.status.*`」需要 presence 决定 fallback 键（running→busy / idle→online / offline）；`useSeatStatusText(row)` 选键 `seats.status.${row.presence}` 确实依赖该字段。
- **偏离 2：i18n 新增 2 键**（change_plan 未列 i18n 行）→ 等价合理：决策③「badge 0 态 aria-label 仅『成员状态』」必需 `squadStatus.ariaLabel` + `ariaLabelRunning`（{{count}} 插值）；zh/en 双语同步。
- **偏离 3（C1 拆分）**：page-studio.tsx 326 行 > 300 铁律（code-review C1 Critical）→ 抽 `squad-status-provider.tsx`（86 行），page-studio 326→295 ≤300 ✓。memberStateMap 派生 / refreshDetail / value useMemo 逻辑逐字迁移（行为等价）；handleChatBack/handleSquadEnterChat 保留 page-studio（与 setMainView 耦合，正确边界）。详见下文「偏离记录」段。

## C1 拆分偏离记录（coder3 2026-08-06 T1）

- **触发**：code-review C1 Critical——page-studio.tsx 编码后 326 行 > 300 行铁律（团队 AGENTS.md「单文件 ≤300 行」；base 275 + T1 +51）。
- **change_plan 行影响**：
  - 行 7（page-studio.tsx `memberStateMap 派生 useMemo`）→ **迁移**到新文件 `app/web/src/components/studio-page/squad-status-provider.tsx`（同逻辑：遍历成员 sessionId 子集 + 值比较返 lastRef 稳定引用）
  - 行 8（page-studio.tsx `onBack useCallback`）→ **保留**在 page-studio.tsx（`handleChatBack`，与 chat 路由耦合）
  - 行 9（page-studio.tsx `chat 分支包 Provider`）→ **迁移**为新组件 `SquadStatusProvider`（含 memberStateMap 派生 + refreshDetail useCallback + value useMemo + Provider JSX 封装）；page-studio chat 分支改调 `<SquadStatusProvider detail stateMap onEnterChat reloadDetail selectedSquadId>`（-50 行 → 295 行 ≤300 ✓）
  - 新增文件 `squad-status-provider.tsx`（86 行）+ 新增 UT `__tests__/squad-status-provider.test.tsx`（8 用例，锁定「非成员 SSE 引用不变」验收点）
- **行为等价性**：memberStateMap 值比较逻辑逐字节迁移（无改动）；handleSquadEnterChat 保留 page-studio（setMainView chat 语义）；refreshDetail 由 provider 内部 useCallback 实现（deps selectedSquadId + reloadDetail，行为与拆分前一致）。
- **验证**：studio-page 全量 34 文件 385 tests 全绿（含新 provider 8）+ tsc -b clean；page-studio 295 行 / provider 86 行均 ≤300。

## 文档同步

- `specs/ui/components/studio-page/section-studio-chat.md`：topbarLeft 形态表补「SquadStatusEntry 前置」（单聊/群聊两形态）+ 复用关系补 SquadStatusEntry + 可观测节点补 testid 引用。
- `specs/ui/components/studio-page/component-seats-panel.md`：状态交互补「buildMemberChatNode 公共 helper（v0.0.268 DRY）」说明。
- `specs/ui/overall/00-app-guide.md`：§3.2 补「会话页成员状态入口（v0.0.268，两级导航）」操作路径（入口/badge/面板/进入对话/返回恒回首页）。
- `specs/tech/app/frontend/log.md` + `index.md`：v0.0.268 条目 + 概念行。
- 新组件 spec `component-squad-status-entry.md`（架构期已建）：本版本已核实与实现一致，无需改。
- **不做**：AT/ET 持久 case（纯前端确定性 UI，UT 覆盖；PRD 用户铁律）；无后端 API 变更（不涉及 specs/api）。
