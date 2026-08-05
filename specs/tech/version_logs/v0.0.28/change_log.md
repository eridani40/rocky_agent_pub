# v0.0.28 Tech Change Log — Multi-Agent 基础设施（parent↔subagent 派生 + a2a + 模板 + scope + subagent UI）

> version: 1.0 · 2026-06-28
> 范围红线（严守）：**只 multi_agent（parent↔subagent 派生 + a2a + 模板 + scope + subagent UI）**。严禁碰 squad/角色/团队层。
> 权威输入：PRD `specs/prd/version_logs/v0.0.28/change_log.md`；概念 spec `specs/tech/multi_agent/` 五件 + `specs/tech/agent/tools/[P1]agent_tools.md` 1.0。
> 实现完成状态：5 task 编码+审查全 pass / UT 2614 pass / AT 7 case 真 LLM 全 pass / ET 2 case 功能层全 pass + BUG-002 视觉保真 known-issue 待用户人工复核。Bug1-4 已修复。

## 1. 概念 spec 优化（architect 阶段产出）

| 文件 | 变更 |
|------|------|
| `specs/tech/multi_agent/overall.md` | 加 v0.0.28 实现完成状态（D8 修订 + scope=EP + 工具归属迁回 + swarm 语义 + 模板存储 + UI + Bug1-4 留痕） |
| `specs/tech/multi_agent/design.md` | §5a 加 6 项 v0.0.28 新决策（D8 修订 / scope=EP / 工具归属迁回 / swarm 语义 / 模板存储 / UI 决策要点）+ **§5a.7 加 Bug1-4 留痕** |
| `specs/tech/multi_agent/[P1]subagent_derivation.md` | 升 1.0（D8 修订 + scope 字段 + 工具归属迁回措辞修正 + swarm 语义 + deliverTo 统一投递 + O1-O6 全落地）；**实现后勘误升 1.0a**：§2 加 subAgentConfig 持久化字段（Bug2 修复） |
| `specs/tech/multi_agent/[P1]subagent_templates.md` | 升 1.0（D8 修订 modelId + 存储定 dev_config + explorer 工具对齐） |
| `specs/tech/multi_agent/[P1]a2a_protocol.md` | 升 0.3（rename a2a_context → a2a_protocol）；**实现后勘误升 0.3a**：§8 边界表加多层引用注（multi_agent 层 agent 工具家族提供 send_message，不依赖 squad_tools） |
| `specs/tech/agent/tools/[P1]agent_tools.md` | 升 1.0（0.1 占位 → 1.0：`agent` 单工具 3 action + scope 工具可见性 + 实现路径 + 工具归属迁回 multi_agent 层）；**实现后勘误**：§3 文件路径修正 `handlers/session-config.ts` + Bug1 修复 inputSchema 补全 |
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md` | 升 5.2：§2 加 deliverTo 接口签名（wrapper 已加 agent-manager-children.ts:deliverTo，旧签名 enqueue/activate 保留兼容，全收敛待后续） |
| `specs/ui/components/chat-page/_overview.md` | v0.0.28 修订摘要：subagent 展开树（三段）+ 只读页面 + tokens --color-indigo；§3 组件清单加 component-subagent-tree；§4.2/§4.2a/§4.3/§8/§7 同步 |
| `specs/ui/components/chat-page/component-subagent-tree.md` | 新增（独立 spec：视觉基线 + Props + testid 三段结构） |

## 2. 实现交付（5 task）

| Task | 模块 | 交付 |
|------|------|------|
| 1 | backend-core | Session schema 4 字段（type/scope/subAgentTemplateType/origin；parentSessionId 复用 v0.0.14 顶层）+ scope-allowed-tools.ts（scope→allowedTools 派生，subagent 排除 agent）+ bootstrap activationStore 连线修复 + buildSessionConfigFromDeps 加 scope + agent-loop allowedTools 过滤 + subagent 403（messages/abort/compact/clear）+ session_meta 5 字段 |
| 2 | backend-agent-tool | agent-tool.ts（spawn/query/abort 3 action）+ spawn/query/abort-action 分模块 + send-message-tool.ts（a2a）+ agent-manager-children.ts（ChildrenTracker + deliverTo + cascadeAbort + 并发上限）+ template-loader.ts（loadTemplate + D8 resolveEffective）+ handlers/session-children.ts（GET /children）+ types（runtime-context/a2a sender.agent）+ message-types |
| 3 | backend-template | template-store.ts（loadTemplate 读 dev_config + makeLoadTemplate + upsertExplorer + EXPLORER 预配）+ dev-config-template-handlers.ts（DELETE 4 情形 + builtin 保护 + group 门控）+ kv-config-service.delete + bootstrap upsert explorer + 注入 loadTemplate 到 agentToolContext |
| 4 | frontend-list | component-subagent-tree.tsx（三段树）+ use-subagent-children.ts（hook）+ section-conv-panel（twisty + 挂载）+ page-chat（GET children + session_meta refresh + onSelectSub 路由 + topSessions 过滤 subagent）+ chat-slice（childrenByParent/activeSubId）+ types（Session 5 字段 + SubagentNode/ChildrenView）+ tokens（--color-indigo light/dark）+ chat-api（listChildren）|
| 5 | frontend-readonly | component-readonly-badge.tsx（chat-readonly-badge）+ section-chat-detail.tsx（readOnly mode：隐藏 chat-input/send/abort/enqueue/compact/clear/chat-model-picker，保留 usage-trigger/messages/readonly-badge）+ page-chat（activeSession.type 透传 sessionType）|

## 3. 真 LLM AT 验证 Bug（design.md §5a.7 留痕）

| Bug | 根因 | 修复 |
|-----|------|------|
| **Bug1**（agent 工具 inputSchema） | spawn/query/abort 三个 action 子对象缺 `properties` 定义，LLM 不知道 task.content 结构 7 轮构造不对 | 补全各 action 子对象 properties schema + runSpawn 入参容错（task 字符串 / content 字符串 / mode 缺失） |
| **Bug2**（subAgentConfig 持久化·最致命） | createChildSessionImpl 只落 session 元信息，eff systemPrompt/tools/skills/maxIter 全丢失→child 用 DEFAULT_SYSTEM_PROMPT + 全集工具 | Session 加 subAgentConfig 字段持久化 effective config；buildSessionConfigFromDeps（handlers/session-config.ts）读它覆盖（6+1 文件） |
| **Bug3**（session modelId 持久化·非 bug，case 修） | POST /session 时没传 modelId（spawn_async_inherit case 设计问题） | **澄清**：POST /session 定 modelId，POST /messages 不回写（session 级配置不变，设计如此）。case 修——POST /session 显式传 modelId |
| **Bug4**（bootstrap parentSessionId 路由） | setBuildAgentToolContext 把 parentSessionId 设成 session 自己 sid → subagent send_message('parent') 投递给自己 | 修：parentSessionId = `session.parentSessionId ?? sessionId`（有 parent 用 parent，无顶层 standalone 用自己兜底）。9 UT 锁定 |

## 4. 与现有子系统的衔接

| 子系统 | 衔接点 |
|--------|--------|
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md` | v5.2：deliverTo wrapper（agent-manager-children.ts）+ children 追踪 Map + abort 级联钩子 + 并发上限；旧签名 enqueue/activate(config) 保留兼容 |
| `specs/tech/agent/session/[P0]session_usage.md §6.2` | sub 递归上报（零改复用）—— parent.usage.sub 聚合所有 child（含 child 的 child） |
| `specs/tech/agent/session/[P0]session_state.md` | child 独立五态机（idle/running/interrupting/interrupted/error）+ activate 三情况（terminated child 可重激活 O3） |
| `specs/tech/agent/tools/[P0]tool_execution_engine.md` | engine.ts:46-73 allowedTools 白名单门控（subagent scope 排除 agent 工具） |
| `specs/tech/config/[P0]ext_impl_scope.md` v0.0.26 | scope 体系（PluginScopeStore/ScopeActivationStore/双重载/CRUD）；本版修 v0.0.26 连线 bug（bootstrap.ts:138 注入 activationStore） |
| `specs/tech/agent/[P0]agent_loop_forked.md` | forked 保持内部（D7，compact/memory），不入 multi_agent LLM 工具集 |

## 5. chat-slice-reducer BUG-fix（subagent 只读页 tool_call 实时显示）

> 编码后发现的渲染真因 BUG，与 coder B 的 `use-subagent-run-refresh.ts`（run 结束刷新 workaround）互补——reducer 修实时 stream 真因，run 结束刷新兜底 headless 极端时序，两者都保留。

**现象**：subagent 只读页（run 后台开始、用户后切过去）切到时，UI 只显示 GET /messages 拿到的前 2 个 tool_call（已落盘），后续 stream 来的 24 个 tool_call part 全部静默丢失。主 agent 不丢（用户始终前台，run 开始即订阅，message_start 收到）。

**真因（代码层确定性）**：`app/web/src/store/chat-slice-reducer.ts` 的 `applyAgentEventToMessages`：
- `text_block_delta` 用 **evt.messageId**（事件自带）锚定 message ✅
- `tool_call_start` / `tool_call_delta` / `tool_call_end` 用 **ctxRef.currentAssistantMessageId** 锚定 ❌

但 `tool_call_*` 事件**自带 messageId 字段**（前端 AgentEvent 类型早有，line 26-28），reducer 没用它，依赖 ctxRef.currentAssistantMessageId（只在 message_start role=assistant 收到时设，line 137-138）。切到进行中的 run 时 message_start 已发完 → ctxRef.currentAssistantMessageId 永远没设 → `if(targetId)` false → tool_call part 静默丢弃。

**根因延伸（spec 层）**：`specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md` §5.4 之前**漏声明 tool_call_* 的 messageId 字段**（只写 blockId/toolCallId/toolName），导致前端实现走了 ctxRef 兜底路径。本版 spec 升 1.4 补声明 + §9 映射表注明锚定规则。

**修复（真因，非 workaround）**：
| 事件 | 修复 |
|------|------|
| `tool_call_start` | targetId = evt.messageId；**兜底**：若 findMsg(evt.messageId) 不存在（错过 message_start），先建 assistant message（id=evt.messageId, role='assistant', content=[]）再 patchMsg 加 tool_call part；同步 ctxRef.currentAssistantMessageId = evt.messageId（兼容后续 delta/end） |
| `tool_call_delta` | rawArgs 缓存 key 是 toolCallId（与 messageId 无关）；ctxRef.current 已由 tool_call_start 兜底设上，沿用 ctxRef 写缓存 |
| `tool_call_end` | patchMsg 用 evt.messageId 锚定（与 start 对齐）；rawArgs 缓存仍读 ctxRef（key=toolCallId） |

**约束兑现**：只改 chat-slice-reducer.ts（+ 类型/注释）；不碰 server、不碰 squad。与 coder B 的 page-chat.tsx + use-subagent-run-refresh.ts 不冲突（互补）。

**验证**：`bun run typecheck` 绿；reducer UT 85 pass 全过（主对话 path B tool_call 渲染无回归）；新增 2 个「错过 message_start」回归 UT（兜底建 message + 多 tool_call 全附加）。

## 6. 待定（非阻断，后续版本）

- **agent_manager deliverTo 全收敛**：v0.0.28 wrapper 已加（agent-manager-children.ts:deliverTo），multi_agent 内部 spawn 首任务 + a2a send_message 已统一走它；旧签名 enqueue/activate(config) 保留兼容（外部既有调用方未改：user 入口 / 心跳激活 / 测试 fixture / forkedRun）。全收敛待后续版本。
- **工具全量 EP impl 化**：每 tool 注册为 EP impl，scope 走 getExtensionImpls 双重载——未来增强（agent_tools §2.2）。本版用 allowedTools 白名单实现 scope。
- **顶层非-squad session 的 type 归属**：TBD，待 squad 层定。
- **squad 层**：完全未实现（leader/member/SquadChat/charter/RoleSpec/团队 budget/team/task/goal 工具等后续版本）。
- **并发上限默认数值**：本版按 O5 三限制（全局主 / 全局 sub / 单主 sub）实现，默认值待用户调优。

## 7. 版本

version: 1.1 `[v0.0.28]`（1.1：补 §5 chat-slice-reducer BUG-fix——subagent 只读页 tool_call 实时显示真因修复（tool_call_* 改用 evt.messageId 锚定 + 错过 message_start 兜底建 message）+ agent_event.md spec 升 1.4 补 tool_call_* messageId 字段声明。1.0：首版 multi_agent tech change_log：①概念 spec 10 文件优化（architect 阶段）；②5 task 编码实现交付（backend-core/backend-agent-tool/backend-template/frontend-list/frontend-readonly）；③真 LLM AT 验证 Bug1-4 留痕（design.md §5a.7）；④与现有子系统衔接（agent_manager v5.2 deliverTo wrapper + session_usage §6.2 + scope 体系 + tool_execution_engine）；⑤待定项（deliverTo 全收敛 / 工具 EP impl 化 / squad 层））。
