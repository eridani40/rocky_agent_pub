---
type: design
title: 一级整理机制（session 级「笔」）
priority: P0
status: active
updated: 2026-08-02
since: v0.0.21
---

# 一级整理机制（session 级「笔」）

> 主文档：`index.md`（① 是什么）。manage 工具见 `../skills/[P0]skill_manage_tool.md`（skill 管理）/ `[P0]memory_manage_tool.md`（memory 管理）。compact 机制见 `../context/[P0]context_compact_detail.md`。forked agent 见 `../agent_interface_and_loop/`。
>
> **注记**：fork-2（整理）**直接调用** `skill_manage` / `memory_manage` 工具落盘（不产出结构化 ops 再执行）。forked agent 的 allowed tools = `[skill_manage, memory_manage]`（不是 NO_TOOLS）。

> **实现落点（v0.0.204 口径；v0.0.238 T1 整理者化扩权）**：fork-2 整理 agent 落地于 `app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts`（`memory_skill_consolidation` handler，runKind=`consolidate` / maxIter=10（consolidate profile `runShape.maxIterDefault`）/ allowed tools=[v0.0.238 起扩为 skill_manage, memory_manage, read, write, edit, glob, grep]（consolidate profile toolBound）/ 复用 session model + CompactCtx + ConsolidationHandler prompt 模板——**纯 directive**，task message 不复述对话历史，snapshot 经旁路 buffer 唯一承载；v0.0.238 起 task message 经 `{{agents_paths}}`/`{{scope_table}}` 占位符承载 AGENTS.md 整理对象路径 + biz scope 可用表这类**静态配置**，旁路不变量保持——不复述 transcript）。防递归 consolidate scope 选 `noop_post_compact`。post_compact AT 不可行（黑盒难观测），UT 覆盖。
>
> **[v0.0.80.t1] 触发模式重构**：旧 v0.0.51 的「compact 完成 → post-compact handler 顺序链」**退役**——fork-2 不再是 compact 成功后的串行后续，而是与 summary 并发的 **sibling**。`tryCompact` 谓词 true 后：deep clone 一份不可变 snapshot → `void runSummarySibling + void runConsolidationSibling` 双发（各自 fire-and-forget + 各自 acquire 自己的锁，互不阻塞）。详见 `../context/[P0]context_compact_detail.md §2c.1`。同步 fork-2 handler 内部 acquire `'tier1_consolidation'` 锁（spec `../session/[P0]session_task_lock.md §6` 实接）。

## 1. 概述

## 1. 概述

一级整理是 memory/skill 的**实时、session 级收集层**（「笔」）：在信息还在、上下文最全的时刻捕捉值得沉淀的东西，写入 memory/skill。轻量、实时、容忍噪声；深度整合（去重/矛盾解决/容量回收）留给二级整理（P1）。

**不审批**：产出直接落盘（self evolution）。

## 2. 两个时机（共享触发时机，任务独立）

### 时机 A · session 内实时

agent 在对话中判断有值得记的（用户纠正、决策、偏好、可复用工作流），随时调 `memory_manage` / `skill_manage` 写入。

- 特点：零散、即时、由 agent 主动判断
- 不靠计数器 fork（区别于 Hermes nudge），是 LLM 随时主动调 tool

### 时机 B · compact 时机，fork-2 通过 post-compact ext point 触发（核心）

compact 完成（setSummary + appendMessages + markSummaryDone 之后），通过 **post-compact handler ext point**（`context_post_compact`，见 `../context/[P0]context_compact_detail.md §2d`）触发整理 forked agent：

| fork | 任务 | 输入 | 输出 |
|------|------|------|------|
| **fork-1（summary）** | 原 compact 职责：压缩对话成 summary | 完整待压缩对话 | `<summary>` → setSummary 推进 summaryUpTo |
| **fork-2（整理）** | 从对话提炼 memory + skill | 同一份完整对话（compact 前完整 snapshot） | 直接调 skill_manage / memory_manage 工具落盘 |

**关键设计**：
- **共享时机**：compact 发生时上下文最全、信息未丢失，是整理的最佳时机。
- **fork-2 在一个 forked agent 里做 memory + skill**：不是两个独立 fork，是一个 fork 同时处理两类整理。
- **fork-2 与 fork-1 独立**：fork-2 是 fork-1 的旁路（通过 post-compact ext point 触发），**失败互不影响**（fork-2 失败不影响 compact 已完成的 summary）。
- **fork-2 通过 post-compact ext point 触发**：不是直接在 compact 流程里硬编码，而是注册 `context_post_compact` EP 的 `memory_skill_consolidation` impl（见 §4）。
- **fork-2 直接调工具落盘**：forked agent 的 allowed tools = `[skill_manage, memory_manage]`，直接调用工具写入（不产出结构化 ops 再执行）。

## 3. fork-2（整理）契约

```typescript
interface ConsolidationForkTask {
  input: { messages: Message[] };            // 完整待压缩对话（与 fork-1 同源，compact 前完整 snapshot）
  // forked agent 直接调 skill_manage / memory_manage 工具落盘
  // 不产出结构化 ops，不返回值（fire-and-forget 落盘）
}
```

**forked agent 配置**：
- **allowed tools** = `[v0.0.238 起：skill_manage, memory_manage, read, write, edit, glob, grep]`（不是 NO_TOOLS；v0.0.238 放权读+改 AGENTS.md 等自定义文件）
- **system prompt**：引导 agent 从对话中提炼值得沉淀的 memory entry 和可复用 skill；v0.0.238 起兼承担 **AGENTS.md 整理职责**（按 5 条标准下沉流水/去重/修 description/控制体量 + 红线：禁删角色定位与用户钦定铁律、不删文件（write/edit 改内容不 rm）、memory 只 archive、skill 只 disable、evolvable=false 不动）。指令按主 session 的 biz 渲染可用 scope 表（`{{scope_table}}` 占位符），写 memory/skill 必须显式 scope（与主会话写侧一致，见 §6）。
- **行为**：forked agent 先判断是否有整理工作（值得记的 memory / 值得沉淀的 skill / AGENTS.md 待整理段落）。**没有就输出**（EOS 可选，参考 squad chat 语义，无所谓）——不强制产出。

**落盘方式**：forked agent 在推理过程中直接调用 `skill_manage.create` / `skill_manage.patch` / `memory_manage.write` / `memory_manage.archive` 工具，工具内部完成落盘（不审批，受 mutable 治理 + 容量上限约束）。

> **输入澄清（v0.0.51 v2）**：fork-2 的 input snapshot 是 compact 前**完整对话**，**已包含本次 session 刚发生的 memory/skill 工具调用记录**（如时机 A agent 调 `memory_manage.write` / `skill_manage.create` 的 user/assistant/tool_result 消息都在对话里）。fork-2 据此判断「本次已沉淀了什么」、不重复写。
>
> **不额外注入历史已落盘 memory**——输入就是 snapshot（与 fork-1 同源），不含 user_memory.md 当前内容。跨 compact 周期的**历史去重**（如多次 compact 间已沉淀的 memory 是否被本次又覆盖）交给 P1 二级整理（merge/prune/矛盾解决）。
>
> 这符合原设计（fork-2 输入 = snapshot，本就不含历史 memory）；此处只是把「为什么不重复沉淀」讲清楚——靠对话内的工具调用记录做本次去重，跨周期靠二级整理。

## 4. 与 compact 的协作（v0.0.80.t1 sibling 双发）

```
runReActLoop 每轮 prepareStage 之后、callLLM 之前：
  void tryCompact(spec, state).catch(log)
    └─ tryCompact 胶水：
         · should-compact 谓词（threshold >60%）→ true 才继续
         · deep clone snapshot ONCE（structuredClone，两 sibling 共享不可变副本）
         · void runSummarySibling(sharedCtx).catch(log)   ← fork-1：acquire 'compact' 锁
         · void runConsolidationSibling(sharedCtx).catch(log) ← fork-2：handler 内部 acquire 'tier1_consolidation' 锁
         · 立即 return（两 sibling 异步并发，互不阻塞，互不耦合）

  fork-2（runConsolidationSibling → memory_skill_consolidation handler）:
    ├─ allowed tools = [skill_manage, memory_manage]
    ├─ 输入 = 触发时刻 deep clone 的 snapshot（与 fork-1 同源）
    ├─ handler 内部 acquire('tier1_consolidation') → 锁失败静默跳过（fire-and-forget）
    ├─ forked agent 判断是否有整理工作 → 没有就输出
    └─ 有则直接调 skill_manage / memory_manage 工具落盘
```

- **[v0.0.80.t1] 触发模式从顺序链改为 sibling 双发**：旧 v0.0.51 「compact 完成 → post-compact handler 触发 fork-2」串行链退役；现 fork-2 与 fork-1 在 tryCompact 胶水内**并发派发**，共享同一份不可变 snapshot deep clone，各自 acquire 自己的锁（`compact` / `tier1_consolidation`）。
- **fork-2 与 fork-1 独立**：两 sibling 各自 `void ... .catch(log)` fire-and-forget，**失败互不影响**（fork-2 失败不影响 compact 已完成的 summary，反之亦然）。
- **fork-2 的 EP 注册仍在 `context_post_compact`**：`MemorySkillConsolidationHandler` 仍是该 EP 的默认 impl；只是调用方式从「compact 成功后串行触发」改为「tryCompact 胶水直接并发派发 `handlers[0].handle(ctx)`」。
- **旁路 scope 防递归**：fork-2 的 scopeId = `<prefix>:consolidate`（沿 extends 链落到 consolidate 基座 scope），该 scope 显式选中 `reject_should_compact`（防递归 compact）+ **post-compact handler 也跳过**（consolidate scope 选 `noop_post_compact`，防整理 run 再触发 compact → 再整理的递归，见 `../context/[P0]context_compact_detail.md §2d`）。

## 5. 设计决策

- **搭 compact 便车**：compact 本就要跑（context 满），整理 fork 共享时机，零额外调度 + 信息最全。
- **fork-2 通过 post-compact ext point 注册**：handler impl 注册在 `context_post_compact` EP（可扩展、可替换）；[v0.0.80.t1] 起调用方式从「compact 成功后串行触发」改为「tryCompact 胶水 sibling 双发」。
- **memory + skill 在一个 forked agent 里**：不是两个独立 fork，是一个 fork 同时处理两类整理（减少 fork 开销）。
- **fork-2 直接调工具落盘**：forked agent 的 allowed tools = `[skill_manage, memory_manage]`，直接调用工具写入。不产出结构化 ops（移除 MemoryOp/SkillOp）。
- **先判断再行动**：forked agent 先判断是否有整理工作，没有就输出（不强制产出）。
- **不审批**：self evolution，工具调用直接落盘。
- **失败隔离**：整理失败不阻断 compact（fork-2 与 fork-1 是 sibling，各自 fire-and-forget + 各自 catch；**两 sibling 互不阻塞、各自锁失败各自静默跳过**——v0.0.80.t1）。
- **只做 tier 1**：tier1 只负责 session 级实时收集（compact 时机双 fork）；离线深度整合（merge/prune/容量回收）已由天级 tier2 落地（`[P0]consolidation_tier2.md`，v0.0.151.t2_consolidate 起）。两 tier 职责解耦到不同时间尺度（见 index.md 原则 2「笔/编辑分离」）。

## 6. fork-2 prompt 模板 + 路由提示词（v0.0.112 落地）

fork-2 task message 模板 = `app/server/src/prompts/content/consolidation.md`（`ConsolidationHandler.build(ctx)` 仍纯 directive——**不复述 transcript**，对话历史由 snapshot 经旁路 buffer 唯一承载，prompt 只下指令——v0.0.204 修复，与 fork-1 summary 同契约，见 `../agent_interface_and_loop/[P0]agent_loop_side_run.md §1`。**v0.0.238 起新增两个静态配置占位符**：`{{agents_paths}}`（按 kind 渲染 AGENTS.md 整理对象路径：studio 团队 + 个人；playground 单份；academy 渲染「本场景不整理 AGENTS.md」固定行——academy T1 维持 memory/skill 范围，OUT）+ `{{scope_table}}`（按主 session biz 渲染可用 scope 层 + 语义 + 必填规则，来自 `biz-scope-rules.renderScopeTableForPrompt`）。这两占位符承载**静态配置**而非对话历史，不破坏旁路不变量。caller（`MemorySkillConsolidationHandler.startConsolidation`）从 `ctx.config`（SessionConfig，含 kind/workdir/sessionContext/studioContext）计算 vars 传入 `build({vars})`；AGENTS.md 路径计算复用 `resolveAgentProfileInput`（agent_profile.ts 路径单源）。模板正文含 5 条整理标准 + 红线，coder 落稿。**v0.0.238 删除 fork-override「默认翻 session」段**——被 scope 必填（§6）取代）。

**[v0.0.112] 两步路由规则显式写进 fork prompt（主战场）**：consolidation.md 的 Step 2 路由段落改为占位符 `{{routing_rules}}`，`ConsolidationHandler.build` 从**单一文案常量** `app/server/src/prompts/routing-decision.ts ROUTING_DECISION_PROMPT` 填入——与 `memory_manage` / `skill_manage` tool description 三处同源（**v0.0.238 起 4 处同源**：`consolidation-tier2-handler` 也共读），避免措辞漂移（memory_manage_tool §5.2）。

- **第一步 skill vs memory vs 都不写**：how-to 步骤 → skill；事实/偏好/约束/教训 → memory；项目代码/架构 → specs（都不写）。
- **第二步 global vs group vs session（v0.0.238：scope 必填无默认 + 按 biz 可用表）**：见 `routing_decision.md` Step 2 全 biz 静态表（playground→session/global；studio→group/global；academy→三层）。fork-2 写 memory/skill 与主会话写侧走同一校验链——**scope 必填**、传错层被工具拒并按 biz 引导（见 §6 + `memory_manage_tool §5.2`）。
- **[v0.0.238] fork-override「默认翻 session」段退役**：v0.0.205 写入指令的「For this consolidation pass, the Step-2 default is flipped: default to session; ...」段删除——scope 必填后无默认可翻。**共享常量 `ROUTING_DECISION_PROMPT` 已含「scope 必填无默认」**（v0.0.238 重写），三/四处消费方自动同源更新。

> consolidation.md 仍保留 evolvable=false 拒绝提示（`skill_manage.patch/disable/enable` + [v0.0.112] `memory_manage` 进化性写命中 non-evolvable 会被工具拒绝——不重试，跳过）。

### 6.1 待定

- 工具调用的部分失败处理（skill_manage 成功但 memory_manage 失败时的策略）
- fork-2 的 maxIterations 限制（防止整理 fork 过度调用工具）

> **fork-2 model（v0.0.51 v2 已 resolve）**：fork-2 **复用 session 当前 model**（不引入便宜 aux model）。模型选择的优化（如换 aux model 降成本）留待后续版本。
>
> **[v0.0.80.t1] fork-2 acquire tier1_consolidation 锁（实接）**：`MemorySkillConsolidationHandler.handle` 内部调 `ctx.taskLock.acquire(sid, 'tier1_consolidation', runId)` —— 锁失败静默 return（fire-and-forget 不阻塞），成功跑完后 `markDone` / 异常 `markFailed`（与 `compact` 锁对称）。spec `../session/[P0]session_task_lock.md §6` 实接完成。
