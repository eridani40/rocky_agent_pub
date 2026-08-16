---
type: log
title: Providers & Models KB 变更记录
updated: 2026-08-15
---

# Providers & Models KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-08-15 · v0.0.361（cache_control 三断点体系 — 删 wire drop/避让，历史块全保留）

- **`[P0]cache_control.md`**：§1 定位改三断点（bp#1 system 末 + bp#T tools 末 + bp#2 messages 末固定落位）+ 历史 reminder 块全保留；§2.2/§2.3 决策依据改写（wire 无过滤，bp#2 前缀命中）；§3.2 改固定末位（删反向避让扫描）；§3.3 改历史块全保留（删 drop 分支）；§3.4 效果表加 tools 行；§4.1 密度行 + §5 两层关系 + §6 代码对齐表（`injectLastNonReminderCacheControl` 删 / `encodeMessage` drop 删 / `encodeTools` bp#T 新增）+ §7 边界 + §8 原则全同步；frontmatter `updated`。
- **`anthropic_impl.md`**：§4 cache control 落地细节改三断点（2→3 breakpoint；JSON 示例加 tools；实现细节改 `encodeTools` bp#T + bp#2 固定末位 + 历史块全保留；删 v0.0.52 反向扫理由段）。
- **`index.md`**：cache_control 概念行 + 导航表两行改三断点口径（删「最后非 reminder block + wire 过滤」旧表述）。

## 2026-08-15 · v0.0.359（路由候选成功点写 success target registry）

- **`[P0]model_routing.md §4` 路由循环伪码**：⑤ 成功分支补 `recordSuccessTarget(该候选 target)`——squad 用量统计归属记实际命中 physical model（registry 契约 → `../llm_caller/[P0]success_target_registry.md` 新）。
- 详情：`specs/tech/version_logs/v0.0.359/change_log.md`

## 2026-08-15 · v0.0.353（模型路由调用链路正确性：时区调度 + T4 根治 + T5 Langfuse 语义校准）

- **`[P0]model_routing.md §2.1`**：TimeCondition 增 `timezone?`（合法 IANA，缺省 `Asia/Shanghai`，向后兼容；非法硬拒 400）。
- **`[P0]model_routing.md §4`**：显式 session model 继承同 providerId+modelId 启用条目中首个带 `timeCondition` 者的时间条件；分支 2 `SessionConfig.modelRoutingPlan` 增 `planName?`；分支 2 `SessionConfig.modelId/providerId` 取 `sessionPersist` 口径（T4 根治）。
- **`[P0]model_routing.md §5`**：wire body 一致性段改写为 T4 根治版——调用现场（`routing_loop.ts` / `llm_caller.ts`）在 `buildRequest` 前注入当前 target/candidate `modelId`，`buildRequest` 信任 caller 不再内部重写；旁路 run `recordSkippedCandidate` 逐条记录被跳候选。
- 详情：`specs/tech/version_logs/v0.0.353/model-routing-trace-correctness/change_log.md`

## 2026-08-15 · v0.0.350（四渠道 coding plan native + 额度/余额查询）

- **`[P0]llm_provider_interface.md`**：ProviderName +4 native（kimi/glm/minimax coding plan + deepseek_api）；LlmProvider 加可选 `queryQuota?`（QuotaSnapshot/QuotaTier 统一形状，决策⑧）；实现表扩 4 impl 行（均 extends AnthropicCompatibleProvider，glm 裸 api_key 特例）；新增 §3.5（deriveQuotaBaseUrl 查询域推导 / impl 顺序约束 anthropic_compatible 首位 / 消费方=GET /provider/quota 聚合 + 前端 5min 轮询 LastGood）。
- **api `02-llm-chat.md` 1.7→1.8**：§5.6 `GET /provider/quota` 聚合端点（Promise.all 并发 + 单渠道错误隔离；QuotaSnapshot 形状）+ §5.2 name 放宽 ProviderName union（白名单 5 值）。
- **UI**：新组件 `component-coding-plans-quota-footer.md`（额度型两行/余额型/展开纯文本明细 boss 铁律）+ fields 类型选择器 + section-providers name 联动三边界 + primitive key-choice-cards +labels。
- 详情：`specs/tech/version_logs/v0.0.350/change_log.md`

## 2026-08-15 · v0.0.349（provider 删除入口 + 方案 dangling 双语义）

- **`[P0]model_routing.md` §4 全 dangling 降级段**：挂载方案**所有候选** provider 已删（buildClientFromCandidates 全 throw）→ caller 段 try/catch 降级 `ModelNotConfiguredError`（400 MODEL_NOT_CONFIGURED，message 含「方案内所有模型不可用」，与分支 1 跑空同时机同构）；MUST NOT 静默回退默认模型（D11）。dangling 双语义（runtime 跳过 + 编辑拦保存）权威 = api `21-model-routing.md §2.7`（1.1.0）。
- 详情：`specs/tech/version_logs/v0.0.349/change_log.md`（T1 后端降级 / T2 前端删除入口+dangling 预检 / T3 BUG-003·004 批修）

## 2026-08-14 · v0.0.347（模型路由降级：组合方案 + attempt 内路由 + 三态熔断）

- **`[P0]model_routing.md` 新增**：模型路由降级全谱（§1 概念 + §2 数据形状 + §3 resolve 双分支 + §4 挂载查询 + §5 routing 循环 + §6 熔断三态 + §7 差异化重试 + §8 app_config 存储 + §9 边界）。§4 含 **academy 排除**（Major-2 修复：`resolveModelRoutingPlan` 加 `isAcademy` 参数，academy 直接分支 1）+ 分支 2 client 组装（`buildClientFromCandidates` 按候选链 buildLlmClient）；§5 含装配链（clientBuilder 条件注入 + 占位回退）+ **方案级 circuit 覆盖**（Major-1 修复：registry 触点全传第 4 参 plan.circuit + entry 已存在同步更新 cfg）；§9 时间控件自研已发生（决策⑧ 兜底）+ **Task 4 UI v2 弹层化**（草稿态隔离 + 视觉语义翻转 + footer 校验）。
- **`[P0]app_config.md`**：group 集合补 `model_routing_plans` + `model_routing`（v0.0.347 新增，指向 model_routing.md §8）。
- **UI specs（Task 4 UI v2 后）**：`component-hour-grid-picker.md` / `component-model-routing-plan-editor.md` / `section-model-routing-plans.md` 按实际代码重写（弹层草稿态 / 7 列行委托 / 两层结构快照回滚）+ 新建 `component-plan-card.md` / `component-plan-item-row.md` / `model-routing-plan-lib.md`（300 行门禁拆分产物）。
- **[P0]model_routing.md T5 增量**（老板 20:51 拍板「20 次失败 12 次就不请求」）：§2.1 CircuitConfig 加 `windowSize`（默认 20，校验整数 [1,1000] + 生效 minRequests≤windowSize）+ §6.1 熔断错误率轨道改**滑动窗口口径**（环形 buffer 最近 N 次请求，取代终身累计；窗口样本 < minRequests 时沉默、连续失败轨道兜底；状态转换不清窗；窗口重建仅 entry 新建/编辑改 windowSize）+ snapshot.errorRate 窗口口径（failureCount/totalRequests 终身保留）。i18n circuitMinRequests 标签改「窗口样本数」/ "Min Window Samples"。
- **[P0]model_routing.md T6 增量**（老板 21:44+22:22 拍板严格互斥）：§2.2 挂载段加「二选一严格互斥」——单 select（上模型/下方案）、双向清（选模型清挂载、选方案清默认模型）、squad PATCH 双非空 400 `mutually exclusive`、playground 先清后写崩溃安全、存量双设不迁移、回退链重定义（方案删除→未设置态 400 引导，无休眠接管）。配套 UI spec `common/component-model-or-plan-picker.md`（新组件）+ `06-studio.md §3.2` 合并 select + `section-default-models-and-request.md`。
- 详情：`specs/tech/version_logs/v0.0.347/change_plan.md` + `change_log.md`（T1/T2/T3 实现核对 + 偏离 + Major 修复 + 装配链回归 + Task 4 UI v2 改版）

## 2026-08-07 · v0.0.279（effort 覆盖链：成员 > 团队 effortDefault > 厂商默认）

- **`[P0]llm_protocol_interface.md §3.8` 补 studio 覆盖链注记**：透传链后加「studio 覆盖链（[v0.0.279]）」——`buildSessionConfigFromDeps` 与 resolveModel 同区调 `resolveEffort(sessionPersist.effort, isStudio && squad ? squad.effortDefault : undefined)`（纯函数 session-config.ts L107-114）：成员显式档（low/high/max）→ 用之；否则团队 `squad.effortDefault`（low/high/max）→ 用之；否则 `undefined`（厂商默认，encode 不注入）。成员 `'default'` 与 `undefined` 同语义；resolve 时机与 model 一致（每次 `resolveConfigBySid` 现拉无 cache）；playground/academy/standalone 无 squad → 只 session 一层；subagent 继承父 resolve 结果不重复 resolve；`squad.effortDefault` 由 schema `required:false` + PATCH 校验双保证合法值。encode 层零改动（config.effort 已是 low/high/max/undefined）。
- 详情：`specs/tech/version_logs/v0.0.279/change_plan.md`（12 行 method 级表）+ `change_log.md`

## 2026-07-31 · v0.0.230（model_resolve 收窄 academy 链去 app 默认兜底 — 群体级无应用层默认）

- **`[P0]model_resolve.md` 收窄 academy 链**：`buildFallbackChain` academy 分支删第三档 `readPlaygroundDefault` push（session → classroom.defaultModel → throw）；`resolveModel` throw 按 sessionType 给引导文案（academy →「教室未配置默认模型，请先在教室设置中选择一个具体模型」；playground/studio 保持默认）。§1.1 解决的问题、§2 接口签名（classroom 注释）、§3 fallback 链表、§3.1 academy 不经 resolveDefaultModel、§4 原则 7/8、§6 错误体、§5 academy 同链均同步。app 默认是 playground 个体级概念，误用为群体级（academy/studio）默认档是错的（用户确认）；academy 对齐 studio 两档链。
- **`[P0]model_resolve.md` 错误文案按 sessionType 引导**：`ModelNotConfiguredError` message 参数由 `resolveModel` throw site 分支注入（academy → 引导去教室 head 配置）；`code`/`detail.sessionType`/HTTP 400 不变。
- 详情：`specs/tech/version_logs/v0.0.230/change_plan.md`（第 9/10 行）+ `[P0]model_resolve.md`（architect 本版已同步）

## 2026-07-23 · v0.0.195（model_resolve §3.3 文字对齐代码 — findProviderForModel 候选集 = listEnabledProviders）

- **`[P0]model_resolve.md §3.3` 文字对齐代码**：原文字「hint 非空精确匹配该 provider——`p.id === hint && ...`」暗示在全量 provider 上匹配，未点明候选集已先经 `listEnabledProviders` 过滤 disabled provider。对齐为「候选集 = `listEnabledProviders`（已过滤 disabled provider），hint 精确匹配在该 enabled 集合内做；hint 指向 disabled provider → 不在集合 → find 不到 → null → 视为未命中继续 fallback」。§4 原则 4 同步加「候选集恒为 listEnabledProviders」一句。**纯文字澄清，resolve 行为零变更**（代码 `findProviderForModel` 自 v0.0.155 起就是走 listEnabledProviders，spec 滞后）。
- 详情：`specs/tech/version_logs/v0.0.195/change_plan.md`（§spec 同步项）

## 2026-07-23 · v0.0.191（anthropic impl 物理迁入 builtin plugin llm_anthropic — 主干零硬编码 impl）

- **impl 物理归 plugin 目录**：`AnthropicCompatibleProvider` + `AnthropicMessagesProtocol` + `encodeAnthropicMessages` + `parseAnthropicSseFrame`/`parseAnthropicUsage` 等所有 anthropic 专属 impl 类/函数从主干 `app/server/src/llm/{provider,protocol,protocol-encode,protocol-parse-stream}.ts` **物理迁入** `app/plugins/builtins/llm_anthropic/`（builtin plugin，经 EP 注册 + `llm-client-factory` 按 implId 解析）。主干 `app/server/src/llm/` 清理为**只留接口 + 类型 + cross-impl 共用工具**：`LlmProvider`/`LlmProtocol` 接口 + `CanonicalRequest`/`CanonicalResponse`/`WireBody`/`WireResponse`/`RequestParams`/`StreamEvent`/`provider-types`/`protocol-types` 类型（30+ 调用点 `import type` 零改动）+ `client.ts`/`credentials.ts`/`logical-view.ts`/`http_error.ts`/`resolve-provider-config.ts` 共用工具。`index.ts` 删两个 impl 类的 named export，保留所有 type export。
- **wire 行为逐字节不变**（硬约束，UT 8739 + typecheck + build-plugins + AT 真 minimax 全绿守护）——含本版本刚修的 reminder 过滤口径「最末 message」+ cache_control bp#2「最后非 reminder block」+ effort `output_config.effort` 注入 + stop sequences 映射 + role tool→user + 相邻同 role 合并，原样保留。
- **plugin 对主干的依赖形态**：`import type {...}` 接口/类型（零运行时依赖）+ `import { pickKeyValue } from '../../../server/src/llm/credentials'` 值 import（cross-impl 共用工具，packaged 经 `build-plugins.ts` 的 `SERVER_IMPORT_RE` 改写为 `@app/server/dist/llm/credentials` + `@app/server` external，与 rocky_context 同范式）。
- **`protocol-encode.ts` 拆 helpers**（决策 5 允许的轻拆）：单文件 325 行超 300 行上限 → 拆为 `protocol-encode.ts`（138 行，`encodeAnthropicMessages` 入口 + `EFFORT_WIRE_MAP`）+ `protocol-encode-helpers.ts`（210 行，8 个 encode 纯函数：`encodeContentBlock`/`mergeAdjacentSameRole`/`encodeTools`/`encodeToolResultContent`/`extractSystemText`/`injectLastNonReminderCacheControl`/`encodeMessage`/`isReminderBlock` + `CACHE_CONTROL_EPHEMERAL` 常量），参照 `rocky_context/assemble/base_builder+_helpers` 范式。零逻辑变更（搬文件不改 wire 输出）。
- **测试跟随被测代码迁**：11 个 plugin impl UT 迁 `app/plugins/builtins/llm_anthropic/__tests__/`；8 个 trunk 测试因值 import plugin impl（client*、stream-consumer-tool-e2e、mock-llm*）由 vitest 跑（`app/server/tsconfig.json` exclude 避免 rootDir 跨 project references 边界）。
- **`index.md §④` 加原则 7**：impl 归 plugin、主干只留接口 + 类型 + cross-impl 共用工具（v0.0.191）；EP 机制不动 / wire 行为不变（纯物理迁移）。
- **`anthropic_impl.md`**：顶部加「impl 物理归 plugin 目录（v0.0.191）」对齐说明（主干只留接口 + 类型 + cross-impl 共用工具；EP 机制 + factory 按 implId 解析不变；plugin 对主干依赖形态）；§4a/§5.1 代码路径 impl 落点从 `app/server/src/llm/...` 改为 `app/plugins/builtins/llm_anthropic/...`。
- **`[P0]llm_protocol_interface.md` / `[P0]cache_control.md`**：impl 落点引用（§3.5.1 `encodeMessage` / §3.7 EOS 代码路径 / §6 cache_control 落地点）从主干路径改为 plugin 路径；接口契约本身不动（接口留主干未变）。
- 详情：`specs/tech/version_logs/v0.0.191/change_plan.md`（method 级变更契约）+ `specs/tech/version_logs/v0.0.191/change_log.md`（实际落地 vs change_plan 偏差清单）

## 2026-07-16 · v0.0.158.compact_model_resolve（删「独立 summary 模型」层 — chat/compact 同链 + 唯一入口收敛）

- **`[P0]model_resolve.md` 全文重构**：
  - §2 `ResolveModelInput` 删 `task: 'chat' | 'summary'` 字段 + `bodyOverrideModelId` / `bodyOverrideProviderId` 两字段；`squad` 子集删 `summaryModelDefault` / `summaryModelDefaultProviderId`。`ModelNotConfiguredError` 构造签名与 `detail` 删 `task` 字段（只留 `sessionType`）。
  - §3 fallback 链 4 行收敛为 **chat 单链 2 行**（playground → `default_models.chat` / studio → `squad.modelDefault`）；删 summary 子链、删 body override 步骤。
  - §3.1 `resolveDefaultModel` 签名去 task 参数（内部固定读 chat key / squad.modelDefault）。
  - §4 原则 6 重写为「chat/compact 同链（v0.0.158 收敛，覆盖旧"summary 链独立于 chat 链"原则）」；原则 7 错误体 detail 简化。
  - §5 表加 `bootstrap.ts:setForkedRunner` / `setConsolidationRunner` 闭包一行（**v0.0.158 唯一入口**：runner 闭包内首行 `agentManager.resolveConfigBySid(input.sessionId)` 自 resolve，chat/compact/T1 记忆整理都从此入口取 config）；§5.1 调用关系图加自动 compact / T1 记忆整理两条分支。
  - §6 错误体 JSON 示例删 `"task"` 字段。
  - §8 边界表：squad 复合字段行删「summaryModelDefault*」；default_models group 行标「只留 chat key」；新增「唯一入口 `resolveConfigBySid`」行。
- **`[P0]llm_client_interface.md` / `[P0]llm_protocol_interface.md` / `[P0]llm_model_interface.md` / `anthropic_impl.md` 无改动**（本版本只动 resolve 层，不动 4 件套契约）。
- **`index.md ①` 概念表 `model resolve` 行**：措辞更新为 v0.0.158 收敛（chat 单链 2 行 + 唯一入口收敛）。
- 详情：`specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md`（§A model_resolver）+ `specs/tech/version_logs/v0.0.158.compact_model_resolve/change_log.md`（同步 spec 偏离清单）

## 2026-07-16 · v0.0.155（ModelRef 复合 + resolve 链去 member.model + resolveDefaultModel 单点出口 — 后端重构）

- **§4 原则 3 重写：ModelRef = `{providerId?, modelId}` 复合**（INV-B1）：从 v0.0.89 的「纯 modelId string」升级为复合——providerId optional back-compat（旧数据无 providerId → resolver hint 空 → 跨 provider 反查兜底，无需 migration，INV-B3）。三持久化字段（`session.{modelId, providerId?}` / `squad.{modelDefault, modelDefaultProviderId?}` / `squad.{summaryModelDefault, summaryModelDefaultProviderId?}`）统一复合结构。
- **§3 fallback 链简化为 4 核心链**：原 v0.0.89 6 行表含 `member.model` 步骤；v0.0.155 后 member.model 硬删（INV-A1），leader/mate/squad session 走相同链（仅读 session + squad）。候选从裸 string 改 `{modelId, providerIdHint?}` 元组（INV-B1）。
- **§3.1 `resolveDefaultModel` 单点出口新增**（INV-A5，用户裁决 2026-07-16 方案 2）：消除原 `buildFallbackChain` 内散乱的 playground/studio default 分支（`readPlaygroundDefault` :176/179/181 vs studio 直读 `squad?.modelDefault` :191/196），抽统一函数按 sessionType 分发。**MUST NOT 跨来源**（playground 读 squad / studio 读 app_config）；**MUST NOT 给 studio 加 app_config fallback**（squad.modelDefault 必填保持，未设 → throw，语义与 v0.0.89 起一致）。
- **§3.3 `findProviderForModel` 双路**（INV-B2）：签名加 `providerIdHint?: string`——hint 非空 → 精确匹配该 provider（消除同名 modelId 歧义，解决 v0.0.9 砍 providerId 留下的坑）；hint 空 → 跨 enabled providers 反查（back-compat 救存量）。
- **§2 `ResolveModelInput` 重构**：删 `member?: { model?: string }` 字段（INV-A2）；加 `sessionProviderId` / `bodyOverrideProviderId`（作 sessionModelId/bodyOverride 的精确 hint）；`squad` 子集加 `modelDefaultProviderId` / `summaryModelDefaultProviderId` 复合字段。
- **§1.1 重构动机记录**：消除 v0.0.154 暴露的 member.model 表层刷漆问题——根本是运行配置该挂 session（像 effort/approval），member 退管理概念；ModelRef 该复合解同名歧义。
- 代码：`app/server/src/services/model-resolver.ts` 全文重构（去 member + resolveDefaultModel 新增 + findProviderForModel 双路 + ResolvedModel 注释复合语义）。
- 详情：`specs/tech/version_logs/v0.0.155/change_plan.md`（段 A + INV-A1/A2/A5/B1/B2/B3/C1）

## 2026-07-16 · v0.0.154（member.model 纯 modelId 纠错 — picker 写入侧约定补充 / 后端零改动）

- **`[P0]model_resolve.md §4 原则 3` 不变量不动**：重申 ModelRef=纯 modelId string 是三持久化字段（`session.modelId` / `squad.modelDefault` / `member.model`）的统一契约；resolver 输出 `{providerId, modelId}` 两个字段，modelId 反查 providerId。
- **§4 原则 3 追加前端写入侧子句**：「前端 picker 写入 PATCH body 也用纯 modelId——picker 内部反查 provider（`findProviderIdByModelId`）仅用于显示名渲染，不进持久化字段」。这是前端对齐补丁，**后端零改动**（`validateModelId` / `resolveModel` / 6 处 handler 调用点不动）。
- **背景（spec 纠错）**：前端 `component-member-chat-input-bar.tsx` 自 v0.0.63 起误以 `providerId/modelId` 斜杠格式写 PATCH body model，与后端 `validateModelId` 纯 modelId 精确匹配不符 → 400 → 被前端 `.catch(console.warn)` 静默吞 → `member.model` 维持原值（空/inherit）→ resolver 永远回退到 `squad.modelDefault`，导致 member-chat 模型选择「选完无效」。是 v0.0.113 同款 `squad.modelDefault` 读侧修复（`parseModelRef` → 纯 modelId 反查）的漏网成员（漏在写入侧 + 读侧双份）。
- **三 spec 对齐**：本文（权威）+ `specs/ui/components/chat-page/component-input-model-picker.md §11` + `specs/api/overall/11-squad.md §4.5` 同步描述 `member.model` = 纯 modelId 契约。
- 详情：`specs/tech/version_logs/v0.0.154/change_plan.md`

## 2026-07-14 · v0.0.143（删除 per-model `default` 字段 — 死字段清理）

- **`[P0]llm_model_interface.md` 删 `LlmModelConfig.default?: boolean`**：该字段（"是否该 provider 实例的默认模型"）为死字段——`client.ts` 不读、透传链 end-to-nowhere，已被 `app_config/default_models`（playground 默认模型 record）取代。接口声明 + 示例 JSON 的 `"default": true` 一并删除。
- **兜底语义降级（`session-provider-utils.resolveProviderModel`，@internal 非主路径）**：删字段前兜底选 model 优先级为「enabled default → 首个 enabled → 首个」；删后简化为「首个 enabled → 首个 model」，无 default 概念。主路径统一走 `services/model-resolver.ts:resolveModel`（playground 走 `default_models.chat`、studio 走 squad 配置），本降级安全。
- **body 兼容忽略**：`POST /provider/:id/model` / `PUT` 对 body.default 静默忽略（不写入、不报错，同 v0.0.53 删 model.protocolId 范式）。
- **边界不动**：保留字 `modelId==='default'` 短路语义、`app_config/default_models` group、`paramConstraints.*.default`、`credentials.keyRef "default"` 均不涉及。
- 详情：`specs/tech/version_logs/v0.0.143/change_plan.md`

## 2026-07-11 · v0.0.113（studio 模型 hover 显「未配置」修正 — 前端格式错配，非 resolve）

- **`[P0]model_resolve.md` 无改动，重申其正确性**：v0.0.113 实测确认 studio 分支 `buildFallbackChain` **不读 `app_config.default_models`**（§3/§4 正确）；`squad.modelDefault` 存盘为**纯 modelId**（如 `"MiniMax-M3"`），schema required 非空，建队 seed 全局默认 → studio chat resolve 恒命中 `squad.modelDefault`（澄清 req「对话能 resolve 到默认」）。
- **前端 bug 定位（不涉本 KB 契约）**：studio 模型 picker hover 显「未配置」= 前端 `parseModelRef(squad.modelDefault)` 格式错配——它要求 `providerId/modelId`（含 `/`），而 squad.modelDefault 是纯 modelId（无 `/`）→ 返 null → hasDefault=false。修法：前端对纯 modelId 反查 provider（同 playground 内部逻辑）。**无后端/resolve 改动**。详见 `specs/ui/components/chat-page/component-input-model-picker.md`。
- **连带修正 stale**：`specs/tech/squad/[P1]session_config_studio.md §3` modelId 行 + `handlers/session-config.ts:134` 注释原写「?? app_config 默认（D5）」为 stale（v0.0.89 已废），本版本对齐到 resolveModel 真相。
- 详情：`specs/tech/version_logs/v0.0.113/change_log.md`

## 2026-07-08 · v0.0.89（model resolve 统一抽象 — resolveModel + ModelNotConfiguredError）

- **新增 `[P0]model_resolve.md`**：把 model resolve 决策从分散在 4 处 handler 的 if/else（playground/studio × chat/summary 4 链各写一遍）抽到**单一无副作用纯函数** `resolveModel(input) → {providerId, modelId} 或 throw ModelNotConfiguredError`。6 行 fallback 表（playground chat/summary + studio squad chat/summary + studio leader/mate chat/summary）一处定义；保留字 `default`/`"none"`/`""`/`undefined` 统一走 fallback 链（不短路）；fallback 链跑空抛 `ModelNotConfiguredError`（handler catch 返 400 `{code:"MODEL_NOT_CONFIGURED", message, detail:{sessionType,task}}`）。
- **核心约束**：① ModelRef=纯 modelId string（resolver 输出 `{providerId, modelId}`，modelId 不含 `:` 拼接）；② studio 完全不读 `app_config.default_models`（playground 专属，混读会让 studio 默认值漂移到全局）；③ cross-provider 反查替代直接读 `session.providerId`（历史持久化字段不代表主动选择）；④ summary 链独立于 chat 链（优先 `default_models.summary` / `squad.summaryModelDefault`）。
- **代码落点**：`app/server/src/services/model-resolver.ts`（resolveModel + ModelNotConfiguredError，221 行）；保留字判定 helper `isReservedModelId` / `normalizeReservedModelId` 抽到 `services/model-validation.ts`（4+ handler 复用，替代 inline `mid === 'default' || mid === 'none' || mid === ''` 重复）；`session-provider-utils.resolveProviderModel` 标 `@internal`（仅 resolver 复用，不再被 handler 直接调，机械解析兜底保留）。
- **6 处 handler 调用点**：`session-config.buildSessionConfigFromDeps` 加 `task?: 'chat' | 'summary'` 参数（缺省 `'chat'`，session-compact 显式传 `'summary'`）→ 内部调 resolveModel（**handler 不双 resolve**：handler 层仅校验 + 落盘，真正 resolve 在 deliverTo → buildSessionConfigFromDeps 单点出口）；session-compact/session-messages/session-run catch ModelNotConfiguredError 返 400 错误体；session POST 默认写 `modelId:'default'`；PUT body.modelId 接受 `default`/`none`/具体（`none` 规范化为 `default` 落盘）；member validateModelId 注释更新（保留字 default=inherit）。
- **`index.md`**：① 概念表加 model resolve 行；⑤ 导航加 `[P0]model_resolve.md`（独立分类）；frontmatter `updated` → 2026-07-08。

详情：`specs/tech/version_logs/v0.0.89/change_log.md`

## 2026-07-02 · v0.0.53（protocolId 归属迁移 model→provider + protocol impl 加 readonly label）

- **归属迁移（S1，锁 1 provider : 1 protocol）**：`protocolId` 从 `LlmModelConfig` 迁到 `LlmProviderConfig`（必填，per-instance 数据）；`LlmModelConfig.protocolId` **物理删除**（不保留 override，单一事实源）。`[P0]llm_provider_interface.md §2/§3.4/§5` 同步；`[P0]llm_model_interface.md §2/§3.4/§4/§5` 同步（§3.4 标题由「引用 provider 实例 + protocol impl」改为「引用 provider 实例」，§4 示例 JSON 删 protocolId）。
- **核心设计原则**：`index.md §④` 加原则 6「protocolId 选择归 provider（1:1 锁定）」+ 原则 1「零件唯一归属」追加 `protocolId 选择→provider`。理由：protocol 挂 path、provider 挂 baseUrl，二者必须同实体；同 provider 挂多 protocol 则每个对应不同 baseUrl，无法共享同一 provider 实例。
- **protocol impl 加 label（S2）**：`[P0]llm_protocol_interface.md §2` `LlmProtocol` interface += `readonly label: string`（人类可读展示名，UI 下拉用，与 `ProtocolName` id 正交）；`anthropic_impl.md §2` 标准值表加 `label = "Anthropic Messages 风格"`。
- **factory 动态取 impl**：`llm-client-factory.ts:68-74` 硬编码 `anthropic_messages` 改为按 `providerConfig.protocolId` 查 `pluginManager.getExtensionImpls(LlmProtocolPoint)` 命中 implId；`client.ts` `protocol` 来源从 modelConfig 切换到 providerConfig（impl 引用不变）。
- **数据迁移（S4，启动一次性幂等）**：server boot 钩子 `migrateProvidersProtocolId(svc)` 扫 providers 组——顶层无 `protocolId` 则从 `models[0].protocolId` 抄（models[] 为空默认 `anthropic_messages`）；旧 `models[].protocolId` 物理删除。位置：`bootstrap.ts:228`（路由挂载前）。**code-review Critical 修复引入两个加固**：(a) **name 守卫**——只处理 `p.name === 'anthropic_compatible'`（protocolId 仅对真实 anthropic provider 有语义，providers 组可能混入 mock fixture，跳过 = 语义正确）；(b) **逐条 try/catch**——单条失败（非 ULID id 的 test fixture / schema 脏数据）跳过不阻塞 bootstrap（迁移是 best-effort，真实 record 必过校验）。详见 `specs/tech/version_logs/v0.0.53/change_log.md §3`。
- **API 契约**：`specs/api/overall/02-llm-chat.md §5`——`ProviderInstance` += `protocolId`；`ProviderCreateBody` += `protocolId`（必填）；`ProviderUpdateBody` += `protocolId?`；`ModelInstance` / `ModelCreateBody` / `ModelUpdateBody` −= `protocolId`（POST model 含 protocolId 字段：忽略，201）。`GET /provider` 响应扩为 `{ items, protocols: [{ id, label, path }] }`（handler 实例化 protocol impl 读 readonly 字段一次性返回，前端零知识拼接）。
- **UI**：`specs/ui/components/providers/_overview.md`——`component-provider-fields` 字段表加 `protocol`（select，testid `provider-field-protocol`）+ 拼接地址 mono 展示区（`baseUrl + protocol.path` 实时变化）；`component-model-edit-modal` 字段表删 protocolId。

详情：`specs/tech/version_logs/v0.0.53/change_log.md`

## 2026-07-02 · v0.0.50（logical-view 公共层抽离 + protocol encode 入参澄清）

- 新增 `[P0]llm_logical_view.md`：业务 `Message[]` → LLM 视图 `Message[]` 公共 encoder（protocol 无关），把 `agent/message-prefix-renderer.ts` 内容迁入 `app/server/src/llm/logical-view.ts`。导出 `toLogicalMessages` / `renderMessageContentWithPrefix` / `renderSenderPrefix` 三纯函数 + 6 类 source 前缀表 + 注入策略（首块 TextBlock 拼前缀 / 非 text prepend / 无 sender 空串）+ 3 调用点（stage-llm / call-main / call-forked，调 protocol.encode 前先 `toLogicalMessages`）。
- `[P0]llm_protocol_interface.md` 新增 §3.5.1：`encode(request)` 入参假定已 logical 展平（sender 已被上游展平入首块 TextBlock 前缀）；encode 不再读 `Message.sender`（既有 anthropic_messages 实现本来就没读，文档层澄清）。
- 与 observability 子系统联动：logical generation input.messages 天然是 LLM 视角（sender 已展平），与 physical generation（wire body）成对，便于对账。
- 旧 `agent/message-prefix-renderer.ts` 删除（内容迁本层）；UT 迁 `llm/__tests__/logical-view.test.ts`。
- **不变量**：anthropic wire body byte-level 不变（除 cache_control 时序无关外）。

详情：`specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md`
## 2026-07-02 · v0.0.52（reminder 缓存优化 — 显式 cache_control breakpoint 路线落地）

- **新增** `[P0]cache_control.md`：protocol encode 层的 prompt caching 目标契约。确立**显式 cache_control breakpoint** 路线（非隐式 prefix-only）——
  - §2 缓存机制两场景互斥：reducer 过滤历史 reminder 是错误方案（破坏 implicit prefix）；正确做法是显式 breakpoint 路线下 wire 层过滤。
  - §3 三步处理机制：bp#1（system 末 block）+ bp#2（**最后一个非 reminder block**，跨所有 messages 反向扫）+ 过滤历史 reminder（drop 非最末 user message 的 reminder，保留最末 user message 的最末 reminder）。
  - §4 anthropic encode 专属：cache_control 逻辑在 `encodeAnthropicMessages` 内，**不抽公共 `supportsCacheControl` 能力位**（不同 protocol cache 机制不通用）；其他 protocol 各自 encode 决定（不实现则自然全传 reminder，fallback）。
  - §5 与 context 层关系：reminder 持久化归 context 层，breakpoint 归 protocol 层，两层独立（transcript 完整 + wire 精简同时成立）。
- **代码对齐**（`app/server/src/llm/protocol-encode.ts`）：§3 三步全落地——bp#1（system 末 block）+ bp#2（`injectLastNonReminderCacheControl` 反向扫非 reminder block）+ reminder wire 过滤（`encodeMessage(m, isLastUserMessage)`）。§6 由「现状偏差」转「代码对齐状态」逐条核对表（v0.0.52 前两项偏差已修复）。`isSystemReminder` 不进 wire（`encodeContentBlock` text 只取 `b.text`）。
- `anthropic_impl.md §4` 同步：bp#2 落点改「跨 messages 反向扫非 reminder block」+ 加 reminder wire 过滤段 + JSON 示例修正（bp 落用户正文非末块 reminder）+ frontmatter `related` 加 `[P0]cache_control.md`。
- `index.md` §① 概念表加 cache_control 行；§⑤ 导航加「protocol 层策略」分类（architect 阶段已落）；frontmatter `updated` → 2026-07-02。
- `protocol-types.ts` text variant 加 `isSystemReminder?: boolean`（镜像 `message/types.ts` TextBlock 块级标记，供 encode 识别；写 wire 时丢弃，零侵入）。

详情：`specs/tech/version_logs/v0.0.52.context_engine_fix/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起，84 行）+ 本 `log.md`。
- 5 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 inline `[vX.Y]` / `[vX.Y modified]` 噪声 + 尾部 `## 版本` 段，迁移到 frontmatter `since` 或本 log。
- `anthropic_impl.md` 顶部 `> [v0.0.13 S3]` 散文标签 → 去版本号改现状描述；`## 版本` 段移除。

## 2026-06-15 · v0.0.25（4 件套 + credentials 多 key + 物理层钩子 + BUG-001/002/004/005 收口）

- `[P0]llm_provider_interface.md` §3.3：`credentials` 扩多 key union（`{key} | {keys[]}`，向后兼容单 key）；`CredentialKey` 含 keyRef/keyValue/quotaScope/weight；`buildAuthHeaders` 加可选 keyRef 参数。
- `[P0]llm_client_interface.md` §3.8：onWire 物理层钩子（prepare 后 fetch 前，记 wire body 供 langfuse physical_wire_body diff 对账，BUG-001）；§3.9 非 2xx 抛 `LlmHttpError`（携 numeric status，BUG-004 Critical：复活 classifier asWireResponse 命中）；§3.9 BUG-005 收口（validate 越界抛 LlmHttpError{400} → classifier MAX_TOKENS_TOO_HIGH / BAD_REQUEST_OTHER，不再裸 Error→NETWORK 白重试）。
- `[P0]llm_protocol_interface.md`：补「外层 message role 转换规则」（`role:"tool" → "user"`，BUG-002 encode 层）+ 「连续同 role 合并规则」（相邻 user/assistant content 数组拼接，保证严格交替）；落点必须在 encode 层覆盖 eager+forked。
- `[P0]llm_model_interface.md` §3.5：新增 `ModelCapability` 能力位（capabilities: `{maxOutputTokens, supportsPrefill, supportsThinking}`）；顶层 maxOutputTokens 保留为 alias 向后兼容。

详情：`specs/tech/version_logs/v0.0.25/change_log.md`

## 2026-06-12 · v0.0.13（stream cost 闭环 + minimax + usage 映射）

- `[P0]llm_client_interface.md` §3.7：stream 路径 cost/currency 闭环（parseStream 产 usage 事件只带 token，client yield 前补 computeCost + pricing.currency）。
- `[P0]llm_protocol_interface.md`：明确 parseStream usage 事件只填 token 字段，cost/currency 归 client、char 归 agent loop；minimax 走同 anthropic_messages impl。
- `anthropic_impl.md`：同时服务 Anthropic 原生 + minimax（同 path/encode）；§5.1 parseAnthropicUsage 校准点（minimax 三字段语义差异）；§6 补 usage 映射（Anthropic 原生格式 + 逐字段计算 + output_reasoning=0 限制）。

详情：`specs/tech/version_logs/v0.0.13/change_log.md`

## 2026-06-09 · v0.0.33.2（SquadChat EOS stop_sequences）

- `anthropic_impl.md` §4a：`RequestParams.stop → stop_sequences` 映射，SquadChat EOS stop 仅在 anthropic_messages impl 显式落地（其他 provider 不作已实现假设）。

详情：`specs/tech/version_logs/v0.0.33.2/change_log.md`

## 2026-05-XX · v0.0.3（4 件套确立 + Anthropic 首实现）

- 4 件套组合层确立：provider（凭证+接入点）/ protocol（path+body+编码）/ model（属性+取值）/ client（组合+I/O+编排）；边界归属规则见 docs_guide §4。
- `[P0]llm_provider_interface.md`：凭证归一单 key + 按鉴权协议族分 type（anthropic_compatible / openai_compatible / glm）。
- `[P0]llm_protocol_interface.md`：标准值自承载为 protocol impl 代码常量；thinking_delta 与 text_delta 平行独立变体。
- `anthropic_impl.md`：cache control 2 breakpoint 策略（prompt caching）。

详情：`specs/tech/version_logs/v0.0.3/change_log.md`

## 2026-07-15 · v0.0.148（RequestParams.effort + anthropic output_config.effort 注入）

- `[P0]llm_protocol_interface.md` §3.5：`RequestParams` 加 canonical 字段 `effort?: 'default'|'low'|'high'|'max'`（**统一语义键，非 wire 字面值**）。默认档 `default` = 不传 wire 字段（模型厂商默认行为），**不是**传 `"default"` 字面值。
- `anthropic_impl.md`：encodeAnthropicMessages 读 `params.effort`，非 default 档注入 wire `output_config.effort`（low→low / high→high / max→max）；default/undefined 档不加 output_config。映射在 encode 内部硬编码（对齐既有字段名映射风格如 stop→stop_sequences）。
- 透传链：session.effort → buildSessionConfigFromDeps → config.effort → callLLMForSpec → CallLLMInput.effort → callLLMViaInvoker baseReq.params.effort → encode（main+forked 共享，callLLMForSpec 是唯一活跃 stage）。
- openai 映射（reasoning.effort: minimal/high/xhigh）**写 spec 不实现**（无 openai provider/protocol impl）。当前 dev/test 模型 glm-5.2/MiniMax 非 Claude/OpenAI，effort 实际支持未验证——AT 验透传契约（wire body 含 output_config.effort）不依赖模型行为变化。

详情：`specs/tech/version_logs/v0.0.148/change_plan.md`（链路 A）
