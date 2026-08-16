# chat_runtime_config_realtime — 运行中改配置下轮 iteration 生效（黑盒）

> v0.0.351 新增持久 AT case（test-plan §3.1 入选决策：新 LLM 不确定性场景 + 老板拍板核心验收点 + 模块归位 tests/api/chat/）。

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /session` | 04-agent-session.md §2 | 建会话预绑定 provider/model（P-A 前置） |
| `POST /session/:id/messages` | 04 §3.2 | fire-and-forget 202 + runId，保留运行中窗口 |
| `GET /session/:id` | 04 §2 | poll `.state == "running"` 确认窗口 |
| `PUT /session/:id` | 04 §2.5（v0.0.148 effort/approvalMode enum） | 运行中改 providerId/modelId/effort/approvalMode → 200 四字段回显（P-B） |
| SSE `agent_loop` | 04 §4（group `session_id:{sid}_amt:main`，runKind 枚举 main/summary/consolidate；spec `_amt:current` 措辞与代码不符待 doc-sync） | run_end(status=done) + 无 error 帧（新配置未致崩） |
| Langfuse oracle | trace.observations[].model | 后续 generation 用新 model（P-C 生效证据） |

## 断言面（test-plan §1 P-A/B/C）

- **P-B 配置写成功**：PUT 运行中 200，`.modelId == "deepseek-v4-pro"` + `.effort == "high"` + `.approvalMode == "greenlight"` + `.providerId` 回显
- **P-C 新配置真实生效**（oracle 主断言）：trace `.observations[] any .model == "deepseek-v4-pro"`（第二轮 callLLM 用切换后模型）——缺 Langfuse 凭证自动 skip，此时生效面由 UT 白盒（run-react-loop iteration 边界）主承载
- **run 完整性**：run_start×1 + run_end(done)×1 + 无 error（配置切换不崩 run）

## 设计要点（vs test-plan §3.2 规格的 3 处修正，均有框架实证）

1. **step2 `run` 原语 → `POST /messages` 202 + poll**：`run` 同步等终态会堵死「运行中改配置」窗口（step_exec._do_run 语义）；照 agent_spawn_sync 先例（fire-and-forget + sse 订阅 + wait 终态）
2. **PUT 补 providerId 同改**：切换目标模型挂在另一 provider 下，只改 modelId 会在原 provider 上解析不到 → client 重建失败风险；test-plan 规格的字面执行会引入非目标故障面
3. **oracle 断 `.model`**：langfuse generation 标准 model 字段；effort 无标准 trace 字段（不可断言），effort 生效由 UT 白盒覆盖（test-plan P-C 的 effort 面归 UT，与「oracle skip 时 UT 主承载」同款归位）
4. **占位符硬编码**：框架 `{var}` 仅支持 save 变量插值（无 env 注入机制，interp.py 实证）→ provider/model 写字面量（mr_tc1 先例注释同口径）。**切换目标选型（复跑 FAIL 后 provider 池实测，2026-08-15）**：deepseek/deepseek-v4-pro 是唯一确定性可用备选——volcengine CodingPlan 订阅过期出站 400（test.env 注释+复跑实证）、glm provider enabled=false、minimax 内无第二个 enabled model
5. **wait 带 status=done 过滤**：run_end running 帧误计防御（W3 陷阱）

## 前置依赖

- v0.0.351 T1（iteration 边界刷新配置）+ T2（运行中 PUT 通道）已实施（3a3faeb14 / 5c181b9fe + 3b405164e）
- test 环境 minimax（初始）+ deepseek（切换目标）provider 真实可用（provider 池实测 enabled+真 key）；Langfuse oracle 凭证可选（缺则 skip）

## 执行

`CASES=chat_runtime_config_realtime bash tests/api/lib/run_all.sh`（executor 职责；AT/ET 严禁并发）
