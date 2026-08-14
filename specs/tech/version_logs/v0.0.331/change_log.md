# v0.0.331 tech change log — a2a out 信封展开空白根治（P0+P1+P1'+P2 全做）

> 对应需求：`reqs/[working] v0.0.331.a2a-envelope-out-blank.md`。
> 权威契约：`specs/tech/version_logs/v0.0.331/change_plan.md`（D1-D13 method 级契约，frozen）。
> 根因实证：bug-analyst 337 行报告（temp/bug-a2a-envelope-out-blank-2026-08-12.md，§5/§8/§9/§10.4 权威）。

## 变更摘要

### 根因（实证）

v0.0.311（4031f1b9f）out 信封 bodyText 提取源从「后端已 normalize 的 tool_result」切到「LLM 原始 arguments」，但只兼容 `array + block.type==='text'` 一种形态。真实 LLM（glm/deepseek 17-20%）传 `[{"text":"..."}]`（block 缺 type）→ 后端 `normalizeSendMessageInput` 只认 text 字段容错发送成功 → 前端 `filter(c=>c.type==='text')` 全滤 → 展开空白。数据：4451 条 send_message 中缺 type 311 后 38 条（11%）。

### 方案（D1-D13 实现，老板裁定全做）

1. **P0 前端容错（D1-D3）**：`component-message-stream.tsx` 新增文件级导出 `extractSendMessageBody(argContent)`——四形态容错（string 直用 / array 只认 text 不读 type join('\n') / object `.item ?? obj` 解包 / 其他 `''`），bodyText 改调；`_rawTruncated === true` 时 errText 显示「发送失败（参数截断）」优先于 result 提取。历史脏数据兜底 + 第二类空白可见化。
2. **P1 落库前 normalize（D4-D10）**：`send-message-tool.ts` 抽公共函数 `normalizeContentBlocks(rawContent)`（语义唯一来源：array 缺 type 补 `type:'text'` / string→包数组 / object `.item ?? obj` 解包 / 未知 type 不透传 / error 形态），`normalizeSendMessageInput` 改调（行为零变化）；`agent-loop-stream.ts closeActive()` + `replay-collector.ts reconstitute()` 落库前对 `send_message` 且非 `_raw` 调同函数 normalize（新数据永不空白 + 切断 LLM 上下文自增强）；`safeParseArgs` 解析失败返回 `{ _raw, _rawTruncated: true }`（两处同构）。
3. **P2 防再生（D6）**：send-message-tool description 补字面示例 `[{"type":"text","text":"hi"}]` + **Each block MUST include the "type" field**（对 glm/deepseek 部分有效）。

### 关键决策

- **公共函数防漂移**：normalizeContentBlocks 与工具定义同文件（send-message-tool.ts）导出，normalizeSendMessageInput + 两处落库前 normalize 全部 import 同一函数 → 前后端/多处永不漂移。
- **P1 只修新落库，P0 兜历史脏数据**：两者互补缺一不可；存量数据不做迁移（不改历史数据）。
- **`_raw` 半截路径不补 content**：safeParseArgs 失败返回 `_rawTruncated:true` 标记，由前端 D3 展示「发送失败（参数截断）」。
- **发给 LLM 的 tool_use.input 为补全形态**（缺 type → `type:'text'`），语义不变，无副作用（protocol-encode 逐字节透传不涉及）。

### 边界与铁律落实情况

- 不改发送链路（后端 normalizeSendMessageInput 已正确，对端接收正常）
- 不改 protocol-encode / clean-view / context-compact / message-flatten.ts
- 不做 P3（容错带 warning 反馈）——可选长期收敛，本轮不实现
- 不改历史数据（存量脏数据靠 P0 前端兜底）
- normalize 只影响 `send_message` 的 arguments.content，其他工具零动
- `_rawTruncated` 是新字段，仅前端 D3 消费

## 关键文件变更

### 后端（P1 + P1' + P2）

| 文件 | 变更 |
|---|---|
| `app/server/src/agent/tools/send-message-tool.ts` | 抽公共导出函数 `normalizeContentBlocks`（D4）；`normalizeSendMessageInput` 改调（D5，-15 行）；description 补字面示例 + Each block MUST include the "type" field（D6） |
| `app/server/src/agent/agent-loop-stream.ts` | `closeActive()` 落库前 normalize send_message arguments.content（D7）；`safeParseArgs` 失败加 `_rawTruncated: true`（D8） |
| `app/server/src/agent/replay-collector.ts` | `reconstitute()` 同 normalize（D9）；`safeParseArgs` 同加 `_rawTruncated`（D10） |

### 前端（P0 + P1' 展示）

| 文件 | 变更 |
|---|---|
| `app/web/src/components/chat-page/component-message-stream.tsx` | 新增导出 `extractSendMessageBody`（D1）；bodyText 改调（D2）；`_rawTruncated` → 「发送失败（参数截断）」（D3） |

### 测试（D11-D13）

| 文件 | 变更 |
|---|---|
| `app/server/src/agent/__tests__/replay-collector.test.ts` | `_raw` 断言同步 `_rawTruncated: true`；新增 send_message 缺 type 落库补 `type:'text'` 断言 |
| `app/server/src/agent/tools/__tests__/send-message-tool.test.ts` | `normalizeContentBlocks` 直接用例全形态（array 缺 type→补 text / string→包数组 / object item 解包 / text 非 string→error / 空） |
| `app/web/src/components/chat-page/__tests__/component-message-stream-strategy.test.tsx` | `extractSendMessageBody` 全形态用例 + `_rawTruncated` 展示「发送失败（参数截断）」 |

## 验证结论

- UT：全量 857 files / 10323 tests passed + tsc 0 error（worktree 跑）
- normalizeContentBlocks 全形态 12 用例 + _rawTruncated 断言同步 + send_message 缺 type 落库补 type + extractSendMessageBody 全形态
- AT/ET：本轮为纯数据链路修复（无用户可感知新交互），test-plan 判 UT 覆盖充分（见 states/v0.0.331/）

## doc 同步（doc-modifier2，合并前完成）

- `specs/tech/multi_agent/[P1]subagent_derivation.md §5.1`：content 容错契约（normalizeContentBlocks 四形态 + desc 要求 + 落库前 normalize）
- `specs/tech/agent/message/[P0]agent_message_interface.md §4.6`：ToolCallBlock 补 `_raw`/`_rawTruncated` 半截形态 + send_message 落库前 normalize
- `specs/api/overall/10a-multi-agent-tool-ref.md §3a.1`：接口签名补 content 容错契约引用
- `specs/ui/components/chat-page/component-a2a-envelope.md`：补 out 方向（direction/status/errorContent props）+ bodyText/error 提取契约（extractSendMessageBody 四形态 + _rawTruncated 展示）
- `specs/tech/multi_agent/log.md` + `specs/tech/agent/message/log.md`：KB 变更记录
