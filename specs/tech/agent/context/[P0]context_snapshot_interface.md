---
type: interface
title: Context Snapshot Interface
priority: P0
status: active
updated: 2026-07-06
since: v0.0.8
---

# Context Snapshot Interface

> 参见 `[P0]agent_message_interface.md` 了解 Message 定义，`[P0]context_engine.md` 了解 ContextEngine 的 `assemble()` 接口。

> **system 注入路径对齐实现**：`ContextSnapshot.system` 是 role="system" 的 Message，但**不另走 CanonicalRequest.system 字段**——system 以 `messages[0]` role=system 形式随 `snapshot.messages` 一起传给 LLM。
> - CanonicalRequest.system 字段**对齐实现移除语义**：caller 不单独填 system 字段（v0.0.13 文件头曾要求「必须注入 CanonicalRequest.system」，此表述已废弃）。
> - system 在 `assemble()` 内被写入 `snapshot.messages[0]`（role=system），主 agent loop / 旁路 run 都直接发 `messages`，system 自然发出。
> - 参见 `../agent_interface_and_loop/[P0]agent_loop_base.md §2.1`（system 不在 CanonicalRequest 单独组装，messages 内已含）+ `../agent_interface_and_loop/[P0]agent_loop_side_run.md §6`（旁路 run 同样只发 messages）。

> **[v0.0.14 实现基线]**：`accumulateUsage` 已激活——AccumulatedUsage 真累计、`session_usage_update` event 真发、getUsageView 真聚合。**[v0.0.16] ContextWindowUsage 7 字段全量激活**（systemTokens / messageTokens / toolTokens / totalTokens / maxOutputTokens / tokenLimit / remainingTokens），assemble 读 `session.getRatio(sessionId)` 估算（不再硬编码 1.0）；历史数据（旧 3 字段 record）反序列化时按 §2 末「normalize 兜底」补全。详见 `specs/tech/version_logs/v0.0.16/change_log.md`。

## 1. 概述

`ContextSnapshot` 描述一次会话中**发送给 LLM 的不可变快照**。它由 `ContextEngine.assemble()` 产出，包含：

- 经过选取、过滤、裁剪后的 message 列表
- 摘要信息（summary 版本 / summaryUpTo 游标）
- token 用量统计

这些元信息帮助后续做增量更新、判断是否需要 compact 等。

---

## 2. 接口定义

```typescript
interface ContextSnapshot {
  /** system prompt（role="system" 的 Message）。[v0.0.16] 不另走 CanonicalRequest.system 字段——
   *  assemble 时 system 同时被写入 messages[0]（role=system），caller（主 agent loop / forked agent）
   *  直接发 messages 即可，system 自然发出。本字段保留作 caller 观测 / compact 复用快照引用。 */
  system: Message;

  /** 发送给 LLM 的消息列表（已过滤、已裁剪，统一用 Message） */
  messages: Message[];

  /** 可用工具定义（policy 裁剪后的 ToolDefinition[]，与 main run spec.toolDefinitions 同源）
   *  assemble 从 `config.tools.map(t => t.definition)` 派生（见 context_assemble_detail §7.5）。
   *  forked 读 snapshot.tools 作为 wire body tools——保证 forked 与 main 的 tools 段前缀一致
   *  （cache 契约：forked 复用 main 的 policy 裁剪集，而非 registry 全集）。
   *  [v0.0.82] 字段恢复为必填：spec §2 完整形态本含 tools，v0.0.8 简化时省略（task-5 自行从
   *  config.tools 构造 CanonicalRequest），v0.0.82 修复 cache 前缀分叉 bug 时恢复——
   *  forked 之前用 `defaultToolDefinitions(workdir)` registry 全集（24，含 squad team/goal/...），
   *  main 用 config.tools policy 裁剪集（20）→ wire body tools 段 24 vs 20 分叉破 cache。 */
  tools: ToolDefinition[];

  /** 摘要信息 */
  summary: SummaryInfo;

  /** 当前 context window 的 token 用量（这个 snapshot 占了多少） */
  contextWindowUsage: ContextWindowUsage;

  /** input 侧 char 总数（system + messages + tools 序列化）；agent loop 构造 Usage 时填入 usage.inputCharCount 供 session 学 ratio（见 ../session/[P0]session_usage.md §1/§7） */
  inputCharCount: number;
}

/**
 * 摘要信息 — 记录当前 snapshot 中摘要的状态
 */
interface SummaryInfo {
  /** 摘要版本号，每次 compact 递增 */
  version: number;

  /** 摘要覆盖到哪个 message id（该 id 之前的消息已被压缩进摘要） */
  summaryUpTo: string | null;

  /** 摘要正文（压缩后的历史内容，已 strip <analysis> 草稿） */
  content: string | null;

  /**
   * [v0.0.186] 烘焙的完整 summary block 文本（preamble + head 段 + tail 段，compact 时
   * 一次构建并持久化）。组装期 base_builder 直接用作 messages[0]（零选取零计算 → prompt
   * 缓存前缀逐字节稳定，ratio 漂移 / transcript 增长均不影响）。旧记录无此字段 → null →
   * 组装走即时构建 fallback（见 context_assemble_detail §6），下次 compact 自动升级。
   * 边界：烘焙后 head/tail 窗口内历史消息被 HITL 编辑不回刷本块（recent 区每轮最新不受影响）。
   */
  block: string | null;
}

/**
 * 当前 context window 的 token 用量 — snapshot 级别
 * 描述这个 snapshot 本身占用了多少 token；每次 assemble 重算
 * token 估算用 char × ratio（不依赖 tokenizer，见 context_usage_detail §5）
 */
interface ContextWindowUsage {
  /** system prompt 的 token 数（char × ratio 估算） */
  systemTokens: number;

  /** messages 的 token 数（char × ratio 估算） */
  messageTokens: number;

  /** tools 定义的 token 数（char × ratio 估算） */
  toolTokens: number;

  /** input 侧总 token = system + messages + tools（均 char × ratio 估算） */
  totalTokens: number;

  /** 预留输出预算（默认 20000，app_config `context` 组）；模型生成也占窗口。
   *  [v0.0.81.compaction_bug] 语义澄清：= estimated output 估算输出常量（非 model maxOutput，
   *  不随 model 变）；常量源 app/server/src/agent/session-usage-helper.ts DEFAULT_MAX_OUTPUT_TOKENS=20000。
   *  字段名保留不改（持久化 record + SSE schema 兼容）。
   *  消费边界：✅ 进 assemble budget（base_builder 放置预算 = 0.95×tokenLimit − maxOutputTokens，
   *  见 context_assemble_detail §6.5）；❌ 不进 compact 阈值（context_compact_detail §1 改纯使用比例）；
   *  ❌ 不进 UI 占用展示（component-usage-panel 用户视角 = 已用/window）。 */
  maxOutputTokens: number;

  /** 模型的 context window 上限 = modelConfig.contextWindow */
  tokenLimit: number;

  /** 剩余可用 input token = tokenLimit − totalTokens − maxOutputTokens */
  remainingTokens: number;
}
```

### [v0.0.16] ContextWindowUsage 7 字段默认值 + 历史数据 normalize 兜底

| 字段 | 默认值 | 备注 |
|---|---|---|
| `systemTokens` | 0 | assemble 按 `system.content` char × ratio 估算 |
| `messageTokens` | 0 | Σ messages char × ratio |
| `toolTokens` | 0 | tools 序列化 char × ratio |
| `totalTokens` | 0 | = system + messages + tools |
| `maxOutputTokens` | `20000` | app_config `context.maxOutputTokens` 缺省 20000 |
| `tokenLimit` | `modelConfig.contextWindow` | 来自 model 配置 |
| `remainingTokens` | `tokenLimit − totalTokens − maxOutputTokens` | 派生 |

**历史数据 normalize**（v0.0.16 必做）：扩展 7 字段后，**旧 record（仅 3 字段：totalTokens / tokenLimit / remainingTokens）反序列化时缺字段**。SessionStore 读回 `session.usage.contextWindowUsage` 时按 normalize 兜底（参考 `session-usage-helper.ts` `normalizePartition` 模式）：
```typescript
function normalizeContextWindowUsage(raw: any): ContextWindowUsage {
  return {
    systemTokens: raw.systemTokens ?? 0,
    messageTokens: raw.messageTokens ?? 0,
    toolTokens: raw.toolTokens ?? 0,
    totalTokens: raw.totalTokens ?? 0,
    maxOutputTokens: raw.maxOutputTokens ?? 20000,
    tokenLimit: raw.tokenLimit ?? 200000,
    remainingTokens: raw.remainingTokens
      ?? (raw.tokenLimit ?? 200000) - (raw.totalTokens ?? 0) - 20000,
  };
}
```
> 下一次 assemble 会真算所有 7 字段覆盖；normalize 仅保证读回期间 UI / compact 触发判定不崩。

### ContextWindowUsage vs AccumulatedUsage

两种 usage 的区别：

| 维度 | ContextWindowUsage | AccumulatedUsage |
|------|-------------------|-----------------|
| **归属** | ContextSnapshot（每次 assemble 产出） | session（三分区累加） |
| **含义** | 当前 snapshot 占了多少 token | 分区累加 LLM 调用 usage |
| **更新方式** | assemble 时重算（→ session.updateContextWindowUsage） | `session.accumulateUsage(type, usage)` 时累加 |
| **用途** | 判断是否需要 compact | 统计 session 总消耗 / 计费 |

> **AccumulatedUsage 类型 + SessionUsageView + 接口（accumulateUsage / updateContextWindowUsage / getUsageView / getRatio）迁到 session**：见 `../session/[P0]session_usage.md`（§1 Usage、§2 AccumulatedUsage、§3 接口、§8 SessionUsageView）。本文只定义 ContextSnapshot（含 `contextWindowUsage: ContextWindowUsage`）+ ContextWindowUsage 类型。

---

## 3. 字段说明

### summaryUpTo 的作用

```
Transcript:
┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │ 9 │10 │
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
  ↑       ↑               ↑           ↑
  head    summaryUpTo     tail        snapshot 末尾
  (保留原文) (1~5 已压缩    (保留原文)  (6~10 原文
            进 summary)                在 messages 中)
```

- `summaryUpTo` 告诉 ContextEngine：下次 assemble 时，这个 id 之前的消息不需要重新选取（已在摘要里）
- compact 时推进 `summaryUpTo`，把更多旧消息压缩进摘要
- `version` 帮助判断摘要是否过期（transcript 有新消息 ingest 后，摘要可能需要更新）

> **head/tail 原文与 SummaryInfo 的关系（[v0.0.186] 更新）**：头部（session 开头）/尾部（summaryUpTo 前）保留多少原文是**选取策略**（tokenCap 参数归 impl configSchema，见 `context_assemble_detail.md` §6）。v0.0.186 起该选取在 **compact 时执行一次**，连同 preamble + summary 正文烘焙成完整文本存 `SummaryInfo.block`（组装期零计算直读）；存量旧 summary 无 `block` 时仍由 base_builder 组装期即时构建（fallback，下次 compact 自动升级）。上图 head/tail 标注反映烘焙/组装构造的视图结构。

---

## 4. 与 ContextEngine 的关系

```
ContextEngine
    │
    ├─ ingest(config, messages[], allowEdit)  → 消息进入 transcript
    │
    ├─ assemble()                     → 内容变化或 compact 后调用
    │                                    → 产出 ContextSnapshot（含 contextWindowUsage）
    │
    ├─ compact()                      → 压缩历史，推进 summaryUpTo
    │
    └─ （usage 方法已迁 session：accumulateUsage / updateContextWindowUsage / getUsageView / getRatio，见 ../session/[P0]session_usage.md；context 只调 accumulate/update）
```

---

## 5. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
