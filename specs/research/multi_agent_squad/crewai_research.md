# CrewAI 多 Agent 架构调研报告

- **调研范围**: CrewAI 的 Crew/Agent/Task/Process/delegation 模型如何对应我们的 Squad/Role/SquadChat/sub-agent 设计
- **调研对象**: `refs/crewai/`（GitHub `crewAIInc/crewAI` monorepo）
- **版本**: commit `e1ddb32e`，包路径 `lib/crewai/src/crewai/`
- **克隆体积**: 562M（shallow clone）
- **调研日期**: 2026-06-27
- **声明**: "CrewAI 事实" 标 `F:`；"对本项目的建议" 标 `S:`

> 本报告遵守 300 行/10000 字符预算。报告同目录另有 `multi_agent_squad_research.md`（其他竞品），互不冲突。

## 1. 总体架构概览

CrewAI 的核心三件套：**Crew（容器）+ Agent（执行者）+ Task（工作单元）**，由 Process 决定执行拓扑。所有源码集中在 `lib/crewai/src/crewai/{crew.py, task.py, agent/core.py, process.py}`。

F: `Crew(BaseModel)` 持有 `agents: list[BaseAgent]` + `tasks: list[Task]` + `process: Process` + `manager_agent/manager_llm`（`crew.py:159-389`）。Crew 是 Pydantic 模型 + FlowTrackable mixin，生命周期由 `kickoff()` 单次驱动（不是常驻 chat loop）。

F: `Process` 是个 11 行的枚举（`process.py:1-11`），只有 `sequential` / `hierarchical` 两个值，`consensual` 是 TODO 注释未实现。拓扑实现**内联在 `crew.py`**（不是独立 `utilities/process/` 模块）。

F: **CrewAI 没有显式 Leader/Member 概念**。hierarchical 模式下的 manager 只是 `crew.manager_agent` 这个属性（普通 Agent 实例 + `allow_delegation=True`），在 Agent 类本身上没有任何 `is_manager`/`is_leader` 字段（`grep "is_manager|is_leader" agent/core.py` 无结果）。

## 2. 策略枚举（Process 拓扑）

### 2.1 Sequential（顺序，默认）
- **定义**: 严格按 `tasks` 列表顺序串行执行，每条 task 由 `task.agent` 执行；上一条 task 的 output 作为下一条 task 的 context
- **触发条件**: `process == Process.sequential`（Crew 默认值）
- **代码位置**: `crew.py:1037-1038`（kickoff 分派）→ `_run_sequential_process()` `crew.py:1485-1487` → `_execute_tasks(self.tasks)` `crew.py:1529-1598`

### 2.2 Hierarchical（分层，有 manager）
- **定义**: 先自动创建 manager agent（注入 delegation 工具），然后仍按 `tasks` 列表顺序执行，但每条 task 的 executing agent 是 manager，manager 通过 `DelegateWork`/`AskQuestion` 工具把具体工作派给 `self.agents` 里的成员
- **触发条件**: `process == Process.hierarchical` 且提供 `manager_llm` 或 `manager_agent`
- **代码位置**: `crew.py:1039-1040` → `_run_hierarchical_process()` `crew.py:1489-1492` → `_create_manager_agent()` `crew.py:1494-1519` → 同一个 `_execute_tasks(self.tasks)`
- **校验**: `check_manager_llm()` `crew.py:710-727`——hierarchical 缺 `manager_llm`/`manager_agent` 直接报错

### 2.3 Consensual（共识，未实现）
- **定义**: 枚举里被注释掉 `# TODO: consensual = 'consensual'`，无实现

## 3. Crew（≈我们的 Squad）定义

F: `crew.py:159` 类声明 `class Crew(FlowTrackable, BaseModel)`。核心字段（`crew.py:218-391`）：

| 字段 | 类型 | 作用 |
|---|---|---|
| `agents` | `list[BaseAgent]` | 成员列表，经 `_resolve_agents` 转换 |
| `tasks` | `list[Task]` | 工作单元列表 |
| `process` | `Process` | 默认 `sequential` |
| `manager_llm` | `str\|BaseLLM\|None` | hierarchical 用——自动创建 manager 的 LLM |
| `manager_agent` | `BaseAgent\|None` | hierarchical 用——可自定义 manager Agent |
| `function_calling_llm` | 已 deprecated | — |
| `verbose` / `memory` / `cache` / `max_rpm` / `share_crew` / `planning` / `chat_llm` | 多类型 | 全局配置 |

F: Crew 通过 `kickoff(inputs, input_files, from_checkpoint)` 启动（`crew.py:980-1072`）——单次同步执行返回 `CrewOutput`。`kickoff_async`（`crew.py:1110`）和 `kickoff_for_each`（`crew.py:1074`、`1164`）是变体。

F: Crew 反向持有每个 agent——`agent.crew = self`（`crew.py:1519` manager；普通 agent 在 `_set_crew_for_agent` 流程里设置）。

S: 我们的 Squad ↔ CrewAI Crew 概念可对齐——都是"持有成员 + 任务集合 + 决定拓扑"的容器。但 CrewAI 的 Crew 是**一次性 kickoff**，不是常驻 chat session；这跟我们 SquadChat 的"哑路由器常驻循环"模型不同。

## 4. Agent（≈我们的 Role）定义

F: `agent/core.py:171` `class Agent(BaseAgent)`；基类 `BaseAgent` 在 `agents/agent_builder/base_agent.py:200`。Agent 核心字段：

| 字段 | 位置 | 默认 | 作用 |
|---|---|---|---|
| `role` | `base_agent.py:263` | 必填 | 角色（=delegation 工具匹配 key） |
| `goal` | `base_agent.py:264` | 必填 | 目标 |
| `backstory` | `base_agent.py:265` | 必填 | 人设背景 |
| `llm` | `core.py:215` | None | 该 agent 用的 LLM |
| `tools` | `base_agent.py:283` | [] | 工具列表 |
| `allow_delegation` | `base_agent.py:279` | **False** | 能否调用其他 agent |
| `max_iter` | `base_agent.py:286` | **25** | ReAct loop 最大迭代 |
| `max_rpm` | `base_agent.py:275` | None | RPM 限流 |
| `step_callback` | `core.py:207` | None | 每步回调 |
| `max_execution_time` | `core.py` | None | 单任务超时 |
| `use_system_prompt` | `core.py:211` | True | — |
| `crew` | `base_agent.py:310` | None | 反向引用所属 Crew |

F: **Leader/Member 区分**：Agent 类本身**完全没有** manager/leader 标记字段。hierarchical 的 manager 只是 Crew 持有的 `crew.manager_agent`——一个普通 Agent 实例 + 在 `_create_manager_agent` 里强制设的 `allow_delegation=True`（`crew.py:1496`、`1514`）。Manager 的特殊能力仅来自其注入的 delegation 工具集，而不是来自 Agent 类型/字段。

S: 我们的 Role 也建议用"普通 Role + 一个特殊 routing role"的对称结构，避免类型膨胀。SquadChat 是哑路由器≠有特权的 Leader Role。

## 5. Process 三拓扑（重点：hierarchical manager）

### 5.1 共享执行引擎（关键反直觉发现）

F: **sequential 和 hierarchical 走同一个 `_execute_tasks(self.tasks)`**（`crew.py:1487` 和 `crew.py:1492`），唯一差别是 hierarchical 先 `_create_manager_agent()`。这彻底否定了我先前的假设"manager 动态拆 subtask"——**CrewAI 的 task list 永远是用户预定义的**，manager 不做"收 user 输入→动态拆解"，只做"逐条 task 执行 + delegation 工具下派"。

### 5.2 Manager 是怎么创建的（`_create_manager_agent` `crew.py:1494-1519`）

F: 两种路径：
1. **用户提供 `manager_agent`**：直接用，强制 `allow_delegation=True`；若 manager 带了工具会抛异常 `"Manager agent should not have tools"`（`crew.py:1505`）
2. **用户提供 `manager_llm`**（更常见）：自动构造普通 `Agent`，role/goal/backstory 取自 i18n，**tools 自动注入 `AgentTools(agents=self.agents).tools()`**（即 `DelegateWorkTool` + `AskQuestionTool`）

F: Manager 注入的 delegation 工具覆盖范围由 `_update_manager_tools` 决定（`crew.py:1824-1834`）：
- task 显式指定了 `task.agent` → manager 只能 delegation 给**那一个 agent**
- task 没指定 agent → manager 可 delegation 给**所有** `self.agents`

### 5.3 Manager 干什么——不是 SquadChat 的现成蓝本

F: Manager 在 ReAct loop 里跑每条 task，它的"工作"就是**调用 `DelegateWorkTool`/`AskQuestionTool` 把 task 派下去**（这两个工具内部走 `selected_agent.execute_task(...)` 同步阻塞调用，等返回结果字符串）。Manager 自己**没有文件/web 工具**（`crew.py:1505` 明确禁止）。

F: 终止——**没有 EOS 概念**。Crew 终止 = `tasks` 列表全部跑完（`_execute_tasks` 主循环 `crew.py:1553-1598`）。Manager 不判定"全做完"，是 task list 列表本身判定。

S（重要启示）: **CrewAI manager ≠ 我们设计的 SquadChat 哑路由器**：
- 相同点：都不做实质工作（manager 无 tools，SquadChat 无业务能力）；都负责派活；都汇总
- 关键差异：CrewAI 的 task list 是**预定义**的，manager 在 list 上"逐条派"；我们设计 SquadChat 是**对话驱动**的——收 user 输入→动态决定派哪条→用 `<EOS>` 自判结束
- **CrewAI manager 不是 SquadChat 的现成蓝本**，但它提供的"caller 暂停→callee 同步执行→caller 继续"机制（delegation 工具）是 sub-agent 语义的干净范本

### 5.4 Manager Prompt（完整收录）

F: `translations/en.json:2-6`：

```json
"hierarchical_manager_agent": {
  "role": "Crew Manager",
  "goal": "Manage the team to complete the task in the best way possible.",
  "backstory": "You are a seasoned manager with a knack for getting the best out of your team.\nYou are also known for your ability to delegate work to the right people, and to ask the right questions to get the best out of your team.\nEven though you don't perform tasks by yourself, you have a lot of experience in the field, which allows you to properly evaluate the work of your team members."
}
```

F: delegation 工具描述（`translations/en.json:58-59`）：

```
"delegate_work": "Delegate a specific task to one of the following coworkers: {coworkers}\nThe input to this tool should be the coworker, the task you want them to do, and ALL necessary context to execute the task, they know nothing about the task, so share absolutely everything you know, don't reference things but instead explain them."
"ask_question": "Ask a specific question to one of the following coworkers: {coworkers}\nThe input to this tool should be the coworker, the question you have for them, and ALL necessary context to ask the question properly, they know nothing about the question, so share absolutely everything you know, don't reference things but instead explain them."
```

F: ReAct 系统提示（`translations/en.json:12`，截关键段）：

```
You ONLY have access to the following tools, and should NEVER make up tools that are not listed here:
{tools}
IMPORTANT: Use the following format in your response:
Thought: ... Action: name [tool_names] Action Input: {...} Observation: ...
Once all necessary information is gathered, return: Thought + Final Answer
```

## 6. Task 定义与分派

F: `task.py:114` `class Task(BaseModel)`。核心字段（`task.py:146-295`）：

| 字段 | 类型 | 作用 |
|---|---|---|
| `description` | str | 任务描述 |
| `expected_output` | str | 预期产出格式 |
| `agent` | `BaseAgent\|None` | 指定执行者（hierarchical 下若指定则限定 manager 可 delegation 范围） |
| `context` | `list[Task]\|NOT_SPECIFIED` | 任务间数据传递——引用其他 Task 实例，执行时取其 output |
| `async_execution` | `bool\|None` | True=丢线程池并行 |
| `tools` | `list\|None` | 任务级额外工具 |
| `output` | `TaskOutput\|None` | 执行结果回填 |
| `guardrail` / `guardrails` | — | 输出校验，失败重试（默认 3 次） |
| `callback` | `SerializableCallable\|None` | 任务完成回调 |

F: **context 数据传递机制**（`crew.py:1837-1845` `_get_context`）：若 `task.context is NOT_SPECIFIED` 则聚合之前所有 task outputs；否则聚合 `task.context` 引用的 task 实例 outputs。即**任务间通过 output 字符串串联，没有直接消息通道**。

F: 分派流程（`_execute_tasks` `crew.py:1553-1598`）：
```
for task in tasks:
    prepare_task_execution() → 决定 executing_agent（sequential: task.agent；hierarchical: manager）
    if task.async_execution: task.execute_async(agent, context, tools) → Future，攒入 futures
    else: 先 _process_async_tasks(futures) 等并行任务完 → task.execute_sync(agent, context, tools)
return _create_crew_output(task_outputs)  # 取最后一条 task output 作为 crew 结果
```

S: task.context 引用其他 Task 实例——是编译期声明依赖，不是运行时消息总线。我们若做 send_message 同步语义可借鉴，但若想支持"运行时发现依赖"则需要更强的消息通道。

## 7. Delegation / Agent 间通信（≈我们的 sub-agent）

F: delegation 是 CrewAI **唯一的** agent→agent 通信通道。普通 agent 之间**没有直接消息通道**（除非在 sequential 下用户显式给某 agent 设 `allow_delegation=True`）。

F: 工具实现（`tools/agent_tools/`）：
- `AgentTools.tools()` `agent_tools.py:22-36`：返回 `[DelegateWorkTool, AskQuestionTool]`
- `BaseAgentTool._execute()` `base_agent_tools.py:46-124`：按 `agent.role` 大小写不敏感匹配（`sanitize_agent_name`），找到 callee 后**构造临时 `Task`** 并调 `selected_agent.execute_task(task, context)`（`base_agent_tools.py:112-120`）——**同步阻塞**

F: 注入逻辑（`crew.py:1616-1631` `_prepare_tools`）：
- `Process.hierarchical`：仅 manager 注入（`_update_manager_tools`），普通成员**不注入**
- `Process.sequential`：仅当 `agent.allow_delegation == True` 时给该 agent 注入（`_add_delegation_tools`）

F: **delegation = sub-agent 语义**：caller agent 的 ReAct loop 在工具调用点暂停，等 callee 跑完返回结果字符串，caller 继续。call stack 嵌套，**无显式生命周期**（callee task 跑完即销毁，不常驻）。

S: 这正是我们 sub-agent 设计的天然范本——callee 不常驻、用完即销；caller 用 ReAct 工具调用触发；同步返回。

## 8. 执行模型与终止

F: ReAct loop 在 `agents/crew_agent_executor.py:330-440` `_invoke_loop_react`：
```
while not isinstance(formatted_answer, AgentFinish):
    if has_reached_max_iterations(iterations, max_iter):  # max_iter 默认 25
        formatted_answer = handle_max_iterations_exceeded(...)  # 强制 Final Answer
        break
    enforce_rpm_limit(...)
    answer = get_llm_response(llm, messages, ...)
    formatted_answer = process_llm_response(answer_str, ...)
    if isinstance(formatted_answer, AgentAction):
        tool_result = tool._run(...)  # delegation 也走这里——同步阻塞
        messages.append(Observation)
return AgentFinish
```

F: 单 agent 终止——三种条件：
1. LLM 输出 `Final Answer:`（`process_llm_response` 解析为 `AgentFinish`）
2. 迭代到 `max_iter=25` → `force_final_answer` 强制收尾（`translations/en.json:47`）
3. `max_execution_time` 超时（`core.py:834-838`）

F: 并发——`task.py:596-625` `execute_async` 用 `threading.Thread(daemon=True)` + `concurrent.futures.Future` + `contextvars.copy_context()`；主循环攒 futures，遇到 sync task 时 `_process_async_tasks` 同步等。**无信号量/并发上限**——RPM 限流（`utilities/rpm_controller.py`）是唯一的并发约束。

F: Crew 终止——**`tasks` 列表全部跑完**（`_execute_tasks` 主循环结束 + `_create_crew_output` `crew.py:1858-1890`，取最后一条 task 的 output 作为 crew 最终输出）。**无 EOS、无 manager 判定**。

S: 这是与 SquadChat 最大的语义鸿沟——CrewAI 终止 = list 跑完；我们设计终止 = SquadChat 输出 `<EOS>`。CrewAI 没有"manager 自判完成"机制可借鉴。

## 9. 与本项目模型对照表

| 概念 | CrewAI 做法 | 我们打算做 | 可借鉴点 |
|---|---|---|---|
| **Squad ↔ Crew** | `Crew(BaseModel)` 持 agents+tasks+process；`kickoff()` 一次性执行 | Squad 常驻会话，SquadChat 哑路由器循环 | Crew 字段布局可参考；但 Squad 不是一次性 kickoff |
| **Role ↔ Agent** | `Agent(BaseAgent)` role/goal/backstory/llm/tools/allow_delegation；无 leader 字段 | Role 对称结构，SquadChat 是哑路由器不是特权 Role | **采纳：Role 类无 is_leader 字段** |
| **hierarchical manager ↔ SquadChat** | 普通 Agent + 自动注入 delegation 工具；按预定义 task list 逐条派；无 EOS | SquadChat 收 user→动态决定派谁→`<EOS>` 自判结束 | **不是现成蓝本**——CrewAI task 是预定义的，我们是对话驱动；但 delegation 工具机制干净 |
| **delegation ↔ sub-agent** | `DelegateWorkTool._run()` → 同步 `callee.execute_task()`；caller ReAct 暂停 | sub-agent 用完即销 | **直接采纳**：caller 工具调用触发、callee 同步执行、栈式嵌套 |
| **task context ↔ send_message** | `task.context: list[Task]` 编译期引用其他 Task 实例；运行时聚合 output 字符串 | 待定 Q3（同步/异步） | 借鉴"引用其他 Task 实例"做静态依赖；动态消息需另设计 |
| **终止** | `tasks` 列表跑完即结束；无 manager 判定 | SquadChat `<EOS>` 自判 | CrewAI 无可借鉴，需自研 |
| **并发** | `async_execution=True` task 跑 daemon thread；无并发上限 | 待定 Q5 | 借鉴 `Future + 主循环同步点`模式；建议加并发上限 |

## 10. 对我们 5 个开放问题的启示

- **Q1 Leader vs SquadChat**：CrewAI 用"普通 Agent + 注入 delegation 工具 = manager"——**不要造特权 Leader 类**。SquadChat 应是一个 Role 实例（无业务工具），通过 prompt + 工具集实现路由，不要在类型层膨胀。CrewAI 的 `crew.py:1505` "Manager should not have tools" 是个好约束——保证 manager 永远只分派不亲自干活。
- **Q2 sub-agent 生命周期**：CrewAI delegation 是**用完即销、栈式嵌套**（callee task 完成即返回字符串，不保留状态、不可复用）。建议我们 sub-agent 同样不常驻；若需多轮，靠 caller 多次调用 delegation（CrewAI 的 `AskQuestionTool` 就是为此存在）。
- **Q3 send_message 同步异步**：CrewAI 的 delegation 是**纯同步阻塞**（caller 等 callee 返回字符串再继续 ReAct）。简单可靠、call stack 天然跟踪；缺点是长 callee 会阻塞 caller 的 token 流。建议我们 send_message 默认同步（与 CrewAI 一致），异步作为可选模式。
- **Q4 终止粒度**：CrewAI 单 agent 终止靠 `Final Answer:` 文本 + `max_iter=25` 兜底；crew 终止靠 task list 跑完。**我们的 `<EOS>` 与 CrewAI 的 `Final Answer:` 是同构的**——采纳"输出特定 token 终止"的设计；但需自研"SquadChat 何时输出 `<EOS>`"的判定（CrewAI 无对应——它靠 task list 跑完）。
- **Q5 并发**：CrewAI 并发只在 task 级（`async_execution`），agent 内部 ReAct 永远串行；RPM 限流是唯一上限。建议我们 Role 内 ReAct 同样串行，并发只在"同时派多个 sub-agent"层面；务必加显式并发上限（CrewAI 没加是个坑——大量 async task 可能打爆 LLM 速率）。

## 11. 关键开放问题 / 风险

- S: CrewAI 的 task list 是**预定义的**，与 SquadChat 的"对话驱动动态拆解"在数据模型层不同——我们不能直接复用 `_execute_tasks(self.tasks)` 主循环，需自研基于消息的循环。
- S: CrewAI 没有"agent 间直接消息通道"——所有 agent→agent 通信必须经 delegation 工具（caller 主动），callee 无法主动给 caller 发消息。如果我们需要"callee 主动通知 caller"，必须自己设计消息总线，CrewAI 无可借鉴。
- S: `crew_chat.py` 与我们的 SquadChat **概念撞名但语义不同**——它是 CLI conversational crew 入口（`chat_llm` 决定下次 kickoff 的 inputs，`crew.py:680-681`），不是 agent 路由器。文档里务必澄清。
- S: hierarchical 默认 `manager_agent` 路径下若用户给了 tools 会硬抛异常（`crew.py:1505`）——这是强约束，建议我们 SquadChat 也禁止业务工具。

