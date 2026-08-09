# v0.0.268 变更计划书 — Squad 成员状态导航

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/version_logs/v0.0.268.squad_status_nav/prd.md`。版本上下文：`states/v0.0.268/context.md`。新组件 spec：`specs/ui/components/studio-page/component-squad-status-entry.md`。
> **架构期裁决（3 个 PRD 决策点）**：
> ① **入口 + 面板新组件 spec**：`component-squad-status-entry.md`（入口图标+badge 小节 + 面板 running/idle 分区小节 + 视觉基线 + testid）。
> ② **stateMap 订阅 selector 精化 = SquadStatusContext + memberStateMap 值比较稳定引用 + StudioChatRouter memo 阻断**：入口组件**不新增 SSE 订阅**（sse-client subscribe 每次生成新 subId + POST——自订阅会新增 subscriber，违反「不新增订阅」铁律）；数据经 page-studio 已订阅的 useStudioUnreadMeta 派生 memberStateMap（只含 detail.members sessionId 子集，useMemo 值比较返 lastRef 稳定引用——非成员 SSE 引用不变）→ SquadStatusContext.Provider 下传 → 入口组件 useContext 读子集；StudioChatRouter React.memo + onBack useCallback 阻断「page-studio SSE re-render → chat 树级联」（现状缺陷）；成员 SSE 时仅入口组件 re-render（Context 消费者自 re-render 不级联父/兄弟），chat 消息区/输入区零 re-render。
> ③ **badge 0 态 = 不显示数字（仅图标）**：不突兀 + 对齐「0 running 不亮」语义；避免「灰色 0」歧义（可能误读为未读数）；aria-label 0 时仅「成员状态」。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（studio / ui-chat） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio | app/web/src/components/studio-page/squad-status-context.ts（新） | SquadStatusContextValue interface | 新增 | `{ detail: SquadDetail \| null; memberStateMap: Record<string, SessionState>; onEnterChat: (node: ChatNode) => void; refreshDetail: () => void }`——入口组件数据注入契约 | MUST detail 缺省 null 时入口组件渲染 loading/空态（不阻塞会话页）；MUST memberStateMap 只含 squad 成员 sessionId 子集 | PRD §3.4；决策②；component-squad-status-entry.md §数据注入 | +8 |
| studio | app/web/src/components/studio-page/squad-status-context.ts（新） | SquadStatusContext + useSquadStatus() | 新增 | React Context（createContext<SquadStatusContextValue \| null>）+ `useSquadStatus()` hook（null → throw 或返 null，组件侧 fail-safe） | MUST 无 Provider 时入口组件不渲染（fail-safe，不炸）；MUST 仅入口组件消费（chat 其他区域不读） | 决策② | +16 |
| studio | app/web/src/components/studio-page/squad-status-utils.ts（新） | buildMemberChatNode(detail, memberId, t) | 新增 | 从 SeatsPanel 抽出公共 helper：member 查找 + ChatNode 组装（tag 规则 leader → `squadTree.tagLeader` / mate → `squadTree.tagSingle` + squadId） | MUST 与 SeatsPanel 现组装逐字节一致（DRY，SeatsPanel 改调本 helper）；MUST member 不存在返 null | PRD §5 概念对齐（buildMemberChatNode 同源）；component-seats-panel.tsx 现状 L87-99 | +14/-14 |
| studio | app/web/src/components/studio-page/squad-status-utils.ts（新） | deriveRunningCount(detail, memberStateMap) | 新增 | running 计数纯函数：遍历 detail.members（state==='deployed'）的 sessionId，`isRunningState(memberStateMap[sid])`（running/interrupting）计数，**含 leader**；suspended/benched 不计 | MUST 口径与 seats isRunning 一致（running/interrupting，suspended 排除）；MUST 纯函数无副作用（UT 覆盖） | PRD §2 D2/D4；use-seats-data.ts isRunningState | +10 |
| studio | app/web/src/components/studio-page/squad-status-utils.ts（新） | derivePanelRows(detail, memberStateMap) | 新增 | 面板行派生纯函数：deployed 成员分两组——running（isRunningState true）/ idle（非 running 含 suspended）；benched 过滤；行 = `{ member, isLeader, statusTextSource }`（复用 deriveStatusTextSource） | MUST benched 不显示；MUST running/idle 分区口径与 deriveRunningCount 一致；MUST 纯函数（UT 覆盖） | PRD §3.3；use-seats-data.ts deriveStatusTextSource | +22 |
| studio | app/web/src/components/studio-page/component-squad-status-entry.tsx（新） | SquadStatusEntry | 新增 | 入口组件：`useSquadStatus()` 读 Context → 图标（Icon name="squad"）+ running badge（deriveRunningCount；**0 态不显示数字**，绝对定位叠加不占文档流）+ 点击展开面板（open state + 外部点击/Esc 关闭）；面板 = derivePanelRows 两组分区渲染（头像 + 名字 + role 标识 + presence 文字单行 truncate）+ hover 显示 Icon name="chat"（点击 onEnterChat(buildMemberChatNode)）；展开时调 refreshDetail（fire-and-forget） | MUST badge 绝对定位不占文档流（0↔非 0 无位移）；MUST button 语义 + aria-label（`成员状态，N 个运行中` / 0 时 `成员状态`）；MUST 无 Context 不渲染；MUST 打开面板触发一次 refreshDetail（失败不阻塞旧快照）；MUST testid：入口 squad-status-entry / 面板 squad-status-panel / 行 squad-status-row-{memberId} | PRD §3.1-3.4；决策①③；component-squad-status-entry.md | +120 |
| studio | app/web/src/components/studio-page/page-studio.tsx | memberStateMap 派生（useMemo） | 新增 | 派生 squad 成员 sessionId 子集的 stateMap：遍历 detail.members sessionId → stateMap[sid]；**值比较**——与 lastRef 逐项比对，无变化返 lastRef（稳定引用），有变化才返新对象 | MUST 非成员 session SSE 时引用不变（StudioChatRouter memo 不 re-render）；MUST 依赖 [stateMap, detail]（stateMap 引用变触发重算，但值比较保证无变化时返旧引用） | 决策②；PRD §7 性能护栏 | +18 |
| studio | app/web/src/components/studio-page/page-studio.tsx | onBack useCallback | 修改 | chat 分支 onBack 从 inline 箭头改 useCallback（依赖 mainView.node?.squadId / selectedSquadId / fallbackToSeats）——稳定引用供 StudioChatRouter memo | MUST 行为等价（backSquadId 逻辑不变）；MUST 引用稳定（deps 不含每次变的对象） | 决策② | +2/-6 |
| studio | app/web/src/components/studio-page/page-studio.tsx | chat 分支包 SquadStatusContext.Provider | 修改 | chat mainArea 外包 `<SquadStatusContext.Provider value={{ detail, memberStateMap, onEnterChat: (node) => setMainView({kind:'chat',node}), refreshDetail: () => void reloadDetail(selectedSquadId) }}>`（value 用 useMemo 稳定化或接受 detail 变化时重建——入口组件 re-render 可接受） | MUST 仅包 chat 分支（seats 不需要）；MUST onEnterChat 语义与 SeatsPanel 传参一致（setMainView chat）；MUST refreshDetail = reloadDetail（fire-and-forget） | 决策②；PRD §3.4/§3.5 | +10 |
| studio | app/web/src/components/studio-page/component-studio-chat-router.tsx | StudioChatRouter React.memo | 修改 | 组件导出改 `memo(StudioChatRouter)`（props: node/prefill/onBack 引用稳定 → page-studio SSE re-render 不级联 chat 树） | MUST node/prefill 引用稳定（来自 mainView state，SSE 不 setMainView）；MUST onBack 已 useCallback（见 page-studio 行）；MUST 内部 useChatChrome 自身订阅仍正常（memo 不影响 hook 订阅） | 决策②；PRD §7 性能护栏 | +2 |
| studio | app/web/src/components/studio-page/section-studio-chat.tsx | topbarLeft 恒渲染（插 SquadStatusEntry） | 修改 | topbarLeft render-prop 两分支都前置 `<SquadStatusEntry/>`：单聊 = 入口 + 身份 header（MemberAvatar+name）+ tag；群聊 = 入口 + `<ChatSessionTopbarLeft chrome={chrome}/>`（缺省 header，readOnly 缺省取 chrome.readOnly） | MUST 单聊/群聊都显示入口（PRD D1）；MUST 群聊缺省 header 行为与现状等价（原 undefined → SectionChatSession defaultTopbarLeft，现显式 ChatSessionTopbarLeft）；MUST SectionChatSession 零改动 | PRD D1；section-studio-chat.md 形态表 | +8/-4 |
| studio | app/web/src/components/studio-page/component-seats-panel.tsx | buildMemberChatNode 改调公共 helper | 修改 | 内部 buildMemberChatNode 实现改为调 squad-status-utils.buildMemberChatNode（DRY） | MUST 行为逐字节一致（现 L87-99 逻辑迁移）；MUST 保留方法签名（caller 零改动） | 决策①（DRY）；squad-status-utils.ts 行 | +2/-10 |
| studio | app/web/src/components/studio-page/__tests__/squad-status-utils.test.ts（新） | 派生纯函数 UT | 新增 | deriveRunningCount（running/interrupting 计/suspended 不计/benched 不计/含 leader/无成员 0）/ derivePanelRows（running/idle 分区/benched 过滤/statusTextSource currentWork 优先）/ buildMemberChatNode（leader tag/mate tag/不存在 null） | MUST 纯函数全用例；MUST mock i18n t（tag 派生） | PRD §4 UC-1~8 / §7 UT 范围 | +60 |
| studio | app/web/src/components/studio-page/__tests__/component-squad-status-entry.test.tsx（新） | 入口组件 UT | 新增 | 有 detail+memberStateMap → 图标+badge 数字正确；0 running → 无数字（仅图标）；点击展开 → 面板 running 上/idle 下分区正确；hover 行 → chat icon 出现；点击 chat icon → onEnterChat 被调（ChatNode 正确）；点击外部/Esc → 关闭；无 Provider → 不渲染 | MUST mock SquadStatusContext value（或包 Provider）；MUST jsdom 环境；MUST badge 0 态断言（无数字节点） | PRD UC-1/3/4/6/8；决策③ | +90 |

## 影响面评估

- **改动文件**：4 个新文件（context/utils/entry + spec）+ 4 个修改（page-studio/router/section-studio-chat/seats-panel）+ 2 个新测试 + 3 个既有 spec 同步（section-studio-chat.md / component-seats-panel.md / 00-app-guide.md）
- **风险点**：
  1. **StudioChatRouter memo**：node/prefill 来自 mainView state（SSE 不 setMainView → 稳定 ✓）；onBack 必须 useCallback（否则 memo 失效）；SectionStudioChat 的 key={sessionId} remount 语义不受影响（memo 是 props 比较，key 变化强制 remount）
  2. **memberStateMap 值比较**：squad 成员增删（deploy/bench）时 detail 变 → useMemo 重算 → 引用变 → 入口 re-render（可接受）；需处理「成员删除后旧 sid 残留」——遍历以当前 detail.members 为准，旧 sid 不进新对象
  3. **Context value 重建**：detail 引用变化（reloadDetail）→ Provider value 变 → 入口 re-render（打开面板刷新 detail 本来就要更新面板，可接受）；StudioChatRouter 不在 Context 内消费（只 memo props）不受影响
  4. **群聊缺省 header**：SectionStudioChat 群聊显式渲染 ChatSessionTopbarLeft（readOnly 缺省 chrome.readOnly）——需与 SectionChatSession 现状 defaultTopbarLeft 行为核对（title/tag/readOnly badge/model-tag 一致）
  5. **0 态视觉**：badge 不显示数字（仅图标）——aria-label 保留「成员状态」语义；绝对定位避免位移
- **不做**（PRD §6）：presence SSE 实时推送 / 面板内成员管理 / 跨 squad / badge 叠加未读数 / 新增 AT/ET 持久 case
