# v0.0.353 tech change_log：模型路由调用链路正确性

> 版本：v0.0.353
> 工作树：`worktrees/v0.0.353-model-routing-trace-correctness`
> 派单：Darvin leader · 老板 09:12-09:13 / 13:50 / 14:32 拍板
> 完整版本叙事：`specs/prd/version_logs/v0.0.353/change_log.md`

## 架构期决策 → 实现核对

| 决策 | 实现 | 偏差 |
|---|---|---|
| D1 TimeCondition.timezone | `model-routing-validation.ts` + 校验 | 无 |
| D2 routing_loop 按 timezone 取小时 | `routing_loop.ts` `timezoneNow` 优先；`localHour` 兼容兜底 | 无 |
| D3 显式 model 继承 timeCondition | `session-config.ts` `resolveModelRoutingPlan` 合成 priority 0 条目时继承 | 无 |
| D4 physical 真实 target | `recordAttemptTarget` + `langfuse_observability_port.ts` 真实 model | 无 |
| D5 logical A1 治理 | `agent-loop-observability.ts` `logicalView=true/providerId=null/providerName=null` | 无 |
| D6 observability 类型扩展 | `observability/types.ts` GenStart/GenMetadata/TraceMetadata +provider 字段 | 无 |
| D7 T4 根治：调用现场注入 modelId | `routing_loop.ts` + `llm_caller.ts` 注入；`build_request.ts` 回滚重写；`session-config.ts` 取 sessionPersist | 无 |
| D8 logical gen 记录 routingPlan | `context-types.ts` + `session-config.ts` + `build-run-deps.ts` + `agent-loop-observability.ts` + `langfuse-adapter.ts` + `langfuse_observability_port.ts` | 无 |
| D9 recordSkippedCandidate | `langfuse_observability_port.ts` 实现 + `routing_loop.ts` 6 分支调用 | 无 |

## 关键代码路径

- `app/server/src/services/model-routing-validation.ts`：TimeCondition 结构 + IANA 校验
- `app/server/src/llm/caller/routing_loop.ts`：时区过滤、recordAttemptTarget、recordSkippedCandidate、T4 modelId 注入
- `app/server/src/handlers/session-config.ts`：resolveModelRoutingPlan（timeCondition 继承 + planName 透传 + T4 取消预选污染）
- `app/server/src/llm/caller/llm_caller.ts`：recordAttemptTarget + branch-1 modelId 注入
- `app/server/src/llm/caller/build_request.ts`：回滚 `258eb6098` 症状修
- `app/server/src/llm/caller/langfuse_observability_port.ts`：physical gen 真实 target + skipped gen 成对记录
- `app/server/src/observability/types.ts` / `langfuse-adapter.ts` / `langfuse-metadata.ts`：类型扩展 + 字段写入
- `app/server/src/agent/agent-loop-observability.ts` / `build-run-deps.ts` / `context-types.ts` / `loop-stage-llm.ts`：logical gen routingPlan + A1

## 文档同步记录

| 文件 | 同步内容 |
|---|---|
| `specs/tech/agent/providers_and_models/[P0]model_routing.md` | TimeCondition 字段（T1 已同步）、SessionConfig.modelRoutingPlan.planName（T5 D8）、§5 wire body 一致性 T4 根治版、observability 语义 T5 |
| `specs/tech/agent/observability/[P0]observability_interface.md` | GenStart/GenMetadata routingPlan/skipped/skipReason；TraceMetadata routingPlan |
| `specs/tech/agent/llm_caller/[P0]llm_caller.md` | ObservabilityPort 注释补 recordAttemptTarget/recordSkippedCandidate |
| `specs/tech/agent/providers_and_models/log.md` | 2026-08-15 · v0.0.353 条目 |
| `specs/tech/agent/observability/log.md` | 2026-08-15 · v0.0.353 条目 |
| `specs/prd/version_logs/v0.0.353/change_log.md` | 新建版本叙事 |
| `states/v0.0.353/task-board.md` | Check 补 doc-modifier 完成 |

## 测试结果

- UT 全量绿（10771 passed / 4 skipped / 0 failed at T4；T5 全量绿）；tsc -b 0。
- AT mr_tc1-5 全绿；mr_tc5 step 07 oracle 9 checks 通过（physical 真实 provider/model + logical routingPlan + skipped gen）。
