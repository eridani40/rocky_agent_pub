# v0.0.262 tech change log — 聊天滚动引导气泡 + 自动滚动跟丢修复

> 对应需求：`reqs/[working] v0.0.262.scroll-guide-bubble/req.md`（用户可感知的 UI 行为改动 → 走完整 PRD）。
> PRD：`specs/prd/version_logs/v0.0.262.scroll_guide_bubble/prd.md`。
> 权威契约：`specs/tech/version_logs/v0.0.262/change_plan.md`（method 级 8 列表，frozen）。

## 变更摘要

### 需求与动机

聊天对话 view 两个滚动相关问题：① 用户在底部时 LLM 流式生成（`text_block_delta` 高频更新同一条消息）不触发自动滚底——`use-message-scroll-pagination.ts` autoScroll effect 的 `autoScrollDeps: [rows.length, lastRunFinish, runActive]` 只在 rows.length 变化时触发，流式更新同一条消息 rows.length 不变 → 不滚底 → **生成跟丢**；② 用户不在底部（向上翻历史）时无任何「下方有新内容/未看完」的视觉提示 → **无引导**。

### 方案（3 口子裁决，详见 change_plan「架构决策记录」）

1. **nearBottom 暴露**：hook 返回签名扩展 `{ onScroll, nearBottom, scrollToBottom }`（新增字段向后兼容，唯一调用方 ComponentMessageStream + 既有测试解构 `{ onScroll }` 照常）。
2. **气泡 DOM 挂载**：ComponentMessageStream 内部——scroll 容器外包 relative wrapper，气泡 absolute 定位（scroll 容器内部不能挂：absolute 随内容滚动）；BaseChatPage 骨架零改动。
3. **autoScrollDeps 内容维度**：渲染视图 rows 派生内容签名 `${rows.length}:${textLenSum}`（tool-batch 无 text 跳过）+ hook 内 rAF 合并节流（cancel + requestAnimationFrame + cleanup cancel，每帧最多一次滚底）。

### T1 — hook 扩展 + rAF 合并（use-message-scroll-pagination.ts）

- **返回签名** `{ onScroll }` → `{ onScroll, nearBottom, scrollToBottom }`：
  - `nearBottom` = `useState(true)` React state：onScroll 内 `setNearBottom(scrollHeight - scrollTop - clientHeight <= 120)`（React setState 值去重：next===prev 不 re-render，防滚动事件风暴）。
  - `scrollToBottom(behavior: 'auto' | 'smooth' = 'auto')` = `scrollRef.current.scrollTo({ top: scrollHeight, behavior })` 编程滚底 + 同步 `nearBottomRef.current = true` + `setNearBottom(true)`（点击滚底后气泡即时消失；编程 scrollTo 不触发 scroll 事件，需显式同步）；useCallback（scrollRef 稳定依赖）。
- **autoScroll effect 改 rAF 合并**：`cancelAnimationFrame(rafRef.current)` + `rafRef.current = requestAnimationFrame(() => { scrollTop = scrollHeight; nearBottomRef.current = true; })`；effect cleanup `cancelAnimationFrame`。触发语义 = 「内容变化」：deps 由 caller 传内容签名，不再依赖 rows.length 单维度。
- **保留三不变量（顺序不变）**：isLoadingMore 跳过 + wasLoadingMoreRef 防滚回底 + nearBottomRef 门控；保留初始挂载即滚底（nearBottomRef 初始 true）。
- **NEAR_BOTTOM_THRESHOLD=120 常量不变**（leader 确认阈值基本正确，非主因）。

### T2 — 气泡组件 + ComponentMessageStream 装配 + i18n

- **`component-scroll-guide-bubble.tsx` NEW（ScrollGuideBubble）**：props `{ nearBottom, runActive, hasMessages, onScrollToBottom }`；`visible = !nearBottom && hasMessages`；`label = runActive ? t('scrollGuide.newMessage') : t('scrollGuide.backToBottom')`；aria-label 对应更完整可访问语义（`scrollGuide.ariaLabel.{newMessage,backToBottom}`）；渲染 `<button type="button" className="absolute left-1/2 -translate-x-1/2 bottom-3 z-20 ...">`：visible 控制 `opacity + pointer-events + translate-y`（transition ≤200ms fade+上移），**不 unmount**；样式基线 = surface 底 + border + 阴影 + 主色文字/图标（参照 tool-batch / run-state pill 胶囊基线）；点击调 `onScrollToBottom()`。
- **`component-message-stream.tsx`**：① 新增 `contentSignature` useMemo（基于已构建 rows：`${rows.length}:${textLenSum}`，textLenSum = user-text + agent-answer 行 text.length 之和，tool-batch 无 text 跳过）→ `autoScrollDeps: [contentSignature, lastRunFinish, runActive]`；② 解构 `nearBottom` / `scrollToBottom`；③ 渲染结构包 relative wrapper（`<div className="relative flex-1 min-h-0 flex flex-col">` 包住原 scroll div，scroll div className 原样保留），wrapper 内 scroll div 之后 absolute 挂 `<ScrollGuideBubble nearBottom={nearBottom} runActive={runActive} hasMessages={messages.length > 0} onScrollToBottom={() => scrollToBottom('smooth')} />`。
- **i18n**：`chat.json` 顶层新增 `scrollGuide` 对象（en + zh-CN 双语同步）：`newMessage`（"New message"/「新消息」）、`backToBottom`（"Back to bottom"/「回到底部」）、`ariaLabel.newMessage`（"View new messages"/「查看新消息」）、`ariaLabel.backToBottom`（"Back to bottom"/「回到底部」）。

### T2 code-review 修复 — build-render-rows 抽取

- **`build-render-rows.ts` NEW（79 行纯函数）**：`buildRenderRows(elements, elementBatch, batches): RenderRow[]` + `RenderRow` 类型导出（user-text / agent-answer / tool-batch 三 union）。动机：component-message-stream.tsx 装配气泡后 325 行 > 300 行硬上限（code-review Critical）→ 抽纯折叠逻辑独立模块，组件内一行调用。纯机械抽取零逻辑改动（grep 确认 RenderRow 无外部引用）；拆后 277 行 ≤300。
- **component-message-stream.tsx**：`const rows = buildRenderRows(elements, elementBatch, batches)` 一行调用；contentSignature useMemo 消费 rows（含 tool-batch 跳过逻辑——build-render-rows 产出的 tool-batch row 无 text 字段，签名计算跳过）。

## 设计决策

- **nearBottom 暴露为 React state（值去重 setState）而非 useSyncExternalStore 订阅**：滚动事件频率有限，setState 值去重已足够；订阅是过度设计。否决回调 prop（nearBottom 上提给父组件 → 数据流跨两层，破坏封装）。
- **气泡挂 ComponentMessageStream 内部 + relative wrapper，非 BaseChatPage / SectionChatSession 层**：nearBottom + runActive + scrollToBottom 全在 ComponentMessageStream 层消费（hook 就在这层调），数据流最短；BaseChatPage 是 3 页共享骨架（slot 注入纯展示），加气泡 prop 会污染骨架 + 需要把 nearBottom/scrollToBottom 上提跨两层。scroll 容器内部不能挂（absolute 随内容滚动）→ 包 relative wrapper 提供定位上下文。
- **内容签名 `${rows.length}:${textLenSum}` 而非 messages 引用 / JSON.stringify**：传 messages 引用 = 依赖 React 引用比较的隐式行为（useMessages 每 delta 帧替换数组 → 每帧触发，含被 messageFilter 过滤的无关变化）；内容签名显式表达「渲染内容变了」，过滤精确（群聊 messageFilter 场景），且可测（纯函数）。JSON.stringify 全量序列化 O(n) 每帧太贵。否决「N ms 节流」定时器（漏滚风险，rAF 与渲染帧对齐更自然）。
- **rAF 合并节流（cancel + requestAnimationFrame + cleanup cancel）**：同帧多次 effect 触发合并为一次滚底，产品语义 = 视觉跟得上即可，不做逐帧强制（防滚动抖动与 CPU 浪费，PRD §7 性能护栏）。
- **气泡 visible 用 opacity/pointer-events 过渡不 unmount**：unmount 会断动画（fade-out 直接消失）；保 DOM + opacity-0/pointer-events-none 保动画平滑（PRD §2.4 过渡 ≤200ms 不突兀）。
- **ariaLabel 用独立嵌套键（偏离 change_plan 单个键）**：aria-label 比可见文案更完整（「查看新消息」/「回到底部」语义），嵌套 `ariaLabel.newMessage` / `ariaLabel.backToBottom` 与文案键分开维护。语义等价，code-review 记录为 Minor（不修）。

## 代码↔spec 核实（doc-modifier 阶段 5）

| 项 | 核验 | 状态 |
|---|---|---|
| hook 返回签名 `{ onScroll, nearBottom, scrollToBottom }` | use-message-scroll-pagination.ts:56-62 | ✓ |
| nearBottom 初始 true + onScroll 值去重 setState | :73（useState(true)）+ :141（next===prev 不 re-render） | ✓ |
| NEAR_BOTTOM_THRESHOLD=120 不变 | :31（export const = 120） | ✓ |
| scrollToBottom useCallback + el.scrollTo + 同步 nearBottom | :151-157 | ✓ |
| autoScroll rAF 合并（cancel + rAF + cleanup cancel） | :101-123 | ✓ |
| 三不变量保留（isLoadingMore / wasLoadingMoreRef / nearBottomRef 顺序） | :102-106 | ✓ |
| contentSignature `${rows.length}:${textLenSum}` tool-batch 跳过 | component-message-stream.tsx:154-161（`row.type !== 'tool-batch'`） | ✓ |
| autoScrollDeps 含内容签名 | :165（`[contentSignature, lastRunFinish, runActive]`） | ✓ |
| relative wrapper 包 scroll div（className 原样）+ absolute 挂气泡 | :173-177 + :266-271 | ✓ |
| 气泡 visible = !nearBottom && hasMessages | component-scroll-guide-bubble.tsx:41 | ✓ |
| 气泡文案 = runActive 二元 | :42 | ✓ |
| 气泡不 unmount（opacity-0 + pointer-events-none） | :57-60 | ✓ |
| button 语义 + aria-label | :47-50（`<button type="button" aria-label={ariaLabel}>`） | ✓ |
| i18n scrollGuide 键 en + zh-CN 双语同步 | en/chat.json:334 + zh-CN/chat.json:334（newMessage/backToBottom/ariaLabel 嵌套） | ✓ |
| build-render-rows 纯函数抽取零逻辑改动 | build-render-rows.ts（79 行）+ message-stream 一行调用 | ✓ |
| hook 头注释 invariants ① 同步「消息内容变化触发」 | use-message-scroll-pagination.ts:11-13 | ✓ |

**偏离记录**：
- ariaLabel 嵌套键（change_plan 行 4 原计划单个 `ariaLabel` 键「View new messages / Back to bottom」）→ 实际拆 `ariaLabel.newMessage` / `ariaLabel.backToBottom` 两键（组件按 runActive 取对应键）。语义等价，code-review 记录 Minor 不修。
- 无其他静默偏离；spec（_overview §4.5 / 组件 spec / app-guide）已按实际实现同步。

## 文档同步（doc-modifier 阶段 5 已完成）

- `specs/ui/components/chat-page/_overview.md`：§3 组件清单加 `component-scroll-guide-bubble` 行；**新建 §4.5 滚动 hook 权威章节**（滚动 hook 签名 / 内容签名 autoScroll / rAF 合并 / 5 条 invariants / 引导气泡），对齐代码注释既有引用。
- `specs/ui/components/chat-page/component-scroll-guide-bubble.md`：新组件 spec（职责 / Props / 状态交互 / 复用关系 / 视觉基线）。
- `specs/ui/overall/00-app-guide.md`：§3.1 Playground 补「聊天滚动引导气泡」操作语义（翻历史 → 气泡 → 点击回底）。
- frontend KB `log.md`：加 v0.0.262 条目；`index.md` ① 加「滚动引导气泡 + 内容签名 autoScroll」概念行。
