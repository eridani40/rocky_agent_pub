# v0.0.216 变更计划书 — chat 区域统一复用架构（chat_unify）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 上游：PRD `specs/prd/version_logs/v0.0.216.md`；接口权威 `specs/api/overall/04a-session-chrome.md`；装配层权威 `specs/tech/app/frontend/[P0]chat_session_assembly.md`；组件契约 `specs/ui/components/chat-page/section-chat-session.md` + `base-chat-page.md 消费方必备能力清单`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

### A. 后端 — session-chrome 服务 + 路由

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| server-chrome | app/server/src/services/session-chrome.ts | `ChromeKind` / `SessionChromeView` / `SessionCapabilities` | 新增 | 三类型定义，与 api 04a §2/§4 字段逐一对齐 | shape 各 kind 同构：字段集恒定（members 恒在、非 studio 为 []） | api 04a §2 | +45 |
| server-chrome | app/server/src/services/session-chrome.ts | `CAPABILITIES`（Record\<ChromeKind, SessionCapabilities\>） | 新增 | capabilities 静态表 | studio_group 关 runState/enqueue/effortPicker/approvalPicker/cron + groupRender=true（v0.0.152 裁决）；其余 kind 全开（academy 全开=用户拍板）；MUST NOT 给 subagent 单列（readOnly 是覆盖层） | api 04a §4 | +20 |
| server-chrome | app/server/src/services/session-chrome.ts | `deriveChromeKind(session)` | 新增 | biz/role → ChromeKind（studio 按 role==='squad' 分 group/member；academy 按三 role；缺省 playground） | 纯函数；MUST 按 api 04a §3.1 判定序 | api 04a §3.1 | +18 |
| server-chrome | app/server/src/services/session-chrome.ts | `buildSessionChrome(session, deps)` | 新增 | 组装 view：readOnly=derivation==='subagent'；sessionModel 保留字 'default'/空→null；defaultModel 按 kind 数据源表（playground=appConfig.get('default_models','default').chat；studio=squadStore.getSquad(session.squadId) 的 modelDefault+ProviderId；academy=academyStore.getClassroom(session.academyClassroomId).defaultModel）；studio 另拉 memberStore.listMembers(squadId) 投影 members + tag | 数据源缺失（squad/classroom 不存在、default 未配）→ 字段 null/[]，MUST NOT throw/4xx（装饰降级）；MUST NOT 调 resolveModel（chrome 返原始配置值，不做可用性解析） | api 04a §3.2 | +75 |
| server-chrome | app/server/src/handlers/session-chrome.ts | `SessionChromeDeps` / `handleSessionChrome()` | 新增 | GET-only handler：store.getSession→404；buildSessionChrome→200；非 GET→405(Allow:GET)。Deps={store, appConfig, squadStore, memberStore, academyStore} 独立接口 | MUST NOT 膨胀 SessionHandlerDeps（chrome 专用 deps 就地定义）；memberStore 按 squad handler 同款 `new MemberStore({root: dataDir})` 或复用 bs 句柄——coder 定位 | api 04a §2/§6 | +55 |
| server-chrome | app/server/src/routes/router-helpers.ts | `matchSessionPath()` | 修改 | sub 正则枚举加 `chrome` | 其余 sub 匹配序零变化（INV-R-1） | session-routes.ts 头注 INV-R-1 | +1 |
| server-chrome | app/server/src/routes/session-routes.ts | `dispatchSessionRoutes()` | 修改 | 加 `sub==='chrome'` 分支：组装 SessionChromeDeps（bs.store/appConfig/squadStore/academyStore + memberStore）→ handleSessionChrome | 分支位置在既有 sub 链中，不打乱 INV-R-1 顺序 | api 04a §2 | +12 |

### B. 后端 — model-resolver academy 分支（存量 gap）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| model-resolve | app/server/src/services/model-resolver.ts | `ResolveModelInput` | 修改 | sessionType 扩 `'academy'`；新增可选 `classroom?: { defaultModel?: { providerId?: string; modelId: string } }` | playground/studio 语义零变化 | api v0.0.216 change_log §2 | +8 |
| model-resolve | app/server/src/services/model-resolver.ts | `buildFallbackChain()` | 修改 | academy 链 = session 候选 → classroom.defaultModel 候选 → app_config.default_models.chat 候选（三档，任一保留字/不可用继续下探） | MUST 与创建链 academy-session-model 语义等价（explicit→classroom→app 默认）；MUST NOT 动 studio 分支（INV-A5：studio 不读 app_config） | model-resolver.ts 头注 INV-A5；academy-session-model.ts 头注 | +14 |
| model-resolve | app/server/src/services/model-resolver.ts | `ModelNotConfiguredError` | 修改 | detail.sessionType 类型放宽含 `'academy'`（构造参同步） | 错误体 shape 不变（code/message/detail 键不变） | api 04 §9 | +3 |
| model-resolve | app/server/src/handlers/session-config.ts | `buildSessionConfigFromDeps()` | 修改 | 参数加可选 `academyClassroomModel?: { providerId?: string; modelId: string }`；resolveModel 的 sessionType 派生加 `kind.biz==='academy' → 'academy'` 且 classroom={defaultModel: academyClassroomModel} 透传 | 非 academy 调用（studio/playground/subagent）行为零变化；参数缺省 undefined 时 academy 链退化 session→app 默认（session-debug 等次要 caller 可不传） | tech assembly §4；api change_log §2 | +14 |
| model-resolve | app/server/src/bootstrap-agent-phase.ts | `setResolveConfig` 闭包 | 修改 | academy 分支复用已拉的 `academyContext.classroom.defaultModel` 透传 academyClassroomModel（buildAcademyContext 已 fetch classroom，零新增网络/存储读取） | MUST NOT 为此再调 academyStore.getClassroom（复用 academyContext） | academy-context.ts:85（classroom 已拉）；tech assembly §4 | +8 |
| model-resolve | app/server/src/academy/academy-session-model.ts | `resolveAcademySessionModel()` | 修改 | 删手工三档 pick（isReservedModelId 预选），改调 `resolveModel({sessionType:'academy', sessionModelId: explicit?.modelId, sessionProviderId: explicit?.providerId, classroom:{defaultModel: classroomDefaultModel}})` | fallback 语义逐档等价（既有 UT 全绿为准）；导出签名不变（三 caller 零改动） | academy-session-model.ts 头注 fallback 链 | +8/-14 |

### C. 前端 — 统一装配层（chat-page）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/lib/chat-api/session-api.ts | `getSessionChrome(id)` + `SessionChromeView` FE 类型 | 新增 | fetch GET /session/:id/chrome + 响应类型（与 api 04a §2 逐字段对齐） | 类型 MUST 与后端 shape 一致（字段集恒定） | api 04a §2 | +40 |
| ui-chat | app/web/src/components/chat-page/use-chat-chrome.ts | `useChatChrome(sessionId)` | 新增 | useLifecycle GET-once（Snapshot 形，deps:[sessionId]，genRef+signal.aborted 守卫）；返回 {chrome, loading, error, setEffort, setApprovalMode, setModel}；setter=mutate 乐观 + fire-and-forget updateSession（'default' 哨兵→body {modelId:'default'}，具体 model→{providerId,modelId}），不 reload | MUST NOT 订 SSE；MUST NOT 复用/保留 useModelRestore；数据形/触发对齐拆解行 | tech assembly §3；data_map §6 范式（useStudioChatChrome 同族） | +115 |
| ui-chat | app/web/src/components/chat-page/section-chat-session.tsx | `SectionChatSession()` | 新增 | 由 section-chat-detail 演进：wrapper（sessionId null→emptyStateSlot；chrome loading→BaseChatPage loading 占位）+ Loaded（hooks 无条件）。compose useChatChrome（`chrome` prop 注入优先，防双拉）+ useMessages + useRunState(sessionId,{enabled:caps.runState}) + useSummary(同) + useUsage + useSessionPanelFanout + useLoadMore + useFlattenedView + deriveMinimapBars；内置 handlers：postMessage/postCompact/postClear/runState.abort/enqueueCancel；readOnly = prop ∪ chrome.readOnly；topbarLeft render-prop 缺省渲 title(+tag)+ReadonlyBadge+model-tag；capabilities 逐项门控（HITL/stop/enqueue/两 picker/usage/compact/clear/minimap/floatMenu/cron）；groupRender→chat-actor-strategy + max-w-[760px] | 文件 ≤300 行（输入区拆 component-chat-session-input）；MUST NOT 出现 biz/kind 字面分支；readOnly 行为与现 forceReadOnly 逐项等价（badge+model-tag+usage+Compact 保留、Clear/输入区隐藏）；HITL/enqueue 透传 MUST 走 useMessages 的 pendingToolCall/submitReply/enqueueItems（禁哑值） | ui section-chat-session.md；base-chat-page.md 能力清单；tech assembly §2 | +260 |
| ui-chat | app/web/src/components/chat-page/component-chat-session-input.tsx | `ComponentChatSessionInput()` | 新增 | 输入区组合：BaseChatInputBar + ChatComposer（biz/role/derivation 取自 chrome → resolveMentionProviders；prefill/placeholder 透传）+ buttonRow（approvalPicker→effortPicker→InputModelPicker(defaultModel 项=chrome.defaultModel)→send→ComponentRunStateAbortSlot 按 caps） | 布局稳定性：卡片/按钮出现消失不得致输入区位移（占位固定口径）；群聊（caps）无 stop/两 picker | 10-tool-permission §10.3；ui section-chat-session.md 门控矩阵 | +150 |
| ui-chat | app/web/src/components/chat-page/chat-actor-strategy.tsx | `isA2aInbox/isUser/groupMessageFilter/a2aRefOf/resolveGroupActor/resolveMemberActorFactory/memberSideResolver` | 新增 | 自 studio-page/squad-chat-helpers.tsx 纯迁移；`resolveMemberActorFactory` 参数窄化为 `{name, role}`（数据来自 chrome.members/memberId）；新增 `deriveRenderStrategy(chrome)`：按 caps.groupRender+memberId 产出 {messageFilter?, resolveActor?, sideResolver?} | 谓词/actor 逻辑 MUST 逐行等价迁移（UT 随迁）；chat-page MUST NOT import studio-page | squad-chat-helpers.tsx 头注（渲染策略契约）；tech assembly §4 | +145 |
| ui-chat | app/web/src/components/chat-page/section-chat-detail.tsx | `SectionChatDetail` | 删除 | 演进为 section-chat-session.tsx（派生逻辑 fv/bars/modelTag/readOnly 迁入） | 删除前确认全仓无残留 import | ui section-chat-session.md | -289 |
| ui-chat | app/web/src/components/chat-page/use-model-restore.ts | `useModelRestore` | 删除 | chrome 接管 model 回填；token 竞态守卫由 useLifecycle abort+genRef 等价承担 | 同帧清空语义（切 session 旧 model 不残留一帧）由 SectionChatSession key/chrome loading 占位保证——coder 验证无一帧残留 | data_map §3（useModelRestore 不迁条目作废） | -102 |
| ui-chat | app/web/src/components/chat-page/use-run-state.ts | `useRunState()` | 修改 | 签名加第二参 `opts?: {enabled?: boolean}`（缺省 true）；!enabled 或 !sessionId → onInit 不 subscribe 不 GET 返 inert ctx；deps=[sessionId, enabled] | enabled=false MUST 零 SSE 订阅零网络（群聊不多出订阅——context findings 风险1）；enabled=true 行为零变化 | tech assembly §2.4 | +14 |
| ui-chat | app/web/src/components/chat-page/use-summary.ts | `useSummary()` | 修改 | 同款 enabled 门（!enabled → 不 subscribe，ctx 恒 null） | 同上 | tech assembly §2.4 | +10 |
| ui-chat | app/web/src/components/chat-page/page-chat.tsx | `PageChat()` | 修改 | 瘦身：删 5 area-hooks compose/useModelRestore/useLoadMore/HITL·send·abort·compact·clear·model·effort·approval 接线，主区改 `<SectionChatSession key={viewedSessionId} sessionId={viewedSessionId || null} emptyStateSlot={<ComponentEmptyState onNewConversation={handleCreate}/>} rootTag="section"/>`；保留 conv-panel/三栏/workspace-panel/subagent 树接线 | 目标 ~120 行；conv-panel 与 workspace-panel 的 props 接线零变化 | ui section-chat-session.md 消费方清单；page-chat 现状头注 | +30/-120 |
| ui-chat | app/web/src/components/chat-page/use-chat-actions.ts | `useChatActions()` | 修改 | 删 handleSend/handleEnqueueCancel/handleCompact/handleClear/handleModelChange/handleEffortChange/handleApprovalModeChange（入 SectionChatSession）；保留 openSession/handleCreate/handleDelete/handleRenameTitle/handleSelectSub；参数列表同步裁剪（messages/model/setModel 等不再需要） | 保留 handler 函数体零变化 | page-chat 行 | +10/-130 |
| ui-chat | app/web/src/components/chat-page/use-subagent-run-refresh.ts | `useSubagentRunRefresh` | 删除 | subagent 只读 transcript 实时性由 useMessages 的 agent_loop 订阅承担（academy session-readonly 同款已验证）；use-page-chat-mount.ts 去 handleSubRunMeta 接线 | **开放点（coder 验证）**：确认 run 结束 transcript 无丢帧；若有丢失场景改为 SectionChatSession 内部 session_meta 补拉并汇报偏离 | tech assembly §4；chat_area_hooks §3 | -105 |
| ui-chat | app/web/src/components/chat-page/use-page-chat-mount.ts | `usePageChatMount()` | 修改 | 删 handleSubRunMeta 参数与调用（配合上行）；其余（拉列表+session_meta 订阅+subagent children 刷新）不变 | 列表/红点行为零变化 | 同上 | +2/-12 |

### D. studio 迁移

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | app/web/src/components/studio-page/component-studio-chat-router.tsx | `StudioChatRouter()` | 修改 | useStudioChatChrome→useChatChrome；workspaceSemantic 由 chrome 派生（groupRender 或对端 member.role==='leader'→'team'；mate→'personal'，对端 = members.find(id===memberId)）；chatPage 改渲 `<SectionStudioChat key={node.sessionId} chrome={chrome} .../>` | chrome 经 prop 下传（防双拉——tech assembly §2.6）；key={sessionId} remount 语义保留；loading 占位/SectionRightTabs 接线不变 | tech assembly §2.6；router 现状头注 | +20/-25 |
| ui-studio | app/web/src/components/studio-page/section-studio-chat.tsx | `SectionStudioChat()` | 新增 | studio 薄壳（残留身份要素）：topbarLeft render-prop（单聊=ChatTopbarBackBtn+MemberAvatar+name+tag；群聊=back+title+tag，按 chrome.memberId/members 渲）+ SectionChatSession(chrome 注入, prefill, fadeIn, rootTag='main', onBack, backActionKey='studio.{member\|group}-chat.back') | ≤100 行；MUST NOT 挂 area-hooks/handler/HITL 接线（能力清单第 4 条）；空态文案 studio:chat.emptyHint 经 emptyStateSlot | ui section-chat-session.md 消费方清单；base-chat-page.md 能力清单 | +95 |
| ui-studio | app/web/src/components/studio-page/section-member-chat.tsx | `MemberChatPage` | 删除 | 被 SectionStudioChat+SectionChatSession 取代 | 删除前确认无残留 import（含 page-studio/router）；__tests__/section-member-chat.test.tsx 迁移断言到新壳或删 | ui section-chat-session.md | -243 |
| ui-studio | app/web/src/components/studio-page/section-squad-chat.tsx | `SquadChatPage` | 删除 | 同上（群聊白名单/actor 策略已迁 chat-actor-strategy） | 同上；INV-E3（群聊无 run 态）由 capabilities.runState=false + enabled 门等价承接 | 同上 | -261 |
| ui-studio | app/web/src/components/studio-page/component-member-chat-input-bar.tsx | `ComponentMemberChatInputBar` | 删除 | 被 component-chat-session-input 取代 | — | 同上 | -181 |
| ui-studio | app/web/src/components/studio-page/use-studio-chat-chrome.ts | `useStudioChatChrome` | 删除 | 被 useChatChrome（后端聚合）取代；GET /session+GET /squad 两跳收敛为 chrome 一跳 | __tests__/use-studio-chat-chrome.test.ts 删；等价断言迁 use-chat-chrome UT | data_map §6（doc-modifier 阶段5作废该节） | -222 |
| ui-studio | app/web/src/components/studio-page/squad-chat-helpers.tsx | 全部导出 | 删除 | 迁至 chat-page/chat-actor-strategy.tsx（C 段行） | __tests__/squad-chat-helpers.test.ts 随迁 chat-page | C 段 chat-actor-strategy 行 | -125 |

### E. academy 迁移

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-academy | app/web/src/components/academy-page/section-classroom-detail.tsx | ht-col 渲染段 | 修改 | ComponentAcademyChatCol+useAcademyChatUsage 展开 → `<SectionChatSession sessionId={classroom.headTeacherSessionId} topbarLeft={班主任 avatar header} placeholder=.../>`；删 defaultModelId/ProviderId 透传（chrome 供） | 能力从无到有全开（HITL 两卡/abort/两 picker/enqueue/minimap/悬浮菜单——PRD §2.1 矩阵）；ht-col 可拖宽包装（handle+width）不变 | PRD §2.1；ui section-chat-session.md | +20/-25 |
| ui-academy | app/web/src/components/academy-page/section-training-observe.tsx | chat-col 渲染段 | 修改 | 同上改 SectionChatSession（coach session）+ **保留 onMessagesChange={handleMessagesChange}**（消息驱动任务刷新残留，后端无 training.* SSE） | onMessagesChange 只用于任务刷新，MUST NOT 用于回收 messages 建 UI（tech assembly §2.5）；防 use-training-task 死循环链路不回归（软刷新 mutateCtx 机制不动） | PRD §2.1；use-training-task.ts 头注 | +18/-22 |
| ui-academy | app/web/src/components/academy-page/section-version-chat.tsx | `VersionChatLoaded()` | 修改 | 删自挂 useUsage/useSummary/useFlattenedView/deriveMinimapBars/topbarRight/rightOverlaySlot/clear state/onMessagesChange minimap 回收（全内置）；只剩包装 div + SectionChatSession(topbarLeft, placeholder) + SectionWorkspacePanel | **风险2 消除**：MUST NOT 再经 onMessagesChange 回收 messages（防双 useMessages 双订阅）；minimap/usage/float-menu 行为与 v0.0.215 一致 | context findings 风险2；tech assembly §2.5 | +15/-60 |
| ui-academy | app/web/src/components/academy-page/component-session-readonly.tsx | `SessionReadonlyView()` | 修改 | ComponentAcademyChatCol readOnly → SectionChatSession（chrome.readOnly=derivation subagent 自动 true；prop readOnly 冗余保留作双保险）+ topbarLeft + onBack | 只读语义零回归：无输入区/无 picker/无 HITL/无 stop（PRD §2.2 UC-6）；gold banner 不变 | PRD §2.2；api 04a §4 readOnly 覆盖层 | +8/-8 |
| ui-academy | app/web/src/components/academy-page/component-academy-chat-col.tsx | `ComponentAcademyChatCol` | 删除 | 被 SectionChatSession 取代（硬编码 pendingToolCall=null/enqueueItems=[] 降级消灭——投诉原点） | 删除前确认 4 消费方全迁 | req.md 背景；ui section-chat-session.md | -267 |
| ui-academy | app/web/src/components/academy-page/use-academy-chat-usage.tsx | `useAcademyChatUsage` | 删除 | usage 三件套内置化；__tests__ 同删 | usage「保持不回归」（v0.0.212 已拉齐，PRD findings） | context findings [prd 12:05] | -56 |

### F. 列宽收敛 + subagent 树收敛

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-common | app/web/src/components/common/use-persistent-width.ts | `clampColWidth/readColWidth/writeColWidth/usePersistentWidth` + `PersistentWidthOptions/PersistentWidthState` | 新增 | 自 academy use-resizable-col.ts 纯迁移（hook 更名 usePersistentWidth，返回形 {width,onResize,onResizeEnd,minWidth,maxWidth} 不变）；UT 随迁 | 逐行等价迁移；localStorage key 语义不变（用户已存宽度不失效） | academy _overview §2 可拖宽列约定 | +100 |
| ui-academy | app/web/src/components/academy-page/academy-col-widths.ts | `ACADEMY_COL` | 新增 | 常量表自 use-resizable-col.ts 迁出（ht/train/versionConv 三行，key/默认/上下限不变） | 常量值零变化 | academy _overview §2 表 | +25 |
| ui-academy | app/web/src/components/academy-page/use-resizable-col.ts | 整文件 | 删除 | 三消费 section（classroom-detail/training-observe/version-chat）改 import common usePersistentWidth + academy-col-widths | — | F 段上两行 | -102 |
| ui-chat | app/web/src/components/chat-page/use-three-col-layout.ts | `readConvWidth/persistConvWidth` | 修改 | 内部读写/clamp 改调 common readColWidth/writeColWidth/clampColWidth（key `conv-panel-width`/默认 220/180~400 不变） | 行为零变化（重复实现消除，非语义变更） | req.md 收敛条；F 段 common 行 | +6/-18 |
| ui-chat | app/web/src/components/chat-page/workspace-storage.ts | 宽度 read/write helper | 修改 | 宽度读写/clamp 改调 common 纯函数（per-session key 工厂不变；collapsed 逻辑不动） | 行为零变化 | 同上 | +5/-12 |
| ui-chat | app/web/src/components/chat-page/component-subagent-tree.tsx | `ComponentSubagentTree` Props | 修改 | 加可选 `onOpenNode?: (sessionId)=>void`（running 行渲「观察 →」链接，替代 academy 平行实现）+ 可选文案注入（terminated 折叠标签）；缺省不渲新 UI | 既有消费方（playground conv-panel 侧树）零视觉/行为变化（新 props 缺省） | chat-page component-subagent-tree.md；academy 平行版行为 | +30 |
| ui-academy | app/web/src/components/academy-page/component-subagent-tree.tsx | `ComponentSubagentTree`（academy 平行版） | 删除 | component-train-view-col.tsx 改 import chat-page 版（传 onOpenNode + academy 文案） | 训练观察 subagent 观察入口行为零变化（running 可点/terminated 折叠灰显） | academy _overview §1 树 | -73 |
| ui-academy | app/web/src/components/academy-page/component-train-view-col.tsx | subagent 树引用段 | 修改 | import 切换 + props 适配（running/terminated/onOpenNode） | 行为零变化 | 同上 | +6/-4 |

## 本版本组件 spec 清单（coder 编码前置，标准见 _conventions.md）

| spec 文件 | 操作 | 归属目录 | 负责 |
|---|---|---|---|
| chat-page/section-chat-session.md | 已建（architect） | chat-page/ | 本版权威，coder 实现前细化视觉基线如需 |
| chat-page/base-chat-page.md | 已改（consumers + 消费方必备能力清单） | chat-page/ | — |
| studio-page/section-studio-chat.md | 新建 | studio-page/ | coder 编码前置（薄壳：topbarLeft 两形态 + 可见文案） |
| studio-page/member-chat-page.md / squad-chat-page.md | 改存根（指向 section-chat-session + section-studio-chat） | studio-page/ | doc-modifier 阶段5（渲染策略契约段迁 chat-actor-strategy 注释/UT） |
| academy-page/_overview.md §2/§3 | 更新（收敛替代 + use-persistent-width 指向） | academy-page/ | doc-modifier 阶段5 |
| chat-page/component-subagent-tree.md | 更新（onOpenNode 可选 prop） | chat-page/ | coder 编码前置 |

## 影响面评估

- **跨模块**：server（chrome 服务/路由 + model-resolver）+ web（chat-page 统一装配层 + studio/academy/playground 三板块迁移 + common 列宽）。净变化约 +1,400 / -2,400（净删 ~1,000 行装配代码，符合 req 目标）。
- **依赖顺序（planner 切 task 依据）**：① A+B 后端（chrome 端点 + resolver academy 分支，可并行）→ ② C 统一装配层（依赖 ① 的接口 shape；enabled 门/actor-strategy 可先行）→ ③ D/E/F 三板块迁移与收敛（依赖 ②；D/E/F 相互独立可并行）→ ④ 清理删除行（全部消费方迁完后执行，typecheck 守门）。
- **破坏性变更**：无对外 API 破坏（chrome 为纯新增；PUT /session 不变）。前端删 8 文件 + 改 7 页装配——回归风险集中在「零回归契约」（PRD §2.4）：playground/studio HITL/enqueue/usage/minimap/拖拽逐项核对。
- **风险点**：
  1. 群聊 SSE 订阅膨胀 → enabled 门（C 段 useRunState/useSummary 行）钉死「enabled=false 零订阅零网络」。
  2. version-chat 双 useMessages → E 段 version-chat 行钉死「禁 onMessagesChange 回收 messages」。
  3. use-subagent-run-refresh 删除为**开放点**（C 段行）——coder 验证 subagent transcript 实时性，有丢帧改内部补拉并汇报偏离。
  4. useLoadMore 依赖 useMessages 实例——已内置于 SectionChatSession，消费方无需接线。
  5. 打包护栏：本版无新第三方依赖 / 无新 plugin / 无新 env 键 / 无路径拼接 → packaged 四类陷阱不触发。
- **测试口径**（test-plan 输入）：chrome 端点/capabilities 表/resolver academy 链 = UT（确定性契约不进 AT）；PRD 路径 1-3（academy HITL/abort/effort）按冒烟集铁律在 test-plan 裁定；路径 4 零回归走既有 chat ET 冒烟 + UT。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列——尤其「零 kind 分支」「enabled 零订阅」「readOnly 等价」「禁哑值透传」、影响行严重偏离）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
- coder 对实现细节有最终决策权（如文件内部拆分、helper 命名）；偏离本表具体行须向 orchestrator 汇报（偏离项+理由+影响范围）。核心约束（同构 shape / capabilities 静态表 / 零 kind 分支 / v0.0.152 群聊裁决 / academy 全开）不可擅自偏离。
