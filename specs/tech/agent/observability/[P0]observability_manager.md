---
type: design
title: ObservabilityManager（composite adapter）
priority: P0
status: active
updated: 2026-07-02
since: v0.0.11
related: [[P0]observability_interface.md, [P0]langfuse_adapter.md]
---

# ObservabilityManager（composite adapter — 多 backend fan-out）

> 把 app_config runtime 组的 observability **列表**收敛成一个 `ObservabilityAdapter`，对 agent loop 透明地 fan-out 到每个 enabled 项。
> 接口契约 + 全量字段（TraceStart/GenInput/ToolSpanInput/…）+ Handle 类型见 `[P0]observability_interface.md §5/§6`；Langfuse SDK 接入 + 字段映射 + env/flush 见 `[P0]langfuse_adapter.md`；observability 列表 schema 见 `specs/tech/config/[P0]app_config.md §3.9`。

## 1. 定位

`ObservabilityManager` 是一个 **composite `ObservabilityAdapter`**：

- 实现 `observability_interface §6` 的 `ObservabilityAdapter` 接口（与 `LangfuseAdapter`/`NoopAdapter` 同接口）。
- 内部持 **child adapter 列表**（每个 enabled 配置项 → 一个 `LangfuseAdapter`；当前仅 langfuse type，预留 vendor 抽象）。
- 对 agent loop **完全透明**：loop 仍调 `config.observability.startTrace/endTrace/...`，背后是 manager，**埋点代码零改动**（见 §9）。

**为什么 composite**：用户要求 observability 是**列表**（dev 可配多条，例如 self-host + cloud 双写、或 staging/prod 隔离），而 `ObservabilityAdapter` 接口是单实例语义、agent loop 埋点已稳定。引入一个实现接口的 composite，把 N 个 child 收敛成 1 个对外，是最小侵入的方案——不动接口、不动 loop。

## 2. fan-out 语义

manager 的每个方法遍历 child 列表，对每个 child 调对应方法：

| manager 方法 | 行为 |
|---|---|
| `startTrace(p)` | 每个 child 各调 `child.startTrace(p)`，收集 N 个 `TraceHandle`，返回一个 manager TraceHandle（id=p.id=runId，见 §4） |
| `endTrace(h, p)` | 按 manager handle 查出 N 个 child trace handle，逐个 `child.endTrace(childH, p)` |
| `startGeneration(p)` | 每个 child 各调 `child.startGeneration(p)`（v0.0.50：`kind='physical'` 时**仅** fan-out 到 `logPhysical=true` child，其他 child 在 childHandles 记 null），收集 N 个 `GenHandle`，返回 manager GenHandle |
| `endGeneration(p)` | 按 manager handle 查出 N 个 child gen handle，逐个 `child.endGeneration({gen: childH, ...p})` |
| `startSpan(p)` | 每个 child 各调 `child.startSpan(p)`，返回 manager SpanHandle |
| `endSpan(h, p)` | 按 manager handle 查出 N 个 child span handle，逐个 `child.endSpan(childH, p)` |
| `shutdown()` | `await Promise.all(children.map(c => c.shutdown()))`（容错见 §5） |

**parent handle 透明**：manager handle 与 child handle 是**两套 id 空间**。manager 对外只暴露 manager handle（id 复用 runId/ulid），child handle 永不外泄——loop 拿到的 handle 全是 manager handle，传回 manager 后由 manager 内部映射到各 child handle。

## 3. 容错（核心红线 ★）

**双层防护，observability 绝不影响 agent loop**：

**第一层（manager 侧 — per-child try/catch）**：

- fan-out 循环中，**每个 child 调用独立 `try/catch`**；一个 child 抛（langfuse 网络错 / SDK 异常 / 构造失败）**只 warn 并跳过该 child**，不影响其他 child。
- `startTrace/startGeneration/startSpan`：某 child 抛 → 该 child 在 handle 表里记 `null`（后续 endXxx 跳过它）。
- `endTrace/endGeneration/endSpan`：某 child 抛 → warn + 继续。
- `shutdown()`：用 `Promise.allSettled`（不用 `Promise.all`），单 child flush 失败不影响其他 child flush。

```typescript
// fan-out 伪代码（以 startTrace 为例）
startTrace(p: TraceStart): TraceHandle {
  const childHandles: (TraceHandle | null)[] = this.children.map(c => {
    try { return c.startTrace(p); }
    catch (e) { console.warn(`[observability:manager] child startTrace failed (suppressed): ${msg(e)}`); return null; }
  });
  const mgrHandle = { kind: "trace", id: p.id };
  this.traceMap.set(mgrHandle.id, childHandles);
  return mgrHandle;
}
```

**第二层（loop 侧 — `LoopObservability.safe()` 兜底）**：现有 `app/server/src/agent/agent-loop-observability.ts` 的 `safe()` 已对每次 adapter 调用 try/catch（见 `observability_interface.md §6.1`）。即使 manager 自身 bug 漏 catch，loop 仍不抛。**两层独立，互不依赖**。

> **为什么需要两层**：第一层保证「一个 child 挂不影响其他 child」（manager 内部隔离）；第二层保证「整个 observability 子系统挂不影响主流程」（loop 边界兜底）。单层无法兼顾——loop 侧 safe() 不知道 manager 内部有 N 个 child，无法 per-child 隔离。

## 4. composite handle 管理

**handle 映射数据结构**（manager 内部，不外泄）：

```typescript
class ObservabilityManager implements ObservabilityAdapter {
  private children: ObservabilityAdapter[];              // enabled 项的 child（LangfuseAdapter / NoopAdapter）
  private traceMap = new Map<string, (TraceHandle | null)[]>();  // mgrTraceId → child trace handles
  private spanMap  = new Map<string, (SpanHandle  | null)[]>();  // mgrSpanId  → child span handles
  private genMap   = new Map<string, (GenHandle   | null)[]>();  // mgrGenId   → child gen handles
  // ...
}
```

- **manager handle.id 生成**：trace 用 `p.id`（=runId，loop 已保证全局唯一）；span/gen 用 `ulid()`（manager 自生成，不与 child id 冲突——child id 各自独立空间）。
- **child handle 收集顺序**：按 `children` 数组顺序，下标对齐；`null` 表示该 child 对应调用失败/被跳过。
- **分发（endXxx）**：拿到 manager handle → 查对应 map → 按 child 下标遍历，跳过 `null`，对每个 child handle 调 child.endXxx。

```typescript
endSpan(h: SpanHandle, p?: SpanEnd): void {
  const childHandles = this.spanMap.get(h.id) ?? [];
  childHandles.forEach((ch, i) => {
    if (!ch) return;
    try { this.children[i].endSpan(ch, p); }
    catch (e) { console.warn(`[observability:manager] child endSpan failed: ${msg(e)}`); }
  });
  this.spanMap.delete(h.id);   // 释放（避免内存泄漏）
}
```

> **parent 在 manager handle 中保留**：`SpanHandle.parent` / `GenHandle.parent` 字段沿用 overall §6 类型（指向 manager handle）。manager 不依赖 parent 字段做分发（用 map），parent 仅供 loop/调试时还原树形；child 侧的 parent 关系由各 child adapter 自行维护（child.startSpan 收到的 `p.parent` 是 manager handle，child 内部把它当不透明 id 用，不影响 SDK 嵌套——因为 child 的 trace/span/generation 是 child 自己 startXxx 时建的，parent 链在 child 内部已正确）。

### 4.1 双层 handle id 空间 — parent 必须按 child 翻译 ★（BUG-001 设计原则）

> 这是 manager 的**生命线**。任何 composite/代理层引入第二层 handle 空间时，parent 必须按 child 翻译，不能透传。

**ObservabilityManager 存在两套 handle id 空间**：

- **manager handle 空间**（对外）：manager 对 agent loop 暴露的 handle（trace.id=runId，span/gen.id=ulid）。
- **child handle 空间**（对内，每个 child 独立）：每个 `LangfuseAdapter` 自己 `startTrace/startSpan/startGeneration` 返回的 handle（child 自身的 langfuse SDK observation id）。

**fan-out 时 parent 是 manager handle**：`startGeneration/startSpan` 的入参 `p.parent` 由 loop 填的是**它从 manager 拿到的 manager handle**（loop 不知道有 child）。**不能直接把这个 manager handle 透传给 child** —— child 在 SDK 里查找 parent 时用的是**它自己的 id 空间**，manager handle 在 child 空间里查不到，SDK 报 `parent observation not found` → generation/tool span **被丢弃**（step span 因 parent=trace，trace.id 复用 runId 在两空间重合而**天然幸存**，极具迷惑性）。

**解法（resolveParentPerChild）**：manager 在 fan-out 到某 child 前，先把 `p.parent`（manager handle）经 `traceMap/spanMap` 反查映射成**该 child 自己的 parent handle**，再传给该 child：

```typescript
// fan-out startSpan（关键：parent 必须按 child 翻译，不能透传）
private resolveParentPerChild(childIdx: number, mgrParent: Handle | undefined): Handle | undefined {
  if (!mgrParent) return undefined;
  const map = mgrParent.kind === 'trace' ? this.traceMap
            : mgrParent.kind === 'span'  ? this.spanMap : this.genMap;
  const childHandles = map.get(mgrParent.id) ?? [];
  return childHandles[childIdx] ?? undefined;   // 该 child 自己的 parent handle（可能 null=失败跳过）
}
startSpan(p: StepSpanStart | ToolSpanStart): SpanHandle {
  const childHandles = this.children.map((c, i) => {
    try { return c.startSpan({ ...p, parent: this.resolveParentPerChild(i, p.parent) }); }
    catch (e) { warn(...); return null; }
  });
  // ... 同 §2
}
```

> **教训（BUG-001 closed）**：实现初版直接透传 manager handle 给 child，仅 step span（parent=trace，runId 重合）幸存，generation/tool span（parent=step span）全丢。verifier 在真机 langfuse 看到 trace 只有 3 个 step span、无 generation/tool span 才暴露。修复 = 加 `resolveParentPerChild` 反查映射。**任何"包装一层 + 多 child"的 composite 设计都必须处理 parent id 翻译**，否则子树静默丢失（不报错，只是数据没了）。

## 5. 异步 / 非阻塞

对 agent loop **同步语义**（与 overall §6 接口语义一致）：

- `startTrace/endTrace/startGeneration/endGeneration/startSpan/endSpan` —— **同步返回 handle / void**，loop **不 await**。manager 内部遍历 child 同步调，热路径零阻塞。
- child（LangfuseAdapter）内部 SDK 异步 batch（见 `langfuse_adapter.md §2`）；manager 不感知 SDK 异步细节。
- `shutdown()` —— 唯一异步方法，`await Promise.allSettled(children.map(c => c.shutdown()))`；调用方（electron before-quit / node SIGTERM）await。

## 6. 构造（从 app_config observability 列表）

```typescript
interface ObservabilityConfigItem {       // 见 app_config.md §3.9
  id: string;
  name: string;
  type: 'langfuse';                       // v0.0.11 仅 langfuse
  baseUrl: string;
  publicKey: string;
  secretKey: string;                      // secret（GET 明文 + mask 收敛前端，见 app_config §3.9）
  enabled: boolean;
  desc?: string;
  logPhysical?: boolean;                  // v0.0.50：physical generation 开关（默认 false，重启生效）
}

function createObservabilityManager(items: ObservabilityConfigItem[]): ObservabilityManager {
  const children: ObservabilityAdapter[] = [];
  for (const item of items) {
    if (!item.enabled) continue;                                  // 跳过 disabled
    if (item.type !== 'langfuse') continue;                       // v0.0.11 仅 langfuse
    try {
      children.push(new LangfuseAdapter({                         // 每 item 一个独立 client
        publicKey: item.publicKey, secretKey: item.secretKey, baseUrl: item.baseUrl,
      }));
    } catch (e) {
      console.warn(`[observability:manager] construct child failed for "${item.name}"(${item.id}): ${msg(e)}`);
    }
  }
  return new ObservabilityManager(children);
}
```

**Langfuse client per-item 决策**（**per item，不 singleton**）：

- 单凭证时代是「一份凭证 → 全局 singleton Langfuse client」（已被本 composite 设计取代）。
- 列表化后，**每个 enabled 项一个独立 `LangfuseAdapter` + 独立 langfuse client**。理由：不同项可能指向**不同 baseUrl/不同项目凭证**（self-host vs cloud、staging vs prod），SDK client 状态（batch queue / flush timer / session 区分）必须隔离，复用会导致 trace 串项目。
- Langfuse SDK client 本身轻量（异步 batch，无长连接），per-item 开销可接受。

**空列表 / 全 disabled → 等价 Noop**：

- manager 持 0 个 child → 所有方法 noop（fan-out 遍历空数组，map 表为空，handle 仍照常生成返回）。
- 行为与 `NoopAdapter` 等价，loop 无感知。
- 不需要为「0 child」特殊换成 NoopAdapter 实例（保持 manager 类型统一，调用方无需判断）。

## 5.3 fan-out 按 logPhysical 过滤（v0.0.50）

每 child 携带 `logPhysical` bool 标记（来自 `ObservabilityConfigItem.logPhysical ?? false`），physical generation 按 child 过滤：

```typescript
interface ChildEntry {
  adapter: ObservabilityAdapter;
  logPhysical: boolean;   // 来自 app_config observability item.logPhysical ?? false
}
```

**fan-out 规则**：
- `startTrace` / `endTrace` / `startSpan` / `endSpan` / `startGeneration(kind='logical')` / `endGeneration(logical)` → **全部 child** fan-out（既有）。
- `startGeneration(kind='physical')` / `endGeneration(physical)` → **仅** `logPhysical=true` 的 child；`logPhysical=false` 的 child 在 childHandles 里记 null（endGeneration 跳过它，不向其调）。
- 若所有 child 都 `logPhysical=false` → 上游可通过 `hasPhysicalChild()` 快速判定，跳过 encode 后的 physical 埋点分支（零开销）。

**hasPhysicalChild()**（manager 暴露的能力探测方法）：

```typescript
hasPhysicalChild(): boolean {
  return this.children.some((c) => c.logPhysical);
}
```

bootstrap 时算好（child 列表不热更新）。`LangfuseObservabilityPort` 在 `llm_caller.invoke` 内调本方法判定是否触发 physical 埋点分支——全 false 时跳过 `startPhysicalGeneration`，零开销（等价 v0.0.49 行为）。

> **physical generation 的 handle 空间**：physical 与 logical 在同一 child 的 handle 空间内（genMap key=manager ulid，与 kind 无关）；resolveParentPerChild 逻辑不变（每 child 独立 handle 空间，physical 与 logical 各自一条 manager GenHandle，互不冲突）。

## 7. 生命周期

| 时机 | 动作 |
|---|---|
| **bootstrap**（`app/server/src/bootstrap.ts`） | 读 `devConfig.get('runtime', 'observability')`（= `ObservabilityConfigItem[]`）→ `createObservabilityManager(items)` → 注入 `AgentManagerImpl.observability` |
| **session start** | SessionConfig.observability = manager（不可变共享，跨 session 复用同一 manager 实例） |
| **run 期间** | loop 调 manager.startTrace/… → fan-out 全 enabled child |
| **关闭**（双触发） | `shutdownObservability()` → `manager.shutdown()` → `Promise.allSettled(children.map(c => c.shutdown()))`（node SIGTERM/SIGINT + electron before-quit 两处调用，见 `langfuse_adapter.md §3`） |

**不热更新**（决策已确认）：

- 用户在 UI 改 observability 列表（增/删/改/启停）→ 写 app_config（runtime 组）→ **当前进程的 manager 不变**。
- 改动在**下次 bootstrap 或下个 session**生效：
  - node server：重启进程（下次 bootstrap 重读 app_config observability 列表构造新 manager）。
  - electron：重启 app；或后续版本做 session 级 manager 重建（当前不做）。
- 理由：manager 持有的 Langfuse client 在 run 中途替换会丢 batch / 串 handle；热更新收益（即时生效）不抵风险。UI 上提示「重启生效」（见 UI spec）。

> **manager 是否 singleton**：是。bootstrap 构造一个 manager，全程注入 AgentManager；跨 session 复用同一实例（singleton，内部从「单 client」变「N client 的 composite」）。test 用 `_resetSingletonForTest()` 清理。

## 8. 边界

| 零件 | 归属 |
|---|---|
| ObservabilityManager（composite adapter）+ fan-out + 容错 + handle 映射 + 构造 + 生命周期 | 本文 ✅ |
| ObservabilityAdapter 接口 + 全量字段 + Handle 类型 | `[P0]observability_interface.md §5/§6` |
| LangfuseAdapter（child 角色）+ SDK 接入 + env/flush | `[P0]langfuse_adapter.md`（被 manager 持有） |
| observability 列表 schema（app_config runtime 组） | `specs/tech/config/[P0]app_config.md §3.9` |
| agent loop 埋点（调 adapter） | `agent_loop.md §6.1` + `agent-loop-observability.ts` |
| manager 注入点 | `bootstrap.ts` |

## 9. agent loop 埋点零改动（论证）

`LoopObservability`（`agent-loop-observability.ts`）的 8 个方法（startTrace/endTrace/startStepSpan/endStepSpan/startGeneration/endGeneration/startToolSpan/endToolSpan）全部经 `this.adapter.xxx(...)` 调用。把 `this.adapter` 从「单 adapter」换成「manager」（都实现 `ObservabilityAdapter`），**调用代码、参数、handle 用法、`safe()` 兜底——一字不改**：

| loop 用法 | 单 adapter 时 | manager 时 |
|---|---|---|
| `adapter.startTrace(p)` | 返回 Langfuse TraceHandle | 返回 manager TraceHandle（内部 fan-out） |
| `adapter.endTrace(h, p)` | h 是 Langfuse handle | h 是 manager handle（manager 内部映射分发） |
| `adapter.startGeneration(p)` | 返回 Langfuse GenHandle | 返回 manager GenHandle |
| `adapter.shutdown()` | await singleton.flush | await manager.shutdown()（fan-out flush） |
| `safe()` 兜底 | 第一层不存在（单 adapter） | 第二层兜底（与 §3 第一层互补） |

**接口不变 = 埋点不变**。manager 是纯实现替换，对 loop 是黑盒。

## 10. 文件级变更清单（impl 侧 — 供 coder 参考，本 spec 不写代码）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/observability/observability-manager.ts` | 新增 | `ObservabilityManager` class（composite，实现 `ObservabilityAdapter`）+ `createObservabilityManager(items)` factory |
| `app/server/src/observability/index.ts` | 修改 | 移除 `createObservabilityAdapter`（单 adapter + ENV 兜底）；导出 `createObservabilityManager`；`shutdownObservability()` 调 manager.shutdown()；`_resetSingletonForTest()` 重置 manager singleton |
| `app/server/src/bootstrap.ts` | 修改 | `createObservabilityAdapter(cfg)` → `createObservabilityManager(items)`；`cfg`（单对象）→ `items`（数组） |
| `app/server/src/agent/agent-loop-observability.ts` | **不改** | 埋点零改动（透明替换论证见 §9） |
| `app/server/src/observability/adapter.ts` / `types.ts` / `langfuse-adapter.ts` / `noop-adapter.ts` | **不改** | 接口/类型/child impl 均不动 |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
