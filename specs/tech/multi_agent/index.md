---
type: index
title: Multi-Agent 子系统总起
priority: P1
updated: 2026-08-04
---

# Multi-Agent 子系统总起

## ① 是什么

multi_agent = **一个 agent 如何派生 sub-agent** + **agent 间如何通信（a2a）** 的基础设施，建在 `../agent/` 之上，**不改 AgentLoop 本体**。本子系统只管 parent↔subagent 派生原语；squad/角色/团队层（leader/mate/SquadChat/charter/budget）在 `../squad/`，本目录不展开。

| 核心概念 | 一句话 |
|---|---|
| **sub-agent** | 隔离上下文的派生子 agent（fresh session，只看 parent 给的 task，独立 transcript/usage 落盘；derivation='subagent'） |
| **[v0.0.204] spawn 泛化** | SubAgentTemplate 加 `role?`/`derivation?` 字段，spawn 可拉起非 subagent 形态的 child（trainer = `role:'trainer', derivation:'parent'` 独立身份，非派生；详见 `[P1]subagent_templates.md §4`） |
| **runKind=summary/consolidate（v0.0.204 替代 forked）** | 同 session 的旁路 run（snapshot 可选输入）；forked 概念彻底退役——详见 `../agent/agent_interface_and_loop/` |
| **a2a** | agent↔agent 通信通道（`send_message` + inbox + `deliverTo`），与 user↔agent 通道分离 |
| **AgentRef** | a2a 寻址结构 `{ type, sessionId, name }`；sessionId = 路由权威主键 |
| **工具可见集（v0.0.204 重述）** | 旧 `scope` 字段（v0.0.56 删）+ `TOOL_POLICY` TS 常量（v0.0.204 删）→ 现 `SessionTypePolicy.profile(kind).toolBound` 单源（subagent.bound 不含 agent 工具 → 不可再派生） |
| **deliverTo** | 统一投递入口 `deliverTo(sessionId, msg)` = enqueue + activate（v0.0.31 去 config 重构） |
| **async 回报兜底（系统代发）** | async subagent run 结束（非 tool_pending）时扫本 run 未回的 needReply=true 请求，系统以 child 身份代发回报（成功=final text / 失败=结局通知）；判据 A = `A2aReplyTracker` 出站投递追踪，不依赖 LLM 自觉（`a2a_protocol.md §4.2`） |
| **swarm** | parent 的 children 集合语义（list_children running/terminated 分组 + UI 三段） |
| **template** | 用户可配置的派生蓝图（app_config `sub_agent_templates` 组，预配 explorer + knowledge_learning_trainer；v0.0.204 加 role/derivation 字段） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| sub-agent 派生原语（`agent` 工具 spawn/query/abort action） | AgentLoop 本体 / prompt builder EP（→ `../agent/`） |
| a2a 通信协议（AgentRef + reachable_agents + needReply + 回复规则） | session store 通用 schema / SessionState 五态机（→ `../agent/session/`） |
| [v0.0.56] session 派生字段语义（role/derivation/biz/parentSessionId/subAgentConfig/origin） | session_usage 递归 sub 上报机制（→ `../agent/session/ session_usage §6.2`） |
| sub-agent 模板（结构 + app_config 存储 + explorer + D8 model resolution） | scope 体系通用机制 / config 后端（→ `../config/`） |
| swarm 语义（children 集合 + UI 三段展示） | squad / 角色 / 团队层 / charter / budget（→ `../squad/`） |
| 设计决策日志（D1-D8 + v0.0.28 §5a 增量） | HTTP API 端点（→ `specs/api/`）/ UI 组件（→ `specs/ui/`） |

## ③ 与系统的关系

```
                  ┌── agent/loop           (AgentLoop 本体，零改；eager-drain 复用)
                  │
   multi_agent  ──┼── agent/session        ([v0.0.56] role/derivation/biz 字段 + parentSessionId/subAgentConfig 派生字段)
   (本目录)       │
                  ├── agent/agent_manager  (deliverTo = enqueue+activate，v0.0.31 去 config)
                  │
                  ├── agent/(inbox|event-hub|session-usage)  (inbox enrich / EventHub / 递归 sub 上报)
                  │
                  └── squad/               (v0.0.33.2 复用 a2a：squad clique + 别名解析)
```

**对外协作点**：
- `agent` 工具家族（spawn/query/abort action + send_message）落 `app/server/src/agent/tools/agent-tool.ts` + `spawn-action.ts` + `send-message-tool.ts`。
- 投递 chokepoint 落 `app/server/src/agent/agent-manager.ts.deliverTo()`（v0.0.31 新签名，内部 `resolveConfigBySid` 方案 A 无 cache）。
- list_children 正向索引落 `app/server/src/agent/session-children-index.ts.ChildrenIndex`（v0.0.30，O(children) 替代 O(N) scan）。
- inbox enrich 落 `app/server/src/agent/inbox-enrich.ts`（deliverTo 层反查发送方补 AgentRef + needReply + inReplyTo）。

## ④ 核心设计原则（跨文件不变量）

1. **sub-agent 上下文隔离（D1）**——child 不继承 parent transcript，初始 messages 仅 = `[systemPrompt, task]`；区别于 forked（继承 snapshot）。→ `subagent_derivation.md §1/§2`
2. **spawn = 创建+首任务+模式 三合一（D4）**——一个 `agent` 工具 action 同时创建 child、发首任务（语义等同 send_message）、设 sync/async；sync 阻塞取 final answer，async 立即返 handle。→ `subagent_derivation.md §4`
3. **abort 单向级联（D6）**——parent abort → in-flight child 级联 abort；child 有独立 controller，自身 abort/出错**不反噬** parent（parent 工具拿到 result/error 继续）。→ `subagent_derivation.md §6`
4. **deliverTo 统一投递（v0.0.31）**——`enqueue(sessionId)`/`activate(sessionId)`/`deliverTo(sessionId, msg)` 去 config 新签名；spawn/send_message/重激活/用户消息全走同一 activate，都过并发上限检查。→ `subagent_derivation.md §4.1/§5`
5. **[v0.0.204] profile.toolBound 单源（替代 scope 字段 + TOOL_POLICY）**——subagent 类型 profile.toolBound 不含 agent 工具（不可再派生）；schema 层 toolDefinitions + 执行层 allowedTools 走 `SessionTypePolicy.resolveToolSet` 三层一致产出（详见 `../agent/tools/[P0]tool_policy.md`）。→ `subagent_derivation.md §2` + `a2a_protocol.md §6`
6. **[v0.0.204] spawn 泛化**——SubAgentTemplate 加 `role?`/`derivation?` 字段，spawn 可拉起非 subagent 形态的 child（独立 parent 身份，不挂 parentSessionId，「不可触达/临时/回收」由 profile 字段承载）；典型 subagent 派生仍走 bloodline role + derivation='subagent'。→ `subagent_templates.md §4`
7. **summary/consolidate 旁路 run（v0.0.204 替代 forked 命名）**——同 session 的旁路 run（snapshot 可选输入），不入 LLM 工具集；LLM 工具只有 `agent`（spawn/query/abort）+ `send_message`。→ `design.md §0/§1 D7` + `../agent/agent_interface_and_loop/`
8. **async 回报可靠性 = 代码保证（判据 A）**——subagent 仅可达 parent 的拓扑硬约束（a2a §6）使「child→sender 有无投递」无歧义；`deliverTo` 成功投递后记 `A2aReplyTracker.markDelivery(from→to seq)`，child run 装配快照 baseline epoch，run 收尾 `hasDeliverySince` 判履约、未履约系统以 child 身份代发（needReply=false）——零 transcript 扫描、零 LLM 语义依赖；tool_pending 悬挂轮 stash 跨 run 携带。→ `a2a_protocol.md §4.2` + `subagent_derivation.md §4`「结果送达语义」

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **派生 / 工具** | | |
| `[P1]subagent_derivation.md` | 派生契约：session schema（type/scope/parentSessionId/subAgentConfig）+ `agent` 工具（spawn/query/abort）+ 生命周期 + 并发上限 + abort 级联 + usage + 复用重激活 | [link]([P1]subagent_derivation.md) |
| `[P1]a2a_protocol.md` | a2a 通信协议：AgentRef 寻址 + 别名解析 + reachable_agents + 回复规则（消息从哪来到哪去）+ needReply + scope 校验 | [link]([P1]a2a_protocol.md) |
| `[P1]subagent_templates.md` | sub-agent 模板：结构（含 modelId + v0.0.204 role/derivation spawn 泛化字段）+ D8 model resolution + app_config 存储 + explorer / knowledge_learning_trainer 预配 | [link]([P1]subagent_templates.md) |
| **决策日志** | | |
| `design.md` | 决策日志：D1-D8 全决议 + §5a v0.0.28 增量（D8 二次修订 / scope=EP / 工具归属迁回 / swarm / 模板存储 / 真 LLM AT 避坑点） | [link](design.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
