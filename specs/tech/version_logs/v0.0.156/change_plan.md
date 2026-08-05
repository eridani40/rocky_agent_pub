# v0.0.156 变更计划书 — 结构性拆分重构（纯 move + A1 重组不改函数内部）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。
> coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 用户铁律（不可违背 — 贯穿整表）

**纯拆分为主，梳理依赖，不改函数内部逻辑**。
- move 函数/类型/组件到新文件 → **保持签名 + 内部逻辑不变**
- move 前画依赖闭包（符号引用谁/被谁引用），确认无循环、不跨层
- **不改算法/控制流/数据结构/调用语义**
- 唯一例外 = A1（重组）：改组合方式（独立渲染 → BaseChatPage + slot），但**每个被搬的子渲染片段内部 JSX/props/事件 handler 保持等价**

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 内） |
| 函数/符号 | 函数名 / class / interface / type / const（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 「从 X move 到 Y」/「改组合方式」；不写逻辑变更 |
| 约束 | MUST/MUST NOT：依赖闭包结论 + 行为等价 INV 编号 |
| 参考 | spec 位置 / 原则编号 / 参考实现路径 |
| 影响行 | +N / -M |

---

## 0. 依赖闭包前置分析（architect 已 grep + 读代码核实，作为契约基线）

### 0.1 前端 chat-page 模块依赖方向（**不允许反向**）

```
types.ts (leaf，无内部依赖)
  ↑
chat-api.ts (只依赖外部 fetch + types)
use-*.ts area-hooks (依赖 chat-api + types + SSE)
component-*.tsx (依赖 types + 子 component + icons)
base-chat-page.tsx / base-chat-input-bar.tsx (依赖 component-clear-confirm-modal + types)
section-*.tsx / page-chat.tsx (顶层：依赖 base + area-hooks + store + component)
store/chat-slice-reducer.ts (依赖 types，不依赖 component/hook)
```

### 0.2 后端依赖方向（**不允许反向**）

```
agent/session-store-*.ts (leaf：schema/converters/types/state-machine/ops)
  ↑
services/* (model-resolver / squad-service / model-validation)
handlers/* (依赖 services + stores)
bootstrap.ts (顶层装配，依赖各模块)
router.ts (顶层路由，依赖 handlers + bootstrap)
```

### 0.3 循环依赖核对结果

| 模块 | 被谁引用（grep 核实） | 循环风险 | 化解 |
|------|------|------|------|
| types.ts（拆分） | 30 文件 in `chat-page/` + 5 文件 in `studio-page/`（全部 `from './types'` 或 `'../chat-page/types'`） | **无**（leaf，不依赖其他业务模块） | **保留 `types.ts` 作 barrel re-export hub**，子域文件 move 后 types.ts 改为 `export * from './types/message'` 等聚合，**消费方零修改** |
| chat-slice-reducer.ts | `useMessages`（area-hook）+ 单测 | **无**（纯函数 + types 依赖） | 按域拆 reducer 后保留 barrel；消费方零修改 |
| chat-api.ts | 14+ 前端文件（page-chat / section-* / studio-page area-hooks） | **无**（只依赖 fetch + types） | 按模块拆，保留 `chat-api.ts` barrel（`export * from './chat-api/session-api'` 等），消费方零修改 |
| squad.ts checkModel | 仅本文件内部 4 处调用 | **无**（内部 helper） | move 到 `handlers/squad-model-helpers.ts` + handler 文件 import；零下游影响 |
| session-store.ts | bootstrap / handlers / services | **类有 20+ 方法，各 ops 模块已下沉**（session-clear-op / session-workspace-store / session-unread-ops / session-pending-ops / session-children-index 等） | 按"方法组"提取到 `session-store-<group>.ts`（仅 move 逻辑函数，不动 class）；class 留作 facade 持方法签名不变 |
| bootstrap.ts | router.ts（导入 BootstrapResult type） + server main | **BootstrapResult type 被外部消费**（router, testing） | type 留 bootstrap.ts（或抽 `bootstrap-types.ts`），装配实现按阶段拆到 `bootstrap-<phase>.ts`；导出契约不变 |
| router.ts | server main（单点） + 单测 | **无**（dispatch 是顶层） | 按路由组拆 dispatch table 到 `routes-<group>.ts`（纯 (method, path, handler) 映射），主文件聚合；零下游影响 |

### 0.4 核心约束（MUST NOT — reviewer 查偏离）

- **MUST NOT** move 过程中改任何函数的签名 / 实现细节 / 错误处理 / 控制流
- **MUST NOT** move 过程中改 import 顺序破坏单例装配（bootstrap）
- **MUST NOT** move 过程中跨层反向引入（component 不得 import store；reducer 不得 import component；hook 不得 import page）
- **MUST NOT** 引入新的运行时行为（懒加载 / 动态 import / cache 等）；纯静态 move
- **MUST** 每个 barrel re-export 文件保持原导出 surface（`export *` 或显式列表）100% 等价
- **MUST** 拆分前后逐文件 `wc -l` 自检 ≤ 300 行（架构契约文件 + 测试文件豁免）

---

## 1. A1 — playground chat 重组为 BaseChatPage 消费方

### 1.0 边界划分（参考 studio 两页实现，coder 必读：`section-squad-chat.tsx` + `section-member-chat.tsx`）

**进 base（slot 注入，原 JSX 片段整体 move）**：
- 主区 `<section data-testid="chat-page">` → `<BaseChatPage rootTag="section" rootTestid="chat-page">`
- topbar 容器（border-b + shrink-0 + 左右 slot）→ BaseChatPage 内置
- messages wrapper（flex-1 relative overflow-hidden）→ BaseChatPage 内置
- clear modal 挂载 → BaseChatPage 内置（onClear/clearModalOpen/onClearModalChange 三 props）

**保留 playground 专属（slot 注入）**：
- **topbarLeft slot**：`title + (readOnly 时 ComponentReadonlyBadge + chat-model-tag)`（playground 特有：非 readOnly 不渲 picker 在 topbar，picker 在 input slot）
- **topbarRight slot**：inline 内联 `<ComponentUsagePanel> + divider + <CompactBtn> + (!readOnly && <ClearBtn>)`（playground 特有：不用 `<ComponentChatTopbarRight>` 复合组件，保留原顺序与元素 + readOnly 分支内部显隐）
- **messagesSlot**：`<ComponentEmptyState>` 或 `<ComponentMessageStream>`（原 isEmpty 分支 + 全部 props 透传）
- **rightOverlaySlot**：`<ComponentChatRightOverlay> + <ComponentChatFloatMenu>`（hideCron=false，与原一致）
- **inputSlot**：`<BaseChatInputBar>` 消费方实例（hideInputBar 门控：readOnly || !sessionId 时为 true）

**input slot 内部进一步 slot 切（参考 squad-chat buttonRowSlot 模式）**：
- composerSlot = `<ChatComposer biz="playground" ... />`（原 JSX 整块 move）
- buttonRowSlot = `<InputApprovalModePicker>? + <InputEffortPicker>? + <InputModelPicker> + <send-btn> + <ComponentRunStateAbortSlot>`（原按钮行 JSX 整块 move）

### 1.1 变更清单（行 = 符号）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_chat_playground | app/web/src/components/chat-page/section-chat-detail.tsx | SectionChatDetail | 修改 | 从「独立 section + 内联 topbar/messages/input/clear」重组为「BaseChatPage 消费方 + topbarLeft/topbarRight/messagesSlot/rightOverlaySlot/inputSlot slot 注入」 | MUST 保持 ChatDetailProps 签名不变（page-chat 等消费方零改）；MUST 内部逻辑等价（派生 fv/bars/modelTag/isEmpty/readOnly 计算原样保留）；MUST NOT 改 ChatComposer / ComponentMessageStream / InputModelPicker / abort-btn 的 props/事件 handler；MUST keep `data-testid="chat-page"` + `data-testid="chat-topbar"` + `data-testid="chat-input-bar"` + `data-testid="chat-send"` + `data-testid="chat-loading"` 锚点；MUST 群聊成员参考差异（**playground 不传 hideStopButton=true**——保留 useRunState 链，输入区有 stop 按钮；hideCron=false；fadeIn=false i.e. 不传 fadeIn）；MUST INV-A1-1（行为等价） | req §A1；`section-squad-chat.tsx:231-246`（消费范式）；`section-member-chat.tsx:154-235`（input slot 透传范式）；specs/ui/components/chat-page/base-chat-page.md；v0.0.155 change_plan §E | +160/-180 |
| ui_chat_playground | app/web/src/components/chat-page/section-chat-detail.tsx | (ChatDetailProps interface) | 修改 | 字段不变，仅文件内重新挂载到 BaseChatPage；类型注释可保留 | MUST 0 字段变更 | section-chat-detail.tsx:45-138 | +0/-0 |
| ui_chat_playground | app/web/src/components/chat-page/section-chat-detail.tsx | (internal helper: `clearModalOpen` state) | 修改 | clearModalOpen 仍组件自管（与 studio 同款，base 不持 state） | MUST 保留 `const [clearModalOpen, setClearModalOpen] = useState(false)`；onClear 透传给 BaseChatPage | base-chat-page.tsx:44-49 | +0/-0 |
| ui_chat_playground | app/web/src/components/chat-page/section-chat-detail.tsx | 新 import | 修改 | 新加 `import { BaseChatPage } from './base-chat-page'` + `import { BaseChatInputBar } from './base-chat-input-bar'`；保留原所有 import（component-run-state-bar/component-pending-*/component-chat-composer/icons/action-button-styles/component-input-model-picker/effort/approval/use-flattened-view/minimap-bars/component-chat-right-overlay/component-chat-float-menu/component-run-state-bar 等，**原消费的 14 个内部 import 全部保留**——slot 内部仍要用） | MUST 保留全部原 import（slot 内 JSX 仍渲染这些组件） | section-squad-chat.tsx:16-38 参考 import 集 | +2/-0 |

### 1.2 A1 行为等价 INV

- **INV-A1-1 渲染 DOM 等价**：重组后 `data-testid="chat-page"` / `"chat-topbar"` / `"chat-input-bar"` / `"chat-send"` 锚点存在；顶层 DOM 结构（section > topbar + messages-wrapper + input-bar + clear-modal）在 `hideInputBar=false` 时与原实现完全一致（允许 BaseChatPage 内部 div 顺序/className 微差但视觉等价——参考 base-chat-page.tsx:116-144 已有 markup）。
- **INV-A1-2 props/handler 等价**：`onSend` / `onAbort` / `onEnqueueCancel` / `onCompact` / `onClear` / `onModelChange` / `onEffortChange` / `onApprovalModeChange` / `onSubmitReply` / `onLoadMore` / `onNewConversation` 透传路径不变（从 ChatDetailProps → BaseChatInputBar/BaseChatPage slot）。
- **INV-A1-3 readOnly 分支等价**：subagent session 时（`sessionDerivation === 'subagent'`）：hideInputBar=true（不渲染 input slot）；topbarLeft 显示 ComponentReadonlyBadge + chat-model-tag；topbarRight 保留 usage + CompactBtn，不显示 ClearBtn。
- **INV-A1-4 状态机等价**：playground 是 standalone session，保留 run 态（input slot 有 stop 按钮，走 `useRunState` → `<ComponentRunStateAbortSlot>`），**不传 hideStopButton**（与群聊 INV-E3 区分）。

---

## 2. A2 — squad.ts 拆分（提取 squad-model-helpers）

### 2.1 依赖闭包（grep 核实）

| 符号 | 引用 | 被引用 |
|------|------|------|
| `checkModel` | `validateModelId` (from services/model-validation) + `AppConfigService` type | 仅 `handlers/squad.ts` 内 4 处（line 340, 342, 416, 420） |
| `json` (helper) | 无外部依赖 | handler 内多处用 |

### 2.2 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_handler_helper | app/server/src/handlers/squad-model-helpers.ts | checkModel | 新增（move 自 handlers/squad.ts:62-70） | 从 squad.ts move 到独立 helper 文件；签名 `(appConfig: AppConfigService \| undefined, mid: string, providerIdHint?: string) => Response \| null` 不变；内部走 validateModelId | MUST 签名/逻辑/错误码 100% 等价；MUST `export function`（squad.ts 要 import）；MUST 同步 move `json` helper（checkModel 内部调用，move 到同文件或独立 shared）| req §A2；v0.0.155 change_plan 段 B `checkModel` | +20/-0（squad.ts 同步 -10） |
| squad_handler_helper | app/server/src/handlers/squad-model-helpers.ts | json | 新增（move 自 handlers/squad.ts:47-51） | handler 内部共享 json helper；move 后 squad.ts import | MUST NOT 与 router.ts/handlers/session.ts 的 json 重复——本 helper 仅 squad-handler 内部用，**不外泄**（不进 utils）| squad.ts:47-51 | +8/-0 |
| squad_handler | app/server/src/handlers/squad.ts | (imports) | 修改 | 顶部加 `import { checkModel, json } from './squad-model-helpers'`；删本地 function 定义 | MUST 4 处调用点（handleCreateSquad/handlePatchSquad）零改 | squad.ts:340,342,416,420 | +1/-30 |

### 2.3 INV

- **INV-A2-1** `checkModel` 行为等价：空 appConfig 返 null；非空走 validateModelId 返 `{ok,error}` → 失败返 400 JSON
- **INV-A2-2** 4 个调用点语义不变：`handleCreateSquad` body.modelDefault + body.summaryModelDefault 校验；`handlePatchSquad` 字段级 400 优先于 404 校验

---

## 2.5 A3 — page-chat 框架收拾（抽 `use-chat-actions.ts` hook）

> 用户原话「需要」：page-chat 347 行框架逻辑一并收拾。**性质 = 重组（同 A1）**——handler 内部逻辑 100% 不变，仅 move 到 hook，page-chat 变薄。

### 2.5.1 现状（architect 已读 page-chat.tsx 1-347）

职责堆叠：
- store selectors/setters（~15 行，line 51-65 + 84-93 + 107）
- 10 area-hooks 组合（line 73-119）
- **12 handlers**（line 126-265）：openSession / handleModelChange / handleEffortChange / handleApprovalModeChange / handleCreate / handleDelete / handleRenameTitle / handleSend / handleEnqueueCancel / handleCompact / handleClear / handleSelectSub
- 三栏渲染（line 279-344）：SectionConvPanel + SectionChatDetail + SectionWorkspacePanel

### 2.5.2 依赖闭包（grep + 读代码核实）

**12 handlers 的 deps 矩阵**（每个 handler 用到的外部变量）：

| handler | store selectors | store setters | area-hook 返回 | 其他 |
|---|---|---|---|---|
| `openSession(sid)` | `sessions` | `setActiveSession` `setSessionUnread` `setActiveSubId` | - | `markSessionRead`（chat-api）|
| `handleModelChange(sel)` | `activeSessionId` | - | `setModel`（useModelRestore） | `updateSession`（chat-api）|
| `handleEffortChange(level)` | `activeSessionId` `sessions` | `setSessions` | - | `updateSession` |
| `handleApprovalModeChange(mode)` | `activeSessionId` `sessions` | `setSessions` | - | `updateSession` |
| `handleCreate()` | - | `setSessions` | - | `createSession` `listSessions`（chat-api）+ `openSession`（本 hook 内）+ `setError` |
| `handleDelete(id)` | `activeSessionId` | `setSessions` `setActiveSession` `setActiveSubId` | `messages.setMessages` | `deleteSession` `listSessions` + `setError` |
| `handleRenameTitle(id, newTitle)` | - | - | - | `updateSession` |
| `handleSend(content)` | `activeSessionId` | - | `messages.pendingToolCall` `messages.clearPendingToolCall` `model`（useModelRestore） | `postMessage` + `setSendError` |
| `handleEnqueueCancel(_sid, enqueueId)` | `activeSessionId` | - | - | `cancelEnqueue` |
| `handleCompact(sid)` | - | - | - | `postCompact` |
| `handleClear(sid)` | - | - | - | `postClear` |
| `handleSelectSub(subSessionId)` | - | `setActiveSubId` | `resetSubRunBaseline`（useSubagentRunRefresh） | `openSession`（本 hook 内）|

**循环风险**：**无**。handlers 依赖 store + area-hook 返回（messages/model/resetSubRunBaseline），不反向被 area-hook 依赖。handler 间内部依赖仅 `handleCreate → openSession` + `handleSelectSub → openSession`（同 hook 内部互调，外部零感知）。

**chat-api import**：hook 内部 import 9 个 chat-api 函数（cancelEnqueue / createSession / deleteSession / listSessions / markSessionRead / postClear / postCompact / postMessage / updateSession），page-chat 不再直接 import 这些（line 22-32 删除）。

### 2.5.3 hook 接口设计

**`app/web/src/components/chat-page/use-chat-actions.ts`**：

```typescript
// deps（page-chat 透传，闭环 deps 全列出 — 防 stale closure）
interface UseChatActionsDeps {
  // store selectors
  activeSessionId: string | null;
  sessions: Session[];
  // store setters
  setSessions: (updater: Session[] | ((prev: Session[]) => Session[])) => void;
  setActiveSession: (id: string | null) => void;
  setSessionUnread: (id: string, unread: boolean) => void;
  setActiveSubId: (id: string | null) => void;
  // area-hook 返回（types 来自 use-messages / use-model-restore / use-subagent-run-refresh）
  messages: ReturnType<typeof useMessages>;
  model: ModelSelection | null;
  setModel: (sel: ModelSelection | null) => void;
  resetSubRunBaseline: (subSessionId: string) => void;
  // error setters（page-chat local state）
  setError: (e: string | null) => void;
  setSendError: (e: string | null) => void;
}

// return：12 handlers（与 page-chat 原行内 useCallback 签名/实现 100% 等价）
interface UseChatActionsReturn {
  openSession: (sid: string) => Promise<void>;
  handleModelChange: (sel: ModelSelection) => void;
  handleEffortChange: (level: 'default' | 'low' | 'high' | 'max') => void;
  handleApprovalModeChange: (mode: 'normal' | 'greenlight') => void;
  handleCreate: () => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
  handleRenameTitle: (id: string, newTitle: string) => void;
  handleSend: (content: string) => Promise<void>;
  handleEnqueueCancel: (_sid: string, enqueueId: string) => void;
  handleCompact: (sid: string) => void;
  handleClear: (sid: string) => void;
  handleSelectSub: (subSessionId: string) => void;
}

export function useChatActions(deps: UseChatActionsDeps): UseChatActionsReturn;
```

### 2.5.4 page-chat 变薄后结构（预期 ≤ 200 行）

```typescript
export function PageChat() {
  // ① store selectors/setters（~10 行）
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  // ... 6 行 store
  const childrenByParent = useChatStore((s) => s.childrenByParent);
  const activeSubId = useChatStore((s) => s.activeSubId);

  // ② 10 area-hooks（~15 行，不动）
  const viewedSessionId = activeSubId ?? activeSessionId ?? '';
  const messages = useMessages(viewedSessionId);
  const runState = useRunState(viewedSessionId);
  const usageHook = useUsage(viewedSessionId);
  const summaryHook = useSummary(viewedSessionId);
  useSessionPanelFanout(viewedSessionId);
  const { handleMetaChange: handleSubRunMeta, resetBaseline: resetSubRunBaseline } = useSubagentRunRefresh(messages.setMessages);
  const { isLoadingMore, loadMore } = useLoadMore(viewedSessionId, messages);
  const { model, setModel } = useModelRestore(activeSessionId, openSessionTokenRef, activeSessionIdRef);
  const { refreshChildren, fetchedRef: childrenFetchedRef } = useSubagentChildren();

  // ③ local state（error / sendError）+ ref（~5 行）
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const openSessionTokenRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // ④ mount lifecycle（不动，~5 行）
  usePageChatMount({ setSessions, setError, refreshChildren, handleSubRunMeta, childrenFetchedRef });

  // ⑤ 一行 useChatActions（取代 12 个内联 useCallback，~140 行 → 1 行）
  const actions = useChatActions({
    activeSessionId, sessions,
    setSessions, setActiveSession, setSessionUnread, setActiveSubId,
    messages, model, setModel, resetSubRunBaseline,
    setError, setSendError,
  });

  // ⑥ 派生 + i18n（~10 行，不动）
  const topSessions = sessions.filter((s) => s.derivation !== 'subagent');
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const { t } = useTranslation('chat');
  const activeTitle = ...;
  const activeSessionRole = activeSession?.role;
  const activeSessionDerivation = activeSession?.derivation;

  // ⑦ 三栏渲染（~60 行，不动；handler 引用从 actions.* 取）
  return (
    <div className="flex h-full min-h-0">
      <SectionConvPanel ... onSelect={(id) => void actions.openSession(id)} onSelectSub={actions.handleSelectSub} onCreate={() => void actions.handleCreate()} onDelete={(id) => void actions.handleDelete(id)} onRefreshChildren={(pid) => void refreshChildren(pid)} onRenameTitle={actions.handleRenameTitle} />
      <SectionChatDetail ... onModelChange={actions.handleModelChange} onEffortChange={actions.handleEffortChange} onApprovalModeChange={actions.handleApprovalModeChange} onSend={(c) => void actions.handleSend(c)} onAbort={(_sid) => runState.abort()} onEnqueueCancel={actions.handleEnqueueCancel} onCompact={actions.handleCompact} onClear={actions.handleClear} onLoadMore={() => void loadMore()} onNewConversation={() => void actions.handleCreate()} ... />
      {activeSessionId && <SectionWorkspacePanel sessionId={activeSessionId} />}
    </div>
  );
}
```

**行数估算**：原 347 → 重构后 ~110-130 行（store 10 + hooks 15 + state/ref 5 + mount 5 + useChatActions 5 + 派生 10 + render 60 + 注释/import 20）。

### 2.5.5 变更清单（行 = 符号）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_chat_actions_hook | app/web/src/components/chat-page/use-chat-actions.ts | UseChatActionsDeps (interface) | 新增 | hook 入参契约（store selectors/setters + area-hook 返回 + error setters）| MUST 字段全（防 stale closure，INV-A3-2）；MUST types 从 `./types` + `../chat/ModelPicker` + use-messages/use-model-restore/use-subagent-run-refresh import | §2.5.3 | +25/-0 |
| ui_chat_actions_hook | app/web/src/components/chat-page/use-chat-actions.ts | UseChatActionsReturn (interface) | 新增 | hook 返回契约（12 handlers）| MUST 12 handler 签名与 page-chat 原 useCallback 等价 | §2.5.3 | +15/-0 |
| ui_chat_actions_hook | app/web/src/components/chat-page/use-chat-actions.ts | useChatActions | 新增（move 自 page-chat.tsx:126-265）| 12 handler 实现 move 到 hook；每个 `useCallback` deps 数组保留原依赖；**函数体 100% 不动**（仅 `setModel` / `messages.setX` 等从 deps 解构而非 closure）| MUST 函数体零改（copy-paste）；MUST 每个 useCallback 第二参 deps 数组与原一致（INV-A3-1）；MUST chat-api 9 函数在 hook 文件顶部 import；MUST `openSession` 内部 deps `[setActiveSession, setSessionUnread, setActiveSubId, sessions]` 保留（INV-A3-2 stale closure 防护）| page-chat.tsx:126-265 | +145/-0 |
| ui_chat_page | app/web/src/components/chat-page/page-chat.tsx | PageChat | 修改 | 删 12 个内联 useCallback；加 `const actions = useChatActions({...})`；render 内 `onSelect={...actions.openSession}` 等改写（~20 处引用替换）| MUST render JSX 结构不动（仅 handler 引用源从 `handleX` → `actions.handleX`）；MUST 保留全部原 area-hooks / store selectors / local state / ref（store/hook 装配链不动）；INV-A3-3（DOM 等价）| §2.5.4 | +15/-155 |
| ui_chat_page | app/web/src/components/chat-page/page-chat.tsx | (imports) | 修改 | 删 9 个 chat-api import（cancelEnqueue/createSession/deleteSession/listSessions/markSessionRead/postClear/postCompact/postMessage/updateSession）；保留 10 area-hooks import + SectionConvPanel/SectionChatDetail/SectionWorkspacePanel + Session type + ModelSelection + useChatStore + useTranslation/useCallback/useRef/useState | MUST import 列表与 hook 实际使用对齐（无 unused）| page-chat.tsx:11-48 | +0/-9 |

### 2.5.6 INV-A3（行为等价）

- **INV-A3-1 handler 实现等价**：12 handler 函数体逐行 copy-paste 到 hook；签名 + deps 数组 + 内部 `await`/`catch`/`.then` 语义 100% 不变。reviewer 查：`diff page-chat.tsx 原 handler vs use-chat-actions.ts 新 handler` 应只有 `useCallback` → `useCallback`（在 hook 内）+ 闭包变量 → deps 解构的差异。
- **INV-A3-2 deps 闭包完整（防 stale closure）**：每个 useCallback deps 数组与原 page-chat 版本逐项一致：
  - `openSession`: `[setActiveSession, setSessionUnread, setActiveSubId, sessions]`（**sessions 必须在 deps**——内部 `sessions.find((s) => s.id === sid)?.derivation === 'subagent'` 读 sessions，漏则永远拿到 stale 列表 → subagent 判定错）
  - `handleModelChange`: `[activeSessionId]`（setModel 是 useModelRestore 返回的稳定 ref，可不进 deps；与原版一致即可）
  - `handleEffortChange` / `handleApprovalModeChange`: `[activeSessionId, sessions, setSessions]`（**sessions 必须在 deps**——乐观更新 `setSessions(sessions.map(...))` 读 sessions）
  - `handleCreate`: `[setSessions, openSession]`（依赖 hook 内 openSession）
  - `handleDelete`: `[setSessions, activeSessionId, setActiveSession, setActiveSubId, messages]`
  - `handleSend`: `[activeSessionId, model, messages]`
  - `handleEnqueueCancel`: `[activeSessionId]`
  - `handleSelectSub`: `[setActiveSubId, resetSubRunBaseline, openSession]`
  - 其他 3 个（handleRenameTitle / handleCompact / handleClear）: `[]`
  - **reviewer 必查**：deps 数组与原 page-chat 版本字面一致（防 coder 漏写 sessions/activeSessionId 导致 stale closure）
- **INV-A3-3 DOM / props 等价**：SectionConvPanel / SectionChatDetail / SectionWorkspacePanel 三栏的 props 透传路径不变；testid（chat-page / chat-topbar / chat-input-bar / chat-send 等）锚点不动；A1 的 SectionChatDetail 仍接收相同 handler 引用（仅来源从 page-chat local → actions.\*）。
- **INV-A3-4 与 A1 协同**：A1 改 section-chat-detail（消费 BaseChatPage），A3 改 page-chat（抽 handler hook）。**两者独立但相关**：A1 的 ChatDetailProps.onSend/onModelChange/... 在 page-chat render 内从 `actions.handleX` 取，透传给 SectionChatDetail —— **签名不变**，A1/A3 可独立实现也可合并 T4 实现。

### 2.5.7 与 A1 的边界（避免重复工作 / 冲突）

- A1 改 `section-chat-detail.tsx`（ChatDetailProps 接口不变；内部 JSX 重组到 BaseChatPage slot）
- A3 改 `page-chat.tsx`（PageChat 顶层；12 handler 抽 hook）
- **协同点**：page-chat render 内 `<SectionChatDetail onSend={...} onModelChange={...} ... />` —— A3 把 handler 引用源从 local `handleX` 改为 `actions.handleX`，**ChatDetailProps 字段集合不变**
- **无冲突**：A1 不动 page-chat；A3 不动 section-chat-detail。可并行实现，也可串行（推荐 A3 先 → A1 后，因 A3 后 page-chat render 更简洁，A1 在 section-chat-detail 内的 props 透传链路更易追踪）

---

## 3. B — chat 域纯拆分（types/reducer/api/components）

### 3.1 types.ts 拆分策略（**barrel re-export hub 保留** → 35 个消费方零改）

**新目录 `chat-page/types/`**：
- `types/message.ts` ← Message / ContentBlock / MessageSender / AgentRefView / ImageBlockView / ToolResultContentBlock / ViewElement / FlattenedView / StopReason / RunFinish / RunRetryStatus / LoadingPhase（line 17-407）
- `types/session.ts` ← Session / SessionState（line 95-202）
- `types/hitl.ts` ← PendingToolCallView / PendingToolCallSubState / PendingQuestion / PendingQuestionOption / FeedbackData / FeedbackAnswer / ApprovalData / ToolHandleType / isFeedbackData / isApprovalData（line 213-338）
- `types/usage.ts` ← ContextWindowUsage / AccumulatedUsageRecord / SessionUsageView / SummaryTaskStatusKind / SummaryInfo / SummaryTaskStatus（line 419-486）
- `types/subagent.ts` ← SubagentNode / ChildrenView（line 488-522）
- `types/enqueue.ts` ← EnqueueItem（line 204-210）

**`chat-page/types.ts` 改为 barrel**：
```typescript
export * from './types/message';
export * from './types/session';
export * from './types/hitl';
export * from './types/usage';
export * from './types/subagent';
export * from './types/enqueue';
```

### 3.2 变更清单 — types 拆分（行 = 符号组）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_chat_types | app/web/src/components/chat-page/types/message.ts | Message / ContentBlock / MessageSender / AgentRefView / ImageBlockView / ToolResultContentBlock / ViewElement / FlattenedView / StopReason / RunFinish / RunRetryStatus / LoadingPhase | 新增（move） | 从 types.ts move 12 符号到 message.ts；**全部保留 `export`** | MUST 签名/注释/JSDoc 100% 等价；MUST 保留 import（`@app/shared` 的 BizType/Role/Derivation 只在部分子文件用，按需 import）| req §B；types.ts:17-407 | +380/-0 |
| ui_chat_types | app/web/src/components/chat-page/types/session.ts | Session / SessionState | 新增（move） | 从 types.ts move 2 符号；import SummaryTaskStatus 从 './usage'（同 barrel）| MUST Session 字段（含 v0.0.148 effort/approvalMode）完整保留 | types.ts:95-202 | +110/-0 |
| ui_chat_types | app/web/src/components/chat-page/types/hitl.ts | PendingToolCallView / PendingToolCallSubState / PendingQuestion / PendingQuestionOption / FeedbackData / FeedbackAnswer / ApprovalData / ToolHandleType / isFeedbackData / isApprovalData | 新增（move） | 从 types.ts move 10 符号（含 2 类型守卫函数）| MUST 函数实现等价（isFeedbackData/isApprovalData 逻辑不动）| types.ts:213-338 | +125/-0 |
| ui_chat_types | app/web/src/components/chat-page/types/usage.ts | ContextWindowUsage / AccumulatedUsageRecord / SessionUsageView / SummaryTaskStatusKind / SummaryInfo / SummaryTaskStatus | 新增（move） | 从 types.ts move 6 符号 | MUST 字段顺序保留（wire 兼容性）| types.ts:419-486 | +68/-0 |
| ui_chat_types | app/web/src/components/chat-page/types/subagent.ts | SubagentNode / ChildrenView | 新增（move） | 从 types.ts move 2 符号 | - | types.ts:488-522 | +35/-0 |
| ui_chat_types | app/web/src/components/chat-page/types/enqueue.ts | EnqueueItem | 新增（move） | 从 types.ts move 1 符号 | - | types.ts:204-210 | +8/-0 |
| ui_chat_types | app/web/src/components/chat-page/types.ts | (barrel) | 修改 | 改为 `export * from './types/message'` 等 6 行 barrel；删原 type 定义 | MUST 35 个消费方零改（grep 已核实 30 in chat-page + 5 in studio-page）；MUST NOT 任何子文件 export 冲突（子域已分组无重叠）| req §B | +6/-515 |

### 3.3 chat-slice-reducer.ts 拆分

**结构（495 行）**：1 文件 reducer 纯函数 + 多个 helper。按域拆：

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| chat_reducer | app/web/src/store/reducer/agent-event-types.ts | LlmAttemptAction / MessageStartEventSender / AgentEvent | 新增（move） | 从 chat-slice-reducer.ts:28-118 move 3 类型；import ContentBlock/EnqueueItem/LoadingPhase/Message 等从 chat-page/types | MUST 类型定义等价（含 JSDoc） | chat-slice-reducer.ts:25-118 | +90/-0 |
| chat_reducer | app/web/src/store/reducer/message-preview.ts | contentBlocksToPreviewText | 新增（move） | 从 chat-slice-reducer.ts:120-130 move helper | MUST 纯函数实现等价 | chat-slice-reducer.ts:120 | +12/-0 |
| chat_reducer | app/web/src/store/reducer/reducer-state.ts | RunContext / ReducerState / ReducerResult / ReducerFullResult | 新增（move） | 从 chat-slice-reducer.ts:132-188 move 4 类型 | MUST 字段等价 | chat-slice-reducer.ts:132-188 | +60/-0 |
| chat_reducer | app/web/src/store/reducer/apply-agent-event.ts | applyAgentEventToMessages | 新增（move） | 从 chat-slice-reducer.ts:190-end move 主 reducer；内部依赖上述 helper（同目录 import）| MUST 函数签名 + 内部逻辑 + runCtx 值传递语义 100% 等价；MUST 保留 enqueue/hitl/llm_attempt 分支；INV-R-1 | chat-slice-reducer.ts:190-495 | +305/-0 |
| chat_reducer | app/web/src/store/chat-slice-reducer.ts | (barrel) | 修改 | 改为 `export * from './reducer/agent-event-types'` 等 barrel；保留 chat-slice（zustand store 部分，若有）| MUST `useMessages` area-hook + 单测零改 | chat-slice-reducer.ts:1-25 | +5/-490 |

### 3.4 chat-api.ts 拆分（403 行 → 4 文件）

**按模块分组**（grep import 已核实 14 个消费方，barrel 保留零改）：

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| chat_api | app/web/src/lib/chat-api/session-api.ts | createSession / listSessions / getSession / updateSession / deleteSession / listChildren / markSessionRead / req (helper) | 新增（move） | move 8 符号；req helper 同文件内 export | MUST 签名/错误处理等价 | chat-api.ts:12-135 | +135/-0 |
| chat_api | app/web/src/lib/chat-api/message-api.ts | getMessages / getInbox / getPendingToolCall / postMessage / abortSession / cancelEnqueue / InboxItemView | 新增（move） | move 7 符号（含 InboxItemView type）| MUST postMessage body shape（含 v0.0.155 复合 providerId+modelId）等价 | chat-api.ts:136-260 | +130/-0 |
| chat_api | app/web/src/lib/chat-api/usage-summary-api.ts | getSessionUsage / postCompact / getSummary / postClear | 新增（move） | move 4 符号 | MUST URL + method 不变 | chat-api.ts:253-320 | +50/-0 |
| chat_api | app/web/src/lib/chat-api/workspace-api.ts | getWorkspaceTree / openWorkspaceItem / pickWorkspaceDirectory / watchWorkspaceDir / unwatchWorkspaceDir | 新增（move） | move 5 符号 | MUST URL + method 不变 | chat-api.ts:322-403 | +85/-0 |
| chat_api | app/web/src/lib/chat-api.ts | (barrel) | 修改 | 改为 5 行 barrel：`export * from './chat-api/session-api'` 等 | MUST 14 个消费方零改（page-chat / section-* / area-hooks）| - | +5/-400 |

### 3.5 component-message-stream.tsx 拆分（337 行 → 接近 300 边界，**保守只抽 avatar**）

**结构**：1 主组件 + 2 inline avatar 子组件 + 1 类型导出。仅抽 avatar 出去，主文件降到 ≤ 250 行。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_chat_stream | app/web/src/components/chat-page/component-message-stream-avatars.tsx | DefaultAgentAvatar / DefaultUserAvatar | 新增（move） | move 2 inline avatar 组件到独立文件 | MUST 实现等价（className / testid / props） | component-message-stream.tsx:90-118 | +35/-0 |
| ui_chat_stream | app/web/src/components/chat-page/component-message-stream.tsx | (imports + 删除 inline) | 修改 | import 2 avatar；删本地定义；保留 ActorInfo / MessageStreamProps / sideOfMessage / ComponentMessageStream 主实现 | MUST ComponentMessageStream props 签名不变；MUST sideOfMessage export 保留（被 studio 用）；INV-B-1 | - | +1/-30 |

### 3.6 page-chat.tsx 已纳入 A3（见 §2.5）

> 用户补硬要求「需要」：page-chat 347 行框架逻辑一并收拾。**详见 §2.5 A3**（抽 `use-chat-actions.ts` hook，12 handler move，page-chat 变薄到 ~110-130 行）。原 B 段「不动 page-chat」作废，A3 取代。

### 3.7 INV-B（chat 域拆分行为等价）

- **INV-B-1** ComponentMessageStream / sideOfMessage 导出契约不变（被三 chat 页消费）
- **INV-B-2** applyAgentEventToMessages reducer 行为等价（v0.0.95 纯函数 + runCtx 值传递语义保留）
- **INV-B-3** 所有 API 调用 URL / method / body / response 解析等价
- **INV-B-4** types barrel 100% 导出等价（35 消费方 typecheck 全绿）

---

## 4. C — 后端核心拆分（bootstrap / session-store / router）

### 4.1 bootstrap.ts（**1132 行，最高风险**）拆分

**现状**：1 个 `bootstrapBuiltinPlugins` 函数 + BootstrapResult type + 2 helper（extractSessionIdFromGroup / loadScopeConfigs）。

**拆分原则**：`bootstrapBuiltinPlugins` 主函数保留为入口（保持 router.ts 等下游 import 路径不变），**按装配阶段抽 helper 函数到独立文件**（主函数内调用这些 helper 替代内联代码）。

**装配阶段（按源码顺序，必须保持）**：

| Phase | 装配内容（源码 line 范围） | 依赖（前置） |
|------|------|------|
| 1. plugin registry | Registry + BUILTIN_EXTENSION_POINTS + BuiltinLoader + test fixtures（296-359）| 无 |
| 2. scope config | loadScopeConfigs + GroupMetaLoader + ScopeConfigValidator（322-359）| Phase 1 |
| 3. policy/config stores | PluginPolicyStore + PluginConfigService + PluginManager + AppConfigService（362-376）| Phase 2 |
| 4. migration | MigrationManager.run（378-386）| Phase 3 (appConfig) |
| 5. mention + log | MentionProviderRegistry + LogWriter + unhandledRejection hook（388-417）| Phase 3 |
| 6. event bus + sse channel | EventHub.singleton + ReplayableEventBus × 3 + wrapBusWithLog + SseChannel + SSE test interceptor（419-498）| Phase 5 (logWriter) |
| 7. session store + unread runtime | SessionStore + SessionUnreadRuntime + SessionMetaBroadcaster + reconcileOnStartup + SessionTaskLock（500-539）| Phase 6 |
| 8. tool engine + agent manager | ToolExecutionEngine + approvalManager.setStore + ContextEngine + AgentManagerImpl + setResolveConfig + setBuildAgentToolContext + setForkedRunner + setConsolidationRunner + setSquadReminderDeps（541-825）| Phase 7 |
| 9. squad runtime + scheduler | BudgetState + createEngine + squadRuntime + bootScheduler（HeartbeatHandler + CronHandler + 双源 loadJobs + onSessionDestroyed wire + SIGTERM trap + engine.start）（827-940 估）| Phase 8 |
| 10. connectors/channels/browser | connectorManager + channelManager + browserDriverRegistry + computerNativePort（估 940-1020）| Phase 8 |
| 11. search/history | searchEngine + historyIndexer（估 1020-1080）| Phase 7 (store) |
| 12. return BootstrapResult | 收集 migrationErrors + 全实例返回（1080-end）| All |

### 4.2 bootstrap 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bootstrap | app/server/src/bootstrap-plugin-phase.ts | bootstrapPluginPhase | 新增（move 抽出） | Phase 1+2+3 装配：new Registry + BUILTIN_EXTENSION_POINTS + BuiltinLoader.loadAll + registerTestFixtures + loadScopeConfigs + GroupMetaLoader + ScopeConfigValidator + PluginPolicyStore + PluginConfigService + PluginManager + AppConfigService → 返 `{registry, pluginManager, pluginConfigService, appConfig, policyStore}` | MUST Phase 顺序（registry → scopes → validator → policy → configService → manager）；MUST test env _test_fixtures 分支保留；MUST ScopeConfigValidator 硬失败语义保留 | bootstrap.ts:296-376 | +95/-0 |
| bootstrap | app/server/src/bootstrap-bus-phase.ts | bootstrapBusPhase | 新增（move 抽出） | Phase 6 装配：EventHub.singleton + ReplayableEventBus（agent_loop + lifecyclePredicate）+ sessionStatusBus + sessionMetaBus + wrapBusWithLog + SseChannel + installSseTestInterceptor；入参 `{logWriter}`，返 `{hub, bus, sessionStatusBus, sessionMetaBus, sseChannel}` | MUST 3 topic 注册顺序（agent_loop → session_panel → session_meta）；MUST agent_loop predicate 保留（run_start/run_end sticky）；MUST session_panel/session_meta **non-replayable** 保留 | bootstrap.ts:419-498 | +90/-0 |
| bootstrap | app/server/src/bootstrap-store-phase.ts | bootstrapStorePhase | 新增（move 抽出） | Phase 7 装配：FsCrudStore + CompositeStore mount 4 schema + SessionUnreadRuntime（enabled=false）+ SessionMetaBroadcaster + wrapStatusBusForUnread + SessionStore 构造 + setSessionStoreEpDelegate + stateMachine.reconcileOnStartup + SessionTaskLock.reconcile + unreadRuntime.start；入参 `{crud, fsRoot, sessionStatusBus, sessionMetaBus, sseChannel}`，返 `{store, unreadRuntime, sessionMetaBroadcaster, taskLock, statusBusForStore}` | MUST reconcileOnStartup → unreadRuntime.start 顺序（reconcile 在 enabled=false 期间 emit 不产未读，INV-4 保留）；MUST setSessionStoreEpDelegate 必须在 ContextEngine 使用 session_store EP 前调；MUST statusBusForStore 包装链：log proxy → wrapStatusBusForUnread → SessionStore | bootstrap.ts:477-539 | +75/-0 |
| bootstrap | app/server/src/bootstrap-agent-phase.ts | bootstrapAgentPhase | 新增（move 抽出） | Phase 8 装配：ToolExecutionEngine + approvalManager.setStore + ContextEngine + setTaskLock + taskLock.setSessionPanelBus + InboxStore + ObservabilityManager + AgentManagerImpl + setResolveConfig（含 studioContext 完整 fetch）+ setBuildAgentToolContext（含 parentSid/selfSquadId/selfMemberId 派生）+ upsertExplorerTemplate + contextEngine.setForkedRunner（含 enableToolWhitelist=true + toolWhitelist=[] 零工具）+ contextEngine.setConsolidationRunner + contextEngine.setSquadReminderDeps；入参含全部上游实例，返 `{agentManager, contextEngine, inbox, observabilityManager}` | MUST setResolveConfig 内 buildSessionConfigFromDeps 12 个参数顺序保留；MUST setBuildAgentToolContext 内 parentSid = session?.parentSessionId ?? sessionId（避免 subagent→self 回环 bug）；MUST forkedRunner 的 modeKey='summary' + maxIter=1 保留；MUST consolidationRunner 透传 caller 指定的 allowedTools/maxIter；MUST cronToolDepsRef 前向引用 holder 保留（bootScheduler 后填充）| bootstrap.ts:541-825 | +285/-0 |
| bootstrap | app/server/src/bootstrap-scheduler-phase.ts | bootstrapSchedulerPhase | 新增（move 抽出） | Phase 9 装配：BudgetState + createEngine + squadRuntime 构造 + bootScheduler（HeartbeatHandler/CronHandler 注册 + 双源 loadJobs + onSessionDestroyed wire + SIGTERM trap + engine.start）+ squadStore 句柄；入参含 store/agentManager/appConfig 等，返 `{squadRuntime, budgetAggregator, budgetState, schedulerEngine, cronStore, cronToolDeps, consolidationAdapter?, squadStore}` | MUST two-phase init 顺序（budgetState 先 → createEngine → squadRuntime → bootScheduler）保留；MUST SIGTERM trap 保留（engine.stop + squadRuntime.stopAll）；MUST cronToolDepsRef.value 在本 phase 填充（**agent activate 时已读**）| bootstrap.ts:827-940（估） | +120/-0 |
| bootstrap | app/server/src/bootstrap-connectors-phase.ts | bootstrapConnectorsPhase | 新增（move 抽出） | Phase 10 装配：connectorManager + channelManager（构造失败 → undefined）+ browserDriverRegistry + computerNativePort（三态：AT=mock/dev=loopback/packaged=registry）；入参含 hub/appConfig/agentManager 等，返 `{connectorManager?, channelManager?, browserDriverRegistry, computerNativePort?}` | MUST channelManager/connectorManager 构造失败不阻塞 server（catch → undefined）；MUST computerNativePort 三态分支保留 | bootstrap.ts:940-1020（估） | +80/-0 |
| bootstrap | app/server/src/bootstrap-search-phase.ts | bootstrapSearchPhase | 新增（move 抽出） | Phase 11 装配：SearchEngine + HistoryIndexer；构造失败 → undefined（router 503 / tool RUNTIME_ERROR）；入参 `{dataDir, store}`，返 `{searchEngine?, historyIndexer?}` | MUST search.sqlite 损坏不阻塞 bootstrap；MUST onSessionDestroyed wire 到 historyIndexer | bootstrap.ts:1020-1080（估） | +50/-0 |
| bootstrap | app/server/src/bootstrap.ts | bootstrapBuiltinPlugins | 修改 | 主函数变薄（1132 → ~200 行）：依次调上述 7 个 phase helper，收集结果构造 BootstrapResult；保留 promptAssetsCheck 前置（296-305）；保留 workdir mkdir；保留 process.on('unhandledRejection') hook（407-417）；保留 BootstrapResult interface 定义（144-284，type 留此供外部消费） | MUST 装配阶段顺序 1→12 与原一致（INV-C-1）；MUST BootstrapResult 字段集合不变（router.ts 等下游 typecheck）；MUST migrationErrors 透传保留；MUST extractSessionIdFromGroup / loadScopeConfigs 留主文件（or 同步 move）；INV-C-1 | - | +200/-930 |
| bootstrap | app/server/src/bootstrap.ts | BootstrapResult (type) | 修改（保留） | type 定义留主文件（**不动**），下游 router/testing 导入路径不变 | MUST 0 字段变更 | bootstrap.ts:144-284 | +0/-0 |

### 4.3 bootstrap INV（启动序列等价）

- **INV-C-1 装配阶段顺序等价**：Phase 1→12 严格按原 line 顺序（migration 必须在 AppConfigService 之后 + 业务 store 之前；reconcileOnStartup 必须在 unreadRuntime.start 之前；setForkedRunner 必须在 agentManager 创建之后；bootScheduler 必须在 cronToolDepsRef holder 之后填充）。reviewer 查：主函数调 phase helper 的顺序 = 原内联代码顺序。
- **INV-C-2** BootstrapResult 字段集合 + 类型 100% 等价（router sessionDeps/buildCronRouteDeps 等下游消费方零改）
- **INV-C-3** SIGTERM/SIGINT trap 行为等价（engine.stop + squadRuntime.stopAll + pending request abort）
- **INV-C-4** test env 分支保留（registerTestFixtures + _test_fixtures group + sseRecorders）

### 4.4 session-store.ts 拆分（822 行 → facade + 3 方法组文件）

**现状**：1 个 SessionStore class + 20+ 方法，部分 op 已下沉到 `session-*-ops.ts`（children-index / clear-op / workspace-store / unread-ops / pending-ops / state-machine）。

**拆分原则**：class 留作 facade（constructor + 字段声明 + 持 method 签名），方法实现 move 到 `session-store-<group>-impl.ts`（class 外 standalone 函数，class 内方法体改为 `return sessionStoreGroupXxx(this, ...)` 单行委托）。

**方法组（按业务域聚类）**：

| 方法组 | 方法（grep 已核实） | 行数估算 |
|------|------|------|
| **core** | constructor + createSession + getSession + getSessionKind + updateSession + listSessions + deleteSession + fallbackCascadeDelete + stripEnvelope | ~250 行 |
| **messages/runs** | createRun + getRun + updateRun + getRuns + appendMessages + getMessages + getMessagesByRun | ~120 行 |
| **summary/usage** | getSummary + setSummary + accumulateUsage + updateContextWindowUsage + notifyUsageChanged + getRatio + getUsageView + persistUsage | ~180 行 |
| **list-children** | listChildren + listSessions filter biz/role | ~70 行 |
| **state-delegates** | stateMachine 字段 + reconcile（已委托 SessionStateMachine）+ markRunning/markInterrupted/markIdle/markError（如果有，未列） | - |
| **ops-delegates** | clearSession + setWorkspaceDir + ensureWorkspaceDir + markUnreadTrue + markRead + getAlwaysApprovedKeys + addAlwaysApprovedKey + peekPendingToolCall + setPendingToolCalls + resolvePendingToolCall（已委托 `session-*-ops.ts`，class 仅 1 行 wrapper） | ~80 行 |

### 4.5 session-store 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session_store_messages | app/server/src/agent/session-store-messages-impl.ts | sessionStoreAppendMessages / sessionStoreGetMessages / sessionStoreGetMessagesByRun / sessionStoreCreateRun / sessionStoreGetRun / sessionStoreUpdateRun / sessionStoreGetRuns | 新增（move 自 class 方法体）| 从 class 方法 move 出 7 个 standalone 函数；签名首参 `(store: SessionStore, ...)`；内部逻辑/错误处理/store.crud 调用等价 | MUST 函数体内部不动（仅 class 方法 → 函数 + 首参 this）；MUST appendMessages/getMessages 分页语义（ULID 字典序=时间序）保留；INV-S-1 | session-store.ts:405-530 | +125/-0 |
| session_store_usage | app/server/src/agent/session-store-usage-impl.ts | sessionStoreGetSummary / sessionStoreSetSummary / sessionStoreAccumulateUsage / sessionStoreUpdateContextWindowUsage / sessionStoreNotifyUsageChanged / sessionStoreGetRatio / sessionStoreGetUsageView / sessionStorePersistUsage | 新增（move 自 class 方法体）| 从 class move 出 8 函数；内部调用 `accumulatePartition`/`computeRatioSample`/`pushRatioSample`/`deriveUsageView`/`normalizeContextWindowUsage` 等已有 helper 保持 | MUST accumulateUsage 三分区累加语义 + ratio 滑动 3 中位数保留；MUST statusBus.emit(session_usage_update) 保留；MUST persistUsage 等价 | session-store.ts:531-685 | +185/-0 |
| session_store_children | app/server/src/agent/session-store-children-impl.ts | sessionStoreListChildren | 新增（move 自 class 方法体） | move 1 函数；内部 childrenIndex 维护 + ChildrenView 分组（running/terminated）语义保留 | MUST listChildren O(N)→O(children) 性能保留（childrenIndex lazy 建 + create/delete 增量）；INV-S-2 | session-store.ts:302-369 | +70/-0 |
| session_store_facade | app/server/src/agent/session-store.ts | SessionStore (class) | 修改 | class 保留 constructor + 字段 + 21 method 签名；**方法体改单行委托**（如 `async appendMessages(sid, msgs, opts) { return sessionStoreAppendMessages(this, sid, msgs, opts); }`）；core 方法（createSession/getSession/updateSession/listSessions/deleteSession/getSessionKind）保留原实现（core 组不拆）| MUST class 公开 API 100% 等价（bootstrap/handlers/services 零改）；MUST 字段（crud/fsRoot/stateMachine/statusBus/childrenIndex）保留 private/readonly；MUST onSessionDestroyed hook 保留；INV-S-3 | session-store.ts:62-end | +25/-490 |

### 4.6 session-store INV

- **INV-S-1** appendMessages / getMessages / getMessagesByRun / createRun / updateRun 行为等价
- **INV-S-2** listChildren 分组语义（running/terminated 按 updatedAt desc）+ childrenIndex 增量维护等价
- **INV-S-3** SessionStore class 公开方法签名 + 返回值 100% 等价（bootstrap/handlers/services 零改）；private 字段（crud/fsRoot/statusBus/childrenIndex）保留 encapsulation
- **INV-S-4** usage 累计（三分区 + ratio + contextWindowUsage）+ statusBus emit 语义等价

### 4.7 router.ts 拆分（731 行 → dispatch table + 4 路由组）

**结构**：1 `dispatchRequestInternal` 主分发 + N helper（sessionDeps / matchSessionPath / dispatchSessionPut / isExcludedApiPath / buildCronRouteDeps / buildConsolidationTestDeps）+ bootstrapCache + json + getBootstrap。

**拆分原则**：主文件保留 bootstrapCache + json + getBootstrap + dispatchRequestInternal 入口 + matchSessionPath（核心路径解析）；按路由组抽 dispatch 函数到 `routes-<group>.ts`（每个返 `Response | null`，主分发 null 时继续下个 group）。

### 4.8 router 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| router_routes | app/server/src/routes/session-routes.ts | dispatchSessionRoutes | 新增（move） | move /session* 路由组分发（含 session-collection/item/messages/inbox/pending-tool-call/run/abort/children/usage/compact/clear/read/update/messages-cancel + session-put dispatch + session debug）；入参 `(req, method, path, bs, dataDir)`，返 `Response \| null`（未命中返 null 给主分发继续）| MUST 路由顺序保留（路径前缀匹配敏感：/session/:id/messages 必须在 /session/:id 之前）；MUST 405/404 语义保留；INV-R-1 | router.ts:263-318 | +200/-0 |
| router_routes | app/server/src/routes/squad-routes.ts | dispatchSquadRoutes | 新增（move） | move /squad* 路由组（含 /squad/:id/member、/squad/:id/charter、/squad/:id/board、/squad/:id/budget、/squad/:id/scheduler）| MUST /squad/:id/member 等子路径分发到对应 handler（handleMemberRoute/handleCharterRoute/handleBoardRoute 等）| router.ts dispatch 段 | +90/-0 |
| router_routes | app/server/src/routes/config-routes.ts | dispatchConfigRoutes | 新增（move） | move /config/* 路由组（kv-config / app-template / plugin-scope / plugin-config / connectors / channels / llm-request-config / app）| MUST /config/plugin 必须在 /config/plugin/scopes 之后（前缀匹配冲突，v0.0.26 INV 保留）| router.ts dispatch 段 | +120/-0 |
| router_routes | app/server/src/routes/misc-routes.ts | dispatchMiscRoutes | 新增（move） | move /health / /counter / /provider* / /model* / /skill* / /sse* / /mention* / /memory* / /cron* / /history* / /consolidation* / /bootstrap* / workspace seed routes + test-only routes（/test/llm-mode, /test/stub*, /test/consolidation/run）+ ET interceptor hooks | MUST NODE_ENV=test gate（workspace seed + test-only routes 非测试返 404）保留；MUST interceptHttpRequest / recordHttpResponse 装配点保留 | router.ts dispatch 段 | +180/-0 |
| router_routes | app/server/src/routes/router-helpers.ts | sessionDeps / matchSessionPath / dispatchSessionPut / isExcludedApiPath / buildCronRouteDeps / buildConsolidationTestDeps | 新增（move） | move 6 helper 函数到独立文件；router.ts import | MUST 签名等价；sessionDeps 构造 SessionHandlerDeps 字段完整 | router.ts:154-220, 319-328, 704-731 | +130/-0 |
| router_main | app/server/src/router.ts | dispatchRequestInternal / _dispatchRequestCore / handleRequest | 修改 | 主分发变薄（~150 行）：依次调 4 个 dispatch 函数（null 时继续）+ bootstrapCache 处理 + json helper + getBootstrap；保留入口签名 | MUST 路由组尝试顺序保留（session → squad → config → misc）；MUST 404 fallback 保留；MUST SSE early-return 分支保留；INV-R-1 | router.ts:263-700 | +60/-550 |

### 4.9 router INV

- **INV-R-1** (method, path) → handler 映射 100% 等价（任何请求分发结果与拆分前一致）
- **INV-R-2** test-only 端点（/test/llm-mode, /test/stub*, /test/consolidation/run, /api/workspace/*）非测试环境返 404 保留
- **INV-R-3** bootstrapCache 行为（同 dataDir 复用 Promise）等价

---

## 5. 持续可打包护栏（MANDATORY — 与依赖闭包 / 启动序列 / INV 并列）

> 用户硬要求：**拆分后打包 dmg 必须没问题**。本节针对 v0.0.108 四类 packaged bug 教训逐项核查。
> 原则：**dev 绿 ≠ packaged 能跑**。C 段拆分后端核心（bootstrap 1132 / session-store 822 / router 731），对打包有三类风险，逐项核查如下。

### 5.1 build 脚本文件列表核查（architect 已 grep + 读代码核实）

**核查对象**：`scripts/build-dmg.sh` / `scripts/build-plugins.ts` / `app/server/package.json#scripts.build` / `app/electron/electron-builder.yml#files` / `scripts/check-server-build-assets.sh`。

**结论**：**全部走 glob / 动态发现，无硬编码 bootstrap/session-store/router 路径** → 拆分新增文件**自动被打包**，**无漏打包风险**。

| 核查点 | 现状（grep + 读代码证据） | 风险 | 结论 |
|------|------|------|------|
| `app/server/tsconfig.json` include | `"include": ["src/**/*"]` + `rootDir: "./src"` + `outDir: "./dist"` | **无**（动态递归扫 src 下全部 .ts）| 新增 `bootstrap-<phase>.ts` / `session-store-*-impl.ts` / `routes-*.ts` 自动被 tsc -b 编译进 `dist/` |
| `app/server/package.json#scripts.build` | `tsc -b && cp -r src/prompts/content dist/prompts/ && cp -r src/migration/handlers/*.yaml dist/migration/handlers/ && bash ../../scripts/check-server-build-assets.sh` | **无**（cp 只针对 prompts + migration yaml 两类静态资源；不碰 .ts）| 新增 .ts 由 tsc -b 自动处理 |
| `app/electron/electron-builder.yml#files` | `dist/**/*`（glob，非清单）+ `node_modules/@app/server/**/*` + `../plugins/dist → node_modules/@app/plugins` | **无**（glob 覆盖 dist 全量 + workspace node_modules 全量）| 新 dist/*.js 自动进 asar |
| `scripts/build-dmg.sh` | `cd app/server && bun run build` → `app/server/dist/index.js` 存在性校验；不枚举源文件 | **无** | - |
| `scripts/build-plugins.ts` | `fs.readdirSync(BUILTINS_SRC)` + 读 `plugin.json` 动态发现 extImpls；`EXTERNALS = ['@app/server', ...]`（包名级，非路径）| **无**（plugin entrypoints 动态扫）| plugin build 不受 server 内部拆分影响 |
| `scripts/check-server-build-assets.sh` | `find src/prompts/content -name "*.md"` + `find src/migration/handlers -name "*.yaml"` 镜像比对；**不检查 .ts** | **无**（本脚本专为静态资源漏 cp 设计，v0.0.153 prompts/content 教训）| 本版本拆分不动这两类资源，无需扩展本脚本 |

**与 v0.0.153 prompts/content 漏进 dist 教训对比**：那次是「build 期 cp 静态资源 glob 漏了新增 .md」；本次拆分全是 .ts → .js（tsc 全量编译），**风险类别不同，天然豁免**。

### 5.2 bootstrap 拆分对 packaged 启动的影响（核心风险）

**核查路径**：bootstrap.ts 拆 7 phase helper 后，packaged cwd=`/` + asar 归档 + process.env 干净（不继承 shell）环境下，启动序列是否与 dev 一致。

**architect 核查结论**：

1. **服务注册/依赖注入顺序**：拆分**保持 Phase 1→12 严格顺序**（见 §4.1 phase 表 + INV-C-1）。phase helper 函数是**纯内联代码 move 出来**（调用顺序与原 line 顺序逐行等价），不引入新运行时 dispatch / lazy / 异步加载。**dev 和 packaged 启动顺序完全一致**。

2. **runtime-config 注入点不受拆分影响（注入时机与 bootstrap phase 解耦）**：
   - `runtime-config.ts` 白名单（API_PORT / DATA_DIR / APP_NAME / APP_ENV / LOG_LEVEL / HEALTH_ENDPOINT）是 **env 键白名单**（非文件路径白名单）
   - 注入时机 = **electron `app/electron/src/main.ts` 最早期**调 `loadRuntimeConfig(process.env, configPath)` —— 在 backend bootstrap **之前**（`loadRuntimeConfig` 在 main.ts 的调用顺序早于 `bootstrapBuiltinPlugins`）
   - **本版本拆分不动 electron main / runtime-config.ts / loadRuntimeConfig 调用点**：phase helper 拆分发生在 `app/server/src/bootstrap.ts` 内部，与 `app/electron/src/main.ts` 完全解耦
   - **硬约束（INV-PKG-2）**：phase helper 内部禁止再调 `loadRuntimeConfig` / 禁止直接读 `process.env.<runtime-key>`（必经 main.ts 单点注入）；phase helper 只**消费** `dataDir: string`（已展开的绝对路径）+ `appConfig: AppConfigService`（已构造完成的实例）—— **phase 间靠参数传递，不重新读 env**
   - **验证点（reviewer 查）**：phase helper 签名应接收已构造完成的依赖（store / appConfig / hub 等），不接收 process.env；若发现 phase helper 内部 `process.env.API_PORT` / `process.env.DATA_DIR` → 违反 INV-PKG-2，退 coder

3. **路径展开**：bootstrap 拆分后 phase helper 仍接收 `dataDir: string`（绝对路径，已由 `resolveDataDir` 展开）。**禁止 phase helper 内部重新拼接字面 `~` / 相对路径**（INV-PKG-1）。原 bootstrap 已遵守此约束（`path.join(dataDir, 'workspace')` / `new SquadStore({ root: dataDir })` 等），move 过程中 coder 不得改写为相对路径。

4. **__dirname 资源解析**：原 bootstrap.ts 有 4 处 `__dirname` 解析（plugins/builtins/scopes/groups.json 路径）：
   - `path.resolve(__dirname, '../../plugins/builtins')`（line 316）
   - `path.resolve(__dirname, '../../plugins/scopes')`（line 337）
   - `path.resolve(__dirname, '../../plugins/groups.json')`（line 339）
   
   **move 到 phase helper 后必须保持 __dirname 语义**（CJS 编译后 __dirname = dist/ 目录，相对路径解析到 app/plugins/）。**禁止改写为 `process.cwd()` + 相对路径**（packaged cwd=`/` 会崩，v0.0.108 BUG-004 教训）。phase helper 接收 `__dirname` 作参数或文件内直接用（CJS 下 __dirname 是模块级常量，move 后仍指向 dist/）。

### 5.3 依赖归属（BUG-002 类）

**architect 核查结论**：本版本拆分**全部在 `@app/server` workspace 内**（bootstrap / session-store / router / handlers 均在 `app/server/src/`）。**不跨 workspace**（无符号 move 到 `app/shared` / `app/protocols`）。

- 前端拆分全部在 `@app/web` workspace 内（chat-page types/reducer/api/components）
- **不新增 npm 依赖**（纯 move 已有代码，deps 集合不变）
- **不触发 build-plugins.ts EXTERNALS 决策**（plugin 不变）

**若 architect 判断某符号该 move 到 `app/shared`**（如 `BizType` / `Role` 等已 @app/shared；但本版本无此类需要）：必须先确认目标 workspace `package.json` 有依赖（`@app/shared` 已是 `@app/server` + `@app/web` 共同依赖，无风险）。

### 5.4 验证 MANDATORY（dev 绿 ≠ packaged 能跑）

**本版本 C 段（bootstrap / session-store / router 拆分）= 后端核心改动** → 必须跑 packaged 验证（CLAUDE.md「持续可打包护栏」第 4 条）。

**验证步骤**（参考 states/v0.0.108/verify 复现方法）：

```bash
# Step 1: build packaged dmg（在 worktree 根目录）
cp prod.env.example prod.env  # 若不存在；填入 APP_NAME/API_PORT/WEB_PORT/DATA_DIR
bash scripts/build-dmg.sh

# Step 2: 解包 asar，用其 dist 起真后端（不走 dev bun run src）
RELEASE_DIR="${RELEASE_DIR:-release}"
APP_NAME="${APP_NAME:-RockyAgent}"
APP_VERSION="$(node -p "require('./package.json').version")"
ASAR_PATH="$RELEASE_DIR/mac/$APP_NAME.app/Contents/Resources/app.asar"
EXTRACT_DIR="/tmp/rocky_packaged_check_v0.0.156"

# 解包 asar
rm -rf "$EXTRACT_DIR"
node -e "require('@electron/asar').extractAll('$ASAR_PATH', '$EXTRACT_DIR')"

# Step 3: 用 packaged dist 起后端（不经 bun，模拟 packaged 运行时）
export NODE_ENV=production
export API_PORT=13579  # 临时端口
export DATA_DIR="$(mktemp -d -t rocky_packaged_test)"
cd "$EXTRACT_DIR"
node node_modules/@app/server/dist/index.js &
SERVER_PID=$!
sleep 3

# Step 4: curl 关键 endpoint，确认后端起 + 200 + plugin 非空壳
curl -sf "http://127.0.0.1:$API_PORT/health" || echo "FAIL: /health"
curl -sf "http://127.0.0.1:$API_PORT/bootstrap/status" || echo "FAIL: /bootstrap/status"
# plugin 非空壳（LLM provider 可用）：
curl -sf "http://127.0.0.1:$API_PORT/provider" | grep -q "anthropic" || echo "FAIL: provider empty"
# session 创建（验证 bootstrap 装配链 + SessionStore 工作）：
curl -sf -X POST "http://127.0.0.1:$API_PORT/session" -H "content-type: application/json" -d '{"title":"packaged test"}' || echo "FAIL: POST /session"
# squad CRUD（验证 router dispatch + squad handler + squad-model-helpers）：
curl -sf "http://127.0.0.1:$API_PORT/squad" || echo "FAIL: GET /squad"

# Step 5: 清理
kill $SERVER_PID 2>/dev/null
rm -rf "$EXTRACT_DIR" "$DATA_DIR"
```

**通过标准**：
- /health 返 200
- /bootstrap/status 返 200（migrationErrors 数组可为非空，但响应 shape 合法）
- /provider 返 200 且含 "anthropic"（**plugin 非空壳，BUG-003 类验证**）
- POST /session 返 201（**bootstrap 装配 + SessionStore 工作链完整**）
- GET /squad 返 200（**router 路由表 + squad handler + squad-model-helpers 工作链完整**）

**若任一 FAIL**：退 coder 修；同时建 BUG-xxx-[open].md 标 `packaged-崩溃` + 类别（BUG-001/002/003/004）。**禁止合并**。

### 5.5 packaged 验证硬约束（INV-PKG）

- **INV-PKG-1** phase helper 内禁止相对路径 / 字面 `~` / `process.cwd()` 拼接 dataDir（v0.0.108 BUG-004 教训）
- **INV-PKG-2** phase helper 内禁止 `process.env.X` 直读（运行时 env 键必经 runtime-config.ts 白名单注入，白名单外的键 packaged 时 undefined）
- **INV-PKG-3** `__dirname` 解析 plugins/scopes/groups.json 路径必须保留 __dirname 语义（CJS 编译后 = dist/，解析到 app/plugins/；禁止改 process.cwd() + 相对路径）
- **INV-PKG-4** session-store facade / router dispatch 拆分后，**public class API + (method, path) → handler 映射 100% 等价**（packaged 路径下任何 endpoint 必须与 dev 同响应）
- **INV-PKG-5** 拆分后必跑 §5.4 packaged 验证全绿才能合并（dev typecheck/test/AT/ET 全绿 ≠ packaged 可用）

---

## 6. 全局不变量清单（reviewer 按此查偏离）

### 6.1 行为等价（适用全部拆分）
- **INV-G1** 纯 move：被搬符号的签名 + 内部逻辑 + 错误处理 + 控制流 + 调用语义 100% 等价
- **INV-G2** barrel re-export：拆分后 barrel 文件导出 surface 与原单文件导出 surface 完全等价（消费方零改 + typecheck 全绿）
- **INV-G3** 单文件行数：每个新增文件 ≤ 300 行（架构契约文件本 change_plan + 测试文件豁免）
- **INV-G4** 循环依赖：拆分后无新增循环依赖（依赖方向见 §0.1 §0.2）
- **INV-G5** import 路径迁移完整：`grep -r "from '原路径'"` 残留归零（memory rename-refs-batch-sed-verify）
- **INV-G6** 持续可打包：§5 全部核查项满足 + §5.4 packaged 验证全绿（INV-PKG-1~5）

### 6.2 特定 INV（见各段）
- **INV-A1-1~4** playground chat 重组（section-chat-detail → BaseChatPage 消费方）
- **INV-A2-1~2** checkModel move（squad-model-helpers）
- **INV-A3-1~4** page-chat 框架收拾（12 handler 抽 use-chat-actions hook，deps 闭包完整防 stale closure）
- **INV-B-1~4** chat 域拆分
- **INV-C-1~4** bootstrap 装配序列
- **INV-S-1~4** session-store facade
- **INV-R-1~3** router 路由表
- **INV-PKG-1~5** 持续可打包（见 §5.5）

---

## 7. 任务切分建议（planner 参考用，按依赖顺序）

建议 **6 task**（3-8 范围内），按「被依赖方先做」排：

| Task | 范围 | coversModules / Files | 依赖前置 |
|------|------|------|------|
| **T1** chat 域 types 拆分 | B 3.1-3.2（types.ts → 6 子文件 + barrel）| `app/web/src/components/chat-page/types/*.ts` + `types.ts`（barrel）| 无（leaf）|
| **T2** chat 域 reducer + api 拆分 | B 3.3-3.4（chat-slice-reducer + chat-api）| `app/web/src/store/reducer/*.ts` + `chat-slice-reducer.ts` + `app/web/src/lib/chat-api/*.ts` + `chat-api.ts` | T1（types 先就绪，reducer/api 消费 types）|
| **T3** A2 squad-handler helpers + B component-message-stream 拆分 | A2 + B 3.5 | `app/server/src/handlers/squad-model-helpers.ts` + `squad.ts`（import 改）+ `app/web/src/components/chat-page/component-message-stream-avatars.tsx` + `component-message-stream.tsx`（import 改）| 无（独立）|
| **T4** A1 + A3 playground chat 重组（section-chat-detail 接入 BaseChatPage + page-chat 抽 use-chat-actions hook）| A1 全（§1）+ A3 全（§2.5）| `app/web/src/components/chat-page/section-chat-detail.tsx` 重组（消费 BaseChatPage + BaseChatInputBar）+ `app/web/src/components/chat-page/use-chat-actions.ts`（新增）+ `app/web/src/components/chat-page/page-chat.tsx` 变薄（12 handler move 到 hook）| T1（types 稳定）+ BaseChatPage/InputBar 已存在（v0.0.155 落地）；**A1 / A3 独立可串行也可并行，推荐 A3 先做（page-chat render 变简洁后 A1 props 透传链路更易追踪）**|
| **T5** C 后端 bootstrap 拆分（**最高风险**）| C 4.1-4.3 + §5（packaged 验证）| `bootstrap-<phase>.ts` × 7 + `bootstrap.ts` 主函数变薄 | 无（独立，但必须跑 §5.4 packaged 验证）|
| **T6** C 后端 session-store + router 拆分 | C 4.4-4.9 + §5（packaged 验证）| `session-store-*-impl.ts` × 3 + `session-store.ts`（facade）+ `routes-*.ts` × 5 + `router.ts` 主（dispatch thin）| 无（独立；可与 T5 并行，但建议串行：bootstrap 改动大，session-store/router 拆分独立验证更容易）|

**并行机会**：T1 / T3 可并行；T4 等 T1；T5 / T6 独立于前端可全程并行。

**测试策略**：
- 每 task 自带 UT 覆盖（reducer / api / types barrel / checkModel / message-stream / bootstrap phases / session-store facade / router dispatch / **use-chat-actions hook 12 handler 行为等价 + deps 闭包完整**）
- **T4（A1+A3）必带 UT**：use-chat-actions hook 逐 handler 行为断言（mock store + chat-api + area-hook 返回，验 handler 调用 → 正确 dispatch / API call / state 更新）；**特别覆盖 INV-A3-2 stale closure 防护**（切 subagent → 切顶层 → activeSubId 清空；改 effort → 乐观更新 sessions；handleSend 用最新 model）
- **T5（bootstrap）+ T6（session-store/router）必须跑 §5.4 packaged 验证**（memory 持续可打包护栏：dev 绿 ≠ packaged 绿）
- 冒烟集回归（AT/ET 各 1-2 条）覆盖 chat 主链路（playground send/abort/compact + 切会话 + subagent 只读页）+ squad CRUD

---

## 8. 风险点（architect 已识别，coder 实现时注意）

### R1 [**最高**] C bootstrap 拆分破坏装配顺序
- **风险**：Phase helper 顺序错乱 → 单例未就绪（如 cronToolDepsRef 未填充时 agent activate / unreadRuntime.start 早于 reconcileOnStartup / setForkedRunner 早于 agentManager 创建）
- **缓解**：§4.1 phase 表 + INV-C-1 强制顺序；T5 必须逐 phase 移动 + 每移一个跑 `bun run typecheck` + 启动 dev 确认无报错；packaged 验证 MANDATORY（memory 持续可打包护栏 #3：runtime config 注入）

### R2 [高] barrel re-export 漏导出 / 重复导出冲突
- **风险**：types/chat-api/reducer barrel 漏符号 → 35 消费方 typecheck fail；或子文件 export 重名 → barrel 编译错
- **缓解**：拆分前 `grep -nE "^export " types.ts > 基线清单`；拆分后 barrel + 子文件 export 集合 diff 基线归零；`bun run typecheck` 全绿兜底

### R3 [中] session-store class 方法委托引入运行时开销
- **风险**：每个方法多一层函数调用（class method → standalone function）；20+ 方法累计可能影响热路径（appendMessages 高频）
- **缓解**：standalone 函数首参传 `this`（实例引用），内部直接读 `store.crud`，**不重新构造实例**；V8 inline 优化等价；性能 UT（如 appendMessages batch 1000 条）对比拆分前后无回归

### R4 [中] types.ts 拆分后 Session 类型跨文件依赖（SummaryTaskStatus 在 usage.ts，Session 在 session.ts 引用它）
- **风险**：session.ts 引用 usage.ts 的 SummaryTaskStatus → 子文件间依赖；循环风险
- **缓解**：依赖方向单向（session → usage，不反向）；barrel 不引入循环（`export *` 是静态聚合）

### R5 [中] A1 重组破坏 readOnly 分支 / hideInputBar 门控
- **风险**：subagent session（readOnly=true）重组后 input slot 仍渲染 / ClearBtn 仍显示 / chat-model-tag 丢失
- **缓解**：INV-A1-3 强制；A1 实现后 e2e designer 确认 readOnly case（subagent 只读页）dom 断言；reviewer 查 hideInputBar 计算逻辑（`readOnly || !sessionId`）等价

### R6 [中] router 路由前缀匹配冲突
- **风险**：/config/plugin 与 /config/plugin/scopes 前缀敏感，拆分到 routes/config-routes.ts 时顺序错 → /config/plugin/scopes 被 /config/plugin 捕获
- **缓解**：INV-R-1 + reviewer 查 config-routes.ts 内 try 顺序（/config/plugin/scopes 必须在 /config/plugin 之前）；AT 跑 /config/plugin/scopes 端点确认

### R7 [低] import 路径迁移遗漏
- **风险**：rename 文件后 grep 残留旧路径 → typecheck fail
- **缓解**：memory rename-refs-batch-sed-verify：grep 全 + sed 批量替换 + grep 残留归零验证；`bun run typecheck` 兜底

### R8 [低] component-message-stream 拆出 avatar 后 DefaultAgentAvatar/DefaultUserAvatar 被外部消费
- **风险**：grep 发现外部直接 import 这两个内部 avatar
- **缓解**：grep 已确认仅 component-message-stream.tsx 内部用；move 后不导出（文件内 `function`，不 `export`）；若发现外部消费则保留 `export`（不破坏）

### R8.5 [**中-高**] A3 page-chat handler move 到 hook 时漏 deps 导致 stale closure
- **风险**：12 handler move 到 useChatActions hook 时，coder 漏写 useCallback deps 数组中的 `sessions` / `activeSessionId` / `messages` / `model` 等 → 闭包锁住旧值 → 行为悄悄偏差（不 typecheck fail，但运行时错误）
  - 典型坑：`openSession` 内读 `sessions.find(...)?.derivation === 'subagent'` 判 subagent，若 deps 漏 `sessions` → 永远拿初始空列表 → 所有会话被判为非 subagent → 切顶层会话时 activeSubId 不清空 → viewedSessionId 短路到旧 subagent → 引擎订阅不释放（page-chat.tsx 注释已警示，line 122-125）
  - 同样坑：`handleEffortChange` / `handleApprovalModeChange` 乐观更新 `setSessions(sessions.map(...))` 读 sessions
  - 同样坑：`handleSend` 读 `model`（useModelRestore 当前值），漏 deps → 发消息始终带旧 model
- **缓解**：INV-A3-2 强制每个 useCallback deps 数组与原 page-chat 版本字面一致（§2.5.6 已逐项列出 12 handler 的 deps 清单）；reviewer 必查 diff（原 deps vs 新 deps 字面相等）；**MUST 启用 eslint-plugin-react-hooks exhaustive-deps 规则**（若项目已配）作 typecheck 外兜底；UT 覆盖「切 subagent 后切顶层 → activeSubId 清空」+「改 effort 后乐观更新生效」
- **反馈**：若验证阶段发现 stale closure bug（如切会话后状态错位）→ 退 coder 补 deps + 反思漏写原因

### R9 [**高 — packaged 专属**] dev 全绿但 packaged 崩（v0.0.108 教训）
- **风险**：T5（bootstrap 拆 7 phase）+ T6（session-store facade + router dispatch 拆）是后端核心改动。dev = bun run src 直接跑 ESM + cwd=worktree（可写）+ source dev.env；packaged = Electron Node CJS + asar 归档 + cwd=`/`（不可写）+ process.env 干净。三类 packaged 专属崩溃 dev 测不到：
  1. **phase helper 内部误用 `process.cwd()` / 相对路径 / 字面 `~`**（cwd=`/` 崩，v0.0.108 BUG-004）
  2. **phase helper 内部 `process.env.X` 直读非白名单键**（packaged undefined，v0.0.108 BUG-001）
  3. **`__dirname` 解析 plugins/scopes/groups.json 路径被改写**（CJS 编译后 __dirname=dist/，解析到 app/plugins/；改 process.cwd() 会崩）
- **缓解**：INV-PKG-1~3 强制；T5/T6 必跑 §5.4 packaged 验证（解包 asar → node 启 dist/index.js → curl 关键 endpoint 全绿才合并）；memory `macos-tcc-spawn-no-perm-use-electron-host`（如涉及 native）+ `持续可打包护栏` 四类全核查

---

## 9. 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离、改函数内部逻辑）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- 拆分后单文件仍 > 300 行（架构契约文件 + 测试文件豁免）→ 退 coder 二次拆分
- bootstrap 装配顺序被破 → 立即报 architect 重新确认（最高风险，非 coder 自由裁量范围）
- barrel re-export 漏符号导致下游 typecheck fail → 退 coder（INV-G2 硬约束）

---

## 附录：architect 核实工作记录（落 change_plan 前的 grep / 读代码证据）

- `wc -l` 10 个待拆分文件行数核实（5686 total）：section-chat-detail=413 / squad.ts=484 / types.ts=522 / chat-slice-reducer.ts=495 / chat-api.ts=403 / component-message-stream.tsx=337 / page-chat.tsx=347 / bootstrap.ts=1132 / session-store.ts=822 / router.ts=731
- `grep "^export\|^function\|^interface\|^const\|^type\|^async function"` 各文件符号清单（见上下文）
- `grep "from '\\.\\./chat-page/types'\\|from '\\./types'"` → 30+5 消费方（types.ts barrel 决策依据）
- `grep "checkModel"` → 仅 squad.ts 内部 4 处（A2 拆分安全）
- 已读 studio 两页参考实现（section-squad-chat.tsx:231-246 + section-member-chat.tsx:154-235）确认 A1 slot 划分范式
- 已读 base-chat-page.tsx + base-chat-input-bar.tsx 确认 slot 接口契约（v0.0.155 已就绪）
- bootstrap.ts 分段读（line 1-80, 140-440, 440-840）确认 phase 顺序
