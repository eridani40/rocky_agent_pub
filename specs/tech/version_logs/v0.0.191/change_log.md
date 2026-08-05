# v0.0.191 变更日志 — protocol/provider impl 物理迁入 llm_anthropic builtin plugin

> **版本轴发布说明**（事后偏差记录）。method 级 review 合同见同目录 `change_plan.md`。
> **主题**：把硬编码在 server 主干 `app/server/src/llm/{provider,protocol,protocol-encode,protocol-parse-stream}.ts` 的 anthropic impl **物理迁入** `app/plugins/builtins/llm_anthropic/`（builtin plugin）。主干只留接口 + 类型 + cross-impl 共用工具。**wire 行为逐字节不变**（UT 8739 + typecheck + build-plugins + AT 真 minimax 全绿守护）。

## A. 实际落地 = change_plan（一致）

- **§A plugin 端 4 个 impl 文件**：provider.ts（57 行）/ protocol.ts（139 行）/ protocol-encode.ts（138 行）/ protocol-parse-stream.ts（221 行）按表落，default export 类（provider/protocol）+ named export 纯函数（encode/parse-stream）。
- **§B 主干清理**：`provider.ts` 删 `AnthropicCompatibleProvider` 类保留 `LlmProvider` 接口；`protocol.ts` 删 `AnthropicMessagesProtocol` 类 + `mapStopReason` 保留全部 canonical/wire 类型；`protocol-encode.ts` + `protocol-parse-stream.ts` 整文件删；`index.ts` 删两个 impl 类的 named export 保留所有 type re-export。30+ `import type` 调用点零改动（类型留主干 → 调用点零改动验证）。
- **§C 测试迁移**：11 个 plugin impl UT 迁 `app/plugins/builtins/llm_anthropic/__tests__/`（provider + protocol-encode 5 个 + protocol-parse 4 个 + protocol-label）；2 处值 import（`app/server/src/agent/__tests__/stream-consumer-tool-e2e.test.ts` + `app/server/src/llm/__tests__/protocol-encode-cache.test.ts`）实际处理见 §B-3。
- **plugin 对主干依赖形态**（决策 2）：`import type` 接口/类型 + `import { pickKeyValue } from '../../../server/src/llm/credentials'` 值 import，packaged 经 `build-plugins.ts` `SERVER_IMPORT_RE` 改写命中 asar 内 server 实例（`bun run scripts/build-plugins.ts` 零失败验证）。
- **EP 机制 + factory 解析不变**：`LlmProviderPoint`/`LlmProtocolPoint` 已在 `BUILTIN_EXTENSION_POINTS`；`llm-client-factory.ts` 已按 `providerConfig.protocolId` 动态取 protocol impl（v0.0.53 起）；`scopes/default.yaml` 已登记 `anthropic_compatible` + `anthropic_messages` active。**本版本纯物理迁移，零机制改动**。
- **wire 行为逐字节不变**（硬约束）：reminder 过滤口径「最末 message」+ cache_control bp#2「最后非 reminder block」+ effort `output_config.effort` 注入 + stop sequences 映射 + role tool→user + 相邻同 role 合并，UT 守护全绿。

## B. 偏差清单（实际 vs change_plan）

### B-1. `protocol-encode.ts` 拆 helpers（决策 5 允许，零逻辑变更，无需 follow-up）

**change_plan 决策 5**：「`protocol-encode.ts` 325 行超限处理：硬约束 wire 逐字节不变 + 纯迁移，本版本**整迁不动逻辑**（coder 可酌情轻拆，但 MUST UT 全绿 + 语义等价；否则整迁保 325 行 + 在 `change_log.md` 记 follow-up 拆分 TODO）」。

**实际落地**：coder 选择**轻拆**（决策 5 允许的分支 a），参照 `rocky_context/assemble/base_builder + base_builder_helpers` 范式，把单文件 325 行拆为：
- `protocol-encode.ts`（138 行）：`encodeAnthropicMessages` 入口 + `EFFORT_WIRE_MAP` 常量 + import 5 个 helpers。
- `protocol-encode-helpers.ts`（210 行）：`CACHE_CONTROL_EPHEMERAL` 常量 + 8 个 encode 纯函数（`encodeContentBlock` / `mergeAdjacentSameRole` / `encodeTools` / `encodeToolResultContent` / `extractSystemText` / `injectLastNonReminderCacheControl` / `encodeMessage` / `isReminderBlock`）。

**偏差性质**：纯函数搬运（零逻辑变更），符合决策 5 分支 a 约束（UT 全绿 + 语义等价）。**无需 follow-up**——两文件各 138 / 210 行均在 300 行上限内，拆分目标已达成。

### B-2. 8 个 trunk 测试值 import plugin impl → tsconfig exclude（非 change_plan 预期项）

**背景**：change_plan §C 只列了 `stream-consumer-tool-e2e.test.ts`（2 行 import 改路径）+ `protocol-encode-cache.test.ts`（迁 plugin）两处值 import。实际验证发现**另外 6 个 trunk 测试也值 import plugin impl**（因被测代码 `client.ts` 留主干，但 client 需要 provider+protocol impl 做集成测试）：
- `app/server/src/llm/__tests__/client.test.ts`
- `app/server/src/llm/__tests__/client-http-error.test.ts`
- `app/server/src/llm/__tests__/client-onwire.test.ts`
- `app/server/src/llm/__tests__/client-stream-cost.test.ts`
- `app/server/src/llm/__tests__/client-stream-error.test.ts`
- `app/server/src/__tests__/mock-llm.test.ts`
- `app/server/src/__tests__/mock-llm-compact-nonstream.test.ts`

**问题**：这些 trunk 测试 `import AnthropicCompatibleProvider from '../../../../plugins/builtins/llm_anthropic/provider'` 会跨 project references 边界（server `rootDir=./src` → 引用 plugin 目录外）→ `tsc --build` 报 rootDir 错。

**处理**：`app/server/tsconfig.json` `exclude` 加 8 条（含原 `stream-consumer-tool-e2e`）把这些测试排除出 `tsc typecheck`，由 vitest 跑（vitest 独立 transpile 不受 rootDir 约束）。`tsconfig.json //` 注释记录理由：「v0.0.191：跨边界 import llm_anthropic plugin impl 的测试由 vitest 跑（不进 tsc typecheck，避免 rootDir 跨 project references 边界）」。

**偏差性质**：server→plugin 反向依赖（trunk 测试需要 plugin impl 做集成测试）是物理迁移的自然副产物。**这是结构性约束**：server 主干类型留主干、impl 归 plugin 后，trunk 集成测试必然跨边界。exclude 是最小代价方案（不破 project references、不挪被测代码、不弱化 rootDir）。后续若新增 trunk 集成测试涉及 plugin impl，同样走 exclude 范式。

### B-3. `protocol-encode-cache.test.ts` 实际留在 trunk（非 change_plan §C 所说迁 plugin）

**change_plan §C**：`protocol-encode-cache.test.ts` 从 `app/server/src/__tests__/` 迁 plugin，改 `encodeAnthropicMessages` import 为 `'../../../plugins/builtins/llm_anthropic/protocol-encode'` + **`AnthropicMessagesProtocol` import 改从 plugin `'../../../plugins/builtins/llm_anthropic/protocol'`**。

**实际落地**：grep 验证 `protocol-encode-cache.test.ts` **实际无 `AnthropicMessagesProtocol` import**（只 import `encodeAnthropicMessages` 一个符号）。该测试已在 §B-2 处理的 8 个 trunk 测试之列（值 import plugin `protocol-encode` → tsconfig exclude 由 vitest 跑），**未迁移到 plugin 目录**。

**偏差性质**：change_plan 对该测试的 import 描述与实际不符（spec 落后于代码的一例）。coder 按代码实际处理（留 trunk + exclude），等价于 §B-2 范式。**无需补迁**——该测试的被测对象（`encodeAnthropicMessages` 的 cache_control 行为）已由 plugin 内 `protocol-encode.test.ts` 等 UT 覆盖；trunk 侧的 cache 测试额外做跨层集成（经 client 路径），留 trunk 合理。

### B-4. 路径层级修正：plugin `__tests__/` 看主干是 4 层非 3 层

**change_plan 风险点 3**：「测试整体迁的 11 个文件必须改 `..` 层级（plugin `__tests__/` 看主干是 `../../../server/src/`）」。

**实际落地**：plugin `__tests__/` 目录看主干是 **4 层** `../../../../server/src/llm/...`（plugin 目录 = `app/plugins/builtins/llm_anthropic/`，`__tests__` 是其子目录 → 4 个 `..` 回到 `app/`，再进 `server/src/llm/`）。change_plan 写的 3 层有误，coder 按实际 4 层调整。

**偏差性质**：change_plan 路径层级计数小错（少算一层 `__tests__`）。coder 按实际修正，不影响功能。已体现在 plugin `__tests__/` 所有文件的 import 语句。

### B-5. `.gitignore` 加 plugin `.js/.d.ts` 副产物规则（未列 change_plan）

**背景**：plugin 源码是 `.ts`，但 bun / tsc 运行时偶发 emit `.js` / `.d.ts` 副产物到 plugin 源码目录（与 `app/plugins/dist/` 编译产物不同——dist 是 build-plugins.ts 的 bundle 输出已 ignore，这里是源码目录被工具链偶发污染）。

**处理**：`.gitignore` 加两行：
```
# v0.0.191: plugin 源码目录下 bun/tsc 运行时偶发 emit 的 .js/.d.ts 副产物（源码是 .ts）
app/plugins/builtins/**/*.js
app/plugins/builtins/**/*.d.ts
```

**偏差性质**：迁移过程中发现的环境卫生规则（非 change_plan 预期项）。零功能影响，防止误提交编译副产物。

## C. spec 同步（doc-modifier 阶段 5 已落）

- `specs/tech/agent/providers_and_models/index.md`：frontmatter `updated` → 2026-07-23；§④ 加原则 7（impl 归 plugin，主干只留接口 + 类型 + cross-impl 共用工具，v0.0.191）。
- `specs/tech/agent/providers_and_models/anthropic_impl.md`：frontmatter `updated` → 2026-07-23；顶部加「impl 物理归 plugin 目录（v0.0.191）」对齐说明段；§4a/§5.1 代码路径 impl 落点改为 plugin 路径。
- `specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md`：§3.5.1 `encodeMessage` 落点 + §3.7 EOS 代码路径，impl 文件路径改为 plugin；frontmatter `updated` → 2026-07-23。
- `specs/tech/agent/providers_and_models/[P0]cache_control.md`：§6 cache_control 落地点路径改为 plugin；frontmatter `updated` → 2026-07-23。
- `specs/tech/agent/providers_and_models/log.md`：追加 v0.0.191 版本条目（本日志的位置轴镜像）。
- **接口契约本身不动**：`LlmProvider` / `LlmProtocol` 接口签名、字段、方法不变（接口留主干）。

## D. code == spec 核查结论（原则 12 MANDATORY）

**核查范围**：`providers_and_models/` KB 全文 + plugin impl 实际代码。

**核查结论**：代码未偏离 spec 契约——

1. **「protocol 只做纯翻译」**（`index.md §④` 原则 5）：plugin `protocol-encode.ts` 头部注释明确「encode 只读 role + content，不读 Message.sender；sender 展平职责归 llm/logical-view.ts，protocol 自身只做协议映射」。代码 ✅ 对齐。
2. **「数据 vs 行为分离」**（原则 2）：plugin `provider.ts` 注释「impl 无状态，**不存 providerConfig**——config 作 buildAuthHeaders 入参传入」；构造签名 `(implId, cfg={})` 遵循 builtin-loader 约定。代码 ✅ 对齐。
3. **「EP 按 type 解析」**（原则 6）：`plugin.json` 登记两个 extImpls（`anthropic_compatible` point=llm_provider / `anthropic_messages` point=llm_protocol）；`llm-client-factory.ts` 按 `providerConfig.protocolId` 查 `pluginManager.getExtensionImpls(LlmProtocolPoint)` 命中 implId（v0.0.53 起机制不变）。代码 ✅ 对齐。
4. **「标准值自承载为代码常量」**（原则 4）：plugin `protocol.ts` 头部注释「标准值（path/contentType/label）自承载为 readonly 常量」。代码 ✅ 对齐。
5. **「零件唯一归属」**（原则 1）：encode 纯函数（含 cache_control bp 注入）归 plugin impl；接口契约归主干 `protocol.ts`；cross-impl 共用工具（credentials/logical-view/client）归主干。代码 ✅ 对齐。

**未发现代码绕过 spec 声明的链路/机制**（教训 v0.0.49 类偏差未再现）。本版本是纯物理迁移，spec 契约（接口签名、EP 机制、wire 行为）全部不变，spec 只需同步 impl 落点路径即可。
