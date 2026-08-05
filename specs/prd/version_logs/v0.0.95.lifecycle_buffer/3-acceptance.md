## §5 验收标准

> 纯架构版的验收 = **契约达标 + 流式不回归**，不验新功能。每条对应 §3 一条路径或一个不变量。

### 5.1 契约达标（硬指标）

| ID | 验收项 | 验证手段 | 通过判据 |
|----|--------|----------|----------|
| A1 | **useMessages 进契约**：删除自管 `sliceRef` / `runCtxRef` / `setSlice`，改用 useLifecycle 的 ctx + buffer 通道 | 代码审查 + grep `sliceRef\|runCtxRef` in `use-messages.ts` 应 0 命中 | useMessages 与其他 area-hook 同构（四方法 + ctx/buffer 通道） |
| A2 | **reducer 纯化**：`applyAgentEventToMessages` 从 mutate ctxRef 改成 `return {ctx, buffer}` | UT：同一 (输入 state, event, buffer) 两次调用得同结果（幂等）；无外部 ref 写入 | reducer 无副作用；StrictMode 双调用不 double 累积（P7） |
| A3 | **buffer 变不渲染**：buffer.rawArgs 半截变化不触发 setCtx | UT：mock onEvent 返 `{ctx: 同引用, buffer: 新}`，断言 setCtx 未被调用 | 半截 rawArgs 不给用户看（P2/P3） |
| A4 | **ctx 变才渲染**：onEvent 返 `{ctx: 新, buffer: 任意}` 时触发 setCtx | UT：mock onEvent 返新 ctx，断言 setCtx 被调用一次 | 渲染态变化即时反映 |
| A5 | **onEvent 串行调度**（不变量 7 新增）：单 buffer 不被并发写 | UT：模拟两个 event 几乎同时到达，断言处理顺序串行（buffer 状态 = 顺序应用结果，非交错 race） | 单 buffer race 防护生效 |
| A6 | **buffer 用完清理**（D2）：tool_call 完成后 rawArgs[key] 从 buffer 删 | UT：跑一轮完整 tool_call（run_start → tool_call_delta* → tool_call 结束 → 写 ctx），断言 buffer.rawArgs 为空 map | 不泄漏 + 不污染（P10） |
| A7 | **deps 变/reload/onDestroy 重置 buffer**：切 session 时 buffer 随 onInit 重置 | UT：sessionA 流式中切 sessionB，断言 sessionB 的 buffer 无 sessionA 残余 | 切 session 干净重置（P9） |
| A8 | **契约 100% 覆盖**：无特例残留 | grep `sliceRef\|runCtxRef\|setSlice` 在所有 area-hook 应仅 useMessages 历史注释（无实际自管） | 所有数据 hook 走 useLifecycle 通道 |

### 5.2 流式不回归（行为指标，覆盖 §3 全部路径）

| ID | 路径 | 验证手段 | 通过判据 |
|----|------|----------|----------|
| R1 | P1 流式文字累积不丢字 | ET chat_basic_tc1（playground 流式）+ UT 高频帧模拟 | 文字完整、顺序正确 |
| R2 | P2 工具调用 rawArgs 累积正确 | ET tool_call case（agent 工具场景）+ UT reducer | 完整 args 写 message；半截不渲染；buffer 清空 |
| R3 | P3 多帧 text_delta 顺序 | UT（50 帧模拟）+ ET | 无丢字/重字/跳序 |
| R4 | P4 messages_cleared 清对话区 | ET clear 端点 case | messages/lastRunFinish/enqueueItems 同帧清 |
| R5 | P5 loadMore 分页 merge | ET 上滑 loadMore + transcript fetch case | 续载不丢近期 SSE 增量；transcript 不覆盖 rawArgs（BUG-002 链路） |
| R6 | P6 三页流式一致 | ET playground / 单聊 / 群聊 各跑一次流式 | 三页行为一致；群聊策略过滤正确 |
| R7 | P8 sticky run_start 孤儿清理 | UT + ET（session 卡死模拟） | runActive 清、loadingPhase 清 |
| R8 | P9 切 session 重置 | UT（切 session 后 buffer 空） | 旧 session 残余不泄漏 |

### 5.3 阈值门禁（沿用 CLAUDE.md）

- **API 测试**：本版零 API 契约变更，无新增 AT case；现有 chat/agent AT 必须保持通过率 ≥ 90% 且无阻塞性 issue（流式相关 AT case 是关键路径必 pass）。
- **E2E 测试**：通过率 ≥ 70%，**hard_fail = 0**，**PRD 关键用户路径 P1-P10 全 pass**（不论 vision/dom）。
- **UT**：useLifecycle buffer 新增 UT + reducer 纯化 UT 全 pass；StrictMode 双调用幂等 UT pass。
- **视觉保真度**：本版无设计稿，跳过（CLAUDE.md「设计稿=视觉契约」原则）。

### 5.4 文档同步（阶段 5 MANDATORY）

doc-modifier 必须同步：
- `[P0]component_architecture.md §3.10`：签名加 TBuffer + 不变量 7（onEvent 串行）+ mutateBuffer 口子说明。
- `[P0]chat_area_hooks.md §3`：删「流式特例 / v0.0.95 预告」，改「标准契约 + buffer 范例（useMessages 是 buffer 用法的样板）」。
- `[P0]lifecycle_data_shapes.md §3.2`：标「v0.0.95 已进契约」，更新 reducer 纯化说明。
- `chat-slice-reducer.ts` 注释：修正「纯函数」描述（v0.0.94 spec 与实现偏差，本版对齐）。
- prd/api/ui 的 overall：本版无 overall 改动（无新功能）。

### 5.5 失败处置

| 失败类型 | 处置 |
|----------|------|
| 流式丢字 / 重字（R1/R3） | 阻塞合并——buffer 契约或 reducer 纯化设计错，退 coder + 通报 architect 重审 |
| rawArgs 半截渲染（R2/A3） | 阻塞合并——buffer 不渲染不变量被破坏 |
| StrictMode 双调用 double 累积（A2） | 阻塞合并——reducer 未真纯化 |
| buffer 泄漏（A6/A7） | 阻塞合并——D2 清理未实现 |
| 三页流式不一致（R6） | 阻塞合并——三页同源 area-hook 假象破裂 |
| 切 session 残余泄漏（R8） | 阻塞合并——deps 重置未覆盖 buffer |
| 契约残留特例（A8） | 阻塞合并——契约未达 100% 覆盖 |
