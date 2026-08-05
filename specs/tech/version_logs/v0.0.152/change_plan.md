# v0.0.152 变更计划书 — squad 单聊补齐 effort + 审批模式 picker + 审批卡

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 范围：纯前端 UI 挂载点扩展（复用 v0.0.148 session 级 effort/approvalMode 能力）+ studio 单聊补渲染审批卡（修 need_approval 悬挂缺陷）。**零后端改动、零 API 契约变更**。PRD：`specs/prd/version_logs/v0.0.152/change_log.md`（已用户确认）。

## 0. 零变更引用（server 端，供 reviewer 对照——本表不列这些文件的变更行）

已逐一 grep 核实以下三处对齐 PRD §0 声明，session 级 effort/approvalMode 注入链路不分 scope（playground 与 studio session 走同一 chokepoint），**本版本 server 端零改动**：

| 文件 | 符号 | 已就绪证据（已核实存在） |
|---|---|---|
| `app/server/src/handlers/session-config.ts` | `buildSessionConfigFromDeps()` | L305-308：`...(sessionPersist.effort !== undefined ? {effort:...} : {})` + `approvalMode` 同构注入，[v0.0.148] 标注，不判断 bizType/scope |
| `app/server/src/bootstrap.ts` | studio session 构造调用点 | L599 起调 `buildSessionConfigFromDeps(...)`，L622-623 显式透传 `effort: session.effort, approvalMode: session.approvalMode`（[v0.0.148] 标注），与 playground POST /messages 同一函数、同一字段 |
| `app/server/src/tools/engine.ts` | `ToolExecutionEngine`（ask 分支） | L196 起 `isGreenlight = config.approvalMode === 'greenlight'`，短路逻辑不区分 session 来源 |

前端 `app/web/src/lib/chat-api.ts` 的 `updateSession()`（L67-87）与 `Session` 类型（`chat-page/types.ts:189-199`）已含 `effort`/`approvalMode` 字段（v0.0.148 交付），本版本**不改此文件**，直接复用。

## 1. 组件-数据源拆解（对齐 `[P0]component_data_map.md §6`，用户 pre-coding 硬门禁）

`useStudioChatChrome` 是已存在的 GET-once 非 area-hook（不订 SSE），本版本增量扩展其 ctx 形状与命令式 setter，**不改变其"GET-once 不订阅"定性**：

| 数据形 | topic | 读 API | 触发 | 契约草案 |
|---|---|---|---|---|
| `Snapshot<StudioChatChrome>`（扩展） | 无（非 SSE） | `GET /session`（onInit 内已发生的同一次请求，新增读 `s.effort`/`s.approvalMode`，**不新增请求**） | mount / `sessionId` 变 → onInit 重查；用户切 picker → `setEffort`/`setApprovalMode` 命令式 `mutate` 本地乐观写（不重查、不 reload） | `StudioChatChrome` 新增只读字段 `effort`/`approvalMode`；`UseStudioChatChromeResult` 新增两个 write-through setter（乐观 `mutate` + fire-and-forget `PUT /session/:id`） |

## 2. 300 行红线评估（`section-member-chat.tsx` 现状 335 行，已超线——预防性拆分）

`section-member-chat.tsx` 当前 **335 行**（`wc -l` 已核实），已是既存超线债务；本版本若直接内联两 picker + 审批卡分流（预估 +31 行）将推到 ~366 行，进一步恶化。**拆分方案**：把原输入区（L260-321，ChatComposer + 按钮行 + HITL 卡 + 本地 handler：`composerRef`/`memberModelSel`/`handleModelChange`/`handleInherit`/`handlePickerChange`/`handleSend`/`handleEnqueueCancel`/`error` state，合计约 102 行逻辑）整体抽到新组件 `component-member-chat-input-bar.tsx`。

- **`section-member-chat.tsx` 预计**：335 - 102（移出）- 12（移出后不再需要的 import）+ 3（新 import）+ 22（新增 4 props 声明 + wrapper 透传）+ 20（新组件单次调用点）≈ **266 行**，在红线内留 ~34 行安全余量。
- **`component-member-chat-input-bar.tsx` 预计**：文件头 10 + import ~22 + props 接口 ~40 + handler ~43 + JSX ~70 ≈ **185 行**，远低于红线。

## 3. 文件级变更清单（摘要）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/web/src/components/studio-page/use-studio-chat-chrome.ts` | 修改 | ctx 新增 `effort`/`approvalMode` 只读字段 + 新增 `setEffort`/`setApprovalMode` 命令式 setter |
| `app/web/src/components/studio-page/component-member-chat-input-bar.tsx` | 新增 | 承接原输入区全部渲染 + 本地 handler（含两新 picker + HITL 卡 subState 分流） |
| `specs/ui/components/studio-page/component-member-chat-input-bar.md` | 新增（coder 编码前置） | 新组件 spec，按 `_conventions.md §6` 模板 |
| `app/web/src/components/studio-page/section-member-chat.tsx` | 修改 | 移出输入区逻辑到新组件；wrapper 透传 4 新 props |
| `specs/ui/components/studio-page/member-chat-page.md` | 修改（coder 编码前置） | input-bar 5 控件布局 + 审批卡挂载点 + 顺带修正过时的 run 态引用 drift |
| `specs/tech/app/frontend/[P0]component_data_map.md §6.2` | 修改（coder 编码前置） | `useStudioChatChrome` 契约块补 effort/approvalMode 字段 + 两 setter |
| `app/web/src/components/studio-page/__tests__/use-studio-chat-chrome.test.ts` | 修改 | 新增 effort/approvalMode 回填 + setter 乐观写用例 |
| `app/web/src/components/studio-page/__tests__/section-member-chat.test.tsx` | 修改 | mock 补 4 新字段；迁出输入区专属用例 |
| `app/web/src/components/studio-page/__tests__/component-member-chat-input-bar.test.tsx` | 新增 | 承接迁出用例 + 两 picker + 审批卡分流新用例 |
| `app/web/src/components/studio-page/__tests__/section-squad-chat.test.tsx` | 修改 | 新增 1 条负向断言（两 picker 不渲染） |

## 4. 变更清单（8 列，行 = 一个函数/符号）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio-chat | app/web/src/components/studio-page/use-studio-chat-chrome.ts | `StudioChatChrome`（interface） | 修改 | 新增只读字段 `effort: EffortLevel \| null`、`approvalMode: ApprovalMode \| null`，值取自 onInit 内已执行的 `getSession(sessionId)` 响应（`s.effort ?? null` / `s.approvalMode ?? null`） | MUST NOT 新增网络请求；类型对齐 `chat-api.ts` 的 `Session.effort`/`Session.approvalMode` | `[P0]component_data_map.md §6.2`；本文件 §1 拆解表 | +4 |
| studio-chat | 同上 | `UseStudioChatChromeResult`（interface） | 修改 | 新增两个命令式字段：`setEffort: (level: EffortLevel) => void`、`setApprovalMode: (mode: ApprovalMode) => void` | MUST 签名与 `InputEffortPicker.onChange`/`InputApprovalModePicker.onChange` 完全一致（已核实：`component-input-effort-picker.tsx:37`、`component-input-approval-mode-picker.tsx:38`） | 同上；两 picker 组件源文件 | +4 |
| studio-chat | 同上 | `useStudioChatChrome()` | 修改 | ① onInit 内 `getSession` 解构补 `effort`/`approvalMode` 写入 return；② `useLifecycle` 解构增取 `mutate`；③ 新增 `setEffort`/`setApprovalMode` 两 `useCallback`：各自 `mutate(c => c ? {...c, effort/approvalMode: 新值} : undefined)` 乐观写 + fire-and-forget `updateSession(sessionId, {effort/approvalMode})`（`.catch` 仅 `console.warn`）；④ 最终 return 补两 setter | MUST `mutate` updater 对 `c===null` 分支返回 `undefined`（不是 `null`——`TCtx=StudioChatChrome` 非空类型，`mutateCtx` 契约「返回 void 才跳写」，见 `use-lifecycle.ts:256-260`）；MUST NOT 调 `reload()`/重新 GET；MUST 新增 import `updateSession`（`chat-api.ts` 已导出） | `use-lifecycle.ts` mutateCtx 契约；`page-chat.tsx:163-183`（同构乐观更新范式，已核实存在） | +26 |
| studio-chat | app/web/src/components/studio-page/component-member-chat-input-bar.tsx | `ComponentMemberChatInputBar()` + `MemberChatInputBarProps`（新文件） | 新增 | 承接原 `section-member-chat.tsx` 输入区全部渲染与本地逻辑：ChatComposer + 按钮行（`[审批模式picker][effort picker][InputModelPicker][send][stop]`）+ `ComponentRunStateBar`（enqueue 排队区）+ HITL 卡 `subState` 分流（`need_approval`→`ComponentPendingApprovalCard`／`need_feedback`→`ComponentPendingQuestionCard`，`onSubmit` 统一走 `submitReply`）+ 发送错误提示行；内部持有 `composerRef`/`memberModelSel`/`handleModelChange`/`handleInherit`/`handlePickerChange`（`patchMember`）/`handleSend`（`postMessage`）/`handleEnqueueCancel`（`cancelEnqueue`）/`error` 本地 state（均从原文件原样迁入，逻辑不变） | MUST 按钮行顺序 `[审批模式][effort][模型选择][发送][停止]`（PRD §2.2 图示 + `section-chat-detail.tsx:352-395` 挂载顺序范式）；MUST subState 分流镜像 `section-chat-detail.tsx:314-326`（两卡互斥挂载，`key={pendingToolCall.toolCallId}`）；MUST NOT 引入 `postMessage`/`patchMember`/`cancelEnqueue`/`updateSession` 之外的新调用路径（零 API 契约变更）；MUST 复用 `CHAT_ACTION_BTN_CLS`/`SendIcon`（不新造样式）；单文件 ≤300 行（预计 ~185 行，见 §2） | PRD §2.2/§3.2/§4.2；`component-pending-approval-card.md §复用关系`；`section-chat-detail.tsx:314-395`（已核实存在） | +200（新文件） |
| studio-chat | specs/ui/components/studio-page/component-member-chat-input-bar.md（新文件，`.md`+`.tsx` 双件之一） | 新组件 spec | 新增（coder 编码前置，先 spec 后实现） | 按 `_conventions.md §6` 模板：层级=component；职责=studio 单聊输入区；Props 对齐上一行；testid 列 `chat-approval-mode-picker`/`chat-effort-picker`/`chat-model-picker`/`squad-chat-send`/`chat-abort`/`pending-approval-{id}`（全部复用既有 testid，**不新增**）；复用关系写明「组合 InputApprovalModePicker/InputEffortPicker/InputModelPicker/ChatComposer/ComponentPendingApprovalCard/ComponentPendingQuestionCard/ComponentRunStateBar，被 section-member-chat.tsx 组合」 | MUST 先 spec 后实现；无设计稿→视觉基线字段引用「复用 playground 视觉基线」（PRD 头部已声明） | `_conventions.md §5/§6/§8` | 新文件 ~60 行 |
| studio-chat | app/web/src/components/studio-page/section-member-chat.tsx | `MemberChatPage()` | 修改 | wrapper 解构 `useStudioChatChrome` 结果增取 `setEffort, setApprovalMode`；`<MemberChatPageLoaded>` 调用增补 4 props：`effort={chrome.effort} approvalMode={chrome.approvalMode} onEffortChange={setEffort} onApprovalModeChange={setApprovalMode}` | MUST NOT 改变现有 chrome loading/error 门控分支（`ChatLoadingFallback` 行为不变） | 上方 3 行（本表内） | +5 |
| studio-chat | 同上 | `MemberChatPageLoaded()` | 修改 | ① 函数签名新增 4 入参（effort/approvalMode/onEffortChange/onApprovalModeChange）；② 删除已迁出的本地逻辑：`composerRef`/`memberModelSel`/`handleModelChange`/`handleInherit`/`handlePickerChange`/`handleSend`/`handleEnqueueCancel`/`error` state（迁至新组件行）；③ 原 L260-321 输入区 JSX 整段替换为单次 `<ComponentMemberChatInputBar .../>` 调用（透传 sessionId/member/squadId/squadModelDefault/prefill/sessionRunning/sessionState/enqueueItems/pendingToolCall/submitReply/clearPendingToolCall/effort/approvalMode/onEffortChange/onApprovalModeChange/onAbort） | MUST NOT 改变 topbar（角色头像/tag/usage/compact/clear）与消息区（`ComponentMessageStream`/右缘 overlay）渲染逻辑；MUST 保留 `clearModalOpen` state + `ComponentClearConfirmModal`（clear 按钮在 topbar、modal 是独立浮层，不属于输入区）；MUST 移除随迁移不再使用的 import（`patchMember`/`PatchMemberBody`/`ChatComposer`+`ChatComposerHandle`/`ComponentPendingQuestionCard`/`ComponentRunStateBar`+`ComponentRunStateAbortSlot`/`InputModelPicker`/`parseModelRef`+`ModelSelection`/`SendIcon`/`CHAT_ACTION_BTN_CLS`/`resolveMentionProviders`/`postMessage`/`cancelEnqueue`）；单文件 ≤300 行（预计 ~266 行，见 §2） | 上方新组件行；`member-chat-page.md`（下一行） | +22/-102 |
| studio-chat | specs/ui/components/studio-page/member-chat-page.md | §Props/§状态交互/§视觉基线/§testid（input-bar 段）+ §复用关系 | 修改（coder 编码前置，先 spec 后实现） | input-bar 布局从 3 控件（InputModelPicker/stop/send）扩到 5 控件（approval-mode/effort/InputModelPicker/send/stop）；补 HITL `subState` 分流挂载点说明（镜像 playground）；渲染主体改为组合 `component-member-chat-input-bar.tsx`（§复用关系新增一行）；**顺带修正** architect 核实发现的既存 drift——现状文档仍写单一 `useSessionRunState` 引擎，代码已是 v0.0.94 起拆分的 5 个独立 area-hooks（`useMessages`/`useRunState`/`useUsage`/`useSummary`/`useSessionPanelFanout`），非本版新增改动，一并订正 | MUST 编码前置完成；MUST NOT 与 doc-modifier 阶段 5 待办重复（`squad-chat-page.md`/`component-pending-approval-card.md §复用关系`/prd overall 由 doc-modifier 统一处理，见 PRD §10） | PRD §10 spec 待同步清单；`_conventions.md §5/§6` | ~+15 行（差异编辑） |
| studio-chat | specs/tech/app/frontend/[P0]component_data_map.md §6.2 | `useStudioChatChrome` 契约块 | 修改（coder 编码前置） | 契约新增 `effort`/`approvalMode` 只读字段 + `setEffort`/`setApprovalMode` 命令式 setter，对齐本文件 §1 拆解表 | MUST 保持「不是 area-hook / 不订 SSE / GET-once」定性不变（本次只加乐观本地写，未引入订阅） | 本文件 §1 | ~+8 行 |
| studio-chat(UT) | app/web/src/components/studio-page/__tests__/use-studio-chat-chrome.test.ts | 新增 `it()` 用例 | 修改 | 覆盖：① `getSession` mock 返回体含 `effort:'high', approvalMode:'greenlight'` → `chrome.effort/approvalMode` 正确回填；② 缺省 → `chrome.effort/approvalMode` 为 `null`；③ 调 `result.current.setEffort('max')` → `chrome.effort` 立即变 `'max'`（无需 `waitFor` 新 GET）+ `updateSessionMock` 被调 `('sess-x', {effort:'max'})`；④ 同构覆盖 `setApprovalMode('greenlight')`；⑤ `mkSession` helper 增补可选 `effort`/`approvalMode` 入参 | MUST mock `chat-api` 新增 `updateSession`（`vi.hoisted` 绝对路径，同现有 `getSession`/`getSquad` mock 风格） | 本文件现状 L21-34（已核实存在）；本表 useStudioChatChrome 行 | +40 |
| studio-chat(UT) | app/web/src/components/studio-page/__tests__/section-member-chat.test.tsx | mock 工厂 + 用例迁移 | 修改 | ① `useStudioChatChrome` mock 默认返回体补 `effort: null, approvalMode: null, setEffort: vi.fn(), setApprovalMode: vi.fn()`（原 L84-92 附近，否则新增 4 props 透传 `undefined`）；② 迁出输入区专属用例到新文件：model picker `patchMember`（原 L366-392）、ChatComposer 渲染/`postMessage` 接线（原 L248-257）、HITL 提问卡相关用例；③ 本文件保留 topbar/消息流/chrome-loading 占位相关用例 | MUST 保留既有 testid 断言不变（`squad-chat-page`/`squad-chat-messages`/`squad-chat-role-avatar` 等黑盒行为不变，仅内部实现拆分） | 本文件现状 507 行、L26-107 mock 结构（已核实存在） | +8/-约230（迁出非删除） |
| studio-chat(UT) | app/web/src/components/studio-page/__tests__/component-member-chat-input-bar.test.tsx（新文件） | 新增用例集 | 新增 | 覆盖：① 渲染两 picker（`chat-approval-mode-picker`/`chat-effort-picker`）+ 缺省态显示；② 选 `effort='high'` → `onEffortChange('high')` 被调；③ 选 `approvalMode='greenlight'` → `onApprovalModeChange('greenlight')` 被调；④ `pendingToolCall.subState='need_approval'` → 渲 `pending-approval-{id}`（不渲问题卡）；⑤ `subState='need_feedback'` → 渲问题卡（不渲审批卡）；⑥ ChatComposer send → `postMessage` 调用；⑦ 迁入的 model picker `patchMember` 用例 | MUST mock `ChatComposer` 绝对路径桩（`forwardRef`+`useImperativeHandle` 暴露 `send()`，同 `input-bar-send-stop-layout.test.tsx` 范式，规避 `@tiptap` 依赖）；MUST mock `chat-api`（`postMessage`/`cancelEnqueue`）+ `squad-api`（`patchMember`） | `chat-page/__tests__/input-bar-send-stop-layout.test.tsx`（已核实存在）；PRD UC-1/UC-2/UC-3/UC-4/UC-7 | +220（新文件） |
| studio-chat(UT) | app/web/src/components/studio-page/__tests__/section-squad-chat.test.tsx | 新增 `it()` 用例 | 修改 | 新增 1 条：渲染群聊入口后断言 `screen.queryByTestId('chat-effort-picker')`/`queryByTestId('chat-approval-mode-picker')` 均为 `null`，锁定 PRD §5 裁决边界（UC-8 的 UT 层等价覆盖） | MUST NOT 修改 `section-squad-chat.tsx` 本身（零产品代码变更，纯新增回归断言） | PRD §5.3「范围声明」+ UC-8 | +12 |

## 5. 影响面评估

- **模块面**：仅 `studio-chat`（`app/web/src/components/studio-page/`）一个前端模块；不涉及 `app/server`、`packages/`、API 契约、DB schema。
- **破坏性变更**：无。`MemberChatPageProps`（对外 props，`sessionId`/`onOpenMember`/`prefill`）不变——`component-studio-chat-router.tsx` 等调用方零改动。`useStudioChatChrome` 对外类型是**扩展**（新增字段/方法），非破坏性。
- **依赖顺序**：① `use-studio-chat-chrome.ts` 契约扩展（表格前 3 行）→ ② 新组件 `component-member-chat-input-bar.tsx`（依赖①的 setter 类型）→ ③ `section-member-chat.tsx` 改造（依赖①②）→ ④ 两处 spec 文档（可与①②并行，编码前置）→ ⑤ UT（依赖①②③落地后补齐，含既有用例迁移）。
- **风险点**：
  1. `section-member-chat.test.tsx` 的输入区用例迁移是本计划最大工作量项（507 行文件中约 230+ 行需重新落位到新文件），coder 须逐条核对迁移后断言语义不变，不得丢用例。
  2. `mutate` 的 `c===null` 分支若误返回 `null` 而非 `undefined` 会导致 TS 类型报错或运行时把 chrome 置空——按本表约束严格实现。
  3. `member-chat-page.md` 现状已有 run 态引擎描述 drift（先于本版本存在），coder 顺手修正时注意不要引入新的不一致表述。

## 6. 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离、任一改动文件超 300 行）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
