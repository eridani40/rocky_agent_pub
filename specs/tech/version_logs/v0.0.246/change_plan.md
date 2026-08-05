# v0.0.246 变更计划书 — 修复 spawn 子 agent 不继承父 agent 实际模型（D8 inherit 改用 resolved）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 背景：spawn 的 D8 inherit（`eff.modelId = template?.modelId ?? parent.modelId`）传父 session record 原始 modelId hint（常 `'default'/空`）而非运行时 resolved 具体 model；子作为 subagent 被 `isStudioMainSession`（需 `derivation='parent'`）切断 squad/classroom default 链 → resolveModel fallback 跑空 → 抛 `ModelNotConfiguredError`（"请配置模型后再发起会话"）。本版本改 spawn 取 **parent resolved 具体 `{providerId, modelId}`**，让子 session 候选为具体值、不再依赖被切断的 default 链。需求：`reqs/[working] v0.0.246.spawn_model_inherit/req.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁模糊描述） |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 / 项目原则编号 |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-tools | app/server/src/agent/tools/agent-tool.ts | runSpawn | 修改 | 删 `store.getSession(parentSid)` 读 raw `parentSession.modelId`；改 `const parentConfig = await rtc.agentManager.resolveConfigBySid(rtc.parentSessionId)`，`parentModelId = parentConfig.modelId`、`parentProviderId = parentConfig.providerId`（父这次 run 的 resolved 具体值）；executeSpawn ctx 透传 `parentProviderId` | MUST 用 resolved 具体 model（非 raw hint）；MUST NOT 保留 store 读 raw modelId 旧路径；resolve 失败抛错透传（parent 能 spawn 说明其 resolveConfigBySid 必成功） | subagent_derivation §4 D8；agent-manager.ts:130 | +4/-2 |
| agent-tools | app/server/src/agent/tools/spawn-action.ts | executeSpawn（childConfig 构造） | 修改 | createChildSession 的 `childConfig` 加 `providerId: ctx.parentProviderId`（透传 resolved providerId 到落库） | MUST providerId 与 modelId 同源（ctx.parentProviderId / parentModelId，均 resolved） | INV-B1 复合 ModelRef；types.ts:140 AgentSpawnContext | +1 |
| agent-tools | app/server/src/agent/tools/agent-tool.ts | createChildSessionImpl | 修改 | `childConfig` 入参类型加 `providerId?: string`；落库 `providerId: input.childConfig.providerId`（替代 `parent?.providerId` raw hint） | MUST child record 落 resolved providerId；MUST NOT 再用 `parent?.providerId` raw；仍需 `store.getSession` 读 parent 取 biz/role/squadId/workspaceDir（非 model 维度，保留） | session-config.ts:208 providerId 复合 hint | +2/-1 |

> **D8 inherit 语义保留**：`executeSpawn` / `template-loader.ts` 不改——`parentModelId` 现已是 resolved 具体值，`eff.modelId = template?.modelId ?? parentModelId` 自然成立（有模板走模板 model，无模板走父 resolved 具体 model）。`AgentSpawnContext.parentModelId/parentProviderId`（types.ts:143-146，原死接口）本版本激活使用。

## 影响面评估
- **跨模块**：仅 agent-tools 子系统（2 文件 3 处 method 级改动）；不改 spawn-action 编排逻辑/template-loader/model-resolver/bootstrap/session-config/isStudioMainSession。
- **无破坏性变更**：D8 语义（模板优先）保留；仅 parentModelId/providerId 来源从 raw hint 变 resolved 具体值。child session 候选变为具体 model → 走 session 候选命中，不再依赖（被切断的）default 链。
- **依赖顺序**：runSpawn 已能拿 `rtc.agentManager`（既有句柄），零新增依赖。
- **风险点**：① `resolveConfigBySid(parentSid)` 在 parent 自身未配 model 时会抛——但 parent 能执行 spawn 说明其 config 已 resolved 成功，不会发生；② parent 是 academy 时同样覆盖（academy 链跑通才有这次 run，resolveConfigBySid 返 classroom resolved 具体 model）；③ back-compat：旧 child session record（无 resolved providerId）不受影响——本改动只影响新建 child。

## 反馈回路
- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
