# v0.0.25 LlmCaller 架构改版（rev2）— 详细变更

> 本文是 v0.0.25 LlmCaller 框架 rev2 改版的**详细变更附录**，收纳 4 块改动中超出 300 行限制的细节内容。各 P0 spec（`specs/tech/agent/llm_caller/*` + `providers_and_models/[P0]llm_client_interface.md` + `agent_interface_and_loop/[P0]agent_loop_base.md`）只保留**接口契约 + 设计决策核心**，详细伪代码 / 映射表 / 大段示例引用本文。
> 权威变更（4 块）：① 错误状态 recentErrors + 派生 maxTokens（→ `[P0]llm_request_config §2`）；② 降级顺序 + cooldown scope（→ `[P0]provider_health_registry §2` + `[P0]llm_caller_overview §2.2`）；③ 错误外显 + finish_reason 后端机制（→ 本文 §3 + `[P0]agent_loop_base §9`）；④ validate() BUG-005 收口（→ `[P0]llm_client_interface §3.9`）。

---

## 1. errorCategory → displayReason 完整映射表（block ③ 权威）

`deriveDisplayReason(err: ClassifiedLlmError): string` 按 category 派生用户可读理由（context 可微调文案，但 category 是权威分类）。caller 可选读 displayReason 直接显示，或读 errorCategory 自定义文案。

| errorCategory | displayReason（用户可读） | 备注 |
|---|---|---|
| `AUTH_INVALID` | 「认证失败，请检查 API Key」 | 401 key 失效 |
| `AUTH_FORBIDDEN` | 「API Key 无权限或地域受限」 | 403 |
| `RATE_LIMITED` | 「模型限流，请稍后重试」 | 429 |
| `PROVIDER_OVERLOADED` | 「服务商过载，请稍后重试」 | 529 / overloaded |
| `SERVER_ERROR` | 「服务商内部错误」 | 500/502/503 |
| `NETWORK` | 「网络错误，请检查网络连接」 | fetch throw |
| `TIMEOUT_FIRST_CHUNK` | 「响应超时」 | TTFB 超 |
| `TIMEOUT_INTER_CHUNK` | 「响应超时」 | stall 超 |
| `STREAM_INCOMPLETE` | 「响应流中断」 | 流断 |
| `EMPTY_RESPONSE` | 「模型返回空响应」 | [v0.0.25] 流 finish 但空 |
| `MAX_TOKENS_TOO_HIGH` | 「输出长度超限（请求参数越界）」 | [v0.0.25] 请求越界（降） |
| `MAX_TOKENS_EXCEEDED` | 「输出达到模型上限」 | 触顶（升） |
| `CONTEXT_LENGTH_EXCEEDED` | 「上下文过长且压缩失败」 | |
| `CONTENT_FILTERED` | 「内容被审核拒绝」 | |
| `MODEL_NOT_FOUND` | 「模型不存在或未配置」 | |
| `MALFORMED_TOOL_CALL` | 「模型工具调用格式错误」 | |
| `BAD_REQUEST_OTHER` | 「请求参数错误」 | 400 其他 |
| `ABORTED_BY_USER` | （不走 error 路径，stopReason=interrupted，不填 RunErrorInfo） | 用户中断 |

**实现要点**：
- `deriveDisplayReason` 是纯函数（category + 可选 context → string），易单测。
- displayReason 是 i18n 候选（v0.0.25 默认中文，后续 locale 切换时按 category 查表）。
- errorDetail 字段是 raw provider message（如 `"max_tokens: 20000 exceeds model max 4096"`），给 debug tooltip / log，不直接给终端用户。

---

## 2. resolveTarget 两遍扫描完整伪代码（block ② 权威）

`[P0]llm_caller_overview §2.2` 只列签名 + 简化伪代码，完整版在此：

```typescript
function resolveTarget(
  sessionId: string,
  chain: FallbackChainItem[],
  health: ProviderHealthRegistry,
  errorState: LlmErrorState,
): { provider; key; model; client } | { kind: "all_dead"; reason: string } {
  const seen = new Set<string>();   // (providerId, modelId, baseUrl) dedup —— 避免切回死路（hermes 教训）

  // ── 第 1 遍：优先选 healthy（isPreferred=true 仅当 healthy） ──
  for (const item of chain) {
    const provider = loadProvider(item.providerId);
    const key = resolveKey(provider.credentials, item.keyRef);   // account-wide quota 例外见 provider_health_registry §4
    const model = findModel(provider, item.modelId);
    const dedupKey = `${item.providerId}|${item.modelId}|${provider.baseUrl}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const probe = health.isPreferred(sessionId, item.providerId, item.keyRef, item.modelId);
    if (probe.ok) {
      return { provider, key, model, client: getClient(provider, key, model) };
    }
    // degraded / cooled_down / dead → 第 1 遍跳过（留给第 2 遍）
  }

  // ── 第 2 遍：兜底选 healthy 或 degraded（isAvailable=true） ──
  seen.clear();   // 重置 dedup（第 2 遍独立计）
  for (const item of chain) {
    const provider = loadProvider(item.providerId);
    const key = resolveKey(provider.credentials, item.keyRef);
    const model = findModel(provider, item.modelId);
    const dedupKey = `${item.providerId}|${item.modelId}|${provider.baseUrl}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const probe = health.isAvailable(sessionId, item.providerId, item.keyRef, item.modelId);
    if (probe.ok) {
      // healthy 或 degraded → 兜底可用（degraded 是有过失败的降级态，但仍能调用）
      return { provider, key, model, client: getClient(provider, key, model) };
    }
    // cooled_down (未到期) / dead → 跳过（cooled_down 尊重 until；dead 排除）
  }

  return { kind: "all_dead", reason: "all fallback chain items dead or cooled_down" };
}
```

**关键规则**：
- **chain 顺序**：正式项 > backup 项（fallback_chain config 中数组顺序即优先级）。
- **dedup**：两遍各自独立 dedup（同 (providerId, modelId, baseUrl) 三元组只试一次，避免切回死路）。
- **cooled_down 处理**：两遍都跳过（尊重 until 冷却窗口，不提前回探；half-open defer 见 `[P0]provider_health_registry §6.2`）。
- **全 dead / 全 cooled_down**：返 `all_dead`，invoke throw ClassifiedLlmError（lastError 的 category）。
- **fallback_chain 为空**：用调用方（agent loop）传入的单一 provider/model（向后兼容，仍走两遍扫描但 chain 只有一项）。

---

## 3. Run finish_reason 收尾机制（block ③ 权威 — agent_loop_base §9 改版细节）

`[P0]agent_loop_base.md §9` 的 StopReason 联合中 `"error"` 分支在 v0.0.25 改版后携带 `RunErrorInfo`。完整收尾流程：

```typescript
// agent loop run 主循环（伪代码，eager-drain / forked 各自实现收尾）
try {
  while (!done) {
    const llmResp = await callLLM(...);   // 内部走 llmCaller.invoke
    // ... tool 执行 / 退出条件判定 ...
  }
  runState.stopReason = "no_tool_call" | "max_iterations" | "doom_loop" | ...;
} catch (err) {
  const classified = err as ClassifiedLlmError;
  if (classified.category === LlmErrorCategory.ABORTED_BY_USER) {
    runState.stopReason = "interrupted";   // 用户 abort 走 interrupted，不走 error
  } else {
    runState.stopReason = "error";
    runState.error = {
      errorCategory: classified.category,
      displayReason: deriveDisplayReason(classified),                    // 见本文 §1 映射表
      errorDetail: classified.rawError?.message ?? classified.message,   // raw provider message
    };
  }
} finally {
  emit run_end({ stopReason: runState.stopReason, error: runState.error });
  // observability.endTrace({ stopReason, errorCategory: runState.error?.errorCategory })
}
```

**RunRecord 持久化**（eager-drain）：RunRecord 落 SessionStore 时 `error` 字段同 RunErrorInfo 形态序列化；`GET /session/:id` 响应可读 `currentRun.error` 或历史 run 的 error。forked 不落 RunRecord（旁路），error 仅在 emit / log。

**SSE error 事件**（v0.0.25 改版后形态，见 `specs/api/version_logs/v0.0.25/change_log.md §1.2`）：

```json
{
  "type": "error",
  "errorCategory": "PROVIDER_OVERLOADED",
  "displayReason": "服务商过载，请稍后重试",
  "message": "all fallback chain items unavailable",
  "errorDetail": "..."
}
```

**向后兼容**：`errorCategory` / `displayReason` / `errorDetail` 都是新增可选字段；旧 caller 读 `message` 仍工作（message 保留兜底文案）。`LOOP_ERROR` 不再出现（整链全 dead 按真实 lastError.category 给）。

---

## 4. 版本

version: 1.0（v0.0.25 新增本附录：收纳 LlmCaller rev2 改版 4 块详细内容——errorCategory→displayReason 完整映射表 §1 / resolveTarget 两遍扫描完整伪代码 §2 / Run finish_reason 收尾机制 §3。各 P0 spec 引用本文，自身保持 ≤300 行）。
