# v0.0.246 变更日志 — 修复 spawn 子 agent 不继承父实际模型（D8 inherit 改用 resolved）

> 版本轴发布说明（跨 KB）。位置轴见各 KB `log.md`（multi_agent + agent/tools）；method 级契约见同目录 `change_plan.md`。
> 纯技术 bug 修复，**无 PRD/API/UI 变更**（不产 prd/api/ui version_log，无 app-guide 更新）。
> 需求源：`reqs/[working] v0.0.246.spawn_model_inherit/req.md`。

## 1. 主题

`agent.spawn` 报「请配置模型后再发起会话」。根因：D8 inherit（`eff.modelId = template?.modelId ?? parent.modelId`）的 `parent.modelId` 旧取父 session record 原始 modelId hint（常 `'default'`/空），非运行时 resolved 具体 model；子作为 subagent 被 `isStudioMainSession`（需 `derivation='parent'`）切断 squad/classroom default 链 → resolveModel fallback 跑空 → 抛 `ModelNotConfiguredError`。

修法：spawn `runSpawn` 调 `agentManager.resolveConfigBySid(parentSid)` 取父这次 run 解析出的 resolved 具体 `{modelId, providerId}`，替代读 `session.modelId` raw hint。child session 候选变为具体 model → 走 session 候选命中，不再依赖被切断的 default 链。D8 语义（模板优先 / spawn 不可覆盖）保留，仅 parentModelId/providerId 来源从 raw hint 变 resolved。

## 2. 实现偏差（相对 change_plan）

### 2.1 providerId 来源：`parentConfig.client.getInfo().providerId`（非 `parentConfig.providerId`）

- **change_plan 行 1（runSpawn）**原写 `parentProviderId = parentConfig.providerId`（假设 `resolveConfigBySid` 返回的 `SessionConfig` 顶层有 `providerId` 字段）。
- **实际落地**（`agent-tool.ts:216`）：`parentProviderId = parentConfig.client.getInfo().providerId`——从 `client.getInfo()` 取。
- **偏离原因（实证）**：`SessionConfig`（`app/server/src/agent/context-types.ts:88`）顶层字段 = `sessionId/systemPrompt/client/modelId/tools/workdir/maxIterations/loopMode/observability/skills/...`，**无 `providerId`**。providerId 是 `buildSessionConfigFromDeps`（`session-config.ts`）的局部变量，只挂在 `LlmClient.getInfo()` 返回值上（client 构造时封装），不暴露到 SessionConfig 顶层。故 change_plan 假设的字段不存在，须从 `client.getInfo()` 取。
- **语义未越界**：仍是「取 parent resolved 具体 providerId」（与 modelId 同源 parentConfig），仅访问路径调整（顶层字段 → client.getInfo()）。`client.getInfo().providerId` 是 provider 解析后的真实值（非 raw hint），满足「resolved 具体」约束。
- **architect 教训**：写 change_plan「调用 X.Y() / 引用 字段 Z」时应核对返回类型字段闭合性——`resolveConfigBySid` 返回 `SessionConfig`，`SessionConfig` 不导出 providerId（只导出 client + modelId）。coder 通过 `client.getInfo()` 兜底取到，属合理偏离。

### 2.2 行 2/3 无偏离（按表落地）

- `spawn-action.ts:116` `childConfig.providerId = ctx.parentProviderId`（resolved 透传）+ `agent-tool.ts:329 createChildSessionImpl` 落库 `providerId: input.childConfig.providerId`（替代旧 `parent?.providerId` raw hint）均按 change_plan 行 2/3 落地，**无偏离**。
- `agent-tool.ts:317` 仍调 `store.getSession(parentSid)` 读 parent 取 biz/role/squadId/workspaceDir（非 model 维度，保留，与 change_plan 行 3 约束一致）。
- `template-loader.ts:92` `template?.modelId ?? parentModelId` 不改——parentModelId 现已是 resolved，D8 语义自然成立（change_plan 已声明 executeSpawn/template-loader 不改）。

## 3. 代码↔spec 一致性核实（doc-modifier 阶段 5）

逐项核对「代码实现 == spec 契约」，**结论：spec 偏离已同步对齐**——

| 契约点 | 代码核实 |
|---|---|
| runSpawn 取 parent resolved（非 raw hint） | `agent-tool.ts:214` `resolveConfigBySid(parentSid)` → `parentConfig`（resolved）✓ |
| parentModelId = resolved modelId | `agent-tool.ts:215` `parentConfig.modelId` ✓ |
| parentProviderId = resolved providerId | `agent-tool.ts:216` `parentConfig.client.getInfo().providerId`（偏离 change_plan 字段路径，§2.1 已记）✓ |
| executeSpawn 透传 resolved providerId | `spawn-action.ts:116` `providerId: ctx.parentProviderId` ✓ |
| createChildSessionImpl 落 resolved providerId | `agent-tool.ts:329` `providerId: input.childConfig.providerId`（替代旧 `parent?.providerId`）✓ |
| getSession 保留读 parent 非 model 维度 | `agent-tool.ts:317` 读 parent.biz/role/squadId/workspaceDir ✓ |
| D8 语义保留（template?.modelId ?? parent.modelId） | `template-loader.ts:92` 不改，parentModelId 现已是 resolved ✓ |
| AgentSpawnContext.parentProviderId 激活 | `spawn-action.ts:54-58` childConfig.providerId 字段 + `agent-tool.ts:299` 入参类型（原死接口激活）✓ |

## 4. spec 同步清单

- tech OKF：
  - `multi_agent/[P1]subagent_derivation.md §4`（D8 resolution 块 + childConfig.modelId 注释澄清 `parent.modelId` = parent resolved 具体 modelId）+ 该 KB `log.md` v0.0.246 条目。
  - `multi_agent/[P1]subagent_templates.md §4`（D8 resolution 伪码注释 + bullet 澄清 `parent.modelId` 来源 + providerId 同源说明）+ 该 KB `log.md` v0.0.246 条目。
  - `agent/tools/[P1]agent_tools.md`：**无改动**（本文不重复 D8 resolution 伪码，指向 derivation §4 + templates §4）；该 KB `log.md` v0.0.246 条目记实现层 parentModelId/providerId 来源调整 + providerId 偏离。
  - `multi_agent/design.md` D8 决策行：**不改**（decision log 记 D8 决策理由，公式 `eff.modelId = template?.modelId ?? parent.modelId` 概念层仍正确；parent.modelId 的 resolved 来源是实现细节，落 §4 spec + 本文，不污染决策理由）。
- prd/api/ui overall：**无变更**（纯技术修复，无用户可感知行为/界面变化；prd/api overall 中 `parent.modelId` 表述为概念层「inherit parent model」，语义不变不需改）。
- app-guide：**无更新**（无新功能/板块/操作路径）。
