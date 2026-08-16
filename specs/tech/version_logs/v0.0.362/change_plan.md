# v0.0.362 变更计划书 — run-end 汇报去重（最近 3 轮已 send_message→leader 则跳过）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 0. 需求与拍板

| 时间 | 拍板 | 内容 |
|---|---|---|
| 老板 20:29 | run-end 汇报去重 | run 结束汇报发送前查最近 3 轮 assistant message——窗口内有 send_message 工具调用且 target 指向 leader → 跳过本次 run-end 汇报（认定已汇报过）。简单粗暴：只看 tool_use 存在性，不区分 needReply/成败 |

- req：`reqs/[working] v0.0.362.run-end-report-dedup.md`（commit 4866c85b7）
- 纯内部行为无 UI 感知 → 跳 PRD。边界：不动汇报格式/退出原因分类；本优化只做去重，未命中照发。

## 1. 方案设计

### 1.1 现状链路（代码实证）

mate 顶级 run 统一退出口 = `RunLifecyclePort.onRunEnd/onInterrupted`（`app/server/src/agent/run-lifecycle-port.ts` L102 / L129）→ `notifyMateExit(state, opts)`（`mate-exit-notify.ts`）→ 两跳解析 leader sessionId（squadStore.getSquad → memberStore.getMember）→ `formatMateExitNotify` 构造 markdown → `deliverTo(leaderSid)`。失败 try/catch 仅 warn 不阻断。

**去重判定插入点**：`notifyMateExit` 内部、leaderSid 解析成功之后、消息构造之前——命中则 log + return（跳过投递）。两调用路径（onRunEnd/onInterrupted）天然同享判定。

### 1.2 判定窗口数据源（最近 3 轮 assistant message）

- 历史轮次：`state.snapshot?.messages`（ContextSnapshot.messages = 发给 LLM 的完整对话，含既往 assistant 轮的 tool_call blocks）过滤 `role==='assistant'`。
- 末轮补拼：run 的最终 assistant 回复**不在 snapshot 内**（snapshot 是发给 LLM 的输入侧，最后回复在其后）→ `state.lastAssistantContent` 非空时拼为一条伪 assistant message 追加。
- 窗口 = 上述合并序列 `.slice(-3)`。
- snapshot 为 null（理论不达，防御）→ 视为未命中，照发。

### 1.3 target=leader 判定口径（req 两种形态）

`tool_call.name === 'send_message'` 且 `arguments.target` 满足其一：

| target 形态 | 判定 |
|---|---|
| 字符串 `'parent'` | 直接命中（mate 的 parent 即 leader——req 明文口径） |
| 字符串显式 sessionId | `=== leaderSid` 命中 |
| AgentRef 对象 `{type:'agent', sessionId, ...}` | `target.sessionId === leaderSid` 命中 |

**不匹配**（记为已知限制，req 范围外）：name 形态 AgentRef（如 `{type:'agent', name:'Darvin'}`）不解析比对——避免每条 tool_call 走异步 store 解析，违背「简单粗暴」拍板；needReply/发送成败一律不看。

### 1.4 新增纯函数（UT 面）

`app/server/src/agent/mate-exit-notify.ts` 内新增导出纯函数（零 IO，与 truncateText/formatMateExitNotify 同层）：

```ts
/** 最近 N 轮 assistant message 内是否有 send_message→leader 调用（run-end 汇报去重判定） */
export function hasRecentLeaderReport(
  snapshotMessages: Message[] | null | undefined,
  lastAssistantContent: ContentBlock[] | undefined,
  leaderSid: string,
  window = 3,
): boolean
```

`notifyMateExit` 调用：命中 → `console.log('[mateExitNotify] recent send_message to leader found, skip run-end report (dedup)')` + return。

## 2. 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent | app/server/src/agent/mate-exit-notify.ts | hasRecentLeaderReport（新增）+ notifyMateExit（修改） | 新增/修改 | 纯函数：snapshot.messages 过滤 assistant + lastAssistantContent 伪消息拼接 → slice(-3) 窗口 → 扫 tool_call（name==='send_message' && target 三形态比对 leaderSid）；notifyMateExit 在 leaderSid 解析后调用，命中 log+return | MUST：纯函数零 IO；MUST NOT：不动 formatMateExitNotify/退出原因分类/汇报格式；未命中路径行为逐字节不变 | 本表 §1.1-1.3 | +45 |
| 测试 | app/server/src/agent/__tests__/mate-exit-notify.test.ts（既有文件追加） | describe hasRecentLeaderReport | 修改 | 命中跳过（parent 形态/显式 sid 形态/AgentRef 形态）；未命中照发（窗口内无 send_message / target 指向他人）；窗口边界（命中调用在第 4 轮→不命中）；lastAssistantContent 伪消息参与窗口；snapshot null → 未命中 | MUST：全绿 + tsc -b 0 error | req 交付物 | +60 |

## 3. 影响面与验证

- **影响**：仅 mate run 退出通知的发送频率（命中场景 leader 不再收重复汇报）；onRunEnd/onInterrupted 两路径同享；leader 解析失败/squad 缺失等现状短路路径不变（判定在其后，不干扰）。
- **风险**：①mate 末轮 send_message 失败（deliverTo 抛错被 send-message-tool 内部 catch）仍会命中跳过——已汇报认定按「调用存在性」，老板拍板口径（不看成败）；②send_message 发给 leader 的内容若与 run 结尾状态无关（如中途问询）也命中跳过——窗口仅 3 轮+mate 尾部惯例是交付汇报，误杀面小，接受（简单粗暴优先）。
- **验证**：UT 必须；AT/ET 豁免（纯内部行为、无 API/UI 变化）。
- **specs 同步**（doc-modifier 收尾）：mate-exit-notify 语义归 `specs/tech/multi_agent/[P1]a2a_protocol.md` 或 273 change_log 追记——去重判定小节（数据源/窗口/三形态口径/已知限制）。
