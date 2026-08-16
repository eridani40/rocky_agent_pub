---
type: spec
title: Model Routing（模型路由降级 — 组合方案 + attempt 内路由 + 三态熔断）
priority: P0
status: active
updated: 2026-08-15
since: v0.0.347
related:
  - "[P0]model_resolve.md"
  - "../llm_caller/[P0]llm_caller.md"
  - "../llm_caller/[P0]provider_health_registry.md"
  - "../llm_caller/[P0]error_normalization.md"
  - "../llm_caller/[P0]retry_and_timeout.md"
  - "../../config/[P0]app_config.md"
---

# Model Routing（模型路由降级）

> 定位：模型组合方案（有序降级链）的定义、存储、挂载，以及「attempt 内逐步决策」的路由循环 + 方案级三态熔断。PRD：`specs/prd/model-routing-PRD-2026-08-14.md`；方案设计 v3.2（D1-D17 全部拍板）：`specs/prd/model-routing-方案设计-2026-08-14.md`。
> 引入版本 v0.0.347。**非目标**：quota 路由 / 熔断持久化 / academy 集成 / session 配方案 / 隐式兜底（PRD §5）。

## 1. 概述

**管什么**：
- 模型组合方案 `ModelRoutingPlan` 数据模型 + 同模型条目约束校验（PRD §2.8）；
- 挂载层级（app 方案库 CRUD / group|playground 挂方案 / session 只能 model|default）；
- `resolve` 双分支（无方案 → 现有单模型零改动；有方案 → 候选链 + priority 0 合成）；
- **attempt 内路由循环**（时间过滤 → enabled → 熔断 → banned 去重 → 调用 → 失败决策 → 降级）；
- **三态熔断状态机**（方案级三维隔离，运行时内存态）+ 差异化重试策略（PRD §2.6/§2.7）。

**不管什么**：LlmClient 4 件套（不可变，不动）；错误归一化（`[P0]error_normalization.md`，复用 classify）；per-session health（`[P0]provider_health_registry.md`，分层共存不替换）；时间控件 UI 组件实现（→ `specs/ui/components/app-dev-config-page/`）；HTTP 端点契约（→ `specs/api/overall/21-model-routing.md`）。

## 2. 数据模型（Config 静态定义）

### 2.1 ModelRoutingPlan（方案库实体）

```typescript
interface ModelRoutingPlan {
  id: string;             // planId（= app_config model_routing_plans group 的 record key）
  name: string;           // 可命名实体（如「主力+兜底」）；group 挂载引用
  items: RoutingItem[];   // 有序降级链（priority 升序 = 尝试顺序）
  circuit?: CircuitConfig; // 熔断参数覆盖（可选，缺省用默认值）
  createdAt: number;
}

interface RoutingItem {
  providerId: string;     // 指向 app_config providers 实例（ModelRef 复合防同名跨 provider 歧义）
  modelId: string;
  priority: number;       // 1 = 最高优先（尝试顺序 = priority 升序）
  timeCondition?: TimeCondition; // 可选；不配置 = 随时可用（无条件条目）
  enabled: boolean;       // 启用/停用开关（老板 11:16 ①），默认 true；停用 = 保留配置但路由直接跳过
}

interface TimeCondition {
  hours: number[];        // 0-23 白名单；条件时区当前小时 ∈ hours → 可用；否则跳过
  timezone?: string;      // [v0.0.353 T1] 合法 IANA 字符串（"Asia/Shanghai"/"UTC"/…）；缺省 Asia/Shanghai（向后兼容，禁默认 UTC）；非法硬拒 400
}

interface CircuitConfig {  // 方案级熔断参数覆盖（UI 高级区）；缺省用 §6 默认值
  failureThreshold?: number;    // 连续失败打开阈值，默认 4
  successThreshold?: number;    // 半开恢复成功数，默认 2
  timeoutSeconds?: number;      // Open 后恢复等待秒，默认 60
  errorRateThreshold?: number;  // 窗口错误率阈值 0-1，默认 0.6
  minRequests?: number;         // 窗口内最小有效样本数（样本不足时错误率轨道沉默），默认 10
  windowSize?: number;          // 错误率滑动窗口大小（最近 N 次请求），默认 20（[v0.0.347增量] 老板 2026-08-14 拍板；UI 暂不暴露）
}
```

### 2.2 挂载字段（Config 的一部分，跨 call 存活）

| 层级 | 字段 | 存储 |
|---|---|---|
| app 方案库 | `model_routing_plans` group（key=planId） | app_config（§8） |
| playground 挂载 | `model_routing` group key=default → `{ playgroundPlanId?: string }` | app_config（§8） |
| studio squad 挂载 | `squad.modelRoutingPlanId?: string`（schema `required:false`，PATCH `!== undefined` 才写） | squad entity |
| session | 只能 model/default（**不能配方案**） | 现有 session 字段 |

**挂载语义**：`squad.modelRoutingPlanId` / `playgroundPlanId` 指向方案库某 planId；指向不存在/被删方案 → 视为未挂载（回退默认模型，删除方案时自动解除引用，见 §8.3）。

**二选一严格互斥（T6 修正，老板 22:22 拍板「必须只保留一个有效的」）**：group/playground 配置入口为**单 select**（上组「模型」/下组「方案」）。**双向清**：选模型清挂载、选方案清默认模型——任意时刻挂载与默认模型**至多一个有值**（非法状态不可表示）。squad PATCH 后端加双非空 reject（400，api §2.5）；playground 两字段异 group 异 record，单 PUT 天然无法双写。写入顺序=**先清后写**（崩溃安全：中断落双空合法态，永不落双设非法态）。存量双设不迁移：resolve 方案优先兼容、UI 方案优先呈现、触碰收敛；deletePlan 解挂兜底。resolve 双分支逻辑零变化。回退链：方案删除 → 解挂 → 分支 1 → session 显式模型 → 未设置态 400 引导（chat/compact 同链同走，`build_invoke_context` L181 无条件透传 routingPlan——挂方案时 compact 同走方案链，无断链风险）。

### 2.3 同模型条目约束（PRD §2.8，保存硬拒绝）

按 **(providerId, modelId)** 分组校验（按「启用」条目统计，停用不占额度）：
1. 同模型**最多 2 条**（1 带时间 + 1 不带时间）；
2. **不允许 2 带时间** / **不允许 2 不带时间** → 硬拒绝（明确提示）；
3. **带时间条目必须排在不带时间条目上面** → 违反硬拒绝（提示「带时间条目必须在不带时间条目上面」）。

校验时机：① PUT 方案时服务端静态校验（400 + 提示）；② 路由求值时运行时防御（发现违规纠正/告警，不静默兜底）。

## 3. Config / State 分离（架构基石，D13）

| 维度 | 内容 | 生命周期 | 特性 |
|---|---|---|---|
| **Config** | 方案实体（items + 时间条件 + 熔断参数）+ **熔断状态**（CircuitBreakerRegistry，planId+providerId+modelId 三维） | **跨 call 存活**（方案维度共享） | 静态可查询；熔断 = 运行时内存态（**不持久化**，重启丢失可接受） |
| **State** | **agent loop 对「这一次 llm call」的状态**——候选处置轨迹（调过谁/失败/放弃/跳过 + 原因 + 尝试次数 + 退避截止 + 游标 + bannedModels） | **call 级瞬时**（不落盘，call 结束即弃） | 每次 llm call 独立生命周期 |

**决策公式**：`下一步调谁 / sleep 多久 = f(config, state)`——config 跨 call（方案 + 熔断）、state 仅本次 call；config 一定 + state 一定 → 结果确定（可复现，无隐藏随机）。对 agent 透明（attempt 内部收敛）。

### 3.1 AttemptState（D14：放弃/熔断挂钩「模型配置」维度）

```typescript
interface AttemptState {
  tried: CandidateRecord[];   // 已处置候选轨迹
  cursor: number;             // 当前尝试到候选列表哪个位置
  bannedModels: Set<string>;  // 本次 call 内被放弃/熔断的模型配置（key = `${providerId}|${modelId}`）
}

interface CandidateRecord {
  item: RoutingItem;
  status: 'called' | 'failed' | 'abandoned' | 'skipped';  // 调过/失败了/放弃了/跳过了
  error?: ClassifiedLlmError;  // 失败原因（错误分类）
  attemptCount?: number;       // 模型内尝试次数
  sleepUntil?: number;         // 退避等待截止（429/限流时）
}
```

**去重键 = 模型配置（providerId+modelId），不是 item**：同一模型在一次 attempt 内可能以多个 item 出现（session 合成 + 带时间 + 无条件）；一旦该模型配置被**放弃（abandoned）**或**熔断（Open）** → 加入 `bannedModels`，本次 attempt 内后续所有该模型 item 全部 skipped。

| status | 语义 | 触发 |
|---|---|---|
| called | 发起了调用（成功或失败都算） | 候选被选中发起 LLM 调用 |
| failed | 调用失败（记录原因分类 → 决定下一步） | 调用返回错误 |
| abandoned | 放弃了（不重试、不降级到它） | 401/403 直接熔断放弃、429 快速失败放弃 |
| skipped | 跳过了（不尝试） | 时间过滤未命中 / enabled=false / 熔断 Open / bannedModels 命中 |

## 4. resolve 双分支（D11/D12）

```
resolve(session, group):
  ├─ group 无挂载方案 → 分支 1：现有单模型逻辑（resolveModel 原链，零改动）
  └─ group 有挂载方案 → 分支 2：读方案实体 → 合成候选链
       ├─ session.modelId == 'default'/'none'/undefined → 候选链 = 方案 items（priority 升序）
       └─ session 显式配了模型 → [session 模型(priority 0)] + 方案 items（临时合成，不写回方案实体；
            熔断键 = planId + session 模型，享受方案熔断控制；
            [v0.0.353 T1 D3] 显式条目继承方案内同 providerId+modelId 启用条目中首个带
            timeCondition 者的时间条件——显式指定 ≠ 绕过调度时间窗；无匹配 → 全天）
```

- **落点**：`buildSessionConfigFromDeps`（`handlers/session-config.ts`）每次 run 现拉——先查挂载（squad.modelRoutingPlanId / playground app_config model_routing）：
  - 有挂载 → 读方案实体（app_config model_routing_plans）+ 判定 session.modelId 合成 → 产出 `SessionConfig.modelRoutingPlan`（含 planId + 合成后候选链 + 生效熔断参数）→ **不再走 resolveModel 单模型**（方案优先，不隐式兜底 D4）；
  - 无挂载 → 现有 resolveModel 原链（零改动）。
- **academy 排除（v0.0.347 Major-2 修复）**：`resolveModelRoutingPlan(deps, sessionPersist, isStudio, studioContext, isAcademy = false)`——`isAcademy` 由调用处传 `isAcademySessionKind(kind)`（`academy/academy-context.ts`）；academy 会话（biz==='academy' 或 academy 角色）**直接返回 undefined 走分支 1**，防止误走 playground 挂载绕过 classroom 三档模型链（academy 集成 = 非目标）。
- **分支 2 client 组装**：`buildSessionConfigFromDeps` 调 `buildClientFromCandidates(deps, items)` 按候选链依次 `buildLlmClient(providerId, modelId, appConfig, pluginManager)` 取首可用候选（`SessionConfig.modelId` 显示用）；方案校验（T1）保证 items 指向 enabled provider 的 enabled model，正常首候选即成功；循环防御运行时 provider 被删/模型被禁（该候选在 routing 也会被跳过）。
- **候选为空/全不可用**：不 fallback 单模型（D4）——运行时报「当前无可用模型」/「所有候选模型不可用」（含失败摘要）。
- **[v0.0.349] 全 dangling 降级（provider 被删）**：挂载方案**所有候选**在 client 组装段即不可用（provider 已删 → buildLlmClient 全 throw）→ caller 段 try/catch 降级 throw `ModelNotConfiguredError`（message 区分「方案内所有模型不可用」，与分支 1 跑空同时机同构，HTTP 400 MODEL_NOT_CONFIGURED）；MUST NOT 静默回退默认模型（D11）。部分候选可组装 → 既有循环取首可用（零改动）；routing_loop 内单候选 dangling 由既有防御跳过（构建 target 时 provider/model/key 拿不到即 continue）。dangling 双语义（runtime 跳过 + 编辑拦保存）权威：api spec `21-model-routing.md §2.7`。
- **SessionConfig 扩展**：

```typescript
interface SessionConfig {
  // ...现有字段
  modelRoutingPlan?: {          // 分支 2 才有；分支 1 = undefined（invoke 走现有路径）
    planId: string;
    planName?: string;          // [v0.0.353 T5 D8] 方案实体名；logical gen metadata 记「当时生效方案」用
    items: RoutingItem[];       // 合成后的候选链（session 显式模型已 priority 0 插入；default = 方案 items）
    circuit: CircuitConfig;     // 生效参数（默认值填充后）
  };
}
```

## 5. attempt 内路由循环（D12 核心）

**invoke 改造**：`llm_caller.invoke` 的 `ctx` 增加 `routingPlan?`；`invokeCore` 检测到 `routingPlan` → 走**新路由循环**（`llm/caller/routing_loop.ts`），否则走现有 attemptLoop（零改动）。路由循环内**复用现有 attemptLoop 单次调用**（看门狗 + classify + buildRequest overlay 全保留），在其上层做候选决策：

> **wire body 一致性（v0.0.353 T4，BUG-mr-tc5-step05）**：路由循环切 client 后 wire body 的 `model` 字段必须跟随当前候选 target。根治版（commit `5cad1bc0f`，回滚 `258eb6098` 症状修）：**`buildRequest` 不再内部重写 `req.modelId`**，改为由调用现场在 `buildRequest` 调用前注入当前 target modelId——`routing_loop.ts` 每次进入 `attemptLoop` 前 `baseReq = { ...baseReq, modelId: model.modelId }`；`llm_caller.ts` branch-1 非路由路径同样 `baseReq = { ...baseReq, modelId: target.model.modelId }`。分支 2 的 `SessionConfig.modelId/providerId` 取 `sessionPersist` 口径（不再取首候选），彻底消除 run 启动前预选污染。修复前 baseReq.model 停留在 SessionConfig.modelId 快照（首可组装候选），跨模型回退时目标端点收到错误模型名 → 400 NO_RETRY → 候选耗尽「所有候选模型不可用」。

> **observability 语义（v0.0.353 T5，老板 13:50 拍板）**：logical generation = 调用意图（metadata.routingPlan 记当时生效方案 planId+planName，model 字段仅 session 口径补充）；physical = 每次 attempt（T2 真实 target）；被跳过候选（时间窗/enabled/熔断/banned/resolve 失败/probe 在途）经 `recordSkippedCandidate` 逐条记录成对 gen（`llm-{N}-skip-{M}`，metadata.skipped=true + reason），排障一眼看清谁被跳谁真调。

> **装配链（v0.0.347 集成回归修复）**：多候选模型需按 (providerId, modelId) 真实组装 client——`buildInvokeContext` 的 `clientFactory.getClient` 双分支：`input.clientBuilder` 存在 → 调 `clientBuilder(provider.id, model.modelId)` 真实构造（`loop-stage-llm` 在 `config.modelRoutingPlan` 存在时**条件注入** `buildLlmClient(providerId, modelId, config.appConfig, config.pluginManager)`）；无 clientBuilder（= 无 routingPlan，分支 1 / 测试 mock）→ **占位回退恒返回 `input.client`**（与 T2 前行为逐字节等价）。装配链：`agent-loop-base.CallLLMInput.routingPlan/clientBuilder`（可选）→ `agent-loop-call-via-invoker` buildInvokeContext 透传 → `loop-stage-llm` 从 `config.modelRoutingPlan` 注入。无 routingPlan 时 clientBuilder 键不存在 → 零影响。

```
routingAttemptLoop(plan, config, state):
  while (state.cursor < plan.items.length):
    item = plan.items[state.cursor]
    // ① 时间过滤：当前小时 ∉ hours（带条件条目）→ skipped（不入候选/不消耗尝试/不计熔断失败）
    // ② enabled 检查：item.enabled == false → skipped（同①语义）
    // ③ 熔断检查：CircuitBreakerRegistry(planId, providerId, modelId).state == Open → skipped + bannedModels.add
    // ④ bannedModels 检查：item 的 providerId+modelId ∈ bannedModels → skipped
    // ⑤ 发起调用：attemptLoop（看门狗 + classify）→ 模型内重试 N 次（差异化表 §7）
    //    成功 → recordSuccess + 熔断 recordSuccess + recordSuccessTarget(该候选 target，用量统计归属) → 返回
    //    失败 → record failure（熔断 escalate）→ 按 §7 决策：
    //          AUTH → 直接 Open + abandoned + bannedModels.add → 下一个候选
    //          其余 → 计失败达阈值 Open；模型内重试耗尽 → abandoned + bannedModels.add → 下一个候选
    //    用户 abort → 不算失败，直接返回
    state.cursor++
  // ⑥ 循环耗尽：
  //    候选为空（时间过滤后无可用）→ throw「当前无可用模型」（引导检查时间条件）
  //    全部失败/熔断 → throw「所有候选模型不可用」（含各条目失败原因摘要）
```

**关键语义**：
- 时间过滤/enabled 是路由**第一步**：不满足的条目完全不参与（不消耗尝试、不计熔断失败）；
- **熔断 Open → 跳过 + 入 bannedModels**（该模型配置本次 call 内不再出现）；abandoned 同步入 bannedModels（D14）；
- **方案级 circuit 覆盖（v0.0.347 Major-1 修复）**：routing 循环所有 registry 触点（`getState` / `tryAcquirePermit` / `recordSuccess` / `recordFailure`）**一律传第 4 参 `plan.circuit`**——保证 entry 首次创建即用方案 cfg（UI 高级区 5 参数生效，非默认 4/2/60/0.6/10）；registry `entry()` 在 cfg 传入且 entry 已存在时**同步更新 cfg**（方案编辑后新调用自动生效）；
- **模型内重试次数 = 换下一个模型前对同 (provider, model) 的尝试次数**（差异化表 §7）；重试走现有退避 `getRetryDelay`；**换模型降级 0 sleep**（可复现，无随机）；
- 超时沿用现有看门狗（TTFB 45s / stall 30/30/120，D2）；
- 半开探测 = 真实用户请求（限流 1 并发，permit 必须归还，防卡死）。

## 6. 三态熔断（D5/D6/D16）

### 6.1 CircuitBreakerRegistry（方案级三维，运行时内存态）

```
Closed ──(连续失败 ≥ failureThreshold 或 (窗口有效样本 ≥ minRequests 且窗口错误率 ≥ errorRateThreshold) 或直接熔断错误)→ Open
  ▲                                                                                                        │
  │ ◄────────────────────────────────────── HalfOpen ◄───────────(timeoutSeconds 到期)─────────────────────┤
  │        (半开连续成功 ≥ successThreshold)                    │ 限流 1 探测请求；探测失败 → 立即回 Open
```

- **key = (planId, providerId, modelId) 三维**：方案 A 里 Kimi 熔断 ≠ 方案 B 里 Kimi 熔断（方案间隔离）；同一方案多处挂载**共享**熔断状态；同一 session 显式合成模型（priority 0）也用 planId 作键。
- **存储**：进程内存 Map（`globalThis` 或 DI 注入单例），不持久化（重启丢失可接受）。
- **默认参数**（cc-switch 官方默认 + 滑窗增量）：failureThreshold=4 / successThreshold=2 / timeoutSeconds=60 / errorRateThreshold=0.6 / minRequests=10 / windowSize=20（方案级 `circuit` 覆盖，UI 高级区暂不暴露 windowSize）。
- **[v0.0.347 增量] 错误率滑动窗口**（老板 2026-08-14 拍板）：错误率轨道 = **最近 windowSize(默认 20) 次请求**的失败率（环形 buffer 记每结果，O(1) 写入），取代终身累计——修复长跑钝化（老成功稀释新失败）与坏历史粘性（恢复后 1 败即回炉）。窗口有效样本 < minRequests 时错误率轨道沉默（连续失败轨道兜底）；状态转换（Closed→Open→HalfOpen→Closed）**不清窗口**，旧失败随新请求自然滚出——恢复后旧失败滚出前保持警惕（探测成功 ×2 回 Closed 后窗口仍可能触发再 Open，期望语义非 bug）；探测是真实请求，结果照常记窗口。仅 entry 新建（空窗）与方案编辑致生效 windowSize 变化（清空重积累）时重建窗口。校验：windowSize 整数 ∈ [1,1000]；生效值 minRequests ≤ windowSize。
- **与 ProviderHealthRegistry 分层共存**：attempt 循环**先查方案熔断（Config 层）**，再走现有 attemptLoop 内的 session health（per-session 4 态管同 session 重试/冷却）——两层正交，互不替换。

### 6.2 状态呈现映射（D16，UI 权威）

| 内部熔断状态 | 用户呈现 | 说明 |
|---|---|---|
| Closed | 🟢 正常 | 模型可用 |
| Open | 🔴 异常（带倒计时） | 显示 Open 剩余时间（timeoutSeconds 倒计时） |
| HalfOpen | 🟡 观察中（无倒计时） | 半开探测期 |

- 给用户看**状态词**（正常/异常/观察中），不是熔断器词（Closed/Open/HalfOpen）——内部逻辑仍用三态；
- 状态查询端点返回 `circuitState: 'closed'|'open'|'half_open'` + `remainingSeconds?`（Open 时），UI 映射为红绿灯。

## 7. 差异化重试策略（D1，消费 error_normalization 分类）

所有失败**都计入熔断**（失败计数 +1，ABORTED_BY_USER 除外）；同一模型配置内尝试几次按错误类型不同：

| 错误类别（LlmErrorCategory） | 模型内重试次数 | 熔断行为 |
|---|---|---|
| RATE_LIMITED(429) / PROVIDER_OVERLOADED(529) | 0（快速失败直接降级） | 计失败；达阈值 → Open |
| NETWORK / TIMEOUT_FIRST_CHUNK / TIMEOUT_INTER_CHUNK / SERVER_ERROR / STREAM_INCOMPLETE / EMPTY_RESPONSE | 1（瞬态重试） | 计失败；达阈值 → Open |
| MAX_TOKENS_TOO_HIGH | 1（降 maxTokens ×0.7 重试，走现有 FIX_AND_RETRY） | 计失败；达阈值 → Open |
| AUTH_INVALID(401) / AUTH_FORBIDDEN(403) | 0（快速失败） | **直接熔断 Open**（key 失效短期不恢复）；全部候选 AUTH 失败 → 上抛首个 AUTH 错误引导修凭证 |
| CONTEXT_LENGTH_EXCEEDED / MAX_TOKENS_EXCEEDED | 0（走现有压缩/bump 修复流程，修复后成功不算路由失败） | 修复流程后再失败才计；达阈值 → Open |
| CONTENT_FILTERED / MODEL_NOT_FOUND / MALFORMED_TOOL_CALL / BAD_REQUEST_OTHER | 0（快速失败，请求/内容问题降级无意义） | 计失败；达阈值 → Open |
| ABORTED_BY_USER | — | 不算失败，直接返回 |

**实现**：新纯函数 `routingRetryPolicy(category) → { inModelRetries: number; directOpen: boolean }`（`llm/caller/routing_loop.ts` 内或独立文件），attempt 循环按表决策。模型内重试的退避沿用现有 `getRetryDelay`（含 Retry-After 消费 + 退避 cap）。

## 8. app_config 存储层

### 8.1 方案库 group `model_routing_plans`

```json
{ "group": "model_routing_plans", "key": "<planId>", "data": {
  "id": "<planId>", "name": "主力+兜底",
  "items": [
    { "providerId": "01KVC9A2...", "modelId": "kimi-k2", "priority": 1,
      "timeCondition": { "hours": [2,3,...,23] }, "enabled": true },
    { "providerId": "01KVC9B5...", "modelId": "glm-4.6", "priority": 2, "enabled": true }
  ],
  "circuit": { "failureThreshold": 4, "successThreshold": 2, "timeoutSeconds": 60,
               "errorRateThreshold": 0.6, "minRequests": 10 },
  "createdAt": 1755200000000
} }
```

- **权威值组**（§3.14 语义）：record 缺失 = 未配置；key=planId（方案库多实例，非单实例）；
- **校验**：PUT 时服务端校验（§2.3 同模型约束 + providerId/modelId 必须指向已启用 provider 的合法 enabled model，复用 `services/model-validation.ts`）；违规 400 + 明确提示；
- **CRUD 端点**：复用 `/config/app` 通用 KV（GET 整组 / PUT 整组原子提交）；删除需 DELETE 支持（见 8.3）。

### 8.2 playground 挂载 group `model_routing`

```json
{ "group": "model_routing", "key": "default", "data": { "playgroundPlanId": "<planId>" } }
```

单实例（key 固定 `default`）；缺失 = 未挂载（playground 走现有默认模型逻辑）。

### 8.3 删除方案 = 解除所有挂载方引用（PRD UC-3）

DELETE 方案时：① 校验无在途引用或自动解除——扫描 `squad.modelRoutingPlanId === planId` → 清空字段；`model_routing.default.playgroundPlanId === planId` → 清空；② 删除 record。挂载方回退默认模型（分支 1 逻辑天然生效）。

**API 形态**：新增 `DELETE /config/app?group=model_routing_plans&key=<planId>`（通用 KV 目前无 DELETE，本版本补一个受控 DELETE 支持，仅允许 `model_routing_plans` group，带引用解除逻辑）；或专用 handler（对齐 `sub_agent_templates` 先例）。**架构决策：走通用 KV DELETE + group 白名单（仅 model_routing_plans）**——`kv-config-handlers.ts` 增 DELETE 分支 + `model-routing-handlers.ts` 做引用解除与校验。

## 9. 边界（PRD §5 非目标）

| 不做 | 理由 |
|---|---|
| quota 用量窗口路由（5h/7d） | 需拉服务商 API，复杂度高，后续 |
| 熔断状态持久化 | 运行时内存态，重启丢失可接受（对齐 cc-switch） |
| attempt state 落盘 | call 级瞬时 |
| academy 方案支持 | 本期仅 studio/playground |
| session 配方案 | session 只能 model/default |
| 隐式兜底 | 全部不可用时报「当前无可用模型」 |
| 独立健康探测任务 | 半开用真实请求 |
| 时间控件自研 | **已发生（决策⑧ 兜底）**：react-availability-grid 0.2.1 内部 hours 生成硬限制无法 hack 出「每天重复 24 小时格」→ 自研 `HourGridPicker`（输出恒 `{hours:number[]}` 0-23 白名单）；依赖 react-availability-grid + dayjs 均移除。**UI v2（Task 4）弹层化**：草稿态隔离（确定前零写回）+ 视觉语义翻转 + footer 校验（0/24 格报错）。UI 细节见 `specs/ui/components/app-dev-config-page/component-hour-grid-picker.md` |

## 10. 与现有体系融合点

| 现有机制 | 融合方式 |
|---|---|
| `resolveModel`（model_resolve.md） | 分支 1 保留原链零改动；分支 2 由 buildSessionConfigFromDeps 先查挂载、产出 modelRoutingPlan（不 resolveModel） |
| `ProviderHealthRegistry`（per-session 4 态） | 分层共存：方案熔断（Config 层）先查，session health（attemptLoop 内）照旧 |
| `retry_and_timeout.md`（退避+看门狗） | 模型内重试走现有退避/看门狗；换模型降级 0 sleep |
| `error_normalization.md`（分类+hints） | §7 策略表直接消费 category；classify/decide 不动 |
| `app_config` | 新增 `model_routing_plans` + `model_routing` 两 group；squad 加 `modelRoutingPlanId` 字段 |
| `llm_caller.invoke`（attemptLoop） | ctx 加 routingPlan；有方案走 routing_loop（复用 attemptLoop 单次调用），无方案零改动 |

> 变更历史见 [`log.md`](log.md) + `specs/tech/version_logs/v0.0.347/change_plan.md`（method 级契约）+ `change_log.md`。
