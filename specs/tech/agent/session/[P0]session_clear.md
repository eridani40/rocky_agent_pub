---
type: interface
title: Session Clear（清空内容保留实体）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.16
---

# Session Clear（清空会话内容，保留 session 实体）

> 主文档：`[P0]session_store.md`（存储 + SessionStore 接口）+ `[P0]session_state.md`（五态机 + summaryTask 旁路 CAS）。
> 本文定义 **clearSession(sid)**：清空 session 所有内容（transcript / summary / runs / usage / summaryTask / state），保留 session 实体（id / title / config）。
> 与 `DELETE /session/:id`（删整个 session）的职责边界见 §4。

## 1. 概述

**clearSession(sid)** —— 清空会话内容、回到空会话状态。语义：

- **保留**：`session.id` / `session.title` / `session.status`（active/archived）/ `session.createdAt` / `session.config`（providerId/modelId 等预绑定）/ `parentSessionId`（子 agent session 的父链不断，递归 sub 上报规则不变）。
- **清空**：transcript / summary / runs / usage 三分区 + RatioWindow + contextWindowUsage / summaryTask / state（重置 idle）。

> clear 用于「同一会话清空重来」场景（保留配置但不重建 session）；区别于 delete（销毁 session 实体，级联删一切）。

---

## 2. 接口

```typescript
interface SessionStore {
  /**
   * 清空 session 内容（保留实体）。同步原子。
   *
   * 前置：caller 已处理并发（abort current run + markSummaryFailed if compact in-flight），见 §5。
   * 后置：session 内容清空、state=idle、summaryTask=idle；store 内部 emit 三事件
   *       （session_status_update / session_usage_update / messages_cleared），见 §5.4。
   *
   * @returns 重置后的 session（含新 state=idle + summaryTask=idle + 零 usage）
   */
  clearSession(sessionId: string): Promise<Session>;
}
```

> clearSession 内部用**单事务**串行清空所有内容（避免部分清空中间态被外部读到）。底层实现可用 SchemaDef 的事务边界（详见 `../../persistence/`），或单次 multi-statement。
>
> **[v0.0.16 spec drift 修正]** 原 spec 设计期写「emit 事件是 caller 职责，非 store 内部」，但代码实现 `session-clear-op.ts:clearSessionStoreOp` 在 store 层 emit 三事件（对齐 stateMachine 现有「store 内 state 变化→emit」模式，与 markRunning/markInterrupted 等同构）。spec 对齐代码（代码是权威）：store 内 emit 更准确、调用方少一步漏 emit 风险、与其它 state 变更 op 一致。

---

## 3. 清理范围表

| 范围 | 清理动作 | 重置后值 |
|---|---|---|
| **transcript** | `DELETE FROM message WHERE sessionId=:sid`（含 raw / tool_result offload 的也级联删） | 空 `[]` |
| **summary**（SummaryInfo 单值） | `setSummary(sid, { version:0, summaryUpTo:null, content:null })` | `version=0 / summaryUpTo=null / content=null` |
| **runs** | `DELETE FROM run WHERE sessionId=:sid` | 空 `[]` |
| **usage.AccumulatedUsage 三分区**（current/sub/forked） | 每个 AccumulatedUsage 所有字段置 0（token/char/cost/llmCallCount=0） | 全零 AccumulatedUsage |
| **usage.RatioWindow** | `set ratio.samples=[], ratio.current=1.0`（冷启动值） | 冷启动 |
| **usage.contextWindowUsage**（ContextWindowUsage） | 置零：`{systemTokens:0, messageTokens:0, toolTokens:0, totalTokens:0, maxOutputTokens:20000, tokenLimit: <保留 modelConfig.contextWindow>, remainingTokens: tokenLimit-0-20000}` | 零占用 |
| **summaryTask** | `markSummaryIdle(sid)`（无条件重置；CAS WHERE status=running 兜底） | `status=idle, runId=null, startedAt=null, error=null` |
| **session.state**（五态机） | 重置 `idle`（强制，不走 CAS——caller 已在 §5 预 abort） | `state=idle, running=false, currentRunId=null` |
| **session.updatedAt** | `now()` | 新时间戳 |

> **`tokenLimit` 不清零**：它来自 modelConfig（非累加值），保留以备 UI 首屏展示（圆环 0/tokenLimit，例 0/200000）。

---

## 4. clear vs delete（职责边界）

| 维度 | `clearSession(sid)` | `DELETE /session/:id`（deleteSession） |
|---|---|---|
| session 实体 | **保留**（id/title/status/config/createdAt/parentSessionId 不变） | **删除**（整个 session 行 + 级联所有内容） |
| 内容 | 清空（transcript/summary/runs/usage/summaryTask/state） | 删除（连同 session 一起级联删） |
| 后续可见性 | session 仍在列表，对话区显 empty-state | session 从列表消失 |
| 用途 | 「清空重来」（保留配置） | 「删整个会话」（彻底销毁） |
| 端点 | `POST /session/:id/clear`（200，同步原子） | `DELETE /session/:id`（204，级联删） |

---

## 5. 并发处理（caller 编排前置；store 内 emit，MANDATORY）

clear 是同步原子操作，但**前置**必须处理可能正在跑的 run / compact，避免悬空状态：

```
clearSessionFlow(sid):
  ┌─ 1. 若 session.state ∈ {running, interrupting}（有活跃或收尾中 run）：
  │     - POST /session/:id/abort（4 步收尾，详见 agent_interrupt §2）
  │       · 校验 (runId, modeKey="current") 命中 agentRuns map
  │       · state: running → interrupting → interrupted；currentRunId=null
  │     - 等 state 转 interrupted（poll 100ms × N，超时 fallback 强制清空）
  │
  ├─ 2. 若 summaryTask.status === "running"（compact 进行中）：
  │     - markSummaryFailed(sid, { error: "cleared" })（CAS WHERE status=running）
  │     - 清 forked agent buffer（bus.clearReplay(`session_id:${sid}_amt:summary`)）
  │     - （forked agent 无副作用，仅状态标 failed 即可）
  │
  ├─ 3. sessionStore.clearSession(sid)（§2 接口，单事务清空 §3 全部范围）
  │     - 内部强制重置 state=idle（不走 CAS；caller 已在 1/2 预清理）
  │     - [v0.0.16] 内部 emit 三事件（store 层，对齐 stateMachine「store 内 state 变化→emit」模式，
  │       详见 session-clear-op.ts:clearSessionStoreOp step4；与 markRunning/markInterrupted 同构）
  │
  └─ 4. emit 事件（store 内部，非 caller 职责）：
        - session_status_update(state=idle, running=false, currentRunId=null)
        - session_usage_update（零 SessionUsageView）
        - messages_cleared（前端清对话区，避免逐条 message_deleted）
```

> **为什么 clear 前必须 abort**：若不 abort 直接清 transcript，活跃 AgentLoop 还在写 buffer → 清空后又被 loop 写回 → 内容残缺。abort 4 步收尾保证 loop 退出（state→interrupted）后再清，无并发写入。
>
> **[v0.0.16] emit 归属**：原 spec 设计期写「emit 是 caller 职责」，代码实际在 store 层 emit（与 stateMachine 既有模式一致）。spec 对齐代码。caller 编排（§5 step1/2 abort + markSummaryFailed）不在 store 内，emit 仍在 store 内——store 负责 state 变化的 emit，caller 负责编排触发，职责清晰。

> **force 语义（可选）**：`POST /session/:id/clear` body 支持 `{ force?: boolean }`（默认 false）。force=true 时跳过 §5.1 等 abort 收尾（直接强制清空 + 重置 idle），用于调试 / 紧急清理；生产路径不用 force。

---

## 6. 状态转换

```
  (任意 state)                                 idle（重置）
     │                                            ▲
     ├─ §5.1 abort（若 running/interrupting） ──► interrupted
     │                                            │
     └─ §5.2 markSummaryFailed（若 compact） ──► (summaryTask=failed)
                                                  │
                              clearSession(sid) ──┘
                              （强制重置 state=idle + summaryTask=idle）
```

clear 后：`session.state=idle, running=false, currentRunId=null, summaryTask.status=idle`，等同新建 session 但保留 id/title/config。前端对话区显 empty-state，usage 圆环归零。

---

## 7. 边界

| 零件 | 归属 |
|---|---|
| clearSession 接口定义 + 清理范围表 + clear vs delete 边界 | 本文 ✅ |
| clear 前并发处理（abort + markSummaryFailed）的编排 | 本文 §5（caller 编排，复用既有 API） |
| clear 内部 emit 三事件（session_status_update / session_usage_update / messages_cleared） | 本文 §5.4（store 内 emit，对齐 stateMachine 模式） |
| clear 内部事务 / SchemaDef 落盘 | `../../persistence/` |
| abort 4 步收尾（被 §5.1 复用） | `../agent_interface_and_loop/[P0]agent_interrupt.md §2` |
| summaryTask CAS（被 §5.2 复用） | `[P0]session_state.md §3a` |
| HTTP 端点契约（POST /session/:id/clear） | `specs/api/overall/04-agent-session.md §8` |
| UI 确认交互（modal + clear-btn） | `specs/ui/components/chat-page/component-usage-panel.md` |

---

## 8. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
