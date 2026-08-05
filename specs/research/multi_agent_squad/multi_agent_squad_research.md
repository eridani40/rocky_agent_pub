# 多 Agent 协作 + 团队编队（multi-agent / squad）调研报告

> 本文件是 multi_agent + squad 调研报告。完整报告见本目录。
>
> - **调研范围**：在现有单 agent 体系（Agent interface + 三 mode + AgentManager + inbox/event/interrupt）之上，如何加「多 agent 协作 + 团队/编队」这一层。
> - **调研对象**：`refs/agentscope_message_event_agent.md`（外部唯一多 agent 参考）+ `specs/tech/agent/**`（本项目基线）。
> - **调研日期**：2026-06-27
> - **性质**：纯调研，仅给观察与建议，不下定论。

---

## 0. TL;DR（给 orchestrator 速读）

1. **AgentScope 文档本质是「单 agent ReAct 框架 + 一套跨 agent 消息/事件契约」**，并没有真正定义"团队/编队/拓扑"——它只定义了 agent 之间互通的"信封格式"（Msg/Event）和 agent 自身的 ReAct 循环 + 状态外置（§1）。多 agent 拓扑（pipeline/graph/supervisor/swarm）是**上层编排**，AgentScope 文档未覆盖。
2. **本项目单 agent 体系已远超 AgentScope 描述的能力**：已有 AgentManager（门面 + 状态持有者）、三 mode（eager/lazy/forked）、inbox/enqueue/cancel、4 步 abort 收尾、五态机、EventHub 多 topic/group 路由。多 agent 这一层**不是从零搭**，而是在这些机制上做"编队 + 编排"。
3. **可直接复用的 3 块**：① `EventHub(topic, group)` 已是通用消息总线（`specs/tech/agent/event/[P0]event_hub.md`），多 agent 通信不必另起 bus；② `sideRun`（`agent_manager.md §2.1/§3.2`）已是天然的"子 agent 旁路执行"单元；③ `enqueue + activate + subscribe`（`agent_manager.md §2/§7`）已是 agent 间"发消息 + 驱动 + 观测"的现成组合。
4. **需要新建的 2 块**（即两个 spec 目录的主题）：① **squad 定义**——如何声明式地把多个 agent 组织成一个有边界/有身份的编队（拓扑、角色、终止条件）；② **squad 编排**——谁驱动流转、turn-taking、并发、错误传播。

---

## 1. AgentScope 架构提炼

### 1.1 Agent 的定义与身份（AgentScope 侧）

AgentScope 的 `Agent` 接口（`refs/agentscope_message_event_agent.md §3.1`）只暴露 4 个方法：`reply / reply_stream / observe / compress_context`。身份与能力**全部塞进 `AgentConfig`**（§3.2）：

| 维度 | AgentScope 字段 | 说明 |
|------|-----------------|------|
| 身份 | `name: string`（必填） | Agent 标识，**无显式 id 字段**——`name` 即身份，也用作 Msg.sender |
| 模型 | `model: ChatModelBase`（必填） | 推理 LLM |
| 系统提示 | `system_prompt: string`（必填） | 基础人设 |
| 工具 | `toolkit?: Toolkit` | 工具 + MCP + 技能统一管 |
| 状态 | `state?: AgentState`（外置） | 上下文 / 权限 / 会话（§3.6） |
| 压缩 | `offloader?` + `context_config` | 自动压缩 + 工具结果卸载 |
| 钩子 | `middlewares?: MiddlewareBase[]` | reply/reasoning/acting/model_call/system_prompt 多层拦截 |
| 重试 | `model_config` | 重试 + fallback 模型 |
| 迭代上限 | `react_config` | 最大推理-行动迭代数 |

关键点（§3.6 + §四）：AgentScope 把 Agent 设计成**「无状态执行器」**——状态全部外置到可序列化的 `AgentState`（context / compression_summary / permission_rules / tool_state / reply_position），存储键是 `(user_id, agent_id, session_id)` 三元组。

### 1.2 编排与通信（AgentScope 侧）

AgentScope 文档**只定义了通信契约，不定义编排**：

- **通信单元 = `Msg`**（§一）：`id / name / role / content[] / metadata / created_at / finished_at / usage`。role 限 `user|assistant|system`，content block 按角色受限（§1.3）。
- **流式单元 = `Event`**（§二）：每事件带 `reply_id`（关联 Msg）；block 遵循 `start→delta*→end`；事件累积可重建 Msg（§2.4 `appendEvent`）。
- **HITL 是事件**：`RequireUserConfirmEvent` / `RequireExternalExecutionEvent` + 对应 result 事件（§2.3）。
- **驱动模型 = 单 agent ReAct loop**（§3.3）：推理→产出 tool_call→执行→注入→回到推理，直到无 tool_call 或超 `max_iters`。**这是单个 agent 内部的循环，不是多 agent 编排。**

> 结论：AgentScope 文档**没有 team/squad/拓扑/turn-taking/并发**概念。它只保证"任意两个 agent 之间可以用 Msg 通信、用 Event 流式观测"。多 agent 怎么组织、谁调用谁、谁汇总——留给上层应用。

### 1.3 执行模型与状态（AgentScope 侧）

- **共享 vs 隔离**：每个 agent 独立 `AgentState`（隔离上下文）。共享靠**显式传 Msg**（一个 agent 的 reply 输出 = 另一个 agent 的输入）。
- **错误传播**：文档未显式定义；`tool_result.state` 有 `SUCCESS|ERROR|INTERRUPTED|DENIED|RUNNING`（§2.3 ToolResultEndEvent）。
- **中断/恢复**：靠 HITL 事件暂停 + result 事件恢复（§3.5），**不是 abort**。
- **持久化**：`AgentState` 可序列化到 Redis 等后端（§3.6），按 `(user_id, agent_id, session_id)` 寻址。

### 1.4 AgentScope 的设计取舍（§四）

| 取舍 | 选择 | 理由（推测） |
|------|------|-------------|
| 状态归属 | 外置（AgentState 可序列化） | 无状态 Agent → 易水平扩展、易恢复 |
| Msg vs Event | 双模型（完整 Msg + 增量 Event，可互转） | 既要持久化完整状态，又要前端流式 |
| 角色约束 | content block 按 role 强制限制 | 防止 user/system 携带 tool_call 等非法组合 |
| HITL | 事件驱动暂停（不发 abort，发 require 事件） | 暂停点可恢复，不丢上下文 |
| 工具结果 | 自动截断 + 卸载 + 路径引用 | 避免大结果撑爆 context |

---

## 2. 本项目单 agent 体系基线摘要（要扩展什么）

以下均来自 `specs/tech/agent/agent_interface_and_loop/` 与 `specs/tech/agent/event/`。

### 2.1 Agent interface（统一契约）

- 4 方法：`run / activate / enqueue / cancel`（`[P0]agent_interface.md §1`）。**abort 不在 interface**——归 `AgentManager.abort()`（§同文件 §1 注）。
- 三 mode 支持矩阵（§5）：`run` 仅 forked；`activate/enqueue/cancel` 仅 eager/lazy。
- `AgentRun`（§2）：`sessionId / modeKey / runId / groupKey / state / promise / result`。**不暴露 controller**，caller 只能 await。
- 同 mode 不并发（§6）：key=`${sid}_${modeKey}`，running 即拒。
- groupKey 约定（§4）：`session_id:<sid>_amt:<modeKey>`。

### 2.2 AgentManager（门面 + 状态持有者）

`[P0]agent_manager.md`：
- 职责（§1）：enqueue 写 inbox；activate 按 state 三情况 dispatch + 路由 eager/lazy；sideRun 启旁路；abort 4 步收尾；subscribe 转 hub.sub。
- **§7「多 Agent 通信」已埋了钩子**："Agent 间通信统一通过 AgentManager 的 enqueue + activate + sessionQuery——无需特殊 Agent 间通信协议。多 agent 场景每个 agent session 独立维护 state + currentRunId；abort 走各自 AgentManager 实例。"
- 内存状态 key = `${sid}_${modeKey}`（§5）：`agentRuns / abortControllers / loops`。

### 2.3 三 mode（持久化 × drain 笛卡尔积，`[P0]agent_loop_base.md §1.1`）

| mode | 持久化 | drain | 场景 |
|------|--------|-------|------|
| eager-drain | 主对话（全副作用） | 每轮 drain | 主对话 ReAct |
| lazy-drain | 主对话 | run 结束才 drain | 严格批输入批输出（P2，未实现） |
| forked | 旁路（内存） | 不消费 inbox | summary / memory_extract |

### 2.4 forked = 天然子 agent 单元

`[P0]agent_loop_side_run.md`：
- 拿 session snapshot + userMessage 跑内存 loop，**不写 transcript / 不 compact / 不转状态机 / 不消费 inbox**（§7 副作用全关）。
- tool 双维度（§5 / base §3）：`toolDefinitions` 复用主对话保缓存；`allowedTools` 白名单收窄执行。
- emit 到独立 groupKey（§10）。
- 中断无收尾（§9，controller.aborted 即退，丢弃内存 buffer）。
- 当前用法 = compact summary（§11）；future = memory_extract + fork-session。

### 2.5 inbox / enqueue / cancel（`[P0]agent_inbox_enqueue.md`）

- inbox = session 级独立队列，与 SessionStore 解耦（§1）。
- cancel = 入队一条 cancel 条目，drain 时同批配对作废（§4/§6）；v0.0.13 加同步移除路径。
- 三事件：`message_enqueued → processed | canceled`（§5）。

### 2.6 EventHub（通用总线，关键复用点）

`specs/tech/agent/event/[P0]event_hub.md`：
- 全局 singleton；`Map<topic, EventBus>` 路由表（§1）。
- **两级寻址 (topic, group)**，hub 不感知业务（§1）：topic = 一级域（`agent_loop` / `session_panel` / ...），group = topic 下二级渠道。
- 接口（§2）：`registerTopic / sub(topic, group) / unsub`。
- **天然可承载多 agent 通信**：新增一个 topic（如 `squad`）或复用 `agent_loop` + 新 group 即可。

### 2.7 中断/收尾（`[P0]agent_interrupt.md` 参考 base §5）

- AbortController = `{ runId, aborted }`（内存对象，非 Web API）。
- eager/lazy 被 abort → loop 只退出不收尾，由 abort api 4 步 finalize（half-data 持久化 + 补 interrupted tool_result + clearReplay + emit run_stop）。
- forked 被 abort → 直接退出无收尾。

---

## 3. 多 agent 衔接点分析（哪些可直接复用）

### 3.1 可直接复用（高置信）

| 机制 | 位置 | 复用为多 agent 的什么 |
|------|------|----------------------|
| **EventHub(topic, group)** | `event/[P0]event_hub.md` | agent 间消息总线。新增 topic `squad` 或 group `squad:<squadId>` 即可 fan-out 给成员 |
| **enqueue + activate + subscribe** | `agent_manager.md §2/§7` | agent A → `manager.enqueue(B_sid, [msg])` → `manager.activate(B)`；A 订阅 `subscribe(A, "current")` 收 B 回复 |
| **sideRun** | `agent_manager.md §2.1` + `agent_loop_side_run.md` | 天然子 agent：共享父 session snapshot、独立 groupKey、可独立 abort、无主对话污染 |
| **AgentRun + AbortController** | `agent_interface.md §2` + base §5 | 多 agent 并发的句柄管理：每 agent 一个 run，独立 abort |
| **三事件生命周期** | `agent_inbox_enqueue.md §5` | 跨 agent 投递的"消息送达/处理/取消"语义 |
| **同 mode 不并发 CAS** | `agent_interface.md §6` + manager §2 | 防同一 agent 重复驱动的天然锁 |

### 3.2 需新增/扩展（这是两个 spec 目录的主题）

| 缺口 | 归属 spec | 说明 |
|------|-----------|------|
| **squad 声明式定义**（拓扑/角色/边界/身份） | `specs/tech/squad` | AgentScope 不提供；本项目也无 |
| **squad 编排**（turn-taking/并发/终止/错误传播/谁驱动） | `specs/tech/multi_agent` | AgentScope 不提供；本项目 manager 只管单 agent |
| **跨 agent 共享上下文/记忆** | `specs/tech/multi_agent` 或 `context/` | AgentScope 靠显式传 Msg；本项目可考虑共享 snapshot 或共享 inbox |
| **squad 级 abort / 取消** | `specs/tech/multi_agent` | 单 agent abort 已有；squad 级需级联 |

---

## 4. team/squad 定义模式对比

由于 AgentScope 未定义 team/squad，下表是**业界常见模式**（综合多 agent 文献常识，**非 refs 直接引用**，仅作讨论起点）与本项目现状的对照：

| 拓扑形态 | 定义方式 | 编排驱动 | 本项目现状契合度 |
|---------|---------|---------|-----------------|
| **Pipeline 流水线** | 静态有序 agent 链：A→B→C | 顺序调用，前者输出喂后者 | ✅ 高：`sideRun` 串行 + snapshot 传递即可 |
| **Graph / DAG** | 声明节点 + 边（依赖关系） | 拓扑排序 + 并发就绪节点 | ⚠️ 中：需新编排器；EventHub 可承载边 |
| **Hierarchical supervisor-worker** | 一个 supervisor + N worker；supervisor 分派/汇总 | supervisor 自驱（LLM 决定派谁） | ✅ 高：supervisor = 主 agent；worker = sideRun 子 agent |
| **Peer 对等** | N 个平等 agent，按 turn-taking 或消息广播 | 轮转或事件广播 | ⚠️ 中：EventHub 广播现成；turn-taking 需新逻辑 |
| **Swarm 群** | 动态加入/退出，handoff（OpenAI Swarm 风格） | agent 自决 handoff | ⚠️ 低：需新 handoff 协议 |

**squad 是否有"身份/边界"**：
- 最小定义（建议讨论）：`{ squadId, members: AgentRef[], topology, entryAgent, termination }`。
- 边界 = 共享上下文/记忆的可见范围 + 共享的 abort 域。
- AgentScope 的 `(user_id, agent_id, session_id)` 三元组（§3.6）启发：本项目可加 `squadId` 作为 session 之上的第四维寻址。

---

## 5. 设计取舍与对本项目的建议（仅观察，不下定论）

### 5.1 AgentScope 取舍中**适合复用**的

1. **状态外置**（§3.6）：本项目已做到（AgentManager 持 state，策略类无状态）。squad 应延续——squad 状态外置到 `SquadManager`，不在成员 agent 内。
2. **Msg/Event 双模型**：本项目已有（Message + AgentEvent）。跨 agent 通信沿用同一套，不另发明。
3. **HITL 走事件**（§3.5）：本项目已有 `require_human_input`（agent_event §3）。squad 级 HITL 可复用同模式。

### 5.2 AgentScope 取舍中**不适合**本项目的

1. **AgentScope 默认远程/Redis 后端**：本项目是**单机本地**（CLAUDE.md 强调 worktree、bun、本地进程）。squad 不应引入 Redis 依赖；内存 + 本地 store 足够。
2. **AgentScope 无 abort 语义**（只有 HITL 暂停）：本项目有更强的 4 步 abort 收尾（agent_interrupt）。squad 应**复用本项目 abort**，不退回 AgentScope 的纯事件暂停。
3. **AgentScope 无 side run**（旧名 forked）：本项目 side run 是独特优势（保缓存 + 旁路）。supervisor-worker 拓扑应**优先用 sideRun 当 worker**，而非新建独立 session。

### 5.3 本项目特有的优势（设计时应利用）

- **side-run = 子 agent 雏形**：sideRun 已实现"基于父 snapshot 的旁路 loop + 独立 group + 独立 abort"。supervisor-worker 拓扑的 worker 可直接用 sideRun，无需新机制。
- **EventHub 已是通用总线**：多 agent 通信不必另起 bus，加 topic/group 即可。
- **plugin/extension 机制**：squad 定义可作为一种 plugin 类型（声明式注册拓扑）。

### 5.4 建议的分层（仅观察）

```
specs/tech/squad/            ← 声明：squad 是什么（拓扑/成员/边界/身份/终止）
specs/tech/multi_agent/      ← 行为：squad 怎么跑（编排/通信/并发/错误/abort 级联）
```

- `squad` 偏**静态定义**（数据模型 + 声明式拓扑）；
- `multi_agent` 偏**动态执行**（编排 loop + 通信协议 + 状态机）。
- 两者都建立在现有 `agent/` 之上，不改动单 agent 接口。

---

## 6. 关键开放问题清单（留给 orchestrator + 用户讨论）

1. **squad 的"边界"靠什么界定？** 是共享上下文/记忆？共享 abort 域？还是纯声明式成员表？AgentScope 的 `(user, agent, session)` 启发加 `squadId` 第四维——是否采用？
2. **worker 用 sideRun 还是独立 session？** sideRun 优势：保缓存、无污染、已有 abort；劣势：无持久化 transcript、不能 compact。独立 session 优势：完整生命周期；劣势：开销大、缓存不命中。**supervisor-worker 拓扑的默认选择是哪个？**
3. **谁驱动 squad 流转？** 一个 squad 级 orchestrator loop（类似 AgentManager 但管多 agent）？还是 supervisor agent 自驱（LLM 决定派谁）？两者可否共存？
4. **squad 级 abort 怎么级联？** 取消整个 squad 时，是逐个 abort 成员 run，还是有"squad controller"统一收尾？与现有 4 步 abort 如何衔接？
5. **squad 是声明式（配置/拓扑文件）还是代码式（API 组装）？** 声明式利于 plugin 化和热加载；代码式灵活但难持久化。是否走 plugin/extension 机制？
6. **跨 agent 共享上下文怎么做？** 共享 snapshot（只读）？共享 inbox？还是显式 Msg 传递（AgentScope 方式）？影响拓扑选型。
7. **squad 内并发度？** 同一时刻允许多少 agent 同时 running？现有"同 mode 不并发"是 per-agent 的，squad 级是否需要独立的并发闸门？
8. **终止条件谁定？** supervisor 决定？拓扑自然结束（DAG 叶节点全完成）？还是外部 abort？多 agent 文献里这是核心分歧点。

---

## 附录 A：来源索引

| 内容 | 来源 |
|------|------|
| AgentScope Msg/Event/Agent | `refs/agentscope_message_event_agent.md §一/§二/§三/§四` |
| Agent interface + AgentRun + 三 mode 矩阵 | `specs/tech/agent/agent_interface_and_loop/[P0]agent_interface.md §1-§6` |
| AgentManager 门面 + 多 agent 通信钩子 | `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §1/§2/§7` |
| loop base（机制层 + 持久化×drain 维度） | `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §1.1/§2/§3/§5` |
| side run mode（旁路子 agent 雏形，旧名 forked） | `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_side_run.md §1/§4/§5/§7/§9/§11` |
| eager-drain（主对话） | `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md §1/§5/§6/§9` |
| inbox/enqueue/cancel | `specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §1/§4/§5/§6` |
| AgentEvent 类型 | `specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §2/§3/§4` |
| EventHub（通用总线） | `specs/tech/agent/event/[P0]event_hub.md §1/§2/§3` |
| ContextSnapshot（共享上下文候选） | `specs/tech/agent/context/[P0]context_snapshot_interface.md §2` |
