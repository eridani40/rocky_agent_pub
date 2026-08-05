# v0.0.229 变更计划书 — task 筛选器 OKR/req 漏出去干净 + task 看板响应式

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | 依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 背景与决策（orchestrator 已读码核实，非委派 architect）

两个 v0.0.223 残留问题，根因与修法唯一、无方案分歧，故由 orchestrator 直接产出本表（CLAUDE.md：纯技术/UI 改动跳过 PRD）：

- **issue 1（漏出）**：`component-board-toolbar.tsx:53` 渲染 `BoardTaskFilterBar` 时只判 `tab==='tasks'`，未过 `isFeatureOkrOn()`。筛选器三选项里「按 Req / 按 KR」即 OKR/requirement 关联。修复 = 渲染条件加 gate（gate 关 → 整个筛选条不渲染，仅留「全部」语义即不筛选）。组件本体不删（gate 内保留代码，对齐 v223「不删除代码」原则）。
- **issue 2（响应式）**：`component-board-tasks-view.tsx:85` 列 `flex w-[200px] shrink-0` 固定宽；父容器 `component-panorama-route.tsx:206` 固定 tab 区 `max-w-[920px]` 第二道宽度枷锁。全景 DSL kanban（`component-panorama-kanban.tsx:51`）v223 已做 `min-w-[200px] flex-1` 响应式（窄缩/宽平铺 + overflow-x-auto 兜底）。修复 = task 列对齐同一 class + 去 panorama-route 的 max-w 约束。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | app/web/src/components/studio-page/component-board-toolbar.tsx | `BoardToolbar`（BoardTaskFilterBar 渲染条件） | 修改 | 导入 `isFeatureOkrOn`；`{tab === 'tasks' && ...}` 改 `{tab === 'tasks' && isFeatureOkrOn() && <BoardTaskFilterBar .../>}`，gate 关时筛选条不渲染 | MUST 复用 `lib/feature-gates.ts` 的 `isFeatureOkrOn()`；MUST NOT 删 BoardTaskFilterBar 组件/filter 逻辑（gate 内保留） | specs/tech/app/[P1]feature_gate.md §3；req 第1条 | +1 / -0 |
| ui-studio | app/web/src/components/studio-page/component-board-tasks-view.tsx | `TaskColumn`（列容器 className） | 修改 | 列容器 `flex w-[200px] shrink-0 flex-col ...` 改 `flex min-w-[200px] flex-1 flex-col ...`，窄屏缩/宽屏平铺 | MUST 对齐 component-panorama-kanban.tsx:51 列 class 范式（`min-w-[200px] flex-1`，无 shrink——flex-1 自带 flex-shrink:1）；MUST 保留外层 `overflow-x-auto pb-2` 兜底（:137） | component-panorama-kanban.tsx:51；req 第2条 | +1 / -1 |
| ui-studio | app/web/src/components/studio-page/component-panorama-route.tsx | `PanoramaRoute`（固定 tab SquadBoard 容器 className，:206） | 修改 | 固定 tab 容器 `max-w-[920px] px-8 pb-10 pt-5` 去 `max-w-[920px]`（改 `w-full`），让 task 看板铺满可用宽度；仅动固定 tab 容器，不动动态 view/more 分支 | MUST 只去固定 tab（SquadBoard）容器宽度约束；MUST NOT 改 PanoramaView / PanoramaIdle 容器 | req 第2条（页面变宽看板自动铺开） | +1 / -1 |
| ui-studio | app/web/src/components/studio-page/__tests__/component-squad-board.test.tsx | `T6 — 筛选器` describe（:716-785） | 修改 | 5 个筛选器用例包 `vi.stubGlobal('__FEATURE_OKR__', true)`（gate 开才渲染筛选条）；`beforeEach/afterEach` 复位 unstub；新增 1 用例：gate=false 时不渲染筛选条（无「按 Req/按 KR」按钮） | MUST 用 vi.stubGlobal 双值 mock（勿改 vitest.config 加 define）；MUST 保持既有断言在 gate=true 下成立 | feature-gates.ts 头注释；spec squad-board.md 筛选器契约 | +12 / -2 |
| ui-studio | app/web/src/components/studio-page/__tests__/component-squad-board.test.tsx | 看板列响应式断言（新增 1 用例） | 新增 | 断言 task 列容器 class 含 `min-w-[200px]` + `flex-1`、不含固定 `w-[200px]`（响应式回归锚点） | MUST 走 className 断言（jsdom 无布局）；MUST NOT Read 截图 | component-panorama-kanban 范式 | +8 / -0 |

## 影响面评估

- **范围**：纯前端 `app/web/src/components/studio-page/` 3 个产品文件 + 1 个测试文件。无后端 / API / 落库 / SSE 变更。
- **破坏性**：无。issue 1 在 gate 开（`__FEATURE_OKR__=true`）时行为完全不变（筛选条照常渲染）；gate 关时才隐藏——与 v223 其余 gate 点行为一致。issue 2 是 CSS 宽度行为放宽（窄屏仍 200px 可滚，宽屏平铺），不改交互/数据。
- **依赖顺序**：无跨层依赖，单文件内聚改动，可单 task 完成。
- **风险点**：① T6 筛选器测试原在 gate 默认关下渲染出筛选条（说明现网测试未 stub，依赖 jsdom 裸标识符回落 false 却仍渲染——因渲染处此前无 gate 判断）；包裹 gate 后这些用例必须显式 stub true，否则筛选条消失致断言崩。② 全景 route 去 max-w 后 goals/requirements tab（gate 开时）也铺满——与 DSL view 容器行为对齐，属预期。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
