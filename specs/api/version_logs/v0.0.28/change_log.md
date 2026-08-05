# v0.0.28 API Change Log — Multi-Agent（parent↔subagent 派生 + a2a + 模板 + scope + subagent UI）

> version: 1.0 · 2026-06-28
> 范围红线（严守）：**只 multi_agent（parent↔subagent 派生 + a2a + 模板 + scope + subagent UI）**。严禁碰 squad/角色/团队层。
> 权威输入：PRD `specs/prd/version_logs/v0.0.28/change_log.md`（9 关键路径 + 4 E2E UC + 17 项对齐核对）；概念 spec `specs/tech/multi_agent/` 五件 + `specs/tech/agent/tools/[P1]agent_tools.md` 1.0。
> 主 spec 文件：`specs/api/overall/10-multi-agent.md`（HTTP 主体，300 行）+ `specs/api/overall/10a-multi-agent-tool-ref.md`（LLM 工具 + scope 连线参考，97 行）。

## 1. 新增 API spec 文件

| 文件 | 行数 | 内容 |
|------|------|------|
| `specs/api/overall/10-multi-agent.md` | 300 | Multi-Agent HTTP API 主体——Session schema 增量字段 + children 端点 + subagent 只读会话接口 + 模板 CRUD + 错误码 + AT 映射 + 文件清单 |
| `specs/api/overall/10a-multi-agent-tool-ref.md` | 97 | Multi-Agent 工具引用 + scope 连线（非 HTTP）——agent 工具 schema 权威源 + 与 HTTP children 区分 + scope 工具注册 + agent_manager deliverTo 旧签名问题 |

## 2. 新增/变更 HTTP 接口清单

### 2.1 Session schema 增量字段（变更现有接口响应）

| 接口 | 变更 |
|------|------|
| `GET /session` | 响应 `Session[]` 增 5 optional 字段：`type?/parentSessionId?/scope?/subAgentTemplateType?/origin?` |
| `GET /session/:id` | 同上 |
| SSE `session_meta_update`（topic=session_meta, group=_all） | payload `SessionMetaView` 同步含 5 新字段 |

### 2.2 新增端点

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/session/:id/children` | 列出 parent 派生的 children（running/terminated 分组，UI swarm 树数据源） |
| `DELETE` | `/config/dev` | 删除 dev_config record（仅 sub_agent_templates group；builtin 拒绝 403） |

### 2.3 现有端点语义收窄（subagent session）

| 方法 | 路径 | 对 subagent session 的语义 |
|------|------|---------------------------|
| `POST` | `/session/:id/messages` | 拒绝 user-source（`403 subagent_readonly`）；a2a deliverTo 内部投递不受影响 |
| `POST` | `/session/:id/abort` | 拒绝（403）——abort 仅经 parent agent.abort LLM 工具触发 |
| `POST` | `/session/:id/compact` | 拒绝（403）——subagent 不暴露手动 compact |
| `POST` | `/session/:id/clear` | 拒绝（403）——subagent transcript 不可手动清空 |
| `DELETE` | `/session/:id` | 保留适用（清理 swarm 历史） |
| `PUT` | `/session/:id` | 保留适用（仅 workspaceDir/title 可变） |
| `GET /session/:id` / `:id/messages` / `:id/usage` / `:id/summary` / `POST :id/read` | 完全适用（subagent 是一等 session，复用现有 GET + 标读） |

### 2.4 模板 CRUD（复用 /config/dev group）

| 操作 | 端点 |
|------|------|
| list | `GET /config/dev?group=sub_agent_templates` |
| get | `GET /config/dev?group=sub_agent_templates&key=<name>` |
| create/copy/update | `PUT /config/dev` body `{group, key, data: SubAgentTemplate}`（builtin 拒绝改） |
| delete | `DELETE /config/dev` body `{group, key}`（builtin 拒绝 403） |

## 3. agent 工具（LLM tool call — 非 HTTP，schema 引用）

| 工具 action | 权威源 |
|-------------|--------|
| `agent(action=spawn)` | `[P1]subagent_derivation.md §4`（SpawnAgentInput/Result + 执行流程 + D8 model 解析） |
| `agent(action=query)` | `[P1]subagent_derivation.md §7` + `[P1]agent_tools.md §1` |
| `agent(action=abort)` | `[P1]subagent_derivation.md §6/§7`（D6 单向级联） |

工具注册规则：session scope 注册 agent 工具；subagent scope 不注册（结构不可再派生）。UT 覆盖（PRD 路径 8）。

## 4. PRD 9 路径 → API 覆盖映射

| PRD 路径 | HTTP 验证方式 |
|----------|--------------|
| 路径 1（sync spawn 模板） | agent.spawn LLM 工具触发 → GET /session/:childSid 断言 type/parentSessionId/scope/subAgentTemplateType + GET /usage + GET /parent/children |
| 路径 2（async spawn + inherit） | agent.spawn/send_message LLM 工具 → GET /:childSid + GET /:childSid/messages + GET /parent/children |
| 路径 3（模板带 modelId） | PUT /config/dev 落模板 → agent.spawn LLM 工具 → GET /:childSid 断言 subAgentTemplateType |
| 路径 4（query swarm） | agent.query LLM 工具（与 HTTP children 同源）→ GET /parent/children 验分组/排序/limit |
| 路径 5（abort child） | agent.abort LLM 工具 → GET /:childSid state=interrupted + GET /parent/children 落 terminated |
| 路径 6（UI 展开 swarm） | GET /parent/children + GET /session（ET 主覆盖；AT 验 children 响应结构） |
| 路径 7（UI 只读页） | GET /:childSid + /messages + /usage + POST /read（ET 主覆盖；AT 验 subagent 经现有 GET 可读） |
| 路径 8（scope 结构约束） | UT 白盒（engine 门控）+ HTTP 验 GET /:childSid scope=subagent + POST /:childSid/messages 返 403 |
| 路径 9（模板管理） | 纯 HTTP：GET/PUT/DELETE /config/dev?group=sub_agent_templates 全 CRUD + builtin 403 |

> **关键**：路径 1/2/3/5 核心动作是 LLM tool call（不经 HTTP），AT 验其**副作用**经现有 GET 端点可观测；路径 4/6/7 是 HTTP 数据源；路径 8 主要 UT；路径 9 纯 HTTP。

## 5. 发现的 spec 问题（反馈 orchestrator，待 doc-modifier 阶段 5 同步）

### 5.1 agent_manager.md deliverTo 旧签名（非阻断）

- **问题**：`[P1]subagent_derivation.md §4/§4.1/§5` 引用 `manager.deliverTo(sessionId, msg)`（只需 sessionId），但 `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md` 仍是 `enqueue(config, ...)` / `activate(config)` 旧签名。
- **影响**：spec 内部不一致——multi_agent spec 已对齐 deliverTo 语义，agent_manager.md 待同步重构。
- **处理**：subagent_derivation §4.1 已标「待重构同步」；本版 coder 按 deliverTo 语义实现 wrapper（即便 agent_manager.md 未改）；E2E/AT 黑盒不验内部签名。**doc-modifier 阶段 5 需同步 agent_manager.md**（enqueue/activate 去 config，全调用收敛 deliverTo）。

### 5.2 a2a_protocol §7 引用 squad_tools（边界，非阻断）

- `[P1]a2a_protocol.md §7` 引用 `squad/[P1]squad_tools.md` 的 send_message 入口，但本版 squad 层未实现。
- 本版 PRD 路径 2 的 send_message 走 multi_agent `agent` 工具同层（不依赖 squad_tools），与 a2a_protocol §8 边界表一致。
- doc-modifier 阶段 5 可补注「squad 层未实现时，multi_agent 的 send_message 由 agent 工具家族提供」。

### 5.3 subagent_templates.md §6 引用 app-dev-config-page（待 coder 核对）

- `[P1]subagent_templates.md §6` 边界表引用 `specs/ui/components/app-dev-config-page/`（模板 UI 复用 config 页），该目录 spec 存在性待 coder 实现时核对。
- 本版 API spec 不发明新页面，复用既有 dev-config-page（PUT/GET/DELETE /config/dev 即可）。

## 6. 版本

version: 1.0 `[v0.0.28]`（首版 multi_agent API change_log：①新增 `10-multi-agent.md` HTTP 主体 + `10a-multi-agent-tool-ref.md` 工具/scope 参考；②Session schema 增 5 字段 + 新增 GET /session/:id/children + DELETE /config/dev + subagent 写端点 403 收窄 + 模板 CRUD 复用 /config/dev；③PRD 9 路径 → API 映射；④3 项 spec 问题反馈待 doc-modifier 同步）。
version: 1.0a `[v0.0.28 doc-modifier 阶段5同步]`：①§5.1 agent_manager.md deliverTo 旧签名已同步——agent_manager.md §2 加 v5.2 标注（wrapper 已加 agent-manager-children.ts:deliverTo，旧签名保留兼容，全收敛待后续）；②§5.2 a2a_protocol §7 多层引用注已加（§8 边界表补 send_message 多层复用澄清——multi_agent 层 agent 工具家族提供 send_message，不依赖 squad_tools）；③spec_clarifications[0/1/2] 落 `10-multi-agent.md` v1.0a——§2 Session 显式列 modelId + §4.0a GET /usage usage.sub 结构 + §4.1 a2a 消息 sender.source='agent' 标记；④文件路径勘误 buildSessionConfigFromDeps 实际在 `handlers/session-config.ts`（落 `[P1]agent_tools.md §3` + `[P1]subagent_derivation.md §4`）；⑤Bug2 修复 subAgentConfig 持久化字段落 `[P1]subagent_derivation.md §2`（createChildSession 落 effective config，buildSessionConfigFromDeps 读它覆盖）。
