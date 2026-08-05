---
type: interface
title: Session Usage（类型 + 三分区 + view + ratio）
priority: P0
status: active
updated: 2026-08-01
since: v0.0.8
---

# Session Usage

> session 持有所有 usage 数据：**类型定义 + 接口（write/notify 分离）+ 三分区存储 + 递归上报 + 聚合 view + ratio**。context 只负责「何时更新（write ops）+ 何时通知（write 完成后 notify）+ char×ratio 估算」（见 `../context/[P0]context_usage_detail.md`）。
> ContextWindowUsage 类型（snapshot 的 context window 占用）见 `../context/[P0]context_snapshot_interface.md`；存储后端见 `[P0]session_store.md`。
>
> **[v0.0.44] write / notify 彻底分离**（本 KB 契约级变更，见 §3/§5/§6/§10）：`accumulateUsage` / `updateContextWindowUsage` 是**纯 write**（只写不 emit）；新增 `notifyUsageChanged(sid)` 独立方法：读 `getUsageView(sid)` 全量 view → emit `session_usage_update` 事件。参考 v0.0.27 `SessionMetaBroadcaster` 单点捕获先例。修正 v0.0.40 T6a（`e394bae`）暴露的「emit payload 不完整（accumulate emit 不带 cw）+ 顺序反转」联合 bug（session_usage 面板 UI 归 0）。

## 1. Usage 类型（LLM 一次调用的用量）

> **[v0.0.10 scope]**：Usage 类型（本节 9 token 字段 + char + cost + currency）**已在 `app/server/src/message/types.ts` 全字段落地**（移除 `[key:string]:unknown` 索引签名）；`CanonicalResponse.usage` 类型从 `Record<string,number>` 改为完整 `Usage`；`parseAnthropicUsage` 把 anthropic wire usage 映射到本节全字段（含 input_cache_read/write、input_no_cache、output_response 等）。**cost 计算由 `LlmClient` 边界完成**（computeCost 按 modelConfig.pricing 填 usage.cost + currency；**v0.0.13 S3 起 stream + call 两路同源**，见 `../providers_and_models/[P0]llm_client_interface.md §3.7`）。**[v0.0.14] `accumulateUsage` 已激活**（三分区累加 + 递归 sub + ratio 学习 + session_usage_update 真发 + getUsageView 真聚合，见 §10）。详见 `specs/tech/version_logs/v0.0.10/change_log.md §6` + `v0.0.14/change_log.md`。

token 为 **LLM 真实返回**，char 为 **估算基准**（学 ratio 用）。

```typescript
interface Usage {
  // ── token（LLM 真实返回）──
  input_cache_read: number;       // 命中缓存的输入 token
  input_cache_write: number;      // 写入缓存的输入 token
  input_no_cache: number;         // 未缓存的普通输入 token
  input_total_tokens: number;     // = cache_read + cache_write + no_cache
  output_response: number;        // 实际回复内容 token
  output_reasoning: number;       // 思维链 token
  output_total_tokens: number;    // = output_response + output_reasoning
  total_tokens: number;           // = input_total_tokens + output_total_tokens
  cost: number;                   // 金额（vendor 返回或框架算）
  currency?: Currency;            // 见 convention.md §5

  // ── char（估算基准，学 ratio 用）──
  inputCharCount: number;         // assemble snapshot 产出的 input char（system+messages+tools 序列化）= snapshot.inputCharCount
  outputCharCount: number;        // llm client 统计的 output char（LLM 实际输出的 char）
}
```

**char 两个来源**：
- `inputCharCount` —— **assemble 统计**（`snapshot.inputCharCount`，描述发给 LLM 的 input 占多少 char）
- `outputCharCount` —— **llm client 统计**（LLM 输出的 char）

> **[v0.0.13 S3 D3.1] outputCharCount 口径 = 纯 TextBlock 字符数**（最小确定口径）：agent loop stream 路径的 StreamConsumer 只累加 `StreamEvent.text_delta.text` 的字符数（按 JS string `.length`，UTF-16 code unit 计），**不含** `thinking_delta`（reasoning 不展示不统计）、`tool_call_delta`（arguments JSON 不算回复内容）、`tool_result`（tool 输出非 LLM 生成）。非流式 `call()` 路径：累加 `CanonicalResponse.message.content` 里 `TextBlock.text` 的字符数。理由：reasoning/tool_call 字符语义不确定（JSON 序列化口径/是否含推理痕迹随 provider 变），而 TextBlock 是「LLM 给用户的最终回复文本」，语义稳定可校准。
>
> **[v0.0.13 S3 D3.2] minimax pricing 币种 = CNY**：minimax 国内计费，modelConfig.pricing.currency 须配 `"CNY"`（见 `../providers_and_models/[P0]llm_model_interface.md §2 Pricing.currency`）。Anthropic / OpenAI 系默认 USD。client.computeCost 按 `pricing.currency` 产出原币种 cost（`llm_client_interface.md §3.5`）。**minimax pricing 实际单价是 config 数据**（非 spec 内容）：minimax provider 的 modelConfig record 须配 `pricing:{inputPerMillion, outputPerMillion, cacheReadPerMillion?, cacheWritePerMillion?, currency:"CNY"}`，具体数值在校准报告 `states/v0.0.13/verify/` 记录，不固化进 spec。

> char 与 token 同在 Usage 里，故 `ratio = input_total_tokens / inputCharCount` 可直接从单次 Usage 算；agent loop 构造 Usage 时填入（token←LLM 返回、inputCharCount←snapshot、outputCharCount←StreamConsumer/call 统计 TextBlock 字符数），accumulateUsage 无需额外传 charLen 参数。

## 2. AccumulatedUsage（累加版，同协议）

session 按分区累加，各字段 Σ（含 token + char + cost）。

```typescript
interface AccumulatedUsage {
  // 同 Usage 字段（token + char + cost），均为 Σ 累加值
  input_cache_read: number;
  input_cache_write: number;
  input_no_cache: number;
  input_total_tokens: number;
  output_response: number;
  output_reasoning: number;
  output_total_tokens: number;
  total_tokens: number;
  cost: number;
  currency?: Currency;
  inputCharCount: number;         // Σ input char
  outputCharCount: number;        // Σ output char
  llmCallCount: number;           // 该分区 LLM 调用次数
}
```

## 3. 接口（v0.0.44 write / notify 分离）

```typescript
type UsagePartition = "current" | "sub" | "forked";

interface SessionUsage {
  // ── 写（write ops，纯写不 emit）──
  /**
   * Σ 累加某分区（读该分区 + usage 各字段、llmCallCount++、写回）。
   * - type=current 时顺带学 ratio（§7，sample = input_total_tokens / inputCharCount）
   * - 有 parentSessionId → 递归以 sub 上报 parent（§6.2）
   * - **不 emit**：完成后由调用方在恰当时机调 notifyUsageChanged。
   * @returns 本次 write 涉及的 sid 链（含自身 + 递归 parent，顶层最后），供调用方 batch notify。
   */
  accumulateUsage(sessionId: string, type: UsagePartition, usage: Usage): Promise<string[]>;
  /** 更新 session 级 context window usage（assemble 后调；不递归；**不 emit**） */
  updateContextWindowUsage(sessionId: string, cw: ContextWindowUsage): Promise<void>;

  // ── 通知（read full view + emit，独立于 write）──
  /**
   * 读 `getUsageView(sid)` 全量聚合 → emit SessionEvent（`type=session_usage_update`,
   * `data=SessionUsageView`）到 EventHub（topic="session_panel", group=`session_id:<sid>`）。
   * write ops 完成后由调用方（context / agent loop）在恰当时机显式触发。
   * 为保证事件负载完整最新态，必须在 write 之后调 notify（先 write 再 notify）。
   */
  notifyUsageChanged(sessionId: string): Promise<void>;

  // ── 查询 ──
  /** 聚合视图（三分区 + total + contextWindowUsage） */
  getUsageView(sessionId: string): Promise<SessionUsageView>;
  /** 读当前 ratio（context 估算用） */
  getRatio(sessionId: string): Promise<number>;
}
```

> - accumulateUsage **不再有 charLen 参数** —— char 已在 `usage.inputCharCount` 里。
> - **write 与 notify 严格分离**：write ops 只写不 emit；notify 只读全量 view 再 emit。彻底消除「emit payload 缺字段（如 accumulate emit 不带 cw）」和「后一发 emit 覆盖前一发 emit」两类风险——每一发 event.data 都是当时 `getUsageView(sid)` 的完整值，与 GET /session/:id/usage 同一权威源。

---

## 4. 整体 picture（多 agent 层次统计）

一个系统可有多个 agent（顶层 + 子 + forked），每个持久化 agent = 一个 session，usage 按**层次**统计：

```
顶层 agent (session A, 无 parent)
├─ current: A 自己 loop 的数据
├─ sub: 子 agent 上报（B 内部递归以 sub 上报 A）
│  └─ 子 agent (session B, parentSessionId=A)
│     ├─ current: B 自己 loop
│     ├─ sub: B 的子 agent 上报
│     ├─ forked: B fork 出的（内存）
│     └─ B 全部数据 → session 内部递归以 sub 上报 A
└─ forked: A fork 出的 forked agent（内存，compact/memory）
```

三分区（相对一个 session）：
- **current**：该 session **自己 loop** 的数据
- **sub**：该 session 的**子 agent** 产生的所有数据（子 session 内部递归以 sub 上报 parent）
- **forked**：该 session **自己 fork 出**的 agent 的数据（forked 内存、compact/memory、不持久化）

> forked agent 只内存存在、无独立 session；其 accumulate 落到**发起者 session** 的 forked 分区。

## 5. session vs context 职责（各一句）

- **session**：usage 数据所有权 —— **write（三分区存储 + 递归上报 parent + ratio 学/存/查）** + **notify（读 `getUsageView(sid)` 全量聚合 → emit `session_usage_update`，独立于 write）** + 聚合 view。**write 与 notify 分离**（v0.0.44）：write ops 只写不 emit；notify 只读全量 view 再 emit，消除 payload 不完整风险。
- **context**：**何时 write**（assemble→updateContextWindowUsage、LLM 返回→accumulateUsage）+ **何时 notify**（write 完成后调 notifyUsageChanged）+ char×ratio 估算；**不知道 sub / 递归**（那是 session 内部）。

## 6. 身份规则 + 递归上报

### 6.1 context 调用规则（简单；不知道 parent / 递归）

context / agent loop 只调 accumulate / update 到**自己（或发起者）session**，**write 完成后调 notify**：

- **非 forked agent**（顶层或子 agent）：
  1. write：`updateContextWindowUsage(自己sid, cw)`（assemble 后）+ `const chain = accumulateUsage(自己sid, "current", usage)`（LLM 返回后；chain 含自身 + 递归 parent 全链）
  2. notify：**为 chain 中每个 sid 各调一次** `notifyUsageChanged(sid)`（顶层链上每层都通知，前端按 group 收自己的）
- **旁路 run（runKind=summary/consolidate，forked 分区）**（v0.0.204 口径修正）：
  1. write：**由 caller 按 run 结束总量一次性累计** `accumulateUsage(发起者sid, "forked", run总usage)`（**不经 lifecycle 逐调用累计**——`RunLifecyclePort.onUsage` 对 forked 桶 early return，防「逐调用 + 总量」双计；fork-1 在 `context-compact-runner.runCompact`，fork-2 在 `post-compact-consolidation.startConsolidation`；**不调 updateContextWindowUsage**）
  2. notify：caller `accumulateUsage` 拿到 sid 链后，对链上每个 sid 调 `notifyUsageChanged`（让 forked 分区增量即时可见，不依赖下一轮 main assemble）；同一 sid 多次 write 时 notify 一次即可（读 write 完成后最终 view）
- **tier2 三 run（公共全局整理）**：**零累计**——天级公共整理不摊到单个 session usage（用户裁决 v0.0.204）

**顺序契约**：write ops 全部完成 → notify（不允许 write 中间 notify——会读到不完整的中间态）。同一 sid 一轮内多次 write 时，notify 一次即可（读的是 write 全部完成后的最终 view）。

context 不知道 `sub`（sub 由 session 内部递归填充，见 §6.2）。

### 6.2 session 内部递归上报（accumulateUsage 实现内部）

`accumulateUsage(sid, type, usage)` 实现（**纯 write，不 emit**）：
1. 累加 `sid` 的 `type` 分区
2. **type=current 时学 ratio**（§7）
3. **if `sid` 有 `parentSessionId`** → 递归 `accumulateUsage(parentSessionId, "sub", usage)`（以 sub 上报 parent）
4. **返回 `string[]` = 本次 write 涉及的 sid 链**（含自身 + 递归 parent 全链，供调用方 batch notify）

**递归**：任何 accumulate（current/sub/forked）落到**有 parent 的 session**，都触发 `sub` 上报 parent 链，直到顶层（无 parent）。**发起者是 context（§6.1），递归上报是 session 内部逻辑，context 不参与**。**递归全程不 emit**——通知职责由 §6.1 的调用方按返回的 sid 链驱动。

> forked agent 内存无 session：其 `accumulate(发起者sid, "forked")` 落发起者 forked 分区；若发起者有 parent，发起者 session 内部仍以 sub 递归上报（统一规则）。sid 链首为发起者 sid，末为顶层 sid。
> `updateContextWindowUsage` **不递归**（只更新自己 session；forked 不调），也**不 emit**（v0.0.44 起 write ops 一律不 emit）。

## 7. ratio 学习（char/token；session 算/存/查）

ratio = input token / input char，用于 assemble 时估算 context window 占用（`context_usage_detail.md §3`）。

| 属性 | 值 |
|---|---|
| 学习时机 | `accumulateUsage(type="current")` 时 |
| sample | `clamp(usage.input_total_tokens / usage.inputCharCount, 0.2, 5.0)` |
| 窗口 | sliding 3，取中位数；窗口未满用 1.0（冷启动） |
| 存储 | `SessionUsageMeta.ratio`（RatioWindow，见 session_store.md §2） |

> **只有 current 分区学 ratio**（自己 loop 的真实 LLM 调用）；sub/forked 不学。assemble 估算时读 `getRatio`。

## 8. SessionUsageView（聚合视图）

```typescript
// [v0.0.16 spec drift 修正] 键名对齐真行为（session-store-types.ts:177-190）：
//   简写键 current/sub/forked/total（非全称键）+ ratio + contextWindowUsage? + 4 cacheRate。
//   每个分区 Record<string, number> = AccumulatedUsage 字段集合（store 序列化路径通用，
//   字段集合权威见 §2 AccumulatedUsage 接口）。
interface SessionUsageView {
  current: Record<string, number>;             // 自己 loop 累计（modeKey=current 累加）
  sub: Record<string, number>;                 // 子 agent 上报累计（递归 sub 累加）
  forked: Record<string, number>;              // forked agent 累计（compact 等）
  total: Record<string, number>;               // Σ 三分区（派生）
  ratio: number;                               // char→token 估算比率（sliding window=3 中位数，冷启动 1.0）
  contextWindowUsage?: ContextWindowUsage;     // 最近 assemble 的 context window 占用（v0.0.14 加；可空）
  // ── [v0.0.16] 派生字段（cacheRate，0-1 比率；UI 渲染为百分比）──
  currentCacheRate: number;     // current.input_cache_read / current.input_total_tokens（分母 0 返 0）
  subCacheRate: number;         // sub 同公式
  forkedCacheRate: number;      // forked 同公式
  totalCacheRate: number;       // total 同公式（按 total 三分区汇总后算）
}
```

- 三个分区（current/sub/forked）+ total（派生 = Σ）≡ 累加版 message Usage + char + `llmCallCount`，字段集合权威见 §2 AccumulatedUsage。
- `contextWindowUsage` = 最近 assemble 产物（assemble 后经 `updateContextWindowUsage` 写入）。
- **[v0.0.16] cacheRate**（4 个派生字段）：`cacheRate = input_cache_read / input_total_tokens`（分母 0 时返 0）；UI 表格「缓存」列直接读，0 用 muted 色、>0 用 accent 高亮（见 `specs/ui/components/chat-page/component-usage-panel.md`）。**AccumulatedUsage 不新增字段**——cacheRate 是派生值，view 聚合时算。
- **[v0.0.16 spec drift 修正]** 原 spec 写全称键（`currentAgentAccumulatedUsage` 等）是设计期理想形态，代码实际返简写键（v0.0.14 起真行为）。spec 对齐代码（代码是权威）。Record<string, number> 化对齐 store 通用序列化路径。

## 9. 存储 + 边界

三分区 AccumulatedUsage + RatioWindow + contextWindowUsage + `parentSessionId` 持久在 session。**parentSessionId 两处保持**（v0.0.28 multi_agent）：① `SessionUsageMeta.parentSessionId`（usage 递归 sub 上报用，见 §6.2）；② `Session.parentSessionId` 顶层（child 自查 parent 路由用，如 send_message('parent') 别名解析）。createSession 时顶层值同步写入 SessionUsageMeta，代码保证一致。详见 `[P0]session_store.md §2`。

| 零件 | 归属 |
|---|---|
| Usage / AccumulatedUsage 类型 + 接口（write / notify / query）+ 三分区存储 + 递归上报 + 聚合 view + notify（读全量 view emit event）+ ratio 算/存/查 | 本文（session）✅ |
| 何时 write（assemble / LLM 返回）+ 何时 notify（write 完成后） + 身份规则 | context（context_usage_detail §2） |
| context window 估算（char×ratio，读 getRatio） | context（context_usage_detail §3） |
| ContextWindowUsage 类型 + snapshot.inputCharCount | context_snapshot_interface |

## 10. accumulateUsage 激活状态（v0.0.14 已激活；v0.0.44 write/notify 分离）

**当前状态**（v0.0.14 起）：`SessionUsage.accumulateUsage` 在 SessionStore 实现中**已激活**（不再 no-op）。原 v0.0.13 S3 [D3.3] stretch 全部落地：

1. **三分区累加**：`accumulateUsage(sid, type, usage)` 按 §6 描述「读该分区 + 各字段 Σ + llmCallCount++ + 写回」 + §6.2 递归 sub 上报 parent + §7 type=current 时学 ratio。
2. **getUsageView 真聚合**：从 SessionUsageMeta 三分区 AccumulatedUsage + RatioWindow + contextWindowUsage 派生 `SessionUsageView`（§8）。
3. **session_usage_update 由 `notifyUsageChanged` 发**（v0.0.44 修正）：write ops（accumulate / updateContextWindowUsage）**不 emit**；`notifyUsageChanged(sid)` 读 `getUsageView(sid)` 全量聚合 → emit SessionEvent（`type=session_usage_update`, `data=SessionUsageView`），与 GET /session/:id/usage **同一权威源**（保证事件负载完整最新态、SSE ↔ REST 形状一致）。前端可订阅 `session_panel` topic 收到刷新。
4. **ratio 学习生效需 3 轮**：sliding window size=3（取中位数），窗口未满（前 3 次 current 分区 LLM 调用）期间 fallback 1.0（冷启动）。实测 minimax ratio 收敛至约 0.6009。
5. **agent loop 已接入调用**：LLM 返回 usage 后经 `ContextEngine` → `accumulateUsage(sid, "current", usage)` → 遍历返回的 sid 链 → 逐个 `notifyUsageChanged(sid)`（v0.0.44 起）。

> **[v0.0.44] write / notify 分离修正**：v0.0.40 T6a（`e394bae`）把 loop 中 `assemble→updateContextWindowUsage`（emit 带 cw）和 `accumulateUsage`（emit 不带 cw）的顺序调换，让「不带 cw 的 emit」成为最后一发，前端全量替换后 UI `contextWindowUsage` 归 0。根因不是顺序，是 write 与 notify 耦合、且 emit payload 缺字段（accumulate 没读 cw）。v0.0.44 起两操作彻底分开：write ops 只写不 emit；notify 独立读全量 view 后 emit——每一发事件的 `data` 都等于当时 `getUsageView(sid)` 返回，与 GET /usage 一致，无论调用顺序如何都不再有 payload 不完整的问题。

> **Run schema 加 per-run usage 字段仍 future**：v0.0.14 激活走「SessionUsageMeta 内存累计（持久化 meta 表）」，未给 Run record 加累计 usage 字段；崩溃恢复靠 SessionUsageMeta 持久化（meta 已落盘），不靠 Run record 重建。后续若需 per-run usage 视图再补 Run 字段。
>
> **[v0.0.235] `RunResult.usage`（`runReActLoop` 返回值，内存对象）已聚合每轮 callLLM usage**（修复 v0.0.40 T6a 起的回归——三条 return 曾硬编码 `{} as never`，导致 forked caller 拿到空 usage、forked 分区归 0）；但 **Run record 持久化 schema 仍不含累计 usage 字段**（future）；崩溃恢复仍靠 SessionUsageMeta 持久化。

## 11. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
