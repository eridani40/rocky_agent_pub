# v0.0.338 change_plan：mate 退出通知 interrupted 提示

> 架构期冻结契约。coder 按此实现，reviewer 按此查偏离。coder/doc-modifier 不改本文件；事后偏差写 `change_log.md`。
> 上游：`reqs/[working] v0.0.338.md`（leader 2026-08-12 14:20 派单）。
> worktree：`worktrees/v0.0.338-mate-exit-interrupted-tip`。
> 边界：只改退出通知文案/语义提示；不改退出机制、不改 stop reason 本身、不影响其他 reason 行为；面向 leader（agent 可读文本），无 UI 改动。

## 定位（代码实证）

| 项 | 文件:行 | 说明 |
|---|---|---|
| 通知组装（纯函数） | `app/server/src/agent/mate-exit-notify.ts:96-114` `formatMateExitNotify` | 拼「【mate 退出通知】{name}（{role}）run 已退出\n退出原因: {stopReason}\n耗时: ...」。**改动点在 :99** `退出原因: ${input.stopReason}`。 |
| StopReason 值域（7 种） | `app/server/src/agent/agent-event-types.ts:43-50` | `no_tool_call / no_new_messages / max_iterations / doom_loop / error / tool_pending / interrupted`（interrupted 注释：abort api 收尾 emit run_stop 用）。 |
| 调用链 | `app/server/src/agent/run-lifecycle-port.ts:101-103`（onRunEnd，`state.stopReason ?? 'error'`）+ `:128-130`（onInterrupted，恒传 `'interrupted'`） | 通知文本由 formatMateExitNotify 单点生成；run-lifecycle-port 仅传 stopReason，不改。 |
| 现有测试 | `app/server/src/agent/__tests__/mate-exit-notify.test.ts:89-93` | 已有 7 reason 循环断言 `退出原因: ${reason}`——interrupted 分支需补提示断言，其余 6 种断言「不含提示」。 |

## 变更清单（method 级）

| # | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| M1 | `app/server/src/agent/mate-exit-notify.ts` | `formatMateExitNotify`（:99） | 修改 | `退出原因: ${input.stopReason}` 改为条件追加提示：stopReason === 'interrupted' 时输出 `退出原因: interrupted（由用户中断，如需要可询问用户）`，其他 6 种 reason 输出不变。实现：`const reasonLine = input.stopReason === 'interrupted' ? \`退出原因: ${input.stopReason}（由用户中断，如需要可询问用户）\` : \`退出原因: ${input.stopReason}\`;`，lines.push(reasonLine)。 | MUST 仅 interrupted 分支追加（其他 reason 输出逐字节不变）；MUST NOT 改 stopReason 值本身（仍原样输出枚举值）；纯函数签名不变 | mate-exit-notify.ts:96-114; agent-event-types.ts:43-50 | +3 |

> 单点改动：M1 一行条件追加。不动 run-lifecycle-port.ts（调用方无需感知）、不动 StopReason 定义、不动通知投递（notifyMateExit）。

## UT 要求（MANDATORY）

仓库根 `bun --bun x vitest run`（**非** `bun test`）。更新 `app/server/src/agent/__tests__/mate-exit-notify.test.ts`：
- **interrupted**：`formatMateExitNotify({...base, stopReason:'interrupted'})` 输出含 `（由用户中断，如需要可询问用户）`，且 `退出原因: interrupted` 保留。
- **其他 6 种**（no_tool_call / no_new_messages / max_iterations / doom_loop / error / tool_pending）：输出含 `退出原因: ${reason}` 且 **不含**「由用户中断」提示（断言 not.toContain）。
- 全量零回归 + tsc 0 error。

## 验收标准（锚定）

1. interrupted 退出通知（onInterrupted → notifyMateExit(state,'interrupted')）文本含「（由用户中断，如需要可询问用户）」。
2. 其他 reason（onRunEnd 6 种）通知文本不含该提示，行为不变。
3. 退出机制 / stop reason 值 / 投递流程零改动。

## 影响面 / 风险

- 仅 formatMateExitNotify 纯函数一行条件；调用方（run-lifecycle-port）与下游（deliverTo 投递）零改动。
- 面向 leader 的 agent 可读文本，无 UI / 协议 / schema 变化。
- 风险极低：单点条件分支，UT 覆盖两分支。
