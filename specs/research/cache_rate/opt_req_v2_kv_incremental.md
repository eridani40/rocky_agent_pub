---
type: research
title: Reminder KV 增量持久化（v2，替代 v1 滑动窗口整段去重）
priority: P0
status: active
updated: 2026-08-15
source: 老板 2026-08-15 17:53/17:54 口述确认 + specs/research/cache_rate/opt_req.md（v1）+ outputs/cache-hit-analysis-2026-08-15.md
---

# Reminder KV 增量持久化（v2）

> 本文是 v0.0.358 的需求定义（老板已拍板做独立版本），替代 v1 `opt_req.md` 的「滑动窗口整段去重」——v1 是块级去重，v2 是 **KV 级增量 diff**，更细、更贴近 DSH PromptContext 变化快照。

## §0 一句话

**reminder 持久化进 transcript、cache_control 不跳过它；每类 reminder 是一个独立 KV（只保留最新 value）；注入时回溯「上次 summary 之后」的 message 构建 KV map，逐 key 比对——value 变了或 key 不存在才填，相同则不填。目标 = 减少非缓存输入（全量 reminder 每轮占非缓存 token）。**

## §1 初衷（老板 17:54 明确）

reminder 发得太多：每次发送的都是**全量** reminder，它一定占据一个**非缓存的输入**。所以要减少的是**非缓存输入**——让稳定段吃缓存，每轮只 append 变化段。这是降成本，不只是提命中率。

## §2 KV 增量模型（老板 17:53 确认）

1. **reminder 持久化 + cache_control 不跳过**：写进 transcript 持久化，作为缓存前缀一部分保留，让稳定段命中缓存。
2. **reminder = 一组独立 KV**：每类 reminder 是一个 key（todo、团队状态、环境、配额……），每个 key 只保留它的**最新 value**。
3. **注入时回溯构建 KV map**：填充最新 reminder（全量信息）时，往前回溯历史 reminder，**每个 key 取最后出现的 value**，构建 KV map。
4. **diff 过滤只发变化**：最新要发的内容与 map 逐 key 比对——**value 变了、或 key 不存在 → 填进去；value 相同 → 不填**。

## §2.5 架构定位（老板 17:56 明确）

1. **KV 增量逻辑 = context assemble 的一个 reducer**：在 assemble 流程加一个 reducer 步骤，负责「回溯 summary 后历史 reminder → 构建 KV map → 与本轮全量 reminder 逐 key diff → 只输出变化的 key」。在 assemble 阶段做，不在 wire 层、不是事后删除。
2. **Anthropic protocol 同步改**：现状 cache_control 逻辑 + reminder 删除逻辑都在 protocol（protocol-encode.ts）里。改后——
   - **cache_control 极简化**：只在「system reminder 的最后」和「message 的最后」加 cache_control breakpoint。
   - **protocol 不再独立处理任何 system reminder 的工作**：删除 reminder、lastKeptReminderIdx、isLastMessage 分支等 reminder 特殊处理全部退役。protocol 层对 reminder 透明无感知。
3. **职责干净**：增量的「智能」全在 assemble 的 reducer；protocol 层只管透传 + 加 cache breakpoint，不碰 reminder 语义。历史 reminder 持久化留 transcript 吃缓存（已增量去重不重复堆积，无需 protocol 再删）。

## §3 关键约束：窗口锚定 summary 边界（非固定 20 条）

- 回溯窗口**不是机械数 20 条 message**，而是「**最后 summary/compaction 填充之后的内容**」。
- 因为 reminder 注入点在 assemble 流程相对**靠后**的位置；刚 summary 完时，可用 message 可能不足 20 条。
- 窗口边界要跟 assemble 实际产出的 message 序列对齐：**以「上次 summary 点之后」作为 KV 基线**。
- summary 后 KV map 从空开始重建 → 首轮全量重发（自然对齐「遗忘后重新告知」语义）。

## §4 与 v1（opt_req.md）的差异

| 维度 | v1 滑动窗口整段去重 | v2 KV 增量 |
|---|---|---|
| 去重粒度 | 整段 reminder 文本相同才跳过 | **KV 级**：每个 key 独立 diff |
| 相同 key 的处理 | 整段相同→跳过本轮 | 该 key 相同→不填，其他变化 key 照填 |
| 窗口 | 固定 N=20 条 | **summary 边界**（更准） |
| 对齐 DSH | 近似 | 完全等价「变化快照 + supersede」 |

## §5 待 architect 实证（出 change_plan 前）

1. **assemble 链路现状**：reminder 注入点在哪一步、summary/compaction 点在哪、两者的相对顺序。
2. **cache_control 现状**：现在 cache_control breakpoint 怎么配、对 reminder block 是否跳过。
3. **reminder 的 key 怎么定义**：按 provider 分（todo provider=一个 key、env provider=一个 key），还是更细？—— **核心决策点**，直接影响 KV 拆分粒度与实现。
4. **KV map 构建成本**：回溯「summary 后」的 message 提取 reminder KV，成本可控性。
5. **wire 层删除逻辑去向**：KV 增量后历史 reminder 是否可不再删除（退役 wire 删除），还是先双保险。

## §6 验收方向

- 稳定期每轮非缓存输入显著下降（对齐 DSH 0.3-0.6% 新增/存量）。
- 变化段仍正确每轮最新（todo 变了 → todo key 重发）。
- summary/compaction 后 KV 正确重建（首轮全量）。
- 缓存命中率提升 + 每轮 token 成本下降（可量化对比）。
