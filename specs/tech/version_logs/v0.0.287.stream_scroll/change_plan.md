# v0.0.287 变更计划书 — 流式滚动 sticky-bottom 间歇失效修复

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/version_logs/v0.0.287.stream_scroll/prd.md`。版本上下文：`states/v0.0.287/context.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 |

## 架构裁决（对齐 PRD 4 留口）

### 裁决 1：程序滚动标记位 vs ResizeObserver → **选标记位（方向 A）**

**选 A（programmaticScrollRef + userInteractedRef）否决 B（ResizeObserver）理由**：

1. **精确贴合四状态决策表**：四状态核心 = 状态①上一轮位置 + 状态④用户操作综合判定。标记位直接表达「这次 scroll 事件是程序还是用户触发的」，onScroll 据此决定是否更新 nearBottom——与四状态一一对应。ResizeObserver 只能感知「内容高度变化」，不区分 scroll 事件的来源（编程 scrollTop vs 用户 wheel vs 内容撑高），语义偏移。
2. **一个机制覆盖所有程序 scroll**：autoScroll effect（rAF 滚底）、scrollToBottom（气泡点击）、prepend restore（loadMore 恢复 scrollTop）三处编程设 scrollTop 都设 programmaticScrollRef=true，onScroll 统一过滤。ResizeObserver 只覆盖「内容撑高」一种。
3. **改动可控**：标记位改动集中在 hook 内部（3 个 ref + onScroll 逻辑）+ message-stream 加 3 个事件监听（wheel/touchmove/keydown）。ResizeObserver 需新增 observer + 断开逻辑 + 高度比较 + 与既有 autoScroll effect 的协调——改动面更大且引入新的异步源。
4. **回归面最小**：标记位不改变 hook 返回签名 / autoScroll 触发语义 / rAF 合并 / 5 invariants——只在 onScroll 入口加一个过滤层。

### 裁决 2：用户操作时效窗口 = **500ms**

PRD 建议 ~500ms。取 **500ms**。用户交互（wheel/touchmove/keydown）后 500ms 内允许 nearBottom 自由更新（用户可能在连续滚动）；窗口外恢复空间判定模式。用 `userInteractDeadlineRef`（`number` 时间戳，`performance.now() + 500`）实现——onScroll 检查 `performance.now() < deadline` 则允许更新。

### 裁决 3：fake scrollRef helper 扩展

scroll-ref-helper.ts 加 `triggerScroll(scrollTopOverride?)` 方法（模拟编程设 scrollTop 后异步触发 scroll 事件 + 设置 programmaticFlag）+ `simulateUserScroll(deltaTop)` 方法（模拟用户 wheel 改变 scrollTop 再触发 scroll 事件，不设 programmaticFlag）。用于 UT 四状态决策 + 竞态时序模拟。

### 裁决 4：L111 注释修正

旧注释（错误）：`// 编程设 scrollTop 不触发 scroll 事件——显式置 true 保持 sticky（滚到底后自然在底部附近）。`
新注释（正确）：`// 编程设 scrollTop 会异步触发 scroll 事件——rAF 回调前置 programmaticScrollRef=true，onScroll 检测到则跳过 nearBottom 更新（防误判）+ rAF 回调后异步清标记（queueMicrotask）。显式置 nearBottomRef=true 保持 sticky。`

## 四状态决策落地方式（D1 表 → 代码映射）

```
onScroll 入口（每次 scroll 事件触发）:
  ① 检查 programmaticScrollRef.current === true
     → YES: 程序滚动（autoScroll/scrollToBottom/prepend）→ 跳过 nearBottom 更新 + queueMicrotask 清标记 → return（仍做 loadMore 检查）
     → NO: 继续 ②
  ② 检查 performance.now() < userInteractDeadlineRef.current
     → YES: 用户操作窗口内 → 正常更新 nearBottom（空间判定）→ 继续 ③
     → NO: 非用户操作触发（内容撑高等）→ 不更新 nearBottom → 继续 ③
  ③ loadMore 触发检查（仅 hasMore && scrollTop < threshold，不变）
```

**四状态对应**：
- 状态①上一轮在底部 = nearBottomRef.current（effect 门控读它，保持 true 不被程序 scroll 篡改）
- 状态④无用户操作 = userInteractDeadlineRef 过期 / 未设过 → onScroll 不更新 nearBottom → nearBottomRef 保持 true → effect 门控通过 → 追赶
- 状态④有用户操作 = userInteractDeadlineRef 在窗口内 → onScroll 正常更新 nearBottom → 用户上翻算出 false → nearBottomRef=false → effect 门控不通过 → 停留

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | programmaticScrollRef | 新增 | `useRef(false)`——编程设 scrollTop 前置标记。autoScroll rAF 回调内 `el.scrollTop = el.scrollHeight` 前设 `programmaticScrollRef.current = true`，回调末尾 `queueMicrotask(() => { programmaticScrollRef.current = false })` 异步清标记（microtask 在 scroll 事件触发后执行，保证 scroll 事件能看到 true） | MUST 编程 scrollTop 前设 true；MUST scroll 事件处理完后清 false（queueMicrotask 异步清，不提前清——scroll 事件在当前 task 后微任务前派发）；MUST 初始 false | PRD D2 §2.2；裁决1 | +3 |
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | userInteractDeadlineRef | 新增 | `useRef(0)`——用户操作时效截止时间戳（`performance.now()` 基准）。用户交互事件（由 message-stream 挂载 wheel/touchmove/keydown → 调 hook 返回的 markUserInteract）设 `userInteractDeadlineRef.current = performance.now() + USER_INTERACT_WINDOW_MS`。onScroll 检查 `performance.now() < userInteractDeadlineRef.current` 判定是否在用户操作窗口内 | MUST 用户交互后才设 deadline；MUST 初始 0（过期态=无窗口）；MUST USER_INTERACT_WINDOW_MS=500 常量导出 | PRD D3 §2.3；裁决2 | +5 |
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | USER_INTERACT_WINDOW_MS | 新增 | 导出常量 `= 500`——用户操作时效窗口毫秒数。onScroll 用 `performance.now() < userInteractDeadlineRef.current` 判窗口内/外 | MUST 500（PRD 建议 ~500ms）；MUST 导出（UT + message-stream 可引用） | PRD D3；裁决2 | +2 |
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | markUserInteract() | 新增 | hook 返回新方法 `markUserInteract: () => void`——设 `userInteractDeadlineRef.current = performance.now() + USER_INTERACT_WINDOW_MS`。message-stream 挂 wheel/touchmove/keydown 监听到调此方法（标记用户操作发生 + 开时效窗口） | MUST 是 useCallback（稳定引用供 effect 依赖）；MUST 只设 deadline 不改 nearBottom（nearBottom 由 onScroll 在窗口内更新）；MUST 返回签名新增字段（向后兼容——现有解构不取 markUserInteract 照常） | PRD D2/D3 §2.2/§2.3；裁决1 | +6 |
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | onScroll() | 修改 | 入口加程序/用户 scroll 区分逻辑：①`programmaticScrollRef.current === true` → 跳过 nearBottom 更新（`queueMicrotask` 清标记已在 rAF 回调末尾排好，onScroll 不重复清）→ 继续做 loadMore 检查 ②`programmaticScrollRef.current === false` → 检查 `performance.now() < userInteractDeadlineRef.current`：YES → 正常更新 nearBottomRef + setNearBottom（空间判定）；NO → 跳过 nearBottom 更新（非用户操作触发的 scroll，如内容撑高）→ 继续做 loadMore 检查 | MUST 程序 scroll 跳过 nearBottom 更新（根治竞态核心）；MUST 用户窗口内才更新 nearBottom（状态④落地）；MUST loadMore 检查始终执行（invariant ⑤ 保留——loadMore 不受标记位影响）；MUST nearBottom 计算公式不变（`scrollHeight - scrollTop - clientHeight <= 120`） | PRD D1/D2 §2.1/§2.2；四状态决策落地方式；hook invariants ④⑤ | +12/-4 |
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | autoScroll effect（rAF 回调） | 修改 | rAF 回调内 `el.scrollTop = el.scrollHeight` 前置 `programmaticScrollRef.current = true`；回调末尾 `queueMicrotask(() => { programmaticScrollRef.current = false })`（microtask 清标记——scroll 事件在当前宏任务后、微任务前派发，microtask 保证 scroll handler 看到标记后清）。L111 注释修正（裁决4）。nearBottomRef.current=true 保留 | MUST 编程 scrollTop 前设标记 + scroll 事件后清标记（queueMicrotask 时序）；MUST nearBottomRef.current=true 保留（sticky 语义）；MUST rAF 合并 + cancel cleanup 不变；MUST isLoadingMore/wasLoadingMoreRef 跳过不变（invariant ①②） | PRD D2 §2.2；裁决1/4；hook invariants ①② | +4/-1 |
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | scrollToBottom() | 修改 | `el.scrollTo({ top, behavior })` 前置 `programmaticScrollRef.current = true`；末尾 `queueMicrotask(() => { programmaticScrollRef.current = false })`。新增 `userInteractDeadlineRef.current = 0`（重置用户操作状态——D4 回到底部恢复吸底）。nearBottomRef=true + setNearBottom(true) 保留 | MUST 编程 scrollTo 前设标记（与 autoScroll 一致）；MUST 重置 userInteractDeadlineRef=0（D4 恢复吸底——重置后 onScroll 不在用户窗口内，nearBottom 不被篡改）；MUST nearBottom=true 保留（气泡消失） | PRD D4 §2.4；裁决1 | +4/-1 |
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | prepend restore effect（useLayoutEffect L86-91） | 修改 | `scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevHeightForPrependRef.current` 前置 `programmaticScrollRef.current = true`；useLayoutEffect 末尾 `queueMicrotask(() => { programmaticScrollRef.current = false })`。防 prepend restore 的编程 scrollTop 触发 scroll 事件误判 nearBottom | MUST prepend restore 前设标记（防 prepend 位置恢复的 scroll 事件误判 nearBottom）；MUST queueMicrotask 清标记（同 autoScroll 时序）；MUST prevHeight 恢复逻辑不变（invariant ③） | PRD D2 §2.2；hook invariants ③ | +3 |
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | 返回签名 | 修改 | `{ onScroll, nearBottom, scrollToBottom }` → `{ onScroll, nearBottom, scrollToBottom, markUserInteract }` | MUST 新增字段向后兼容；MUST markUserInteract 为稳定引用（useCallback） | PRD F11 §3.3 | +1 |
| ui-chat | app/web/src/components/chat-page/component-message-stream.tsx | ComponentMessageStream() 用户交互监听 | 修改 | ① hook 解构新增 `markUserInteract` ② scroll div 加 `onWheel={markUserInteract}` + `onTouchMove={markUserInteract}` + `onKeyDown={markUserInteract}`（React 合成事件，keydown 需 scroll div `tabIndex={0}` 可聚焦——或挂到外层 wrapper） | MUST 3 事件挂载（wheel/touchmove/keydown = 用户交互 D2）；MUST 用 React 合成事件（非 addEventListener——生命周期自动清理）；MUST keydown 需 scroll 容器可聚焦（tabIndex）；MUST 不改 onScroll 挂载（invariant ⑤） | PRD D2 §2.2 F2；裁决1 | +6/-1 |
| ui-chat | app/web/src/components/chat-page/__tests__/scroll-ref-helper.ts | triggerScroll() + simulateUserScroll() | 新增 | ①`triggerScroll(newScrollTop?, newScrollHeight?)`：设 programmaticFlag=true + 更新 scrollTop/scrollHeight backing + 调 onScroll + queueMicrotask 清标记（模拟编程设 scrollTop 后异步触发 scroll 事件全流程）②`simulateUserScroll(deltaTop)`：不设 programmaticFlag + scrollTop += deltaTop + 调 onScroll（模拟用户 wheel 触发 scroll 事件） | MUST triggerScroll 模拟编程 scroll 全流程（标记位 true→onScroll→microtask 清）；MUST simulateUserScroll 不设标记（用户 scroll）；MUST 两方法调 onScroll（测试 hook 逻辑入口）；MUT queueMicrotask stub（installSyncRaf 已有 rAF，需补 queueMicrotask 同步执行） | PRD §8 UT；裁决3 | +35 |
| ui-chat | app/web/src/components/chat-page/__tests__/scroll-ref-helper.ts | installSyncMicrotask() | 新增 | 同 installSyncRaf 模式：stub `globalThis.queueMicrotask` 同步执行 cb（单测中等价于立即清标记）。返回卸载函数 | MUST 同步执行（单测无真微任务调度）；MUST 返回卸载函数（恢复原 queueMicrotask） | 裁决3 | +12 |
| ui-chat | app/web/src/components/chat-page/__tests__/use-message-scroll-pagination.test.tsx | 四状态 + 竞态时序 + 回归 | 修改 | ①程序 scroll（triggerScroll）→ nearBottom 不更新（保持 true）②用户 scroll（simulateUserScroll）+ 窗口内 → nearBottom 更新（上翻=false）③用户窗口外（wait 500ms+）→ nearBottom 不更新 ④竞态模拟：rAF 设 scrollTop=scrollHeight + 模拟内容撑高 scrollHeight+200 + triggerScroll → nearBottom 保持 true（核心 bug 修复断言）⑤scrollToBottom → nearBottom=true + userInteractDeadlineRef 重置 ⑥回归：loadMore prepend 保持/sticky 门控/气泡显隐（既有用例全绿） | MUST 竞态模拟用例（④）为核心修复断言；MUST 既有 baseline 用例全绿（向后兼容）；MUST installSyncRaf + installSyncMicrotask 组合使用 | PRD §8 UT 范围 | +80 |

## 影响面评估

- **跨模块**：单模块 ui-chat（hook 1 文件 + message-stream 1 文件 + 2 测试文件），无后端/API/协议/i18n 改动，纯前端 bug 修复。
- **零改动声明**：autoScroll 触发语义（contentSignature）/ rAF 合并 / NEAR_BOTTOM_THRESHOLD=120 / 引导气泡组件 / 5 invariants 全保留。
- **关键时序设计**（queueMicrotask 选型理由）：
  - 编程设 `el.scrollTop = X` → 浏览器在**当前宏任务完成后、微任务执行前**派发 scroll 事件（spec: scroll 事件在 task 队列，但实际浏览器实现中编程 scrollTop 的 scroll 事件在当前 event loop 的后续阶段）。
  - 用 `queueMicrotask` 清标记：微任务在 scroll 事件 handler 之后执行（如果 scroll 是同步派发）或在 scroll 事件之前（如果浏览器延迟派发）。
  - **关键风险**：不同浏览器 scroll 事件派发时机不同（Chrome 同步 / Firefox 异步）。如果 scroll 事件在 microtask **之前**派发（同步派发场景），microtask 清标记时 onScroll 已跑过（看到 true=跳过，正确）。如果 scroll 事件在 microtask **之后**派发（异步派发场景），microtask 先清标记 → onScroll 看到 false=正常更新 → 标记失效。
  - **兜底方案**：onScroll 内不依赖标记单一判定——结合 userInteractDeadlineRef 双重门控（程序 scroll 标记位是第一道门，用户操作窗口是第二道门）。即使标记位因浏览器时序偶发失效（异步派发 scroll 时标记已被 microtask 清），内容撑高的 scroll 事件也不会在用户操作窗口内（用户没操作 → deadline 过期）→ nearBottom 不更新 → 仍正确。**双保险**。
- **回归不变量保持**：
  1. 用户上翻不拉回（invariant ④）：用户 wheel → markUserInteract 设 deadline → onScroll 在窗口内正常更新 nearBottom=false → effect 门控不通过 → 不滚 ✅
  2. loadMore prepend 保持（invariant ③）：prepend restore 设 programmaticScrollRef=true → onScroll 跳过 nearBottom 更新 → prevHeight 恢复生效 ✅
  3. loadMore 跳过滚底（invariant ①②）：isLoadingMore/wasLoadingMoreRef 不变 ✅
  4. onScroll 始终挂载（invariant ⑤）：onScroll 仍挂 scroll div，loadMore 检查始终执行 ✅
  5. 气泡显隐（F9）：nearBottom 驱动，修复后不误显/误隐 ✅
- **风险点**：queueMicrotask 浏览器时序差异——双保险（标记位 + 用户操作窗口）兜底。ET 验证 UC-1（长内容贴底）确认真浏览器环境修复有效。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
