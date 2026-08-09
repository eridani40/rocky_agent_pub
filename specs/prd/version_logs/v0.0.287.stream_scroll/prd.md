# v0.0.287 PRD — 流式生成自动滚动 sticky-bottom 间歇失效修复

- **版本号**: v0.0.287
- **版本主题**: 流式生成时 sticky-bottom 门控间歇失效（nearBottom 误判）根治
- **需求文件**: `reqs/[working] v0.0.287/req.md`（老板最终拍板：四状态决策模型）
- **工作目录**: `worktrees/0.0.287-stream-scroll`
- **类型**: 纯前端 bug 修复（用户可感知行为变化——间歇性跟丢）→ 完整 PRD（含四状态决策模型产品化）

---

## 1. 背景

### 1.1 现象（老板报，间歇性）

流式生成时自动滚动跟不上生成速度：用户停在最底部，生成很长内容后被「甩」到中间——auto-scroll 失效不再贴底。**间歇性**，与生成速度/一次性长度相关：慢速流式（<120px/帧）能追平；一次性大段（>120px/帧）追不上。

### 1.2 根因（PRD 核实确认）

`use-message-scroll-pagination.ts` 自动滚底竞态漏洞：

1. **autoScroll effect（L101-123）**：内容签名变化时 rAF 滚底 `el.scrollTop = el.scrollHeight`（L110）。
2. **注释 L111 错误**：「编程设 scrollTop 不触发 scroll 事件」——**实际会异步触发 scroll 事件**。
3. **onScroll（L133-146）不区分程序/用户滚动**：所有 scroll 事件一视同仁更新 `nearBottomRef` = `scrollHeight - scrollTop - clientHeight <= 120`。
4. **竞态时序**：
   - rAF 回调设 `scrollTop = scrollHeight`（滚到底）
   - 浏览器异步触发 scroll 事件，**但此时下一批 delta 已撑高 scrollHeight**（内容增长），而 scrollTop 还是 rAF 设的旧值（= 旧 scrollHeight，已 < 新 scrollHeight）
   - onScroll 算 `newScrollHeight - oldScrollTop - clientHeight > 120` → **nearBottomRef 误判 false**
   - autoScroll effect 门控 `nearBottomRef.current` 读到 false → **不滚**
   - 一旦某帧误判 → nearBottomRef 卡 false → 永久停止滚底（直到用户交互或点击气泡）
5. **间歇性机理**：仅当单帧内容撑高 >120px（一次性长段/快速流式）时触发；慢速（<120px/帧）即使 scroll 事件间隙也 ≤120px 不误判。

### 1.3 老板拍板：四状态决策模型（最终版，2026-08-08）

**核心策略**：**只有「用户交互」才解除吸底**；「新内容生成 / 程序滚底」不构成「离开」。

**四状态**（决定是否把当前位置追赶到最新底部）：
1. ① 上一轮位置在不在底部
2. ② 这一轮位置在不在底部
3. ③ 中间有没有新内容生成
4. ④ 中间有没有用户操作

**本质公式**：`追赶 = 上一轮在底部 AND 中间无用户操作`
- 用户操作 = 唯一「解除吸底」因素
- 新内容生成 / 程序滚底 ≠ 用户操作 → 不构成「离开」

---

## 2. 核心决策

### D1. 四状态决策表（老板最终拍板 2026-08-08，PRD 产品化）

**四状态**（决定是否把当前位置追赶到最新底部）：

| 状态①：上一轮在底部 | 状态②：这一轮在底部 | 状态③：中间新内容 | 状态④：中间用户操作 | 决策 | 说明 |
|---|---|---|---|---|---|
| ✅ | —（无论） | — | ❌ 无 | **追赶** | 原本在底部 + 无用户交互 → 无论现在在哪都追（核心修复） |
| ✅ | ❌ 不在 | — | ✅ 有 | **停留** | 用户主动离开 → 尊重，不拉回 |
| ❌ 不在 | — | — | — | **不追** | 旧位置不在底部 → 无需追赶 |

**本质公式**：`追赶 = 上一轮在底部 AND 中间无用户操作`

**关键洞察**：当前 bug = 状态③（新内容生成撑高）触发的 scroll 事件被 onScroll 算成「这一轮不在底部」→ 误判为用户离开。四状态模型拆开「上一轮/这一轮位置」——只要上一轮在底部且无用户操作，无论这一轮因内容撑高瞬态在哪，都追赶。

### D2. 区分程序滚动 vs 用户滚动（根治竞态）

**什么算用户操作（状态④）**：
- `wheel`（鼠标滚轮）
- `touchmove`（触摸滑动）
- 键盘滚动（PageDown/PageUp/方向键 → `keydown`）
- 拖拽滚动条（mousedown 在 scrollbar + mousemove）

**什么不算用户交互（不更新 nearBottom）**：
- 编程设 `scrollTop` / `scrollTo`（autoScroll effect / scrollToBottom / prepend restore）
- 内容撑高导致的 scrollHeight 增长（新消息到达 / 流式 delta）
- loadMore prepend 导致的位置变化

**实现方向（给架构参考，PRD 定行为）**：
- **方向 A（程序滚动标记位）**：编程滚底前设 `programmaticScrollRef = true`，scroll 事件里检测到则跳过 nearBottom 更新 + 异步重置（rAF/microtask 后清标记）；用户交互事件（wheel/touchmove/keydown）设 `userInteractedRef = true`。
- **方向 B（ResizeObserver 内容驱动）**：监听内容容器高度变化 → 用户在底部时持续贴底（不依赖 scroll 事件）。
- **架构裁决**实现方式；PRD 定义行为语义：程序/内容 scroll 不解除吸底，用户交互才解除。

### D3. 状态④ 用户操作的时效窗口

- 用户交互（wheel/touchmove/keydown）标记 `userInteractedRef = true`，在交互后**短窗口内（如 500ms）**允许 nearBottom 自由更新（用户可能在连续滚动）。
- 窗口外或用户回到底部 → 重置 `userInteractedRef`，恢复空间判定模式。
- **目的**：避免用户一次 wheel 后程序滚底立即覆盖用户位置（尊重用户上翻意图），但用户回到底部后恢复自动跟随。

### D4. 回到底部恢复吸底

- 用户上翻离开底部后（nearBottom=false，sticky 解除），用户主动滚回底部（或点击引导气泡 scrollToBottom）→ nearBottom 恢复 true → 吸底恢复。
- **scrollToBottom（气泡点击）** 已同步 `nearBottomRef = true`（现状保留）+ 需同时重置 `userInteractedRef`（恢复自动跟随模式）。

---

## 3. 功能需求

### 3.1 四状态决策模型实现（核心修复）

| # | 需求 | 说明 |
|---|------|------|
| F1 | 区分程序滚动 vs 用户滚动 | 程序/内容撑高触发的 scroll 事件不更新 nearBottom |
| F2 | 用户交互事件识别 | wheel / touchmove / 键盘 / 拖拽滚动条 = 用户交互 |
| F3 | 四状态决策表落地 | 状态①上一轮在底部 + 状态④无用户操作 → 追赶（D1 表） |
| F4 | 流式生成贴底始终追平 | 单帧内容撑高 >120px 也不误判（上一轮在底部 + 无用户操作 → 追赶） |

### 3.2 不破坏（回归不变量）

| # | 需求 | 说明 |
|---|------|------|
| F5 | 用户主动上翻不强制拉回 | 状态④用户操作 → 上一轮在底部但有用户操作 → 停留不追（invariant ④ 保留） |
| F6 | loadMore prepend 位置保持 | invariant ③ 保留（prevHeight 恢复） |
| F7 | loadMore 期间跳过滚底 | invariant ①② 保留（isLoadingMore + wasLoadingMoreRef） |
| F8 | onScroll 始终挂载 | invariant ⑤ 保留（near-bottom 追踪 + loadMore 触发） |
| F9 | 引导气泡显隐正确 | nearBottom 驱动气泡（!nearBottom && hasMessages），修复后不误显/误隐 |
| F10 | 气泡点击滚底恢复吸底 | scrollToBottom 同步 nearBottom=true + 重置用户交互状态 |

### 3.3 状态暴露（兼容现有消费方）

| # | 需求 | 说明 |
|---|------|------|
| F11 | hook 返回签名不变 | `{ onScroll, nearBottom, scrollToBottom }` 保持（v0.0.262 扩展向后兼容） |
| F12 | autoScrollDeps 不变 | caller 仍传 `[contentSignature, lastRunFinish, runActive]`（内容签名语义不变） |

---

## 4. 关键用户路径

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 用户在底部 → LLM 流式生成长内容（快速/一次性大段 >120px/帧）→ 持续生成 | **始终贴底跟随**（不被甩到中间——核心修复验证） |
| UC-2 | 用户在底部 → LLM 慢速生成（<120px/帧）| 贴底跟随（现状行为不变） |
| UC-3 | 用户在底部 → 用户鼠标滚轮上翻 → LLM 继续生成 | **不拉回**（尊重用户上翻），引导气泡显示「新消息」 |
| UC-4 | 用户上翻后（不在底部）→ 用户滚回底部（或点击气泡「回到底部」）| 恢复吸底，后续生成继续贴底跟随 |
| UC-5 | 用户在底部 → LLM 生成结束 → 消息流静止 | 停在底部（nearBottom=true，气泡不显示） |
| UC-6 | 用户上翻 → 点击气泡「回到底部」→ LLM 新一轮生成 | 平滑滚底 → 恢复吸底 → 新内容贴底跟随 |
| UC-7 | loadMore 前插（滚到顶触发加载更多）| prepend 位置保持（原顶部条目不动），不被滚底拉走 |

---

## 5. 概念对齐（specs/ui + specs/tech）

| 概念 | 位置 | 关系 |
|------|------|------|
| useMessageScrollPagination | `_overview.md §4.5`（滚动 hook 权威章节） | 本版本修复核心：onScroll 区分程序/用户 + 四状态决策 |
| sticky-bottom 门控 | `_overview.md §4.5` invariant ④（v0.0.129） | 本版本强化：门控源从「空间判定」升级为「四状态综合判定（上一轮位置 + 用户操作）」 |
| autoScroll 内容签名 | `_overview.md §4.5`（v0.0.262 内容变化触发） | 不变（contentSignature 语义保留）；修复在 onScroll 层 |
| rAF 合并 | hook L99-114（v0.0.262） | 保留（每帧最多一次滚底）；修复在 scroll 事件区分层 |
| 引导气泡 | `component-scroll-guide-bubble.md`（v0.0.262） | nearBottom 驱动显隐——修复后不误显/误隐 |
| 5 个 invariants | hook L10-21 | 全部保留（F5-F8 回归不变量） |

**新增概念**：
- 四状态综合决策模型（状态①上一轮位置/②这一轮位置/③中间新内容/④中间用户操作）
- 用户交互识别（wheel/touchmove/keydown/拖拽 → userInteractedRef）
- 程序滚动标记（programmaticScrollRef，区分编程设 scrollTop 的 scroll 事件）

---

## 6. 边界 / 不做

- ❌ 不改 autoScroll 触发语义（内容签名 contentSignature 不变——v0.0.262 修复保留）
- ❌ 不改 rAF 合并机制（每帧最多一次滚底保留）
- ❌ 不改 NEAR_BOTTOM_THRESHOLD=120（阈值保留）
- ❌ 不改引导气泡组件（nearBottom 消费方，显隐逻辑不变）
- ❌ 不改 hook 返回签名（向后兼容）
- ❌ 不做平滑自动滚动（autoScroll 保持即时 scrollTop=scrollHeight，避免流式高频抖动）
- ❌ 不做「用户上翻后自动回到底部」（尊重用户意图，仅引导气泡提示）

---

## 7. 验收口径

### 能力不变量（核心修复）
- [ ] 流式生成（快速/一次性大段 >120px/帧）始终贴底跟随（UC-1，根治间歇失效）
- [ ] 程序滚底/内容撑高触发的 scroll 事件不误判 nearBottom=false
- [ ] 用户交互（wheel/touchmove/keydown）才解除吸底

### 回归不变量
- [ ] 用户上翻不拉回（invariant ④，F5）
- [ ] loadMore prepend 位置保持（invariant ③，F6）
- [ ] loadMore 期间跳过滚底（invariant ①②，F7）
- [ ] onScroll 始终挂载（invariant ⑤，F8）
- [ ] 引导气泡显隐正确（F9）
- [ ] 气泡点击恢复吸底（F10）
- [ ] hook 返回签名不变（F11）
- [ ] autoScrollDeps 不变（F12）

---

## 8. 测试建议

- **UT（主要）**：
  - 四状态决策模型：mock 程序滚动 scroll 事件 → nearBottom 不更新；mock 用户操作（wheel）→ nearBottom 更新；上一轮在底部 + 无用户操作 → 追赶
  - 竞态时序模拟：rAF 设 scrollTop 后模拟内容撑高 + scroll 事件 → nearBottom 保持 true（核心 bug 修复断言）
  - 用户交互窗口：wheel 后短窗口内 nearBottom 可更新；窗口外恢复
  - 回归：loadMore prepend 保持 / sticky 门控 / 气泡显隐 / scrollToBottom 恢复吸底
  - fake scrollRef helper 需扩展（scroll 事件触发模拟 + programmaticScroll 标记断言）
- **ET（老板要求）**：流式生成滚动场景（UC-1 长内容贴底 + UC-3 用户上翻不拉回 + UC-4 回到底部恢复吸底）

---

## 9. 版本总结

- **修复**：sticky-bottom 门控间歇失效——根因 = 编程设 scrollTop 异步触发 scroll 事件 + onScroll 不区分程序/用户滚动 → nearBottom 误判 false → 门控失效不滚
- **方案**：四状态综合决策模型（状态①上一轮位置/②这一轮位置/③中间新内容/④中间用户操作）——程序/内容触发的 scroll ≠ 用户操作，不解除吸底
- **实现方向（架构裁决）**：程序滚动标记位（programmaticScrollRef）+ 用户交互识别（wheel/touchmove/keydown → userInteractedRef），或 ResizeObserver 内容驱动贴底
- **零改动**：autoScroll 触发语义（contentSignature）/ rAF 合并 / NEAR_BOTTOM_THRESHOLD / 引导气泡组件 / hook 返回签名 / 5 个 invariants
- **UT 为主**（四状态 + 竞态时序 + 回归）+ **ET**（流式滚动 UC-1/3/4）
