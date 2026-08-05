# v0.0.191 变更计划书 — protocol/provider impl 物理迁入 llm_anthropic builtin plugin（主干零硬编码 impl）

> **method 级 review 合同**。架构期冻结：planner/coder 按本表切 task 实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 内） |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁「更新调用链」等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 版本主题

把硬编码在 server 主干 `app/server/src/llm/{provider,protocol,protocol-encode,protocol-parse-stream}.ts` 的 anthropic impl 类**物理迁移**到 `app/plugins/builtins/llm_anthropic/`，主干只留接口 + 类型 + cross-impl 共用工具。**wire 行为逐字节不变**（本版本刚修过的 reminder 过滤 + cache_control 2bp 语义必须原样保留，UT 守护）。

**范围边界**：
- 纯技术重构，无 PRD（无用户可感知变化）
- EP 机制不动（`LlmProviderPoint`/`LlmProtocolPoint` 已在 `BUILTIN_EXTENSION_POINTS`；list cardinality）
- `llm-client-factory.ts` / `provider-protocol-helpers.ts` 不动（已 EP 驱动）
- `scopes/default.yaml` 不动（已登记 `anthropic_compatible` + `anthropic_messages` active）
- `build-plugins.ts` 不动（`SERVER_IMPORT_RE` + `EXTERNALS` 已覆盖 deep import 主干）
- 不引入新第三方依赖（无 EXTERNALS 决策）

## 设计决策（架构期冻结）

1. **接口 vs 实现归属**（对齐 spec §3.1「数据 vs 行为分离」+ §3.2「protocol 只做纯翻译」）：
   - **留主干**（契约/cross-impl 共用）：`LlmProvider`/`LlmProtocol` 接口、`CanonicalRequest`/`CanonicalResponse`/`WireBody`/`WireResponse`/`RequestParams`/`StreamEvent` 类型、`provider-types.ts`、`protocol-types.ts`、`logical-view.ts`（跨协议上游）、`credentials.ts`（caller 也用）、`resolve-provider-config.ts`、`client.ts`、`http_error.ts`。
   - **迁 plugin**（anthropic 专属 impl）：`AnthropicCompatibleProvider` 类、`AnthropicMessagesProtocol` 类、`mapStopReason`、`encodeAnthropicMessages` 整文件、`parseAnthropicSseFrame`/`parseAnthropicUsage` 整文件。
2. **plugin 对主干的依赖形态**：`import type {...}`（接口/类型，type-only 零运行时依赖）+ `import { pickKeyValue } from '../../../server/src/llm/credentials'`（值 import，cross-impl 共用工具）。packaged 经 `build-plugins.ts` 的 `SERVER_IMPORT_RE=/(\.\.\/)+server\/src\//g` 改写为 `@app/server/dist/llm/credentials` + `@app/server` external → 命中 asar 内 server 实例（与 rocky_context 同范式）。
3. **主干 index.ts 清理**：删 `AnthropicCompatibleProvider`/`AnthropicMessagesProtocol` 的 named export（impl 不再归主干）；保留所有类型 + client + 聚合 + credentials/logical-view/http_error 的 re-export。
4. **测试跟随被测代码迁 plugin `__tests__/`**：provider/protocol-encode/protocol-parse-stream/protocol-parse/protocol-parse-usage/protocol-label/protocol-encode-cache 的 UT 迁 `app/plugins/builtins/llm_anthropic/__tests__/`；client/credentials/resolve-provider-config/logical-view 的 UT 留主干（被测留主干）。
5. **`protocol-encode.ts` 325 行超限处理**：硬约束 wire 逐字节不变 + 纯迁移，本版本**整迁不动逻辑**（coder 可酌情轻拆，但 MUST UT 全绿 + 语义等价；否则整迁保 325 行 + 在 `change_log.md` 记 follow-up 拆分 TODO）。不本版本做拆分重构（迁移 + 重构叠加风险高）。

## 变更清单

### A. 新增 plugin：impl 代码物理迁入 `app/plugins/builtins/llm_anthropic/`

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm_anthropic | app/plugins/builtins/llm_anthropic/provider.ts | AnthropicCompatibleProvider (default class) | 修改 | 从 re-export shim 改为真实 impl：迁入 `AnthropicCompatibleProvider implements LlmProvider` 类（implId/cfg 字段 + buildAuthHeaders，原 `app/server/src/llm/provider.ts` L33-64 内容）；`import type { LlmProvider } from '../../../server/src/llm/provider'` + `import { pickKeyValue } from '../../../server/src/llm/credentials'` + `import type { LlmProviderConfig } from '../../../server/src/llm/provider-types'` | MUST 保留 buildAuthHeaders 原行为（x-api-key + anthropic-version:2023-06-01）；MUST NOT 改凭证解析语义；MUST 保留构造签名 `(implId, cfg={})` | specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md §2/§3.1；specs/tech/plugin_system/[P0]builtin_plugins_directory.md §2.2 | +35/-3 |
| llm_anthropic | app/plugins/builtins/llm_anthropic/protocol.ts | AnthropicMessagesProtocol (default class) | 修改 | 从 re-export shim 改为真实 impl：迁入 `AnthropicMessagesProtocol implements LlmProtocol` 类（path/contentType/label 常量 + buffer/toolUseIndex 状态 + encode/parse/parseStream 方法 + 构造）；同文件迁入 `mapStopReason`（anthropic stop_reason 专属，原 protocol.ts L216-228）；`import type { LlmProtocol, CanonicalRequest, WireBody, WireResponse, CanonicalResponse, StreamEvent } from '../../../server/src/llm/protocol'` + `import type { ContentBlock, Message } from '../../../server/src/llm/protocol-types'` + `import type { Usage } from '../../../server/src/message/types'` + `import { encodeAnthropicMessages } from './protocol-encode'` + `import { parseAnthropicSseFrame, parseAnthropicUsage } from './protocol-parse-stream'` + 本文件 `nextFrameSplit` 辅助留 plugin | MUST 保留 path='/v1/messages' + contentType='application/json' + label='Anthropic Messages 风格'；MUST 保留 parseStream 跨 chunk 半帧缓冲语义（buffer 累积 + nextFrameSplit）；MUST NOT 改 mapStopReason 分支表 | specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2；anthropic_impl.md §2；原则：wire 逐字节不变 | +200/-3 |
| llm_anthropic | app/plugins/builtins/llm_anthropic/protocol-encode.ts | encodeAnthropicMessages (export) | 新增 | 整文件物理迁入（原 `app/server/src/llm/protocol-encode.ts` 全部内容）：encodeAnthropicMessages 入口 + encodeTools / injectLastNonReminderCacheControl / extractSystemText / encodeMessage / isReminderBlock / mergeAdjacentSameRole / encodeContentBlock / encodeToolResultContent + 常量 CACHE_CONTROL_EPHEMERAL / EFFORT_WIRE_MAP；`import type { CanonicalRequest, WireBody } from '../../../server/src/llm/protocol'` + `import type { ContentBlock, Message } from '../../../server/src/llm/protocol-types'` | MUST wire 逐字节不变（含本版本刚修 reminder 过滤口径「最末 message」+ cache_control bp#2「最后非 reminder block」+ effort output_config 注入 + stop sequences 映射 + role tool→user + 相邻同 role 合并）；325 行超限整迁不动逻辑（见决策 5）；MUST NOT 改 encode 入口签名 | specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5/§3.6/§3.7/§3.8；[P0]cache_control.md §3.2/§3.3；原则：wire 逐字节不变 | +325/-0 |
| llm_anthropic | app/plugins/builtins/llm_anthropic/protocol-parse-stream.ts | parseAnthropicSseFrame + parseAnthropicUsage (export) | 新增 | 整文件物理迁入（原 `app/server/src/llm/protocol-parse-stream.ts` 全部内容）：parseAnthropicSseFrame（单帧 SSE→StreamEvent 分流）+ parseAnthropicUsage（wire usage→canonical Usage 9 字段映射）+ 辅助；`import type { StreamEvent } from '../../../server/src/llm/protocol'` + `import type { Usage } from '../../../server/src/message/types'` | MUST 保留 parseAnthropicUsage 字段映射（input_no_cache/cache_read/cache_write/output_response/output_reasoning 等派生 totals）；MUST NOT 改 SSE 帧解析（含 thinking_delta / tool_call_delta 分流） | anthropic_impl.md §5.1；[P0]llm_protocol_interface.md §3 流式 | +218/-0 |

### B. 主干清理：删 impl 类残留，保留接口 + 类型

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm | app/server/src/llm/provider.ts | AnthropicCompatibleProvider (default class) | 删除 | 删整个 `AnthropicCompatibleProvider` 类 + `import { pickKeyValue } from './credentials'`（不再用）+ `import type { LlmProviderConfig } from './provider-types'`（若仅类用）；**保留 `LlmProvider` 接口定义**（plugin 需要 import type） | MUST 保留 `LlmProvider` 接口；MUST NOT 改接口签名；MUST 同步删 `index.ts` 的 `export { default as AnthropicCompatibleProvider } from './provider'` 行 | specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md §2 | +0/-37 |
| llm | app/server/src/llm/protocol.ts | AnthropicMessagesProtocol (default class) | 删除 | 删整个 `AnthropicMessagesProtocol` 类 + `mapStopReason` 函数（迁 plugin）+ `import { encodeAnthropicMessages } from './protocol-encode'` + `import { parseAnthropicSseFrame, parseAnthropicUsage } from './protocol-parse-stream'` + `nextFrameSplit` 辅助 + `import type { ContentBlock, Message } from './protocol-types'`（若仅类用）；**保留** `LlmProtocol` 接口 + `CanonicalRequest`/`CanonicalResponse`/`WireBody`/`WireResponse`/`RequestParams`/`StreamEvent` 类型（含所有 JSDoc） | MUST 保留所有类型定义（30+ `import type` 调用点依赖）；MUST NOT 改 StreamEvent union（含 llm_attempt 变体）；MUST 同步删 `index.ts` 的 `export { default as AnthropicMessagesProtocol } from './protocol'` 行 | specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2 | +0/-100 |
| llm | app/server/src/llm/protocol-encode.ts | 整文件 | 删除 | 整文件删（impl 已迁 plugin） | MUST 主干无残留 impl；MUST 同步处理 `__tests__/protocol-encode*.test.ts` 迁 plugin | — | -325 |
| llm | app/server/src/llm/protocol-parse-stream.ts | 整文件 | 删除 | 整文件删（impl 已迁 plugin） | MUST 同步处理 `__tests__/protocol-parse*.test.ts` 迁 plugin | — | -218 |
| llm | app/server/src/llm/index.ts | AnthropicCompatibleProvider + AnthropicMessagesProtocol re-export | 删除 | 删 L39 `export { default as AnthropicCompatibleProvider } from './provider';` + L43 `export { default as AnthropicMessagesProtocol } from './protocol';`；**保留** 所有 type export + client + resolveProviderConfig/resolveModelConfig/deepMerge + LlmProvider/LlmProtocol 接口 re-export | MUST 保留 `export type { LlmProvider }` + `export type { LlmProtocol, CanonicalRequest, CanonicalResponse, WireBody, WireResponse, RequestParams, StreamEvent }`；MUST NOT 删其他 named export | specs/tech/agent/providers_and_models/index.md §⑤ | +0/-2 |

### C. 测试迁移：跟随被测代码迁 plugin `__tests__/`

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm_anthropic-test | app/plugins/builtins/llm_anthropic/__tests__/provider.test.ts | 整文件 | 新增（迁入） | 从 `app/server/src/llm/__tests__/provider.test.ts` 迁入；改 impl import 路径为 `'../provider'`；type import 主干路径 `'../../../server/src/llm/...'` | MUST UT 全绿 | rocky_context/__tests__/ 范式 | +0 移动 |
| llm_anthropic-test | app/plugins/builtins/llm_anthropic/__tests__/protocol-encode.test.ts | 整文件 | 新增（迁入） | 从主干 `__tests__/protocol-encode.test.ts` 迁入；改 `encodeAnthropicMessages` import 为 `'../protocol-encode'` | MUST wire 行为逐字节不变（UT 守护刚修的 reminder + cache_control 语义） | 原文件 | +0 移动 |
| llm_anthropic-test | app/plugins/builtins/llm_anthropic/__tests__/protocol-encode-cache.test.ts | 整文件 | 新增（迁入） | 从 `app/server/src/__tests__/protocol-encode-cache.test.ts` 迁入；改 `encodeAnthropicMessages` import 为 `'../../../plugins/builtins/llm_anthropic/protocol-encode'` + type import 改 `'../../../server/src/llm/protocol'`；**AnthropicMessagesProtocol import 改从 plugin `'../../../plugins/builtins/llm_anthropic/protocol'`** | MUST UT 全绿 | — | +0 移动 |
| llm_anthropic-test | app/plugins/builtins/llm_anthropic/__tests__/protocol-encode-{effort,role-tool,stop}.test.ts | 整文件 | 新增（迁入） | 同上模式从主干 `llm/__tests__/` 迁入 | MUST UT 全绿（effort 4 档 + role tool→user + 相邻合并 + stop sequences） | — | +0 移动 |
| llm_anthropic-test | app/plugins/builtins/llm_anthropic/__tests__/protocol-parse{,-stream,-stream-tool,-usage}.test.ts | 整文件 | 新增（迁入） | 同上模式从主干 `llm/__tests__/` 迁入；改 parse import 为 `'../protocol-parse-stream'`（或 plugin 内 protocol.ts） | MUST UT 全绿 | — | +0 移动 |
| llm_anthropic-test | app/plugins/builtins/llm_anthropic/__tests__/protocol-label.test.ts | 整文件 | 新增（迁入） | 同上；测 `AnthropicMessagesProtocol.label='Anthropic Messages 风格'` | — | — | +0 移动 |
| llm-test | app/server/src/agent/__tests__/stream-consumer-tool-e2e.test.ts | import AnthropicCompatibleProvider + AnthropicMessagesProtocol | 修改 | L16 改 `from '../../../plugins/builtins/llm_anthropic/provider'`；L17 改 `from '../../../plugins/builtins/llm_anthropic/protocol'`；type import（CanonicalRequest/StreamEvent 等）保持原 `'../../llm/protocol'` | MUST 测试功能不变；MUST UT 全绿 | — | +2/-2 |
| llm-test-keep | app/server/src/llm/__tests__/{client*,credentials,resolve-provider-config,logical-view}.test.ts | — | 不动 | 被测代码留主干，测试不动 | — | — | +0/-0 |

### D. spec 同步（doc-modifier 阶段 5 处理，本计划只标注预期落点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec-providers | specs/tech/agent/providers_and_models/anthropic_impl.md | impl 落点段 | 修改 | 把 impl 文件路径引用从 `app/server/src/llm/...` 改为 `app/plugins/builtins/llm_anthropic/...`；补一段「impl 物理归 plugin 目录，主干只留接口」对齐说明 | doc-modifier 阶段 5 统一改 | — | +10/-5 |
| spec-providers | specs/tech/agent/providers_and_models/log.md | 版本条目 v0.0.191 | 新增 | 追加 v0.0.191：impl 物理迁 plugin，wire 逐字节不变 | doc-modifier 阶段 5 | — | +5/-0 |

## 影响面评估

**跨模块**：
- `app/plugins/builtins/llm_anthropic/`：4 个 impl .ts（provider/protocol/protocol-encode/protocol-parse-stream）从 shim/无 → 真 impl，+11 个 UT 文件迁入 `__tests__/`
- `app/server/src/llm/`：删 2 整文件（protocol-encode.ts -325 / protocol-parse-stream.ts -218）+ 2 文件瘦身（provider.ts -37 / protocol.ts -100）+ index.ts -2
- `app/server/src/agent/__tests__/stream-consumer-tool-e2e.test.ts`：2 行 import 改路径
- specs：2 文件（doc-modifier 阶段 5）

**破坏性变更**：无产品行为变化（wire 逐字节不变）。TypeScript 编译期：删主干 impl 类 → 必须同步删 `index.ts` 的 named re-export + 处理 2 处 test 值 import，否则 import 失败。

**依赖顺序**（同 PR）：
1. plugin 端先写好真 impl（A 节）
2. 主干端删 impl 类 + 清理 index.ts（B 节）
3. 测试迁移（C 节）
4. 跑全量 UT 验证 wire 行为不变
5. spec 同步在 doc-modifier 阶段 5 落（D 节）

**packaged 护栏**：迁移后 plugin 对主干 credentials 的 deep import 经 `build-plugins.ts` 的 `SERVER_IMPORT_RE` 自动改写为 `@app/server/dist/llm/credentials`，命中 asar 内 server 实例。**建议 coder 在收尾跑一次 `scripts/build-plugins.ts` + 检查 `app/plugins/dist/builtins/llm_anthropic/` 产出 4 个 `.cjs` 自包含 bundle**，验证 packaged 能编译（不强求跑真 packaged dmg，但 build-plugins 零失败是硬指标）。

**风险点**：
1. **protocol-encode.ts 超 300 行**：硬约束 wire 不变，整迁保 325 行；coder 可酌情轻拆（仅当 UT 全绿 + 语义完全等价），否则 follow-up。
2. **主干 import type 调用点漏处理**：所有 30+ 个 `import type {...} from '../llm/protocol'/'./llm/provider'` 依赖类型留主干。**类型留主干 → 调用点零改动**；但 `index.ts` 清理时若误删 type re-export 会导致连锁编译失败。MUST 保留所有 `export type` 行。
3. **测试 import 路径漏改**：2 处值 import（stream-consumer-tool-e2e + protocol-encode-cache）必须改路径；测试整体迁的 11 个文件必须改 `..` 层级（plugin `__tests__/` 看主干是 `../../../server/src/`）。
4. **packaged build 失败**：若 plugin 对主干 deep import 路径写错（如少一层 `../`），build-plugins 的 SERVER_IMPORT_RE 不匹配 → bundle 出错或 inline 失败。MUST coder 跑一次 `bun run scripts/build-plugins.ts` 验证零失败。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- 若 coder 发现 spec 与代码不符（如某类型实际在别处）→ 按代码实际调整 + 汇报偏离，orchestrator 记 doc-sync 待办，doc-modifier 阶段 5 统一修 spec
