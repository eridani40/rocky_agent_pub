# v0.0.351 change_plan：会话运行中配置实时生效

> 版本：v0.0.351（主仓 dev1）
> 派单：Darvin leader · 老板 2026-08-15 09:08 拍板方案 A
> 前置调研：`specs/research/chat-input-config-cache.md`
> 范围：只出 plan + task.json，不编码；PRD/Tech/API/UI 确认链由派单时补齐

## 0. 老板拍板

**方案 A**：会话运行中（agent_loop 已启动）可以修改输入框/设置里的模型、effort、审批模式等配置；**每个 iteration 边界重新读取 session 最新配置并生效**（真正随时生效，不只是新消息）。

## 1. 现状实证（源码层）

| 现象 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 配置启动时一次快照 | `app/server/src/agent/agent-manager.ts` | L217-218 | `activate` 内 `resolveConfigBySid(sessionId)` 只调一次，生成完整 `SessionConfig` |
| 快照写入 RunSpec | `app/server/src/agent/build-run-deps.ts` | L237 | `spec.config = opts.config`，loop 内只读 `spec.config` |
| LLM 消费 model/effort | `app/server/src/agent/loop-stage-llm.ts` | L93-94, L107 | `baseCallLLM` 直接读 `config.client` / `config.modelId` / `config.effort` |
| 审批消费 approvalMode | `app/server/src/tools/engine.ts` | L198 | 工具执行时读 `config.approvalMode` 绿灯短路 |
| 前端运行中禁用 picker | `app/web/src/components/chat-page/component-chat-session-input.tsx` | L161, L166, L172 | 三个 picker 都 `disabled={sessionRunning}`，物理阻止修改 |
| 前端 setter 已支持 PUT | `app/web/src/components/chat-page/use-chat-chrome.ts` | L82-114 | `setEffort/setApprovalMode/setModel` 已走乐观更新 + `PUT /session/:id`，运行中禁用是 UI 层 |
| SessionConfig 无 providerId | `app/server/src/agent/context-types.ts` | L88-102 | 只有 `modelId`，缺少重读 client 所需的 `providerId` |

一句话：**session 表实时更新，RunSpec.config 是启动快照，loop 不再回读**。

## 2. 决策点

### D1 重读边界：prepareStage 后、callLLM 前

在 `run-react-loop.ts` while 循环中，**`prepareStage` 之后、`callLLMForSpec` 之前**调用配置刷新函数。理由：
- 覆盖本轮 LLM 调用（model/effort）。
- 审批模式在本轮随后的 `executeAndEmit` 被消费（tool execution 在 callLLM 之后），因此同一次刷新即可覆盖。
- 不放在 `callLLM` 内部（函数已接收 client/modelId），也不放在 execute 内部（过晚，且入口分散）。
- **必须 await 刷新完成后再进 callLLM**；刷新期间 controller.aborted 需再次检查。

### D2 可变字段：model、effort、approvalMode（当前 UI 实际三件套）

本轮先处理用户输入区/设置页已暴露的 session 级配置：
- `providerId` + `modelId`
- `effort`
- `approvalMode`

架构上 `refreshRuntimeConfig` 按字段名刷新，后续新增字段可扩展；**本轮不加定时/schedule 等未暴露字段**。

### D3 client 重建策略：只比较 providerId+modelId，不变不重建

- `SessionConfig` 新增 `providerId: string` 字段（与 `modelId` 配对），由 `buildSessionConfigFromDeps` 两分支都填充。
- 刷新函数读取 session 最新 `providerId/modelId`，与 `spec.config` 当前值比较：
  - 相同 → client 引用保持不变，零重建成本。
  - 不同 → 调用 `buildLlmClient(providerId, modelId, appConfig, pluginManager)` 重建 client，并替换 `spec.config.client` 与 `modelId/providerId`。
- `effort`/`approvalMode` 是纯值，直接覆盖。

### D4 运行中改模型 = 显式模型优先，脱离 model routing 方案

- 启动时若 session 挂载 modelRoutingPlan，仍按 v0.0.347/v0.0.349 方案解析出首候选 client。
- **运行中用户通过 picker 改 model → 直接写入 session.providerId/modelId**，刷新时走简化路径（分支 1），不再调用 `resolveModelRoutingPlan`。
- 这是用户显式指定，符合直觉；PRD/UI 文案应说明「运行中切换会脱离当前方案」。

### D5 刷新函数不重跑完整 buildSessionConfigFromDeps

`refreshRuntimeConfig` 只做轻量读取 + client 重建，**禁止**重建 skills/tools/workdir/systemPrompt/maxIter 等。这些在运行期不应因用户调 picker 而变。

### D6 仅 main run 实时刷新；forked/subagent run 保持快照

通过 `spec.runKind === 'main'` 门控。旁路 run（summary/consolidate）和 subagent run 仍走启动快照，避免跨 run 行为不一致。

### D7 前端：直接移除运行中 disabled 门控

`component-chat-session-input.tsx` 中三个 picker 的 `disabled={sessionRunning}` 改为 `disabled={false}`（或按能力 caps 新增 `runtimeEditable` 默认 true）。布局稳定性不变。

### D8 observability trace 顶部 model 保留启动值

`startTrace` 在 loop 启动时已记录初始 model。后续每轮 `startGeneration` 读 `config.modelId`（loop-stage-llm L85），会自动用新 model。**trace 顶部 model 不随动**，这是可接受的快照 vs 逐轮生成差异；如 PRD 要求统一，可在 `LoopObservability` 补 `updateTraceModel`（本版暂定不补，避免扩大面）。

## 3. 方法级契约表

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 (MUST/MUST NOT) | 参考 | 预计影响行 |
|---|---|---|---|---|---|---|---|
| agent loop | `app/server/src/agent/run-react-loop.ts` | `runReActLoop` | modify | while 内 `prepareStage` 后、`callLLMForSpec` 前调用 `await refreshRuntimeConfig(spec, deps)` | MUST 在 callLLM 前；MUST 再次检查 `controller.aborted`；MUST 仅当 `spec.runKind==='main'` | run-react-loop L109-156 | ~+12 |
| agent loop | `app/server/src/agent/loop-runtime-config.ts`（新） | `refreshRuntimeConfig` / `RuntimeConfigRefreshDeps` | new | 读 session 最新 providerId/modelId/effort/approvalMode；按需 `buildLlmClient` 重建 client；更新 `spec.config` | MUST NOT 重建 skills/tools/workdir；MUST 保持 client 引用稳定当模型未变；MUST 吞非致命错误（log warn 后继续用旧 config） | agent-manager L218, session-config L371 | ~+90 |
| context types | `app/server/src/agent/context-types.ts` | `SessionConfig` | modify | 新增 `providerId: string`（与 modelId 配对） | MUST 向后兼容：如测试 mock 未设，refresh 函数需兜底；建议必填但 coder 需同步修测试 | buildSessionConfigFromDeps | ~+3 |
| session config | `app/server/src/handlers/session-config.ts` | `buildSessionConfigFromDeps` | modify | return 对象增加 `providerId`（分支 1 `resolved.providerId`；分支 2 `builtClient.providerId`） | MUST 两分支都填充 | L371-377 | ~+3 |
| llm client | `app/server/src/llm-client-factory.ts` | `buildLlmClient` | read/verify | 确认返回的 `LlmClient` 无状态/可安全重建；必要时加注释 | 若发现状态型字段，改 plan 需更新 | — | 0 |
| frontend | `app/web/src/components/chat-page/component-chat-session-input.tsx` | `buttonRowSlot` | modify | 三个 picker `disabled={sessionRunning}` → `disabled={false}`（或按 caps.runtimeEditable） | MUST 保留停止按钮位置；MUST 不引入布局跳动 | PRD §运行中可改 | ~-3 |
| frontend | `app/web/src/components/chat-page/use-chat-chrome.ts` | `setEffort/setApprovalMode/setModel` | read | 当前实现已支持运行中 PUT，无需改动 | 确认无额外门控 | L82-114 | 0 |
| tests | `app/server/src/agent/__tests__/run-react-loop.test.ts` | 新增用例 | modify | 构造 running loop，iteration N 前更新 session store，断言 callLLM 收到新 modelId/effort/approvalMode | 用 fake timers + mock store；MUST 覆盖模型变与不变两条路径 | run-react-loop | ~+130 |
| tests | `app/web/src/components/chat-page/__tests__/component-chat-session-input.test.tsx` | 新增/修改 | modify | 运行中 picker 不 disabled；断言点击可改 | 不读截图；用 DOM 测试 | component-chat-session-input | ~+50 |
| spec sync | `specs/api/overall/04a-session-chrome.md` | — | read/patch | 补充「运行中配置修改下轮 iteration 生效」语义 | 后续 PRD/Tech 确认链更新 | PRD 确认后 | 0（本版不编码） |

## 4. 风险清单与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **R1 client 重建成本/状态** | 每 iteration 重建 client 可能影响性能或连接状态 | 仅 providerId/modelId 变化时重建；不变时保持引用；coder 实现前确认 `buildLlmClient` 无状态 |
| **R2 observability trace 顶部 model 不一致** | trace 记录启动 model，后续 generation 用新 model | 可接受；如 PRD 要求统一，补 `LoopObservability.updateTraceModel`（本版不默认做） |
| **R3 审批 pending 状态切换** | 运行中切 approvalMode 时已有 pending tool call | 当前 run 已 suspended，下轮恢复时 `activate` 会重新 resolveConfig，自然生效 |
| **R4 model routing 方案冲突** | 运行中改模型是否脱离方案 | 决策 D4：运行中显式改模型走简化路径；PRD/UI 文案需说明 |
| **R5 定时/schedule 等未暴露字段** | 需求提到"定时条件" | 本轮只处理 UI 已暴露三件套；`refreshRuntimeConfig` 按字段名扩展，为 future 留口 |
| **R6 litellm/health 缓存** | client 重建是否破坏缓存 | `invoke` 按四元组 key 缓存 health，client 实例重建但四元组不变 → 命中；安全 |
| **R7 竞态：刷新与再次修改** | store.getSession 和 callLLM 之间用户又改配置 | 以 callLLM 前最后一次读取为准，下下轮再生效——符合 iteration 边界语义 |
| **R8 测试回归：mock SessionConfig 缺 providerId** | 新增必填字段 break 大量测试 | 约束：refresh 函数兜底缺失 providerId；coder 批量补测试； reviewer 重点查 |
| **R9 forked/subagent run 误刷新** | 旁路 run 不应实时变配置 | `spec.runKind === 'main'` 门控 |
| **R10 store.getSession 每轮读取** | sqlite 轻量读取，不增加数量级 | 可接受；如 PRD 要求可优化为事件推送，但增加复杂度，本版不用 |

## 5. 数据流变化

```
before:
  activate → resolveConfigBySid ──→ buildRunDeps ──→ runReActLoop
                                      (config 快照)      ↑ 每轮读 spec.config

after:
  activate → resolveConfigBySid ──→ buildRunDeps ──→ runReActLoop
                                      (启动快照)         ↑ 每轮 iteration 边界
                                                          refreshRuntimeConfig(spec, store)
                                                                   ↓
                                                          store.getSession(sid) 读最新字段
                                                                   ↓
                                                          更新 spec.config.modelId/providerId/effort/approvalMode
                                                          模型变化时重建 client
```

## 6. 范围边界

- **要**：
  - 后端：main run 每 iteration 边界重读 model/effort/approvalMode 并生效。
  - 后端：新增 `refreshRuntimeConfig` helper；`SessionConfig` 加 `providerId`。
  - 前端：移除运行中 picker disabled 门控。
  - UT：后端 loop 实时生效 + 前端 picker 回归。
- **不要（本轮）**：
  - 不改 session-config.ts 主装配逻辑（启动时仍全量）。
  - 不改 buildRunDeps / LoopState / LifecyclePort。
  - 不新增定时/schedule picker。
  - 不改 observability trace 顶部 model（如 PRD 要求后续单独立项）。
  - 编码、PRD、Tech spec 细节在派单后由对应 mate 执行。

## 7. 关键接口草案

```ts
// app/server/src/agent/loop-runtime-config.ts
export interface RuntimeConfigRefreshDeps {
  store: SessionStore;          // 读 session 最新字段
  appConfig: unknown;           // buildLlmClient 需要
  pluginManager: unknown;       // buildLlmClient 需要
}

export async function refreshRuntimeConfig(
  spec: RunSpec,
  deps: RuntimeConfigRefreshDeps,
): Promise<void> {
  // 1. 仅 main run
  if (spec.runKind !== 'main') return;
  // 2. 读 session
  const session = await deps.store.getSession(spec.sessionId);
  if (!session) return; // log warn，保持旧 config
  // 3. 取可变字段
  const nextProviderId = session.providerId;
  const nextModelId = session.modelId;
  const nextEffort = session.effort;
  const nextApprovalMode = session.approvalMode;
  // 4. 按需重建 client
  const cfg = spec.config;
  if (
    nextProviderId &&
    nextModelId &&
    (nextProviderId !== cfg.providerId || nextModelId !== cfg.modelId)
  ) {
    cfg.client = buildLlmClient(nextProviderId, nextModelId, deps.appConfig, deps.pluginManager);
    cfg.providerId = nextProviderId;
    cfg.modelId = nextModelId;
  }
  // 5. 覆盖纯值
  cfg.effort = nextEffort;
  cfg.approvalMode = nextApprovalMode;
}
```

注：具体错误处理、类型、`buildLlmClient` 参数形状由 coder 按实际代码调整；以上仅为接口意图。
