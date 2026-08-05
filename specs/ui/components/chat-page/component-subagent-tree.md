# component-subagent-tree

> 层级: component（嵌于 `component-conversation-item` 内，有 subagent 时展开）
> 文件: app/web/src/components/chat-page/component-subagent-tree.tsx
> 数据权威: `specs/tech/multi_agent/[P1]subagent_derivation.md §7`（list_children = swarm，running/terminated 分组）
> 数据源: `GET /session/:id/children`（REST，父级 `refreshChildren` 触发拉取写 store；`fetchedRef` 防重复 GET）。**无 SSE 订阅**——`useLifecycle` 仅借来做 unmount 时 abort in-flight，无实时增量；running/terminated 由父 conv-item 注入。
> 本文是 subagent 展开树的概念权威源：定义三段展开结构、identity 视觉、交互、视觉基线。PRD/编码对齐本文。

## 职责
会话列表项（parent session）有 subagent 时，展开显示其派生的 children（swarm）——三段结构：① running subagent 列表 → ② 分割线「非运行中 (N)」+ 展开按钮 → ③ terminated subagent 列表灰显。点击子项切换到该 subagent 只读页面。
本组件同时是 academy 训练观察页 subagent 树的共享实现（academy 平行版已删）：flat 形态 + onOpenNode 观察入口以 props 表达差异，无 kind 分支。
边界：不做 squad/角色层（leader/member/SquadChat）；只展示 parent 派生的 subagent。无 subagent 时整个组件不渲染（conv-item 占位 placeholder 对齐）。

## Props
- parentSessionId?: string      // 仅日志/审计；academy flat 形态不传
- running: SubagentNode[];      // running 态（按 updatedAt desc）
- terminated: SubagentNode[];   // terminated 态（idle/error/interrupted，按 update...
- activeSubId?: string;         // 当前选中的 subagent sessionId（高亮）
- onSelectSub?: (subSessionId: string) => void  // 行点击；缺省行不可点（academy 树行本身不可点）
- onOpenNode?: (sessionId: string) => void      // running 行渲「观察 →」链接（academy 观察入口）；缺省不渲
- openNodeLabel?: string        // 观察链接文案注入（academy 传 iter.watch「👁 观察 →」；缺省 chat:subagent.observe）
- terminatedLabel?: string      // 折叠分割线文案注入（缺省 chat:subagent.terminatedCount「非运行中 (N)」）
- flat?: boolean                // 平铺形态：行/toggle 去 48px conv 缩进（academy 独立列用）；缺省 false = conv 嵌套形态
- sessionId: string
- name: string;                 // subagent 显示名（subAgentTemplateType 或系统名）
- state: "running" | "idle" | "error" | "interrupted" | "interrupting" | "suspe...
- updatedAt: string

## 状态 / 交互
  - **收起例外 — activeSubIsMyChild**：active→false 收起 tree 有一**例外**——若当前 `activeSubId` 属于本 conv-item 的 children，则**不收起 + 兜底渲染 tree**。理由：用户需看到兄弟 subagent 列表 + 当前选中在 tree 里高亮的位置，否则刚选的 subagent 在 tree 里消失，体验断裂。
- **点 subagent 子项** → `onSelectSub(sessionId)` → 父切到该 subagent 只读页面（SectionChatSession，chrome.readOnly 自动 true）。
- **terminated 灰显**：idle/error/interrupted → `opacity-0.4` + name 。
- **无 subagent**：tree 不渲染（行点击无展开动作；conv-item title 左对齐贴 padding，无 twisty 占位）。

## 复用关系
- 被组合：`component-conversation-item`（conv-item 内，有 subagent 时挂载；无则不渲染）
- 被组合：`academy-page/component-train-view-col`（flat 形态 + onOpenNode/openNodeLabel/terminatedLabel 注入，running 行「👁 观察 →」跳只读 transcript；design §8.8 观察入口仅进行中可点）
- 不组合其他（identity dot 是内联 span，不复用 primitive）
- 视觉基线对齐 `_overview.md §8`（tokens 新增 `--color-indigo`）
