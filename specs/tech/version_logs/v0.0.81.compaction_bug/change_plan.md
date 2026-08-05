# v0.0.81.compaction_bug — Change Plan（重定义，含范围扩展）

> 用户输入已落 `reqs/[working] v0.0.81.compaction_bug/req.md` + `states/user_query.md`。
> 已完成（前一轮 coder，保留）：删 compact_notice 全足迹 + summary role=system→user。
> 本轮聚焦：compact 阈值改比例 / base_builder 放置预算+summary 结构 / UI dedup / UI usage 去 estimatedOutput 展示。
> **关键语义**（用户澄清）：20000 = **estimated output 常量**（不随 model 变），代码字段名 `maxOutputTokens` 保留（持久化/SSE 兼容），spec/UI 文案/注释统一表述 "estimated output（估算输出常量）"。

## 0. 已完成（保留，不重做）
- 删 compact_notice（buildCompactNoticeMessage / appendMessages notice / noticeEmitter / agentLoopBus / UI pill / spec §6.5）— grep 0 残留。
- summary role=user（base_builder:154 + assemble-pipeline:140）。

## 1. 变更 C：compact 阈值去 estimatedOutput（按使用比例）
| 文件 | 行 | 操作 |
|------|----|------|
| `app/plugins/builtins/rocky_context/compact/threshold_should_compact.ts` | :49-55 | 公式 `(usage.totalTokens + usage.maxOutputTokens) / usage.tokenLimit > compactRatio` → `usage.totalTokens / usage.tokenLimit > compactRatio`（删 `+ usage.maxOutputTokens`）；同步注释 :7-9/:44-47 表述「按使用比例，不含 estimated output」|
| `__tests__/compact-eps.test.ts` | :92-110 | ratio 用例重算（去掉 maxOutput 分母贡献）|

不变：`DEFAULT_COMPACT_RATIO=0.6`、configSchema（compactRatio）。

## 2. 变更 D：base_builder 放置预算 + summary 1-block-3-sections 重构
| 文件 | 操作 |
|------|------|
| `app/plugins/builtins/rocky_context/assemble/base_builder.ts` | **预算**：`budget_tokens = 0.95 * tokenLimit - estimatedOutput`（tokenLimit=`config.client.contextWindow`，estimatedOutput=devConfig `context.maxOutputTokens`??20000；通过 AssembleCtx 或直接 config+devConfig 读）。**累积**：char×ratio（现有 ratio）≈ token，cap at budget。**放置**：summary block 先（始终放）→ recent（summaryUpTo 之后）从新→旧累加至 budget，超额丢最旧 recent。**summary block 结构**：1 个 content block（不是每消息 1 block），文本 3 段：①说明（preamble，引导 LLM 这是压缩历史+保留片段）②head（pre-summaryUpTo 早段，msgid+role+content 配对）③tail（pre-summaryUpTo 近段，同配对）；head/tail 选取沿用现有 pickWindow fraction（headFraction/tailFraction）；重叠（summary 区间短，head∩tail）按 head 算。role=user（已改）。删 `messageToBlock` 每消息一 block 的旧用法，改 head/tail 内联拼字符串进 1 个 text block。|

开放（coder 定位）：若 summary block 自身已超 budget，cap tail（丢 tail 保 head+说明），汇报。

## 3. 变更 E：UI dedup（by-id merge 防御）
| 文件 | 操作 |
|------|------|
| `app/web/src/store/use-session-run-state.ts` | `setMessages`（:126-133 整体替换路径）+ loadMore prepend（:129）加 **by-id merge**：新消息与现有按 id 合并（不覆盖 SSE 累积的 tool_call 增量；transcript fetch 不重置已渲染的同 id 消息）。用 Map by id 去重 + 保序。|

SSE reducer 已按 id dedup（chat-slice-reducer:131），不动。

## 4. 变更 F：UI usage 去 estimatedOutput 展示
| 文件 | 操作 |
|------|------|
| `app/web/src/components/chat-page/component-usage-panel.tsx` | 删 reserve 分段（:81 `reserve=maxOutputTokens` / :86 parts.reserve / :174 ctx-seg-reserve / :181 ctx-leg-reserve）；`free` 口径改 `tokenLimit - totalTokens`（不读 maxOutput，:88）；occupancy 文案「pct% / free Y」对齐（free 不含减 estimatedOutput）。用户视角 = 已用/window。|

## 5. UT（必做，无 AT/ET）
- threshold：ratio 用例重算（去 maxOutput）。
- base_builder：summary block 是 1 个 text content block（非多 block）；含 3 段（说明/head/tail）；head/tail 含 msgid；recent 新→旧放置 + budget cap（超 budget 丢最旧）；estimatedOutput 计入 budget。
- UI dedup：setMessages by-id merge（同 id 不重复 / 不覆盖 tool_call 增量）。
- UI usage：reserve 分段移除（parts 无 reserve）；free = limit - total。
- vi.mock 绝对路径。

## 6. spec 同步（doc-modifier 阶段，落所有变更）
- `specs/tech/agent/context/[P0]context_compact_detail.md`：§2c.2 阈值公式改 `total/limit > compactRatio`（去 estimatedOutput）；§6.5 compact_notice 章节删（已删）；§3 prompt/summary 结构补「summary block = 说明+head(msgid+content)+tail(msgid+content) 1 block」；estimatedOutput 语义澄清。
- `specs/tech/agent/context/[P0]context_usage_detail.md`（或同名）：estimatedOutput 语义（估算输出常量，非 model maxOutput）+ assemble budget = 95% - estimatedOutput + recent 新→旧。
- `specs/tech/agent/context/[P0]context_assemble_detail.md`：base_builder 放置算法（summary 先 + recent 新→旧 + budget）。
- `specs/ui/components/chat-page/component-usage-panel.md`：usage 面板去 reserve 展示（用户视角 已用/window）。
- `specs/tech/agent/context/[P0]context_snapshot_interface.md`：ContextWindowUsage.maxOutputTokens 字段语义澄清（= estimated output 常量，保留字段名兼容）。
- 各 KB index.md ④ + log.md 追加 v0.0.81。

## 7. 不变量
- compact threshold = 已用/window（不含 estimatedOutput）。
- assemble budget = 0.95×window − estimatedOutput（保护 LLM 调用不过大）。
- summary = 1 个 user content block（说明+head+tail），不进 compact_notice。
- estimatedOutput = 常量 20000（devConfig 可覆盖，不随 model 变），仅 assemble 预算用，不进 threshold/UI。
- UI dedup：所有消息路径（SSE + transcript fetch + loadMore）按 id 合并。
