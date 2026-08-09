# v0.0.262 变更计划书 — 聊天滚动引导气泡 + 自动滚动跟丢修复

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/version_logs/v0.0.262.scroll_guide_bubble/prd.md`。版本上下文：`states/v0.0.262/context.md`。
> **架构期 3 口子裁决**（详见「架构决策记录」）：① nearBottom 暴露 = hook 返回签名扩展 `{onScroll, nearBottom, scrollToBottom}`（新增字段向后兼容）；② 气泡 DOM 挂载 = ComponentMessageStream 内部（scroll 容器外包 relative wrapper，气泡 absolute 定位，BaseChatPage 骨架零改动）；③ autoScrollDeps 内容维度 = 渲染视图内容签名（rows 派生，`${rows.length}:${textLenSum}`）+ hook 内 rAF 合并节流。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（ui-chat） |
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
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | useMessageScrollPagination() | 修改 | 返回签名 `{ onScroll }` → `{ onScroll, nearBottom, scrollToBottom }`。`nearBottom` = `useState(true)` React state：onScroll 内 `setNearBottom(scrollHeight - scrollTop - clientHeight <= 120)`（React setState 值去重，next===prev 不 re-render，防滚动事件风暴）；`scrollToBottom(behavior: 'auto' \| 'smooth' = 'auto')` = `scrollRef.current.scrollTo({ top: scrollHeight, behavior })` 编程滚底 + 同步 `nearBottomRef.current = true` + `setNearBottom(true)`（点击滚底后气泡即时消失） | MUST NOT 破坏现有调用方（仅新增返回字段，onScroll 语义/签名不变，既有解构 `{ onScroll }` 照常）；MUST nearBottom 初始 true（新会话首条消息到达即滚底语义保持）；MUST NEAR_BOTTOM_THRESHOLD=120 常量不变；scrollToBottom 为 useCallback（scrollRef 稳定依赖） | PRD §3.3（nearBottom 判定）/§2.2（气泡显示条件）；_overview §4.5（sticky-bottom 门控，doc-modifier 待补内容变化+气泡） | +18/-2 |
| ui-chat | app/web/src/components/chat-page/use-message-scroll-pagination.ts | autoScroll effect（useEffect 内滚底逻辑） | 修改 | effect 内滚底改 **rAF 合并**：`cancelAnimationFrame(rafRef.current)` + `rafRef.current = requestAnimationFrame(() => { scrollTop = scrollHeight; nearBottomRef.current = true; })`，effect cleanup `cancelAnimationFrame`。触发语义 = 「内容变化」：deps 由 caller 传入内容签名（行 3），不再依赖 rows.length 单维度 | MUST 每帧最多一次滚底（rAF 合并，防流式 delta 逐帧抖动）；MUST cleanup cancel 未执行 rAF（组件卸载/依赖再变时不留悬空回调）；MUST 保留 isLoadingMore 跳过 + wasLoadingMoreRef 防滚回底 + nearBottomRef 门控三不变量（顺序不变）；MUST 保留初始挂载即滚底（nearBottomRef 初始 true） | PRD §3.2（跟丢修复）/§7（性能护栏：视觉跟得上即可，不做逐帧强制）；hook invariants ① 注释同步改「消息内容变化触发」 | +9/-3 |
| ui-chat | app/web/src/components/chat-page/component-message-stream.tsx | ComponentMessageStream() | 修改 | ① 新增 `contentSignature`（useMemo 基于已构建 rows：`${rows.length}:${textLenSum}`，textLenSum = user-text + agent-answer 行 text.length 之和，tool-batch 无 text 跳过）→ `autoScrollDeps: [contentSignature, lastRunFinish, runActive]`（contentSignature 含行数维度，替代旧 rows.length，等价覆盖新消息到达 + 新增内容增长）② 解构 `nearBottom` / `scrollToBottom` ③ 渲染结构包 relative wrapper：最外层 `<div className="relative flex-1 min-h-0 flex flex-col">` 包住原 scroll div（保持 `flex-1 overflow-y-auto ...` 不动），wrapper 内 scroll div 之后 absolute 挂 `<ScrollGuideBubble nearBottom={nearBottom} runActive={runActive} hasMessages={messages.length > 0} onScrollToBottom={() => scrollToBottom('smooth')} />` | MUST 布局不位移：新 wrapper 不改变 scroll 容器尺寸/滚动语义（scroll div className 原样保留），气泡 absolute 脱离文档流；MUST contentSignature 为纯计算（useMemo 依赖 rows）；MUST autoScrollDeps 含内容签名（跟丢修复核心）；MUST 不新增 props（nearBottom/scrollToBottom 内部 hook 消费） | PRD §3.2/§2.3（气泡浮动不占位）；行 1/2 hook 签名；_overview §4.5（待补） | +28/-6 |
| ui-chat | app/web/src/components/chat-page/component-scroll-guide-bubble.tsx（新） | ScrollGuideBubble() | 新增 | 引导气泡组件：props `{ nearBottom: boolean; runActive: boolean; hasMessages: boolean; onScrollToBottom: () => void }`。`visible = !nearBottom && hasMessages`（PRD §2.2 显示条件）；`label = runActive ? t('scrollGuide.newMessage') : t('scrollGuide.backToBottom')`；`aria-label` 对应 i18n（「查看新消息」/「回到底部」）。渲染 `<button type="button" className="absolute left-1/2 -translate-x-1/2 bottom-3 z-*" ...>`：visible 控制 `opacity + pointer-events + translate-y`（transition ≤200ms fade+上移），**不 unmount**（保动画平滑）；样式基线 = surface 底 + border + 阴影 + 主色文字/图标（参照 tool-batch / run-state pill 胶囊基线）；点击调 `onScrollToBottom()` | MUST absolute 定位不占文档流（出现/消失不得致任何元素位移——PRD 布局稳定性 MANDATORY）；MUST button 语义 + aria-label（可访问）；MUST visible 用 opacity/pointer-events 过渡（不 unmount，防动画断裂）；MUST 文案 = runActive 二元（不引「是否有新内容」新判定字段，PRD §6 边界） | PRD §2.3（位置）/§2.4（文案交互）/§3.1（气泡）；i18n 行 5；_conventions.md §9（视觉基线） | +85 |
| ui-chat | app/web/src/i18n/locales/en/chat.json + app/web/src/i18n/locales/zh-CN/chat.json | scrollGuide.* | 新增 | 顶层新增 `scrollGuide` 对象：`newMessage`（en "New message" / zh "新消息"）、`backToBottom`（en "Back to bottom" / zh "回到底部"）、`ariaLabel`（en "View new messages / Back to bottom" / zh "查看新消息 / 回到底部"） | MUST en + zh-CN 双语同步（缺一 = 渲染 fallback 键名）；MUST 不覆盖既有键（纯新增） | PRD §3.1.6（i18n）；行 4 消费 | +6×2 |
| ui-chat | app/web/src/components/chat-page/__tests__/use-message-scroll-pagination.test.tsx（修改）+ __tests__/scroll-ref-helper.ts（修改） | hook 单测补充 | 修改 | ① 内容变化（同 rows.length 下消息内容增长 = autoScrollDeps 签名变）且 nearBottom=true → 滚底（跟丢修复核心断言）② 内容变化但 nearBottom=false → 不滚 ③ nearBottom 暴露：onScroll 后 `result.current.nearBottom` 更新（距底≤120 → true / >120 → false）④ scrollToBottom 调用：scrollTop 置底 + nearBottom 变 true。helper 补 `scrollTo` stub（`captureWrites` 记录 top + 更新 backing，防 fake 无 scrollTo 抛 TypeError） | MUST 既有 sticky-bottom + pagination 两测试文件全绿（返回签名扩展向后兼容——解构 `{ onScroll }` 仍成立）；MUST rAF stub（vi.useFakeTimers / rAF mock，防真 rAF 异步断言不稳） | PRD §UT 范围（① 内容变化滚底 ② 门控）；行 1/2 | +65/-2 |
| ui-chat | app/web/src/components/chat-page/__tests__/component-scroll-guide-bubble.test.tsx（新） | 气泡单测 | 新增 | 纯渲染测试（jsdom + @testing-library/react）：① nearBottom=false + runActive=true → 文案「新消息」② nearBottom=false + runActive=false → 文案「回到底部」③ nearBottom=true → 不可见（opacity-0 / pointer-events-none 类）④ 点击 → `onScrollToBottom` 调用 ⑤ aria-label 存在 | MUST 不测视觉（无设计稿，视觉走既有 design system，vision_check 跳过）；MUST i18n mock 或真实 t（两文案断言可区分） | PRD §UT 范围（气泡显隐/文案/点击）；行 4/5 | +70 |

## 影响面评估

- **跨模块**：单模块 ui-chat（chat-page 目录内 3 个源文件 + 2 个测试文件 + i18n 2 个），无后端/API/协议改动，纯前端。
- **破坏性变更**：无。hook 返回签名扩展（新增字段），既有调用方（仅 ComponentMessageStream）与既有测试均向后兼容。
- **依赖顺序**：T1（hook 扩展 + hook 单测）→ T2（气泡组件 + ComponentMessageStream 装配 + i18n + 气泡单测）。T2 依赖 T1 的 hook 返回签名（nearBottom/scrollToBottom），串行。
- **风险点**：
  1. rAF 合并引入异步滚底——单测需 fake rAF；若 rAF 不触发（headless 环境）→ 单测需显式 flush。
  2. scrollToBottom 用 `el.scrollTo`——scroll-ref-helper fake 需补 stub（测试）；真实浏览器 Element.scrollTo 全支持。
  3. 平滑滚动动画期间 nearBottom 可能瞬态 false（气泡闪烁）——点击时 scrollToBottom 已同步 setNearBottom(true)，动画中 onScroll 若算 false 会短暂显示；缓解 = 气泡点击后本地 pending 隐藏 300ms（编码期可选优化，非 v1 必做，PRD 未列）。
  4. contentSignature 基于 rows 每帧重算 O(rows)——rows 数级（几十~几百），可接受；若 perf 敏感可降级为 messages 引用（编码期评估，需报偏离）。
- **doc-modifier 阶段 5 待同步**：`_overview.md` §4.5 补「v0.0.262：触发条件从 rows.length 扩展为内容签名 + rAF 合并 + 引导气泡（nearBottom 暴露 / scrollToBottom）」；`00-app-guide.md` 补「聊天滚动引导气泡」操作语义（翻历史 → 气泡 → 点击回底）；hook 头注释 invariants ① 同步（内容变化触发）。

## 架构决策记录（3 口子裁决，PRD 留白）

### 口子 1：nearBottom 状态暴露 API
- **裁决**：hook 返回签名扩展 `{ onScroll, nearBottom, scrollToBottom }`，不引入订阅/回调。
- **理由**：nearBottom 是「当前用户位置」快照，hook 内部已在 onScroll 实时维护 ref；暴露为 React state（值去重 setState）让气泡直接消费，零额外订阅。scrollToBottom 一并暴露（气泡点击滚底能力）——hook 是滚动副作用唯一 owner，滚底能力归它。
- **否决**：useSyncExternalStore 订阅（滚动事件频率有限 + setState 值去重已足够，过度设计）；回调 prop（nearBottom 上提给父组件 → 数据流跨两层，破坏封装）。

### 口子 2：气泡 DOM 挂载归属
- **裁决**：ComponentMessageStream 内部（scroll 容器外包 relative wrapper，气泡 absolute 定位）。
- **理由**：nearBottom + runActive + scrollToBottom 全部在 ComponentMessageStream 层消费（hook 就在这层调），数据流最短；BaseChatPage 是 3 页共享骨架（slot 注入纯展示），加气泡 prop 会污染骨架 + 需要把 nearBottom/scrollToBottom 上提到 SectionChatSession 再回传（跨两层）。scroll 容器**内部**不能挂（absolute 随内容滚动）→ 包 relative wrapper 提供定位上下文。
- **否决**：BaseChatPage messages wrapper 挂载（数据流跨两层 + 骨架改动）；SectionChatSession 层 wrap（同前，数据上提问题）。

### 口子 3：autoScrollDeps 内容维度传什么 + 高频节流
- **裁决**：内容签名（渲染视图 rows 派生，`${rows.length}:${textLenSum}`）入 autoScrollDeps；节流 = hook 内 rAF 合并。
- **理由**：传 messages 引用 = 依赖 React 引用比较的隐式行为（useMessages 每 delta 帧替换数组 → 每帧触发，含被 messageFilter 过滤的无关变化）；内容签名显式表达「渲染内容变了」，过滤精确（群聊 messageFilter 场景），且可测（纯函数）。节流放 hook 内 rAF 合并——同帧多次 effect 触发合并为一次滚底，产品语义 = 视觉跟得上即可。
- **否决**：JSON.stringify 全量序列化（O(n) 每帧太贵）；messages 引用直传（引用语义隐式 + 过滤不精确）；「N ms 节流」定时器（漏滚风险，rAF 与渲染帧对齐更自然）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
