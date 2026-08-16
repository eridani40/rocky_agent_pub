---
type: spec
title: success-target-registry（进程级成功 target 注册表）
priority: P1
status: active
updated: 2026-08-15
since: v0.0.359
related: [[P0]llm_caller.md, [P0]provider_health_registry.md, ../../persistence/[P1]token_usage_stat.md, ../../version_logs/v0.0.359/change_plan.md]
---

# success-target-registry（进程级成功 target 注册表）

## 1. 概述

**(a) 管什么**：记录每个 session「最近一次 LLM 调用成功那一下」的物理 target（providerId / providerName / modelId）的**进程级内存注册表**——供 squad token usage subscriber 解析 model 归属时最高优先消费，使 token_usage_stat 统计口径对齐「实际命中 physical model」，而非配置侧 fallback 推测。

**(b) 不管什么**：usage delta 计算 / hour 桶 / upsert（→ `../../persistence/[P1]token_usage_stat.md`）；provider 健康态（→ `[P0]provider_health_registry.md`）；langfuse 观测（→ observability 端口，两者平行不寄生）。

**(c) 与外界如何交互**：写入点在 llm_caller 两个成功 return 点（llm_caller.ts attemptLoop ok 分支 + routing_loop.ts 候选链 ok 分支）；消费点在 token-usage-subscriber model 归属解析头部。registry 是叶子模块：`subscriber → registry ← llm_caller`，无接口改动、无循环依赖。

## 2. 接口/模型

```typescript
// app/server/src/llm/caller/success-target-registry.ts

/** 成功 target 快照（写入与消费共享形状；at 仅诊断用） */
export interface SuccessTargetEntry {
  providerId: string;
  providerName?: ProviderName;   // registry 存档用，不进 stat 维度
  modelId: string;
  at: number;                    // 写入时刻（epoch ms；诊断用）
}
export type SuccessTargetInput = Omit<SuccessTargetEntry, 'at'>;

export class SuccessTargetRegistry {
  recordSuccessTarget(sessionId: string, target: SuccessTargetInput): void; // 覆盖式写入
  getSuccessTarget(sessionId: string): SuccessTargetEntry | undefined;      // 纯同步 Map.get
}

// 进程级单例便捷入口（写入点/消费点直接用）
export function recordSuccessTarget(sessionId: string, target: SuccessTargetInput): void; // sessionId 空则不写
export function getSuccessTarget(sessionId: string): SuccessTargetEntry | undefined;
export function getSuccessTargetRegistry(): SuccessTargetRegistry;                        // globalThis 单例
export function __resetSuccessTargetRegistryForTest(): void;                              // 仅 UT
```

单例挂载 key：`globalThis.__successTargetRegistry`（与 CircuitBreakerRegistry / ProviderHealthRegistry 同模式）。

## 3. 设计决策

### 3.1 为什么独立 registry，不寄生 observability recordAttemptTarget

`recordAttemptTarget` 挂在 `ObservabilityPort`（langfuse 可选端口，未启用时端口缺席）——统计归属挂它上面 = langfuse 关闭时口径回退坏值；且 usage 统计是业务正路数据，不能寄生旁路观测链路。故独立一条与 observability 平行的正路线（无条件执行，成功点直写）。详见 change_plan §1.1。

### 3.2 只在成功点写

失败 / abort / max_tokens 不写（保持上一次成功值）——usage 只在成功后累计，语义自洽。写入与消费时机天然对齐「调用成功那一下」。

### 3.3 纯内存运行态，无淘汰无落盘

`Map<sessionId, entry>`，每 session ~100B，进程生命周期；重启即清 → subscriber 回退原三级 fallback（session 显式 → squad.modelDefault → `__unknown__`），与重启前现状一致，不劣化。

### 3.4 边界语义

- **覆盖式**：跨模型 failover 后记最后成功者；同轮跨模型 failover 的 delta 归最后成功模型（极小概率误差，已接受）。
- **subagent**：成功 target 记在 subagent sid 键下（按 sid 精确查），不污染 parent 归属。
- **非 squad session**：registry 照写不碍事（写入点在 llm_caller，与 session 类型无关；subscriber 侧本就跳过）。

## 4. 示例

```typescript
// 写入（llm_caller.ts invokeCore ok 分支 / routing_loop.ts 候选链 ok 分支，return 前）
if (ctx.sessionId) {
  recordSuccessTarget(ctx.sessionId, {
    providerId: target.providerId,
    providerName: target.provider.name,
    modelId: target.model.modelId,
  });
}

// 消费（token-usage-subscriber.ts onUsageNotify，model 归属解析头部）
const successTarget = getSuccessTarget(sid);                    // 最高优先
let providerId = successTarget?.providerId ?? sessionProviderId; // miss 回退三级 fallback
let modelId = successTarget?.modelId ?? sessionModelId;
```

UT：subscriber / llm_caller / routing_loop 三面均含 registry 用例，每例 `afterEach __resetSuccessTargetRegistryForTest()`。

## 5. 边界

| 零件 | 归属 |
|------|------|
| registry 本体（单例范式 / 接口 / 边界语义 / 两写入点） | 本文件 ✅ |
| 消费端优先级链（registry → session → squad → `__unknown__`）+ stat 表/查询 | `../../persistence/[P1]token_usage_stat.md §4` |
| globalThis 单例范式参照 | `[P0]provider_health_registry.md` |
| 写入点在 invoke 数据流中的位置 | `[P0]llm_caller.md §2.2` |
| 方案设计与 frozen 变更表 | `../../version_logs/v0.0.359/change_plan.md` |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)。
