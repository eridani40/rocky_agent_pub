# v0.0.353 change_plan：模型路由调用链路正确性（调度生效 + Langfuse 真实记录）

> 版本：v0.0.353（worktree `worktrees/v0.0.353-model-routing-trace-correctness`）
> 基线：`dev1@9aba386b0`
> 派单：Darvin leader · 老板 09:12-09:13 拍板：timeCondition 不生效 + Langfuse 记录错误/缺 provider 元数据合并处理
> 前置报告：`states/v0.0.353/bugs/BUG-MODEL-ROUTING-TRACE-CORRECTNESS-[open].md`
> 范围：只出 plan + task.json，不编码

## 0. 老板拍板

- **timeCondition 必须按用户预期时区生效**（非服务器本地时区）。
- **session 显式 model 不得绕过方案时间窗口**。
- **调用谁记录谁**：每次 wire attempt（含失败）的 physical generation 必须记录真实 providerId / providerName / modelId。
- **logical generation 治理**：采用老板偏好 **A1** —— logical generation 不填 provider/model，仅作父 span；真实信息下沉到 physical 子 span。

## 1. 现状实证（源码层）

| 问题 | 文件 | 行号 | 说明 |
|---|---|---|---|
| 时间判断用服务器本地时区 | `app/server/src/llm/caller/routing_loop.ts` | L96 | `localHour = overrides.localHour ?? (() => new Date().getHours())` |
| 时间过滤未读 timezone | `app/server/src/llm/caller/routing_loop.ts` | L128-136 | `item.timeCondition.hours.includes(localHour())` 无 timezone |
| 显式 model 以 priority 0 无条件插入 | `app/server/src/handlers/session-config.ts` | L161-167 | 合成 `{ providerId, modelId: explicit, priority: 0, enabled: true }`，无 timeCondition |
| TimeCondition 无 timezone 字段 | `app/server/src/services/model-routing-validation.ts` | L22-24 | 只有 `hours: number[]` |
| logical gen model 固定为 config.modelId | `app/server/src/agent/agent-loop-observability.ts` | L228, L237 | `model: this.opts.modelId` |
| physical gen model 固定为 opts.model | `app/server/src/llm/caller/langfuse_observability_port.ts` | L134 | `model: opts.model`（来自 config.modelId） |
| onWire 无真实 target 透传 | `app/server/src/llm/caller/llm_caller.ts` | L250-264 | 仅 `recordWireBody(providerAttempt + 1, body, url)` |
| routing_loop onWire 也无 target | `app/server/src/llm/caller/routing_loop.ts` | L109-120 | 同样只传 body/url |
| GenStart/GenMetadata/TraceMetadata 缺 provider 字段 | `app/server/src/observability/types.ts` | L86-145, L212-241 | 只有 `model` / retryChain |
| 仅失败路径 retry_chain 含 providerId | `app/server/src/llm/caller/llm_attempt_emit.ts` | L51-61 | 成功路径无真实 provider 记录 |

一句话：**调度看服务器时间 + 显式 model 无条件；观测层只有固定 modelId，真实 provider 信息只残留在失败 retry_chain。**

## 2. 决策点

### D1 TimeCondition 增加 `timezone?: string`，默认 `Asia/Shanghai`

- `TimeCondition` 增加可选 `timezone?: string`。
- 向后兼容：**旧方案无 timezone 时默认 `Asia/Shanghai`**（与当前绝大多数用户/服务器设置一致），**禁止默认 UTC** 导致已配方案突然失效。
- 校验：timezone 必须是合法 IANA 字符串（如 `"Asia/Shanghai"`、`"UTC"`）。不合法可硬拒 400 或回退默认；本版建议硬拒（避免静默错误）。

### D2 时间过滤：按 item.timeCondition.timezone 取当前小时

- `routing_loop.ts` 中 `localHour` 不再使用 `new Date().getHours()`。
- 实现：`getHourInTimezone(timezone ?? 'Asia/Shanghai', now)`，使用 `Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(now)` 原生 API（不引入新依赖）。
- `RoutingLoopOverrides` 增加 `timezoneNow?: (timezone: string) => number` 以方便 UT mock。
- 现有 UT 用 `{ localHour: () => 10 }` mock，签名变更后需同步为 `{ timezoneNow: () => 10 }` 或保持 `localHour` 作为兜底。建议：overrides 保留 `localHour` 作废弃兼容（1 版本），内部优先 `timezoneNow`。

### D3 显式 session model 继承同模型 timeCondition

- `resolveModelRoutingPlan`（`session-config.ts`）合成 priority 0 条目时：
  - 若 `plan.items` 中存在 `providerId+modelId` 相同的条目（按启用条目优先），继承其 `timeCondition`。
  - 这样用户显式选模型后仍受方案时间窗口约束；若方案里该模型无时间条件，则仍全天可用。
- 允许多条同模型条目：取**第一条带 timeCondition 的启用条目**继承；若都不带时间条件则不加。

### D4 physical generation 记录真实 target（调用谁记录谁）

- 扩展 `ObservabilityPort`：
  - `recordWireBody(attempt, body, url, target?: { providerId, providerName, modelId })`；或新增 `recordAttemptTarget(target)`。
  - 本版推荐：**新增 `recordAttemptTarget(target)`**，不污染 `recordWireBody` 已有调用点签名（更安全）。
- `routing_loop.ts` 与 `llm_caller.ts` 在每次确定 `target` 后立即调用 `recordAttemptTarget`。
- `LangfuseObservabilityPort.startPhysicalGeneration` 用真实 target 的 `providerId`/`providerName`/`modelId` 启动 physical gen，替代 `opts.model`。
- `langfuse-adapter.ts`：
  - `model` 字段写真实 `modelId`。
  - `providerId`/`providerName` 写入 `metadata`（不污染 SDK model/name 字段；避免中文/特殊字符问题）。

### D5 logical generation 治理（A1）

- `LoopObservability.startGeneration`（agent-loop-observability.ts）：
  - logical generation 的 `model` 字段**置空字符串**（或保留 `this.opts.modelId` 但加 `metadata.logicalView: true` 明确标识）。
  - 本版决策：**model 保留原 config.modelId 但 metadata 增加 `providerId: null, providerName: null, logicalView: true`**，表示这是 logical view，真实信息在 physical 子 span。
- `LangfuseObservabilityPort` 启动 physical 子 span 时带真实 target；logical span 只作为父容器。
- TraceMetadata 顶部（`build-run-deps.ts` 构造 `LoopObservability` 时）仍保留启动时的 `modelId`，这是 trace 级快照，不影响 generation 级真实记录。

### D6 扩展 observability 类型

- `GenStart`：增加 `providerId?: string; providerName?: string;`。
- `GenMetadata`：增加 `providerId?: string; providerName?: string; modelId?: string;`。
- `TraceMetadata`：增加 `providerId?: string; providerName?: string;`（可选，顶部 trace 可填首候选）。
- 所有字段均为 optional，保持旧 trace 读取兼容。

## 3. 方法级契约表

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 (MUST/MUST NOT) | 参考 | 预计影响行 |
|---|---|---|---|---|---|---|---|
| model routing | `app/server/src/services/model-routing-validation.ts` | `TimeCondition` | modify | 增加 `timezone?: string` | MUST 向后兼容：无 timezone 默认 Asia/Shanghai | L22-24 | ~+1 |
| model routing | `app/server/src/services/model-routing-validation.ts` | `validateModelRoutingPlan` | modify | 校验 timezone 合法性（IANA 字符串） | MUST 可选字段；非法可 400 | L143-154 | ~+10 |
| model routing | `app/server/src/llm/caller/routing_loop.ts` | `RoutingLoopOverrides` | modify | 增加 `timezoneNow?: (timezone: string) => number`；保留 `localHour` 兼容 | MUST 优先 timezoneNow | L50-56 | ~+3 |
| model routing | `app/server/src/llm/caller/routing_loop.ts` | `routingAttemptLoop` | modify | 时间过滤按 `item.timeCondition.timezone ?? 'Asia/Shanghai'` 取小时 | MUST 不依赖服务器时区 | L96, L128-136 | ~+8 |
| session config | `app/server/src/handlers/session-config.ts` | `resolveModelRoutingPlan` | modify | priority 0 显式条目继承同模型 timeCondition | MUST 同模型多条时取第一条带 timeCondition 启用条目 | L161-167 | ~+12 |
| llm caller | `app/server/src/llm/caller/llm_caller.ts` | `ObservabilityPort` | modify | 新增 `recordAttemptTarget(target)` 方法 | MUST safe（target 未传不报错） | ObservabilityPort 接口 | ~+5 |
| llm caller | `app/server/src/llm/caller/llm_caller.ts` | `invokeCore` onWire / target 确定后 | modify | 调 `recordAttemptTarget(target)` 透传真实 target | MUST 分支1/分支2都调 | L250-264, L271-273 | ~+6 |
| llm caller | `app/server/src/llm/caller/routing_loop.ts` | onWire / target 组装后 | modify | 调 `recordAttemptTarget(target)` 透传真实 target | MUST 每次候选 attempt 都调 | L109-120, L160-167 | ~+8 |
| llm caller | `app/server/src/llm/caller/langfuse_observability_port.ts` | `createLangfuseObservabilityPort` / `startPhysicalGeneration` | modify | physical gen 用真实 target provider/model；增加 `recordAttemptTarget` | MUST 替代 opts.model 作为 physical model | L38-40, L78-86, L129-140 | ~+25 |
| agent loop | `app/server/src/agent/agent-loop-observability.ts` | `LoopObservability.startGeneration` | modify | logical gen 保留 modelId 但 metadata 加 `logicalView: true, providerId: null, providerName: null` | MUST 明确 A1 语义 | L210-243 | ~+6 |
| observability types | `app/server/src/observability/types.ts` | `GenStart` / `GenMetadata` / `TraceMetadata` | modify | 各加 `providerId?`, `providerName?`；GenMetadata 加 `modelId?` | MUST optional 保持兼容 | L86-91, L107-145, L212-241 | ~+10 |
| langfuse adapter | `app/server/src/observability/langfuse-adapter.ts` | `startGeneration` / `mapGenMetadata` | modify | providerId/providerName 写入 metadata；model 写真实 modelId | MUST 不污染 name 字段 | L160-178, mapGenMetadata | ~+10 |
| model routing spec | `specs/tech/agent/providers_and_models/[P0]model_routing.md` | §时区/§trace | modify | 增加 timezone 字段说明 + 显式 model 继承规则 + 调度生效语义 | 架构期同步 | — | 0（本版不编码） |
| api spec | `specs/api/overall/21-model-routing.md` | TimeCondition schema | modify | 增加 timezone 字段 | 架构期同步 | — | 0 |
| observability spec | `specs/tech/agent/observability/[P0]overall.md` | GenStart/GenMetadata/TraceMetadata | modify | providerId/providerName 字段说明 + A1 治理 | 架构期同步 | — | 0 |
| tests | `app/server/src/llm/caller/__tests__/routing_loop.test.ts` | 新增/修改用例 | modify | timezone mock + 显式 model 继承 timeCondition + 真实 target 记录 | 同步签名变更 | PRD + change_plan | ~+80 |
| tests | `app/server/src/llm/caller/__tests__/llm_caller.test.ts` | 新增/修改用例 | modify | recordAttemptTarget 调用 + physical gen model=真实 target | 同步签名变更 | PRD + change_plan | ~+60 |
| tests | `app/server/src/observability/__tests__/langfuse-adapter.test.ts` | 新增用例 | modify | metadata 含 providerId/providerName | 不真调 SDK | PRD + change_plan | ~+40 |

## 4. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| **R1 timezone 向后兼容** | 旧方案无 timezone 时默认 UTC 会突变 | 默认 Asia/Shanghai（与当前用户/服务器一致） |
| **R2 `localHour` mock 签名变更** | 现有 routing_loop UT 大量用 `{ localHour: () => 10 }` | 保留 `localHour` 作兼容兜底，新代码优先 `timezoneNow`；coder 批量修测试 |
| **R3 `recordWireBody` 签名变更扩散** | 多个调用点/测试需同步 | 采用新增 `recordAttemptTarget` 而非改 recordWireBody，最小化签名变更 |
| **R4 Langfuse model 字段语义变化** | 原记录 session 默认 model，改后记录真实 model，cost dashboard 可能变化 | 这是正确行为；与老板/依赖方同步；UT 断言同步 |
| **R5 providerName 含中文/特殊字符** | 直接写入 SDK name/model 字段可能异常 | providerName 只写入 metadata，model 只写 modelId |
| **R6 logical gen 置空 model 导致 AT 失败** | AT 可能断言 `model` 字段非空 | metadata.logicalView 标识 + 同步 AT 断言 |
| **R7 physical gen 数增加** | 每次 attempt 一个 physical span，trace 更细碎 | 符合「调用谁记录谁」需求；成本可接受 |
| **R8 分支1（无 routingPlan）真实 target 来源** | 分支1 无 candidate 概念，target 来自 resolveTarget | `resolveTarget` 返回 target 含 provider/model，可直接传 |
| **R9 旧 trace 无 provider 元数据** | 历史数据不可回溯 | 只改新 trace，旧数据不迁移 |
| **R10 时区库依赖** | 是否引入 dayjs/luxon | 用 `Intl.DateTimeFormat` 原生 API，不引入新依赖 |

## 5. 范围边界

- **要**：
  - timeCondition 按 timezone 生效（默认 Asia/Shanghai）。
  - 显式 session model 继承同模型 timeCondition。
  - 每次 wire attempt 真实 providerId/providerName/modelId 进 physical generation。
  - observability 类型扩展 provider 元数据字段。
  - logical generation A1 治理（metadata.logicalView + provider 字段置 null）。
  - 相关 spec 同步。
  - UT 回归。
- **不要（本轮）**：
  - 不改 retry_chain 结构（继续保留，作为错误路径补充）。
  - 不改 model routing 候选优先级/熔断/降级逻辑。
  - 不引入新时区依赖库（用原生 API）。
  - 不迁移历史 trace 数据。
  - 编码在派单后执行。

## 6. task 拆分

- **T1 调度生效**：TimeCondition.timezone + routing_loop 时区过滤 + session-config 显式 model 继承 timeCondition + 校验 + spec 同步。
- **T2 physical 真实记录**：observability 类型扩展 + ObservabilityPort.recordAttemptTarget + routing_loop/llm_caller 透传 + langfuse_observability_port / langfuse-adapter 写入真实 provider/model + spec 同步。
- **T3 logical 治理 + 回归**：LoopObservability logical gen A1 治理 + UT/AT/ET + 全量回归。

T1/T2 并行度高（仅共享 `routing_loop.ts` 但不同函数），T3 依赖 T2。

## 7. 关键接口草案

```ts
// app/server/src/services/model-routing-validation.ts
export interface TimeCondition {
  hours: number[];
  timezone?: string; // 缺省 Asia/Shanghai（向后兼容）
}

// app/server/src/llm/caller/routing_loop.ts
export interface RoutingLoopOverrides {
  now?: () => number;
  /** @deprecated 保留兼容；新代码用 timezoneNow */
  localHour?: () => number;
  timezoneNow?: (timezone: string) => number; // 返回 0-23 小时
  sleep?: (ms: number) => Promise<void>;
}

// app/server/src/llm/caller/llm_caller.ts
export interface ObservabilityPort {
  recordWireBody(attempt: number, body: unknown, url: string): void;
  recordAttemptTarget(target: {
    providerId: string;
    providerName: string;
    modelId: string;
  }): void;
  startPhysicalGeneration?(body: unknown, startTime: Date): GenHandle | undefined;
  // ...
}

// app/server/src/observability/types.ts
export interface GenStart {
  parent: SpanHandle | TraceHandle;
  model: string;
  providerId?: string;
  providerName?: string;
  // ...
}

export interface GenMetadata {
  iteration: number;
  step: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerId?: string;
  providerName?: string;
  modelId?: string;
  // ...
}

export interface TraceMetadata {
  runId: string;
  sessionId: string;
  modelId: string;
  providerId?: string;
  providerName?: string;
  // ...
}
```

## 8. 数据流变化

```
before:
  routing_loop/llm_caller
      ↓ onWire(body, url)
      ↓ startPhysicalGeneration(body)  // model=opts.model (config.modelId)

after:
  routing_loop/llm_caller
      ↓ onWire(body, url)
      ↓ recordAttemptTarget({providerId, providerName, modelId})  // 真实 target
      ↓ startPhysicalGeneration(body)  // model=真实 modelId, metadata.providerId/providerName
```

---

## 增量：T4 路由切换后 wire model 字段修复（leader 2026-08-15 13:47 派单；bug-analyst 报告 BUG-mr-tc5-step05 定性）

> 输入：`states/v0.0.353/bugs/BUG-mr-tc5-step05-all-candidates-unavailable-[open].md`（curl 双向复现 + Langfuse physical wire 铁证）。
> 根因：`session-config.ts:222 buildClientFromCandidates` 取首可组装候选（disabled MiniMax）→ baseReq.model="MiniMax-M3"；`routing_loop.ts` 切 client 到 deepseek 但 `build_request.ts:65 buildRequest` 从不重写 `req.model` → deepseek 端点收到 MiniMax-M3 body → 400 → NO_RETRY → 候选耗尽 → 「所有候选模型不可用」。v0.0.347 引入（529945438），影响所有跨模型回退。

### D7（接续 D6）T4 根治版：wire model 由调用现场 target 注入，禁止启动前预选污染

> 老板拍板（2026-08-15 14:32）：输入只保留 session 配置 + group 配置（model routing plan）+ 已调用过的 state；每次调用现场决定用哪个 candidate，用该 candidate 完整信息（providerId/modelId/baseUrl/key）现场构造请求参数；不存在 run 启动前「预选 candidate 并把 modelId 污染进 SessionConfig.modelId / baseReq.model」的步骤；启动前可 display 默认模型名给 UI，但不写 baseReq.model；真正发请求时只看 routing_loop 当前选中的 candidate。

原症状修 `258eb6098` 在 `buildRequest` step 1 前重写 `req.modelId = model.modelId`——它能止血跨模型回退，但属于下游补丁，没有消除上游污染源。根治路径：**SessionConfig.modelId 在分支 2 不再取首候选；baseReq.modelId 由调用现场当前 target 注入；`buildRequest` 只信任已经携带正确 modelId 的 baseReq，不再内部覆盖。**

#### 取舍：回滚 258eb6098，重改

- 推荐 **rollback + rewrite**：`258eb6098` 是症状补丁，叠在 `build_request.ts` 内会留下「函数必须靠模型参数修正 baseReq」的误导性契约；根治版把 model 来源上提到调用现场，语义更干净，后续维护不困惑。
- 回滚范围：仅 `build_request.ts` 内 3 行重写 + `build_request_model.test.ts` 中「baseReq.model≠target.modelId 时 built.req.model==target」的断言（这些断言验证的是症状修行为，根治后不再成立）。
- 不回滚 T2/T5：T2 recordAttemptTarget、T5 planName 透传 / recordSkippedCandidate 与 T4 根治方向正交。

#### 与 T5（coder2 commit `582ef0fde`，code-reviewer2 在审）的关系

- **文件交集**：`session-config.ts`（T5 D8 加 planName 透传；T4 改 modelId 取值）、`routing_loop.ts`（T5 D9 加 recordSkippedCandidate；T4 改 buildRequest 调用点）。两处改动位置不同，但同一文件。
- **逻辑正交**：T5 不改候选选择/切换逻辑，T4 不改 skip/observability 逻辑，可叠加。
- **合并顺序**：**建议 T5 review 先完成、merge 后再落地 T4 根治版**。原因：T5 已 commit 且 review 在途，若先动 T4 会让 T5 测试基线漂移；T5 落稳后 T4 做精确增量，减少 rebase 冲突。

#### 改动点

1. **`session-config.ts` 取消预选污染**
   - 分支 2 时，`builtClient` 仍用于取首可组装 client（作为 callLLM 占位/兜底）和检测「全候选不可用」；但 `providerId`/`modelId` 改为保留 session 持久口径（`sessionPersist.providerId ?? ''`、`sessionPersist.modelId ?? ''`），不再取首候选。
   - `buildClientFromCandidates` 返回类型不变，注释明确「返回值仅用于 client + 全候选不可用检测，不再作为 SessionConfig.modelId 来源」。

2. **`llm_caller.ts` 分支 1 现场注入 target modelId**
   - `invokeCore` 非路由分支中，target 确定后、调用 `buildRequest` 前：`baseReq = { ...baseReq, modelId: target.model.modelId }`。
   - branch-1 无跨模型回退时幂等；若有 fallback/resolve 链，保证 wire body 始终跟随当前选中的 target。

3. **`routing_loop.ts` 分支 2 现场注入 candidate modelId**
   - 每次进入 attemptLoop 前，调用 `buildRequest` 前：`baseReq = { ...baseReq, modelId: model.modelId }`。
   - MAX_TOKENS bump 路径 `baseReq = { ...baseReq, params: { ... } }` 不破坏已注入的 modelId（spread 保留）。

4. **`build_request.ts` 回滚症状修**
   - 删除 step 1 前的 `req = { ...req, modelId: model.modelId }`；`buildRequest` 信任 caller 已注入正确 modelId。
   - 保留 `model` 参数用于 capabilities/maxTokens 派生。

5. **`loop-stage-llm.ts` 保持现状**
   - `modelId: config.modelId` 仍传给 baseCallLLM，但分支 2 时 `config.modelId` 已是 session 口径/空字符串（非首候选），不再污染 wire；仅作为 logical gen / trace 快照的 session 补充信息。

#### 契约表（增量行）

| 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计行 |
|------|------|----------|------|---------|------|------|--------|
| handlers | app/server/src/handlers/session-config.ts | `buildSessionConfigFromDeps`（分支 2 赋值段） | 修改 | `providerId`/`modelId` 取 `sessionPersist.providerId/modelId ?? ''`，不再取 `builtClient.providerId/modelId` | MUST：分支 2 不预选 candidate；client 仍取 builtClient.client 占位 | 老板 14:32 拍板 | +4 |
| handlers | app/server/src/handlers/session-config.ts | `buildClientFromCandidates` | 修改注释 | 明确返回值仅用于 client/全候选不可用检测，不再作为 SessionConfig.modelId 来源 | MUST NOT：不改循环逻辑 | 同上 | +2 |
| llm/caller | app/server/src/llm/caller/build_request.ts | `buildRequest` | 修改 | 回滚 `258eb6098`：删除 step 1 前 `req = { ...req, modelId: model.modelId }` | MUST：调用点已保证 baseReq.modelId 正确 | 症状修回滚 | -3 |
| llm/caller | app/server/src/llm/caller/routing_loop.ts | routing attempt 主循环 | 修改 | buildRequest 调用前 `baseReq = { ...baseReq, modelId: model.modelId }` | MUST：每次 attempt 使用当前 candidate 的 modelId | 老板 14:32 | +2 |
| llm/caller | app/server/src/llm/caller/llm_caller.ts | `invokeCore` 分支 1 | 修改 | buildRequest 调用前 `baseReq = { ...baseReq, modelId: target.model.modelId }` | MUST：branch-1 fallback 同样跟随 target | 同上 | +2 |
| tests | app/server/src/llm/caller/__tests__/build_request_model.test.ts | 修改 | 修改 | 症状修断言改写为「buildRequest 不修改 modelId（baseReq.modelId 原样保留）」；保留 maxTokens/precompress overlay 不回归断言 | MUST：反映新契约 | 根治版 | ~20 |
| tests | app/server/src/llm/caller/__tests__/routing_loop.test.ts | 修改 | 修改 | 补 UT：次 candidate 进入 attemptLoop 前 baseReq.modelId 被覆盖为次 candidate modelId（mock client/observability 捕获） | MUST：调用点注入正确 | 同上 | ~25 |
| tests | app/server/src/llm/caller/__tests__/llm_caller.test.ts | 修改 | 修改 | 补 UT：branch-1 fallback 后 buildRequest 收到 baseReq.modelId==target.model.modelId | MUST：branch-1 同标准 | 同上 | ~20 |
| tests | app/server/src/handlers/__tests__/session-config.test.ts | 修改 | 修改 | 分支 2 时 SessionConfig.modelId 等于 sessionPersist.modelId（或空字符串），不等于首候选 modelId | MUST：污染消除 | 同上 | ~15 |

#### 零改动行（边界钉死）

- `CanonicalRequest` 类型、`protocol.encode`、旧路径 `client.stream`（无 routingPlan 时）不变。
- `agent-loop-call-via-invoker.ts` 不额外改（它只负责把 baseReq 传给 invoke；model 注入改在 invoke 内部）。
- T5 已落内容：`SessionConfig.modelRoutingPlan.planName`、`recordSkippedCandidate`、langfuse port `routingPlan` 透传——T4 不动。
- retry/timeout/length overlay 逻辑零改动。

#### 风险段

- **数据修复**：若历史 session 已把首候选 modelId 持久进 `sessionPersist.modelId`（旧版本 bug），本修复不能自动修正历史记录；但 wire 时已不读它，只影响 UI display/逻辑 gen 的 model 字段（非致命）。
- **旧路径兼容性**：无 routingPlan 的分支 1 旧 `client.stream` 路径不经过 invoke，仍直接用 `input.modelId`；该路径仅在测试/向后兼容场景，生产主路径走 invoke，已覆盖。
- **回归面**：`bun run test` llm/caller + handlers；AT `mr_tc5_timezone_schedule` step05 复跑；T5 全绿后再合 T4。
- **UT 时序**：UT 必须镜像「调用点注入 → buildRequest → attemptLoop」完整序列，孤立测 buildRequest 会失效。

#### spec 同步

- `specs/tech/agent/providers_and_models/[P0]model_routing.md` §invoke 改造段：把原「路由循环内 buildRequest 统一重写 req.model」改为「调用现场（routing_loop/llm_caller）在 buildRequest 前用当前 target modelId 注入 baseReq.modelId；buildRequest 信任 caller 注入值；SessionConfig.modelId 在分支 2 保留 session 口径，不取首候选」。

### 增量追加（leader 13:50 二次派单）：Langfuse 逻辑/物理两层语义模型校准 → 单列 T5

老板语义模型（13:50 拍板）：逻辑层=调用意图（1 意图 1 条，metadata 必须记**当时生效的路由方案** planId+方案名，session 配置仅补充）；物理层=attempt（T2 已实现，核对无缺口）；被跳过候选也记录标 skipped（排障一眼看清谁被跳了）。

**差距实证**（vs 现状代码）：
1. logical gen metadata 仅 `logicalView:true, providerId:null, providerName:null`（agent-loop-observability.ts:244-257 + port buildMetadata）——**无 planId/方案名**；mr_tc5 logical 显示 MiniMax-M3 纯 session 口径即此缺口。
2. `SessionConfig.modelRoutingPlan`（context-types.ts:281）= `{planId, items, circuit}` **不带 name**——resolveModelRoutingPlan（session-config.ts:162 `getPlan`）读了实体（有 name，validation.ts:77）但返回时丢弃。
3. routing_loop skip 分支 6 处静默 `continue`（①时间窗 162 ②enabled 175 ③熔断 open 178 ④banned 182 ⑤provider/model/key 不存在 186-190 ⑥half-open permit 194）——零记录。
4. physical 层（T2 recordAttemptTarget + startPhysicalGeneration 真实 target）：语义达标，无缺口。

### D8（接续 D7）logical gen 记录生效路由方案：routingPlan 全链透传（planId + planName）

- `SessionConfig.modelRoutingPlan` 增 `planName?: string`；`resolveModelRoutingPlan` 返回时带 `plan.name`（实体已有，只增不改，routing_loop 消费零破坏）。
- `LoopObservabilityOpts` 增 `routingPlan?: { planId: string; planName?: string }`；build-run-deps 构造时从 `config.modelRoutingPlan` 取（有方案才传）。
- `GenStart` 增 `routingPlan?: { planId: string; planName?: string }`；`startTrace` 的 TraceMetadata 同步带上（run 级快照）。
- `LoopObservability.startGeneration` logical gen 传 routingPlan；`langfuse-adapter.startGeneration` meta 透传（`meta.routingPlan`）。
- `LangfuseObservabilityPortOpts` 增 `routingPlan?`（loop-stage-llm 创建 port 时从 config 传入）；`buildMetadata`（endLogical 全量重建处）同步带——start/end 两侧对称。
- **口径**：logical gen 的 model 字段保留 opts.modelId（session 口径「仅补充」），metadata.routingPlan 为主要归属标识；无方案（分支 1）不传字段（零开销，旧 trace 兼容）。

### D9 被跳过候选也记录：port 增 `recordSkippedCandidate`，每 skip 一条 physical 同级 gen（标 skipped）

- `ObservabilityPort` 增可选 `recordSkippedCandidate?(cand: { providerId; providerName?; modelId; reason: 'time_window'|'disabled'|'circuit_open'|'banned'|'resolve_failed'|'probe_inflight' })`。
- port 实现：`adapter.startGeneration({ parent: genHandle, name: 'llm-{N}-skip-{M}', model: cand.modelId, kind: 'physical', input: { skippedCandidate: cand }, metadata: { skipped: true, reason, providerId, providerName } })` + 立即 end（一次成对，无 attempt 语义）；与 `llm-N-physical` 同 N 前缀成组，Langfuse 树上一眼区分「被跳 vs 真调」。
- routing_loop 6 处 skip 分支 continue 前调用（port 可选方法 + port 内部 safe 包裹，observability 失败绝不影响路由主流程）；`resolve_failed` 细分 reason 字符串（provider_missing/model_missing/key_missing 可并入 resolve_failed 单 reason 或携带 detail 字段，实现从简）。
- **MUST NOT**：不改 skip 语义本身（仍不消耗尝试/不计熔断失败）；不做批量聚合（每 skip 即时一条，老板要的就是逐条可见）。

### 契约表（T5 增量行）

| 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计行 |
|------|------|----------|------|---------|------|------|--------|
| agent | app/server/src/agent/context-types.ts | `SessionConfig.modelRoutingPlan` | 修改 | 增 `planName?: string` | 只增不改 | D8 | +3 |
| handlers | app/server/src/handlers/session-config.ts | `resolveModelRoutingPlan` | 修改 | 返回值带 `planName: plan.name` | 挂载悬空分支不变 | D8 | +2 |
| agent | app/server/src/agent/agent-loop-observability.ts | `LoopObservabilityOpts` / `startTrace` / `startGeneration` | 修改 | opts 增 routingPlan；TraceMetadata + GenStart 带 planId/planName | 无方案不传字段 | D8 | +15 |
| agent | app/server/src/agent/build-run-deps.ts | LoopObservability 构造 | 修改 | 从 config.modelRoutingPlan 透传 routingPlan | — | D8 | +4 |
| observability | app/server/src/observability/types.ts | `GenStart`（+TraceMetadata） | 修改 | 增 `routingPlan?` 可选字段 | 旧 trace 兼容 | D8 | +6 |
| observability | app/server/src/observability/langfuse-adapter.ts | `startGeneration` | 修改 | meta.routingPlan 透传 | — | D8 | +3 |
| llm/caller | app/server/src/llm/caller/llm_caller.ts | `ObservabilityPort` | 修改 | 增可选 `recordSkippedCandidate?` | port 可选风格（同 recordAttemptTarget） | D9 | +8 |
| llm/caller | app/server/src/llm/caller/langfuse_observability_port.ts | `LangfuseObservabilityPortOpts` / `buildMetadata` / 新方法 | 修改 | opts 增 routingPlan（buildMetadata 带上）；实现 recordSkippedCandidate（create-gen + 立即 end，safe 包裹） | start/end 对称；skipped gen 与 physical 同 parent | D8/D9 | +35 |
| agent | app/server/src/agent/loop-stage-llm.ts | port 创建 | 修改 | 传 routingPlan（config.modelRoutingPlan 有才传） | — | D8 | +4 |
| llm/caller | app/server/src/llm/caller/routing_loop.ts | skip 分支 ×6 | 修改 | continue 前调 `ctx.observability?.recordSkippedCandidate?.(...)`（带 reason） | MUST NOT：不改 skip 语义；observability 失败不影响路由 | D9 | +30 |
| tests | app/server/src/agent/__tests__/agent-loop-observability.test.ts | 修改 | 修改 | logical gen metadata 带 routingPlan 断言；无方案不传字段断言 | — | D8 | +15 |
| tests | app/server/src/llm/caller/__tests__/langfuse-observability-port-t2.test.ts | 修改 | 修改 | buildMetadata 带 routingPlan；recordSkippedCandidate 成对 gen（name/model/metadata.skipped/reason）断言 | — | D8/D9 | +30 |
| tests | app/server/src/llm/caller/__tests__/routing_loop.test.ts | 修改 | 修改 | 时间窗/enabled skip → port 收到 recordSkippedCandidate（reason 正确）；熔断 open skip 同断言 | — | D9 | +25 |

### T5 风险段

- `SessionConfig.modelRoutingPlan` 加字段：routing_loop/校验层消费零破坏（只增）；forked/分支 1 无方案路径不传（零行为变化）。
- skipped gen 量级：极端方案（多候选全跳）产生多条 gen——正是老板要的逐条可见；Langfuse batch 上限由既有 queue 机制管理（与 physical 同通道）。
- AT 扩展：mr_tc5 step06 Langfuse oracle 可加断言 logical 带 planId + 存在 skipped 记录（MiniMax disabled→skipped）——case 侧归 api-test-designer，T5 验收列联络点不阻塞编码。
- UT 时序：recordSkippedCandidate 调用点在 continue 前（路由循环内即时），UT 按分支逐处 mock 断言。
