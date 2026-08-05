---
type: spec
title: Agent Loop — Lazy-Drain Mode（外循环 drain，P2 future）
priority: P2
status: draft
updated: 2026-07-20
since: v0.0.16
---

> **⚠️ 概念未落地**：截至 v0.0.180，lazy-drain 仅为设计概念，代码中无任何实现（零匹配 `LazyDrain`）。保留作 future 参考。

# Agent Loop — Lazy-Drain Mode（外循环 drain）

> **[v0.0.40] 对齐说明**：本 spec 为 P2 future 概念稿，仍按 v0.0.40 前的「策略类 + Agent interface(run/activate/enqueue)」框架描述。v0.0.40 协议瘦身后，lazy-drain 落地形态将是**第三份 deps 装配**（`buildLazyDeps`，配合统一骨架 `runReActLoop(spec)`，见 `[P0]agent_loop_unified.md §4`）——v0.0.49 起 `drainMode='lazy'` 三态枚举预留（spec 已定义，未实现）：骨架在 run 结束时 peek inbox（`drainMode='lazy'` 路径）触发外循环重启（而非单 run 内每轮 drain）。下方对「LazyDrainAgent 类 / activate / enqueue」的描述应理解为「`buildLazyDeps` 装配出的 lazy RunSpec 行为契约」，drain timing 不变量（run 内不 re-drain）是本 mode 真正的契约核心。

> 定位：**主对话执行引擎的另一种 drain 模型**（P2 future — 概念定稿，等待落地）。外循环驱动 drain，run 内不再 drain；每次 inbox 非空就跑一个 runLoop，多 runLoop 跨多次 inbox drain。
> 参见：[P0]agent_interface.md（单 run 契约）、[P0]agent_loop_unified.md（统一骨架 + 4 port，v0.0.40 权威）、[P0]agent_manager.md（门面调度）、[P0]agent_loop_base.md（机制原语）、[P0]agent_loop_eager_drain.md（current 不变量对照）、[P0]agent_interrupt.md（中断）

---

## 1. 定位与对照

LazyDrainAgent 与 EagerDrainAgent 都属于「主对话 loop」分类（写 store / 转状态机 / compact），**唯一差异在 drain timing**：

| 维度 | eager-drain（默认） | lazy-drain（本 mode） |
|------|--------------------|---------------------|
| **drain 时机** | 同 1 个 run 内每轮 iteration 开头 | run 内不 re-drain；run 结束若 inbox 非空再起新 runLoop |
| **用户插话** | 当前 run 内下一轮 LLM call 前就能感知 | 当前 run 完整结束后下一轮 runLoop 才感知 |
| **总 run 数** | 1 个 run 处理本批所有消息 | 跨 N 个 runLoop（每个 runLoop 处理本批消息时的状态） |
| **适用场景** | 实时交互、用户可能中途插话 | 严格回合制、避免上下文中途扩展 |
| **同 inbox 多消息** | 同一 run 中 LLM 看到全部消息 | 每 runLoop 单独读取本批，runLoop 间状态独立 |

> 「严格回合制」对照：用户消息 + agent 一轮回复构成一回合，agent 回复期间用户的新消息不影响本回合；本回合结束后才进入下一回合。eager-drain 在 tool 多轮中允许用户插话扩展当前 run；lazy-drain 把每次 inbox→回复封闭为独立 runLoop。

---

## 2. LazyDrainAgent 类

```typescript
class LazyDrainAgent implements Agent {
  /**
   * run(): ❌ NotSupportedError（lazy-drain 不支持独立 run，使用 enqueue + activate）
   */
  run(): never {
    throw new NotSupportedError("lazy-drain does not support run(); use enqueue + activate");
  }
  
  /**
   * activate(): 启动外循环 + 内部 runLoop。
   * - 外循环：while (inbox.peek(sid).length > 0 && !controller.aborted) runLoop(false)
   * - 每个 runLoop 复用 eager-drain 的 AgentLoop（构造时设 allowContinuousInboxRead: false）
   * - 共享同一 AgentRun（runId 不变），runLoop 间累计 stopReason
   */
  async activate(config: SessionConfig, deps: ActivateDeps): Promise<AgentRun>;
  
  /**
   * enqueue(): 委托 inbox.append（同 EagerDrainAgent）
   */
  async enqueue(config: SessionConfig, messages: Message[]): Promise<string[]>;
  
  /**
   * cancel(): 委托 inbox.appendCancel（同 EagerDrainAgent）
   */
  async cancel(sessionId: string, enqueueId: string): Promise<void>;
}
```

> **中断不在策略类**：abort 由 AgentManager 统一处理（同 EagerDrainAgent，agent_interface.md v1.1 去掉 abort 方法）。详见 `[P0]agent_manager.md §3` + `[P0]agent_interrupt.md §3`。

---

## 3. 循环结构

```
activate() → 外循环：
  while (true):
    ⚡ controller.aborted → break
    if (inbox.peek(sessionId).length === 0): break
    runLoop(allowContinuousInboxRead: false)
    // runLoop 内：drain 一次 → ⓪ ① ② ③ ④ → run_end
  // 退出：state=idle 或 interrupted（取决于 controller.aborted）
```

**runLoop 实现**：复用 eager-drain 的 AgentLoop 类，构造时设 `allowContinuousInboxRead: false`。每次 runLoop 是一次完整的 ReAct 循环（同 eager-drain），但 ① drain 只在首轮执行，后续 iteration 不 re-drain。

### 3.1 AgentRun 模型（共用同一个 run）

**设计选择**：整个 activate 调用对外返回**一个 AgentRun**（一个 runId），内部跨多个 runLoop：

```
AgentRun.runId = 整个 activate 周期的统一 ID
内部多个 runLoop 共享此 runId（每个 runLoop 对应一次 inbox drain + ReAct 闭环）
AgentRun.promise 等到所有 runLoop 结束（inbox 空 或 controller.aborted）才 resolve
AgentRun.state：running → completed（最后一个 runLoop 自然结束）/ interrupted（任一 runLoop 被中断）
stopReason：取最后一个 runLoop 的 stopReason；中断时为 "interrupted"
```

> 替代方案（每个 runLoop 独立 AgentRun，外循环创建多个）的缺点：caller 需追踪多个 runId，abort 语义复杂（abort 第几个？）。采用「一个 AgentRun + 内部多 runLoop」模型简化 caller 视角。

---

## 4. 适用场景

- **严格批处理（batched）流**：每批消息一次性处理完，下批再来
- **避免用户插话扩展当前 run 的上下文**：tool 多轮执行期间用户插话不会被「就近」消化
- **简化中断模型**：每个 runLoop 单独可中断，inbox 残留消息下次 runLoop 自然消费

---

## 5. 与 eager-drain 共享部分

LazyDrainAgent 与 EagerDrainAgent 高度同构，仅 drain timing 不同：

| 共享项 | 说明 |
|--------|------|
| **中断模型** | `controller.aborted`（单条件，同 eager-drain §9） |
| **store 游标** | `ingestUpTo / llmUpTo`（同 eager-drain §8） |
| **AgentLoop 类** | 完全复用（构造时设 `allowContinuousInboxRead: false`） |
| **emit groupKey** | `session_id:<sid>_amt:current`（与 eager-drain 共用 current group，agent_interface.md §4） |
| **副作用策略** | 同 eager-drain §7（ingest / compact / accumulateUsage / state machine / emit 全开） |
| **state machine** | run_end 写 markIdle / markError（CAS）；中断走 markInterrupting → markInterrupted |
| **cancel 配对** | drain 同批 message+cancel 配对作废（eager-drain §5.2） |

**唯一差异**：

| 差异项 | eager-drain | lazy-drain |
|--------|-------------|------------|
| **AgentLoop.start() 编排** | `runLoop(true)` 单次（内部每轮 drain） | `while (inbox.peek>0) runLoop(false)`（外层 drain） |
| **drain 时机** | 每轮 iteration 的 ① | 仅 runLoop 首轮的 ① |
| **多消息处理** | 同 run 内累计 | 跨 runLoop 分批 |

---

## 6. 落地路径（future）

实施步骤（v0.0.16 后某版本）：

1. AgentLoop.start() 内的 normal 模式分支（eager-drain §5.1 已预留 `inboxHandleMode === "normal"` 走外层 while）实际激活
2. AgentManager.agentByMode 路由 `lazy-drain` → LazyDrainAgent 实例
3. SessionConfig.loopMode 文档补 "lazy-drain" 启用方式
4. 测试：批处理场景（multi-message inbox），验证跨 runLoop 状态独立

---

## 7. （版本史见 `log.md`）