# v0.0.25 Tech Spec 变更日志 — LLM 调用错误处理 / 自适应重试（llm-opt）

> 概述：**backend-only**。新增 LlmCaller 编排层（6 文件）+ 修订 LlmClient 4 件套（onWire 钩子 / 多 key credentials / role 映射 / ModelCapability）+ 修订 agent_loop_base（callLLM 接入 + RunState.llmErrorState）+ 修订 app_config（llm_request group）。覆盖 PRD §8 全部 7 处 spec 缺口 + 全部新概念。
> 权威输入：`specs/prd/version_logs/v0.0.25/change_log.md`（10 系统行为路径 + §8 spec 对齐核查）；`reqs/v0.0.25/reqs.md`（§7 LlmCaller 架构）；`specs/research/v0.0.25-llm-error-handling/`（4 文件，尤 recommendations.md §2.4/§2.5）。

---

## 1. PRD §8 spec 缺口覆盖（7 处全部落 spec）

| PRD §8 概念 | 原状态 | v0.0.25 落点 | 覆盖 |
|------|------|------|------|
| `LlmClient`（4 件套不可变） | `[P0]llm_client_interface.md` v2.1 | **不动核心契约**；仅加 `LlmClientOptions.onWire` 钩子（§3.8）+ constructor options 参数（向后兼容） | ✅ |
| `LlmProviderConfig.credentials`（单 key） | `[P0]llm_provider_interface.md §3.3` 锁定单 key | **扩 union**：`{key} \| {keys[]}`，向后兼容；完整 schema 在 `[P0]llm_request_config.md §3` | ✅ |
| `app_config` group 清单 | `[P0]app_config.md §3` 只有 3 group | **补 §3.4 llm_request group**（timeout/retry/degradation/length/fallback_chain） | ✅ |
| `RunState` 字段 | `agent_loop_base §4` 缺 llmErrorState | **扩 LoopStateBase** 加 `llmErrorState: LlmErrorState`（schema 在 `[P0]llm_request_config.md §2`） | ✅ |
| protocol `encodeMessage` role 映射 | `[P0]llm_protocol_interface.md` 多模态表无 role 转换规则 | **补 §2 「外层 message role 转换规则」+「连续同 role 合并规则」**（BUG-002 encode 层修复） | ✅ |
| `callLLM` 接入点 | `agent_loop_base §2.1` 直接调 `client.stream` | **改调 `llmCaller.invoke`**（§2.1 [v0.0.25] 改造说明 + CallLLMInput 加 runState/backgroundPath） | ✅ |
| `modelConfig` 能力位 | `[P0]llm_model_interface.md` 有 maxOutputTokens | **扩 `capabilities: ModelCapability`**（supportsPrefill / supportsThinking / maxOutputTokens） | ✅ |

**新概念全部落 tech spec**：`LlmCaller` / `LlmErrorCategory` / `ClassifiedLlmError` / `ProviderHealthRegistry` / `RunState.llmErrorState` / `fallback_chain` / 多 key credentials / `llm_request` config group / 物理层 `onWire` 钩子 / `ModelCapability` —— 见 §2 文件清单。

---

## 2. 文件变更清单

### 2.1 新增 tech spec（6 文件，`specs/tech/agent/llm_caller/`）

| 文件 | 操作 | 内容 |
|------|------|------|
| `specs/tech/agent/llm_caller/[P0]llm_caller_overview.md` | 新增 | LlmCaller 编排层总纲：与 LlmClient 关系（§1.1）+ invoke 接口契约（§2）+ 内部数据流（§3）+ callLLM 接入改造（§4）+ RunState 扩展（§5）+ 5 设计决策（§6） |
| `specs/tech/agent/llm_caller/[P0]error_normalization.md` | 新增 | LlmErrorCategory 17 值枚举（§1）+ ClassifiedLlmError + ErrorActionHints（§2）+ classify/computeHints（§3）+ Anthropic adapter 完整映射表（HTTP/error.type/流内/stop_reason/正则/Retry-After，§4）+ OpenAI/GLM 占位（§5）+ 6 设计决策 |
| `specs/tech/agent/llm_caller/[P0]provider_health_registry.md` | 新增 | 进程级单例：4 态 discriminated union（healthy/cooled_down/degraded/dead，§2）+ 升级/恢复规则（§3）+ account-wide quota 例外（§4）+ cooldown 不因 chain-switch 累加（§5）+ 5 设计决策 |
| `specs/tech/agent/llm_caller/[P0]retry_and_timeout.md` | 新增 | getRetryDelay 公式（retry-after 优先 + 半 jitter + counter seed，§1）+ 三计时器看门狗（TTFB/stall/wall，§2）+ 阶段感知 stall + tool stall 切分（§2.2-§2.3）+ CompositeAbortController + abortReason 事前记录（§3）+ partial 保留策略（§4）+ 6 设计决策 |
| `specs/tech/agent/llm_caller/[P0]length_handling.md` | 新增 | MAX_TOKENS 决策树（prefill/bump/throw，§2）+ prefill 续写数据流 + 拼接 + 递归限制（§2.1）+ CONTEXT_LENGTH 压缩 + 粘性预压缩（§3）+ STREAM_INCOMPLETE 区分（§4）+ ModelCapability 能力位（§5）+ max_tokens_bump_strategy（§6）+ 5 设计决策 |
| `specs/tech/agent/llm_caller/[P0]llm_request_config.md` | 新增 | llm_request config group + 默认值 + LlmRequestConfigService（§1）+ LlmErrorState schema + 跨 iteration 继承规则（§2）+ credentials 多 key union + keyRef 选择器（§3）+ account-wide quota 例外（§4）+ 5 设计决策 |

### 2.2 修订现有 tech spec（6 文件）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `specs/tech/agent/providers_and_models/[P0]llm_client_interface.md` | 修改 | v2.1→v2.2：新增 `LlmClientOptions`（fetchImpl + onWire）+ constructor 加 options 参数；`call()`/`stream()` 在 encode 后 fetch 前调 `onWire`；新增 §3.8 物理层 onWire 钩子设计决策（BUG-001）+ langfuse error 补全归 LlmCaller 说明 |
| `specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md` | 修改 | v2.0→v2.1：`credentials` 类型改 union（`{key} \| {keys[]}`）；`LlmProvider.buildAuthHeaders` 加可选 keyRef 参数；§3.3 补多 key 扩展决策（向后兼容） |
| `specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md` | 修改 | v2.2→v2.3：§2 补「外层 message role 转换规则」（`role:"tool" → "user"`，BUG-002）+「连续同 role 合并规则」（encodeAnthropicMessages 相邻 user/assistant content 数组拼接，保证严格交替）+ wire body 示例；强调 encode 层修复覆盖 eager+forked |
| `specs/tech/agent/providers_and_models/[P0]llm_model_interface.md` | 修改 | v2.0→v2.1：`LlmModelConfig` 加 `capabilities: ModelCapability`（maxOutputTokens + supportsPrefill + supportsThinking）；顶层 maxOutputTokens 保留为 alias 向后兼容；新增 §3.5 ModelCapability 设计决策 + 初始值表 |
| `specs/tech/agent/providers_and_models/anthropic_impl.md` | 修改 | §3 role 映射补 `[v0.0.25 BUG-002]` 标注（`tool→user` + 连续合并），引用 protocol §2 新规则 |
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md` | 修改 | v1.2→v1.3：§2.1 `CallLLMInput` 加 `runState` + `backgroundPath` 字段；§2.1 末尾补 [v0.0.25] callLLM 接入改造说明（client.stream → llmCaller.invoke）；§4 `LoopStateBase` 加 `llmErrorState: LlmErrorState` 字段 + 不落盘说明 |
| `specs/tech/config/[P0]app_config.md` | 修改 | v2.3→v2.4：§3 新增 §3.4 llm_request group（timeout/retry/degradation/length/fallback_chain）；group 集合扩展为 {appearance, providers, locale, llm_request}；标注 llm_request 缺省回退默认（语义不同于 providers） |

### 2.3 新增 api spec（1 文件）

| 文件 | 操作 | 内容 |
|------|------|------|
| `specs/api/version_logs/v0.0.25/change_log.md` | 新增 | 端点契约变更（SSE error event 加 errorCategory + `/config/app/llm_request` 新端点）+ BUG-002 wire body 规则（api spec 重点）+ langfuse metadata 补全 + 17 category 列表 + 验收门禁 |

---

## 3. 关键设计原则（核心决策汇总）

| # | 原则 | 落点 |
|---|------|------|
| 1 | **LlmClient 不动，LlmCaller 在其上抽** | 4 件套不可变共享契约保持；LlmCaller 是组合层之上的编排层（`[P0]llm_caller_overview §1.1 §6.1`） |
| 2 | **错误状态记 RunState，非 LlmCaller 局部** | `RunState.llmErrorState` 跨 iteration 继承 overlay；进程级 ProviderHealthRegistry 走内存单例（`[P0]llm_caller_overview §6.2`） |
| 3 | **classify 与 decide 分离**（hermes 模式） | ClassifiedLlmError 携带 5 个 action hints bool；adapter 改 category 映射列主逻辑不动（`[P0]error_normalization §6.1`） |
| 4 | **STREAM_INCOMPLETE ≠ MAX_TOKENS_EXCEEDED** | 无 stop_reason + tool args 未完成 → STREAM_INCOMPLETE（不 bump）；有 length stop_reason → MAX_TOKENS（`[P0]error_normalization §4.3` + `[P0]length_handling §4`） |
| 5 | **abort 来源事前记录**（改进 claude-code） | CompositeAbortController 把 abortReason 当一等公民，不靠事后推断（`[P0]retry_and_timeout §3 §5.4`） |
| 6 | **prefill 续写是 v0.0.25 核心创新** | Anthropic Messages API：partial assistant turn 作 messages 最后一条续写（`[P0]length_handling §2.1 §7.1`） |
| 7 | **discriminated union 表示健康状态** | ProviderHealthState 4 态 union，不用并行 bool（avoid impossible states，`[P0]provider_health_registry §6.3`） |
| 8 | **不瞎猜 context window** | CONTEXT_LENGTH 后不永久调窗口，粘性只设预压缩标记（`[P0]length_handling §3.3 §7.4`） |
| 9 | **role=tool 修复在 encode 层**（覆盖 eager+forked） | forked 不走 assemble，encode 层是 canonical→wire 最后一站（`[P0]llm_protocol_interface §2` BUG-002） |
| 10 | **llm_request 缺省回退默认**（语义不同于 providers） | 调优参数不配应能用默认；providers 是权威值不配=没配（`[P0]llm_request_config §1.3`） |
| 11 | **credentials 多 key union 向后兼容** | 单 key `{key}` 等价多 key `{keys:[{keyRef:"default",...}]}`（`[P0]llm_request_config §3 §5.3`） |
| 12 | **物理层 onWire 钩子归 client** | encode 后 fetch 前注入点，类比 fetchImpl（`[P0]llm_client_interface §3.8`） |

---

## 4. PRD 10 系统行为路径覆盖矩阵

| 路径 | 覆盖 tech spec 章节 |
|---|---|
| P1 overload/rate_limit retry | error_normalization §4.1 + retry_and_timeout §1 + llm_caller_overview §3（attemptLoop） |
| P2 provider 降级 + 整链 dead | provider_health_registry §3 + llm_caller_overview §3（resolveTarget + FALLBACK） |
| P3 CONTEXT_LENGTH 压缩 | length_handling §3 + llm_request_config §2（precompress 粘性） |
| P4 MAX_TOKENS prefill/bump | length_handling §2 + llm_model_interface §3.5（supportsPrefill） |
| P5 分阶段超时 | retry_and_timeout §2（TTFB/stall/wall）+ §2.2 阶段感知 |
| P6 abort 来源区分 | retry_and_timeout §3（CompositeAbortController + abortReason）+ §4 partial 保留 |
| P7 tool result 可见性 + wire 记录 | llm_client_interface §3.8（onWire）+ api change_log §3 |
| P8 anthropic role=tool | llm_protocol_interface §2（role 映射 + 连续合并）+ anthropic_impl §3 |
| P9 跨 iteration overlay 继承 | llm_request_config §2.3（maxTokensOverlay 跨 iteration）+ llm_caller_overview §6.2 |
| P10 不可恢复错误 | error_normalization §6.4（CONTENT_FILTERED NO_RETRY）+ §1 category 分组恢复语义 |

---

## 5. 不一致修正（spec 即当修正）

| 发现 | 修正 |
|------|------|
| `app_config.md` §3 group 清单与代码占位（代码已有 `llm_request` 组 stub 但 spec 没有）不一致 | 补 §3.4 llm_request group（PRD §8 已标） |
| `llm_protocol_interface` 多模态表只列 content block 映射，无外层 message role 转换规则（BUG-002 根因） | 补 §2 「外层 message role 转换规则」+「连续同 role 合并规则」 |
| `agent_loop_base §4` RunState 无 llmErrorState（用户强调跨 iteration 继承无落点） | 扩 LoopStateBase 加 llmErrorState 字段 |
| `anthropic_impl.md §3` 隐式提到「tool 作 user content block」但未显式落 encodeMessage role 映射规则 | 显式化 + 标注 BUG-002 修复（encode 层 + 连续合并） |

---

## 6. backend-only 声明

本版本**无 UI spec 变更**（无 `specs/ui/` 改动）。所有改动在 server / agent 层。视觉保真度门禁 N/A。

---

## 7. 后续动作

- architect 产出完成后，orchestrator 写 test-plan.md（基于 PRD §2 十条路径 + 本 spec 文件清单），委派 coder 创建 tests/api/ + tests/e2e/ 用例文件。
- coder 编码前必读本 spec 全部 6 个新文件 + 6 个修订文件。
- 测试用例直接照 spec 的接口签名 / 类型定义 / 状态机 / 数据流写（用户强调「tech spec 必须写细」已落实）。
