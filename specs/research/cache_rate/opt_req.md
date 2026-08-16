---
type: research
title: System Reminder 缓存优化建议（滑动窗口去重，替代 wire 删除）
priority: P1
status: active
updated: 2026-08-15
source: specs/research/cache_rate/rocky.log（leader 会话 dump 实测）+ specs/tech/agent/context/[P0]system_reminder.md + specs/tech/agent/providers_and_models/[P0]cache_control.md + app/plugins/builtins/rocky_context/ingest/system_reminder_injector.ts + deepseek-harness system-prompt 子系统（PromptContext 变化快照）
---

# System Reminder 缓存优化建议

> 老板 2026-08-15 口述思路 + 会话内推演。本文是「优化需求建议」，供后续立项/设计参考，不直接改代码。

## §0 一句话结论

**当前「每轮注入 reminder + wire 层删除历史 reminder」可以简化为「滑动窗口去重注入」：注入前只往回看最近 N（建议 20）条 message，若某条 reminder 内容与窗口内已有内容相同则本次不注入。** 好处：①reminder 不再需要 wire 层删除（历史段天然稳定，缓存不破）；②无意义重复注入消失（todo/squad 状态没变就不重发）；③超过窗口的内容自然重新注入（含 compaction 后），语义上等于「DSH PromptContext 的变化快照 + supersede」。

---

## §1 现状与问题

### 1.1 现状链路（两处处理，职责分离）

| 层 | 现状 | 目的 |
|---|---|---|
| **ingest 层**（system_reminder_injector）| 每轮跑 provider 链 → 聚合 → 追加到最后一条 user/tool message 的 content 末尾并**持久化进 transcript** | 让 LLM 每轮看到最新环境/时间/团队状态 |
| **wire 层**（protocol-encode.ts）| 非最末 message 的 reminder block 全 drop；最末 message 只保留最后一个 reminder block | 保前缀缓存 + 防止历史 reminder 堆积 |

### 1.2 问题（实测证据）

从 rocky.log（leader 会话 37 轮）实测：

1. **每轮 4.5-5KB 的 reminder 中，绝大部分内容跨轮不变**（todo 状态、squad 成员 idle/running、环境信息），但仍每轮生成、每轮注入、wire 层再删——**无意义的生成与传输**。
2. **wire 层删除是「事后补救」**：先注入了再删，历史 transcript 里每轮都有一条 reminder（时间戳不同 → 内容必不同），wire 层必须靠「只留最末」来兜底。删除逻辑本身是 v0.0.274 踩坑后的补丁（trace 显示旧口径曾导致隐式缓存整段崩，命中率 0.2%）。
3. 缓存命中率受「每轮新增量」影响：稳定期 rocky 0.95-1.6%，DSH 0.37-0.73%——差距一部分就来自 DSH 的 PromptContext「**变化才写快照**」，rocky 是「每轮都写」。

### 1.3 核心矛盾

- reminder 的**内容**（todo/团队状态）大多稳定 → 每轮重发是浪费
- reminder 的**某些字段**（时间）每轮必变 → 无法避免每轮发
- wire 删除解决了「缓存不破」，但没解决「无意义重复注入」

---

## §2 优化方案：滑动窗口去重（N=20）

### 2.1 机制

在 **ingest 层**（system_reminder_injector 内）注入前加一步去重：

```
对本次要注入的 reminder 聚合文本 text：
  1. 从当前 messages 末尾往回扫描最近 N（=20）条 message
  2. 若这 20 条内存在一条 isSystemReminder block 的 text == 本次 text（逐字节相等）
     → 本次不注入（跳过）
  3. 否则 → 正常注入（append 到最后一条 user/tool message 末尾）
```

### 2.2 关键语义

| 场景 | 行为 | 效果 |
|---|---|---|
| todo/squad/env/workspace 内容没变 | 窗口内已有相同 text → **不注入** | 该轮 wire 无此内容，历史不增长 |
| time 变了（每轮必变） | 窗口内无相同 text → 正常注入 | 时间仍每轮最新（正确性保留） |
| 超过 20 条 message（内容从未再出现） | 窗口外 → **重新注入** | 自然刷新，等于「遗忘后重新告知」 |
| compaction 压缩历史 | 窗口内找不到旧快照 → 重新注入 | 对齐 DSH「compaction 移除后重新快照」语义 |

### 2.3 为什么这样就不需要 wire 删除

- 注入前已去重 → **历史 transcript 中同内容 reminder 最多出现一次**（在窗口内）
- 历史段天然稳定（内容不重复追加）→ 前缀缓存不破 → wire 层「删除历史 reminder」逻辑**可退役**（或降级为防御性保留）
- time reminder 每轮追加的是**新内容**（时间戳不同）→ 属于 append-only 增长，不破坏前缀稳定段

> 本质：**把「先注入再删」改为「先查重再注入」**——删除是补救，查重是预防。与 DSH PromptContext「变化才写快照」是同一目标，但用「窗口查重」实现，天然兼容 rocky 的 transcript 完整持久化原则（不需要在 wire 层做任何篡改）。

### 2.4 为什么窗口是 20 而不是「对比上一条」

| 方案 | 问题 |
|---|---|
| 只对比上一条 reminder | 若中间插了 2 轮 tool 循环（reminder 在 tool 消息上），同内容可能隔 2-3 条才重复 → 漏去重 |
| 对比全部历史 | 成本 O(全历史)，且语义错误：太久远的内容模型可能已遗忘，不该视为「已告知」 |
| **窗口 20 条** | 平衡：覆盖 tool 循环间隔 + 近似「模型近期记忆窗口」+ 超窗自然重发 |

---

## §3 收益预估（基于 rocky.log 实测数字）

| 指标 | 现状 | 优化后（预估） |
|---|---|---|
| 稳定期每轮新增 | 5.4KB（含 4.5KB 重复 reminder） | ~1-2KB（只有 time + 变化内容 + 对话） |
| 稳定期新增/存量 | 0.95-1.6% | 0.3-0.6%（对齐 DSH 水平） |
| 缓存命中率 | ~98.5-99% | ~99.3-99.7% |
| 每轮 token 消耗 | 多付 ~4.5KB 全价 token | 省掉重复部分 |
| wire 层删除逻辑 | 必须（补丁式） | 可退役（防御性保留） |

**注意**：命中率提升的绝对幅度不大（98.5→99.5%），但**每轮省 4.5KB token 是全价 token**（不进缓存），对成本是实打实的；且简化了 wire 层逻辑（删代码 = 少一个坑）。

---

## §4 边界与风险

1. **time provider 不参与去重**（每轮必变，查重必然 miss → 自然每轮注入）。不要试图给 time 降频（正确性 > 缓存，v0.0.64 已定）。
2. **tool_error reminder**：事件驱动，天然低密度，查重不影响。
3. **去重比较成本**：仅比较「本次聚合文本 vs 窗口内 reminder block 文本」，O(20×block数)，可忽略。
4. **窗口大小可配置**：N=20 是建议值，可做成 session/config 级参数（若 todo 很长、tool 循环密集，可调 N=30-50）。
5. **与 wire 删除的关系**：建议先「查重 + 保留 wire 删除」双保险跑一版，验证历史稳定后，再评估退役 wire 删除（或改为仅 drop 极端异常）。
6. **a2a/squad 场景**：mate 消息注入 reminder 的触发已放宽（v0.0.33.3/v0.0.274），窗口去重对多 agent 轮同样生效——mate 回报轮 reminder 若与 leader 轮相同内容，会被 leader 轮的窗口去重掉。

---

## §5 其他可考虑的优化方向（待讨论）

1. **reminder 分 provider 去重**（粒度更细）：不是「整段 text 相等才跳过」，而是按 provider 粒度（todo 段 vs 环境段）分别查重——todo 变了但环境没变，只重发 todo 段。代价：注入块结构从「单块」变「多块」。
2. **tier 信息密度控制**：warn tier 的 reminder 保留全部；info tier 的 reminder 窗口内已出现即跳过（含不同内容？——需定义「同类已告知」语义）。
3. **todo 变化检测上游化**：todo provider 内部做「状态变化」判断（与上轮 todo 内容 diff），而不是 injector 层做整段查重——provider 更懂自己的语义（如「进度 2/5→3/5」算变化，但「presence 未变」不算）。
4. **squad_agents_status 压缩**：全量成员状态块每轮都发，可改为「只发变化成员」（DSH 的 RuntimeContextProjection 只投变化思路）。
5. **wire 层退役后**：encodeMessage 的 isLastMessage 分支、lastKeptReminderIdx 逻辑可删 → 简化 protocol-encode.ts。

---

## §6 结论

**主优化 = ingest 层滑动窗口去重（N=20），替代「注入 + wire 删除」的组合**。收益：每轮省 ~4.5KB 全价 token、历史天然稳定、wire 逻辑简化、命中率对齐 DSH 水平。语义上等价于把 reminder 当作「多 KV 的消息媒介」：窗口内内容相同即视为已投放，超过窗口自然重放（含 compaction 后）。方向正确，可立项细化（change_plan + 单测覆盖窗口边界/compaction 交互/tool 循环间隔）。
