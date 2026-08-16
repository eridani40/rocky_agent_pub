# v0.0.359 change_log — squad 用量统计归属记实际命中 physical model

## 头部

- **需求**：squad 用量统计（token_usage_stat）应记在「调用成功那一下」对应的 item 模型上（解法 2：记实际命中 physical model），而非配置侧三级 fallback 推测（老板 2026-08-15 18:29 拍板）。
- **根因**：BUG-TOKEN-USAGE-PLAN-FALLBACK（states/v0.0.357/bugs/）——subscriber model 解析 = session → squad.modelDefault → `__unknown__` 三级配置侧 fallback；studio squad 挂路由方案（T6 互斥清空 modelDefault）+ session 未显式选模型 → 两级全空 → 统计落 `__unknown__`，实际调用走方案候选链。
- **契约**：change_plan.md（frozen，method 级 review 合同）。
- **commits**：`aa34eb679`（架构四件套）→ `0df1fe681`（T1 实现）→ `32764f9cb`（双轨状态 + UT 报告）→ `b2a7c18c5`（review Minor：删死代码 createSuccessTargetRegistry）→ `239009245`（T1 review 报告，CONDITIONAL PASS）。

## 变更摘要（决策表）

| # | 决策 | 说明 |
|---|---|---|
| D1 | 独立进程级 registry，不寄生 observability | `recordAttemptTarget` 挂 `ObservabilityPort`（langfuse 可选端口，未启用即缺席）——统计是业务正路数据，挂它 = langfuse 关闭时口径回退坏值；故建 `success-target-registry.ts`，与 observability 平行的正路线（globalThis 单例，同 CircuitBreakerRegistry 范式） |
| D2 | 只在成功点写 | 失败/abort/max_tokens 不写（保持上一次成功值）——usage 只在成功后累计，语义自洽 |
| D3 | 消费端插头式优先级链 | registry 命中 → session 显式 → squad.modelDefault → `__unknown__`；miss（进程重启后/旧 session 补记/测试注入）三级 fallback 原样保留，零回归 |
| D4 | 纯内存无淘汰 | `Map<sessionId, entry>` 每 session ~100B，进程生命周期；重启即清 → 回退现状，不劣化 |

## 实现核对表（逐计划项）

| change_plan 项 | 状态 |
|---|---|
| §2-1 新增 success-target-registry.ts（SuccessTargetRegistry + globalThis 单例 + reset for test） | ✅（0df1fe681，+118 行） |
| §2-2 llm_caller.ts attemptLoop ok 分支 return 前 recordSuccessTarget | ✅（ctx.sessionId 存在时写入，+9） |
| §2-3 routing_loop.ts 候选链 ok 分支 return 前 recordSuccessTarget | ✅（ctx.sessionId 已可达，无需补透传——架构期风险点①排除） |
| §2-4 subscriber model 归属优先级链插头（getSuccessTarget 最高优先） | ✅（+14，三级 fallback 保留） |
| §2-5 subscriber UT +4（registry 命中/miss session 显式/miss 全空回归/subagent 跳过回归） | ✅（每例 afterEach reset） |
| §2-6 llm_caller UT +1（ok → registry 写真实 target） | ✅ |
| §2-7 routing_loop UT +1（候选 ok → 该候选 target 写入） | ✅（合计 63 全绿；tsc -b 0 error） |

## 实现偏差（以代码为准）

- **影响行偏离**：registry +118 行（计划 +90，接口注释与 `providerName?` 存档字段充实）；llm_caller +9 / routing_loop +9（计划各 +6，含双行注释）——review 判定非实质偏离，随 commit 说明。
- **review Minor（已修 b2a7c18c5）**：死代码 `createSuccessTargetRegistry` 工厂函数（UT 用途未兑现，零引用）删除，-9 行。spec 与本 log 不再引用该工厂。
- **review 报告**：CONDITIONAL PASS → Minor 修复后闭环（states/v0.0.359/verify/review/code-review-taskT1.md）。

## 标准沉淀

- **归属口径**：统计 model 维度 = 「调用成功那一下」的实际命中（运行时数据源 > 配置侧推断）。同类问题（统计与实际行为脱节）优先找运行时成功点数据源，不挂旁路观测端口。
- **插头式优先级链**：新增数据源插最高优先 + 原链完整保留兜底，miss 路径零回归。

## 关键文件表

| 文件 | 角色 |
|---|---|
| `app/server/src/llm/caller/success-target-registry.ts` | 新：进程级成功 target 注册表（写/读/reset） |
| `app/server/src/llm/caller/llm_caller.ts` | 写入点 1（attemptLoop ok 分支） |
| `app/server/src/llm/caller/routing_loop.ts` | 写入点 2（候选链 ok 分支） |
| `app/server/src/squad/token-usage/token-usage-subscriber.ts` | 消费点（model 归属链插头） |
| `app/server/src/**/__tests__/{token-usage-subscriber,llm_caller,routing_loop}.test.ts` | UT 三面（+6 例） |

## 文档同步清单

| 文档 | 同步内容 |
|---|---|
| `specs/tech/agent/llm_caller/[P0]success_target_registry.md` | 新建组件 spec（§1-5，含双向引用） |
| `specs/tech/agent/llm_caller/index.md` | 概念表/边界表/导航表补 SuccessTargetRegistry |
| `specs/tech/agent/llm_caller/[P0]llm_caller.md` | §2.2 流程图 ok 分支补 recordSuccessTarget；related 补引 |
| `specs/tech/persistence/[P1]token_usage_stat.md` | §4 流程图 + 关键不变量：model 归属优先级链更新 |
| `specs/tech/agent/providers_and_models/[P0]model_routing.md` | §4 路由循环伪码成功分支补 recordSuccessTarget |
| 上述各 KB `log.md` + 本 change_log | 倒序补记 |

## 根因边界声明

本修复消除「registry 命中」路径的 `__unknown__` 误归属。**不保证彻底消除 `__unknown__`**：进程重启后窗口期（registry 空 + session/squad 配置侧均空）、以及从未成功调用过却有 usage 事件的极端路径仍会落 `__unknown__`（三级 fallback 终站，防御性保留）。长期方向：若需彻底消除，需持久化成功 target（当前裁决不做——纯内存与 lastSeen 同命运，语义一致）。
