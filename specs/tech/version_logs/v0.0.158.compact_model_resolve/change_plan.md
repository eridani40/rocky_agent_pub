# v0.0.158 变更计划书 — compact 模型 resolve 架构简化（删「独立 summary 模型」层）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 版本主题（一句话）

删除「独立 summary 模型」这一层概念。所有 session 场景（chat / 手动 compact / 自动 compact / T1 记忆整理）统一走 **`agentManager.resolveConfig(sid)` 唯一入口**，无 `task`、无 `bodyOverride` 参数；按 session 类型分发链（playground → app_config.chat；studio → squad.modelDefault）。保留 T2 天级整理 / see_image / web_search / subagent 出生模型不动。

## Invariant 变更（v0.0.155 → v0.0.158）

| 编号 | v0.0.155 现状（`services/model-resolver.ts` 头注释权威） | v0.0.158 新态 |
|---|---|---|
| **INV-A1** | 链中任何分支不再读 `member.model`（member.model 已硬删）| **保留不变** |
| **INV-A2** | session 是 model 唯一运行配置读源 | **保留不变** |
| **INV-A5** | studio 只读 squad；MUST NOT 读 app_config；MUST NOT 加 app_config fallback | **收窄+简化**：studio 只读 `squad.modelDefault`（不再读 `squad.summaryModelDefault`——该字段整删）；仍 MUST NOT 读 app_config；chat/compact **同链**（不再区分 summary 子链） |
| **INV-B1/B2** | ModelRef 复合 + providerIdHint 精确；hint 空跨 provider 反查 | **保留不变**（仅对 chat 链应用；summary 分支整删） |
| **task 参数（`resolveModel` / `buildSessionConfigFromDeps` / `ResolveModelInput`）** | `task: 'chat' \| 'summary'` 三处签名参数 | **删除**（三处签名去 task；resolveModel 只走 chat 链） |
| **body override（`POST /session/:id/messages`）** | body 支持 `providerId/modelId` 一次性覆盖当次 turn + 落 session 持久 | **删除**：前端不再传，后端 handler 收到也忽略（不解析、不落 session）。改配置生效点 = 用户改设置那一刻（写 session.modelId / squad.modelDefault），下次发消息走 server 记录 |
| **唯一入口（AgentManager.resolveConfigBySid）** | chat 走它；手动 compact 直调 buildSessionConfigFromDeps 独立支路；自动 compact / T1 复用主 loop `spec.config` | **收敛**：手动 / 自动 / T1 **全部**走 `agentManager.resolveConfigBySid(sid)`——bootstrap `setForkedRunner` / `setConsolidationRunner` 闭包内自 resolve（不消费 caller 传入的 config），主 loop 通路不改（chat/compact 同链后 spec.config 语义等价） |
| **Squad schema `summaryModelDefault` / `summaryModelDefaultProviderId`** | 存在，UI 上可配 | **删字段**（schema + handler body + service + UI 全整删；存量数据走 migration 清理） |
| **app_config `default_models.summary`** | 存在，UI 上可配 | **删字段**（前端删 chat/summary 两列的 summary 列；后端 resolver 不再读；存量走 migration 清理） |

## 已知 spec 偏离（doc-modifier 阶段 5 修）

1. **`specs/tech/agent/context/[P0]context_compact_detail.md §2b.1 / §6.4` compact task 描述**：目前描述基于 v0.0.155 分链（引「summary fallback 链」），本版本删链后需改为「compact 走与 chat 同一链」。change_plan 不改 spec，doc-modifier 修。
2. **`specs/tech/agent/providers_and_models/[P0]model_resolve.md` PRD §3 六行 fallback 表**：本版本收敛为 4 行（chat × {playground, studio}）——删 summary 两行 + 各链末尾的 summary 分支。doc-modifier 修。
3. **`specs/api/overall/04-agent-session.md §3.2` POST /messages 请求体** 描述 body.providerId/modelId：本版本删除该参数（handler 忽略但不 400）；doc-modifier 修 spec 标为「已废弃，保留兼容接受但忽略」。
4. **`specs/api/overall/11a-squad-endpoints.md §1` Squad 字段表**：删 summaryModelDefault / summaryModelDefaultProviderId 两行。doc-modifier 修。
5. **UI spec `component-manage-tab.md` / `section-default-models-and-request.md`**：删「默认整理模型」相关 testid（`key-model-picker-summary` / `key-model-summary-clear` / `key-card-summary`）。doc-modifier 修。

## 变更清单

<!-- 行 = 一个函数/符号；同模块相邻。类型：新增 / 修改 / 删除 -->

### A. 后端 — model_resolver（PRD §3 表收敛为 chat 单链）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| model_resolver | app/server/src/services/model-resolver.ts | `SquadLike` interface | 修改 | 删除 `summaryModelDefault` + `summaryModelDefaultProviderId` 两字段（chat/compact 同链后 squad 只保 modelDefault + modelDefaultProviderId 复合 ModelRef） | MUST NOT 保留任何 summary* 字段读取 | Invariant §INV-A5 收窄；context.md findings #3 | +0/-6 |
| model_resolver | app/server/src/services/model-resolver.ts | `ResolveModelInput` interface | 修改 | 删除 `task: 'chat' \| 'summary'` 字段；删除 `bodyOverrideModelId` / `bodyOverrideProviderId` 两字段 | MUST NOT 保留 task 字段（三处 caller 同步去参）；MUST NOT 保留 bodyOverride*（body 参数整删） | Invariant §task 参数 + §body override | +0/-8 |
| model_resolver | app/server/src/services/model-resolver.ts | `ModelNotConfiguredError` class | 修改 | 构造函数第 2 参数 `task` 删除；`detail` 类型 `{sessionType, task}` → `{sessionType}`；错误 message 保留 | MUST 保 `code: 'MODEL_NOT_CONFIGURED'` 契约不变；handler catch 后 400 响应体 shape `{code, message, detail:{sessionType}}` | Invariant §task 参数；api §5.1 错误契约 | +2/-8 |
| model_resolver | app/server/src/services/model-resolver.ts | `readPlaygroundDefault` | 修改 | 签名从 `(svc, key: 'chat'\|'summary')` 简化为 `(svc)`（内部固定读 `default_models/default.chat`）；rename 可选（保留原名亦可） | MUST 只读 `chat` key；MUST NOT 读 `summary` key（本版本删该字段） | model_resolver.ts 现行 §readPlayground | +2/-4 |
| model_resolver | app/server/src/services/model-resolver.ts | `resolveDefaultModel` | 修改 | 删除 `task: 'chat' \| 'summary'` 参数；删除 studio summary 分支（`if (task === 'summary')` 整块）；playground 分支只读 chat；studio 分支只读 `squad.modelDefault` + `modelDefaultProviderId` | MUST NOT 保留 summary 分支；MUST NOT 读 squad.summaryModelDefault | Invariant §INV-A5 收窄；spec compact_detail §2b.1（doc 待同步） | +5/-25 |
| model_resolver | app/server/src/services/model-resolver.ts | `buildFallbackChain` | 修改 | 移除 `task` / `bodyOverride*` 消费；删除 playground/studio 各自的 summary 子分支；chat 链保留（playground: body→session→default_chat；studio: body→session→squad_default——但 body 分支下方 caller 已不再传 body，实践上恒无 body 候选） | MUST 只产 chat 链（4 处 `if (task==='summary')` 全删）；MUST 保留 bodyCandidate 处理路径（防未来复活也无害；本版本 caller 传空 undefined） | Invariant §task 参数；model_resolver §buildFallbackChain 现行注释 | +12/-40 |
| model_resolver | app/server/src/services/model-resolver.ts | `resolveModel` | 修改 | 内部 `throw new ModelNotConfiguredError(input.sessionType, input.task)` → `throw new ModelNotConfiguredError(input.sessionType)`（少一参） | MUST 保 throw 位置不变（fallback 跑空即 throw） | Invariant §task 参数 | +1/-1 |
| model_resolver | app/server/src/services/model-resolver.ts | 顶部 header 注释 | 修改 | 更新头注释块的「设计要点」小节：删 INV-A5 关于 summary 的措辞（改为「chat/compact 同链」）；删「default 来源单点出口」中的 summary 分支描述 | MUST 与新 INV-A5 一致（无 summary 特判） | Invariant §INV-A5 | +6/-8 |

### B. 后端 — session-config（`buildSessionConfigFromDeps` 签名瘦身）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session_config | app/server/src/handlers/session-config.ts | `ProviderModelOverride` interface | 删除 | 类型整删（body override 参数整删；session-messages / session-compact / bootstrap 三处 caller 都改为不传 bodyOverride） | MUST 从 export 中彻底移除；grep 0 引用 | Invariant §body override | +0/-8 |
| session_config | app/server/src/handlers/session-config.ts | `buildSessionConfigFromDeps` 签名 | 修改 | 删除 `bodyOverride: ProviderModelOverride \| undefined` 参数（pos 4）；删除 `task: 'chat' \| 'summary' = 'chat'` 参数（末位）；其余参数（deps/sessionId/sessionPersist/kind/workspaceDir/scope/subAgentConfig/studioContext）保留 | MUST 保留 kind 必填不变；MUST 保留组装顺序 5 步不动 | Invariant §task 参数 + §body override | +0/-10 |
| session_config | app/server/src/handlers/session-config.ts | `buildSessionConfigFromDeps` 实现 body | 修改 | 内部 `resolveModel({...})` 调用：删 `task`、`bodyOverrideModelId`、`bodyOverrideProviderId` 三字段；`squad` 展开对象删 `summaryModelDefault` / `summaryModelDefaultProviderId` 两字段（只留 modelDefault + modelDefaultProviderId） | MUST 保留 sessionModelId/sessionProviderId 复合 hint；MUST NOT 引用已删的 body/summary 字段 | model_resolver §buildFallbackChain | +2/-15 |

### C. 后端 — session-compact handler（唯一入口收敛）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session_compact | app/server/src/handlers/session-compact.ts | `handleSessionCompact` | 修改 | 删除 `buildSessionConfigFromDeps(...)` 90 行组装块；改为 `let config: SessionConfig; try { config = await deps.agentManager.resolveConfigBySid(id); } catch (e) { ... }`（唯一入口）；保留 ModelNotConfiguredError catch（返 400 `{code, message, detail:{sessionType}}`）+ ProviderNotFound/ModelNotFound catch（返 400）；保留 fire-and-forget `void deps.contextEngine.compact(config).catch(log)` 尾段；handler 从 ~90 行瘦到 ~30 行 | MUST 走 `agentManager.resolveConfigBySid`（唯一入口）；MUST NOT 直调 `buildSessionConfigFromDeps`；MUST 保留 202 fire-and-forget + 409 lock 检查（不动） | context.md §files context_compact_detail §2b；Invariant §唯一入口 | +12/-70 |
| session_compact | app/server/src/handlers/session-compact.ts | 头注释 | 修改 | 更新说明段：删「summary fallback 链 PRD §2.1 第 2/4/6 行」；改为「compact 走 chat 同链——resolveConfigBySid 唯一入口，chat/compact 无区分」 | MUST 与新 Invariant 一致 | Invariant §task 参数 | +5/-6 |

### D. 后端 — session-messages handler（删 body override 解析）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session_messages | app/server/src/handlers/session-messages.ts | `PostMessageBody` interface | 修改 | 删除 `providerId?: string` + `modelId?: string` 两字段（保留 content/activate/toolReply） | MUST 从 interface 移除；旧 client 传字段 body TS 层不 typecheck 但**运行时静默忽略**（后端不 400、不解析、不落 session） | Invariant §body override | +0/-4 |
| session_messages | app/server/src/handlers/session-messages.ts | `handleMessagesPost` | 修改 | 删除 `body.providerId` 校验分支（`findProvider(...) → 400`）；删除 `body.modelId` 校验 + 落盘分支（`validateModelId → normalizeReservedModelId → updateSession({modelId})` 整块）；保留 content/toolReply/skipActivate 三分支；保留 ModelNotConfiguredError catch | MUST NOT 落 session.modelId / session.providerId（改配置生效点 = 用户改设置那一刻，PUT /session 或 PATCH squad） | Invariant §body override；api §3.2（doc 待同步） | +0/-25 |
| session_messages | app/server/src/handlers/session-messages.ts | 未用 import 清理 | 修改 | `validateModelId` / `isReservedModelId` / `normalizeReservedModelId` / `findProvider` 如失去引用则删 import 行；`ModelNotConfiguredError` 保留（deliverTo catch 分支） | MUST grep 无残留引用 | 编码惯例 | +0/-3 |

### E. 后端 — bootstrap（唯一入口注入到 forked/consolidation runner）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bootstrap | app/server/src/bootstrap.ts | `agentManager.setResolveConfig` 闭包 | 修改 | 内部调 `buildSessionConfigFromDeps(deps, sessionId, {providerId, modelId, effort, approvalMode}, kind, workspaceDir, scope, subAgentConfig, studioContext)` —— **删掉 `undefined` bodyOverride 位置参 + 末位 task 参数**（对齐 §B 新签名）；保留 studio 分支 studioContext 装配（squad/member/members 拉齐） | MUST 保持 studio session 判定 + 装配链路；MUST 传新签名的位置参 | §B buildSessionConfigFromDeps 新签名 | +2/-5 |
| bootstrap | app/server/src/bootstrap.ts | `contextEngine.setForkedRunner` 闭包 | 修改 | 闭包内首行加 `const config = await agentManager.resolveConfigBySid(input.sessionId)`（唯一入口）；下方 `agentManager.forkedRun({... config, ...})` 用 **本地 `config`** 而非 `input.config`；`input.config` 参数彻底不消费 | MUST 走 resolveConfigBySid（chat 链，chat/compact 同链后语义等价 spec.config）；MUST NOT 消费 caller 传入的 config；MUST 保留 modeKey='summary' / NO_TOOLS / maxIter=1 / structuredClone 语义 | Invariant §唯一入口；context_compact_detail §2c.1（doc 待同步） | +3/-2 |
| bootstrap | app/server/src/bootstrap.ts | `contextEngine.setConsolidationRunner` 闭包 | 修改 | 同上：闭包内首行 `const config = await agentManager.resolveConfigBySid(input.sessionId)`；下方 `agentManager.forkedRun({... config, ...})` 用本地 config；`input.config` 不消费 | MUST 走 resolveConfigBySid；MUST 保留 modeKey/toolWhitelist/maxIter 由 caller 指定的语义 | Invariant §唯一入口；context_compact_detail §2d.1 | +3/-2 |

### F. 后端 — compact runner / types（runner input 删 config 字段）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| compact_types | app/server/src/agent/context-compact-runner.ts | `CompactForkedRunner` type | 修改 | input 对象 shape 删除 `config: SessionConfig` 字段（保留 sessionId/snapshot/userMessage/triggerMessageId/triggerUsage）；runner 内部自行 resolve | MUST 保留其余字段；type 更新后 `import type SessionConfig` 若无其他引用则清 import | Invariant §唯一入口 | +0/-3 |
| compact_types | app/server/src/agent/context-compact-runner.ts | `runCompact` | 修改 | forkedRunner 调用去掉 `config` 传参（保留 sessionId/snapshot/userMessage/trigger*）；`config: SessionConfig` 形参**保留**（仍用 `config.sessionId` 派生 sid + 传递给 taskLock），无功能改动 | MUST 只从 forkedRunner input 摘掉 config；MUST 保留 `sid = config.sessionId` 与 taskLock CAS 语义 | §E setForkedRunner 闭包 | +0/-1 |
| compact_types | app/server/src/agent/compact-types.ts | `ConsolidationRunner` type | 修改 | input 对象 shape 删除 `config: SessionConfig` 字段（保留 sessionId/modeKey/snapshot/userMessage/enableToolWhitelist/toolWhitelist/toolDefinitions/maxIter/trigger*） | MUST 与 setConsolidationRunner 闭包签名同步 | Invariant §唯一入口 | +0/-3 |
| compact_types | app/server/src/agent/compact-types.ts | `CompactCtx` interface | 修改 | `config` 字段**保留**（consolidation handler 从 ctx.config.sessionId 派生 sid + fork-2 内部 resolve 自行走 setConsolidationRunner 闭包）；不动 | 保留字段以维持 handler 兼容 | Invariant §唯一入口 边界解释 | +0/-0 |
| compact_consolidation | app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts | `MemorySkillConsolidationHandler.startConsolidation` | 修改 | `runner({...})` 调用去掉 `config: ctx.config` 传参（保留 sessionId=`ctx.config.sessionId` + 其余字段）；handler 逻辑其余不动 | MUST 与 §F ConsolidationRunner 新 shape 一致 | §F ConsolidationRunner | +0/-1 |

### G. 后端 — squad schema + handler + service（删 summaryModelDefault 字段族）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_schema | app/server/src/agent/schema_defs/squad/squad.ts | `SquadSchema.fields` | 修改 | 删除 `summaryModelDefault` + `summaryModelDefaultProviderId` 两字段定义（modelDefault + modelDefaultProviderId 保留）；`SquadRecord` 类型自动派生跟着变 | MUST 存量数据兼容（record 读到多余字段 lazy 忽略，migration handler 事后清） | Invariant §Squad schema | +0/-16 |
| squad_handler | app/server/src/handlers/squad.ts | `CreateSquadBody` interface | 修改 | 删除 `summaryModelDefault` + `summaryModelDefaultProviderId` 两字段 | 兼容：旧 client 传字段 → TS 编译层不通过但**运行时忽略**（不 400） | Invariant §Squad schema | +0/-4 |
| squad_handler | app/server/src/handlers/squad.ts | `PatchSquadBody` interface | 修改 | 删除 `summaryModelDefault` + `summaryModelDefaultProviderId` 两字段 | 同上 | Invariant §Squad schema | +0/-4 |
| squad_handler | app/server/src/handlers/squad.ts | `SquadDetail` interface（响应型） | 修改 | 删除 `summaryModelDefault` + `summaryModelDefaultProviderId` 两字段 | GET /squad/:id 响应不再回显；前端类型同步 §I 删字段 | Invariant §Squad schema；api 11a §1.3 | +0/-4 |
| squad_handler | app/server/src/handlers/squad.ts | `handleCreateSquad` | 修改 | 删除 summary 相关校验：`summaryModelDefaultProviderId without summaryModelDefault` 400 分支 + `checkModel(deps.appConfig, body.summaryModelDefault, body.summaryModelDefaultProviderId)` 校验分支；传给 `createSquadService` 的 input 去除 summary 字段（依 §G squad-service 新签名） | MUST 保留 modelDefault 校验；MUST NOT 引用 body.summaryModelDefault* | Invariant §Squad schema | +0/-8 |
| squad_handler | app/server/src/handlers/squad.ts | `handlePatchSquad` | 修改 | 删除 summary 相关：字段级 400 分支（`summaryModelDefault === '' && summaryModelDefaultProviderId !== ''`）+ `checkModel` 校验分支 + patch 写入分支（`patch.summaryModelDefault = ...` / `patch.summaryModelDefaultProviderId = ...`）整删 | MUST 保留 modelDefault 相关字段处理 | Invariant §Squad schema | +0/-16 |
| squad_handler | app/server/src/handlers/squad.ts | `toDetail` | 修改 | 响应体去除 `summaryModelDefault: s.summaryModelDefault` + `summaryModelDefaultProviderId: s.summaryModelDefaultProviderId` 两字段 | MUST 与 SquadDetail interface 同步 | Invariant §Squad schema | +0/-2 |
| squad_service | app/server/src/services/squad-service.ts | `CreateSquadInput` interface | 修改 | 删除 `summaryModelDefault?: string` + `summaryModelDefaultProviderId?: string` 两字段 | 与 handler CreateSquadBody 同步 | Invariant §Squad schema | +0/-4 |
| squad_service | app/server/src/services/squad-service.ts | `createSquadService` | 修改 | 删除 summary 校验块（`if (input.summaryModelDefault !== undefined)` checkModel 分支）+ 归一化块（`summaryModelDefault === ''` / providerId 联动块）+ 落盘 spread（`summaryModelDefault` 透传行 + `summaryModelDefaultProviderId` 条件 spread） | MUST 保留 modelDefault 路径不动 | Invariant §Squad schema | +0/-18 |
| squad_handler | app/server/src/handlers/squad.ts | 顶部 header 注释 + checkModel doc | 修改 | 更新「modelDefault / summaryModelDefault 写入校验」措辞为只提 modelDefault；checkModel 函数 doc 同步 | 与新接口面一致 | Invariant §Squad schema | +2/-4 |

### H. 后端 — Migration handlers（存量数据一次性清理）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| migration | app/server/src/migration/handlers/clean-default-models-summary.ts | `cleanDefaultModelsSummaryMigration` (new file) | 新增 | handler：读 `appConfig.get('default_models', 'default')` → 若返回对象存在且含 `summary` key（`Object.prototype.hasOwnProperty.call(rec, 'summary')`）→ `delete rec.summary` + `appConfig.set('default_models', 'default', rec)`；record 不存在 / 无 summary key → 静默 no-op | MUST 幂等（二次跑 no-op）；MUST 只动 summary key（保留 chat + 其他字段）；MUST 走 AppConfigService.set（不裸写 fs） | context.md §files migration_manager §3；本版本裁决删除清单 §3 | +45/0 |
| migration | app/server/src/migration/handlers/clean-squad-summary-model-default.ts | `cleanSquadSummaryModelDefaultMigration` (new file) | 新增 | handler：`new SquadStore({root: dataDir}).listSquads()` → 遍历每个 squad → 若 record 含 `summaryModelDefault` 或 `summaryModelDefaultProviderId` 任一字段 → `delete` 两字段 + `squadStore.updateSquad(...)` 或走 CrudStore replace 语义 write（复用现有 store 更新入口，禁裸 fs） | MUST 幂等；MUST 只 unset 这两字段，其他字段原样保留（version/updatedAt 由 CrudStore 信封处理）；MUST 无 squad / 无字段 → 静默 no-op | 本版本裁决删除清单 §3 | +60/0 |
| migration | app/server/src/migration/handlers/handlers.yaml | 追加两条 entry | 修改 | 追加 `{id: clean-default-models-summary, versionRange: '<0.0.158', module: './handlers/clean-default-models-summary'}` + `{id: clean-squad-summary-model-default, versionRange: '<0.0.158', module: './handlers/clean-squad-summary-model-default'}` | MUST versionRange 用 `<0.0.158`（仅 ledger `lastAppVersion < 0.0.158` 时触发；跑完 ledger 记 done 后续启动 applied 主防线 skip） | migration_manager §3.1 processEntry 分支；context.md #4 | +6/-0 |
| migration | app/server/src/migration/handlers/index.ts | `handlerRegistry` map | 修改 | import 两个新 handler；map 注册 `'clean-default-models-summary': cleanDefaultModelsSummaryMigration` + `'clean-squad-summary-model-default': cleanSquadSummaryModelDefaultMigration` | MUST 与 handlers.yaml id 完全一致（resolveHandler 报错以 id 查） | migration_manager §3.2 静态 registry | +4/-0 |
| migration_ut | app/server/src/migration/handlers/__tests__/clean-default-models-summary.test.ts | new file | 新增 | 两分支 UT：(1) 数据存在（record 含 chat+summary）→ 跑后 chat 保留、summary 删除、set 被调；(2) 数据不存在（无 record / 无 summary key）→ set 未被调用（no-op） | MUST 用 vitest；MUST mock AppConfigService 或用真实 in-mem fixture；MUST 断言幂等（二次跑无副作用） | 本版本裁决 §两 migration UT 覆盖 | +80/0 |
| migration_ut | app/server/src/migration/handlers/__tests__/clean-squad-summary-model-default.test.ts | new file | 新增 | 两分支 UT：(1) 数据存在（某 squad 含 summaryModelDefault 或 providerId）→ 跑后字段被 unset、modelDefault 保留；(2) 数据不存在（无 squad / 全无 summary 字段）→ 无更新调用 | MUST 用真实 SquadStore + tmpdir dataDir；MUST 断言幂等 | 同上 | +100/0 |

### I. 前端 — 类型删字段（squad-types.ts）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_squad_types | app/web/src/components/studio-page/squad-types.ts | `SquadDetail` interface | 修改 | 删 `summaryModelDefault?: string` + `summaryModelDefaultProviderId?: string` 两字段 | 与后端 SquadDetail 响应型同步（§G） | Invariant §Squad schema | +0/-8 |
| ui_squad_types | app/web/src/components/studio-page/squad-types.ts | `CreateSquadBody` interface | 修改 | 删 `summaryModelDefault?: string` + `summaryModelDefaultProviderId?: string` 两字段 | 同步 §G handler CreateSquadBody | Invariant §Squad schema | +0/-4 |
| ui_squad_types | app/web/src/components/studio-page/squad-types.ts | `PatchSquadBody` interface | 修改 | 删 `summaryModelDefault?: string` + `summaryModelDefaultProviderId?: string` 两字段 | 同步 §G handler PatchSquadBody | Invariant §Squad schema | +0/-4 |

### J. 前端 — Studio squad 编辑页删「默认整理模型」

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_studio | app/web/src/components/studio-page/component-manage-tab.tsx | `ManageTab` | 修改 | 删除 `summaryModel` useState + `summaryModel !== detail.summaryModelDefault` dirty 分支 + `onSaveMeta({summaryModelDefault: summaryModel})` 传参 + JSX 段 `<div className="mb-4">...KeyModelPicker testIdSuffix="summary".../></div>`（含 label）；`KeyModelPicker` import 若无其他引用则清除 | MUST 保留 name/description/modelDefault 三字段编辑；MUST 保留 charter / delete section 不动；testid `key-model-picker-summary` / `key-model-summary-clear` / `key-card-summary` 从 UI 消失 | 需求 §删除清单 前端 §1；context.md §files component-manage-tab.tsx | +0/-25 |
| ui_studio | app/web/src/components/studio-page/component-manage-tab.tsx | 头注释 | 修改 | 更新 header 注释「职责」小节：删「/summaryModelDefault」；删「summaryModelDefault 编辑器：复用 common/KeyModelPicker...」段 | 与新实现一致 | 同上 | +2/-6 |
| i18n | app/web/src/components/studio-page/**（locale 文件路径由 coder 确认）| `studio:manageTab.summaryModelLabel` key | 删除 | 删除该 key（i18n 资源中英双语），避免僵尸翻译 | MUST 删中英双语；grep 0 使用 | i18n-key-add-checklist memory | +0/-4 |

### K. 前端 — 应用设置删「默认压缩模型」列 + 类型收窄

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_appset_defs | app/web/src/components/app-dev-config-page/app-settings-config-defs.ts | `DefaultModelsData` interface | 修改 | 删 `summary?: string` 字段（保留 `chat?: string`） | 与后端 default_models schema 同步 | Invariant §default_models.summary | +0/-1 |
| ui_appset | app/web/src/components/app-dev-config-page/section-default-models-and-request.tsx | `SectionDefaultModelsAndRequestProps.onDefaultModelsChange` 类型 | 修改 | 参数 `key` 类型 `'chat' \| 'summary'` → `'chat'`（可考虑改为无 key 参数直接 `(value: string \| undefined) => void`——由 coder 定 stylistically，MUST 类型层剔 summary） | MUST 前端 UI 只能编辑 chat | 需求 §删除清单 前端 §2 | +1/-1 |
| ui_appset | app/web/src/components/app-dev-config-page/section-default-models-and-request.tsx | `DefaultModelsGroup` | 修改 | 删除第二个 `<ModelKeyRow keyName="summary" ...>` JSX 段（含 label/desc/value/onChange 四 props） | MUST 只保留 chat 列 | 同上 | +0/-8 |
| ui_appset | app/web/src/components/app-dev-config-page/section-default-models-and-request.tsx | `ModelKeyRow.keyName` 类型 | 修改 | 类型 `'chat' \| 'summary'` → `'chat'`；testid `key-card-summary` 与 `key-card-summary-label` 从 UI 消失 | MUST 与 caller 同步 | 同上 | +1/-1 |
| ui_appset | app/web/src/components/app-dev-config-page/use-app-settings-config.ts | `handleDefaultModelsChange` | 修改 | 参数 `key` 类型收窄为 `'chat'`；`setDmDraft` 内 delete/set 分支不动（key 仍是 'chat' 单值） | MUST 与 §K SectionDefaultModelsAndRequestProps 同步 | 同上 | +1/-1 |
| ui_appset | app/web/src/components/app-dev-config-page/use-app-settings-config.ts | `dirtyOfTab` (default_models 分支) | 修改 | dirty 判定简化：`dmDraft.chat !== dmSnapshot.chat` 单字段比较；删除 `for (const k of dKeys)` 循环遍历（chat 单字段直比更清晰）——本条为可选简化，功能等价 | MUST 保留 dirty 语义正确；测试 UT 若断言遍历路径需同步更新 | 同上 | +2/-8 |
| ui_appset | app/web/src/components/app-dev-config-page/section-tab-panel.tsx | `SectionTabPanelProps.onDefaultModelsChange` | 修改 | 类型 `key` 参数收窄为 `'chat'`（与 §K 上游一致） | MUST 与上游同步 | 同上 | +1/-1 |
| ui_appset | app/web/src/components/app-dev-config-page/use-app-settings-config.ts | `UseAppSettingsConfigResult.handleDefaultModelsChange` | 修改 | 返回类型收窄同 §K | 同上 | 同上 | +1/-1 |
| i18n | app/web/src/**（locale 文件路径由 coder 确认）| `schema.default_models.summary.label` + `schema.default_models.summary.desc` | 删除 | 删除两 i18n key（中英双语） | MUST grep 0 使用 | i18n-key-add-checklist memory | +0/-4 |

### L. 前端 — chat 发消息 API 层删 body override

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| chat_api | app/web/src/lib/chat-api.ts | `postMessage` 签名 | 修改 | body 参数删 `providerId?: string` + `modelId?: string` 两字段（保留 content/toolReply） | MUST 与后端 §D PostMessageBody 同步；旧 body 字段 TS 层禁写；调用点（§L 下方 3 处）同步删传参 | Invariant §body override | +0/-4 |
| chat_page | app/web/src/components/chat-page/page-chat.tsx | `handleSend` | 修改 | `postMessage(activeSessionId, { content, providerId: model?.providerId, modelId: model?.modelId })` → `postMessage(activeSessionId, { content })`；`model` 变量若仅用于此处则 useCallback deps 中的 `model` 也需清理（现地由 setModel 落 session 走 PUT /session 路径，此处不再挂 per-call override） | MUST 保留 handleSend 主体不动；MUST NOT 保留 model 依赖引用（若无其他消费） | 需求 §删除清单 前端 §4 | +1/-2 |
| studio_chat | app/web/src/components/studio-page/section-squad-chat.tsx | `handleSend` | 修改 | `postMessage(sessionId, { content, providerId: modelOverride?.providerId, modelId: modelOverride?.modelId })` → `postMessage(sessionId, { content })`；`modelOverride` 依然可留（编辑器 UI 直接改 session.modelId 走 PUT /session 落库），但此处不再挂 body | MUST 与 §L postMessage 签名同步；useCallback deps 若无 modelOverride 消费则删 | 同上 | +1/-3 |
| studio_chat | app/web/src/components/studio-page/section-squad-chat.tsx | 头注释 INV-D1 段 | 修改 | 删除注释「per-call model override 保留（INV-D1，postMessage body 透传 providerId+modelId）」；改为「模型改动由 setModel 走 PUT /session 落库；发消息 body 不再带 provider/model override」 | 与新实现一致 | 同上 | +2/-2 |
| studio_chat_ut | app/web/src/components/studio-page/__tests__/section-squad-chat.test.tsx | `[P5]` 两 case | 修改/删除 | 现有 `[P5] 选 picker 具体项 → 发送时 postMessage body 含 providerId+modelId` + `[P5] 未选 model 直接发送 → body providerId/modelId undefined` 两 case → 改断言为「body 只有 content，无 providerId/modelId 字段」（或整删两 case） | MUST 与 §L 新语义对齐 | §L | +5/-15 |

## 影响面评估

- **跨模块**：后端 model_resolver / handlers / bootstrap / squad(schema + handler + service) / migration；plugin builtins/rocky_context（1 处 consolidation handler）；前端 studio-page / app-dev-config-page / chat-api / chat-page/studio 发消息路径。
- **破坏性变更**：
  - **前端 → 后端 API**：POST /session/:id/messages body 的 providerId/modelId 参数移除（后端仍能接受但静默忽略——**兼容**旧未升级 client；不 400）。POST /squad + PATCH /squad body 的 summaryModelDefault* 字段移除（后端 TS 侧类型删；旧 body 传字段 → 运行时进 patch 展开会带上被 SquadSchema 拒收？——由于 SquadSchema 已删字段，CrudStore 写盘时 strict 校验会 fail；**coder 需确认 CrudStore fields 未定义字段的处理策略**：若 strict → 500，需在 handler patch 构造处显式 drop）。
  - **API 响应**：GET /squad/:id 不再回显 summaryModelDefault* 字段（老前端读为 undefined 兼容）。
- **依赖顺序**：
  1. 先 §A model_resolver + §B session-config + §D session-messages（类型收窄，编译层门禁）
  2. §C session-compact + §E bootstrap + §F runner input（唯一入口收敛，运行时）
  3. §G squad schema / handler / service 一起（字段整删闭环）
  4. §H migration（存量清理，独立）
  5. §I 前端类型 / §J §K §L 前端删字段与 body（前端 typecheck 门禁）
- **风险点**：
  - **CrudStore 未定义字段处理**（`squadStore.updateSquad` 传入已从 SquadSchema 删除的 summaryModelDefault* 字段时行为）——coder 若发现拒收，需在 clean-squad-summary-model-default handler 内**先** delete 字段再 write（本行 §H handler 已按此实现）；同时后端 §G 各 handler 的 patch 构造已不带该字段，正常路径无 gap。
  - **bootstrap setForkedRunner / setConsolidationRunner 闭包**：本版本改为闭包内 resolveConfigBySid，`agentManager.resolveConfigBySid` 在初始化时可能触发 assertion（`resolveConfig not injected`）——由于闭包内 `agentManager` 就是本 bootstrap 已构造的实例、`setResolveConfig` 也在同 bootstrap 内完成，实际调用发生时（forkedRun 派发）已注入完成，无循环坑。coder 验证时确认执行顺序。
  - **body 静默忽略 vs 400**：前端删传后，后端接收旧 client body 时不 400 只忽略（兼容层）——若后端严格模式 typecheck 报 unknown key，则 handler 用 `Pick<...>` / `as PostMessageBody` cast 避开；无需返 400。
  - **AutoNamingService**：走 `resolveConfigBySid` 拿 chat config 后调 `client.call`——本版本不动，chat 链保留，AutoNaming 天然复用。
- **compact ratio / T2 天级整理 / see_image / web_search / subagent 出生模型 / auto-naming**：全部不动。
- **AT 冒烟集入选评估**（需求 §关键用户路径 P1/P2/P3/P4）：orchestrator 阶段 2.5 test-plan 决定是否入选 / 一进一出淘汰；本 change_plan 不做 tests/ 新增行（AT/ET case 由 test-designer 阶段 4 与编码并行创建）。
- **spec 同步（doc-modifier 阶段 5）**：已列上「已知 spec 偏离」5 条，doc-modifier 修 spec 对齐代码。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
- spec ↔ code 偏离（如 CrudStore 未定义字段行为与预期不符）→ coder 汇报 orchestrator，orchestrator 记 doc-sync 待办，doc-modifier 阶段 5 修 spec。
