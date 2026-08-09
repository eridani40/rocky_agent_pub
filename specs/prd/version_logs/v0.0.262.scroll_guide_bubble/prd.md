# v0.0.262 PRD — 聊天滚动引导气泡 + 自动滚动跟丢修复

> 版本：v0.0.262 · 主题：聊天对话 view 不在最底部时，输入框上方显示引导气泡（生成中「新消息」/ 空闲「回到底部」，点击滚到底）；修复生成过程中自动滚动跟丢（流式内容更新未触发滚底）。
> PRD 边界（用户裁决 2026-07-14）：本文只覆盖**用户可感知**的产品逻辑/体验/反馈；滚动触发机制、气泡 DOM 挂载、nearBottom 状态暴露、性能策略归 architect 落 `specs/tech/version_logs/v0.0.262/change_plan.md`；组件 spec 由编码期补/改 `specs/ui/components/`。PRD 不发明技术细节，只描述产品语义到可落地。
> 需求来源：`reqs/[working] v0.0.262.scroll-guide-bubble/req.md`（3 点）+ `states/v0.0.262/context.md`（已确认决策 + 根因定位）

---

## 1. 背景 + 目标

### 1.1 背景（现状）

聊天对话 view 存在两个滚动相关问题，且二者相互纠缠：

| 现状 | 问题 |
|------|------|
| 用户在底部时，LLM 流式生成内容（`text_block_delta` 高频更新同一条消息）不触发自动滚底 | **生成跟丢**：用户明明在底部，但生成太快可视区没跟上，看到的是旧内容位置（`use-message-scroll-pagination.ts` autoScroll effect 的 `autoScrollDeps: [rows.length, lastRunFinish, runActive]` 只在 rows.length 变化时触发；流式更新同一条消息 rows.length 不变 → 不滚底） |
| 用户不在底部（向上翻历史）时，没有任何「下方有新内容/未到底」的视觉提示 | **无引导**：用户翻看历史时不知道下方有新消息在产生或未看完，只能盲猜 |
| 现有 sticky-bottom 门控（`nearBottomRef` + `NEAR_BOTTOM_THRESHOLD=120px`）逻辑基本正确 | 触发频率不足是跟丢根因；阈值本身不是主因（保留 120px，配合修复后的触发频率即可） |

### 1.2 目标

1. **引导气泡（新功能）**：用户不在底部时，输入框上方显示气泡——生成中显示「新消息」，空闲显示「回到底部」；点击气泡平滑滚到底部。
2. **修复自动滚动跟丢**：用户在底部时，流式生成内容更新也要触发滚底，不被甩开。
3. **平衡**：在底部 → 自动跟进；不在底部 → 不自动滚动、显示引导气泡。两者由同一 sticky-bottom 门控统一裁决。

## 2. 范围与代决（orchestrator 代 AFK 用户拍板）

### 2.1 「新消息产生中」判定 = runActive（复用 useMessages 既有字段）

- 气泡文案「新消息」的判定 = `runActive === true`（useMessages ctx 字段，agent_loop 派生——run_start → true，run_end → false）。
- 覆盖整个 run 生命周期（含 thinking / tool 执行阶段）：只要 run 在进行中，用户不在底部时提示「新消息」都合理（下方消息在产生/即将产生）。
- 不新建「是否有新 content」的额外判定字段（runActive 足够，避免双源不一致）。

### 2.2 气泡显示条件 = 用户不在底部 && 会话非空

- **显示**：`nearBottom === false`（用户距底部 > 120px）&& 会话有消息（非空态）。
- **隐藏**：用户在底部（含点击气泡滚到底后）；空会话（无消息且无 run——走既有空态分支，不显示气泡）。
- 气泡与「是否在生成」无关的显示/隐藏（runActive 只决定文案，不决定显隐）。

### 2.3 气泡位置 = 消息流可视区底部（输入框上方），浮动不占位

- 视觉位置：**贴消息流可视区底部边缘、输入框正上方**，水平居中于消息区（对齐现有 820px 内容列中心）。
- **浮动**：绝对定位脱离文档流，不推动消息流/输入框/排队区布局（布局稳定性 MANDATORY——出现/消失不得致任何元素位移）。
- 与既有输入框上方元素（enqueue 排队区 / HITL 卡 / 停止钮）**不重叠**：气泡在消息区 wrapper 底部，排队区/HITL 卡在输入 bar 内部，两层垂直相邻不冲突（实现层保证 z-order 与间距）。

### 2.4 气泡文案与交互

| 状态 | 气泡文案 | 点击行为 |
|---|---|---|
| runActive（生成中） | 「新消息」 | 平滑滚动到底部 |
| 非 runActive（空闲/已结束） | 「回到底部」 | 平滑滚动到底部 |

- 点击后：平滑滚到底 → 用户回到底部 → 气泡消失（nearBottom 更新）。
- 气泡出现/消失有过渡（fade + 轻微上移，不突兀）。
- 可访问：button 语义 + aria-label（i18n）。

### 2.5 自动滚动修复 = 触发频率补「消息内容维度」

- **修复方向（leader 已定位根因）**：autoScroll effect 依赖数组从 `[rows.length, lastRunFinish, runActive]` 扩展——**流式内容更新（同一条消息内容变化）也要触发滚底**，不只 rows.length。
- **产品语义**：用户在底部时，任何新内容（新消息或既有消息内容增长）到达 → 滚到底；用户不在底部 → 不滚（sticky-bottom 门控保留）。
- **保留既有 invariants**：loadMore 前插不滚底；loadMore 完成下一帧跳过；prepend 位置保持。
- 阈值 NEAR_BOTTOM_THRESHOLD=120px **保持不变**（leader 确认基本正确）。

## 3. 功能需求

### 3.1 引导气泡（新功能，核心）

**描述**：聊天对话 view 不在最底部时，输入框上方显示一个浮动气泡，提示用户下方有内容。

**优先级**：P0

**用户故事**：作为用户，我翻看历史消息时，希望知道下方有新消息在产生（「新消息」）或还有未看完的内容（「回到底部」），点一下就能回去。

**产品规则**：

1. **显示条件**：`nearBottom === false` && 会话非空（有消息）。
2. **文案**：`runActive === true` → 「新消息」；否则 → 「回到底部」。
3. **点击**：平滑滚动到消息流底部；滚动完成后气泡消失（用户回到底部）。
4. **过渡**：出现/消失有 fade + 轻微上移动画（≤200ms，不突兀、不位移其他元素）。
5. **样式基线**：轻量胶囊气泡（surface 底 + 边框 + 阴影 + 主色文字/图标），hover 微亮、cursor pointer；尺寸紧凑（高 ~28-32px），不遮挡消息内容主区。
6. **i18n**：chat.json 新增 `scrollGuide.newMessage`（新消息）/ `scrollGuide.backToBottom`（回到底部）/ ariaLabel（「回到底部」/「查看新消息」语义），en + zh-CN 双语。

**覆盖范围**：所有经 `SectionChatSession` 接入的聊天页（playground / studio 单聊群聊 / academy×4）**自动生效**——滚动逻辑与气泡在共享内核（ComponentMessageStream + useMessageScrollPagination），不逐页接入。

### 3.2 自动滚动跟丢修复（bug）

**描述**：用户在底部时，流式生成内容更新也要自动滚底，不被甩开。

**优先级**：P0

**现状根因**（`use-message-scroll-pagination.ts` 第 86-97 行）：
- `autoScrollDeps: [rows.length, lastRunFinish, runActive]`——只在 rows.length 变化时触发滚底。
- 流式生成时 `text_block_delta` 只更新同一条消息内容（rows.length 不变）→ effect 不触发 → 不滚底 → 用户被甩开。

**修复语义**：autoScroll 触发条件从「行数变化」扩展为「**内容变化**」（新消息到达 OR 既有消息内容增长）。用户在底部（nearBottom=true）→ 滚底；不在底部 → 不滚。

**不变量（MUST NOT 破坏）**：
- loadMore 前插绝不触发滚底（isLoadingMore=true 跳过）
- loadMore 完成后下一帧跳过一次滚底（wasLoadingMoreRef 防滚回底）
- prepend 后视觉保持原顶部条目位置（prevHeight 技巧）
- sticky-bottom 门控：仅 nearBottom=true 才滚（用户向上翻不强制拉回）

### 3.3 平衡策略（自动滚动 vs 不干扰看历史）

**描述**：统一由 sticky-bottom 门控裁决，气泡与自动滚动共享同一 nearBottom 判定。

**优先级**：P0

**产品语义**：

| 用户位置 | runActive | 自动滚动 | 气泡 |
|---|---|---|---|
| 在底部（≤120px） | 任意 | ✅ 内容更新即滚底（修复后） | 不显示 |
| 不在底部（>120px） | true | ❌ 不滚 | 「新消息」 |
| 不在底部（>120px） | false | ❌ 不滚 | 「回到底部」 |

- **阈值**：NEAR_BOTTOM_THRESHOLD=120px 保持（与 LOAD_MORE_THRESHOLD 对称，上下边界同等缓冲）。修复触发频率后，若仍偶发跟丢，架构期可评估微调（PRD 不预设，不主动改）。
- **nearBottom 判定**：沿用 onScroll 实时更新（`scrollHeight - scrollTop - clientHeight <= 120`），初始 true（新会话首条消息到达即滚底）。

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 在底部 → 发消息 → LLM 流式生成（长回复） | 内容逐段出现，**可视区自动跟进不被甩开**（修复核心验证） |
| UC-2 | 生成中 → 手动向上翻历史（不在底部） | **不自动滚动**；输入框上方出现气泡「新消息」；点击气泡 → 平滑滚到底 → 气泡消失，看到最新内容 |
| UC-3 | run 已结束 → 手动向上翻历史（不在底部） | 不自动滚动；气泡显示「回到底部」；点击 → 平滑滚到底 → 气泡消失 |
| UC-4 | 用户在底部（无生成） | 无气泡（不显示） |
| UC-5 | 空会话（无消息无 run） | 无气泡（走既有空态） |
| UC-6 | 会话历史很长 → 上滑触发 loadMore（前插更旧消息） | 不滚底、不跳动（prepend 位置保持）；气泡按 UC-2/3 规则正常出现/消失 |
| UC-7 | 生成中在底部 → 停止（abort）→ runActive=false | 若仍在底部 → 无气泡；若已翻走 → 气泡从「新消息」切为「回到底部」 |

> **AT 入选评估**：本版本是**确定性 UI 滚动/显示逻辑**（无新 LLM 不确定性板块）——autoScroll 触发、nearBottom 门控、气泡显隐/文案/点击全部可 UT 确定性覆盖。**v1 不新增 AT case**（用户铁律：普通 feature 不建持久 AT/ET）。
> **UT 范围（核心）**：`use-message-scroll-pagination` hook 单测补充——① 内容变化（同 rows.length 下消息内容增长）且 nearBottom=true → 滚底（跟丢修复）；② 内容变化但 nearBottom=false → 不滚；③ 气泡组件渲染——nearBottom=false + runActive → 「新消息」；nearBottom=false + 非 runActive → 「回到底部」；nearBottom=true → 不渲染；点击回调触发。
> **ET 评估**：本版本改动用户可感知行为（滚动 + 气泡）。聊天板块已有 send-message 冒烟 case（核心冒烟集，板块至多一条）——**v1 不新增 ET case**，靠 UT 覆盖 + 既有 ET 回归聊天主链路；若 orchestrator 判定气泡交互值得真机验证，可临时跑一条非持久 case（自由心证 pass/small/blocking），不落库。

## 5. 概念对齐（PRD ↔ ui/tech spec — 不发明新概念）

| PRD 引用 | 权威 spec / 归属 |
|---|---|
| 滚动 hook（`useMessageScrollPagination` + NEAR_BOTTOM_THRESHOLD + invariants） | `specs/ui/components/chat-page/_overview.md` §4.5 + `app/web/src/components/chat-page/use-message-scroll-pagination.ts` |
| 消息流共享内核（ComponentMessageStream） | `specs/ui/components/chat-page/_overview.md` §3/§4 + `component-message-stream.tsx` |
| runActive 来源（useMessages ctx，agent_loop 派生） | `specs/tech/app/frontend/[P0]chat_area_hooks.md` §3 |
| 统一装配层（SectionChatSession，7 页接入点） | `specs/ui/components/chat-page/section-chat-session.md` |
| BaseChatPage 布局（messages wrapper flex-1 + relative + overflow-hidden） | `app/web/src/components/chat-page/base-chat-page.tsx` |
| 布局稳定性（按钮显隐不位移） | `specs/prd/overall/10-tool-permission.md` §10.3 |

**新概念（架构期/编码期补 spec，PRD 只定义产品语义）**：

- **「滚动引导气泡」组件（新）**：chat-page 下新组件（如 `component-scroll-guide-bubble`），消费 nearBottom + runActive + 点击滚底回调。挂载点 = 消息流可视区底部（ComponentMessageStream 外层或 BaseChatPage messages wrapper——架构期定 DOM 归属）。**spec 待补 `specs/ui/components/chat-page/`**。
- **「nearBottom 状态暴露」**：当前 `useMessageScrollPagination` 只返回 `onScroll`，气泡需读 nearBottom（显示条件）——hook 需暴露 nearBottom 派生值或订阅（架构期定 API 形态，不破坏现有调用方）。
- **「内容变化触发 autoScroll」依赖源**：autoScrollDeps 需补「消息内容维度」——具体传什么（messages 引用 / 内容签名 / flatten 派生）归架构期定，产品语义 = 内容更新触发滚底。

**与既有 spec 的已知差异（doc-modifier 阶段 5 待同步）**：

- `_overview.md` §4.5（sticky-bottom 门控）需补「v0.0.262：触发条件从 rows.length 扩展为内容变化 + 引导气泡」
- `component-message-stream.tsx` 消费的 `useMessageScrollPagination` 返回签名变化（新增 nearBottom/滚底能力）需同步 `_overview.md` §4.5 + hook 注释
- `specs/ui/overall/00-app-guide.md` → 补「聊天滚动引导气泡」操作语义（翻历史 → 气泡 → 点击回底）

## 6. 边界 / 不做（v1）

- **不做未读计数气泡**（如「N 条新消息」）：只做引导，不做数量统计
- **不做新内容高亮/标记**：滚到底后不额外高亮新消息
- **不做阈值自动调节**：NEAR_BOTTOM_THRESHOLD 保持 120px 常量
- **不改 enqueue 排队区 / HITL 卡 / 输入区布局**：气泡浮动在消息区底部，不与输入 bar 内部元素重叠
- **不新建 AT/ET 持久 case**（用户铁律）：UT 覆盖滚动逻辑 + 气泡渲染
- **不引入 runActive 之外的「是否有新内容」判定字段**（双源不一致风险）
- **不动自动滚动为平滑滚动**：自动滚动保持即时（scrollTop 赋值）；仅气泡点击为平滑滚动（req 验收口径）

## 7. 验收口径

- **功能**：UC-1~7 语义全部成立（UT：hook 内容变化触发滚底 + nearBottom 门控 + 气泡显隐/文案/点击；ET：既有 send-message 回归聊天主链路不破坏）
- **能力不变量**：
  - 用户在底部 → 流式内容更新自动滚底，不被甩开（核心修复）
  - 用户不在底部 → 不自动滚动（看历史不被打断）
  - 气泡显示 = 不在底部 && 会话非空；文案 = runActive ? 「新消息」 : 「回到底部」
  - 点击气泡 → 平滑滚到底 → 气泡消失
- **回归不变量**：
  - loadMore 前插不滚底 / loadMore 完成一帧跳过 / prepend 位置保持（既有 invariants 不破坏）
  - 空会话 / 用户在底部 → 无气泡
  - 既有 `use-message-scroll-pagination` 单测（sticky-bottom + pagination）全绿
- **布局稳定性**（CLAUDE.md MANDATORY）：气泡出现/消失**不得导致任何元素位移**（绝对定位浮动，不占文档流）
- **性能护栏**：内容变化触发 autoScroll 需防高频重复滚底（流式帧率高）——实现层合并/节流策略归架构期定，但产品语义 = 视觉跟得上即可，不做逐帧强制（避免滚动抖动与 CPU 浪费）
- **视觉保真门禁**：**无设计稿** → 气泡视觉走既有 design system（surface/border/主色，参照现有胶囊组件如 tool-batch / HITL 卡基线）→ 本项跳过 `vision_check compare`

## 8. spec 对齐备忘（读 spec 时发现的出入，供 doc-modifier 后续修）

- `specs/tech/app/frontend/[P0]chat_area_hooks.md` §3 useMessages ctx 字段表含 runActive——本版本直接消费，无需改 hooks spec（气泡判定语义写 PRD/组件 spec 即可）
- `use-message-scroll-pagination.ts` 头注释 invariants ① 写「自动滚底只在『新消息/run 状态变化』触发」——v0.0.262 扩展为「消息内容变化」，注释需同步更新（含「流式内容更新」语义）
- `_overview.md` §4.5 需补引导气泡 + 内容变化触发（见 §5 差异表）

## 9. 版本

**v0.0.262** — 聊天滚动引导气泡 + 自动滚动跟丢修复：用户不在底部时输入框上方显示气泡（生成中「新消息」/空闲「回到底部」，点击平滑滚底）；修复流式生成跟丢（autoScroll 触发从 rows.length 扩展为消息内容变化）；sticky-bottom 门控（120px）保留为统一裁决，在底部自动跟进、不在底部不干扰看历史。详见本 PRD + change_plan（architect 落 `specs/tech/version_logs/v0.0.262/change_plan.md`）。
