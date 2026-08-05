---
type: interface
title: ProviderHealthRegistry（provider 健康注册表）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.25
related: [[P0]llm_caller.md, [P0]llm_request_config.md, [P0]retry_and_timeout.md]
---

# ProviderHealthRegistry（provider 健康注册表）

> 管什么：记录每个 `(sessionId, providerId, keyRef, modelId)` 的健康状态（healthy / degraded / cooled_down / dead）；提供状态升级 / 到期恢复 / 查询接口。
> 不管什么：fallback chain 遍历逻辑（归 resolveTarget，见 `[P0]llm_caller.md §2.2`）；session 级错误状态（→ `LlmErrorState`，见 `[P0]llm_request_config.md §2`）；退避算法（→ `[P0]retry_and_timeout.md`）。
> **核心约束（refs openclaw 原则）**：用 **discriminated union** 表示状态，不用并行 bool（avoid impossible states）。
> **health state key = `(sessionId, providerId, keyRef, modelId)` 四元组**——per-session × per-model 双隔离（session-scoped 存储，session 结束清理）。

---

## 1. 概念（What）

**[v0.0.25 改版]**：429/overload/cooldown 是 **(session, provider, key, model)** 的属性，不是进程全局也不是单 (provider,key)。一个 model 的 cooldown **不影响**别的 model（同 provider 不同 model 独立）；A session 的 cooldown **不影响** B session（session 隔离）。存储按 session 分区（session-scoped Map），session 结束（AgentManager 销毁 session / run 结束）清理对应分区。

**为什么从「进程级全局」改为「per-session × per-model」**（推翻 v1.0）：
- **per-model 隔离**：同 provider 下不同 model（如 claude-sonnet vs claude-opus）独立 quota / 独立容量，不应共享 cooldown；旧 `(providerId, keyRef)` key 会让 opus 的 overload 连累 sonnet 被跳过。
- **per-session 隔离**：A session 触发某 model cooldown，B session 用同 model 可能仍是健康（用户/账户隔离、CDN 路由不同等）；进程全局共享会让 B session 无谓跳过。session 结束清理避免 stale cooldown 累积。
- **保留 reqs.md §3 原意**（「冷却窗口应避免每个 session 各自重试各自踩坑」）：同 session 内的多个并发 run / iteration 共享该 session 的健康表（同 session 的 attemptLoop 不会各自踩坑）；跨 session 隔离是合理的，因为 session 通常代表不同用户/上下文。

`ProviderHealthRegistry` 是 **per-session 实例**（或 `Map<sessionId, SessionHealthTable>` 的 session-scoped 存储）。LlmCaller.invoke 调 `resolveTarget` 时读它，调 `escalate / recordSuccess` 时写它。

**状态机**（4 态 discriminated union）：

```
                   escalate (consecutive >= threshold)
    healthy ────────────────────────────────────► cooled_down {until}
       ▲                                              │
       │                                              │ escalate (2nd consecutive window)
       │                                              ▼
    degraded ◄─────────────────────────────────── degraded {until}
       │                                              │ escalate (3rd consecutive window)
       │                                              ▼
       │                                            dead
       │ cooldownUntil expire
       │ (MVP: 直接回 healthy；half-open defer)
       └──────────────────────────────────────────────
```

---

## 2. 类型定义（discriminated union）

```typescript
/** per (sessionId, providerId, keyRef, modelId) 的健康状态（discriminated union） */
type ProviderHealthState =
  | { status: "healthy"; consecutive: { overload: number; rate_limit: number; auth: number } }
  | { status: "cooled_down"; until: number; consecutive: { overload: number; rate_limit: number; auth: number } }
  | { status: "degraded"; until: number; consecutive: { overload: number; rate_limit: number; auth: number } }
  | { status: "dead"; reason: string; at: number };

interface HealthEntry {
  /** [v0.0.25 改版] 完整四元组 key——per-session × per-model 双隔离 */
  sessionId: string;        // session 标识（session-scoped 存储分区键；session 结束清理）
  providerId: string;       // app_config provider 实例 id（LlmProviderConfig.id = data.id）
  keyRef: string;           // credential key 引用（多 key 时区分；单 key = "default"）
  modelId: string;          // [v0.0.25 新增] model 标识（per-model 隔离；同 provider 不同 model 独立 cooldown）
  state: ProviderHealthState;
}

/** [v0.0.25 改版] session-scoped 注册表（非进程级单例） */
interface ProviderHealthRegistry {
  /** 查询某 (session, provider, key, model) 当前健康状态——供 resolveTarget 两遍扫描用 */
  getState(sessionId: string, providerId: string, keyRef: string, modelId: string): ProviderHealthState;

  /** [resolveTarget 用] 查询「是否优先选」（healthy 才返 ok=true；其余状态返 ok=false + 原因 + tier 标识） */
  isPreferred(sessionId: string, providerId: string, keyRef: string, modelId: string): 
    | { ok: true; tier: "healthy" }
    | { ok: false; tier: "degraded" | "cooled_down" | "dead"; reason: string; until?: number };

  /** [resolveTarget 用] 查询「是否可兜底」（healthy 或 degraded 才 ok=true；cooled_down/dead 返 false） */
  isAvailable(sessionId: string, providerId: string, keyRef: string, modelId: string): 
    | { ok: true; tier: "healthy" | "degraded" }
    | { ok: false; tier: "cooled_down" | "dead"; reason: string; until?: number };

  /** 记录一次失败，升级状态（consecutive 累加 / 跨阈值升级 / 设 cooldownUntil） */
  escalate(sessionId: string, providerId: string, keyRef: string, modelId: string, category: LlmErrorCategory, now: number): void;

  /** 记录一次成功，重置 consecutive + 状态降级恢复 */
  recordSuccess(sessionId: string, providerId: string, keyRef: string, modelId: string): void;

  /** 显式标 (provider, key, model) dead（连续 AUTH 触发，见 decide ROTATE_KEY） */
  markDead(sessionId: string, providerId: string, keyRef: string, modelId: string, reason: string): void;

  /** [v0.0.25 新增] session 结束时清理对应分区（释放内存，防 stale cooldown 累积） */
  cleanupSession(sessionId: string): void;

  /** 列举某 session 所有 fallback chain 涉及的 (provider, key, model) 状态快照（debug / langfuse） */
  snapshot(sessionId: string): HealthEntry[];
}
```

**[v0.0.25 改版] isPreferred vs isAvailable 语义**：
- `isPreferred` = true 仅当 `healthy`（resolveTarget 第 1 遍扫描用——优先选健康项）。
- `isAvailable` = true 当 `healthy` **或** `degraded`（resolveTarget 第 2 遍兜底扫描用——degraded 兜底可用）。
- `cooled_down`（未到期）：两者都返 false——**不调用**（尊重 until 冷却窗口）。
- `dead`：两者都返 false——**排除**（本 session 不再用）。

**为什么 consecutive 拆 overload / rate_limit / auth 三计数**：三类错误的升级阈值与恢复策略不同（overload 升级快、auth 升级即 dead）；合并为单一 consecutive 会丢失语义。

---

## 3. 状态升级 / 恢复规则

### 3.1 升级规则

`escalate(providerId, keyRef, category, now)` 内部：

```typescript
function escalate(entry: HealthEntry, category: LlmErrorCategory, now: number, config: DegradationConfig): void {
  const c = entry.state.consecutive;
  
  // 1. 累加 consecutive（按 category）
  if (category === LlmErrorCategory.PROVIDER_OVERLOADED) c.overload += 1;
  else if (category === LlmErrorCategory.RATE_LIMITED) c.rate_limit += 1;
  else if (category === LlmErrorCategory.AUTH_INVALID || category === LlmErrorCategory.AUTH_FORBIDDEN) {
    c.auth += 1;
    // AUTH 连续 N 次 → 直接 markKeyDead（凭证类硬错，重试无意义）
    if (c.auth >= config.consecutiveToDegrade) {
      entry.state = { status:"dead", reason:`auth failed ${c.auth} times`, at: now };
      return;
    }
  }

  // 2. overload/rate_limit 连续达阈值 → 升级状态
  const totalInstant = c.overload + c.rate_limit;
  if (totalInstant >= config.consecutiveToDegrade) {
    const cooldownUntil = now + config.cooldownS * 1000;
    if (entry.state.status === "healthy") {
      entry.state = { status:"cooled_down", until: cooldownUntil, consecutive: c };
    } else if (entry.state.status === "cooled_down") {
      // 已 cooled_down 又失败 → 升 degraded（更长 cooldown）
      entry.state = { status:"degraded", until: now + config.cooldownS * 2000, consecutive: c };
    } else if (entry.state.status === "degraded") {
      // degraded 再失败 → dead（该 (provider,key) 本次进程生命周期内不再用）
      entry.state = { status:"dead", reason:`instant errors ${totalInstant} times (degraded escalate)`, at: now };
    }
  }
}
```

### 3.2 恢复规则（MVP：到期直接回 healthy）

```typescript
function refreshState(entry: HealthEntry, now: number): void {
  if (entry.state.status === "cooled_down" && now >= entry.state.until) {
    // MVP：直接回 healthy（half-open 探测 defer，见 §6.2）
    entry.state = { status:"healthy", consecutive: { overload:0, rate_limit:0, auth: entry.state.consecutive.auth } };
  } else if (entry.state.status === "degraded" && now >= entry.state.until) {
    entry.state = { status:"healthy", consecutive: { overload:0, rate_limit:0, auth: entry.state.consecutive.auth } };
  }
  // dead 不自动恢复（进程级，重启 reset；或懒重验见 §6.1）
}
```

`isAvailable()` 调用前先 `refreshState(entry, now)` 检查到期。

### 3.3 recordSuccess（降级恢复 + 清计数）

```typescript
function recordSuccess(entry: HealthEntry): void {
  // 成功 → 清 overload/rate_limit 计数（auth 计数不清，auth 是硬错）
  entry.state.consecutive.overload = 0;
  entry.state.consecutive.rate_limit = 0;
  // 状态降级：degraded → cooled_down → healthy？MVP：成功即回 healthy（除 dead）
  if (entry.state.status === "cooled_down" || entry.state.status === "degraded") {
    entry.state = { status:"healthy", consecutive: entry.state.consecutive };
  }
  // dead 不因成功恢复（dead 是 (provider,key) 级，本次进程不再用）
}
```

---

## 4. account-wide quota 例外（hermes 教训）

多 key credential 中，部分 provider 的 quota 是 **account-wide**（如 hermes refs `run_agent.py:244-260` Google CloudCode）—— 这类 provider **轮换 key 无效**（所有 key 共享一个 quota），rate_limit 时应直接 `FALLBACK` 换 provider，不 ROTATE_KEY。

**schema 标注**（credentials 多 key 扩展，见 `[P0]llm_request_config.md §4`）：

```typescript
interface CredentialKey {
  keyRef: string;        // 引用名（"default" / "backup" / ...）
  keyValue: string;      // 实际 key（或 env var 引用）
  /** quota 作用域：per-key（每 key 独立 quota，可轮换）vs account-wide（所有 key 共享 quota，不轮换） */
  quotaScope: "per_key" | "account_wide";
}
```

`resolveTarget` 遍历 fallback chain 时，若 provider 的所有 key 都是 `account_wide`，rate_limit 错误不进 ROTATE_KEY 路径，直接 FALLBACK 换 provider。

---

## 5. cooldown 设定时机（避 chain-switch 累加）

**hermes 教训（refs `chat_completion_helpers.py:1057-1065`）**：chain 切换时若重置 primary 冷却，会导致「切到 secondary 失败又切回 primary」无限循环。

**v0.0.25 规则**：
- `escalate()` **只在「该 (provider,key) 本次确实失败」时设 cooldownUntil**（即 attemptLoop catch 到属于该 provider 的错误）。
- `resolveTarget` 切换到下一个 chain 项时**不**对前一项调 escalate（前一项的 cooldown 由它自己的失败记录决定，不由「被切换」触发）。
- 即：cooldown 是「失败次数累计触发的」，不是「被换走触发的」。

---

## 6. 设计决策（Why）

### 6.1 dead-key 不扛重启（MVP）

**结论**：dead 状态进程级，重启 reset。下次该 key 被选中时**懒重验**（直接尝试一次，成功则回 healthy，失败则再 escalate）。
**理由**：dead 可能是临时（key 被临时禁用、quota 短暂耗尽）；扛重启需持久化 + TTL + 清理，复杂度高，v0.0.25 MVP 不做。懒重验是廉价兜底（最坏浪费一次失败调用）。
**反例**：若 dead 永久扛重启，key 恢复后仍不用，浪费。

### 6.2 half-open 探测 defer（MVP）

**结论**：cooldown 到期直接回 healthy（不进 half-open 中间态）。
**理由**：half-open 需要「探测请求」语义（限流 1 个请求验证），增加状态机复杂度；MVP 直接回 healthy 让正常请求验证（失败会再 escalate）。refs 三个都没实现 half-open。
**future**：若 cooldown 恢复后又快速失败（闪电升级），再考虑 half-open。

### 6.3 discriminated union（不用并行 bool）

**结论**：状态用 `status: "healthy" | "cooled_down" | "degraded" | "dead"` discriminated union，cooled_down/degraded 携带 `until: number`。
**理由**：openclaw AGENTS.md 原则「make impossible states unrepresentable」—— 若用 `isCooledDown: boolean + cooldownUntil?: number + isDead: boolean`，会出现 `isCooledDown=true && isDead=true` 这种不可表示状态。discriminated union 让 TS 编译器强制每个 case 处理。
**反例**：并行 bool 的 impossible state（dead 且 cooled_down）会运行时出错。

### 6.4 consecutive 拆 overload / rate_limit / auth

**结论**：三类错误独立计数，不合并。
**理由**：overload 是 provider 容量问题（换 key 无效，应换 provider）；rate_limit 可能 per-key（换 key 有效）；auth 是 key 硬错（连续即 dead key）。合并会丢失「为何升级」的语义。
**反例**：合并 consecutive 后 decide 无法区分「该 ROTATE_KEY 还是 FALLBACK」。

### 6.5 进程级单例（非 session 级）

**结论（v0.0.25 推翻）**：~~`ProviderHealthRegistry` 是 `globalThis.__providerHealthRegistry` 单例（或 DI 根注入），跨所有 session 共享。~~
**[v0.0.25 改版结论]**：改为 **`(sessionId, providerId, keyRef, modelId)` 四元组 key + session-scoped 存储**（session 结束 cleanupSession 清理）。
**推翻理由**：
1. **per-model 隔离必要**：同 provider 下不同 model（claude-sonnet vs claude-opus）独立 quota / 容量，旧 `(providerId, keyRef)` key 会让一个 model 的 overload 连累同 provider 别的 model 被跳过。
2. **per-session 隔离合理**：A session 触发 cooldown 不应影响 B session（用户/账户/路由可能不同）；进程全局共享过于激进。
3. **同 session 内仍共享**：同 session 的多个并发 run / attemptLoop 仍共享该 session 健康表（避免同 session 内各自踩坑，保留 reqs.md §3 原意）。
**实现**：`Map<sessionId, Map<compositeKey, HealthEntry>>`；compositeKey = `${providerId}|${keyRef}|${modelId}`；AgentManager 销毁 session 时调 `cleanupSession(sessionId)`。
**反例（旧设计问题）**：进程全局共享会让 B session 因 A session 的 transient cooldown 无谓跳过好 model；同 provider 不同 model 共享 key 会让 model 间连坐。

---

## 7. 边界

| 零件 | 归属 |
|------|------|
| ProviderHealthState discriminated union / HealthEntry / Registry 接口 | 本文件 ✅ |
| 升级 / 恢复 / recordSuccess 规则 | 本文件 §3 ✅ |
| account-wide quota 例外（quotaScope 标注） | 本文件 §4（credentials schema 在 `[P0]llm_request_config §4`） |
| cooldown 设定时机（不因 chain-switch 累加） | 本文件 §5 |
| resolveTarget 遍历 fallback chain | `[P0]llm_caller.md §2.2 §3` |
| credentials 多 key schema | `[P0]llm_request_config.md §4` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
