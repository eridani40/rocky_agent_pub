# v0.0.44 Tech Change Log — SessionUsage write / notify 分离

> version: 1.0 · 2026-07-01
> 范围：`SessionStore` 契约级改造——`accumulateUsage` / `updateContextWindowUsage` 变纯 write（不 emit）；新增独立通知方法 `notifyUsageChanged(sid)`（读 `getUsageView(sid)` 全量 view → emit `session_usage_update`）。**纯后端契约调整，无对外 HTTP API 变更**（GET /session/:id/usage 形状不变；SSE `session_usage_update` 事件形状不变，只是发送时机与来源统一到 notify）。
> 需求：`reqs/v0.0.44.session_usage_zero/req.md`
> 参考先例：v0.0.27 `SessionMetaBroadcaster` 单点捕获（读全量 record 再广播，避免各 write 点自造 payload 缺字段）。
> 验证：typecheck ✅；`bun run test` 3682/3686（1 flaky 无关，单跑绿）；code review PASSED（`states/v0.0.44/verify/review/code-review-task123.md`）。

---

## 1. 修复的 bug

**现象**：一次真实 LLM 对话回合完成后（不刷新页面），顶栏 usage 面板 `usage-num` 跳成 `0/0`；展开面板 `contextWindowUsage` 各字段全 0；累积消耗表格（三分区 input/output）**仍然正常增长**——只有 context window 分区归 0。刷新页面后（重新 GET /usage）恢复正常，直到下一轮对话再度归 0。

**根因**（契约层漏洞，非 loop 顺序）：

- `session_usage_update` 事件历来在两个 write op 完成后各自 emit：
  - `accumulateUsage` → emit **不带 cw** 的 view（`emitUsageUpdate(sid, meta)`）
  - `updateContextWindowUsage` → emit **带 cw** 的 view（`emitUsageUpdate(sid, meta, cw)`）
- `deriveUsageView(meta, cw?)` 对 undefined cw **不写入** `view.contextWindowUsage`（`session-usage-helper.ts:297`）。
- 前端 reducer 是**全量替换**（`use-session-run-state.ts:184-187`）——最后一发若缺 cw，UI 就归 0。

**触发线**：v0.0.40 T6a（提交 `e394bae`）把新 `runReActLoop` 骨架里的 `recordAssistant`（内部 assemble → updateContextWindowUsage，emit 带 cw）与 `onUsage`（accumulateUsage，emit 不带 cw）**顺序调换**，让「不带 cw 的 emit」成为最后一发。这不是根因，只是让潜藏漏洞显性化——只要两个 write 路径的 emit payload 有一个不完整，前端全量替换后就会归 0。

**根治**：契约层把 write 与 notify 彻底分开——write ops 只写不 emit；notify 独立读全量 `getUsageView(sid)` 后 emit。**无论 write 顺序如何、无论未来加多少 write op，事件负载永远是当时全量 view，与 GET /usage 同一权威源**。参考 v0.0.27 `SessionMetaBroadcaster` 先例（session_meta 广播也是「变更信号 → 读全量 view emit」而非「各 write 点自造 payload」）。

---

## 2. 契约变更（SessionStore）

### 2.1 `accumulateUsage` 签名变更（Breaking）

```diff
- accumulateUsage(sid, type, usage): Promise<void>
+ accumulateUsage(sid, type, usage): Promise<string[]>
```

- 语义：Σ 累加分区 + [仅 current] 学 ratio + 有 parentSessionId 递归 `sub` 上报——**行为不变**，唯一新增「返回 sid 链」（自身 + 递归 parent 全链，顶层最后）。
- 语义变更：**内部不再 emit** `session_usage_update`（原 step4 `emitUsageUpdate` 移除）。
- 调用方职责：`chain.forEach(sid => notifyUsageChanged(sid))`——顶层链每层都通知，前端按 group `session_id:<sid>` 收自己的。
- 容错：session 不存在时返回空数组（无 sid 需 notify）。

### 2.2 `updateContextWindowUsage` 语义变更

- 签名不变（`Promise<void>`），行为改为**纯 write**——**不再 emit** `session_usage_update`。
- 调用方职责：write 完成后为当前 sid 调 `notifyUsageChanged(sid)`；若与 accumulate 在同一轮，可与 accumulate 的 sid 链合并到最后一次 batch notify（同一 sid 一轮内 notify 一次即可）。

### 2.3 新增 `notifyUsageChanged(sid): Promise<void>`

```typescript
notifyUsageChanged(sessionId: string): Promise<void>
```

- 内部：读 `getUsageView(sid)` 全量聚合（三分区 + total + ratio + contextWindowUsage + 4 cacheRate）→ 构造 `SessionUsageUpdateEvent{ type: 'session_usage_update', data: SessionUsageView }` → statusBus emit 到 `(session_panel, session_id:<sid>)`。
- 静默 no-op：session 不存在或 statusBus 未注入时。
- **权威一致性**：走 `getUsageView` 与 GET /session/:id/usage 同一路径，保证 SSE ↔ REST 每一发字段级相等。

### 2.4 顺序契约

- **write ops 全部完成 → notify**（不允许 write 中间 notify——会读到不完整的中间态）。
- 同一 sid 一轮内多次 write 时 notify 一次即可（读的是最终 view）。
- 调用点自行决定 notify 时机；session-store 不做批处理调度。

---

## 3. 调用点收敛（4 处）

所有 SessionStore usage write 调用点收敛为「write → chain notify」两步：

| 调用点 | 文件 | 变更 |
|---|---|---|
| current agent loop LLM 返回 usage | `agent/context-port.ts` `MainLifecyclePort.onUsage` | `const chain = accumulateUsage(sid, 'current', usage); for (const s of chain) await notifyUsageChanged(s)` |
| forked agent loop LLM 返回 usage | `agent/forked-context-port.ts` `ForkedLifecyclePort.onUsage` | 同上（type='forked'，chain 含发起者 + 递归 parent） |
| current recordAssistant / recordToolResult / drainInboxIfAny / recordAssistant 内 tryCompact fresh assemble | `agent/context-port.ts` `MainContextPort.*` | assemble 后（内部触发 `updateContextWindowUsage` 纯 write）追一发 `notifyUsageChanged(sid)` |
| context-compact-runner forked 累计 | `agent/context-compact-runner.ts` `runCompact` | `const chain = accumulateUsage(sid, 'forked', usage); for (const s of chain) await notifyUsageChanged(s)` |
| （v0.0.40 之后已迁走的旧路径）`agent-loop-stage-llm.ts` `stageLLMRequest` | `agent/agent-loop-stage-llm.ts` | 同步改造：LLM 返回后 `accumulateUsage → chain notify`；ingestAndAssemble 后 `notifyUsageChanged(sid)`（本文件在 v0.0.40 后续 dev 场景仍存在，改造保持契约一致） |

`ContextEngine.assemble` 内部本就调 `store.updateContextWindowUsage`（纯 write）——本次不改 assemble；改的是 assemble 调用点（context-port 各方法）在 assemble 完成后追补 notify。

---

## 4. 关键设计原则（本次沉淀）

1. **write / notify 严格分离**——write ops 只写不 emit；通知走独立方法读全量 view emit。彻底消除「emit payload 缺字段」和「后一发覆盖前一发」两类风险。
2. **调用方按 sid 链驱动 notify**——`accumulateUsage` 返回递归全链（含自身 + parent），调用方 `chain.forEach(notify)`；顶层链每层都通知，前端按 group 各收自己的。
3. **事件负载 = getUsageView 全量**——每一发 `session_usage_update.data` 都是当时 `getUsageView(sid)` 返回，与 GET /session/:id/usage **同一权威源**，SSE ↔ REST 逐字段相等。
4. **顺序契约由调用方保证**——同一 sid 一轮内 write 全部完成再 notify 一次；session-store 不做批处理调度。
5. **参考 v0.0.27 `SessionMetaBroadcaster` 先例**——广播路径同样「变更信号 → 读全量 view emit」而非「各 write 点自造 payload」。

---

## 5. 涉及代码

**产品代码**（`app/server/src/agent/`）：

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `session-store.ts` | 契约变更 | `accumulateUsage` 返回 `Promise<string[]>` + 移除内部 emit；`updateContextWindowUsage` 移除内部 emit；新增 `notifyUsageChanged`；私有 `emitUsageUpdate` 删除（能力搬到 `notifyUsageChanged`） |
| `context-port.ts` | 调用点收敛 | `MainLifecyclePort.onUsage` chain notify；`MainContextPort.recordAssistant/recordToolResult/drainInboxIfAny` 及 tryCompact fresh assemble 补 `notifyUsageChanged(sid)` |
| `forked-context-port.ts` | 调用点收敛 | `ForkedLifecyclePort.onUsage` chain notify |
| `context-compact-runner.ts` | 调用点收敛 | `runCompact` 累计 forked 后 chain notify |
| `agent-loop-stage-llm.ts` | 调用点收敛 | 保持契约一致（历史路径） |

**测试**（`app/server/src/agent/__tests__/`）：

| 文件 | 变更 |
|---|---|
| `session-usage-event.test.ts` | 断言 write ops 静默不 emit + `notifyUsageChanged(sid)` 后 emit 一次事件 + `data === getUsageView(sid)` + 递归 sub 场景每层都收 |
| `agent-loop-stage-llm-eos.test.ts` | 适配 `accumulateUsage` 新签名 |
| `forked-agent.test.ts` | 适配 forked chain notify |

**Spec 文档同步**：

| 文件 | 变更 |
|---|---|
| `specs/tech/agent/session/[P0]session_usage.md` | §3 接口 write/notify 分离；§5 职责表；§6 调用规则；§9 边界表；§10 激活状态；`updated: 2026-07-01` |
| `specs/tech/agent/session/[P0]session_store.md` | §3 usage 接口签名 + notifyUsageChanged；`updated: 2026-07-01` |
| `specs/tech/agent/session/[P0]session_event.md` | producer / §1 定位 / §3 触发时机表 / §3a.4 broadcaster 表 —— 全部改为 `notifyUsageChanged` 触发 |
| `specs/tech/agent/session/log.md` | 顶部 v0.0.44 条目（已在编码期落） |
| `specs/tech/agent/context/[P0]context_usage_detail.md` | §2 时机表增加 notify 行 + 身份规则改 chain notify；`updated: 2026-07-01` |

---

## 6. 追溯

- **暴露 bug 的 commit**：`e394bae`（v0.0.40 T6a 顺序调换）——非根因，只是让契约层漏洞显性化。
- **修复层级**：契约层（session_usage 接口）——**不修 loop 顺序、不修前端 reducer、不修 deriveUsageView 内部逻辑**。这三个都是补丁式修复，下次多加一个 write op 就要重复补。
- **UT 覆盖**：write 静默 + notify emit 一次 + 事件 data 与 getUsageView 逐字段相等 + 递归 sub 每层收到独立事件（`session-usage-event.test.ts`）。

---

## 7. 非 target

- 不改前端 reducer（全量替换是 v0.0.27 刻意设计——server 侧修完后每一发 event.data 都完整，reducer 无需变）。
- 不改 `run-react-loop` 的 recordAssistant/onUsage 顺序（顺序合理；分离后无论顺序如何都不再有 payload 不完整问题）。
- 不改 `deriveUsageView` 内部逻辑（cw 缺失时不写字段仍合理——历史 session 可能真没 cw；notify 时读的是 record 里的 cw，兜底逻辑与 GET /usage 完全一致）。
- 不引入 batch/debounce notify 调度（同 sid 一轮 notify 一次由调用方自行保证；框架不掺和）。
