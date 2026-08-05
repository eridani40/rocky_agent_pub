# compact_model_directive — v0.0.158 studio 手动 compact 主战场

**模块**：compact
**断言面**：Resp（202 + summary 非空 + forked usage 非 0）+ SSE（summary_task_update 事件）+ 真实调 minimax forked compact 行为面（无 tool_use）
**版本**：v0.0.158（一进一出，改写自旧同名 case）；v0.0.190 更新为真实调 API（不再依赖 frame_checks/recordings/stub audit）；v0.0.235 加 forked usage 回归门

## 覆盖核心逻辑

本 case 覆盖 v0.0.158 P2 主战场（req.md 用户路径 P2 studio 手动 compact，本版本关键回归门 = 修前必 400 修后必 202）：

1. **修前必 400 修后必 202 的门槛**（v0.0.158 核心回归）：
   - **修前行为**：studio session 手动 compact → resolveModel 走 summary 分链 + INV-A5 禁 app_config fallback + squad.summaryModelDefault 未配 → 抛 `MODEL_NOT_CONFIGURED { studio, summary }` → 400
   - **修后行为**：chat/compact 同链 → 走 `squad.modelDefault` → resolve 成功 → 202 + `{ok:true}`（fire-and-forget）
   - **断言**：`POST /session/:id/compact status=[202] + .ok == true`
2. **forked 出站不变量**（保留自旧 case，v0.0.190 起改为真实调 minimax 行为面验证）：
   - **tools 为空 / NO_TOOLS 生效**：forked agent `enableToolWhitelist=true, toolWhitelist=[]`；真实调 minimax 时由 forked response 无 tool_use block 作行为面证明（case.yaml 不断 wire 层 tools 字段）
   - **NO_TOOLS marker 存在**：compact.md preamble/trailer 双保险 messages[-1].content 含 "NO_TOOLS"——由 forked 路径本身保证 + 行为面（response 无 tool_use）间接证明
   - **纯 directive**：forked input 只是压缩指令，transcript 历史已在 forked buffer 中不复述——由 forked 路径本身保证
3. **summary content 非空**（走 squad.modelDefault 链正常产出）：`GET /session/:id/summary → .summary.content exists`
4. **SSE `summary_task_update` 事件序列**：SessionTaskLock CAS 成功后经 sessionStatusBus emit 到 `(session_panel, session_id:<sid>)`，至少 1 帧（start）；done/failed 也是 summary_task_update 类型
5. **forked usage 累计非 0**（v0.0.235 核心回归门）：
   - **修前行为**：`runReActLoop` 的 `RunResult.usage` 恒为空 `{}`（v0.0.40 起从未聚合每轮 callLLM usage）→ fork-1 caller `accumulateUsage(sid,'forked', 空usage)` → forked 分区归 0（空对象 `{}`，`input_total_tokens` 字段缺失）→ 前端隐藏「整理」行
   - **修后行为**：`RunResult.usage` 真实聚合每轮 callLLM usage Σ + fork-1 caller `accumulateUsage` 后补 `notifyUsageChanged` → forked 分区有真实 token → 客户端 usage 面板「整理」行显示
   - **断言**：`GET /session/:id/usage → .forked.input_total_tokens >= 1 && .forked.output_total_tokens >= 1`（poll until `.forked.input_total_tokens >= 1`，覆盖 summary 写入→RunResult 聚合→caller accumulateUsage 的滞后窗口）
   - **为何断 forked 而非 total**：`total = current + sub + forked`，主 run 的 current 分区恒 > 0，故 bug 在时 total 也 > 0——total 无法区分 bug 在/不在；forked 分区才是本版本修复的精确判别
   - **为何 REST 而非 SSE session_usage_update**：主 run 的 current 累计也会 emit `session_usage_update`，故 `panel.count(type=session_usage_update) >= 1` 在 bug 在时也成立（不精确）；DSL 无法断「某帧 session_usage_update payload 的 forked>0」（数组谓词只作用于响应体不作用于流事件）。故 AT 用 REST GET /usage 精确判别 forked 数据；「caller notify 顺序」由 UT 兜底（test-plan §2）

## setup 结构

`POST /squad` 事务性建 squad + leader member + **leader session（role=leader/biz=studio/绑 squadId+memberId）**——一步同得目标 studio session，无需额外 `POST /session`。leader session 就是要手动 compact 的对象。

不传 `summaryModelDefault`（本版本删该字段；旧 body 若传后端进 patch 展开由 SquadSchema 拒收）。

`session.modelId` 由 POST /squad 事务默认注入（保留字 `default` 或与 squad.modelDefault 同），不由 case 控制——chat 链 studio 分支 resolve 到 `squad.modelDefault`（本版本主战场）。

## 帧布局（v0.0.190 起改为行为面说明）

| 阶段 | 含义 | 断言要点（真实调 minimax） |
|---|---|---|
| 主 run | leader studio session 正常聊天 LLM 调用 | run 完成 + `stopReason == "no_tool_call"` + 主 run 状态 idle |
| forked compact | compact forked LLM 出站（fire-and-forget 异步） | summary.content 非空（forked 正常产出）+ response 无 tool_use（NO_TOOLS 生效行为面） |
| forked usage 累计（v0.0.235） | fork-1 run 结束 → caller accumulateUsage(sid,'forked', RunResult.usage Σ) | `GET /session/:id/usage → forked.input_total_tokens >= 1 && forked.output_total_tokens >= 1` |

## 已知边界（v0.0.190 真实调 API 表达范围）

- case.yaml 的 `check` 只对 HTTP 响应体 / SSE 事件求值，不读 LLM 出站 wire 帧——**NO_TOOLS 生效由 forked response 无 tool_use 行为面间接证明**（forked agent `enableToolWhitelist=true, toolWhitelist=[]` 决定了 LLM 不会调工具；若 NO_TOOLS preamble 失效，minimax 大概率会调工具，response 会含 tool_use block）
- 真实调 minimax 时主 run 是否调工具不设断言（prompt 显式「不要调工具」但 LLM 行为有弹性；不通过 `main.absent(type=error)` 兜底即可）

## 一进一出说明（旧断言 → 新断言的对照）

| 旧 v0.0.155 断言 | 新 v0.0.158 断言 |
|---|---|
| playground session（POST /session + providerId+modelId） | studio session（POST /squad 事务建 leader session） |
| summary fallback 到 `default_models.summary`（PRD §2.1 第 2/4/6 行） | summary 走 `squad.modelDefault`（chat/compact 同链，无 summary 独立分链） |
| POST /compact 只断 .ok == true（默认成功不看 status） | POST /compact 显式 status=[202]（本版本关键回归门） |
| （无 squad 概念） | teardown 硬删 squad 级联删所有 session/member/办公室目录 |

## 引用

- `reqs/[working] v0.0.158.compact_model_resolve/req.md` — 本版本需求 + 用户裁决全文（P2 主战场）
- `specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md` — Invariant 变更（INV-A5 收窄 + task 参数删除 + body override 删除 + squad 字段整删）+ §A model_resolver + §B session-config + §H migration 变更细节
- `specs/api/overall/04-agent-session.md §7` — POST /session/:id/compact 契约（202 + {ok:true} / 409 compact_in_progress）
- `specs/api/overall/04-agent-session.md §5` — GET /session/:id/summary 契约（SummaryInfo 结构）
- `specs/api/overall/04-agent-session.md §6` — GET /session/:id/usage 契约（SessionUsageView：current/sub/forked/total 各 Record<string,number>；forked 字段集合 = input_total_tokens/output_total_tokens 等；v0.0.235 forked usage 回归门依据）
- `specs/tech/agent/session/[P0]session_usage.md §8` — SessionUsageView shape 权威（§2 AccumulatedUsage 字段集合）+ §6.1 旁路 run 累计口径（v0.0.204；v0.0.235 起 forked caller 补 notifyUsageChanged）
- `specs/api/overall/11a-squad-endpoints.md §1.1 / §1.3` — POST /squad 事务 + SquadDetail 结构（本版本 doc-modifier 阶段 5 删 summaryModelDefault 字段）
- `specs/tech/agent/context/[P0]context_compact_detail.md §1` — forked 不变量（NO_TOOLS + 纯 directive；本版本 doc-modifier 阶段 5 改 §2b.1/§6.4 描述为「chat/compact 同链」）
- `specs/tech/agent/tools/[P0]tool_policy.md §3.2` — forked enableToolWhitelist=true 路径
- `states/v0.0.158/verify/test-plan.md §改写后 case 断言重点` — 本次改写的 6 项 assertions 权威清单
- `states/v0.0.235/verify/test-plan.md §3 AT` — v0.0.235 forked usage 回归门（compact case 加 forked 断言 / 不新增持久 case）
