# v0.0.338 change_log — mate 退出通知 interrupted 提示

> 对应需求：`reqs/[working] v0.0.338.md`（leader 2026-08-12 14:20 派单）。
> 权威契约：`specs/tech/version_logs/v0.0.338.mate_exit_interrupted_tip/change_plan.md`（M1，frozen）。
> commit：`70beab2e7`（T1 实现）。

## 变更摘要（已合并编码）

### M1：formatMateExitNotify 退出原因行条件追加（commit 70beab2e7）

- `app/server/src/agent/mate-exit-notify.ts:96-103`：`退出原因: ${input.stopReason}` 改为条件分支——`stopReason === 'interrupted'` → `退出原因: interrupted（由用户主动中断，无需处理）`；其他 6 种 reason（no_tool_call/no_new_messages/max_iterations/doom_loop/error/tool_pending）输出逐字节不变。
- 纯函数签名不变；不改 stopReason 值本身（仍原样输出枚举值）；不动 run-lifecycle-port.ts / agent-event-types.ts / 投递流程。

## 实现核对（method 级）

| 计划项 | 实现一致性 |
|---|---|
| M1（formatMateExitNotify :99 条件追加） | ✅ 代码 :99-103 实现条件 reasonLine；仅 interrupted 分支追加提示；其他 6 种 not.toContain（UT 断言）；stopReason 原样输出 |

## 偏离记录

- **文案用词偏离（change_plan「可询问用户」→ 代码「可向用户查证」）**：change_plan M1 原文写「退出原因: interrupted（由用户中断，如需要可**询问用户**）」；编码实现用「如需要可向用户**查证**」（leader 派单原文 + 老板钦定文案，commit message 亦载明）。**以代码为准**（「查证」语义更精确：向用户求证事实而非简单询问）。change_plan 为 frozen 契约不改写，此处记录。

## 已知缺陷（本版不做）

（无新增。）

## 关键文件（编码产出）

| 文件 | 变更 |
|---|---|
| `app/server/src/agent/mate-exit-notify.ts` | M1：reasonLine 条件分支（interrupted 追加提示） |
| `app/server/src/agent/__tests__/mate-exit-notify.test.ts` | UT +2（interrupted 含提示断言 + 其他 6 种 not.toContain）；全量 10373 passed 零回归 |

## 文档同步

- **`specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md`**：§3.2 mateExitNotify 装配段通知内容补「退出原因行（`[v0.0.338]` 条件追加）」——interrupted → 「退出原因: interrupted（由用户主动中断，无需处理）」，其余 6 种逐字节不变。
- **`specs/tech/agent/agent_interface_and_loop/log.md`**：v0.0.338 变更记录条目。
- 注：`specs/prd/version_logs/v0.0.273.mate_exit_notify/prd.md` 为历史版本快照，不更新（惯例保留当时现状）。
