---
type: index
title: Agent 子系统总起（顶层导航）
priority: P0
updated: 2026-06-30
---

# Agent 子系统总起（顶层导航）

## ① 是什么

agent 子系统 = **LLM agent 执行的完整运行时**——从统一契约（v0.0.40 单 `run(spec)` + RunSpec + AgentRun）到统一 ReAct 骨架（`runReActLoop` + 4 port 注入：current/forked 共用一份）、门面管理（AgentManager）、消息/事件类型、LLM 调用编排、上下文/记忆/技能/工具、session 持久化与可观测性。本目录是顶层导航，每个子目录各是一个 OKF KB（自有 `index.md` 总起）。

| 核心概念 | 一句话 |
|---|---|
| **Agent interface** | v0.0.40 单 run 契约：只有 `run(spec: RunSpec) → AgentRun`（删 enqueue/cancel/activate，无 abort）（→ `agent_interface_and_loop/`） |
| **Unified Skeleton** | v0.0.40 `runReActLoop(spec)`：current/forked 共用一份骨架，mode 差异全在 4 port 装配（→ `agent_interface_and_loop/agent_loop_unified.md`） |
| **AgentManager** | session 级门面（路由 + 句柄 + abort 收尾 + subscribe + `run(spec)` 唯一 loop 入口）（→ `agent_interface_and_loop/`） |
| **Message / AgentEvent** | 业务消息类型 + agent 执行流式事件（→ `message/` + `agent_interface_and_loop/agent_event.md`） |
| **ContextEngine** | snapshot/ingest/assemble/compact 上下文生命周期（v0.0.40 源/汇可注入 + compact 触发 plugin 化）（→ `context/`） |
| **LlmCaller** | LLM 调用编排（错误归一化/retry/超时/length）（→ `llm_caller/`） |
| **Session** | 五态机 + SessionStore + usage + workspace（→ `session/`） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| agent 执行运行时（unified loop/manager/mode 不变量/中断/入队/事件） | squad 自主协作单元（→ `../squad/`） |
| message/event/llm/context/memory/skills/tools/session/observability 类型与机制 | multi_agent 派生基础设施（→ `../multi_agent/`） |
| providers_and_models 接入（provider/protocol/model/client 四件套） | HTTP API 端点（→ `../../../specs/api/overall/`）/ UI 组件（→ `../../../specs/ui/`） |
|  | persistence CrudStore FS engine / sharding（→ `../persistence/`） |

## ③ 与系统的关系

```
   agent/ (本目录)
   ├── agent_interface_and_loop/  ← 执行核心：Agent contract（单 run）+ unified skeleton + scope router + manager + 中断 + 事件
   ├── message/                   ← 业务消息类型（Message/ContentBlock/MessageSender）
   ├── event/                     ← 通用 pub-sub 底座（EventBus + EventHub）
   ├── context/                   ← ContextEngine（snapshot/ingest/assemble/compact；v0.0.40 源/汇可注入 + compact EP）
   ├── llm_caller/                ← LLM 调用编排（错误归一化/retry/超时/length）
   ├── providers_and_models/      ← provider/protocol/model/client 四件套接入
   ├── session/                   ← 五态机 + SessionStore + usage + workspace
   ├── memory/                    ← 记忆子系统（注入 + 整理 + 管理工具）
   ├── skills/                    ← 技能定义与加载
   ├── tools/                     ← 工具执行引擎 + 工具集（bash/file/web/browser/task）
   └── observability/             ← 埋点（langfuse adapter + manager）

   上下游：squad/（自主协作，消费 agent loop）/ multi_agent/（subagent 派生 + a2a）/ persistence/（CrudStore）
```

## ④ 核心设计原则（跨 KB 不变量）

1. **AgentLoop 本体零改，差异落 SessionConfig**——studio 4 scope（standalone/leader/mate/subagent）共用单一 loop，差异由 config + mapper + 工具 + a2a 校验消化。→ `agent_interface_and_loop/` + `../squad/session_config_studio.md`
2. **中断唯一入口 AgentManager.abort**——Agent interface 无 abort 方法；AgentRun 不暴露 controller；loop 被中断只退出不收尾。→ `agent_interface_and_loop/agent_interrupt.md`
3. **API + SSE 不漏契约**——GET(全量持久化) ∪ SSE replay(半截) ∪ stream(增量)，按 messageId merge。→ `agent_interface_and_loop/agent_event.md §10`
4. **message 是业务层权威，protocol-types 是协议层翻译**——两者分工，字段名对齐 message spec。→ `message/agent_message_interface.md`
5. **event 基础设施不感知业务**——topic/group 通用字符串，bus 实例 per-topic。→ `event/`

## ⑤ 本目录导航（子 KB）

| 子 KB | 管什么（一句话） | index |
|---|---|---|
| `agent_interface_and_loop/` | Agent contract（v0.0.40 单 run）+ unified skeleton + scope router + AgentManager 门面 + 中断/入队/事件 | [index](agent_interface_and_loop/index.md) |
| `message/` | 业务消息类型（Message/ContentBlock/MessageSender 判别联合） | [index](message/index.md) |
| `event/` | 通用 pub-sub 底座（EventBus transport + EventHub 路由） | [index](event/index.md) |
| `context/` | ContextEngine（snapshot/ingest/assemble/compact + system_prompt/reminder EP） | [index](context/index.md) |
| `llm_caller/` | LLM 调用编排（错误归一化/retry/超时/length/provider health） | [index](llm_caller/index.md) |
| `providers_and_models/` | provider/protocol/model/client 四件套接入 + anthropic 实现 | [index](providers_and_models/index.md) |
| `session/` | 五态机 + SessionStore + usage + workspace + event + clear | [index](session/index.md) |
| `memory/` | 记忆子系统（定义 + 注入 + 整理 tier1/tier2 + 管理工具） | [index](memory/index.md) |
| `skills/` | 技能定义（架构 + definition + skill_tool + overview） | [index](skills/index.md) |
| `tools/` | 工具执行引擎 + 工具集（bash/file/web/browser/task/agent） | [index](tools/index.md) |
| `observability/` | 埋点（observability manager + langfuse adapter） | [index](observability/index.md) |

> 各子 KB 自有 `log.md`（位置轴）；跨版本发布说明见 `../version_logs/vX.Y/change_log.md`。
