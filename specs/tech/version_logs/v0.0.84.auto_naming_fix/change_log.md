# v0.0.84.auto_naming_fix — Tech Change Log

> 跨版本发布说明（版本轴）。本目录级变更见各 KB `log.md`（位置轴）：`specs/tech/agent/auto_naming/log.md`。
> 权威输入：`reqs/[working] v0.0.84.auto_naming_fix/` + `specs/tech/version_logs/v0.0.84.auto_naming_fix/change_plan.md`。

## 概览

playground session AI 自动起名不稳定（部分 session 起名失败、重启不恢复）。根因三层：① 起名裸调 `config.client.call` 绕过 `LlmCaller.invoke`（无 adaptive retry / 无 langfuse / 无错误归一化）；② hardcode `params:{maxTokens:1024, temperature:0}`（thinking 模型 thinking budget 占满 → `stop_reason:max_tokens` 无 text → 静默失败）；③ gate 首条锁定（失败永久放弃）。

**修复核心**：起名改走 `LlmCaller.invoke`（`backgroundPath:true`），三件事一次到位——① 去 hardcode 复用配置 ② reuse adaptive retry 全套（含 `FIX_AND_RETRY_MAX_TOKENS` 治 thinking 截断）③ langfuse 观测闭环（独立 trace + generation）。gate/CAS 保持现状（D4：不补起名，CAS 保护用户改名是核心不变量）。

**与 change_plan 的实际偏差**：实现与 change_plan 一致；observability 源加固（D5）是 AT round1 中暴露坐实、round2 修复的额外不变量——change_plan 列了「observability 复用 SessionConfig 已注入的 adapter」（§变更清单 D2 行），但实际代码 AT 暴露 `SessionConfig` 不含 observability 字段，改为从 `AutoNamingServiceDeps.observability` 注入（见 §2.2）。

## §1 起名改走 LlmCaller.invoke（替代裸 client.call）

**before**：`applyAiName` 内 `resp = await config.client.call({modelId, messages, params:{maxTokens:1024, temperature:0}})`——裸调 `LlmClient.call`，无 retry / 无 langfuse / 无错误归一化。

**after**：

```typescript
const baseReq: CanonicalRequest = {
  modelId: config.modelId,
  messages: [{ role: 'user', content: [{ type: 'text', text: NAMING_PROMPT + plainText }] }],
  params: {},   // D3：不 hardcode，复用 session/model 配置 + invoke buildRequest overlay
};
const ctx: InvokeContext = buildInvokeContext({
  client: config.client,
  errorState: createLlmErrorState(),
  sessionId: sid,
  controller: { runId: 'auto-naming', aborted: false },
  observability: obs?.port,
  backgroundPath: true,   // D2：仅排除 capacity(rate_limit/overload) 类重试防雪崩
});
invokeResp = await this.llmCaller.invoke(baseReq, ctx);
```

**收益**：
- **adaptive retry 全套**：`RETRY_BACKOFF`（网络抖动）/ `FIX_AND_RETRY_MAX_TOKENS`（thinking 模型 maxTokens 截断 → 自动加大重试，治 v0.0.64 类回归）/ `ROTATE_KEY`（API key 配额）/ `FALLBACK`（provider 降级）。
- **错误归一化**：所有失败按 `LlmErrorCategory` 归一（CAPACITY/NETWORK/PROVIDER/AUTH/ABORTED_BY_USER/INTERNAL），langfuse 可观测。
- **langfuse 闭环**：invoke 内部成功 `endGenerationOk` / 失败 `endGenerationError`，不再纯静默。

**理由（D2/D3）**：
- **D2**：reuse LlmCaller adaptive retry 全套是最低成本获得「跨 provider 韧性」的方式（thinking 截断 / 限流 / 抖动全覆盖）。`backgroundPath:true` 仅排除 capacity 类防雪崩——auto-naming 是后台任务，不应在 rate_limit/overload 时反复重试拖垮 provider。
- **D3**：baseReq 完全不传 params（temperature:0 也不留——名字每次一样不一样无所谓），maxTokens/temperature 全复用 session/model 配置。v0.0.64 的 maxTokens=1024 兜底退役——thinking 模型 budget 由 `model.capabilities.maxOutputTokens` 自然兜底，不再需要起名场景特判。

**代码**：`app/server/src/agent/auto-naming-service.ts:applyAiName()`（line 138-199）+ `build_invoke_context.ts` + `llm_caller.ts:invoke`。

**spec**：`specs/tech/agent/auto_naming/[P0]auto_naming_service.md §1` + `§3` + `§4`。

## §2 langfuse 观测接线

### 2.1 独立 trace + generation（fire-and-forget 后台任务）

起名启**独立 trace**（无父 trace，不挂主 run 的 trace 链）+ 1 个 GENERATION 观测：

```typescript
const trace = adapter.startTrace({
  id: `auto-naming-${sid}-${Date.now()}`,
  sessionId: sid,
  name: 'auto_naming',   // langfuse 检索关键字
  input: [{ id: 'auto-naming-input', sessionId: sid, role: 'user', content: [...] }],
  metadata: { runId: `auto-naming-${sid}`, sessionId: sid, inputMessageIds: [], modelId, toolNames: [] },
});
const gen = adapter.startGeneration({ parent: trace, model: modelId, input: {...}, startTime: new Date() });
const port = createLangfuseObservabilityPort({ adapter, genHandle: gen, iteration: 0, step: 0, model: modelId });
```

**AT langfuse oracle 检索约定**：`name === 'auto_naming'` + `metadata.sessionId === sid` + 1 个 GENERATION event（`model === config.modelId`）。起名 SDK batch flush 周期较长，AT poll window **必须 ≥40s**（`langfuse_wait_for_trace` bounded poll，禁固定 sleep）。

### 2.2 observability 真源 = deps 注入（D5，AT 加固不变量）

**change_plan 列了**：observability 复用 SessionConfig 已注入的 adapter（D2 行注释「MUST observability 复用 SessionConfig 已注入的 adapter」）。

**AT round1 暴露**：实现按 change_plan 写 `config.observability ?? noopAdapter`，起名功能 pass 但 langfuse **无 trace**。根因坐实：`resolveConfigBySid(sid)` 返的 `SessionConfig` 来自 `buildSessionConfigFromDeps`（`handlers/session-config.ts` return 块），**该 return 不含 observability 字段** → `config.observability === undefined` → 落 `noopAdapter` → langfuse 永远接不上。observability 注入只在 `AgentManager.activate`（`agent-manager.ts:227` 的 `configWithObs`，主 run 路径）里做；起名 `applyAiName` **不走 activate** → 拿到的 config.observability 永远 undefined。

**修复（D5）**：
- `AutoNamingServiceDeps` 加 `observability?: ObservabilityAdapter`。
- bootstrap（`bootstrap.ts:815-821`）传 `observability: observabilityManager`（与 `AgentManager` 同源实例）。
- `applyAiName`/`startGeneration` 用 `this.observability`（deps 注入），**永远不读** `config.observability`。

**不变量**：起名 observability 真源 = `this.observability`（deps 注入）。新增任何起名相关 observability 接线时，**第一步**确认用 `this.observability` 而非 `config.observability`——误用必致 langfuse 静默断流（功能仍 pass，无报错，只能 AT langfuse oracle 抓到）。

**代码**：`auto-naming-service.ts:AutoNamingServiceDeps.observability`（注释里有完整说明）+ `bootstrap.ts:815-821`（装配点）+ `agent-manager.ts:227 activate.configWithObs`（对照：主 run 注入点）。

**spec**：`specs/tech/agent/auto_naming/[P0]auto_naming_service.md §6`（§6.1 真源 + §6.2 trace 命名 + §6.3 失败归一）+ `index.md §④` 核心原则 #4。

## §3 不变（D4，确认 spec 不变）

change_plan §「不改」全部保留，实现一致：

- **`triggerIfFirstQuery` gate**：首条 query（`store.getMessages(sid, {limit:200})` 扫 transcript 无 prior `role=user`）+ `titled!==true` + playground scope（`biz==='playground' && derivation!=='subagent'`）触发，**逻辑不变**（不补起名，失败由用户手动改名）。
- **CAS**：`applyAiName` re-read `store.getSession(sid)` → `if(latest.titled === true) return` 才回写 AI 名（用户已改名 `titled=true` 则丢弃）。
- **fire-and-forget**（外层 `.catch(()=>{})`，不阻塞主 run）+ `extractPlainName` 净化 + playground scope gate / `limit=200` 兜底全保留。
- 触发点 `session-messages.ts:handleMessagesPost` 内（约 line 167 后、deliverTo 前）不动。

**spec**：`specs/tech/agent/auto_naming/[P0]auto_naming_service.md §2`（gate）+ `§3`（CAS）+ `§7`（POST/PUT 协作）。

## §4 验证结果

- **typecheck** 绿。
- **UT**：36/36 pass（含 2 个 bug-fix case：observability 接线 + langfuse trace 真现）。
- **AT（真 LLM + 真 langfuse）**：basic + cas 2/2 = 100%，无阻塞。
  - `auto_naming_basic`：起名功能 pass（title="Python快速排序实现" titled=true）+ langfuse oracle trace 真现（poll window 加长 15s→40s 覆盖 SDK batch flush）。
  - `auto_naming_cas`：AI 名返回前用户改名 → CAS fail → AI 名丢弃 → 用户名保留。

## §5 影响面

- **跨模块**：agent（`auto-naming-service.ts`）+ bootstrap 装配点。不碰 handler/store/前端/HTTP 契约。
- **无破坏性变更**：triggerIfFirstQuery/gate/CAS/触发点/HTTP 契约全保留，外部行为契约不变（仍是「首条 query fire-and-forget 起名，CAS 保护」），仅内部 LLM 调用链路升级。
- **依赖顺序**：底层 `LlmCaller.invoke` 已存在（v0.0.25 起），本版本只消费它，不动它。
