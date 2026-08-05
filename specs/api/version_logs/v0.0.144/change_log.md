# v0.0.144 — API 变更日志（llm_attempt SSE 事件补 maxAttempts + message）

> 日期：2026-07-14
> 类型：修改（SSE 事件字段扩充，向后兼容加字段；无新增/变更 HTTP 端点）
> 对应 overall：`specs/api/overall/02-llm-chat.md` §1 header（v0.0.25 rev2 段 item 2 + [v0.0.144 modified] 标注）
> 权威：`specs/tech/agent/llm_caller/[P0]llm_caller.md §2.3`

## 变更摘要

`llm_attempt` SSE event（topic=`agent_loop`，v0.0.25 rev2 引入，此前前端零消费）新增两字段，供前端运行气泡外显「重试中 {attempt}/{maxAttempts}」态。**无 HTTP 端点变更**——事件经 `POST /session/:id/messages` 触发 run + `GET /sse` 订阅 `agent_loop` 观察。向后兼容（加字段，旧订阅者忽略新字段仍工作）。

## 1. `llm_attempt` 事件字段扩充

payload（[v0.0.144] 后完整形态）：

```json
{
  "type": "llm_attempt",
  "category": "PROVIDER_OVERLOADED",
  "providerId": "01KVC9A2...",
  "modelId": "claude-sonnet-4-6",
  "keyRef": "default",
  "attempt": 2,
  "maxAttempts": 3,
  "action": "RETRY",
  "message": "服务商繁忙，正在重试"
}
```

- **`maxAttempts: number`（新增）**：本次 invoke 的最大 attempt 次数 = `llm_request` config `retry.max_attempts`。前端「重试中 x/x」的分母。**真实性依赖 config 装配接线**（v0.0.144 需求2 修断链前恒为 DEFAULT 的 3，见 `specs/tech/agent/llm_caller/[P0]llm_caller.md §4.1`）。
- **`message: string`（新增）**：`category` 对应的用户可读文案（后端 `deriveDisplayReason(category)` 派生，中文兜底），前端 hover 展示。前端不重复维护 category→文案映射。
- **`keyRef?`（订正为可选）**：attempt 失败时携带失败目标 key 引用；整链 all_dead 的 `action=FAIL` 终态 target=null 时缺省（`attempt=0`）。
- **`action` 枚举**（既有，v0.0.144 订正 overall 历史误记）：`RETRY` / `ROTATE_KEY` / `FALLBACK` / `FAIL`（不存在旧 spec 文字里的 `bump_max_tokens`/`switch_key`/`switch_provider`——具体动作语义由 `action` + `category` 组合表达）。

## 2. 前端消费（v0.0.144 起）

前端 reducer 消费 `llm_attempt`：`action ∈ RETRY/ROTATE_KEY/FALLBACK` → 置 `retryStatus = { attempt: Math.min(attempt, maxAttempts), maxAttempts, message }`（clamp 防越界，绝不出 `4/3`）；`action=FAIL` → 不设（交棒 run 失败 error 呈现）；常规运行事件（message_start(assistant)/text_block_delta/tool_call_start/tool_result_start/tool_execution_start）与 run_end → 清 `retryStatus`。运行气泡切「重试中 {attempt}/{maxAttempts} + ！(hover 显 message)」态。UI 契约见 `specs/ui/components/chat-page/_overview.md §4.10 + §7`（testid `chat-run-spinner-retrying` / `chat-run-spinner-retry-error`）。

## 3. AT/UT 覆盖

- **AT**：`tests/api/` 出站帧断言 `llm_attempt.maxAttempts`(=config 值) + `message`(=deriveDisplayReason) 透传（record 双关 PASS）。
- **UT**：`llm/caller/__tests__/error_log_layer.test.ts`（emitLlmAttempt 直测 maxAttempts+message + invoke onEvent 集成出站）+ `agent/__tests__/llm-attempt-forward.test.ts`（forwardEvent 透传）+ 前端 `chat-slice-reducer-retry.test.ts` reducer clamp。
