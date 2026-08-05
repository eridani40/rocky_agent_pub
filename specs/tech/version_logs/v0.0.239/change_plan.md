# v0.0.239 变更计划书 — session 工作区 file tab 文件自然排序（numeric-aware，对齐 VSCode）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 决策基线见 `specs/prd/version_logs/v0.0.239/change_log.md` §0（D1–D7 全部用户已拍板）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 内） |
| 函数/符号 | 函数名或符号名（新增 interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 核心架构决策（落点 = reducer ingest，非渲染层）

**比较器落点 = `workspace-slice-reducer.ts` 的 `setTreeLoaded` + `setChildrenLoaded` 两个 ingest 点**（不是渲染层 `TreeLevel`）。理由（对应 PRD §6.3 三条件）：

1. **条件①「数据进渲染前必经排序」✓**：reducer 是 `state.tree` / `state.childrenCache[path]` 写入 state 的唯一入口；在 ingest 时 `.sort(compareWorkspaceNodes)` 保证 state 本身即有序，渲染层 `TreeLevel` 无需任何排序逻辑、零改动。
2. **条件②「缓存命中也有序」✓**：`childrenCache[path]` 在 `setChildrenLoaded` 写入时已排序；折叠再展开走缓存读 path 直接有序，无需重排。
3. **条件③「SSE stale 重取走同 ingest」✓**：SSE `file_changed` → `applyWorkspaceFileChanged` 标 stale → `ComponentWsFileTree` useEffect 监测到 stalePaths 中已展开父 → `onStaleRefetch` → 父组件重 GET → 又调 `setTreeLoaded`/`setChildrenLoaded`（同一 ingest）→ 自动有序，无需额外分支。

**为何不选渲染层 `TreeLevel`**：(a) 渲染层每次 re-render 重排（性能微亏 + 语义混乱）；(b) `state.tree`/`childrenCache` 本身仍无序，未来若有其他消费者（debug 端点、导出等）拿到的是无序数据；(c) 违背 reducer 文件 header 已声明的「数据规整层」职责（L1-18 注释明示「拉数据后直接调用的状态更新」）。reducer 落点把「已排序」升级为 state invariant，单一职责、UT 友好（纯函数断言「乱序输入→有序输出」）。

**比较器选型 = 自定义分段比较器（非 `localeCompare(numeric)`）**：orchestrator 实测 `localeCompare(numeric:true)` 对 `9.txt` vs `09.txt` 返回 0（不兜底）；用户要确定性文字兜底（D 决策基线）。算法 = 拆交替「文字段+数字段」→ 文字段字符串序（大小写不敏感）+ 数字段数值序 + **同值数字段按原 digit 字符串兜底**（`"09"` < `"9"` 因 `'0'` < `'9'`）→ 外层先按节点类型分组（dir < file）。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-workspace-sort | app/web/src/lib/natural-sort.ts | compareNaturalNames | 新增 | 自然序字符串比较器：把两字符串按交替「文字段+数字段」拆 chunk 后逐段比较——文字段按字符串序（大小写不敏感）、数字段按数值大小比较；若两数字段**数值相等但原 digit 字符串不同**（如 `09` vs `9`，值都=9）则**再按原 digit 字符串序兜底**比较（`"09"<"9"` 因 `'0'<'9'`，与 VSCode 一致）。返回 -1/0/1。签名 `compareNaturalNames(a: string, b: string): number`。 | MUST 自定义分段（**禁 `localeCompare(numeric:true)` 一把梭**——D 决策）；MUST 数字段按数值比较（`90<100`）；MUST 同值不同格式走 digit 字符串兜底（不返回 0）；文字段大小写不敏感的具体实现 coder 定（建议 `localeCompare(sensitivity:'base')` 不带 numeric，或 `toLowerCase()` 对比——文件名 ASCII 为主两者等价）；MUST 纯函数无副作用；返回值符合 Array.sort comparator 契约 | PRD §1 不变量「逐段比较」+ §2.1 排序规则 + §4 架构期责任 | +35 |
| ui-workspace-sort | app/web/src/lib/natural-sort.ts | compareWorkspaceNodes | 新增 | workspace 节点比较器（reducer 直接喂给 `.sort`）：**先按 `node.type` 分组**（`'dir'` < `'file'`，文件夹置顶）→ **同组内按 `compareNaturalNames(a.name, b.name)`** 自然序。签名 `compareWorkspaceNodes(a: WsTreeNode, b: WsTreeNode): number`。 | MUST 复用 `compareNaturalNames`（不重写比较逻辑）；MUST 文件夹（`type==='dir'`）排在文件（`type==='file'`）前——D7 决策对齐 VSCode 默认；MUST `WsTreeNode` 类型从 `app/web/src/components/chat-page/workspace-types` import（type-only import，不引入运行时依赖）；**节点 type 字段枚举 = `'file' \| 'dir'`**（已核实 `workspace-types.ts` L17，非 `'folder'`）；返回值符合 Array.sort comparator 契约 | PRD §1 不变量「文件夹置顶」+ §2.1 节点类型判定；workspace-types.ts L11-20 | +12 |
| ui-workspace-sort | app/web/src/store/workspace-slice-reducer.ts | setTreeLoaded | 修改 | ingest 顶层 tree 时排序：在写入 `state.tree` 前对 `tree` 数组调用 `[...tree].sort(compareWorkspaceNodes)`（**复制后排序，不突变入参**），把已排序数组塞进 next state。其余逻辑（stale.delete('')、loading=false、workspaceDir 填充）零变更。 | MUST 用 `compareWorkspaceNodes`（从 `../lib/natural-sort` import）；MUST 复制后排序（`[...tree].sort(...)`）不突变 caller 传入的数组；MUST NOT 在渲染层再排（避免双重排序）；保持纯函数返回新 state 不变；签名（state, workspaceDir, tree）零变更 | PRD §6.3 落点条件①③；workspace-slice-reducer.ts L92-106 | +2/-0 |
| ui-workspace-sort | app/web/src/store/workspace-slice-reducer.ts | setChildrenLoaded | 修改 | ingest 子目录 children 时排序：在写入 `state.childrenCache[parentPath]` 前对 `children` 数组调用 `[...children].sort(compareWorkspaceNodes)`（复制后排序），把已排序数组塞进 next state。其余逻辑（stale.delete(parentPath)、loadingChildren=false）零变更。 | MUST 用 `compareWorkspaceNodes`；MUST 复制后排序不突变入参；MUST NOT 在渲染层再排；保持纯函数返回新 state；签名（state, parentPath, children）零变更；**这是缓存命中也有序的关键**（条件②） | PRD §6.3 落点条件②③；workspace-slice-reducer.ts L109-122 | +2/-0 |
| ui-workspace-spec | specs/ui/components/chat-page/component-workspace-panel.md | §4.X 文件排序（新增小节） | 新增（spec 动作，coder 编码前置产出） | 新增「§4.X 文件排序：文件夹置顶 + 自然序 numeric-aware」小节：声明顶层 `state.tree` + 子目录 `state.childrenCache[path]` 在 reducer ingest（`setTreeLoaded`/`setChildrenLoaded`）时**先按节点类型分组（`type==='dir'` 在前、`'file'` 在后）再按自定义分段自然序**（文字段字符串序+数字段数值序+同值 digit 兜底）排序；watch/SSE stale 重取走同 ingest 自动有序；节点 type 枚举 `'file'\|'dir'`（对齐 api §2.6.1 WsTreeNode）。 | MUST 引用本 change_plan 的 compareWorkspaceNodes 契约；MUST 明示「排序在 reducer ingest（非渲染层）」；MUST 明示三条件（数据进渲染前必经排序 / 缓存命中也有序 / SSE 重取同 ingest）；MUST NOT 发明新概念（复用既有 tree/childrenCache 数据契约）；遵循 `_conventions.md` spec 规范 | PRD §4 spec gap；component-workspace-panel.md §3 数据契约 + §8 state | +25 |

## 显式不变（OUT OF SCOPE — 零变更明示）

以下文件/接口**本版本零变更**（PRD §5 OUT 边界 + D2 决策"排序位置=前端"），coder 不得擅自修改：

| 文件 / 接口 | 不变原因 |
|---|---|
| `app/server/src/handlers/session-workspace.ts` `handleWorkspaceTree`（L78-162，`readdirSync` L127 原样返 `nodes`） | 后端零变更（D2：排序纯前端）；后端 OS 字节序根源不动 |
| `app/server/src/routes/session-routes.ts`（L135 注册 `GET /session/:id/workspace/tree`） | 路由零变更 |
| `app/web/src/lib/chat-api/workspace-api.ts` `getWorkspaceTree`（L18-32 纯透传） | HTTP 客户端零变更 |
| `app/web/src/components/chat-page/component-ws-file-tree.tsx` `TreeLevel`（L100-139 `items.map`） | 渲染层零变更（排序落点在 reducer，不在渲染层） |
| `app/web/src/components/chat-page/section-workspace-panel.tsx`（fetch/SSE stale 链路） | 数据流零变更（stale 重取走既有 onStaleRefetch → reducer ingest） |
| `app/web/src/components/common/file-tree.ts`（技能管理页） | OUT OF SCOPE（D5：同问题但不在本版本范围） |
| `specs/api/overall/04-agent-session.md` §2.6 workspace 端点 | API 契约零变更（排序不进接口） |
| chokidar watch / SSE event payload / stalePaths 机制 | watch/SSE 行为零变更 |

## 影响面评估

- **范围**：纯前端 UI 改动，1 个新 util 文件（`natural-sort.ts`，~50 行 ≤300 行限）+ 1 个 reducer 文件改 2 行 + 1 个 spec 文件补 1 小节。
- **跨模块**：仅 `ui-workspace-sort`（前端 lib + store + spec 三处，强内聚）；不动后端 / 不动 API 契约 / 不动 watch-SSE / 不动 plugin / 不动 runtime-config / 不动路径展开——**packaged 专属四陷阱全部不沾**（PRD §7 已确认）。
- **依赖顺序**：`natural-sort.ts`（底层 util，零依赖）→ `workspace-slice-reducer.ts`（import util）→ spec 文档。无循环依赖（`natural-sort.ts` 仅 type-only import `WsTreeNode`，不引入运行时回路）。
- **风险点**：(1) `compareNaturalNames` 边界正确性（`09` vs `9`、`a9` vs `a10`、大小写、纯数字、纯文字、混合前缀）—— 必须有 UT 覆盖（coder 写 UT，断言对齐 VSCode 实测行为）；(2) reducer 复制后排序不突变入参（caller 可能持有原数组引用）。
- **三处复用入口全覆盖**：`SectionWorkspacePanel` 链路改一处（reducer），chat-page / academy section-version-chat / studio section-right-tabs 三处同时受益（v0.0.227 已验证共用）。
- **测试策略**：UT 为主（比较器边界 + reducer ingest 排序 + 缓存命中有序）；本版本无新持久 AT/ET case（PRD §3 已定：普通 feature + UI-only UT 豁免倾向，由 orchestrator 在 test-plan 裁决）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件如后端 handler、动未声明符号、破约束列如用 `localeCompare(numeric)` 一把梭、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
