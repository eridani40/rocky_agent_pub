# v0.0.359 变更计划书 — squad 用量统计归属修复：记实际命中 physical model

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 0. 需求与口径（老板 2026-08-15 18:29 拍板）

**需求**：squad 用量统计（token_usage_stat）应记在「调用成功那一下」对应的 item 模型上（解法 2：记实际命中 physical model），而非配置侧三级 fallback 推测。

**根因**（BUG-TOKEN-USAGE-PLAN-FALLBACK，states/v0.0.357/bugs/）：subscriber model 解析 = session → squad.modelDefault → `__unknown__` 三级配置侧 fallback。studio squad 挂路由方案（T6 互斥清空 modelDefault）+ session 未显式选模型 → 两级全空 → 统计落 `__unknown__`。实际调用走方案候选链（routing_attempt_loop），统计口径与实际行为脱节。

## 1. 方案设计（为什么不是「方案反查/记首候选」也不是「寄生 recordAttemptTarget」）

### 1.1 数据源判定（关键架构决策）

v0.0.353 D4 已落地的 `recordAttemptTarget`（llm_caller.ts:298 / routing_loop.ts:250）**不是可用数据源**：
- 它挂在 `ObservabilityPort`（`ctx.observability?.recordAttemptTarget?.(...)`）——langfuse observability 可选端口，仅 `AgentLoopObservability` 一个实现；
- observability 是「开 langfuse 才有」的可选链路（`startAgentTrace` 失败/未启用 → 端口缺席），统计归属挂它上面 = langfuse 关闭时统计口径回退到坏值；
- 职责污染：observability 是旁路观测（失败绝不影响主流程），usage 统计是业务正路数据，不能寄生。

**正解**：独立「进程级成功 target registry」——llm_caller 两个成功 return 点直接调 registry setter（与 observability 平行的另一条线，无条件执行），subscriber 在解析 model 归属时优先读它。同 `CircuitBreakerRegistry` 的 globalThis 单例范式（llm/caller/circuit_breaker_registry.ts:66 起，与 ProviderHealthRegistry 同模式）。

### 1.2 写入点（两处，恰好 = 「调用成功那一下」）

| 分支 | 文件 | 位置 | 时机 |
|---|---|---|---|
| 分支 1（无方案，attemptLoop） | llm_caller.ts | `result.kind === 'ok'` 分支内（L336 return 前） | 内层 attempt 成功 |
| 分支 2（有方案，routing_attempt_loop） | routing_loop.ts | `result.kind === 'ok'` 分支内（L287 return 前） | 候选链某候选 attempt 成功 |

写 `recordSuccessTarget(sessionId, { providerId, providerName?, modelId })`。sessionId 从 `ctx.sessionId`（InvokeContext 已有，分支 2 需在签名补传或从 ctx 读）。**只在成功点写**：失败/abort/max_tokens 不写（保持上一次成功值——usage 只在成功后累计，语义自洽）。

### 1.3 消费点（subscriber model 解析改造）

subscriber（token-usage-subscriber.ts onUsageNotify）model 归属解析改为**优先级链**：
1. `registry.getSuccessTarget(sid)`（运行时真实命中）← 新增，最高优先
2. session 显式 providerId/modelId
3. squad.modelDefault / modelDefaultProviderId
4. `__unknown__`

理由：registry 覆盖一切「实际调用过的 session」（分支 1+2 全部成功点都写）；session/squad fallback 仅在 registry 无记录（如进程重启后、旧 session 补记、测试注入路径）时兜底——旧三级 fallback 完整保留，**零回归风险**。

### 1.4 边界与不变量

- **多模型混跑 session**（方案候选链跨模型 failover 成功）：registry 只存「最后一次成功」，本轮 delta 归最后成功模型。极小概率误差（跨模型 failover 同轮分摊），可接受（老板口径=「调用成功那一下」，单次成功调用天然单模型；跨次多模型已按 hour 桶各自累计，无交叉污染）。
- **内存**：`Map<sessionId, {providerId, providerName, modelId, at}>`，每 session ~100B，1k session ~100KB，无需淘汰（进程生命周期；重启即清，与 lastSeen 同命运，语义一致）。
- **崩溃安全**：registry 是纯内存运行态，不落盘。重启后失效 → subscriber fallback 到旧三级（记 session/squad 配置值）——与现状一致，不劣化。
- **subagent**：usage 递归上报 parent，subscriber 本就跳过 subagent session；subagent 的成功 target 记在 subagent sid 键下，不污染 parent 归属（getSuccessTarget 按 sid 精确查）。
- **playground / 非 squad session**：subscriber 现逻辑不变（无 squadId/memberId 跳过）；registry 照写不碍事（写入点在 llm_caller，与 session 类型无关）。
- **MUST NOT**：不动 `SessionUsageView` / `SessionUsageUpdateEvent` 负载（事件形状不变）；不动 `accumulateUsage`/`notifyUsageChanged` 链路；不动 langfuse observability 端口；不动 `recordAttemptTarget`（它继续服务 physical generation）。

## 2. 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm-caller | app/server/src/llm/caller/success-target-registry.ts | class SuccessTargetRegistry + getCircuitBreakerRegistry 同款 globalThis holder | 新增 | 进程级成功 target 注册表：`recordSuccessTarget(sessionId, {providerId, providerName?, modelId})` 写入 / `getSuccessTarget(sessionId)` 读取 / `__resetSuccessTargetRegistryForTest()`。Map<sid, target>，无淘汰、无落盘 | MUST：与 CircuitBreakerRegistry 同 globalThis 单例范式；MUST NOT：不持久化、不挂 ObservabilityPort | circuit_breaker_registry.ts:66-330 范式 | +90 |
| llm-caller | app/server/src/llm/caller/llm_caller.ts | invoke 内层 attemptLoop 成功分支 | 修改 | `result.kind === 'ok'` 分支 return 前：`ctx.sessionId` 存在时调 `recordSuccessTarget(ctx.sessionId, {providerId: target.providerId, providerName: target.provider.name, modelId: target.model.modelId})` | MUST：fire-and-forget 同步调用（Map.set 无异常面）；MUST NOT：不包 observability 可选链 | 本表 §1.2 | +6 |
| llm-caller | app/server/src/llm/caller/routing_loop.ts | routing_attempt_loop 候选成功分支 | 修改 | `result.kind === 'ok'` 分支 return 前：同上 recordSuccessTarget（分支 2 ctx.sessionId 已可达；若签名未带则从 ctx 透传补字段） | MUST：与分支 1 同款写入；MUST NOT：不改候选决策/skip/熔断逻辑 | 本表 §1.2 | +6 |
| squad-token-usage | app/server/src/squad/token-usage/token-usage-subscriber.ts | onUsageNotify（model 归属解析段 L140-154） | 修改 | model 归属优先级链插头：先 `getSuccessTarget(sid)` 命中 → 直接用其 providerId/modelId（providerName 不进 stat）；miss → 现有三级 fallback 原样保留 | MUST：registry 读失败不抛（Map.get 纯同步）；MUST NOT：不动 delta 计算/hour 桶/upsert/subagent 跳过逻辑 | 本表 §1.3；[P1]token_usage_stat.md §4 | +14 |
| squad-token-usage | app/server/src/squad/token-usage/__tests__/token-usage-subscriber.test.ts | describe TokenUsageSubscriber | 修改 | 新增用例：①registry 命中 → 记真实 target（session/squad 配置不覆盖）；②registry miss + session 显式 → 现行为；③registry miss 全空 → `__unknown__`（回归）；④subagent 仍跳过（回归） | MUST：每例独立 reset registry（afterEach） | 既有测试面 | +40 |
| llm-caller | app/server/src/llm/caller/__tests__/llm_caller.test.ts | describe（分支 1 ok 路径） | 修改 | 新增用例：attemptLoop ok → recordSuccessTarget 以 ctx.sessionId + 真实 target 写入 | MUST：断言 registry 内容非 observability mock | 既有测试面 | +15 |
| llm-caller | app/server/src/llm/caller/__tests__/routing_loop.test.ts | describe（ok 路径） | 修改 | 新增用例：候选链 ok → 该候选 target 写入 registry | 同上 | 既有测试面 | +15 |

## 3. 影响面评估

- **跨模块**：llm/caller（写入侧）→ squad/token-usage（消费侧），经进程级 registry 解耦，无接口改动、无循环依赖（依赖方向：subscriber → registry ← llm_caller，registry 是叶子）。
- **破坏性变更**：无。事件负载、stat 表 schema、查询端点（GET /squad/:id/token-stats）零改动——纯写入侧归属修正。
- **依赖顺序**：T1（registry + 两写入点 + subscriber 消费）单一 task，内部先 registry 后接线。
- **风险点**：①分支 2 ctx.sessionId 可达性（routing_attempt_loop 签名若未透传需补——实现时核实，补字段属透传接线允许范围，需在交付说明标注）；②跨模型 failover 同轮 delta 归属最后成功模型（§1.4 已接受）。
- **验证**：UT 必跑（subscriber + llm_caller + routing_loop 三面）；AT/ET 豁免——纯统计写入侧逻辑、无用户可感知行为变化（token-stats 返回形状不变，仅 modelId 归属值修正），UT 直接断言 statStore.upsertDelta 入参即可覆盖。

## 4. 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
