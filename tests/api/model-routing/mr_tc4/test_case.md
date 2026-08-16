# mr_tc4 — 路由调用降级链：401 直接熔断 + 降级成功 + open/half_open 呈现

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /provider` + `/provider/:id/model` | 02-llm-chat.md §5.1/§5.3 | 建坏 provider（无效 key）+ 加合法 model |
| `POST /session/:id/run` | 04-agent-session.md §3.2/§7 | 挂载方案后 leader session（modelId=default）发消息走方案链：坏模型 401 → 降级 minimax 成功 |
| `GET /model-routing/plans/:planId/status` | 21-model-routing.md §2.6 | open → abnormal + remainingSeconds（🔴 带倒计时）；half_open → observing 无倒计时（🟡 观察中）；minimax normal（🟢 降级成功未熔断） |

## 断言面（P-C 核心路径，test-plan §3.5）

**401 直接熔断 + 降级链（PRD UC-14/16）**
- 无效 key provider（baseUrl 真实可达 minimax，key=`sk-invalid-mr-tc4-xxx`）→ 请求必然 401 AUTH_INVALID → routingRetryPolicy directOpen → 直接 Open（UC-16）
- 方案 = [坏模型 p1, minimax p2] + `circuit.timeoutSeconds: 30`（方案级覆盖，加速 half_open 可测）
- squad 挂载方案 → leader session 发消息（同步等终态）→ `.state == "idle"`（坏模型 401 快速失败 → bannedModels → 降级 minimax 成功收敛，UC-14 降级链）

**三态呈现映射（PRD UC-18/19 / D16 权威）**
- 调用后立即 GET status：坏模型 `.presentation == "abnormal"` + `.circuitState == "open"` + `.remainingSeconds exists`（🔴 带倒计时）；minimax `.presentation == "normal"`（降级成功未熔断）
- 轮询 status（every 3s / timeout 60s）：30s 到期 → 坏模型 `.circuitState == "half_open"` + `.presentation == "observing"` + `.items[] all .remainingSeconds absent`（🟡 无倒计时）

## 设计权衡

- **无效 key 确定性触发 401**（AUTH_INVALID）——不依赖外部 provider 故障/限流；baseUrl 指向真实 minimax 端点保证出站可达（而非 DNS 失败导致 NETWORK 分类）
- **timeoutSeconds=30 方案级覆盖**（api §3 CircuitConfig 支持）——默认 60s 太久，30s 既保证 open 态可断言（run 后立即查），又 ≤ poll 上限 60 内可等 half_open
- **minimax 正常条目降级成功** = 真调 LLM（minimax 主 provider）；429/529/503 框架层自动 skip 不算 fail
- **半开恢复 Closed 不断言**：坏 key 探测必失败立即回 Open，无法确定性走通恢复路径——由 UT registry 状态机覆盖（UC-20，test-plan §3.1 明确）
- **teardown 完整清理**：解散 squad + 删方案 + 删坏 provider（不污染 test pool）

## 前置依赖

- v0.0.347 `routing_loop.ts`（401 directOpen + bannedModels + 降级）+ `circuit_breaker_registry.ts`（Open→HalfOpen 到期）+ `session-config.ts` 分支 2（挂载查询 + 合成候选链）+ `model-routing-status.ts` 已实现
- test 环境 minimax provider 有真实 key（test.secrets.env）
