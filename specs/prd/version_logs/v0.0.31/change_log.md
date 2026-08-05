# v0.0.31 PRD 变更日志 — a2a 协议对齐（inbox 中枢 + AgentRef 上下文兑现）

## 概述

本版本交付 **a2a 通信协议的上下文兑现**：让 inbox 成为 a2a 上下文中枢，使 AgentRef（type/name）从「写满零消费的死数据」变为「prompt 渲染 + LLM 决策依据」的活字段；needReply 合同接收方能读到、prompt builder 能渲染；`deliverTo` 彻底脱离 config，user POST 入口收敛；MessageSource enum 对齐 spec；inbox 补 `enqueuedAt`。

**严守范围红线**：**只 multi_agent a2a 协议对齐**（parent↔subagent 场景）。**严禁碰 squad 层**（leader/member/SquadChat 未实现）；不引入跨 squad 寻址；heartbeat/cron/reminder 仅做 enum 对齐（投递逻辑后续版本）。

技术方案细节（inbox 入口 enrich 反查机制、sender 判别联合具体 TypeScript 表达、deliverTo 去 config 的 agent_manager 重构）由 architect 落 `specs/tech/`，本 PRD 只描述诉求 + 引用已有概念。

权威输入：`reqs/v0.0.31/req2.md`；概念权威源：见 §5 对齐确认。

---

## 1. 问题陈述（现状）

v0.0.28 已交付 multi_agent 基础设施（parent↔subagent 派生 + a2a 投递通路 + deliverTo wrapper），但盘点发现 **a2a 上下文未兑现**——AgentRef.type/name 被写满进 `sender.agent.ref`，但下游零消费：

| 现状缺陷 | 代码定位 | spec 已设计的理想态 |
|----------|---------|---------------------|
| **drain consumer 只读 `sender.source`**，丢弃 `sender.agent`（type/name/needReply/inReplyTo 全丢） | `agent-loop-stage-pre.ts:74` | a2a_protocol §4.1/§4.2：接收方按 `sender.source='agent'` + `needReply` 决定回复策略 |
| **prompt builder 零渲染 a2a 信封** | prompt builder section 未注册 `inbox_from_marker` | a2a_protocol §5：`[Message from <name> (<type>, needReply=<bool>)]: <content>` |
| **needReply 合同无能力监督**：发送方填 needReply=true 期望对方回，但接收方 prompt 里看不到 needReply | drain 丢字段 | a2a_protocol §4.2：needReply 接收方应「必回（即便简短 ack）」 |
| **`deliverTo` 内部仍碰 config**（`resolveConfig` + 旧 `enqueue(config)/activate(config)`） | agent_manager 实现 | subagent_derivation §4.1：deliverTo 不取不传 config |
| **user POST `/messages` 裸 `enqueue(config)+activate(config)`**，未收敛 deliverTo | user POST handler | subagent_derivation §4.1：所有「给 session 发消息」收敛 deliverTo |
| **MessageSource enum 落后 spec**：代码 `'scheduled'`，spec 已改 `'system'`（含 heartbeat/cron/reminder） | `message/types.ts` | agent_message_interface §5：`MessageSource = "user" \| "agent" \| "approval" \| "system"` |
| **user POST sender 扁平残留** `agentName/agentId` | user POST handler | agent_message_interface §5 历史注：已替换为子结构 `agent:{ref,inReplyTo,needReply}` |
| **inbox 缺 `enqueuedAt` 字段** | inbox 实现 | agent_inbox_enqueue §2：`InboxEntry` 含 `enqueuedAt: string` |

**用户感知**：subagent 收到 a2a 消息时只当普通 user 消息——看不到「这是 parent 发的、需要回复」，无法区分「fyi 通知」与「提问需回」，prompt 里也没有「这是谁发的、什么角色」上下文。needReply 形同虚设。

---

## 2. 设计原则（用户拍板，源自 req2.md §3）

1. **路由权威 = sessionId**：`deliverTo` / 别名解析永远靠 sessionId 路由，type/name 不参与路由。**不变**（与 a2a_protocol §2 / subagent_derivation §4.1 一致）。
2. **inbox = a2a 上下文中枢**：入口 enrich（normalize 补全完整 a2a 形态），出口消费（drain 透传 + prompt builder 渲染前缀）。
3. **enrich 责任在 inbox 入口（deliverTo 层）**，不在调用方。调用方可只传 sessionId，系统反查兜底补 type/name/needReply。
4. **调用方传 AgentRef = 防幻觉契约**：调用方传了 type/name → 入口用反查结果校验，不一致 warn（不阻塞投递）；没传 → 反查补全。

---

## 3. 功能范围

### 3.1 IN SCOPE（6 项，本轮全做）

| 编号 | 功能 | 描述 | 优先级 | 权威概念 spec |
|------|------|------|--------|---------------|
| **A** | **inbox 入口 enrich（核心）** | deliverTo 内、enqueue 前，对 `source='agent'` 的 message 补全：①`sender.agent.ref`（type/name 反查发送方 session record）；②`needReply`（必填，缺失按场景默认：spawn async 首任务=true、send_message 提问=true、fyi=false）；③`inReplyTo`（thread）。调用方传了 type/name 则校验 warn 不一致。 | P0 | a2a_protocol §2/§4.2 + agent_message_interface §5 |
| **B** | **user POST `/messages` 收敛 deliverTo** | 替换裸 `enqueue(config)+activate(config)` → `manager.deliverTo(sessionId, msg)`。 | P0 | subagent_derivation §4.1 |
| **C** | **enqueue/activate 去 config** | `enqueue(sessionId)/activate(sessionId)` 新签名（manager 按 sessionId 持有 config）。改所有调用方（user POST / deliverTo 内部 / 测试 fixture）。**deliverTo 不再 resolveConfig**。agent_manager 大重构。 | P0 | subagent_derivation §4.1 + agent_manager §3 |
| **D** | **MessageSource enum 对齐** | 代码 `'scheduled'` → `'system'`（含 heartbeat/cron/reminder）。同步 agent_event §4.3 行为表 + emit message_enqueued 处硬编码改 `'system'`。 | P1 | agent_message_interface §5 + §历史注 |
| **E** | **sender 判别联合 + 清扁平残留** | `MessageSender` 改 discriminated union（按 `source` 分流）：`source='agent'` → `{source, agent:{ref,needReply,inReplyTo?}}`；`source='user'` → `{source:'user'}`（无 agent 字段）；`source='system'` → `{source, system:{kind,refId?}}`；`source='approval'` → `{source, approval:{...}}`。清 user POST 的扁平 `agentName/agentId`。**needReply / sender.agent = source='agent'（a2a）专属**。 | P0 | agent_message_interface §5 + req2.md §4 表 |
| **F** | **inbox 补 `enqueuedAt` 字段** | `InboxEntry`（kind=message / kind=cancel）均补 `enqueuedAt: string`（isoDate，append 时注入）。 | P1 | agent_inbox_enqueue §2 |

### 3.2 OUT OF SCOPE（NON-GOALS）

| 排除项 | 理由 |
|--------|------|
| **squad 层 a2a 复用**（leader/member/SquadChat） | squad 未实现（v0.0.28 红线延续）；本版仅 multi_agent parent↔subagent |
| **跨 squad 寻址**（squadId 前缀） | a2a 拓扑硬约束（subagent 仅可达 parent） |
| **heartbeat/cron/reminder 入口的实际投递实现** | 仅 enum 对齐（D 项）；触发逻辑后续版本 |
| **drain consumer 重写**（仍读 `sender.source` 做分流） | drain 分流逻辑不变；本版补的是「drain 透传 sender.agent 给 prompt builder」（出口侧渲染），非 drain 内核重写 |
| **prompt builder section 体系重构** | 仅新增/激活 `inbox_from_marker` section（a2a 消息渲染前缀），不动 v0.0.22 section 框架 |

---

## 4. name 规则（enrich 反查补全时）

enrich 反查发送方 session record 补 name 时（req2.md §5）：

| 发送方 session.type | name 取值 | 示例 |
|---------------------|----------|------|
| `subagent` | `subAgentTemplateType` | `"explorer"` |
| parent / 顶层 standalone | `session.title`；无标题 → `"parent"` | `"探查代码任务"` / `"parent"` |

**约束**：
- name = 渲染用人类可读字段，**不参与路由**（路由只靠 sessionId）。
- **不要求全局唯一**（唯一性靠 sessionId）。
- **不取 sessionId 片段**（如 `01K...` 前缀）——name 必须是人类可读语义。

> 与 a2a_protocol §2（name = 人类可读名）一致；squad 层将来补「RoleSpec.name squad 内唯一」约束（本版不涉及）。

---

## 5. 关键用户路径（MANDATORY — = 测试最低覆盖要求）

每条路径至少一个 API 或 E2E case。verifier 不得低于此覆盖。无 mock（遵循 memory `no-mock-api-e2e-tests`：真 LLM + 真服务，agent 实际写数据并查真落库）。

| 路径 | 链路 | 涉及功能 | 最低 case |
|------|------|---------|----------|
| **路径 1【async spawn 回报渲染】** | parent spawn explorer(async) → explorer 完成 → `send_message(to=parent, needReply=false)` 回报 → parent drain 透传 sender.agent → prompt builder 渲染 `[Message from explorer (subagent, needReply=false)]: <内容>` → parent LLM 看见「explorer 回报、无需回复」 | A（入口 enrich 兜底 needReply）+ E（sender.agent 子结构）+ drain 透传 + prompt 渲染 | AT（async_spawn_reply_render） |
| **路径 2【sync spawn 取 answer】** | parent spawn explorer(sync) → 首任务 needReply=false（系统硬填）→ explorer 不 send_message 回 → parent `await run.promise` + `getFinalAnswer(childSid)` 取 answer | A（needReply=false 系统硬填）+ spawn sync 路径 | AT（sync_spawn_answer） |
| **路径 3【a2a 提问 + 回复】** | parent `send_message` 给运行中 child(needReply=true) → child drain 渲染 `[Message from <parent title> (session, needReply=true)]` → child LLM 看见「parent 提问、必须回」→ child `send_message(to=parent)` 回 | A（needReply=true 透传）+ E + drain 透传 + prompt 渲染 | AT（a2a_ask_reply） |
| **路径 4【user 入口收敛】** | user POST `/messages` → 经 `deliverTo`（去 config）→ drain 渲染 `[User]: <内容>`（**无 needReply**，sender.source='user' 判别联合无 agent 字段）→ agent 在当前 session 出 final text 回 | B（user POST 收敛）+ C（去 config）+ E（user sender 无 needReply） | AT（user_post_via_deliverto） |

---

## 6. E2E Use Cases（功能性，无视觉设计稿）

> 本版本**无设计稿**（reqs/v0.0.31/ 只有 req2.md），视觉保真度比对项**跳过**（CLAUDE.md 原则 15：「无设计稿时本原则跳过」）。E2E 覆盖 = 功能性断言（prompt 渲染内容 + 落库校验），不做视觉 compare。

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-31.1 | parent session 跑中 → LLM 调 `agent(spawn, templateRef=explorer, mode=async)` → 等 subagent 跑完 → subagent `send_message(to=parent, needReply=false)` 回报 → 查 parent session 的 prompt assemble snapshot（或 trace） | parent 下一轮 assemble 的 user part 含 `[Message from explorer (subagent, needReply=false)]:` 前缀；sender.source='agent' / sender.agent.ref.type='subagent' / ref.name='explorer' / needReply=false 落库 |
| UC-31.2 | parent session → LLM 调 `agent(spawn, mode=sync)` → 阻塞等 → 查 subagent session 首任务 message | 首任务 sender.agent.needReply=false（系统硬填）；subagent 全程不 send_message 回；parent 通过 `getFinalAnswer` 拿到 answer |
| UC-31.3 | parent session 跑中 → LLM 调 `send_message(to=child, needReply=true)` → 等 child drain → 查 child session 的 prompt assemble snapshot | child 下一轮 assemble 含 `[Message from <parent title> (session, needReply=true)]:` 前缀；sender.agent.ref.type='session'（parent 是顶层 standalone）；child 后续 `send_message(to=parent)` 回 |
| UC-31.4 | user 在某 session UI 打字 → POST `/messages` → 查后端 trace | user message 经 `deliverTo(sessionId, msg)` 入队（不走裸 enqueue+activate）；sender = `{source:'user'}`（无 agent/needReply 字段）；下一轮 assemble 含 `[User]:` 前缀 |

---

## 7. 验收标准（每条用户路径的验收点）

| 路径 | 验收点 |
|------|--------|
| 路径 1 | ①parent prompt 渲染含 `[Message from explorer (subagent, needReply=false)]:`；②sender.agent.ref 落库 type='subagent'/name='explorer'；③needReply=false 落库 + 透传到 prompt；④subagent 不被强制回复 |
| 路径 2 | ①首任务 sender.agent.needReply=false；②subagent 全程不调 send_message；③parent `getFinalAnswer` 取到非空 answer |
| 路径 3 | ①child prompt 渲染含 `[Message from <parent title> (session, needReply=true)]:`；②sender.agent.ref.type='session'（parent standalone）；③needReply=true 透传；④child 后续 send_message 回（trace 可见） |
| 路径 4 | ①POST `/messages` 内部调 `deliverTo`（trace 不见裸 enqueue+activate）；②sender = `{source:'user'}` 无 agent 字段（判别联合）；③assemble 含 `[User]:` 前缀无 needReply；④agent 在当前 session 出 final text 回（不调 send_message） |

**全局验收点**：
- `MessageSource` enum 全代码无 `'scheduled'`，emit message_enqueued 处用 `'system'`。
- `InboxEntry` 落库条目均含 `enqueuedAt`（isoDate）。
- `enqueue/activate` 签名 `(sessionId, ...)`，无 config 参数；`deliverTo` 内部不调 resolveConfig。
- user POST 无扁平 `agentName/agentId` 残留。

---

## 8. PRD ↔ 概念 spec 对齐确认（MANDATORY）

逐条引用概念 spec，声明 PRD 与之**无矛盾**——PRD 是概念的产品化表达，新概念只引用 + 描述诉求，详细技术定义留给 architect 落 tech spec。

| PRD 概念 | 概念 spec 权威源 | 对齐确认 |
|----------|------------------|---------|
| AgentRef `{type, sessionId, name}`（type 不含 user；sessionId 路由权威；name 渲染用人类可读） | `[P1]a2a_protocol.md §2` | ✅ 一致——PRD §2 原则 1 + §4 name 规则引用同结构；不发明 user type |
| 回复规则（source='agent' → send_message 回；其他 → session 内 final text） | `[P1]a2a_protocol.md §4.1` | ✅ 一致——PRD 路径 4 user 入口出 final text 回（非 send_message）映射同规则 |
| needReply 语义（spawn sync 首任务系统硬填 false；async 默认 true；send_message LLM 必填） | `[P1]a2a_protocol.md §4.2` + `[P1]subagent_derivation.md §4`（sync=保证送达，needReply=false 避免双重投递） | ✅ 一致——PRD §3.1-A enrich 默认值表 + 路径 2 sync 硬填 false 映射 |
| prompt 渲染前缀 `[Message from <name> (<type>, needReply=<bool>)]:` / `[User]:` | `[P1]a2a_protocol.md §5`（消息归属 sender.source 分流表） | ✅ 一致——PRD 路径 1/3/4 验收点引用同前缀格式 |
| MessageSender 子结构（source='agent' → agent:{ref,inReplyTo,needReply}） | `agent/message/[P0]agent_message_interface.md §5` | ✅ 一致——PRD §3.1-E 判别联合引用同子结构；本版仅落实 spec 已声明的「待代码同步」 |
| MessageSource enum（`'user'\|'agent'\|'approval'\|'system'`，scheduled 并入 system） | `agent/message/[P0]agent_message_interface.md §5`（含「待代码同步」注） | ✅ 一致——PRD §3.1-D 引用同 enum；spec 自标代码落后，本版补齐 |
| InboxEntry `{enqueueId, kind, message/cancelFor, enqueuedAt}` | `agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §2` | ✅ 一致——PRD §3.1-F 引用同类型；spec 已含 enqueuedAt，代码落后本版补 |
| `deliverTo(sessionId, msg)` 不碰 config / 不取不传 config / 统一收敛入口 | `[P1]subagent_derivation.md §4.1` + `[P0]agent_manager.md §3`（自标重构方向） | ✅ 一致——PRD §3.1-B/C 引用同契约；spec 自标「待重构同步」，本版执行 |
| inbox = a2a 上下文中枢（入口 enrich + 出口 drain 透传 + prompt 渲染） | req2.md §3 设计原则 2（用户拍板） | ⚠️ **新概念**——spec 未单独立稿；PRD 仅描述诉求（§2 原则 2 + §3.1-A），详细 enrich 反查机制由 architect 落 `specs/tech/agent/agent_interface_and_loop/` 新增/补充 spec |
| sender 判别联合（needReply = source='agent' 专属，user/system/approval 无此字段） | req2.md §4 表 + `agent_message_interface §5`（已子结构化但非严格判别联合） | ⚠️ **概念增强**——spec 现状是「子结构 optional」，PRD 诉求是「判别联合（按 source 分流，needReply 是 agent 专属必填）」；PRD 引用现有 sender 子结构 + 描述诉求，由 architect 决定 TypeScript 判别联合具体表达 |
| 调用方传 ref = 防幻觉契约（传了校验 warn，没传反查补全） | req2.md §3 设计原则 4（用户拍板） | ⚠️ **新概念**——spec 未单独立稿；PRD 仅描述诉求（§2 原则 4），详细校验/warn 机制由 architect 落 tech spec |

> **新概念标注（交 architect 落 tech spec 后 PRD 才能转用户确认）**：
> 1. **inbox 入口 enrich 机制**——deliverTo 层反查发送方 session record 补 type/name + needReply 默认值 + ref 校验 warn 的具体实现。概念诉求在 PRD §2 原则 2/3/4 + §3.1-A；技术定义待 `specs/tech/agent/agent_interface_and_loop/` 补 enrich spec。
> 2. **sender 判别联合的 TypeScript 表达**——按 source 分流，needReply 是 source='agent' 专属必填。概念诉求在 PRD §3.1-E + req2.md §4 表；技术定义待 architect 在 `agent_message_interface §5` 落判别联合 schema。
> 3. **deliverTo 去 config 的 agent_manager 重构**——`enqueue(sessionId)/activate(sessionId)` 新签名 + 改所有调用方。概念诉求在 PRD §3.1-C；技术定义待 architect 同步 `[P0]agent_manager.md` §3/§5（spec 自标「待重构同步」）。

> **无矛盾确认**：PRD 引用的所有已有概念（AgentRef / 回复规则 / needReply 语义 / 渲染前缀 / MessageSender 子结构 / MessageSource enum / InboxEntry / deliverTo 契约）与对应 spec **完全一致**；3 个新概念（enrich 机制 / 判别联合 / 去 config 重构）PRD 只描述诉求不发明实现，待 architect 落 tech spec 后回链核对。

---

## 9. 不覆盖项及理由

| 不覆盖项 | 理由 |
|----------|------|
| **E2E 不覆盖 squad 层 a2a** | squad 未实现（范围红线） |
| **E2E 不覆盖跨 squad 寻址** | 拓扑硬约束（subagent 仅可达 parent） |
| **E2E 不覆盖 heartbeat/cron/reminder 投递逻辑** | 仅 enum 对齐（D 项），触发逻辑后续版本 |
| **视觉保真度 compare 跳过** | 本版本无设计稿（reqs/v0.0.31/ 仅 req2.md），按 CLAUDE.md 原则 15 跳过 |
| **UT 覆盖 enrich 反查 + sender 判别联合类型层** | 白盒，coder 单测（路径 1/3 enrich 落库 + 类型守卫） |
| **AT 不覆盖 prompt builder section 注册内部实现** | AT 黑盒只验 assemble 出来的 prompt 含渲染前缀（落库 message + assemble snapshot），不验 section 注册机制 |

---

## 10. 版本

v0.0.31（a2a 协议对齐：inbox 中枢 + AgentRef 上下文兑现。**严守范围红线：只 multi_agent a2a，不碰 squad**。功能 6 项：A inbox 入口 enrich（deliverTo 层补 sender.agent.ref type/name 反查 + needReply 默认 + inReplyTo + ref 校验 warn）；B user POST `/messages` 收敛 deliverTo；C enqueue/activate 去 config（agent_manager 重构，deliverTo 不 resolveConfig）；D MessageSource enum 对齐（'scheduled' → 'system'）；E sender 判别联合（按 source 分流，needReply = source='agent' 专属）+ 清扁平 agentName/agentId；F inbox 补 enqueuedAt。关键用户路径 4 条：async spawn 回报渲染 / sync spawn 取 answer / a2a 提问+回复 / user 入口收敛。无设计稿，视觉保真度比对跳过。权威输入 `reqs/v0.0.31/req2.md`；概念权威源 `[P1]a2a_protocol.md` 0.3 + `[P0]agent_inbox_enqueue.md` 2.1 + `agent/message/[P0]agent_message_interface.md §5` + `[P0]agent_manager.md` §3 + `[P1]subagent_derivation.md §4.1`。新概念（enrich 机制 / 判别联合 TS 表达 / 去 config 重构）PRD 仅描述诉求，详细 tech 定义交 architect）。
