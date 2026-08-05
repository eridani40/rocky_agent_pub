---
type: interface
title: LLM Client Interface（4 件套组合层）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.3
related: [[P0]llm_provider_interface.md, [P0]llm_protocol_interface.md, [P0]llm_model_interface.md]
---

# LLM Client Interface

> 管什么：把 4 件套**组合**起来发起真实调用（I/O + 编排 + 参数校验 + 成本计算 + token 计数）：`providerConfig`（数据）+ `provider`（代码）+ `protocol`（代码，自承载 path）+ `modelConfig`（数据）。
> 不管什么：凭证/header 数据与行为（→ `[P0]llm_provider_interface.md`）、请求翻译与 path/contentType 自承载（→ `[P0]llm_protocol_interface.md`）、模型属性（→ `[P0]llm_model_interface.md`）。
> 边界归属规则见 [docs_guide.md](../../docs_guide.md) §4。

## 1. 概述

provider / protocol / modelConfig 的接口（含各自的数据与行为契约）是**声明层**，各自不发起调用。`LlmClient` 是**组合层 / use 层**：构造时绑定 **4 件套**（2 个数据：`providerConfig` + `modelConfig`；2 个代码 ext impl：`provider` + `protocol`），暴露 `call()` / `stream()` 完成一次真实的 HTTP 调用。**token 真实值由 LLM 返回**（UsageBlock，见 agent_message_interface §2），LlmClient 不估算 token；context window 估算（char×ratio）归 ContextEngine（见 context_usage_detail §4）。

它是本模块的入口：调用方 `new LlmClient(providerConfig, provider, protocol, modelConfig)` 绑定一次，之后多次调用。

> **4 件套**：`providerConfig`（app_config per-instance 数据）+ `provider`（`llm_provider` ext impl，无状态代码）+ `protocol`（`llm_protocol` ext impl，无状态代码、自承载 path/contentType）+ `modelConfig`（app_config 数据）。**没有第 5 件 protocolConfig**——path/contentType/paramFields 自承载在 protocol impl 里（见 `[P0]llm_protocol_interface.md` §3.1）。**tokenizer 已移除**——token 估算用 char × ratio（per-session，归 ContextEngine，见 context_usage_detail §4），client 不持 tokenizer。

## 2. 接口定义

> **[v0.0.10 scope]**：`call()`（computeCost/validate/currency）**已在 `app/server/src/llm/client.ts` 落地**——返回前填 `resp.usage.cost = this.computeCost(resp.usage)` + `resp.usage.currency = this.modelConfig.pricing.currency`；`validate(request)` 用 modelConfig 校验 temperature/topP/maxTokens/输入模态。
>
> **[v0.0.13 S3 修订]**：**stream 路径补 cost/currency 闭环**（之前缺口：stream 透传 `usage` 事件但 cost/currency 零赋值）。规则见 §2 stream 边界 + §3.7。outputCharCount 口径归 client（stream 路径的 StreamConsumer 累积，**纯 TextBlock 字符数**，见 `../session/[P0]session_usage.md §1` [D3.1]）。

```typescript
/**
 * [v0.0.25 BUG-001] LlmClient 可选注入点（类比 fetchImpl 注入点）。
 * onWire: prepare（encode + header 组装）后、fetch 前触发，记最终 wire body + url。
 * 用途：langfuse 物理层「physical wire body」metadata，做逻辑 input（snapshotMessages）vs 物理 body diff 对账。
 */
interface LlmClientOptions {
  fetchImpl?: typeof fetch;
  /** 物理层 wire body 钩子（stream + call 两路同源） */
  onWire?: (req: CanonicalRequest, body: WireBody, url: string) => void;
}

class LlmClient {
  constructor(
    private providerConfig: LlmProviderConfig,   // 数据（app_config provider 实例）
    private provider: LlmProvider,               // 代码（llm_provider ext impl，无状态）
    private protocol: LlmProtocol,               // 代码（llm_protocol ext impl，自承载 path/contentType）
    private modelConfig: LlmModelConfig,         // 数据（app_config providers.models[] 一条）
    private options?: LlmClientOptions,          // [v0.0.25] 可选注入点（fetchImpl + onWire）
  ) {}

  async call(request: CanonicalRequest): Promise<CanonicalResponse> {
    this.validate(request);
    const url = this.providerConfig.baseUrl + this.protocol.path;        // path 来自 protocol impl
    const headers = {
      ...this.provider.buildAuthHeaders(this.providerConfig),            // 行为读 config 凭证
      "Content-Type": this.protocol.contentType,                         // contentType 来自 protocol impl
    };
    const body = this.protocol.encode(request);                          // 不再传 config
    // [v0.0.25 BUG-001] 物理层 wire body 钩子：prepare 后 fetch 前，记最终 wire body（确诊 tool result 可见性）
    this.options?.onWire?.(request, body, url);
    const wire = await http(url, headers, body);
    const resp = this.protocol.parse(wire);
    resp.usage.cost = this.computeCost(resp.usage);
    resp.usage.currency = this.modelConfig.pricing.currency;
    return resp;
  }

  async *stream(request: CanonicalRequest): AsyncIterable<StreamEvent> {
    this.validate(request);
    const url = this.providerConfig.baseUrl + this.protocol.path;
    const headers = {
      ...this.provider.buildAuthHeaders(this.providerConfig),
      "Content-Type": this.protocol.contentType,
    };
    const body = this.protocol.encode(
      { ...request, params: { ...request.params, stream: true } },
    );
    // [v0.0.25 BUG-001] 物理层 wire body 钩子（stream 路径同 call 路径）
    this.options?.onWire?.(request, body, url);
    for await (const chunk of httpStream(url, headers, body)) {
      for (const evt of this.protocol.parseStream(chunk)) {
        // [v0.0.13 S3] stream 路径 cost/currency 闭环：
        // protocol.parseStream 产出的 { type:"usage" } 事件只含 LLM 返回的 token 字段，
        // cost/currency 未填 → client 在 yield 前补齐（与 call() 同源 computeCost + pricing.currency）。
        if (evt.type === "usage") {
          evt.usage.cost = this.computeCost(evt.usage);
          evt.usage.currency = this.modelConfig.pricing.currency;
        }
        yield evt;
      }
    }
  }

  // 注：LlmClient 不提供 countTokens —— token 真实值由 LLM 返回（UsageBlock），
  //     context window 估算（char × ratio）归 ContextEngine（见 context_usage_detail §4）。

  /** 上下文窗口上限 = modelConfig.contextWindow */
  get contextWindow(): number {
    return this.modelConfig.contextWindow;
  }

  // 用 modelConfig 校验请求，违反则抛错
  private validate(request: CanonicalRequest): void {
    // temperature / topP 落在 modelConfig.paramConstraints 范围内
    // maxTokens ≤ modelConfig.maxOutputTokens
    // 输入模态 ⊆ modelConfig.inputModalities
  }

  // 用 modelConfig.pricing 算 cost
  private computeCost(usage: Usage): number {
    const p = this.modelConfig.pricing;
    let cost = 0;
    cost += usage.input_no_cache * p.inputPerMillion / 1e6;
    cost += usage.output_total_tokens * p.outputPerMillion / 1e6;
    if (p.cacheReadPerMillion)  cost += usage.input_cache_read * p.cacheReadPerMillion / 1e6;
    if (p.cacheWritePerMillion) cost += usage.input_cache_write * p.cacheWritePerMillion / 1e6;
    return cost;   // 原币种；折算见 §3.5
  }
}
```

### 调用方使用

```typescript
const client = new LlmClient(providerConfig, provider, protocol, modelConfig);
const resp = await client.call({
  modelId: modelConfig.modelId,
  messages: [...],   // 含 role:"system" 的 system message（若需）
  params: { temperature: 0.7, maxTokens: 1024 },
});
```

## 3. 设计决策

### 3.1 独立成文件：声明层与组合层分离

**结论**：client 单独成文件，不塞进 protocol。
**理由**：provider/protocol/model 是正交的声明（各自可独立演化、独立单测），client 是它们的组合点，把组合逻辑放进任一声明文件都会让该文件职责膨胀；独立后"声明 3 + 组合 1"边界清晰。
**反例**：若 call 放 protocol，protocol 既做纯翻译又做 I/O 编排，无法脱离网络单测。

### 3.2 I/O 与编排归 client，protocol 只做纯翻译

**结论**：HTTP 调用、header 组装、流式迭代归 client；protocol 的 encode/parse/parseStream 是纯函数，不碰网络；URL = `providerConfig.baseUrl + protocol.path`、Content-Type = `protocol.contentType`（path/contentType 自承载在 protocol impl，不再读数据对象）。
**理由**：纯函数可单测、可在不同 transport 复用；I/O 集中在 client 便于统一处理重试/超时。
**反例**：让 protocol 一个方法连 HTTP 一起干，会迫使 protocol 依赖 provider 与 I/O。

### 3.3 modelConfig 在 client 里用于校验与计费

**结论**：`validate()` 用 `modelConfig.paramConstraints` / `maxOutputTokens` / `inputModalities`；`computeCost()` 用 `modelConfig.pricing`。
**理由**：声明层 modelConfig 不主动做事，由 client 在调用边界消费其约束——校验前置避免无效请求，计费后置填入 `Usage.cost`。
**反例**：校验散在各调用点会重复；计费放进 protocol 会引入模型依赖。

### 3.4 LlmClient 是唯一门面，封装 4 组件

**结论**：4 件套（`providerConfig` 数据 + `provider` 代码、`protocol` 代码 + `modelConfig` 数据）只在 `new LlmClient(...)` 构造时进入，之后被封装；门面绑定 4 组件，消费方只持 LlmClient。消费方（agent / context engine）需要 modelConfig 信息（contextWindow / pricing / modalities）通过 client 暴露的属性获取（`client.contextWindow`），**不裸传 modelConfig/provider/protocol/providerConfig**。token 估算（context window）归 ContextEngine 用 per-session ratio，不经 client（见 context_usage_detail §4）。
**理由**：单一入口 = 单一依赖点；换任一组件的实现或数据（换凭证、换 path、换模型）不影响消费方；token 计费/校验/计 token 同源（都消费 modelConfig），集中在 client 一致。
**反例**：若消费方各自持有裸 modelConfig，会出现 token 计算口径漂移、且 modelConfig 与 client 内不一致；若 config 与行为分离后不在门面统一绑定，调用方需自己组合 4 件套，组合错配风险高。protocol 不再单独带 config（path/contentType 自承载在 impl 里），消除了"protocol config 与 protocol impl 不匹配"的一类错配。

### 3.5 货币折算

**结论**：`computeCost` 按 `modelConfig.pricing.currency`（CNY 或 USD）产出原币种 cost 并写入 `Usage.currency`；若需统一币种汇总，由上层按汇率折算，client 不内置汇率（见 `convention.md` §5）。
**理由**：client 不应耦合汇率数据源；币种归属见 `[P0]llm_model_interface.md`。

### 3.7 stream 路径 cost/currency 闭环（v0.0.13 S3）

**结论**：`stream()` 在 yield `StreamEvent` 前，对 `{type:"usage"}` 事件就地补齐 `usage.cost = computeCost(usage)` + `usage.currency = modelConfig.pricing.currency`（与 `call()` 同源同口径）。之前缺口：parseStream 产出的 usage 事件只带 token 字段，cost/currency 零赋值（agent loop stream 路径走该事件 → accumulateUsage / session_usage_update 全程 cost=0）。
**理由**：stream 与 call 是同一 LlmClient 的两条等价调用路径，cost/currency 必须同源；否则 stream-only 调用方（agent loop 默认走 stream）永远拿不到 cost。client 是唯一持有 `modelConfig.pricing` 的组合层（§3.3），补齐职责归它。
**反例**：若由 agent loop / StreamConsumer 补 cost，则消费方需裸持 modelConfig（违反 §3.4 门面原则）；若由 protocol impl 补，则引入 model 依赖（违反 protocol 纯翻译）。
**口径**：token 字段全部来自 protocol.parseStream 映射的 wire usage（见 `llm_protocol_interface.md §3`）；cost/currency 由 client 补；char 字段（`inputCharCount`/`outputCharCount`）归 agent loop（从 `snapshot.inputCharCount` / StreamConsumer 累积，见 `../session/[P0]session_usage.md §1` [D3.1]），client 不填 char。

### 3.6 LlmClient 的构造与生命周期

**结论**：LlmClient 由一个 **factory**（在 plugin 激活 / 首次需要时）按 **app_config（provider 实例 + modelConfig）+ ext impl（provider/protocol 代码）+ ext_impl_config overlay** 组装并构造；按该组合**缓存复用**（同组合返回同实例）、**不可变共享**。LlmClient 一旦构造即**不可变**（绑定的 4 组件只读），故**可跨 session / run 共享**，async 并发调用安全（无可变状态）。
**理由**：组合本身无副作用、构造廉价（只存引用），按组合缓存避免重复构建；不可变 ⇒ 天然并发安全，无需锁。消费方（agent）持有一个 LlmClient 句柄即可，不关心它是否被复用。
**反例**：若每次调用新建 LlmClient，重复构建、浪费；若做全局单一 singleton，则不同 (provider,protocol,model) 组合无法区分。按组合缓存的不可变共享对象是折中。

### 3.8 物理层 onWire 钩子（v0.0.25 BUG-001）

**结论**：`LlmClientOptions.onWire?(req, body, url)` 在 `protocol.encode` 产出最终 wire body 后、`fetchImpl` 调用前触发（call + stream 两路同源注入点）。挂载点：`call()` 内 `const body = this.protocol.encode(request);` 之后 `await http(...)` 之前；`stream()` 内同样位置。
**理由**：BUG-001 确诊前置 —— langfuse 当前记**逻辑层** input（`snapshotMessages`），与**物理层** wire body 间无对账机制，导致 tool result 显示 `...` 难定位（server 代码层已排除截断，可能来自第三方网关 / BUG-002 422 / 前端）。onWire 钩子记 encode 产出的最终 wire body（含 tool_result content 原文），挂 langfuse generation 作「physical wire body」metadata，做逻辑 vs 物理 diff 对账。
**为什么归 client 不归 protocol**：protocol 是纯翻译（无 I/O），onWire 是「翻译完、要发出去前」的观测点，归 client（I/O 编排层）。类比 fetchImpl 注入点 —— onWire 是同一类可选注入钩子。
**为什么是可选注入**：默认不挂（生产可关，避免记大 body 占空间）；langfuse adapter 启用时注入 onWire，记 body 进 generation metadata。
**反例**：若由 LlmCaller / agent loop 记，拿不到 encode 后的最终 body（protocol.encode 是纯函数但调用点在 client 内）；若由 protocol impl 记，引入 I/O 副作用破坏纯翻译。
**langfuse error 补全**（v0.0.25 PRD §4.9）：LlmCaller.invoke 的 catch 块在所有 throw 前调 `observability.endGeneration({status:"error", errorCategory: classified.category})`（category 记进 metadata）。client 自身不调 endGeneration（client 不持 observability 端口，归 LlmCaller）。

### 3.9 非 2xx 抛 LlmHttpError（v0.0.25 BUG-004 Critical 修复）

**结论**：`call()` / `stream()` 在 `await http(...)` 后判定响应非 2xx 时，**抛 `LlmHttpError extends Error`**（携 numeric `status` + `body?` + `headers?`，保留 `.message`）。落点 `app/server/src/llm/http_error.ts`；抛出点 `app/server/src/llm/client.ts` call 路径 line ~124 + stream 路径 line ~159（`throw await buildHttpErrorFromResponse(resp)`）。

**理由（BUG-004 根因）**：v0.0.8 旧实现 `throw new Error(stringifiedBody)` 把 HTTP status 当字符串拼进 `.message` 丢了——下游 classifier 的 `asWireResponse` 探测 `typeof e.status === 'number'` 返 null → 兜底 `NETWORK`（可重试）。后果：v0.0.25 全部 HTTP 错误分类塌缩 NETWORK（401 不再 AUTH_INVALID、429 不再 RATE_LIMITED、529 不再 PROVIDER_OVERLOADED），adaptive retry / provider 降级 / length 处理整条链失效。UT 全绿（绿在 mock fetch 不走 throw 路径，绕开了 bug），真服务 AT 暴露（401 端到端测试发现 category 误标 NETWORK）。经 langfuse oracle 证明修复后 401→AUTH_INVALID 复活。

**为什么 `extends Error` 而非新独立类型**：保留 `.message` 向后兼容——agent loop SSE error event 透出 `.message`、log 打 `.message`、上层 catch `instanceof Error` 全部不动。`LlmHttpError` 只**加**结构化字段，不破坏既有 catch 契约。

**字段口径**：
- `status: number`：HTTP status code（asWireResponse 命中字段，必须 number 不能 undefined）。
- `body?: unknown`：原始响应体（优先 JSON parse 后对象，parse 失败留 text 字符串），供 adapter 抽 `error.type`。
- `headers?: Record<string,string>`：lowercase key（`responseHeadersToRecord` 统一小写化，跨网关兼容；adapter 的 `parseRetryAfter` 查 `'retry-after'`）。

**反例**：若由 LlmCaller / agent loop 拼错误，拿不到原始 `Response` 对象（已被 client 消费）；若由 protocol impl 拼，引入 I/O 副作用破坏纯翻译。`buildHttpErrorFromResponse(resp)` 是 client 内部 helper（消费 `Response` 读 status/body/headers 构造 LlmHttpError）。

**已知边缘**（BUG-005，~~open / Low-Med~~ → **[v0.0.25 改版] 收口**）：`client.validate()` 对参数越界抛**裸 `Error(string)`**（无 status）→ 落 NETWORK 可重试 → misconfig 白重试。**v0.0.25 改版收口方案**：`validate()` 抛可被 classifier 归类为对应 category 的 error，不再裸 Error→NETWORK：
- **maxTokens 越界**（`request.params.maxTokens > modelConfig.maxOutputTokens`）→ 抛带 `category: MAX_TOKENS_TOO_HIGH` 提示的 error（classifier 识别 → retryable + buildRequest 降 ×0.7 重试，见 `[P0]error_normalization §1 §6.6` + `[P0]llm_request_config §2.4`）。实现选项：抛 `LlmHttpError` 形态 `{status:400, body:{message:"max_tokens X exceeds model max Y"}}`（classifier 的 400 max_tokens 行命中 → MAX_TOKENS_TOO_HIGH）。
- **temperature / topP 越界**（`paramConstraints` 范围外）→ 抛 `LlmHttpError` 形态 `{status:400, body:{message:"temperature X out of range"}}`（classifier 400 其他 → `BAD_REQUEST_OTHER`，NO_RETRY）。
- **输入模态不支持**（如 model 只接 text 但 request 含 image）→ 同 `BAD_REQUEST_OTHER`（NO_RETRY）。

**为什么 maxTokens 走 MAX_TOKENS_TOO_HIGH 而非 BAD_REQUEST_OTHER**：rocky_agent 是多 provider/model 用户自配系统，用户配 `maxOutputTokens=4096` 但 session 输出预算 `DEFAULT_MAX_OUTPUT_TOKENS=20000` 是常见 misconfig；降 ×0.7 重试（而非 NO_RETRY）能在用户不重启 session 的情况下自适应恢复（20000 → 14000 → 9800 → ... 直到 ≤ 4096）。temperature/topP 越界则是真正不可恢复的 misconfig（用户必须改 config），NO_RETRY 合理。

**实现落点**：`app/server/src/llm/client.ts` `validate()`（line ~207-231）改抛 `LlmHttpError`（复用 §3.9 的 error 类型，不新增类型）；classifier 无需改（400 max_tokens 行已映射 MAX_TOKENS_TOO_HIGH，400 其他行已映射 BAD_REQUEST_OTHER）。详见 `../llm_caller/[P0]llm_caller.md §7` BUG-005 段。

## 4. 示例

```json
// 一次 call 的产出（CanonicalResponse）
{
  "message": {
    "id": "01KVC9D8...",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "图里是一只猫。" }
    ]
  },
  "usage": {
    "input_no_cache": 320, "input_total_tokens": 320,
    "output_response": 12, "output_total_tokens": 12,
    "total_tokens": 332, "cost": 0.00114
  },
  "stopReason": "stop"
}
```

## 5. 边界

| 零件 | 归属 |
|------|------|
| HTTP 调用、header 组装、流式编排 | 本文件 ✅ |
| 物理层 wire body 钩子（onWire，§3.8） | 本文件 ✅ |
| 非 2xx 抛 LlmHttpError（携 numeric status，§3.9 BUG-004） | 本文件 ✅ |
| 参数校验、成本计算（消费 modelConfig；**stream + call 两路同源**，§3.7） | 本文件 ✅ |
| token 估算（context window，char × ratio） | context（context_usage_detail §4） |
| `providerConfig.baseUrl` + `provider.buildAuthHeaders(providerConfig)` | `[P0]llm_provider_interface.md` |
| `protocol.path` + `protocol.contentType` + `protocol.encode/parse/parseStream`（均自承载在 protocol impl） | `[P0]llm_protocol_interface.md` |
| `pricing` / `paramConstraints` / `maxOutputTokens` / `inputModalities` | `[P0]llm_model_interface.md` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
