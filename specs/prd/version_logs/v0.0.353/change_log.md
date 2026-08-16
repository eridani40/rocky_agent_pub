# v0.0.353 change_log：模型路由调用链路正确性

> 版本：v0.0.353（主仓 dev1@9aba386b0）
> 工作树：`worktrees/v0.0.353-model-routing-trace-correctness`
> 拍板：老板 2026-08-15 09:12-09:13（timeCondition 时区 + Langfuse 真实记录）/ 13:50（逻辑/物理两层语义）/ 14:32（T4 根治：调用现场注入 modelId）
> 契约：`specs/tech/version_logs/v0.0.353/model-routing-trace-correctness/change_plan.md`
> 状态：UT/AT/review 全绿，合并前 doc 同步

## 需求与决策摘要

| 决策 | 内容 |
|---|---|
| D1 | TimeCondition 增加 `timezone?` 字段；缺省 `Asia/Shanghai`；非法 IANA 硬拒 400 |
| D2 | routing_loop 时间过滤按条目 `timeCondition.timezone ?? 'Asia/Shanghai'` 取当前小时 |
| D3 | session 显式 model 继承方案内同 providerId+modelId 启用条目中首个带 timeCondition 者 |
| D4 | physical generation 记录真实 target（providerId/providerName/modelId） |
| D5 | logical generation A1 治理：providerId/providerName 显式 null + `logicalView: true` |
| D6 | observability 类型扩展 GenStart/GenMetadata/TraceMetadata provider 字段 |
| D7 | T4 根治：调用现场注入当前 target modelId；`buildRequest` 不再内部重写；分支 2 SessionConfig.modelId 取 sessionPersist 口径 |
| D8 | logical gen 记录生效路由方案：`SessionConfig.modelRoutingPlan.planName` + `routingPlan` 全链透传 |
| D9 | 被跳过候选逐条记录：`recordSkippedCandidate` 成对 gen `llm-{N}-skip-{M}`，metadata.skipped/reason |

## 实现核对表

| 任务 | commit | 状态 | 关键文件 | 验收 |
|---|---|---|---|---|
| T1 时区调度生效 | `fe74746b0` | review PASSED (`4df77b84f`) | `model-routing-validation.ts` + `routing_loop.ts` + `session-config.ts` | TimeCondition.timezone、timezoneNow mock、显式 model 继承 timeCondition；定向 67/67 + tsc 0 |
| T2 physical 真实 provider/model 记录 | `cd13dcb48` | review PASSED (`ea525eaf7`) | `observability/types.ts` + `langfuse-adapter.ts` + `llm_caller.ts` + `routing_loop.ts` + `langfuse_observability_port.ts` | `recordAttemptTarget` + physical gen 真实 model；60/60 + tsc 0 |
| T3 logical A1 治理 + 回归 | `608e3c556` | review PASSED (`a081b3dea`) | `agent-loop-observability.ts` + `build-run-deps.ts` + tests | logicalView=true/providerId=null/providerName=null；77/77 + tsc 0 |
| T4 根治版 wire model 现场注入 | `5cad1bc0f` | review PASSED (`2d0b4d9ca`) | `session-config.ts` + `build_request.ts` + `llm_caller.ts` + `routing_loop.ts` | 回滚 `258eb6098` 症状修；69/69 + 全量 10771 绿 + tsc 0 |
| T5 Langfuse 逻辑/物理两层语义校准 | `582ef0fde` | review PASSED (`5c73428ee`) | `context-types.ts` + `agent-loop-observability.ts` + `build-run-deps.ts` + `langfuse_observability_port.ts` + `routing_loop.ts` | D8 routingPlan 透传 + D9 6 分支 skip 记录；全量绿 + tsc 0 |
| AT 回归 | `mr_tc5_timezone_schedule` 等 | PASS | `tests/api/cases/llm-chat/` | mr_tc1-5 全绿；mr_tc5 10/10 steps + oracle 9 checks |

## 实现偏离与说明

1. **T4 `buildRequest` 参数保留 `model`**：`buildRequest` 回滚了内部重写 `req.modelId`，但仍接收 `model` 参数用于 capabilities/maxTokens 派生（change_plan 已预见）。
2. **T4 分支 2 modelId 为空串显示**：`sessionPersist.modelId` 为空时 `SessionConfig.modelId = ''`，这是「不预选」语义的一部分；UI display 如需默认模型名应在调用前由 display 层决定，不写入 `SessionConfig.modelId`（T4 review 知悉项）。
3. **T5 `recordSkippedCandidate` reason 口径**：6 分支为 `time_window` / `disabled` / `circuit_open` / `banned` / `resolve_failed` / `probe_inflight`；`resolve_failed` 聚合 provider/model/key 缺失场景（change_plan 允许从简）。
4. **T5 `routingPlan` 仅方案路径携带**：分支 1 无方案不传字段，旧 trace 兼容零行为变化。

## 测试结果

- **UT**：T1 定向 67/67；T2 定向 60/60；T3 定向 77/77 + agent-loop-observability 25/25；T4 定向 69/69；T4 全量 10771 passed / 4 skipped / 0 failed；T5 全量绿；`tsc -b` 0 error。
- **AT**：`mr_tc5_timezone_schedule` PASS（10/10 steps，step 06 黑盒 6 checks + step 07 Langfuse oracle 9 checks）；mr_tc1-4 冒烟回归全绿。
- **ET**：待 e2e-test-executor 执行（task.json T3 列 AT/ET 由对应 mate 执行；task-board AT 已 PASS，ET 状态未显式标注）。

## 关键文件变更

### 产品代码
- `app/server/src/services/model-routing-validation.ts`：TimeCondition.timezone + 校验
- `app/server/src/llm/caller/routing_loop.ts`：时区过滤 + recordAttemptTarget + recordSkippedCandidate 6 分支 + T4 调用点 modelId 注入
- `app/server/src/handlers/session-config.ts`：显式 model 继承 timeCondition + planName 透传 + T4 取消预选污染
- `app/server/src/llm/caller/llm_caller.ts`：recordAttemptTarget + T4 branch-1 modelId 注入
- `app/server/src/llm/caller/build_request.ts`：回滚 `258eb6098` 症状修
- `app/server/src/llm/caller/langfuse_observability_port.ts`：physical gen 真实 target + recordSkippedCandidate + routingPlan 对称
- `app/server/src/observability/types.ts`：GenStart/GenMetadata/TraceMetadata 字段扩展
- `app/server/src/observability/langfuse-adapter.ts` / `langfuse-metadata.ts`：metadata provider/routingPlan 写入
- `app/server/src/agent/agent-loop-observability.ts` / `build-run-deps.ts` / `context-types.ts` / `loop-stage-llm.ts`：logical gen routingPlan + A1 治理

### 测试
- `app/server/src/llm/caller/__tests__/routing_loop.test.ts`：时区 + skip 分支 + wire body 跟随 candidate
- `app/server/src/llm/caller/__tests__/llm_caller.test.ts`：recordAttemptTarget + branch-1 modelId 注入
- `app/server/src/llm/caller/__tests__/build_request_model.test.ts`：buildRequest 不修改 modelId
- `app/server/src/handlers/__tests__/session-config-model-routing.test.ts`：分支 2 modelId 取 sessionPersist 口径
- `app/server/src/observability/__tests__/langfuse-adapter.test.ts`：metadata provider
- `app/server/src/llm/caller/__tests__/langfuse-observability-port-t2.test.ts`：physical gen + skip gen 断言
- `app/server/src/agent/__tests__/agent-loop-observability.test.ts`：logicalView + routingPlan 断言
- `app/server/src/llm/caller/__tests__/routing_loop_timezone.test.ts`：timezone 过滤
- `app/server/src/services/__tests__/model-routing-validation.test.ts`：timezone 校验

## 文档同步清单（doc-modifier，本次 commit）

| 文档 | 变更 |
|---|---|
| `specs/tech/agent/providers_and_models/[P0]model_routing.md` | updated→2026-08-15；TimeCondition 结构已同步（T1）；`SessionConfig.modelRoutingPlan` 补 `planName?`（T5 D8）；§5 wire body 一致性段改写为 T4 根治版（调用现场注入，buildRequest 信任 caller）；observability 语义段补 routingPlan + skipped gen 说明 |
| `specs/tech/agent/observability/[P0]observability_interface.md` | updated→2026-08-15；GenStart 补 `routingPlan?`；GenMetadata 补 `routingPlan?`/`skipped?`/`skipReason?`；TraceMetadata 补 `routingPlan?` |
| `specs/tech/agent/llm_caller/[P0]llm_caller.md` | `ObservabilityPort` 注释补 `recordAttemptTarget` / `recordSkippedCandidate` |
| `specs/tech/agent/providers_and_models/log.md` | 加 2026-08-15 · v0.0.353 条目 |
| `specs/tech/agent/observability/log.md` | 加 2026-08-15 · v0.0.353 条目 |
| `states/v0.0.353/task-board.md` | Check 补 doc-modifier 完成标记 |
| `specs/prd/version_logs/v0.0.353/change_log.md` | 新建（本文档） |

> T4/T5 代码已实现 `recordSkippedCandidate` 和 `recordAttemptTarget`，本次 spec 同步已补入口注释；完整实现语义以 change_plan §7/§8 及代码为准。
