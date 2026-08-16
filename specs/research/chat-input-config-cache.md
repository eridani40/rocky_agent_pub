# Chat Input 配置缓存调研：模型 / effort / 审批模式在 agent_loop 中的生效路径

> 调研时间：2026-08-15 09:01-09:04 · researcher · 老板问题：对话输入框里的模型/effort 等配置是否被 loop 缓存，导致中途改了没反应
> 范围：只读代码/做时间线/写报告，不改代码
> 仓库：（主仓 dev1）

## 0. 结论速览（回答老板 5 个问题）

1. **UI 控件位置**：输入区按钮行从左到右（按 capabilities 门控）= 审批模式 picker（绿通）→ effort picker → model picker → 发送按钮 → 停止按钮。三者的值都挂在 `chrome`（`SessionChromeView`）上。
2. **传值方式**：picker 的 `onChange` 直接调用 `chromeHook.setModel/setEffort/setApprovalMode`，后者 **fire-and-forget PUT /session/:id**，同时乐观更新本地 `chrome`。
3. **读入 agent_loop 时机**：在 **loop 启动瞬间** 通过 `AgentManagerImpl.activate` → `resolveConfigBySid(sessionId)` → `buildSessionConfigFromDeps` 把 `session.providerId/modelId/effort/approvalMode` 组装成 **SessionConfig**；然后 `buildRunDeps` 把该 config 注入 `RunSpec`。整个 run 期间 `runReActLoop` 只读 `spec.config`，**不会重新读 session 持久字段**。这就是老板说的「loop 内缓存」。
4. **配置消费点**：
   - `modelId/effort`：每轮 LLM 调用 `loop-stage-llm.ts:90 base.callLLM` 时直接透传 `config.modelId` 和 `config.effort`。
   - `approvalMode`：`engine.execute` 在工具调用时通过 `ToolCtx.config.approvalMode` 判断是否需要审批。
5. **结论**：
   - 老板的怀疑 **属实**：同一个 run 内，模型/effort/approvalMode 是启动时快照，后续修改不会生效。
   - 当前前端在 `sessionRunning` 时把 picker **disabled=true**（`component-chat-session-input.tsx:162,166,173`），等于物理上阻止了运行中修改；但如果绕过 UI（API/脚本直接 PUT session），确实会出现「改了但当前 run 没反应」。
   - 如果老板想要「**随时生效**」，最小改动路径不是改 agent_loop 读 session（会破坏 snapshot 一致性），而是：
     - **A 方案（推荐）**：保持 run 级快照语义，但在 loop 的每次 iteration 边界（prepareStage 后、callLLM 前）重新 `resolveConfigBySid` 并更新 `spec.config` 的 `modelId/effort/approvalMode`；LLM client 的重新装配（client/modelId）需要可控替换。
     - **B 方案（更轻量）**：前端允许运行中改 effort/model，但 UI 文案提示「下次对话生效」；当前 run 仍走快照。这其实是现状的语义清晰化，不是技术改。

下面给出完整链路定位与流程图。

## 1. UI 控件：输入框里的配置项

### 1.1 三个 picker 文件与职责

| 配置项 | 文件 | props | 默认值来源 | 备注 |
|--------|------|-------|----------|------|
| 模型 | `app/web/src/components/chat-page/component-input-model-picker.tsx` | `model`, `defaultModelId`, `defaultModelProviderId`, `defaultModel`, `onChange`, `disabled` | 4 源优先级：studio 显式 `defaultModel` > 内部自拉 `GET /config/app?group=default_models&key=default` > provider 列表反查 | modelId='default' 表示跟随默认 |
| effort | `app/web/src/components/chat-page/component-input-effort-picker.tsx` | `effort`, `onChange`, `disabled` | 显示值 `effort ?? 'default'`，语义键 `default/low/high/max` | 纯 enum 下拉 |
| 审批模式 | `app/web/src/components/chat-page/component-input-approval-mode-picker.tsx` | `approvalMode`, `onChange`, `disabled` | `normal/greenlight` | HITL 相关 |

### 1.2 装配层：ComponentChatSessionInput

文件：`app/web/src/components/chat-page/component-chat-session-input.tsx:75-212`

按钮行装配：
```tsx
{caps.approvalPicker && <InputApprovalModePicker approvalMode={chrome.approvalMode} disabled={sessionRunning} ... />}
{caps.effortPicker && <InputEffortPicker effort={chrome.effort} disabled={sessionRunning} ... />}
<InputModelPicker
  model={chrome.sessionModel ?? { providerId: '', modelId: 'default' }}
  defaultModelId={chrome.defaultModel?.modelId ?? ''}
  defaultModelProviderId={chrome.defaultModel?.providerId}
  disabled={sessionRunning}
  onChange={onModelChange}
/>
```

- 所有 picker 都受 `disabled={sessionRunning}` 控制：会话一旦进入 running，picker 不可点。
- 但 `sessionRunning` 来自 `useRunState` SSE 派生，存在网络/处理延迟；极端情况下用户可能在 run 刚起、UI 还没收到 running 状态时点击修改。

### 1.3 onChange → PUT /session

`ComponentChatSessionInput` 接收 `onModelChange/onEffortChange/onApprovalModeChange`，来自父级 `SectionChatSession` 的 `chromeHook.setModel/setEffort/setApprovalMode`：

```tsx
// section-chat-session.tsx:265-267
onModelChange={chromeHook.setModel}
onEffortChange={chromeHook.setEffort}
onApprovalModeChange={chromeHook.setApprovalMode}
```

这些 setter 在 `use-chat-chrome.ts:82-114`：

```ts
const setEffort = useCallback((level: EffortLevel) => {
  mutate((c) => (c ? { ...c, effort: level } : undefined));
  if (!sessionId) return;
  updateSession(sessionId, { effort: level }).catch(...);
}, [sessionId, mutate]);

const setModel = useCallback((sel: ModelSelection) => {
  mutate((c) => (c ? { ...c, sessionModel: sel.modelId === 'default' ? null : sel } : undefined));
  if (!sessionId) return;
  const body = sel.modelId === 'default' ? { modelId: 'default' } : { providerId: sel.providerId, modelId: sel.modelId };
  updateSession(sessionId, body).catch(...);
}, ...);
```

- **数据流**：picker 改值 → 本地乐观更新 `chrome` → PUT /session 写持久字段 `session.effort`、`session.providerId`、`session.modelId`。
- 注意：`updateSession` 是 `app/web/src/lib/chat-api/session-api.ts:85-108` 的 HTTP 客户端封装，请求体只含被改字段。

## 2. 后端：SessionConfig 组装（启动时一次性快照）

### 2.1 入口：AgentManagerImpl.activate

文件：`app/server/src/agent/agent-manager.ts:209-299`

```ts
async activate(sessionId: string): Promise<AgentRun> {
  let config: SessionConfig;
  try {
    config = await this.resolveConfigBySid(sessionId);  // ← 启动瞬间读一次
  } catch (e) { ... }
  ...
  const { spec, loop } = buildRunDeps({
    config: configWithToolCtx,  // ← 整个 run 的 config 来源
    ...
  });
  return this.run(spec, loop);
}
```

`resolveConfigBySid` 是 bootstrap 注入的闭包，内部调用 `buildSessionConfigFromDeps` + `store.getSession(sessionId)`。注释明确：**每次 enqueue/activate/deliverTo 内部按需取最新 session 持久字段（无 cache）**——但这里的「每次」指的是 **每次启动/激活**，不是 run 内的每个 iteration。

### 2.2 buildSessionConfigFromDeps：把持久字段转成 SessionConfig

文件：`app/server/src/handlers/session-config.ts:228-541`

输入 `sessionPersist` 包含 `providerId/modelId/effort/approvalMode`，函数内：

- 调用 `resolveModel`（或 v0.0.347 候选链）解析 provider/model，构造 `client`。
- 调用 `resolveEffort(sessionPersist.effort, squadEffortDefault)` 得到 `resolvedEffort`。
- 把 `resolvedEffort`、`approvalMode`、`client`、`modelId`、`llmRequestConfig` 等打包进 `SessionConfig`。

关键输出字段：

```ts
return {
  sessionId,
  client,        // buildLlmClient 产物
  modelId,       // 当前生效模型
  effort,        // low/high/max（undefined = 厂商默认）
  approvalMode,  // normal/greenlight（undefined = normal）
  llmRequestConfig,
  allProviders,
  ...
};
```

### 2.3 buildRunDeps：把 config 注入 RunSpec

文件：`app/server/src/agent/build-run-deps.ts:82-240`

```ts
const spec: RunSpec = {
  sessionId: sid,
  runId,
  config: opts.config,     // ← 就是上面组装的 SessionConfig
  toolDefinitions,
  allowedTools,
  maxIter,
  ...
};
```

从这一步开始，loop 内只读 `spec.config`，不会再回查 session 持久字段。

## 3. 配置在 run 内的消费点（一次性快照的实际含义）

### 3.1 effort / modelId → loop-stage-llm.ts

文件：`app/server/src/agent/loop-stage-llm.ts:42-144`

```ts
const { config, controller, runId, runKind, scopeId, observability: obs } = spec;
...
const { assistantMessage: assistantMsg, usage: lastUsage } = await baseCallLLM({
  sessionId: sid,
  runId,
  client: config.client,
  modelId: config.modelId,      // ← 启动快照
  messages: logicalMessages.map(toProtocolMessage),
  ...
  effort: config.effort,        // ← 启动快照
  ...
});
```

也就是说，每次 LLM 调用时，modelId/effort 都来自 `spec.config`，不会重新读取 session。

### 3.2 approvalMode → tool execution engine

审批模式在工具调用阶段被消费。虽然调研时间有限未追到 `engine.execute` 的精确行，但 `SessionConfig` 中 `approvalMode` 被注入后，会经 `buildRunDeps` → `RunSpec` → `agent-loop-stage-tool.ts` 的 `executeAndEmit` → `toolEngine.execute(config, ...)` 透传。工具策略里读取 `ctx.config.approvalMode` 判断是否需要审批。该字段同样来自启动快照。

### 3.3 runReActLoop：整个 run 只读 spec.config

文件：`app/server/src/agent/run-react-loop.ts:68-301`

核心循环骨架：

```
while (!state.done) {
  prepared = await prepareStage(spec, state);
  { assistant, usage } = await callLLMForSpec(spec, state);  // 读 spec.config.modelId/effort
  await ingestAssistant(...);
  toolCalls = extractToolCalls(...);
  { results, pending } = await executeToolsForSpec(spec, toolCalls); // 读 spec.config.approvalMode
  await ingestToolResults(...);
  checkDoomLoop / checkMaxIter
}
```

整个循环没有任何一处重新 `resolveConfigBySid` 或 `store.getSession`，`spec.config` 对象不变。

整个循环没有任何一处重新 `resolveConfigBySid` 或 `store.getSession`，`spec.config` 对象不变。

## 4. 完整数据流流程图

```
┌────────────────────────────────────────────────────────────────────────────┐
│  浏览器 UI                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│  │ Approval picker │  │ Effort picker   │  │ Model picker    │            │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘            │
│           │ onChange           │ onChange          │ onChange             │
│           ▼                    ▼                   ▼                       │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │ chromeHook.setApprovalMode / setEffort / setModel                    │   │
│  │   mutate local chrome + PUT /session/:id {effort|providerId/modelId} │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                  │                                         │
└──────────────────────────────────┼─────────────────────────────────────────┘
                                   │ HTTP PUT
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Server                                                                     │
│  handlers/session.ts updateSession(...)                                      │
│  │→ store.updateSession({ providerId, modelId, effort, approvalMode })       │
│  │→ session 表持久字段更新                                                    │
│  └────────────────────────────────────────────────────────────────────┐     │
│                                    │                                    │     │
│  当用户发送消息/触发新 run          ▼                                    │     │
│  POST /session/:id/messages {content}                                 │     │
│                                    │                                    │     │
│                                    ▼                                    │     │
│  AgentManagerImpl.activate(sessionId)                                   │     │
│   config = await resolveConfigBySid(sessionId)  ◄─── 读取 session 最新字段 │     │
│   buildSessionConfigFromDeps(sessionPersist, ...)                         │     │
│   └── client / modelId / effort / approvalMode / ...                    │     │
│                                    │                                    │     │
│                                    ▼                                    │     │
│   buildRunDeps({ config }) → RunSpec.config                             │     │
│                                    │                                    │     │
│                                    ▼                                    │     │
│   runReActLoop(spec, state)                                             │     │
│   ┌──────────────────────────────────────┐                              │     │
│   │ while (!state.done) {                 │                              │     │
│   │   callLLMForSpec(spec, state)        │◄─── 读 spec.config.modelId   │     │
│   │   executeToolsForSpec(spec, toolCalls)│◄─── 读 spec.config.approval │     │
│   │ }                                    │                              │     │
│   └──────────────────────────────────────┘                              │     │
│   [期间 session 表字段被改，但这里不会再读]                                │     │
└────────────────────────────────────────────────────────────────────────────┘
```

一句话：**session 持久层实时更新；RunSpec.config 是启动快照；loop 只认快照**。

## 5. 影响面分析

### 5.1 当前用户可见行为

- 运行中 picker 被 disabled，所以正常用户无法触发「改了没反应」。
- 但存在以下例外：
  1. **竞态窗口**：点击发送→服务端开始运行→SSE 还没推 `running` 回前端→用户此时仍可切换 model/effort。这些修改只写入 session，不影响已启动 run。
  2. **API/脚本绕过**：外部直接 PUT /session，或以后 UI 支持运行中修改，都会出现「配置已更新但当前 run 没生效」。
  3. **多个并发 run**：同一个 session 如果有 background/forked 子运行，子运行启动时取的是启动瞬间的 session 字段，之后 session 被改也不会影响它们。

### 5.2 设计一致性风险

- **聊天记录与模型一致性**：同一次 run 里的多轮 LLM 调用若混用不同 model/effort，会让 usage、trace、回放数据难以解释。
- **审批模式切换安全**：如果在工具调用中途把 `approvalMode` 从 normal 切到 greenlight，理论上应该「后续工具调用不再弹审批」。当前快照意味着不会生效，反而更安全；若要支持实时生效，需明确「已经 pending 的审批如何处理」。
- **client 缓存**：`config.client` 在 `buildSessionConfigFromDeps` 里被构造（含 provider API key、baseUrl）。如果运行时切换 model 需要换 client，必须重新 buildLlmClient，否则可能用错 API key 或 endpoint。

### 5.3 相关代码引用汇总

| 作用 | 文件 | 行号 |
|------|------|------|
| UI picker 装配、disabled 门控 | `app/web/src/components/chat-page/component-chat-session-input.tsx` | 75-212 |
| UI setter：乐观更新 + PUT /session | `app/web/src/components/chat-page/use-chat-chrome.ts` | 82-114 |
| PUT /session 请求封装 | `app/web/src/lib/chat-api/session-api.ts` | 85-108 |
| 后端 handler：更新 session 字段 | `app/server/src/handlers/session.ts` | 120-260（update 路径） |
| POST /session/:id/messages 只发 content | `app/server/src/handlers/session-messages.ts` | 40-180 |
| 组装 SessionConfig | `app/server/src/handlers/session-config.ts` | 228-541 |
| loop 启动：一次性 resolve config | `app/server/src/agent/agent-manager.ts` | 209-299 |
| 把 config 注入 RunSpec | `app/server/src/agent/build-run-deps.ts` | 82-240 |
| LLM 调用消费 modelId/effort | `app/server/src/agent/loop-stage-llm.ts` | 42-144 |
| 主循环只读 spec.config | `app/server/src/agent/run-react-loop.ts` | 68-301 |

## 6. 结论与建议

### 6.1 老板的问题：是否存在 loop 缓存？

**属实。**

- 模型、effort、审批模式都在 `AgentManagerImpl.activate` 启动时通过 `resolveConfigBySid` 读取 session 字段，生成 `SessionConfig`。
- `buildRunDeps` 把 `config` 写入 `RunSpec.config`。
- `runReActLoop` 在每次 iteration 中直接消费 `spec.config`，不会回读 session 表。
- 因此，同一 run 内修改 session 字段不会生效。

### 6.2 当前前端是否暴露这个问题？

不直接暴露，因为 picker 在 `sessionRunning` 时被 disabled。但：

- 竞态窗口下用户仍可能改到。
- 这是「用 UI 禁用」来掩盖「后端快照」的设计；如果未来要支持运行中调参，必须解决快照问题。

### 6.3 最小改动路径

方案排序取决于老板要的是「真正随时生效」还是「语义清晰化」。

#### 方案 A：运行时 iteration 边界重新 resolveConfig（真正随时生效）

改动点：
1. 在 `run-react-loop.ts` 的 `while` 循环开头（每轮迭代前）调用 `resolveConfigBySid(sessionId)`，得到新的 `SessionConfig`。
2. 只更新 `spec.config` 的 `modelId`、`effort`、`approvalMode` 字段，不动 `spec.config.systemPrompt` 等 run 级稳定字段。
3. 如果 `modelId` 变化：
   - 用 `buildLlmClient` 重新构造 `config.client`。
   - 或复用 `loop-stage-llm.ts` 里已有的 `clientBuilder`（v0.0.347 为 routingPlan 引入）按需组装 client。
4. 如果 `approvalMode` 变化：
   - 更新 `toolEngine` 的 `ToolCtx.config`。
   - 明确「当前 pending 审批」的处理策略（建议保持现状：已弹窗的仍按原策略）。
5. 在 observability 里记录每轮实际使用的 model/effort，便于 trace 回溯。

风险：
- 同一次 run 内多模型混跑会让 usage 归集、token 成本统计、模型路由缓存复杂化。
- client 重新构造可能引入 API key 切换问题（多 provider 场景）。

#### 方案 B：UI 提示「下次运行生效」（语义清晰化，改动最小）

改动点：
1. 保持现有 run 级快照语义不变。
2. 前端 picker 在运行中允许修改（或仍 disabled），但显示 tooltip/文案：「当前运行已启动，新的模型/effort 将在下次运行生效」。
3. 如果运行中修改，向用户明确告知「下次生效」。

优点：
- 无需改 agent_loop，风险最低。
- 符合「一次运行是一次原子会话」的产品语义。

缺点：
- 没有实现老板最初说的「随时生效」。

### 6.4 推荐

- 如果老板坚持「**中途改配置必须立即生效**」：走 **方案 A**，但需要 architect 出 change_plan，明确 run 级一致性、observability、client 缓存、审批 pending 处理。
- 如果老板接受「**运行中修改下次运行生效**」：走 **方案 B**，前端加文案即可。
- 建议先由 PRD 拍板产品语义，再让 architect 出 change_plan。

---

## 7. 附录：关键代码片段

### 7.1 session-messages.ts 注释（说明历史设计意图）

`app/server/src/handlers/session-messages.ts` 中有明确注释（约 v0.0.158）：

```ts
// model changes take effect at the moment user changes settings
// (PUT /session or PATCH squad); next message reads server record.
```

这段注释本身承认了「下次消息读取服务端记录」，与我们的调研结论一致。

### 7.2 component-chat-session-input.tsx 中 disabled 门控

```tsx
{caps.approvalPicker && (
  <InputApprovalModePicker
    approvalMode={chrome.approvalMode}
    onChange={onApprovalModeChange}
    disabled={sessionRunning}
  />
)}
{caps.effortPicker && (
  <InputEffortPicker
    effort={chrome.effort}
    onChange={onEffortChange}
    disabled={sessionRunning}
  />
)}
<InputModelPicker
  model={chrome.sessionModel ?? { providerId: '', modelId: 'default' }}
  defaultModelId={chrome.defaultModel?.modelId ?? ''}
  defaultModelProviderId={chrome.defaultModel?.providerId}
  defaultModel={chrome.defaultModel}
  onChange={onModelChange}
  disabled={sessionRunning}
/>
```

### 7.3 agent-manager.ts 中 config 只读一次

```ts
async activate(sessionId: string): Promise<AgentRun> {
  let config: SessionConfig;
  try {
    config = await this.resolveConfigBySid(sessionId);
  } catch (e) {
    ...
  }
  ...
  const configWithToolCtx: SessionConfig = {
    ...config,
    agentToolContext: { currentMessageId: undefined },
  };
  const { spec, loop } = buildRunDeps({ config: configWithToolCtx, ... });
  return this.run(spec, loop);
}
```

### 7.4 loop-stage-llm.ts 消费快照

```ts
const { config, controller, runId, runKind, scopeId, observability: obs } = spec;
...
const { assistantMessage: assistantMsg, usage: lastUsage } = await baseCallLLM({
  sessionId: sid,
  runId,
  client: config.client,
  modelId: config.modelId,
  ...
  effort: config.effort,
  ...
});
```

---

*报告完成。如需进一步追踪 `approvalMode` 在工具 engine 里的精确消费点，或需要补一个最小可复现的「绕过 UI 修改 session，观察 loop 未生效」的 AT case，可继续派单。*
