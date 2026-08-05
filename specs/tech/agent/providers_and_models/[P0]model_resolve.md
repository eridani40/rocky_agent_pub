---
type: spec
title: Model Resolve 抽象（resolveModel + ModelNotConfiguredError）
priority: P0
status: active
updated: 2026-07-31
since: v0.0.89
related:
  - "[P0]llm_provider_interface.md"
  - "[P0]llm_model_interface.md"
  - "../../session/[P0]session_store.md"
  - "../../squad/[P1]data_model.md"
  - "../../../config/[P0]app_config.md"
---

# Model Resolve 抽象（resolveModel + ModelNotConfiguredError）

> 定位：model resolve 的**统一抽象入口**——把「以哪个 modelId 调用 LLM」的决策从分散在 4 处 handler（session-config/session-compact/session-messages/session-run）的 if/else 链抽到一个无副作用纯函数。
> 引入版本 v0.0.89；v0.0.155 重构 ModelRef 复合 + resolve 链去 member.model + `resolveDefaultModel` 单点出口；**v0.0.158 收敛为 chat 单链**（删「独立 summary 模型」层，chat/compact 同链）；**v0.0.216 加 academy 三档链**；**v0.0.230 收窄 academy 去 app 默认兜底**（session → classroom.defaultModel → throw，无应用层默认概念）。
> 代码实现：`app/server/src/services/model-resolver.ts`（resolveModel + ModelNotConfiguredError + resolveDefaultModel + findProviderForModel）。

## 1. 概述

**管什么**：定义 `resolveModel(input) → { providerId, modelId } | throw ModelNotConfiguredError`——按 §3 fallback 链分支，输入 session/squad 上下文（v0.0.155 去 member），输出**确定的复合 ModelRef**（或抛错）。
**不管什么**：LlmClient 4 件套绑定（→ `[P0]llm_client_interface.md`）、provider/model 数据 schema（→ `[P0]llm_provider_interface.md` / `[P0]llm_model_interface.md`）、handler 调用时机（→ 各 handler spec）、member 实体（v0.0.155 退管理概念，不持运行配置）。

### 1.1 解决的问题（不这样写会怎样）

**v0.0.88 之前**：分散在 4 处 handler 的 resolve 链——每处独立实现「查 session.modelId → 查 default_models → 查首个 enabled provider」的 if/else，**playground/studio chat/summary 4 链各写一遍**——重复且易漂移；session.modelId 缺失与显式选择「具体 modelId」语义混淆；「未配置模型」错误散落各处返 500 或静默 fallback。

**v0.0.89 集中到 resolveModel 单点出口**：fallback 链一处定义；保留字 `default`/`""`/`undefined` 统一视为「继续 fallback」；fallback 链跑空才抛 `ModelNotConfiguredError`（handler catch 返 400 错误体）。

**v0.0.155 进一步重构**（消除 v0.0.154 暴露的 member.model 表层刷漆问题）：
- **ModelRef 复合**（`{providerId?, modelId}`）：解决「同名 modelId 跨 provider 歧义」（v0.0.9 砍 providerId 后留下的坑——`findProviderForModel` 只能跨 provider 找首个命中）；新数据 session/squad 携带 providerId 作 hint，resolver 精确匹配该 provider。
- **resolve 链去 member.model**（INV-A1/A4）：member 退管理概念（name/role/intro/workStyle/tools/skillConfig），运行配置（model/effort/approval）全跟 session；picker 写 session 不写 member（INV-D1）。
- **`resolveDefaultModel` 单点出口**（INV-A5）：消除原 buildFallbackChain 内散乱的 playground/studio default 分支，default 来源单点定义 + 可单测。

**v0.0.158 删「独立 summary 模型」层**（用户裁决）：
- **背景 bug**：prod session `01KXJZCFVST8SQVD4SKGWVDP0E`（studio squad）点手动 compact → 400 `MODEL_NOT_CONFIGURED { studio, summary }`，squad 已配 `modelDefault` 却因 `summaryModelDefault` 空 + INV-A5 studio 禁 app_config fallback → 链跑空。深层：三个压缩入口（手动/自动/T1）三种姿势、只有手动 compact 走 summary 链导致「承诺一致性」被打破。
- **删除**：`task: 'chat' | 'summary'` 参数、summary 链、`squad.summaryModelDefault*` 字段、`default_models.summary` 字段、chat body 里 `providerId/modelId` 一次性 override（前端不传 + 后端静默忽略）。
- **收敛**：chat / 手动 compact / 自动 compact / T1 记忆整理**全部走 `agentManager.resolveConfigBySid(sid)` 唯一入口**（bootstrap `setSideRunner` / `setConsolidationRunner` 闭包内首行 resolve）。
- **一层策略按 session 类型分发**：playground → `default_models.chat`；studio → `squad.modelDefault`（chat/compact 同链）。
- **不动**：T2 天级整理（`consolidation.modelId` 独立）、see_image / web_search（各自 provider 硬编码）、subagent 出生模型（`templateRef.modelId` 或 inherit 父，出生写死 session 之后走 resolveConfigBySid 命中 session）。

**v0.0.216 加 academy 三档链**：新增 `sessionType: 'academy'` + `classroom?` 输入——academy session 走 `session → classroom.defaultModel → app_config.default_models.chat`（app 默认作第三档兜底）。

**v0.0.230 收窄 academy 去 app 默认兜底**（用户确认「app 默认在哪里？没这个东西，只能报错啊」）：academy 链收窄为 `session → classroom.defaultModel → throw ModelNotConfiguredError`——app 默认是 playground 个体级逻辑，误用为群体级（academy/studio）默认档是错的；academy 对齐 studio 两档链（studio 本就不读 app_config，INV-A5）。教室未配 defaultModel → 链跑空 → 400 `MODEL_NOT_CONFIGURED`（academy 文案引导去教室 head 配置）。

## 2. 接口签名

```typescript
/** resolveModel 入参（v0.0.155：去 member；v0.0.158：删 task + bodyOverride*；ModelRef 复合 + providerIdHint） */
interface ResolveModelInput {
  /** AppConfigService（读 default_models group，仅 playground 分支用） */
  appConfigService: AppConfigService;
  /** session 类型：playground 走 app_config.default_models.chat；studio 仅读 squad.modelDefault；academy 走 session → classroom.defaultModel（v0.0.230 收窄去 app 默认，无应用层默认概念） */
  sessionType: 'playground' | 'studio' | 'academy';
  /** studio 必填（仅日志/detail 用；v0.0.155 后 leader/mate/squad 同链，不区分） */
  role?: 'squad' | 'leader' | 'mate';
  /** session.modelId（可能为 'default'/'none'/undefined/具体 modelId） */
  sessionModelId?: string;
  /** session 持久 providerId（v0.0.155：作 sessionModelId 的精确 hint，INV-B1 复合） */
  sessionProviderId?: string;
  /** studio: squad 配置（modelDefault 必填，v0.0.158 删 summaryModelDefault*） */
  squad?: {
    modelDefault?: string;
    /** v0.0.155 复合 ModelRef 的配对 providerId（optional back-compat） */
    modelDefaultProviderId?: string;
  } | null;
  /** academy: 教室配置（defaultModel = 教室级默认档；复合 ModelRef，providerId 作精确 hint）。缺省 → academy 链退化为 session → throw（v0.0.230 起不再下探 app 默认） */
  classroom?: {
    defaultModel?: { providerId?: string; modelId: string };
  } | null;
}

/** resolveModel 输出：ModelRef 复合（hint 命中则 = 输入 hint；hint 空 = 跨 provider 反查命中的首个） */
interface ResolvedModel {
  /** 命中的 provider 实例 id（= app_config providers 组 record 的 data.id） */
  providerId: string;
  /** 命中的 modelId（= 该 provider 的 models[] 一条的 modelId） */
  modelId: string;
}

/** fallback 链跑空时抛（v0.0.158：detail 删 task 字段；v0.0.230：detail 扩 academy + message 按 sessionType 引导） */
class ModelNotConfiguredError extends Error {
  readonly code = 'MODEL_NOT_CONFIGURED' as const;
  readonly detail: { sessionType: 'playground' | 'studio' | 'academy' };
  constructor(
    sessionType: 'playground' | 'studio' | 'academy',
    message?: string,
  ) {
    super(message ?? '请配置模型后再发起会话');
    this.detail = { sessionType };
  }
}

/** 主入口 */
function resolveModel(input: ResolveModelInput): ResolvedModel;
```

## 3. fallback 链（v0.0.158：chat 单链 4→2 行；chat/compact 同链）

> 原 v0.0.89 6 行表含 `member.model` + summary 独立子链；v0.0.155 删 member.model；v0.0.158 进一步删 summary 子链（chat/compact 同链）。

| # | sessionType | fallback 顺序（每步未命中→继续） |
|---|---|---|
| 1 | playground | `session.{modelId, providerId?}` → `resolveDefaultModel()`（= `default_models.chat`） → throw |
| 2 | studio（squad / leader / mate 同链） | `session.{modelId, providerId?}` → `resolveDefaultModel()`（= `squad.modelDefault`） → throw |
| 3 | academy（head / coach / student 同链） | `session.{modelId, providerId?}` → `classroom.defaultModel`（复合 `{providerId?, modelId}`，providerId 作精确 hint） → throw |

> **v0.0.230 收窄**：academy 原第三档 `app_config.default_models.chat`（v0.0.216 加）已删——app 默认是 playground 个体级概念，不得作群体级（academy/studio）兜底。academy 与 studio 同口径「必须配具体默认模型，未配 → 明确报错引导」。创建链 `resolveAcademySessionModel`（`academy-session-model.ts` 薄委托本 resolver）与运行时链（`resolveConfigBySid`）共用同一链，语义等价。

**候选为复合 `{modelId, providerIdHint?}`**：session/squad 字段都同时携带 modelId 与 providerId（如已持久化），透传给 `findProviderForModel(svc, modelId, hint?)` 作精确匹配（INV-B1/B2）。

> **v0.0.158 变更**：
> - **删 body override 分支**：chat body 里的 `providerId/modelId` 一次性覆盖已整删（前端不传，后端 handler 静默忽略；配置改动的生效点 = 用户改设置那一刻，写 `session.modelId` / `squad.modelDefault`，之后 resolve 读 session/squad）。
> - **删 summary 子链**：无 `task` 参数；chat/compact/T1 记忆整理都走同一条链。summary 模型作为「独立层概念」退役。

### 3.1 resolveDefaultModel 单点出口（v0.0.155 新增，INV-A5；v0.0.158 简化）

`buildFallbackChain` 所有 default 步都经 `resolveDefaultModel(input)` 决定来源（不再 inline `readPlaygroundDefault` / `squad?.modelDefault`）：

```typescript
function resolveDefaultModel(input): ModelCandidate | undefined {
  if (input.sessionType === 'playground')
    return readPlaygroundDefault(appConfigService); // = app_config.default_models.chat
  // studio：只读 squad.modelDefault；不读 app_config（INV-A5）
  return input.squad?.modelDefault
    ? { modelId: input.squad.modelDefault, providerIdHint: input.squad.modelDefaultProviderId }
    : undefined;
}
```

**约束**：playground MUST NOT 读 squad；studio MUST NOT 读 app_config；studio MUST NOT 加 app_config fallback（`squad.modelDefault` 必填保持，未设 → 链跑空 → throw，语义与 v0.0.89 起一致）。

> academy 分支不经 `resolveDefaultModel`（该函数是 playground/studio 二分发）——academy 的 default 档（`classroom.defaultModel`）由 `buildFallbackChain` 内联 push（v0.0.216 起）；v0.0.230 删其后的 app 默认档。

### 3.2 「未命中」判定

每个 fallback 步骤的取值经 `isReservedModelId(value)` 判定——**保留字视为「未命中」继续 fallback**：

| 输入值 | 视为 | 理由 |
|---|---|---|
| 具体模型（如 `"gpt-4o"`、`"01KVC9A2...:gpt-4o"`） | 命中 | 走 `findProviderForModel` 精确/跨 provider 反查 |
| `"default"` | 继续 fallback | 保留字=未手动选/跟随默认（v0.0.89 决策） |
| `"none"` | 继续 fallback | 等价 `"default"`（规范化为 `"default"` 落盘） |
| `""`（空串） | 继续 fallback | 历史 member inherit 语义（v0.0.155 member.model 删后此值不再出现在运行链，但 session/squad 可能 lazy 空） |
| `undefined` / 字段缺失 | 继续 fallback | 未配置 |

> 单一权威：`isReservedModelId(value)` + `normalizeReservedModelId(value)` 落在 `services/model-validation.ts`（v0.0.89 抽取，4+ 处 handler 复用）。

### 3.3 「具体 modelId 不命中」判定 — findProviderForModel 双路（INV-B2）

具体 modelId 经 `findProviderForModel(svc, modelId, providerIdHint?)`。**候选集 = `listEnabledProviders(svc)`**（已过滤 `_deleted` 墓碑 + `enabled === false` 的 disabled provider）——disabled provider 对 resolve **不可见**，不在候选集内：

- **hint 非空**（复合 ModelRef 已持久 providerId）：在 enabled 集合中精确匹配该 provider——`enabledProviders.find(p => p.id === hint)`，再在该 provider 的 models 里查 `modelId === value && model.enabled !== false`。**hint 指向 disabled provider → 不在 enabled 集合 → find 不到 → 返 null**（不短路、不兜底，视为该步未命中继续 fallback）。同理 provider 不含该 modelId / model disabled → 返 null。
- **hint 空**（旧 session/squad 无 providerId）：在 enabled 集合中跨 provider 反查首个命中（back-compat：救存量无 providerId 的数据）。
- 命中 → 返回 `{providerId, modelId}`；不命中 → **视为该步未命中继续 fallback**（不立即抛错；fallback 链跑空才抛）。

> 即「hint 精确匹配」是在 **enabled 集合内**做，不是在全量 provider 上做——disabled provider 永远不会成为命中候选（无论 hint 是否指向它）。设计意图：停用 = 对 resolve 链彻底消失，避免「default/selection 指向已停用 provider 还能命中」造成 LLM 调用配置错配。

> v0.0.155 前 cross-provider 反查是唯一路径（v0.0.33.2 BUG-3 修后稳定路径）；复合化后新数据精确命中，旧数据继续走反查兜底，无需 migration（INV-B3）。

## 4. 核心设计原则

1. **保留字=继续 fallback**——`"default"`/`"none"`/`""`/`undefined` 全走 fallback，不抛错不短路；fallback 链跑空才抛。
2. **default 来源单点出口 `resolveDefaultModel`（v0.0.155 INV-A5）**——`buildFallbackChain` 所有 default 步经此函数，按 sessionType 分发：playground → `app_config.default_models.chat`；studio → `squad.modelDefault`。**MUST NOT 跨来源**（playground 读 squad / studio 读 app_config）；**MUST NOT 给 studio 加 app_config fallback**（`squad.modelDefault` 必填保持，未设 → throw，与 v0.0.89 起语义一致）。
3. **ModelRef = `{providerId?, modelId}` 复合（v0.0.155 INV-B1）**——两持久化字段（`session.{modelId, providerId?}` / `squad.{modelDefault, modelDefaultProviderId?}`）统一复合结构；`providerId` optional back-compat（旧数据无 providerId → resolver hint 空 → 跨 provider 反查兜底，无需 migration，INV-B3）。
4. **resolve 精确（v0.0.155 INV-B2）**——providerIdHint 已知 → `findProviderForModel` 精确匹配该 provider（消除同名 model 歧义）；hint 空 → 跨 provider 反查（救存量）；两条路径都走同一函数单点出口。**候选集恒为 `listEnabledProviders`**（已过滤 disabled provider）——hint 指向 disabled provider 同样不命中（详见 §3.3），停用 provider 对 resolve 链彻底消失。
5. **session 是 model 唯一运行配置读源（v0.0.155 INV-A2）**——与 effort/approvalMode 同款，运行配置跟 session（`buildSessionConfigFromDeps` 读 sessionPersist 四字段）；resolver 只接 session+squad 上下文，**member 不再参与 resolve 链**（member.model 硬删，INV-A1/A4，member 退管理概念：name/role/intro/workStyle/tools/skillConfig）。
6. **chat/compact 同链（v0.0.158 收敛，覆盖旧"summary 链独立于 chat 链"原则）**——删除「独立 summary 模型」层：所有 session 场景（chat / 手动 compact / 自动 compact / T1 记忆整理）**全部走同一条 chat 链** + 同一入口 `agentManager.resolveConfigBySid(sid)`。理由（用户裁决）：(1) resolve 分叉带来的"承诺一致性"更容易断（历史 bug：自动 compact 根本没读 summary 字段、只有手动读了）；(2) "复用主 agent config 提高上下文利用"这一原设计动机在跨模型时不成立（KV cache 需同 provider + model + 前缀）；(3) 一层策略更简单，将来要独立压缩模型再加回。
7. **错误体 schema 三字段（v0.0.158 detail 简化；v0.0.230 detail 扩 academy + 文案引导）**——`{ code: "MODEL_NOT_CONFIGURED", message, detail: { sessionType } }`（HTTP 400）。handler catch 后统一返此结构。**v0.0.158 删 `detail.task` 字段**（chat/compact 同链后 task 概念不存在）；**v0.0.230 `message` 按 sessionType 分支**（academy 引导去教室 head 配置，见 §6）。
8. **群体级默认必须具体模型、无应用层默认（v0.0.230）**——studio（`squad.modelDefault`）与 academy（`classroom.defaultModel`）都是群体级默认，MUST 配具体 modelId，**MUST NOT 下探 `app_config.default_models.chat`**（app 默认是 playground 个体级逻辑，误用为群体级兜底 = 错误语义）；academy 未配 → 链跑空 → 400 `MODEL_NOT_CONFIGURED`（文案引导去教室 head 配置）。

## 5. 5 处 handler 调用点（v0.0.158 收敛：手动/自动 compact / T1 都走唯一入口）

| handler / 文件 | 调用方式 | 错误体 catch 位置 |
|---|---|---|
| `handlers/session-config.ts:buildSessionConfigFromDeps` | 主实现——resolveModel 单点出口（供 activate 内 `resolveConfigBySid` 调） | session-config 内 throw → deliverTo 上抛 → handler catch 400 |
| `handlers/session-compact.ts:handleSessionCompact` | **v0.0.158 收敛**：直调 `agentManager.resolveConfigBySid(sid)`（唯一入口，chat/compact 同链）—— 不再自建 `buildSessionConfigFromDeps` 调用 | handleSessionCompact 内 catch 400 `{code:"MODEL_NOT_CONFIGURED", message, detail:{sessionType}}` |
| `handlers/session-messages.ts:handleSessionMessages` | 走 `deliverTo` → activate → `resolveConfigBySid` → 内部 buildSessionConfigFromDeps → resolveModel | handler catch 400 + toast link；activate 内 catch 落 makeErrorRun → resolveErrorRunResult 识别返 400 |
| `handlers/session-run.ts:handleSessionRun` | 同上（走 activate 路径） | handler catch 400 |
| `handlers/session.ts:POST/PUT` | 不调 resolve（仅校验 modelId 保留字 `default`/`none`/具体 + 落盘） | 不抛 ModelNotConfigured（落盘不等于要跑 LLM） |
| `handlers/member.ts:Create/Hire/Patch` | v0.0.155 起不调 resolve（member.model 已硬删；body.model 旧 client 传 → warn+ignore 非 400） | — |
| `bootstrap.ts:setSideRunner` / `setConsolidationRunner` 闭包 | **v0.0.158 新增**：runner 闭包首行 `await agentManager.resolveConfigBySid(input.sessionId)` 自 resolve（compact runner + T1 consolidation runner 都从此拿 config；不消费 caller 传入的 config） | runner 内异常统一由 SessionTaskLock markFailed + 上抛 |

- **academy session 同链**：head/coach/student session 走同一 `resolveConfigBySid → buildSessionConfigFromDeps → resolveModel({sessionType:'academy', classroom})` 链（v0.0.216 起），错误体 `detail.sessionType='academy'`；创建链（建教室 head / 建学生播种 / 建任务 coach）经 `academy-session-model.ts:resolveAcademySessionModel` 薄委托同 resolver——v0.0.230 收窄后创建链与运行时链同语义（教室未配 defaultModel → 创建即 400 / 运行即报错引导）。

### 5.1 调用关系（v0.0.158：resolveConfigBySid 唯一入口收敛所有 forked run）

```
POST /session/:id/messages ─→ handleSessionMessages
                                ↓ body.providerId/modelId 静默忽略（v0.0.158 兼容层：不解析/不 400/不落 session）
                                ↓ deliverTo(sessionId)
                                   ↓ activate → resolveConfigBySid → buildSessionConfigFromDeps
                                      ↓ resolveModel({ sessionType, session, squad })
                                         ↓ 返回 {providerId, modelId} 或 throw ModelNotConfiguredError

POST /session/:id/compact  ─→ handleSessionCompact
                                ↓ v0.0.158：唯一入口
                                ↓ config = await deps.agentManager.resolveConfigBySid(id)
                                ↓ fire-and-forget: void deps.contextEngine.compact(config).catch(log)

自动 compact（runReActLoop tryCompact）─→ setSideRunner 闭包
                                ↓ v0.0.158：唯一入口
                                ↓ const config = await agentManager.resolveConfigBySid(input.sessionId)
                                ↓ 不消费 caller 传入的 config

T1 记忆整理（post-compact consolidation）─→ setConsolidationRunner 闭包
                                ↓ v0.0.158：同上，唯一入口
                                ↓ const config = await agentManager.resolveConfigBySid(input.sessionId)
```

- **handler 不双 resolve**：handler 层仅做请求体校验 + 落盘；真正 resolve 在 deliverTo → activate → resolveConfigBySid（避免双 resolve 漂移 + 减少重复 listEnabledProviders 调用）。
- **`buildSessionConfigFromDeps` 签名瘦身（v0.0.158）**：删 `task?: 'chat' | 'summary'` 参数 + 删 `bodyOverride: ProviderModelOverride | undefined` 参数（body override 整删）。签名 = `buildSessionConfigFromDeps(deps, sessionId, sessionPersist, kind, workspaceDir, scope, subAgentConfig, studioContext)`。
- **runner input 签名收敛（v0.0.158）**：`CompactSideRunner`（v0.0.204 rename 自 `CompactForkedRunner`） + `ConsolidationRunner` 的 input 删 `config: SessionConfig` 字段——runner 内部自 resolve（唯一入口在此落地）。`CompactCtx.config` 保留（consolidation handler 从 `ctx.config.sessionId` 派生 sid + fork-2 内部 resolve）。

## 6. 错误体 schema（HTTP 400，v0.0.158 detail 简化）

```json
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "code": "MODEL_NOT_CONFIGURED",
  "message": "请配置模型后再发起会话",
  "detail": {
    "sessionType": "playground"
  }
}
```

- `code` 字段闭合：`"MODEL_NOT_CONFIGURED"`（新增枚举值，不与 v0.0.25 18 个 LlmErrorCategory 混——后者属 LLM 调用错误分类，本处属前置配置缺失）。
- `detail.sessionType`：`"playground"` / `"studio"` / `"academy"`（取自 `session.biz`）。
- **v0.0.230 academy 引导文案**：`message` 按 sessionType 分支——academy → 「教室未配置默认模型，请先在教室设置中选择一个具体模型」（引导去教室 head 配置）；playground/studio 保持默认「请配置模型后再发起会话」。
- **v0.0.158 删 `detail.task`**：chat/compact 同链后无 task 概念。旧 client 若已适配读 `detail.task` 需同步调整（前端本项目已在 v0.0.158 前端 task 同步收敛）。

## 7. 与 session.modelId 保留字 `default` 的关系

- **session.modelId 落盘**：`POST /session` 默认写 `"default"`（替代旧 `undefined`）；`PUT /session/:id` body.modelId 接受 `"default"`/`"none"`/具体 ModelRef（`"none"` 规范化为 `"default"` 落盘）。
- **resolveModel 读**：见 §3.2 保留字表——`"default"` 视为「继续 fallback」，不短路；与 `"none"`/`""`/`undefined` 同走链。
- **不动 schema**：`Session.modelId` 类型仍 `string?`（optional），仅注释更新（保留字 `default`=未手动选/跟随默认；POST 默认 `"default"`；resolve 视为 undefined 继续走 fallback）。详见 `../../session/[P0]session_store.md §2`。

## 8. 边界

| 零件 | 归属 |
|---|---|
| `resolveModel` + `ModelNotConfiguredError` + fallback 链（v0.0.158 chat 单链 2 行）+ `resolveDefaultModel` 单点出口 + 复合 ModelRef 契约 | 本文 ✅ |
| 保留字判定 `isReservedModelId` / `normalizeReservedModelId`（单一权威 helper） | `services/model-validation.ts`（与 `validateModelId` 同文件，4+ handler 复用） |
| `findProviderForModel` 双路（hint 精确 / 空 fallback 跨 provider） | 本文 §3.3（代码：`services/model-resolver.ts:findProviderForModel`） |
| `listEnabledProviders` | `services/model-resolver.ts`（自包含，与 `model-validation.ts` 同口径） |
| provider/model 数据 schema + 跨 provider 反查命中判定 | `[P0]llm_provider_interface.md` / `[P0]llm_model_interface.md` |
| 5+ 处 handler / bootstrap runner 调用点 + 错误体 catch | 各 handler spec（`specs/api/overall/02-llm-chat.md` + `04-agent-session.md`） |
| session.modelId + session.providerId 复合字段 | `../../session/[P0]session_store.md §2` |
| squad.modelDefault + squad.modelDefaultProviderId 复合字段 schema（v0.0.158 删 `summaryModelDefault*`） | `../../squad/[P1]data_model.md §1.1` |
| default_models group（playground 专属，v0.0.158 只留 `chat` key，删 `summary` key） | `../../../config/[P0]app_config.md §3.7`（v0.0.89 新增） |
| 唯一入口 `agentManager.resolveConfigBySid(sid)`（v0.0.158 chat/compact/T1 都走它） | `../agent_interface_and_loop/[P0]agent_manager.md §2.4` + `bootstrap.ts setSideRunner/setConsolidationRunner` |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
