# v0.0.48 — 跨版本发布说明（tech 侧）

> version: 1.0 · 2026-07-02
> 版本类型：**tool 系统统一**（policy 驱动 resolve + forked 白名单 formal 化 + 去 leader/mate tool 可配置）
> PRD 增量：`specs/prd/version_logs/v0.0.48/change_log.md`
> 调研定稿：`specs/research/v0.0.48-tool-system.md`（§9 gap + §10 最终方案 + §10.4 policy + §10.6 forked 三态）
> 设计稿：无 → 视觉保真门禁跳过

---

## 1. 7 项架构决策（PRD §6 落地）

| # | 决策点 | 决策 |
|---|---|---|
| 1 | **JSON tool policy 形式 + 位置** | TS 常量对象 `TOOL_POLICY`（非 JSON 文件，对齐 SchemaDef 风格 + 编译期类型 + IDE 跳转），落 **`app/server/src/agent/tool-policy.ts`** 新文件；schema/5 角色 bound + capByParent 见 `[P0]tool_policy.md §2` |
| 2 | **`resolveTools` 单方法签名** | `(input: { allTools, allToolDefs, role?, mainAllowedTools?, parentRole?, enableToolWhitelist?, toolWhitelist? }) → { tools, toolDefinitions, allowedTools }`；顶层走 role、subagent 走 mainAllowedTools ∩ bound、forked 走 enableToolWhitelist+toolWhitelist；**替代** `filterToolDefinitionsBySessionType`(schema) + `deriveAllowedTools`(exec) + session-config 工具分支(config) 三入口；4 调用点改造见 `[P0]tool_policy.md §4` |
| 3 | **`enableToolWhitelist` + `toolWhitelist` 字段位置 + 默认** | 加在 **`RunSpec`**（`loop-ports.ts:198`）；默认 `enableToolWhitelist=false`、`toolWhitelist=[]`；与现有 `RunSpec.allowedTools` **共存**（前者是 caller 输入到 resolveTools，后者是 resolveTools 产出给 exec 消费）；详见 `[P0]tool_policy.md §6` + `[P0]forked_reminder.md §4` |
| 4 | **forked reminder 注入点** | **cache 前缀之后**（snapshot 之后、userMessage 之前作为独立 user-role message）；**不复用** `system_reminder_injector`（forked scope 仍禁用它防污染 cache 前缀）；新增 `injectForkedReminder()` 独立注入器（`forked-reminder-injector.ts`）；文案三态模板见 `[P0]forked_reminder.md §3` |
| 5 | **统一拒绝错误 code** | `tool_not_allowed`（PRD §3.3 候选采用）；文案 `[tool_not_allowed] Tool '<name>' is not allowed in this session (<reason>).`；**不进 errorInfo**（ToolResultBlock.isError=true + content 已含 code 前缀，保持轻量）；合并 engine.ts:89(unknown_tool) + engine.ts:146-158(notAllowedResult) → 见 `[P0]tool_execution_engine.md §3.1` |
| 6 | **`Member.tools` 处理** | entity 字段保留为 **dead code**（不物理删，避免 migrate 风险；写 doc 标 deprecated）；API：PATCH body 带 tools → **忽略并 warn**（不返 400，向后兼容旧 client）；HireBody 去 tools 字段（不接收）；详见 `[P1]data_model.md §1.2` + API `11a-squad-endpoints.md §2.1/§2.2` |
| 7 | **subagent `input.tools` resolve 顺序** | `agent(action=spawn, input.tools)` 优先 → 缺省回退 `template.tools` → 结果 ∩ `TOOL_POLICY['subagent'].bound` → studio-subagent `capByParent=true` 再 ∩ `TOOL_POLICY[parentRole].bound`；改造点：`spawn-action.ts:89`/`template-loader.ts:74` 不变（input ?? template 仍是 default），`agent-tool.ts:280-320 createChildSessionImpl` 算 parentRole 透传，`session-config.ts:199` 调 resolveTools；详见 `[P0]tool_policy.md §4.5/§5` |

---

## 2. 变更 KB 一览

| KB | 文件 | 变更摘要 |
|---|---|---|
| **agent/tools** | `[P0]tool_policy.md`（**新增**） | policy schema (TS const) + 5 角色 bound + resolveTools 单方法签名 + 流程伪码 + 4 调用点改造 + subagent mainAllowedTools 流 + 与 RunSpec 字段关系 |
| | `[P0]tool_execution_engine.md §3.1`（修订） | 统一拒绝错误 `tool_not_allowed` code（合并 unknown_tool + notAllowedResult）+ 改造后 engine.execute 拒绝分支伪码 + rejectToolCall helper |
| | `index.md`（修订） | ④ 加原则 5（policy 单源/三层一致/bound=上限）+ 6（统一拒绝 code）；旧原则 5（scope 双层门控）标退役；⑤ 导航加 `tool_policy.md` |
| | `[P1]agent_tools.md §2.2`（修订） | 引 `agent-loop.ts:278` 标 stale（v0.0.40 已拆，v0.0.48 改走 build-deps.ts:204 → resolveTools）；「每次 toolCall 前 derive」订正为「每 run 一次」；标注 v0.0.48 实现路径迁移到 tool-policy.ts |
| | `log.md`（追加） | v0.0.48 条目 |
| **agent/agent_interface_and_loop** | `[P0]forked_reminder.md`（**新增**） | cache 前缀之后注入点 + 不复用 system_reminder_injector + 三态文案模板 + RunSpec 新字段 enableToolWhitelist/toolWhitelist + 不变量（cache 不污染/只 forked 注入/与 resolveTools 读同一对 option/compaction 强制零工具） |
| | `index.md`（修订） | ④ 加原则 11（forked reminder cache 之后注入）；⑤ 导航加 `forked_reminder.md` |
| | `log.md`（追加） | v0.0.48 条目 |
| **squad** | `[P1]data_model.md §1.2/§5`（修订） | Member.tools 标 deprecated/dead；createMemberService 入参 tools 标 accept-and-ignore |
| | `[P1]agent_leader.md §3`（修订） | leader 工具集 = `TOOL_POLICY['studio-leader'].bound`（**15**，加 3 web 工具，research §10.5.4）；v0.0.37 LEADER_DEFAULT_TOOL_NAMES 三层 wiring retire |
| | `[P1]agent_member.md §3`（修订） | mate 工具集 = `TOOL_POLICY['studio-mate'].bound`（**15**，含 agent 工具 — 修 research §8 偏差 #4）；goal ❌ 不在 mate bound |
| | `[P1]session_config_studio.md §3.1`（修订） | tools 取法重写为 static-by-type（不再读 member.tools，改 resolveTools(role) 查 policy） |
| | `log.md`（追加） | v0.0.48 条目 |
| **multi_agent** | `[P1]subagent_derivation.md §4`（修订） | line 169 伪码 resolveTools 引用真实签名（修 research §8 偏差 #3）；scope 字段保留作历史；subAgentConfig.tools = eff.tools（不变） |

---

## 3. 文件级变更清单（产品代码 — planner/coder 依据）

### 3.1 新增文件（2）

| 文件 | 内容 |
|---|---|
| `app/server/src/agent/tool-policy.ts` | `TOOL_POLICY` 常量（5 角色 bound + capByParent）+ `ToolPolicyRole` 类型 + `resolveRole()` + `resolveTools()` 单方法（§3 签名 + §3.2 流程）；单文件 ≤250 行 |
| `app/server/src/agent/forked-reminder-injector.ts` | `injectForkedReminder(input)` 纯函数 + `buildReminderText(input)`（§3 文案模板）；单文件 ≤150 行 |

### 3.2 修改文件（11）

| 文件 | 变更内容 |
|---|---|
| `app/server/src/agent/scope-allowed-tools.ts` | 全文件标 `@deprecated v0.0.48`；`filterToolDefinitionsBySessionType`/`deriveAllowedTools`/`LEADER_DEFAULT_TOOL_NAMES`/`MATE_DEFAULT_TOOL_NAMES` 改 thin re-export from `tool-policy.ts`（保 migrate 期 import 兼容） |
| `app/server/src/agent/tools/engine.ts` | 拒绝分支统一：删 `notAllowedResult`(line 146-158) + `executeOne` unknown_tool 分支(line 88-90)，合并为 `rejectToolCall(call, reason)` helper，产 `[tool_not_allowed]` 文本 |
| `app/server/src/handlers/session-config.ts` | line 199-231 工具分支整段重写为单次 `resolveTools({ role, parentRole, mainAllowedTools: subAgentConfig?.tools })`；删 member.tools ∩ / leader 空 fallback / mate 全集 if/else |
| `app/server/src/agent/agent-loop-call-main.ts` | line 87 删 `filterToolDefinitionsBySessionType` 调用，直接用 RunSpec 入参 `toolDefinitions` |
| `app/server/src/agent/agent-loop-stage-llm.ts` | line 94 同上 |
| `app/server/src/agent/build-deps.ts` | line 204 `deriveAllowedTools` 改为读 resolveTools 产出（与 call-main 同源）；删 scope='subagent' 旧路径 |
| `app/server/src/agent/agent-manager.ts` | `forkedRun`(line 312-323) opts 签名：去 `allowedTools`，加 `enableToolWhitelist: boolean` + `toolWhitelist: string[]` |
| `app/server/src/agent/loop-ports.ts` | `RunSpec` 加 `enableToolWhitelist: boolean` + `toolWhitelist: string[]`（默认 false/[]） |
| `app/server/src/agent/context-port.ts` | `ForkedContextPort` 构造 buffer 时插入 reminder（cache 之后、userMessage 之前） |
| `app/server/src/bootstrap.ts` | line 486-499 compact 调用点：改传 `enableToolWhitelist: true, toolWhitelist: []`（触发零工具 reminder） |
| `app/server/src/agent/tools/agent-tool.ts` | `createChildSessionImpl`(line 280-320) 算 parentRole（parent session.memberId → member.role），透传给 `buildSessionConfigFromDeps` |
| `app/server/src/services/member-service.ts` | hire/PATCH 工具字段处理：忽略 `tools` 参数（accept-and-ignore，warn 不报错） |
| `app/server/src/handlers/member.ts` | line 60,141-156 去 tools 字段（HireBody/PatchMemberBody 不接收 tools；带则 warn） |

### 3.3 UI 删除（S4 — 不在本 tech spec 范围，仅枚举）

| 文件 | 删除内容 |
|---|---|
| `app/web/.../component-hire-modal.tsx` | 删「工具」MultiCheck 区块 |
| `app/web/.../section-member-panel.tsx` | 删「工具管理」section |
| `app/web/.../squad-types.ts` line 179 | 删 `TOOL_OPTIONS` 常量 |

> UI 改动落 `specs/ui/components/`（coder 编码前置产出组件 spec），架构阶段不展开。

---

## 4. 与 PRD/research 对齐核对

- PRD §3.1（policy + resolveTools）→ `[P0]tool_policy.md` 全文
- PRD §3.2（forked 白名单 + reminder）→ `[P0]forked_reminder.md` 全文
- PRD §3.3（统一拒绝错误）→ `[P0]tool_execution_engine.md §3.1`
- PRD §3.4（去 leader/mate tool 可配置）→ squad KB 4 文件修订 + API 11a
- research §10.4 policy 内容 → `[P0]tool_policy.md §2.2`（一字不差对齐）
- research §10.6 forked 三态 → `[P0]forked_reminder.md §5` 三态对照
- research §8 spec↔code 偏差 #1-#4 → 全部修复（agent_tools §2.2 / tools index.md「双层→三层」/ subagent_derivation §4 line 169 / agent_member §3 mate agent）

---

## 5. 验收要点（UT/AT 必须覆盖）

- **policy 单源 UT**：5 角色 bound 数量正确（12/1/15/15/11）+ resolveTools 三 case 分流（顶层/subagent/forked）+ capByParent ∩ 父 bound
- **三层一致 UT**：config/schema/exec 三处产出 `tools`/`toolDefinitions`/`allowedTools` name set 相同（B1/B2 防回归）
- **统一拒绝 UT**：engine.execute 不在 allowedTools 的 toolCall → `[tool_not_allowed] ... not in whitelist`；未注册 toolCall → `[tool_not_allowed] ... not registered`
- **forked reminder UT**：reminder 在 buffer 索引位置（snapshot 之后、userMessage 之前）；三态文案对应 toolWhitelist 内容；cache 前缀（snapshot.system + snapshot.messages）hash 不变
- **AT**：playground-rocky LLM 仅见 12 工具（B1 回归）；强行调 team → 拒绝 code；studio-mate LLM 见 15（含 agent）；studio-subagent ∩ 父 bound（UC-3.1.6/7/8）

---

version: 1.0 `[v0.0.48]`（tool policy 单源 + resolveTools 收敛 + forked 白名单 formal 化 + 去 leader/mate tool 可配置。基于 `specs/research/v0.0.48-tool-system.md §10` 设计定稿；PRD `specs/prd/version_logs/v0.0.48/change_log.md` 行为契约。）
