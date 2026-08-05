---
type: interface
title: Context Engine — usage（调用时机 + context window 估算）
priority: P0
status: active
updated: 2026-07-06
since: v0.0.8
---

# Context Engine — usage（调用时机 + context window 估算）

> 主文档：`[P0]context_engine.md`。usage 的 **view / 存储 / 聚合 / 通知归 session**（`../session/[P0]session_usage.md`）；本文只管 context 的两点职责：① 调用 accumulate/update 的时机；② context window usage 估算（含 ratio）。
> 类型（AccumulatedUsage / ContextWindowUsage / Usage）见 `[P0]context_snapshot_interface.md`。

> **cache 字段语义统一为「比率」**：UI / spec 表达「缓存率」时一律用比率（0-1 小数，UI 渲染为百分比），公式 `cacheRate = cache_read_tokens / input_total_tokens`。session 侧 `AccumulatedUsage` 不另增字段（直接从 `input_cache_read / input_total_tokens` 派生），`SessionUsageView` 三分区各加派生字段 `cacheRate`（见 `../session/[P0]session_usage.md §8`）。
>
> **assemble 读 `store.getRatio(sessionId)`**（不再硬编码 1.0）：assemble 估算 context window usage 时调 `session.getRatio(sessionId)` 读真实 ratio（v0.0.14 学满 3 轮收敛至约 0.6009，冷启动 1.0）；ContextWindowUsage 7 字段全激活（systemTokens / messageTokens / toolTokens 分别 char × ratio 估算，详见 `context_snapshot_interface §2`）。

## 1. context 的 usage 职责（两点）

context（ContextEngine）**不持 usage view / 不存储 / 不通知**（那些归 session，见 session_usage）。它只做：

1. **调用时机**：何时调 session 的 `accumulateUsage` / `updateContextWindowUsage`（§2）
2. **context window usage 估算**：char×ratio 估算 + ratio 学习（§3/§4）

## 2. 调用 accumulate / update / notify 的时机（v0.0.44 write/notify 分离）

| 时机 | 调 session | 说明 |
|---|---|---|
| assemble 后 | `updateContextWindowUsage(sessionId, snapshot.contextWindowUsage)` | 每次 assemble 产出 snapshot，更新 session 级 context window usage；**纯 write，不 emit** |
| LLM 返回（current agent loop，非 forked） | `const chain = accumulateUsage(sessionId, "current", usage)` | 当前 session 累加 current 分区；session 内部学 ratio（usage 已含 inputCharCount）；**纯 write，不 emit**；返回递归上报的 sid 链（含自身 + parent 全链） |
| LLM 返回（sub agent） | `const chain = accumulateUsage(sessionId, "sub", usage)` | sub 分区；不学 ratio；同样返回 sid 链 |
| LLM 返回（forked agent，compact/memory） | `const chain = accumulateUsage(发起者sid, "forked", usage)` | forked 分区；不学 ratio；同样返回 sid 链 |
| **write ops 完成后**（v0.0.44 MANDATORY） | 遍历 `chain` 每个 `sid` 逐个调 `notifyUsageChanged(sid)` | 独立 notify：读 `getUsageView(sid)` 全量 view → emit `session_usage_update`；顶层链每层都通知（前端按 group 收自己的） |

- `accumulateUsage(type, usage)` 由 **agent loop** 在 LLM 返回后调（type 按自身类型；usage 已含 inputCharCount，type=current 时 session 内部学 ratio）—— context engine 无此入口
- `updateContextWindowUsage` 由 **context engine** 在 assemble 内部调（assemble 产出 snapshot 后自动）
- **[v0.0.44]** write ops 静默不 emit——**调用方必须在 write 完成后显式触发 `notifyUsageChanged`**：`accumulateUsage` 返回的 sid 链（`string[]`：自身 + 递归 parent，顶层最后）**每个 sid 都要 notify 一次**，`updateContextWindowUsage` 后只需为当前 sid notify 一次。若同一轮既 update 又 accumulate，同一 sid 合并到最后一次 batch notify 即可（不允许 write 中间 notify——会读到不完整的中间态）。
- 两者都是调 session 的更新接口；context engine 不暴露任何 usage 方法（view / 通知全在 session）

**身份规则**（context 视角，简单；递归上报归 session，见 `session_usage.md §6.1`）：
- **非 forked agent**（顶层或子 agent）→ write：`updateContextWindowUsage(自己sid, cw)` + `const chain = accumulateUsage(自己sid, "current", usage)`；notify：`chain.forEach(sid => notifyUsageChanged(sid))`
- **forked agent** → write：`const chain = accumulateUsage(发起者sid, "forked", usage)`（**不调 updateContextWindowUsage**）；notify：`chain.forEach(sid => notifyUsageChanged(sid))`
- context 不知道 `sub` 分区（sub 由 session 内部递归上报 parent 填充）

## 3. context window usage 估算（char × ratio）

ContextWindowUsage（定义见 context_snapshot_interface §2，7 字段）用 char × ratio 估算，不依赖 tokenizer：

```
estimateTokens(content) = content.length (char) × ratio
  ratio          = session.getRatio(sessionId)   // [v0.0.16] 读真值（不再硬编码 1.0）
  systemTokens    = estimateTokens(systemString)
  messageTokens   = Σ estimateTokens(msg)
  toolTokens      = estimateTokens(tools 序列化)
  totalTokens     = system + messages + tools   // input 侧
  maxOutputTokens = appConfig.context.maxOutputTokens ?? 20000   // estimated output（见下注）
  tokenLimit      = config.client.contextWindow
  remainingTokens = tokenLimit − totalTokens − maxOutputTokens
```

- **token 真实值由 LLM 返回**（UsageBlock）；char×ratio 仅用于 assemble 时估算当前 snapshot 占多少 token
- LlmClient **不估算 token**（无 countTokens）
- **[v0.0.16]** ratio 从 `session.getRatio(sessionId)` 读真值（v0.0.14 三轮收敛后 ≈ 0.6009，冷启动 1.0）。原 v0.0.8 硬编码 1.0 已废弃。

> **[v0.0.81.compaction_bug] maxOutputTokens 字段语义澄清**：`ContextWindowUsage.maxOutputTokens` = **estimated output 估算输出常量**（默认 20000，`app_config.context.maxOutputTokens` 可覆盖；常量源 = `app/server/src/agent/session-usage-helper.ts` `DEFAULT_MAX_OUTPUT_TOKENS=20000`）。**非 model maxOutput，不随 model 变**。字段名保留不改（持久化 record + SSE schema 兼容）。**消费边界（重要）**：
> - ✅ **进 assemble budget**：base_builder 放置预算 = `0.95 × tokenLimit − maxOutputTokens`（保护调 LLM 时 input + output 不过载，见 `context_assemble_detail.md §7`）。
> - ❌ **不进 compact 阈值**：threshold 改纯使用比例 `total/limit > compactRatio`（见 `context_compact_detail.md §1/§2c.2`）——estimated output 是为 assemble 留的保护量，不是已用量。
> - ❌ **不进 UI 占用展示**：usage 面板用户视角 = 已用/window（`free = tokenLimit − totalTokens`），不体现 estimated output（见 `specs/ui/components/chat-page/component-usage-panel.md`）。
>
> `remainingTokens` 字段仍按旧公式派生（保留字段兼容），但 compact/UI 都不再读它——它的语义降级为「input 余量 − estimated output」的内部观察值。

## 4. ratio（char/token；算/存归 session）

ratio = input token / input char，用于 assemble 时估算 context window 占用（§3）。**计算（T/C）+ 存储 + 中位数全在 session**（`accumulateUsage(type, usage)` 内部 type=current 时算，见 session_usage §7）；**context 只读 getRatio**：

| 属性 | 值 |
|---|---|
| 作用域 | per-session（session 存） |
| 学习时机 | `accumulateUsage(type="current")` 时 |
| 公式 | `sample = clamp(usage.input_total_tokens / usage.inputCharCount, 0.2, 5.0)`（session 算） |
| inputCharCount 来源 | `snapshot.inputCharCount`（assemble 产出）→ agent loop 填入 `usage.inputCharCount` |
| 窗口 | sliding 3，中位数；窗口未满用 1.0（冷启动） |
| clamp | [0.2, 5.0] |

**context 的职责**：
- assemble 时：读 `session.getRatio(sessionId)` → char×ratio 估算 contextWindowUsage（§3）；产出 snapshot 时记录 `inputCharCount`
- LLM 返回后（current，非 forked）：agent loop 构造 usage（token←LLM、inputCharCount←snapshot、outputCharCount←client）→ 调 `session.accumulateUsage(sid, "current", usage)`（type=current 时 session 内部学 ratio）

> **真实基准只有两个**：LLM 返回 token（T，`usage.input_total_tokens`）+ assemble snapshot char（C，= `usage.inputCharCount`）；ratio = T/C 由 session 算。sub/forked 的 usage 也含 inputCharCount，但只有 current 学 ratio；估算时统一读该 session 主 ratio。

## 5. cache 字段语义（v0.0.16）

**cacheRate = 比率（0-1 小数）**，UI 渲染为百分比。三分区（current / sub / forked）各有 `cacheRate`（见 session_usage §8 SessionUsageView 派生字段）。

| 字段 | 类型 | 公式 | 含义 |
|---|---|---|---|
| `input_cache_read` | token（绝对值） | LLM 返回原值 | 命中 prompt cache 的输入 token |
| `input_total_tokens` | token（绝对值） | LLM 返回原值 | 总输入 token |
| `cacheRate` | 比率（0-1） | `input_cache_read / input_total_tokens` | 缓存命中率（UI 显示百分比） |

- 分母 `input_total_tokens = 0` 时 `cacheRate = 0`（防除零）。
- UI 表格「缓存」列：`cacheRate = 0` 用 muted 色；`cacheRate > 0` 用 accent 色高亮（对齐 `chat-page/component-usage-panel.md`）。

## 6. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
