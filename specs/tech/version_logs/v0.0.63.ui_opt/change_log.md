---
type: change_log
version: v0.0.63.ui_opt
title: Playground / Squad 对话区 UI 5 问题修复（thin 架构）
updated: 2026-07-04
---

# v0.0.63.ui_opt · Playground / Squad 对话区 UI 5 问题修复（thin 架构）

> 纯前端改动 5 处（F1-F5）：F1 bug 修复（model 渲染时机）+ F2 渲染器扩展（GFM 表格）+ F3 删冗余节点 + F4 squad 头部对齐 playground + F5 删重复 tab bar。
> **后端 API 零变更**；UT only；不动 `specs/tech/` 各子系统 OKF KB 的事实层。
> 权威输入：`specs/prd/version_logs/v0.0.63.ui_opt.md`（PRD 含 F1-F5 + P1-P6 + T1-T7 spec 张力清单）。

---

## 1. 范围

### 1.1 IN-SCOPE（5 项 — 与 PRD §2.1 一致）

| # | 项 | 改动文件（核心） |
|---|---|---|
| F1 | playground model 渲染时机修复（bug） | `app/web/src/components/chat-page/page-chat.tsx` |
| F2 | markdown GFM 表格支持 | `app/web/src/components/common/primitive-markdown-view.tsx` |
| F3 | 删 chat-model-tag（非 readOnly） | `app/web/src/components/chat-page/section-chat-detail.tsx` |
| F4a | member 单聊头部对齐 playground | `app/web/src/components/studio-page/section-member-chat.tsx` |
| F4b | squad 群聊头部对齐 playground | `app/web/src/components/studio-page/section-squad-chat.tsx` |
| F5 | SectionRightTabs 退化为薄 wrapper | `app/web/src/components/studio-page/section-right-tabs.tsx` |

### 1.2 OUT-OF-SCOPE（硬边界）

- **后端 API 零变更**：F4a 走现有 `PATCH /squad/:id/member/:mid`（§2.2，可改 `model`）；F4b per-call override 走现有 `POST /session/:id/messages` body `{providerId?, modelId?}`；usage GET / clear / compact 全是现有端点。
- **AT / ET 不跑**：UT 覆盖所有改动点。
- **不发明新概念**：所有引用组件（ModelPicker / ComponentUsagePanel / CompactBtn / ClearBtn / useSessionRunState / GFM 表格语法）均已存在。
- **不动 specs/tech/ OKF KB 事实层**：仅 doc-modifier 阶段同步 T1-T7 spec（见 §5）。

---

## 2. F1 — Playground model 渲染时机修复（bug）

**改动文件**：`app/web/src/components/chat-page/page-chat.tsx`

**根因**：model state 仅在 `openSession(sid)` 路径内 `getSession(sid)` 回填（line 134-166）；PageChat 挂载 effect（line 89-132）只拉 sessions 列表 + 建 SSE，不主动恢复 model。从 studio 切到 playground 时 activeSessionId 已存在但 model=null，ModelPicker trigger 显空态，必须用户点一下会话项才回填。

**做法**：在 `page-chat.tsx` 加一个 `useEffect`，依赖 `[activeSessionId]`：mount 或 activeSessionId 变化时主动 `getSession(sid)` 拿 `providerId/modelId` 回填 model state；与现有竞态守卫 `openSessionTokenRef` / `activeSessionIdRef`（line 73-76）**复用同一对 token + ref**，与现有 `useLayoutEffect`（line 81-83 同帧清 model）**协调**：

```
useEffect(() => {
  const sid = activeSessionId;
  if (!sid) { setModel(null); return; }
  const myToken = ++openSessionTokenRef.current;  // 复用 openSession 的 token
  (async () => {
    try {
      const detail = await getSession(sid);
      // 双校验：token 仍是最新 + sid 仍是 active（防快切 A→B→A）
      if (myToken !== openSessionTokenRef.current) return;
      if (activeSessionIdRef.current !== sid) return;
      if (detail.providerId !== undefined || detail.modelId !== undefined) {
        setModel({ providerId: detail.providerId ?? '', modelId: detail.modelId ?? '' });
      } else {
        setModel(null);
      }
    } catch {
      if (myToken === openSessionTokenRef.current && activeSessionIdRef.current === sid) {
        setModel(null);
      }
    }
  })();
}, [activeSessionId]);
```

**与现有机制协调点**：
- 复用 `openSessionTokenRef`（line 73）—— openSession 和新 effect 都 ++token，互斥使旧响应作废；同一 token 池保证「快切 A→B→A」时 A 的晚到响应被丢弃。
- 复用 `activeSessionIdRef`（line 75-76）—— 防止响应到达时 activeSessionId 已切走。
- 与 `useLayoutEffect`（line 81-83 同帧 setModel(null)）协调：useLayoutEffect 在 paint 前同步清 model → 新 effect 在 paint 后异步回填；二者顺序保证「新 sid 的 header 不残留旧 model 一帧」+「渲染时机独立于进入路径」。
- 无 activeSessionId（首次进入空态）→ effect 内 `if (!sid) setModel(null); return;` 与现状一致（UC-3.1.3）。

**回归风险**：
- 现有 5 个 UT（page-chat.test.tsx 覆盖竞态守卫 + 同帧清空）必须全绿——本变更**只新增 effect，不改 openSession 内现有回填逻辑**（line 134-166 不动），二者通过共享 token 池互斥；如某 UT 显式断言「挂载 effect 不调 getSession」，需迁移断言到新 effect 触发。
- 新 effect 触发额外 1 次 `getSession(sid)` —— 与 openSession 内的 `getSession(sid)` 调用重叠（同一 sid 双调）—— 后端 idempotent，UI 二次回填值相同无副作用；如担心浪费，可让 openSession 移除其内部回填段（line 144-163），改由新 effect 单点负责——**推荐保留 openSession 内回填**（不动现有 5 UT 覆盖的语义），新 effect 是 mount/cross-page-enter 的兜底。

---

## 3. F2 — Markdown GFM 表格支持

**改动文件**：`app/web/src/components/common/primitive-markdown-view.tsx`

**根因**：渲染器按行扫描支持「代码块 / 无序列表 / 段落」（line 63-135），无 GFM 表格分支。`| a | b |` 表头 + `|---|---|` 分隔行 + 数据行被当段落渲染，`|` 字符堆在文本里。

**做法**：在主扫描循环（line 63 `while` 内）现有「代码块」+「无序列表」分支之后、「空行」+「段落」分支之前，**新增一个 GFM 表格分支**：

- 表格识别条件（block 级别，3 行连续匹配）：
  1. 当前 line 匹配表头行：`/^\s*\|.*\|\s*$/`（首尾 `|`，至少 1 列）。
  2. 下一 line 匹配分隔行：`/^\s*\|[\s:|-]+\|\s*$/` 且每段是 `---`/`:---`/`---:`/`:---:`（连字符 ≥ 3 + 可选冒号对齐标记）。
  3. 后续 0..N 行匹配数据行：与表头同形 `/^\s*\|.*\|\s*$/`；遇到非数据行即停。
- 解析列数 = 表头 `|` 数 - 1；对齐数组从分隔行 split 提取（左/右/居中/默认）。
- 输出 `<table>` 结构：`<thead><tr><th style=text-align>×列</tr></thead>` + `<tbody><tr><td>×列</tr>×行</tbody>`；单元格内走现有 `renderInline`（line 19-52，处理 `**bold**` + `` `code` ``）保持行内格式一致。
- 视觉基线（PRD T5 / `_overview.md §8`）：`<table>` 加 `border border-border rounded-md overflow-hidden`；`th` 加 `bg-bg-warm px-3 py-1.5 text-left font-semibold text-fg-2`；`td` 加 `px-3 py-1.5 border-t border-border text-fg-2`；列对齐通过 `style={{ textAlign: 'left'|'right'|'center' }}` 内联（避免污染 tailwind class）。

**回归风险**：
- 非合法表格（缺分隔行 / 表头列数 ≠ 分隔行列数 / 单元格数 ≠ 列数）按现状段落渲染（UC-3.2.3）；不抛错、不强转。
- 现有「段落」分支的 `para.push` 循环（line 117-129）需在 break 条件加上「当前行是表格表头」检查，避免段落吃掉表格首行；同理「列表项」分支后需先尝试表格识别。

---

## 4. F3 — 删 chat-model-tag（非 readOnly 分支）

**改动文件**：`app/web/src/components/chat-page/section-chat-detail.tsx`

**根因**：topbar 左侧 `chat-model-tag`（line 164-170）+ 右侧 `ModelPicker` trigger（line 173）重复展示同一 `provider/model`；ModelPicker trigger 自身已通过 `formatModelDisplay(value, providers)`（`ModelPicker.tsx:70`）显示当前 model，左侧 tag 是冗余。

**做法**：把 line 158-170 的「左侧 div」简化——**仅在 `readOnly` 分支保留** `<span data-testid="chat-model-tag">`；非 readOnly 分支删 tag span（保留 `chat-title` + readOnly 时 `ComponentReadonlyBadge`）。`useProviders` + `formatModelDisplay` 调用（line 145-146）保留——readOnly 分支的 tag 仍需 `modelTag` 显示。

```
<div className="flex items-center gap-2 min-w-0">
  <span data-testid="chat-title" className="text-[14px] font-semibold text-fg truncate">
    {title || '新会话'}
  </span>
  {readOnly && <ComponentReadonlyBadge />}
  {readOnly && (
    <span data-testid="chat-model-tag" className="...ml-2">{modelTag}</span>
  )}
</div>
```

**与现有机制协调点**：
- ModelPicker 在非 readOnly 分支已挂载（line 173）；删 tag 后 trigger 是唯一 model 展示点，无重复。
- readOnly 分支（subagent）—— ModelPicker 不挂载（line 172 条件 `!readOnly`）；保留 tag 是其唯一 model 展示（PRD UC-3.3.2）；tag 不可点选保持现状（无 onClick）。
- `chat-model-picker` testid 沿用（`_overview.md §7`）；现有 UT 断言若显式查 `chat-model-tag` 在非 readOnly 分支存在 → 迁移到查 `chat-model-picker`（testid 已存在，沿用）。

**回归风险**：
- 删 tag 后非 readOnly topbar 左侧只剩 title（+ 可能的 subagent badge）；视觉上 chat-title 不会因 tag 消失而位移（tag 用 `ml-2` margin，删后 title 自然贴左，无 reflow）。
- formatModelDisplay 调用（line 146）的 `modelTag` 变量在非 readOnly 分支不再被引用，但保留调用无害（readOnly 分支仍用）；如需精简可在非 readOnly 时跳过，但收益小、改动量大，本版本保留。

---

## 5. F4 — Squad 聊天头部对齐 playground

### 5.1 F4a — member 单聊头部对齐（改 member.model 持久化）

**改动文件**：`app/web/src/components/studio-page/section-member-chat.tsx`

**做法**：topbar（line 93-104）在 `squad-chat-role-avatar` + `tag` 之后追加 ModelPicker + ComponentUsagePanel + divider + CompactBtn + ClearBtn（参照 `section-chat-detail.tsx:171-194` 的 topbar-right 结构）。

- **ModelPicker**：value 派生自 `member.model`（Member 字段，line 70 of squad-types.ts，是 `ModelRef` string 形如 `providerId/modelId`）；onChange 拆 ModelRef → `{providerId, modelId}` 后调 `patchMember(squadId, member.id, {model: '${providerId}/${modelId}'})`（`squad-api.ts:98` patchMember → `PATCH /squad/:id/member/:mid`，§2.2 已支持 `model?: string`）。**inherit squad.modelDefault**：value=null（model 空串或 undefined）→ 传 `inheritLabel="继承小队默认"` + `onInherit={() => patchMember(squadId, member.id, {model: ''})}`（清 member.model → 后端回退链 `body → member.model → squad.modelDefault → app 默认`，§11-squad.md §127）。**需要新增 prop `squadId`** + 父级 `component-studio-chat-router.tsx:42` 透传 `squadId={detail.id}`。
- **ComponentUsagePanel**：直接接本 section 已有的 `useSessionRunState` 引擎（line 59 已解构出 `usage`/`summaryTask`/`sessionRunning`，run 态契约见 `member-chat-page.md`）——`<ComponentUsagePanel usage={usage ?? emptyUsage} />`；emptyUsage 常量从 `section-chat-detail.tsx` 抽公共（或本地复刻，避免跨 section 导入副作用）。
- **CompactBtn**：`<CompactBtn summaryTask={summaryTask} sessionBusy={sessionRunning} onClick={() => postCompact(sessionId)} />`；`postCompact` from `chat-api.ts`。
- **ClearBtn**：`<ClearBtn onClick={() => setClearModalOpen(true)} />` + 复用 `ComponentClearConfirmModal`（`chat-page/component-clear-confirm-modal.tsx`）。

**F4a member.model 修改 API 确认**：走 **`PATCH /squad/:id/member/:mid`** body `{model: 'providerId/modelId'}`（`squad-api.ts:98 patchMember`，§11a §2.2 已列 `model?` 为可变字段，§11-squad.md §4 路径 4「edit member（改 name/tools/skills/model 等）」已覆盖）。**不发明新 API**。member.model 是 `ModelRef` 单字符串（`providerId/modelId` 形态），后端解析回退链已支持。

### 5.2 F4b — squad 群聊头部对齐（per-call override 进 body）

**改动文件**：`app/web/src/components/studio-page/section-squad-chat.tsx`

**做法**：topbar（line 100-105）在 `title` + `tag` 之后追加 ModelPicker + ComponentUsagePanel + divider + CompactBtn + ClearBtn。

- **ModelPicker（per-call override，前端 state）**：本 section 新增 `const [modelOverride, setModelOverride] = useState<ModelSelection | null>(null)`；`<ModelPicker value={modelOverride} onChange={setModelOverride} />`。**不调任何持久化 API**（PRD OUT-OF-SCOPE：群聊 model override 不污染 squad.modelDefault）。`handleSend`（line 83-92）改：`postMessage(sessionId, { content, providerId: modelOverride?.providerId, modelId: modelOverride?.modelId })`——后端按 body override 解析（§11-squad.md §127 回退链已支持）。
- **ComponentUsagePanel（轮询合并 fetchOnce）**：扩展 `fetchOnce`（line 51-61）在 `getMessages` 之外并行走 `getSessionUsage(sessionId)`（`chat-api.ts:187`）—— 改写为：
  ```
  const fetchOnce = useCallback(async () => {
    try {
      const [msgRes, usageRes] = await Promise.all([
        getMessages(sessionId, { limit: 100 }),
        getSessionUsage(sessionId).catch(() => null),
      ]);
      setMessages(msgRes.items ?? []);
      if (usageRes) setUsage(usageRes);
      ...
    }
  }, [sessionId]);
  ```
  新增 `const [usage, setUsage] = useState<SessionUsageView | null>(null)`。轮询链路不动（挂载 setInterval 2s + 发送后 30s 高频），仅每轮多调一个 GET /session/:id/usage，与现有 polling 共时序不另起 setInterval（PRD §3.4「与现有 fetchOnce 2s 轮询合并，不另起一条轮询」）。
- **CompactBtn**：`<CompactBtn summaryTask={null} sessionBusy={false} onClick={() => postCompact(sessionId)} />`——群聊无 SSE 故 summaryTask=null/idle 兜底；sessionBusy=false（CompactBtn disabled 只看 `summaryTask.status==='running'`，群聊 summaryTask 永 null 故永不 disabled，对齐 §api §7 双保险）。
- **ClearBtn**：同 F4a，复用 `ComponentClearConfirmModal`。

**与现有机制协调点**：
- F4b postMessage body 已支持 `{providerId?, modelId?}`（`chat-api.ts:146-148`，§04-agent-session.md §3.2 + §11-squad.md §3.2），后端零变更。
- F4b 轮询合并：现有 `fetchOnce` 是 useCallback，被 2 个 useEffect 共用（line 64-69 挂载 2s + line 73-80 发送后 30s 高频）；扩展后两个 setInterval 都自动多调一个 usage GET，无需新 setInterval。
- F4b 不接 useSessionRunState（群聊无 agent_loop SSE，沿用轮询模型，§squad-chat-page.md「状态/交互」）。

**回归风险**：
- 群聊头部加 4 组件占位变宽——topbar 已 `flex items-center gap-3`，组件用 divider 隔开；窄屏场景右侧组件可能挤压 title——参照 `section-chat-detail.tsx` 的 `justify-between` 布局，title 容器 `min-w-0 truncate`，右侧 shrink-0，已被 playground 验证。
- F4a ModelPicker value=`member.model`（ModelRef string）需要拆解成 `{providerId, modelId}`——在 MemberChatPage 内做一次性 split（`member.model?.split('/')` → `{providerId: parts[0], modelId: parts[1]}`），空串/null → null（inherit 态）；不污染 ModelPicker 接口。

---

## 6. F5 — SectionRightTabs 退化为薄 wrapper

**改动文件**：`app/web/src/components/studio-page/section-right-tabs.tsx`

**根因**：SectionRightTabs（v0.0.55）自造了 workspace/memory tab bar（line 70-109）+ memory 分支（line 112-116）；而它 tab=workspace 时渲染的 `<SectionWorkspacePanel>` 自身（v0.0.55 同批次）也加了 `<ComponentWsTabBar>`（`section-workspace-panel.tsx:229-236`）+ memory tab（line 249-251）—— 双重 tab bar + 内容两份。

**做法**：把 SectionRightTabs 退化为**薄 wrapper**：

- 删自造 tab bar（line 70-109 整段 `<div className="flex shrink-0 items-center...">` 含 squad-tab-workspace / squad-tab-memory / squad-right-collapse-btn 三个按钮）。
- 删 memory 分支（line 112-116 的 ternary），改为**无条件**渲染 `<SectionWorkspacePanel sessionId={sessionId} />`——后者自带的 `ComponentWsTabBar`（`section-workspace-panel.tsx:229`）+ workspace/memory 内容分支（line 237-251）成为唯一 tab bar + 内容源。
- 删本地 state `active` / `collapsed`（line 39-40）—— tab 切换 + collapse 由 SectionWorkspacePanel 内部 state 管理（localStorage per session 持久化，§component-workspace-panel.md §4）。
- 保留：外层 `<aside data-testid="squad-right-tabs" data-workspace-semantic={workspaceSemantic}>` + minimal className（PRD §3.5「保留 squad-right-tabs wrapper testid + data-workspace-semantic 标记（AT 断言用，不影响渲染）」）。

**目标形态**：
```
export function SectionRightTabs({ sessionId, workspaceSemantic }: SectionRightTabsProps) {
  return (
    <aside
      data-testid="squad-right-tabs"
      data-workspace-semantic={workspaceSemantic}
      className="flex shrink-0 min-w-0"
    >
      <SectionWorkspacePanel sessionId={sessionId} />
    </aside>
  );
}
```

**与现有机制协调点**：
- SectionWorkspacePanel 自带 collapsed 态（`ws-rail` 36px 窄栏 + ws-expand-btn，line 201-219）—— 外层 aside 不再叠 collapse；如需「squad-right-tabs 整体收起」，由 ws-panel 内部 collapsed 自己管（外层 aside 自然跟 ws-panel width 收缩）。
- testid：**废止** `squad-tab-workspace` / `squad-tab-memory` / `squad-right-collapse-btn` / `squad-right-expand-btn`（SectionRightTabs 原自造）；统一用 `ws-tab-workspace` / `ws-tab-memory` / `ws-collapse-btn` / `ws-expand-btn`（`component-ws-tab-bar.tsx:53,66`，由 SectionWorkspacePanel 内部提供）。保留 `squad-right-tabs` wrapper testid + `data-workspace-semantic` attr（AT 断言用，不影响渲染）。
- imports 清理：删 `useState` / `SectionMemoryPanel` / `BrainIcon` / `ChevronRightIcon` / `FolderIcon`，只留 `SectionWorkspacePanel`。

**回归风险**：
- playground 侧 `SectionWorkspacePanel`（chat-page 直接挂，page-chat.tsx:314）不受影响——本变更只改 studio 侧 SectionRightTabs，不动 SectionWorkspacePanel 自身。
- AT 断言若显式查 `squad-tab-workspace` / `squad-tab-memory` → 失效；本版本无 AT（用户豁免），无影响；后续如有 AT 需查 tab，统一用 `ws-tab-*`。
- SectionWorkspacePanel 内部 `ws-collapse-btn`（collapse 整个 ws-panel）替代原 `squad-right-collapse-btn`——视觉行为一致（窄栏 + 展开按钮），testid 改名。

---

## 7. 文件级变更清单（MANDATORY）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/web/src/components/chat-page/page-chat.tsx` | 修改 | 新增 `useEffect([activeSessionId])`：mount / 切 session 时主动 `getSession(sid)` 回填 model；复用 `openSessionTokenRef`/`activeSessionIdRef` 竞态守卫 + 与 `useLayoutEffect` 同帧清空协调 |
| `app/web/src/components/common/primitive-markdown-view.tsx` | 修改 | 主扫描循环新增 GFM 表格 block 分支（表头 + 分隔行 + 数据行 3 段匹配）；输出 `<table>`+`<thead>`+`<tbody>`，列对齐标记 `:---`/`---:`/`:---:` 生效；段落 break 条件加「当前行是表头」防吃表格首行 |
| `app/web/src/components/chat-page/section-chat-detail.tsx` | 修改 | topbar 左侧 `chat-model-tag` 仅 readOnly 分支渲染（line 164-170 加 `readOnly &&` 条件）；非 readOnly 分支删 tag span；`useProviders`/`formatModelDisplay` 调用保留（readOnly 仍需） |
| `app/web/src/components/studio-page/section-member-chat.tsx` | 修改 | topbar 加 ModelPicker（改 member.model 走 `patchMember(squadId, memberId, {model})`）+ ComponentUsagePanel（接 `useSessionRunState.usage`）+ CompactBtn + ClearBtn + ComponentClearConfirmModal；新增 prop `squadId`；value 拆 ModelRef → `{providerId, modelId}`；inheritLabel/onInherit 支持 |
| `app/web/src/components/studio-page/section-squad-chat.tsx` | 修改 | topbar 加 ModelPicker（前端 `modelOverride` state，发送塞进 `postMessage` body）+ ComponentUsagePanel（`fetchOnce` 内 `Promise.all` 合并 `getSessionUsage`）+ CompactBtn + ClearBtn + ComponentClearConfirmModal；新增 `usage` state；`handleSend` 透传 `providerId`/`modelId` |
| `app/web/src/components/studio-page/component-studio-chat-router.tsx` | 修改 | `<MemberChatPage>` 新增透传 `squadId={detail.id}` prop（F4a patchMember 用） |
| `app/web/src/components/studio-page/section-right-tabs.tsx` | 修改 | 退化为薄 wrapper：删本地 state（active/collapsed）+ 自造 tab bar + memory 分支 + icons import；保留外层 `<aside data-testid="squad-right-tabs" data-workspace-semantic>`；无条件渲染 `<SectionWorkspacePanel sessionId={sessionId} />` |

> **不动文件**：`section-workspace-panel.tsx`（F5 不动 ws-panel 自身）/ `component-ws-tab-bar.tsx`（已提供 ws-tab-* testid）/ `ModelPicker.tsx`（inherit 机制已存在）/ `component-usage-panel.tsx`（CompactBtn/ClearBtn 已存在）/ `use-session-run-state.ts`（F4a 接现有 usage 字段）/ `squad-api.ts`（patchMember 已支持 model）/ `chat-api.ts`（postMessage body 已支持 providerId/modelId，getSessionUsage 已存在）/ 任何后端文件。

---

## 8. UT 计划（UT only — PRD §6）

| F | UT 覆盖点 | 测试文件（建议） |
|---|---|---|
| F1 | mount/cross-page-enter 主动 getSession 回填 model；与竞态守卫协调（快切 A→B→A 旧响应丢弃）；与 useLayoutEffect 同帧清空协调（不闪烁）；无 activeSessionId 显空态 | `app/web/src/components/chat-page/__tests__/page-chat.test.tsx`（现有 5 UT 基础上新增） |
| F2 | 合法 GFM 表格（表头+分隔行+数据行）渲染 `<table>`；对齐标记 `:---`/`---:`/`:---:` 生效 `text-align`；非法表格（缺分隔行 / 列数不匹配）按段落渲染不崩；段落 break 不吃表格首行 | `app/web/src/components/common/__tests__/primitive-markdown-view.test.tsx`（新建） |
| F3 | 非 readOnly 分支不渲染 `chat-model-tag`；readOnly 分支保留 tag；切会话 ModelPicker trigger 跟随更新；现有「tag 显 model」UT 迁移到「ModelPicker trigger 显 model」 | `app/web/src/components/chat-page/__tests__/section-chat-detail.test.tsx`（现有基础迁移） |
| F4a | topbar 挂 ModelPicker/ComponentUsagePanel/CompactBtn/ClearBtn；ModelPicker 选 model → 调 `patchMember(squadId, memberId, {model: 'p/m'})`；inherit 选 → `patchMember({...model:''})`；CompactBtn → `postCompact(sessionId)`；ClearBtn 弹 modal → `postClear(sessionId)` | `app/web/src/components/studio-page/__tests__/section-member-chat.test.tsx` |
| F4b | topbar 挂 4 组件；ModelPicker 选 model → 仅本地 state 不调 patchMember；发送时 postMessage body 含 providerId/modelId；fetchOnce 并行 getMessages + getSessionUsage；CompactBtn/ClearBtn 调对端点 | `app/web/src/components/studio-page/__tests__/section-squad-chat.test.tsx` |
| F5 | 渲染 `<SectionWorkspacePanel>`；不渲染 `squad-tab-workspace`/`squad-tab-memory`/原 collapse btn；保留 `squad-right-tabs` wrapper testid + `data-workspace-semantic`；切 tab 走 ws-tab-bar（`ws-tab-workspace`/`ws-tab-memory`） | `app/web/src/components/studio-page/__tests__/section-right-tabs.test.tsx` |

> PRD 关键路径 P1-P6 全覆盖（P1→F1, P2→F2, P3→F3, P4→F4a, P5→F4b, P6→F5）。

---

## 9. Spec 同步清单（doc-modifier 阶段 5 — T1-T7）

| # | spec 文件 | 同步内容 |
|---|---|---|
| T1 | `specs/api/overall/11-squad.md §127` | 「常规 Studio UI 不需要显式传 model」→「常规 Studio UI **可**显式传 model（member 单聊改 member.model 持久化；squad 群聊作 per-call override 进 body，不改 squad.modelDefault）」 |
| T2 | `specs/ui/components/studio-page/squad-chat-page.md` 视觉基线段 | topbar 加 ModelPicker（per-call override）+ ComponentUsagePanel + CompactBtn + ClearBtn |
| T3 | `specs/ui/components/studio-page/member-chat-page.md` 视觉基线段 | topbar 加 ModelPicker（改 member.model，支持 inherit squad.modelDefault）+ ComponentUsagePanel + CompactBtn + ClearBtn |
| T4 | `specs/ui/components/chat-page/_overview.md §4.4 + §7 testid` | 非 readOnly 分支删 `chat-model-tag`；readOnly 分支保留 |
| T5 | `specs/ui/components/chat-page/_overview.md §4.7`（或新增 primitive-markdown-view.md） | primitive-markdown-view 支持 GFM 表格（表头 + 分隔行 + 对齐标记），视觉基线参照 §8 |
| T6 | `specs/ui/components/chat-page/_overview.md §5 交互6` | page-chat mount / activeSessionId 变化时主动 getSession 回填 model（渲染时机独立于进入路径） |
| T7 | `specs/ui/components/studio-page/section-right-tabs.md` | SectionRightTabs 退化为薄 wrapper 渲染 SectionWorkspacePanel（tab bar 由 ws-tab-bar 提供）；废止 `squad-tab-*` testid |

> 不动 `specs/tech/` 各子系统 OKF KB（事实层零变更）；纯前端 UI 修复 + 对齐，无架构原则新增。

---

## 10. 不影响范围 / 风险小结

- **后端**：零变更（F4a patchMember / F4b postMessage body / usage GET / compact / clear 全是现有端点）。
- **playground 侧**：F1/F2/F3 改 playground；F4/F5 不动 playground；SectionWorkspacePanel 自身不动（F5 只动 studio 侧 wrapper）。
- **现有 UT 回归**：page-chat 现有 5 个竞态/同帧清空 UT 必须全绿（F1 不破坏）；section-chat-detail 现有 UT 中 `chat-model-tag` 断言迁移到 `chat-model-picker`（F3）。
- **文件大小**：所有改动文件维持 ≤ 300 行（page-chat.tsx 现 340 行——接近上限但本版本仅新增 ~25 行 effect，需 coder 注意如超限可把 model restore effect 抽到 `use-model-restore.ts` hook；section-member-chat.tsx 现 175 行 + 新增 ~30 行；section-squad-chat.tsx 现 170 行 + 新增 ~40 行；section-right-tabs.tsx 现 122 行 - 删 ~70 行 + 加 ~10 行）。
- **PRD 关键路径 P1-P6 全覆盖**（UT only，无 AT/ET）。
