# v0.0.25 PRD 变更日志 — LLM 调用错误处理 / 自适应重试（llm-opt）

> 概述：**backend-only**（无 UI、无设计稿）。为 LLM 调用层补齐错误处理：错误归一化 + 带状态的 adaptive retry + provider 降级（全局健康注册表 + fallback_chain）+ 分阶段超时（TTFB / 阶段 stall / wall-clock）+ length 处理（prefill 续写 / max_tokens bump）+ `llm_request` config 组接线 + langfuse error 路径补全 + 物理层 wire body 记录 + anthropic role=tool 协议修复。让 LLM 调用遇到 429/overload/auth/超时/length 等错误时**自适应地重试、换 key/provider、改参数**，而非直接塌缩成 `LOOP_ERROR`。
> 权威输入：`reqs/v0.0.25/reqs.md`；调研：`specs/research/v0.0.25-llm-error-handling/`（4 文件）；关联 Bug：BUG-001（tool result 可见性 / 物理层 wire 记录）、BUG-002（anthropic role=tool 422）。
> 概念先行：本 PRD 对齐 `specs/tech/agent/providers_and_models/`（LlmClient 4 件套不可变 + provider/protocol/model interface）、`specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md`（callLLM + RunState）、`specs/tech/config/[P0]app_config.md`（KV group）。**新概念（LlmCaller / LlmErrorCategory / ProviderHealthRegistry / RunState.llmErrorState / 多 key credentials / `llm_request` group）留给 tech spec 落类内部设计、接口签名、schema**；PRD 只描述功能行为 + 系统路径 + 验收。

## 1. 用户原话与产品定位

### 1.1 用户原话要点（来自 reqs.md）

- 为 LLM 调用层补齐错误处理：错误归一化 + adaptive retry + provider 降级 + 分阶段超时 + length 处理，统一由独立 config group 管理。
- 让 LLM 调用在遇到 429/overload/auth/超时/length 等错误时，**自适应地重试、换 key/provider、改参数**，而不是直接塌缩成 `LOOP_ERROR`。
- 「服务器 overload 我们还是继续」= P1 冷却 → 取 P2 → 请求完成；整链全 dead 才真失败。
- **错误状态记在 loop 的 RunState**（非 LlmCaller 局部、非仅 Session）：每个 iteration 调 LLM 时 `buildRequest` 能跨 retry 修改实参（attempt1 max_tokens=20000 → 命中 MAX_TOKENS → attempt2 改 30000；下一 iteration 继承 overlay）。
- 429/overload 是 **(provider,key) 的属性**，冷却窗口必须**全局共享**，否则每个 session 各自重试各自踩坑。
- 用户 abort = 保留 partial、不重试；看门狗超时 abort = 丢 partial 重试。
- 物理层 wire body 记录（BUG-001 确诊前置）+ anthropic role=tool 协议修复（BUG-002）。

### 1.2 产品定位

| 维度 | v0.0.24（既有） | v0.0.25（本版） |
|------|----------------|-----------------|
| LLM 调用错误 | 零重试、零退避、零超时、零熔断、零归一化；所有错误塌缩 `LOOP_ERROR` | 归一化分类 + adaptive retry + provider 降级 + 分阶段超时 + length 处理 |
| provider 健康 | 每 session 各自重试各自踩坑 | 进程级 `ProviderHealthRegistry` 跨 session 共享冷却/状态升级 |
| 错误可观测 | langfuse 仅逻辑层 input，throw 后可能漏 `endGeneration` | 物理层 wire body 记录 + langfuse error 路径补全 + category 入 generation metadata |
| 配置 | 代码硬编码 | `llm_request` config 组（不配=默认，配了=按配置） |
| 兼容协议 | role=tool 直接进 wire → anthropic 端点 422（BUG-002） | encode 层 `tool→user` + tool_result block + 合并连续同 role |
| 终端用户感知 | overload/超时直接报错或卡死 | 自适应恢复，**用户无感拿到回复**（整链 dead 才明确错误上抛） |

---

## 2. 关键系统行为路径（= 测试最低覆盖要求）

> backend-only 无终端用户，用「系统行为路径」表述。每条路径 ≥1 可验收点，后续 api/e2e case 由此派生。

| # | 路径 | 覆盖要点 | 派生 case 方向 |
|---|------|---------|---------------|
| **P1** | 发消息 → provider `overloaded`/`rate_limit` → adaptive retry（指数退避 + jitter）→ 同 provider 恢复 → 用户无感拿到回复 | retry/backoff 触发 + 成功完成；langfuse 记 retry 链 | mock provider 首次 429 二次 200，断最终回复 + retry 计数 |
| **P2** | 发消息 → provider 连续 overloaded → `ProviderHealthRegistry` 升级 cooldown → `fallback_chain` 选下一个 healthy → 请求完成；整链全 dead → 明确错误上抛（带原因） | 全局健康表共享 + fallback chain 遍历 + 整链 dead 兜底 | mock P1 连续 429 → 切 P2 成功；mock 全链 fail → 断错误码 + message |
| **P3** | 发消息 → `CONTEXT_LENGTH_EXCEEDED` → 自动压缩/截断输入 → 重试成功；粘性状态：连续触发 → 下一 iteration 主动预压缩 | length 处理（输入超→压缩）+ 粘性状态跨 iteration | mock 首次 context 超长 → 触发 compact → 二次成功 |
| **P4** | 发消息 → 输出触顶 `MAX_TOKENS_EXCEEDED` → partial 可 salvage（无未完成 tool_use）+ `supportsPrefill` → prefill 续写拼接完整回复；elif `max_tokens < maxOutputTokens` → bump 重跑；else 到模型硬上限 → 上抛用户 | length 处理（输出触顶）+ prefill 续写 + bump 决策树 | mock 首次 stop_reason=length + partial text → prefill 续写完整 |
| **P5** | 流式调用 → TTFB 超 45s（首 chunk 不到）→ `TIMEOUT_FIRST_CHUNK` abort → 丢弃 partial 重试；首 chunk 后 chunk 间 stall（answer 30s / think 30s / tool 120s）→ `TIMEOUT_INTER_CHUNK` abort → 重试；wall-clock 600s → 兜底 abort | 分阶段超时看门狗 + abort 来源区分 + partial 丢弃策略 | mock stream 首 chunk 延迟 >45s → 断 abort + retry |
| **P6** | 用户主动 abort → `ABORTED_BY_USER` → 保留 partial、不重试、不影响 provider 健康；看门狗超时 abort → `TIMEOUT_*` → 丢 partial 重试 | abort 来源事前记录（user vs watchdog_ttfb/stall/wall_max） | 发请求 → 主动 abort → 断保留 partial + 不触发 retry |
| **P7** | tool 执行 → LLM 在下一 iteration 看到真实 tool result（非 `...`）→ 物理层 wire body 记录保证逻辑 input vs 物理 body 可对账（BUG-001） | 物理层 `onWire` 钩子记 wire body + 响应；langfuse generation metadata 带 wire body | tool 调用 → 读 langfuse generation metadata → 断 wire body 含真实 tool_result |
| **P8** | anthropic 协议：canonical `role:"tool"` message → encode 层转 `role:"user"` + `tool_result` block + 合并连续同 role → 端点接受（BUG-002 修复） | encodeMessage role 映射 + encodeAnthropicMessages 连续同 role 合并 | 多 tool result 连续 + tool 紧跟 user → 断 wire 不出现 role=tool + 端点返 200 |
| **P9** | 跨 iteration 错误状态继承：iteration N 命中 `MAX_TOKENS` → bump max_tokens → `RunState.llmErrorState` 记 overlay → iteration N+1 `buildRequest` 继承 max_tokens bump → 不再触顶 | 错误状态在 loop RunState，非 LlmCaller 局部 | 触发 bump 后下一轮 LLM 请求 max_tokens=30000（继承） |
| **P10** | `CONTENT_FILTERED` → 不盲重试，直接上抛用户（同输入=同拒绝+合规）；`AUTH_INVALID`/`MODEL_NOT_FOUND` → NO_RETRY 直接上抛 | 不可恢复错误直接失败 | mock content_filtered → 断不重试 + 错误码上抛 |

---

## 3. 范围

### 3.1 IN（v0.0.25 全做，不分期）

1. **归一化错误分类模块**：内部 `LlmErrorCategory`（按恢复语义分组：可重试-瞬时 / 超时 / 凭证 / 请求）；Anthropic adapter 实现完整映射列（HTTP status + `error.type` + 流内 error 事件 + 消息正则）；OpenAI/GLM adapter **仅占位**（主逻辑只认 category，后续填列不动主逻辑）。
2. **Adaptive retry（双层状态）**：层 1 单次调用循环（attempt 1..max_attempts，decide action）；层 2 粘性状态（连续 AUTH→key dead、连续 OVERLOADED/RATE_LIMIT→provider 冷却、连续 CONTEXT_LENGTH→预压缩、上次 MAX_TOKENS→调参），**必须衰减**（成功清计数、窗口/dead-key 过期恢复）。
3. **Provider 降级**：进程级全局 `ProviderHealthRegistry`（per `(provider,key)` 的 status/cooldownUntil/consecutive，状态升级 `healthy→cooled_down→degraded→dead`，到期恢复）；全局兜底链 `fallback_chain`（有序 `[{providerId, keyRef, modelId}, …]`，resolveTarget 遍历跳过 cooled_down/dead 取首个 healthy）；**「换 key」与「换 provider」统一为 fallback_chain 一项 `(provider,key,model)` 元组**（需扩 credentials 多 key）；session 级只管对话相关（连续 CONTEXT_LENGTH、最近错误原因）。
4. **分阶段超时（看门狗）**：TTFB 45s + chunk 间阶段 stall（answer 30s / think 30s / tool 120s）+ wall-clock 600s 兜底；**abort 区分**（用户=保留 partial 不重试；看门狗=丢 partial 重试）。
5. **Length 处理**：`CONTEXT_LENGTH_EXCEEDED`（输入超）→ 压缩/截断 + 粘性预压缩；`MAX_TOKENS_EXCEEDED`（输出触顶）→ 决策树（prefill 续写 / max_tokens bump / 上抛）；区分 `STREAM_INCOMPLETE`（无 stop_reason + tool args 未完成，不 bump）vs `MAX_TOKENS_EXCEEDED`（有 length stop_reason，bump）。
6. **`llm_request` config 组接线**：`timeout{ttfb_s, stall_answer_s, stall_think_s, stall_tool_s, wall_max_s}` + `retry{max_attempts, backoff_base_s, backoff_cap_s, jitter}` + `degradation{cooldown_s, consecutive_to_degrade, respect_retry_after}` + `length{auto_compress, precompress_threshold_ratio, max_tokens_bump_strategy}` + `fallback_chain[{providerId, keyRef, modelId}]`（不配=默认，配了=按配置，走 app_config）。
7. **调用编排层（`LlmCaller`）**：在 `LlmClient`（4 件套不可变共享）之上抽一层，收口 error 归一化 + retry + provider 降级 + 动态参数构建（`resolveTarget` / `buildRequest` / `invoke` / `classify+decide`）；`agent-loop callLLM` 从直接 `client.stream` 改为 `llmCaller.invoke`；`LlmClient` 本身不动。
8. **错误状态持久化**：进程级 `ProviderHealthRegistry`（内存单例，全 session 共享）；**loop RunState 级 `llmErrorState`**（本轮连续 CONTEXT_LENGTH、最近错误 `{cat,reason,at}`、参数 overlay 如 max_tokens bump / 预压缩标记）—— loop 每 iteration callLLM 读它 → `buildRequest` 算实参，跨 retry / iteration 修改实参。
9. **langfuse error 路径补全**：所有 throw 前调 `endGeneration({status:"error", errorCategory})`；category 记进 generation metadata（现 throw 后可能漏调）。
10. **物理层 wire body 记录（BUG-001 确诊前置）**：`LlmClient` 的 `prepare()` 后 / `fetchImpl` 前挂钩子（`LlmClientOptions.onWire?(req, body, url)` 类比 fetchImpl 注入点），记 `protocol.encode` 产出的最终 wire body + 响应；挂 langfuse generation 作「physical wire body」metadata，做逻辑 input vs 物理 body diff 对账。
11. **anthropic role=tool 协议修复（BUG-002）**：`encodeMessage`（canonical→wire 边界）做 role 映射 `tool → user`（库内 Message 仍 role=tool，符合 message types §1）；`encodeAnthropicMessages` 合并相邻同 role user（anthropic 要求严格交替）；**必须在 encode 层**才能覆盖 eager + forked 两条路径（forked 不走 assemble）。
12. **modelConfig 能力位**：`{ maxOutputTokens, supportsPrefill, supportsThinking }`（每模型事实，供 length 处理决策）。

### 3.2 OUT（NON-GOALS）

| 项 | v0.0.25 状态 | 理由 |
|----|------------|------|
| UI / 前端渲染层 | **不做** | backend-only；前端是否折叠 tool result（BUG-001 的 client/renderer 深查）本版不覆盖 |
| 设计稿 / 视觉保真度门禁 | **N/A** | 无设计稿 |
| OpenAI/GLM adapter 完整错误映射列 | **仅占位** | 主逻辑只认 category；Anthropic 先实现完整映射，OpenAI/GLM 后续各填一列 |
| half-open 探测恢复机制 | **defer**（MVP 到期直接回 healthy） | refs 也都没实现；可选做，v0.0.25 范围内可不做 |
| 第三方 LLM 网关截断（BUG-001 真因之一） | **确诊后再定** | 本版加物理层记录确诊 `...` 真因；若确诊是网关截断，再决定网关对接（非本版必做） |
| 后台路径 overload 抑制（summary/title 等） | **标注不实现** | refs 教训：后台路径 overload 直接 fail 不重试；v0.0.25 若有后台 LLM 调用需标注，本版不主动加 |
| credentials 持久化迁移（单 key → 多 key 的 app_config 迁移脚本） | **schema 落 tech spec，迁移脚本视情况** | 多 key credentials 的数据模型归 tech spec；本版 PRD 只要求「能配多 key」 |
| `runstate.llmErrorState` 是否随 session 落盘 | **由 arch 定** | PRD 只要求「跨 iteration 继承」；落盘与否（重启后是否保留 overlay）留给 architect |
| dead-key 是否扛重启 | **待定（懒重验亦可）** | 冷却/健康走内存（300s TTL，重启 reset 可接受）；dead-key 抗重启由 arch 细化 |

---

## 4. 功能需求（system 必须做什么）

> 类内部设计 / 接口签名 / schema 留给 tech spec（architect）。PRD 只描述功能行为 + 验收口径。

### 4.1 错误归一化（基础）

- **功能行为**：每 provider adapter 把原始错误（HTTP status + `error.type` + 流内 error 事件 + 消息文本）映射到内部统一 `LlmErrorCategory`；**重试/降级逻辑只认 category，不认 provider 细节**。
- **类别（按恢复语义分组，具体枚举值由 tech spec 定）**：
  - 可重试-瞬时：`RATE_LIMITED` / `PROVIDER_OVERLOADED` / `SERVER_ERROR` / `NETWORK` / `STREAM_INCOMPLETE`
  - 超时：`TIMEOUT_FIRST_CHUNK` / `TIMEOUT_INTER_CHUNK` / `ABORTED_BY_USER`
  - 凭证：`AUTH_INVALID` / `AUTH_FORBIDDEN`
  - 请求：`CONTEXT_LENGTH_EXCEEDED` / `MAX_TOKENS_EXCEEDED` / `CONTENT_FILTERED` / `MODEL_NOT_FOUND` / `MALFORMED_TOOL_CALL` / `BAD_REQUEST_OTHER`
- **分类与决策分离**（借鉴 hermes）：classify 只产 `ClassifiedLlmError`（携带 action hints：retryable / shouldRotateKey / shouldFallbackProvider / shouldCompressContext / shouldBumpMaxTokens），decide 读 hints。Anthropic adapter 改 category 映射列时主逻辑不动。
- **验收**：Anthropic adapter 覆盖 429/overload/401/403/500/context_length/max_tokens/content_filtered/model_notifact 是否分类为 `STREAM_INCOMPLETE`。

### 4.2 Adaptive retry（双层状态）

- **功能行为**：
  - **层 1 单次调用循环**：`attempt 1..max_attempts`，失败 → 归一化 → decide action：`NO_RETRY` / `RETRY_BACKOFF` / `ROTATE_KEY` / `FIX_AND_RETRY` / `FALLBACK`。
  - **层 2 粘性状态**（影响后续调用）：连续 `AUTH` → 标 key dead；连续 `OVERLOADED`/`RATE_LIMIT` → provider 冷却；连续 `CONTEXT_LENGTH` → 主动预压缩；上次 `MAX_TOKENS` → 调参。**必须衰减**：成功清计数；窗口/dead-key 过期恢复。
- **退避算法**（借鉴 claude-code + hermes）：`getRetryDelay(attempt, retryAfter)` = retry-after 优先（秒*1000，cap 在 `backoff_cap_s` 防病态 header）否则 `min(base*2^(n-1), cap) + random*ratio*base`（半 jitter）；并发场景加进程级 counter seed 防同步重试。
- **partial tool args 区分（避坑，借鉴 hermes）**：`STREAM_INCOMPLETE`（无 stop_reason + tool args 未完成）≠ `MAX_TOKENS_EXCEEDED`（有 length stop_reason）—— 前者**不**走 max_tokens-boost 路径（否则 3 次无效重试）。
- **验收**：层 1 attempt 循环触发 + backoff 间隔符合公式 + 层 2 粘性状态连续 N 次升级 + 成功衰减清零。

### 4.3 Provider 降级（全局健康 + 全局兜底链）

- **功能行为**：
  - **进程级 `ProviderHealthRegistry`**（跨 session 共享）：命中 429/overload → `cooldown_s` 窗口，窗口内**跳过该 (provider,key)**；连续升级状态 `healthy → cooled_down → degraded → dead`；到期恢复（MVP 直接回 healthy，half-open 探测 defer）。
  - **全局兜底链 `fallback_chain`**：有序 `[{providerId, keyRef, modelId}, …]`，`resolveTarget` 遍历跳过 `cooled_down`/`dead`，取首个 healthy。**整链全 dead 才真失败**（给明确原因）。
  - **「换 key」与「换 provider」统一**成 fallback_chain 一项 `(provider, key, model)` 元组 —— 需扩 credentials 支持多 key。
  - **session 级只管对话相关**：连续 `CONTEXT_LENGTH`（本对话）、本对话最近错误原因；**不碰** provider 冷却。
- **同 backend dedup**（借鉴 hermes）：fallback chain 切换时按 `(provider, model, base_url)` 三元组避免切回死路。
- **account-wide quota 例外**（借鉴 hermes 教训）：多 key credential 设计要标注「quota 作用域」（per-key vs account-wide）；account-wide 的 provider 不轮换 key，直接 fallback。
- **验收**：P1 连续失败 → `ProviderHealthRegistry` 升级 cooldown → 切 P2 成功；整链全 dead → 明确错误上抛；多 session 共享冷却（session A 触发 cooldown，session B 跳过该 provider）。

### 4.4 分阶段超时（看门狗）

- **功能行为**：
  - **TTFB（首 chunk）**：默认 45s；超时 → `TIMEOUT_FIRST_CHUNK` abort → 丢弃 partial 重试。
  - **chunk 间 stall（阶段感知）**：answer 30s / think 30s / tool 120s；超时 → `TIMEOUT_INTER_CHUNK` abort → 丢弃 partial 重试。tool 120s 主要覆盖**工具执行期**（LLM 不流式）。
  - **整体 wall-clock 兜底**：默认 600s；超时 → abort → 重试。
  - **abort 来源区分**（改进 claude-code 事后推断）：自管 AbortController，事前记录 `abortReason: "user" | "watchdog_ttfb" | "watchdog_stall" | "wall_max"`；abort 时分类写入。**用户触发 = `ABORTED_BY_USER`（不重试，保留 partial）；看门狗触发 = `TIMEOUT_*`（进重试，丢弃 partial）**。
- **partial 保留策略**：partial 保留仅当 (1) 用户 abort；(2) partial 无未完成 tool_use（否则 tool_use 部分无法续）。watchdog/wall_max 触发 → 全丢重试。
- **tool stall 期间切分**（待 arch 细化）：tool 阶段分「tool 实参流式」（LLM 仍在 stream，适用 stall_tool_s）vs「工具执行期」（LLM 不流式，**不进 stall 计时**，LlmCaller 退出 stream 循环时停 stall timer，下次 invoke 重启）。
- **验收**：TTFB >45s abort + 重试；chunk 间 stall >30s abort + 重试；wall-clock >600s abort；用户 abort 保留 partial 不重试。

### 4.5 Length 处理（分两种）

| 错误 | 杠杆 | max_tokens |
|---|---|---|
| `CONTEXT_LENGTH_EXCEEDED`（输入超长） | 压缩/截断输入后重试；粘性→提前压缩 | 非主杠杆（可次要降低换输入空间） |
| `MAX_TOKENS_EXCEEDED`（输出触顶） | 让模型说完整 | **增加**或**续写**，绝不降低 |

- **输出触顶决策树**（reqs.md §5，refs 没有必须自己写）：
  1. partial 可 salvage（无未完成 tool_use） && `model.supportsPrefill` → **续写（prefill）拼接**（把 partial assistant turn 作 messages 数组最后一条，模型续写）。
  2. elif 当前 `max_tokens < model.maxOutputTokens` → **加 max_tokens 重跑**（封顶 `model.maxOutputTokens`）。
  3. else 已到模型硬上限 → **上抛用户**（不无限重试）。
- **modelConfig 能力位**：`{ maxOutputTokens, supportsPrefill, supportsThinking }`（每模型事实）。
- **不瞎猜 context 窗口**（借鉴 hermes 教训）：CONTEXT_LENGTH_EXCEEDED 后**不**永久调小 context 窗口；只在 provider 明确报告时本次调用降 max_tokens，粘性状态只设「预压缩标记」不缩窗口。
- **验收**：MAX_TOKENS + supportsPrefill → prefill 续写完整；MAX_TOKENS + 无 prefill + max_tokens<maxOutputTokens → bump 重跑；MAX_TOKENS + 到硬上限 → 上抛；CONTEXT_LENGTH → 压缩重试成功。

### 4.6 独立 config 组（`llm_request`）

- **功能行为**：**config 不配 = 默认值，配了 = 按配置**（dev 可调，走 app_config KV group）。默认值锁定（reqs.md §6）：
  - `timeout: { ttfb_s=45, stall_answer_s=30, stall_think_s=30, stall_tool_s=120, wall_max_s=600 }`
  - `retry: { max_attempts=3, backoff_base_s=2, backoff_cap_s=30, jitter=true }`
  - `degradation: { cooldown_s=300, consecutive_to_degrade=3, respect_retry_after=true }`
  - `length: { auto_compress=true, precompress_threshold_ratio=0.8, max_tokens_bump_strategy=continue }`
  - `fallback_chain: [{providerId, keyRef, modelId}, …]`
- **model 能力位放 modelConfig**（每模型事实，不放 llm_request）。
- **spec 缺口（需 architect 补）**：`specs/tech/config/[P0]app_config.md` 当前只定义 appearance/providers/locale 三个 group，**没有 `llm_request` group**（代码侧占位与 spec 不一致）—— tech spec 需补 group 定义。

### 4.7 调用编排层（`LlmCaller`）+ 错误状态持久化

- **功能行为**：在 `LlmClient`（不可变 4 件套）之上抽 `LlmCaller`，收口 error 归一化 + retry + provider 降级 + 动态参数。`LlmClient` 本身不动（保持不可变共享 + 4 件套绑定契约）。
- **职责（功能层描述，接口签名留 tech spec）**：
  1. `resolveTarget(config, healthRegistry)`：按 `fallback_chain` + 健康表选 `(provider,key,model)`，跳过冷却/dead。
  2. `buildRequest(baseReq, errorState, modelCapability, config)`：动态构建真正参数（config=基线/默认，每 attempt 按 error 状态覆写）：MAX_TOKENS + increase → `max_tokens` bump（封顶 `model.maxOutputTokens`）；连续 CONTEXT_LENGTH → 设预压缩标记 / 收上下文窗口；MAX_TOKENS + continue → partial 当 assistant turn 续写（prefill）。
  3. `invoke()`：retry 循环 + 看门狗（TTFB / 阶段 stall / wall_max）组合 abort，每轮调 `LlmClient.stream/call`。
  4. `classify + decide`：adapter 归一化 → category → decide（backoff/rotate key/fallback provider/fix req/no-retry）→ 写错误状态 → 下一轮。
- **接入点**：`agent-loop callLLM`（`agent-loop-base.ts:186` 区域）从直接 `client.stream` 改为 `llmCaller.invoke`。
- **错误状态分层**（用户强调 RunState）：

| 作用域 | 内容 | 落点 |
|---|---|---|
| 进程级（全局单例） | `ProviderHealthRegistry`：per `(provider,key)` 的 status/cooldownUntil/consecutive{overload,rate_limit}、dead-key 集 | 内存单例，全 session 共享 |
| **runstate 级（loop RunState）** | 本轮连续 `CONTEXT_LENGTH`、最近错误 `{cat,reason,at}`、参数 overlay（max_tokens bump / 预压缩标记） | `RunState.llmErrorState` —— loop 每 iteration callLLM 读它 → `buildRequest` 算实参 |
| 单次调用（瞬时） | attempt 计数、本次 attempt 错误 | `invoke` 局部 |

- **跨 iteration 继承（关键）**：错误状态记在 loop 的 RunState（非 LlmCaller 局部、非仅 Session），这样每个 iteration 调 LLM 时 `buildRequest` 能**跨 retry 修改实参**（attempt1 max_tokens=20000 → 命中 MAX_TOKENS → attempt2 改 30000；下一 iteration 继承 overlay）。
- **spec 缺口（需 architect 补）**：`RunState`（`agent_loop_base §4`）当前只有 `step/done/stopReason/snapshot/lastAssistantContent`，**无 `llmErrorState` 字段** —— tech spec 需扩。

### 4.8 行为默认（非 config）

- 超时 abort 后 partial：**丢弃重试**（仅用户 abort 保留 partial）。
- `CONTENT_FILTERED`：**不盲重试**，直接上抛用户（同输入 = 同拒绝 + 合规）。
- `ABORTED_BY_USER`：从不进重试、不影响降级。
- 后台路径 overload（若有 summary/title 等后台 LLM 调用）：**直接 fail 不重试**（避免 3-10× gateway 放大，借鉴 claude-code 教训）—— v0.0.25 若有后台路径需标注。

### 4.9 langfuse error 路径补全 + 物理层 wire body 记录

- **langfuse error 路径补全**：`LlmCaller.invoke` catch 块里，所有 throw 前调 `endGeneration({status:"error", errorCategory})`；category 记进 generation metadata（现 throw 后可能漏调）。
- **物理层 wire body 记录（BUG-001 确诊前置）**：`LlmClient` 的 `prepare()` 后 / `fetchImpl` 前挂钩子（`LlmClientOptions.onWire?(req, body, url)` 类比 fetchImpl 注入点 `client.ts:42/66`），记 `protocol.encode` 产出的最终 wire body + 响应。挂 langfuse generation 作「physical wire body」metadata，做逻辑 input（`snapshotMessages`）vs 物理 body 的 diff 对账。
- **目的**：确诊 BUG-001 `...` 真因（server 代码层已排除截断；可能来自第三方网关 / BUG-002 的 422 / 前端渲染层）。物理层记录落地后再决定改 encode / 网关对接 / 前端。
- **验收**：tool 调用后读 langfuse generation metadata → 断含「physical wire body」字段 + wire body 中 tool_result content 与逻辑 input 一致（无 `...`）。

### 4.10 anthropic role=tool 协议修复（BUG-002）

- **功能行为**：
  1. `encodeMessage`（canonical→wire 边界）：role 映射 `tool → user`（库内 Message 仍 role=tool，符合 `[P0]agent_message_interface.md §1` 的 role 模型）。
  2. 合并连续同 role：anthropic 要求 user/assistant 严格交替。转 user 后可能连续 user/user（多个 tool 结果 / tool 紧跟 user），需在 `encodeAnthropicMessages` 合并相邻 user（现有 role_merge 只合同 role，encode 层仍需兜底）。
- **落点必须在 `protocol-encode.ts` encodeMessage 层**（不是 assemble reducer）：`forked-agent.ts:181-184` 的 tool message 不走 assemble pipeline（直接 `state.messages.push`），只改 assemble 对 forked 无效。
- **spec 缺口（需 architect 补）**：`[P0]llm_protocol_interface.md §4` 多模态表只列了 `ToolResultBlock → {type:"tool_result",...}` 的 content block 映射，**没说外层 message role 转换规则**（role=tool→user）—— tech spec 需补 encodeMessage 的 role 映射规则 + encodeAnthropicMessages 连续同 role 合并规则。

---

## 5. 验收标准（product 级）

> 每条路径（§2）≥1 可验收点。后续 api/e2e case 直接照路径 + 此处验收点写。

| 路径 | 验收点（product 级） |
|------|--------------------|
| P1 overload/rate_limit retry | mock provider 首次 429/overload 二次 200 → 最终用户拿到完整回复；langfuse trace 记 ≥2 次 attempt（retry 链可见） |
| P2 provider 降级 + 整链 dead | mock P1 连续失败 → 切 P2 成功（trace 记 provider 切换）；mock 全链 fail → 错误码明确（非 `LOOP_ERROR` 笼统）+ message 含「整链 dead」原因 |
| P3 CONTEXT_LENGTH 压缩 | mock 首次 context 超长 → 触发 compact → 二次成功；连续触发后下一 iteration 主动预压缩（不等地报错） |
| P4 MAX_TOKENS prefill/bump | mock 首次 stop_reason=length + partial text + supportsPrefill → prefill 续写完整回复（拼接无重复/无断裂）；不支持 prefill + max_tokens<maxOutputTokens → bump 重跑成功；到硬上限 → 明确上抛 |
| P5 分阶段超时 | mock TTFB >45s → abort + 重试（trace 记 `TIMEOUT_FIRST_CHUNK`）；chunk 间 stall >30s → 同；wall-clock >600s → 兜底 abort |
| P6 abort 来源区分 | 主动 abort → 保留 partial + 不触发 retry + 不影响 ProviderHealth；看门狗 abort → 丢 partial + 触发 retry |
| P7 tool result 可见性 + wire 记录 | tool 调用后读 langfuse generation metadata → 含「physical wire body」字段；wire body 中 tool_result content == 逻辑 input（无 `...`）；下一 iteration LLM 看到真实 tool result |
| P8 anthropic role=tool | 多 tool result 连续 + tool 紧跟 user → wire body 中无 role=tool（全转 user）；端点返 200（非 422 literal_error） |
| P9 跨 iteration overlay 继承 | 触发 max_tokens bump 后，下一 iteration LLM 请求 max_tokens == bumped 值（继承 overlay，非回退默认） |
| P10 不可恢复错误 | mock content_filtered → 不重试 + 错误码 `CONTENT_FILTERED` 上抛；mock auth_invalid → 不重试 + 错误码 `AUTH_INVALID` 上抛 |

### 5.1 整体验收门禁

- **零塌缩**：所有 LLM 错误不再笼统塌缩成 `LOOP_ERROR`，必须带 `LlmErrorCategory`（langfuse generation metadata 可查）。
- **provider 健康全局共享**：多 session 并发场景，session A 触发 provider 冷却，session B 立即跳过该 provider（不各自踩坑）。
- **config 接线**：`llm_request` config 组配了按配置走（如改 `max_attempts=5` 生效），不配走默认值。
- **langfuse 闭环**：error 路径也调 `endGeneration`（无泄漏）；物理层 wire body 可查。
- **BUG-002 修复**：forked + eager 两条路径均不再 422（encode 层修复覆盖全）。

---

## 6. 设计决策（锁定）

| # | 决策 | 落地 |
|---|------|------|
| 1 | LlmClient 不动，在其上抽 LlmCaller | 保持 4 件套不可变共享契约（`[P0]llm_client_interface.md`）；LlmCaller 是组合层之上的编排层 |
| 2 | 错误状态记 loop RunState（非 LlmCaller 局部） | `RunState.llmErrorState` 跨 iteration 继承参数 overlay；进程级 ProviderHealthRegistry 走内存单例 |
| 3 | provider 健康全局共享 | 进程级 `ProviderHealthRegistry` 跨 session；session 级只管对话相关 |
| 4 | 换 key = 换 provider（统一 fallback_chain 元组） | 扩 credentials 多 key；fallback_chain 项 = `(provider, key, model)` |
| 5 | 分类与决策分离 | ClassifiedLlmError 携带 action hints；adapter 改映射列主逻辑不动 |
| 6 | abort 来源事前记录 | 自管 AbortController 记 abortReason，不事后推断 |
| 7 | prefill 续写（refs 没有，自己写） | Anthropic Messages API：partial assistant turn 作最后一条 message 喂回续写 |
| 8 | 物理层 wire body 记录（BUG-001 确诊前置） | `onWire` 钩子（类比 fetchImpl 注入点）+ langfuse metadata |
| 9 | role=tool 修复在 encode 层（非 assemble） | 覆盖 eager + forked 两条路径 |
| 10 | half-open 探测 defer | MVP 到期直接回 healthy；v0.0.25 范围内可不做 |

---

## 7. 风险与避坑（来自 refs 教训）

| 风险 | 应对 |
|------|------|
| 3 次无效 max_tokens bump（hermes 教训） | 严格区分 STREAM_INCOMPLETE（无 stop_reason）vs MAX_TOKENS_EXCEEDED（有 length）；前者不 bump |
| 病态 retry-after header | 解析后必须 cap（`backoff_cap_s` × N 或绝对上限如 10min） |
| account-wide quota 轮换无效（hermes 教训） | 多 key credential 标注 quota 作用域；account-wide 不轮换直接 fallback |
| 冷却延 long-chain-switch（hermes 教训） | ProviderHealthRegistry 升级状态时，只在「离开 primary」或「该 provider 本次确实失败」时设 cooldownUntil，不因 chain 切换累加 |
| 瞎猜 context_length（hermes 教训） | CONTEXT_LENGTH_EXCEEDED 后不永久调小窗口；粘性只设预压缩标记 |
| SDK 内部 timeout 误判为用户 abort（claude-code 教训） | 自管 AbortController 事前记 abortReason |
| overload 雪崩（claude-code 教训） | 后台路径 overload 直接 fail 不重试 |
| 状态机不可表示（openclaw 原则） | ProviderHealthRegistry 用 discriminated union，不用并行 bool |

---

## 8. spec 对齐核查（PRD ↔ tech spec，MANDATORY）

| 概念 | 已有 tech spec 状态 | v0.0.25 动作 |
|------|---------------------|--------------|
| `LlmClient`（4 件套不可变共享） | `[P0]llm_client_interface.md` v2.1 已定义 | **不动**；LlmCaller 在其上抽（新 tech spec） |
| `LlmProviderConfig.credentials`（单 key） | `[P0]llm_provider_interface.md §3.3` 锁定单 key | **需改**：扩多 key（reqs.md §3 要求） |
| `app_config` group 清单 | `[P0]app_config.md §3` 只有 appearance/providers/locale | **需补**：`llm_request` group 定义（代码占位与 spec 不一致） |
| `RunState` 字段 | `agent_loop_base §4` 只有 step/done/stopReason/snapshot/lastAssistantContent | **需扩**：加 `llmErrorState` 字段 |
| protocol `encodeMessage` role 映射 | `[P0]llm_protocol_interface.md §4` 多模态表只列 content block，无 role 转换规则 | **需补**：encodeMessage 的 `tool→user` 映射 + encodeAnthropicMessages 连续同 role 合并（BUG-002） |
| `callLLM` 接入点 | `agent_loop_base §2.1` callLLM 直接调 `client.stream` | **需改**：改调 `llmCaller.invoke` |
| `modelConfig` 能力位 | `[P0]llm_model_interface.md` 有 maxOutputTokens | **需扩**：加 supportsPrefill / supportsThinking |

**新概念（需 architect 落 tech spec，PRD 不发明技术细节）**：`LlmCaller` / `LlmErrorCategory` / `ClassifiedLlmError` / `ProviderHealthRegistry` / `RunState.llmErrorState` / `fallback_chain` / 多 key credentials / `llm_request` config group / 物理层 `onWire` 钩子。

---

## 9. 里程碑

- v0.0.25 验收口径：§2 十条系统行为路径全部通过（api case 派生自此）+ §5 整体门禁 + §8 spec 对齐完成（新概念落 tech spec）。
- backend-only，无 e2e 视觉门禁（视觉保真度门禁 N/A）。
- BUG-001 / BUG-002 在本版修复（物理层记录确诊 + role=tool 修复），关闭条件见各自 BUG 文件。
