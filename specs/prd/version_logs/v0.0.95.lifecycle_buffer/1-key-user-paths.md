## §3 关键用户路径（MANDATORY）—— 纯架构版 = 流式不回归契约

> **本版本零新功能**，路径不是「新增功能链路」而是「重构后必须不回归的现有流式行为」。每条路径 = 至少一个 UT/ET case 覆盖（req.md 验证项对齐）。testid 契约从 `specs/ui/components/chat-page/_overview.md` + `studio-page/_overview.md` 读（不扒代码）。
>
> 路径覆盖逻辑：buffer 改造触及 part 级累积的所有链路——文字累积、工具参数累积、半截清理、多帧顺序、清空、分页 merge、三页同源。任一回归 = buffer 契约设计错或 reducer 纯化错。

### 3.1 路径清单（回归契约）

| ID | 路径 | 关键断言（落在用户价值） | 类型 |
|----|------|--------------------------|------|
| P1 | 发消息 → 收纯文本流式回复（多帧 text_delta 累积） | 文字一字不丢、顺序正确、最终完整；不出现半截 rawArgs 残留渲染 | ET + UT |
| P2 | 发消息 → LLM 返回工具调用 → 工具执行 → 返回结果 → LLM 继续回复 | tool_call rawArgs 半截累积正确（buffer 内攒）、完整 args 写进 message、buffer 清空；不渲染半截 JSON | ET + UT |
| P3 | 多帧 text_delta 顺序到达（不丢字、不重字、不跳序） | 帧间 ctx 切换无 stale 读；buffer 变不触发渲染；ctx 变才渲染 | UT（高频帧模拟）+ ET |
| P4 | session_panel messages_cleared → 对话区清空 | messages/lastRunFinish/enqueueItems 同帧清；buffer.rawArgs 随卸载/reload 清 | ET |
| P5 | 上滑 loadMore 分页 → mergeMessagesById 合并（不重置 SSE 累积态） | 续载旧消息不丢近期 SSE 增量；transcript fetch 整体替换不覆盖已渲染同 id 消息的 tool_call rawArgs（BUG-002/compaction_bug 链路） | ET |
| P6 | playground / 单聊（MemberChatPage）/ 群聊（SquadChatPage）三页流式行为一致 | 三页同源 area-hook（useMessages）后流式表现完全一致；群聊策略过滤不破坏 part 累积 | ET |
| P7 | StrictMode 双调用下 reducer 幂等（buffer + ctx 不 double 累积） | reducer 纯化后双调用同一 event 得同结果；rawArgs 不被双倍 append | UT |
| P8 | run 卡死（session_status_update 进终态，run_end 未到）→ 强制清 sticky run_start 孤儿 | runActive=false / loadingPhase=null；buffer 不泄漏（D2 清理） | UT + ET |
| P9 | 切 session（deps 变）→ onInit 重置 ctx + buffer（双清） | 旧 session 的 rawArgs/pendingError 不泄漏到新 session；runCtx 重置 | UT |
| P10 | buffer 用完清理不变量（D2）—— tool_call 完成后 rawArgs[key] 删除 | 一轮 tool_call 跑完后 buffer.rawArgs 为空；不无限增长；下次同 id 不拼旧半截 | UT |

### 3.2 不覆盖项（明确排除 + 理由）

| 排除项 | 理由 |
|--------|------|
| 后端 agent_loop 帧 schema / event 语义 | 本版不碰后端（仅前端 reducer 纯化） |
| 三形 reducer（applyCrud/applySnapshot/applyKeyed）行为 | 本版不动三形（buffer 对它们恒 null），v0.0.94 已覆盖 |
| 非 useMessages 的 area-hook（useRunState/useUsage/useSummary/useSessionPanelFanout）流式行为 | 它们无 part 级累积，v0.0.94 已验；本版不动它们的契约 |
| BUG-001 Tiptap 兼容（若不纳入本版） | 见 change_log §2.3，可选顺手修，不阻塞主线 |
| 视觉保真度 compare | 本版本无设计稿（CLAUDE.md「设计稿=视觉契约」原则跳过） |

### 3.3 E2E Use Cases（每路径至少一 case，MANDATORY）

| ID | 用户操作链路 | 预期结果 |
|----|--------------|----------|
| UC-P1 | 在 playground 输入框发"讲个长故事" → 等 LLM 流式回复完成 | 对话区完整呈现多段文字；中间过程不闪烁/不丢段；最终消息无残留半截 JSON |
| UC-P2 | 发"用工具查下时间" → 等 tool_call 完成 + LLM 继续回复 | 工具调用块显示完整参数（非半截 rawArgs）；工具结果 message 入列；LLM 续答完整 |
| UC-P3 | （UT 主导）模拟 50 帧 text_delta 高频到达 | messages 最终内容 = 50 帧按序拼接；无丢字/重字 |
| UC-P4 | 点 clear 按钮（或调 clear 端点） | 对话区立即清空；run-finish 也清；enqueue 区清 |
| UC-P5 | 在已有消息的会话上滑到顶 → 触发 loadMore | 旧消息前插；近期 SSE 增量消息不丢；tool_call rawArgs 不被 transcript 覆盖 |
| UC-P6 | playground / 单聊 / 群聊三页分别发同款消息 | 三页流式表现一致；群聊策略过滤（mute assistant answer）正确生效不破坏累积 |
| UC-P8 | run 进行中模拟 session 卡死（session_status_update 推 idle 但 run_end 未到） | runActive 立即清；停止按钮消失；loadingPhase 清 |
| UC-P9 | 在 sessionA 流式中切换到 sessionB | sessionA 残余 rawArgs 不进 sessionB；sessionB 从空基线开始 |
