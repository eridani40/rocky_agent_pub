---
type: design
title: cron expr 解析 + tz 支持 + 人话化选型
priority: P0
status: active
updated: 2026-07-04
since: v0.0.58
---

# cron expr 解析 + tz 支持 + 人话化

> 5 字段 cron 解析（搬 `refs/claude-code/src/utils/cron.ts`）+ 扩 per-job tz + UI 人话化选型（cronstrue zh_CN）。
> 引用：`[P0]engine.md §4` isDue 消费 `computeNextCronRunMs`。
> 调研依据：`specs/research/v0.0.58-cron-scheduling.md §2.5（claude-code 自实现）+ §4.1（cronToHuman）+ §4.2（库对比）`。

---

## 1. 选型：搬 claude-code 自实现 + 扩 per-job tz（0 npm 依赖）

| 维度 | claude-code 自实现（选） | npm 库（croner / cron-parser / cron-expression-parser） |
|---|---|---|
| 大小 | 0 依赖 | 15-50KB |
| 5 字段 + dom/dow OR 语义 | ✅ | ✅ |
| per-job tz | ❌ hardcoded 进程本地 → 我们扩 | 部分（croner） |
| 中文人话化 | ❌（cronToHuman 英文） | ❌（仅 cronstrue 有） |
| 维护成本 | 自维护（~200 行） | 库升级风险 |

**决策**：解析 + 下次到点计算搬 claude-code（零依赖、与 v0.0.33.4 squad scheduler 风格一致），扩 per-job tz。中文人话化单独选 cronstrue（仅 UI 层引入，server 不引入）。

**否决**：croner（openclaw 同款）——支持 tz 但引入 npm 依赖，与 server 零依赖原则不一致；claude-code 已验证自实现够用。

---

## 2. cron expr 标准（5 字段 minute-hour-dom-month-dow）

```
┌──────── 分钟（0-59）
│ ┌────── 小时（0-23）
│ │ ┌──── 日（1-31）
│ │ │ ┌── 月（1-12）
│ │ │ │ ┌ 周几（0-6，0=Sunday，7 亦=Sunday）
│ │ │ │ │
* * * * *
```

**支持语法**（与 claude-code 完全对齐）：
- `*` 通配
- `*/N` 步长（如 `*/30` 每 30 分钟）
- `N-M` 范围
- `N-M/S` 范围+步长
- `N,M,...` 列表
- 单 `N`
- `dayOfWeek` 7=Sunday alias（与 0 等价）

**不支持**（claude-code 同步）：`L` / `W` / `?` / 周几名（`MON`）/ 月名（`JAN`）—— 5 字段纯数字，简化实现。

**dom/dow OR 语义**（vixie-cron 标准）：当 dom 和 dow 都被 constrained（非 `*`），任一匹配即触发。例 `0 0 1 * 1`（每月 1 号 + 每周一 00:00）→ 1 号 OR 周一都触发。

---

## 3. parseCronExpression(expr): CronFields | null

```typescript
interface CronFields {
  minute: number[];       // [0..59]，sorted
  hour: number[];         // [0..23]
  dayOfMonth: number[];   // [1..31]
  month: number[];        // [1..12]
  dayOfWeek: number[];    // [0..6]，7 已归一为 0
}

function parseCronExpression(expr: string): CronFields | null;
```

实现直接搬 `refs/claude-code/src/utils/cron.ts`（`expandField` + `parseCronExpression`），含 dom=7 alias 归一、step/range/list 校验。

---

## 4. computeNextCronRunMs(expr, from, tz): number | null

**claude-code 原版**：`computeNextCronRun(fields, from)` 返 `Date`，用 `from.getMinutes()` 等本地字段迭代（hardcoded 进程本地 tz）。

**本版本扩展**：per-job tz 支持，签名扩为 `computeNextCronRunMs(expr, from, tz)`，内部用 `Intl.DateTimeFormat` 取 from 在 tz 的字段：

```typescript
function computeNextCronRunMs(expr: string, from: Date, tz: string): number | null {
  const fields = parseCronExpression(expr);
  if (!fields) return null;
  // 从 from 在 tz 的 Y/M/D/H/min 起，分钟级向后迭代，找第一个匹配字段
  // 最多 maxIter=366*24*60 步（一年分钟数，足够覆盖 cron 跨月场景）
  // dom/dow 都 constrained → OR 语义（任一匹配）
  // 返匹配时刻 epoch ms，无匹配（如 2/30 不存在）返 null
}
```

**tz 转字段实现**（参考 `app/server/src/squad/scheduler/gate-chain.ts:toTimeZoneHHmm` 同模式）：

```typescript
function fieldsInTz(d: Date, tz: string): {y:number;mo:number;day:number;h:number;mi:number} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t:string) => Number((parts.find(p=>p.type===t)||{value:'0'}).value);
  const h = g('hour') % 24;   // hourCycle:'h23' 仍可能在某些 locale 返 24
  return { y:g('year'), mo:g('month'), day:g('day'), h, mi:g('minute') };
}
```

**迭代算法**：
1. 锚点 = from + 1 分钟（不含 from 本身分钟，因 isDue 是 `next <= now`）
2. 取候选时刻在 tz 的 Y/M/D/H/min 字段
3. 检查 min∈fields.minute ∧ h∈fields.hour ∧ mo∈fields.month ∧ (day∈fields.dayOfMonth ∨ (fields.dayOfMonth=*) ∨ dow∈fields.dayOfWeek ∨ (fields.dayOfWeek=*))
   - 完整 dom/dow OR：dom constrained ∧ dow constrained → 任一匹配；dom 或 dow 之一是 `*` → 该字段恒真
4. 命中即返；否则 +1 分钟继续，maxIter 兜底返 null

**性能**：典型场景（每 N 分钟 / 每天 HH:mm）迭代 < 1440 步即命中；最坏 cron 跨月 < 50k 步（毫秒级）。

---

## 5. 边界：DST / 跨时区

- **DST spring-forward gap**（春令时跳过 02:00-03:00）：cron 在跳过时段内（如 `0 2 * * *` 在 spring-forward 日）→ 该日不触发，等下一日。算法自然实现（迭代跳过非存在时刻）。
- **DST fall-back repeat**（秋令时重复 02:00-03:00）：cron 在重复时段内 → 触发一次（isDue 已满足，lastFiredAt 推进）。
- **跨时区**：`computeNextCronRunMs(expr, from, userTz)` 永远在用户时区算 next，与 server 本地时区无关（即使 server 在 UTC，user 在 Asia/Shanghai，cron 9:00 仍按上海 9:00 触发）。

---

## 6. 用户时区来源

`Job.schedule.tz` 是必填字段，取值规则（**PRD/arch 阶段决策**）：

| 场景 | tz 来源 | 兜底 |
|---|---|---|
| playground rocky session | session.timezone（新增 schema 字段，PRD/arch 定） / 用户配置 | `Intl.DateTimeFormat().resolvedOptions().timeZone`（server 进程本地） |
| squad leader / mate session | squad.timezone（v0.0.33.4 已有字段） | 同上 |

**新增 schema**：`session.timezone`（IANA string，optional，缺省 fallback）。session schema 已有 squadId/memberId，加 timezone 是同模式增量。详见 `[P1]cron_subsystem.md §5`。

---

## 7. UI 人话化选型：cronstrue (zh_CN)

**决策**：UI 层（`app/web/`）引入 `cronstrue` npm 包（~50KB），用 `'zh_CN'` locale 输出「每 30 分钟」「周一至周五 09:00」等中文文案。

| 库 | 选 | 原因 |
|---|---|---|
| `cronstrue` | ✅ | 内置 zh_CN，覆盖最全，最流行 |
| `cron-parser` | ❌ | 仅 parse，无 stringify |
| `cron-expression-parser` | ❌ | 仅 en toHuman |
| `croner` | ❌ | 无翻译 |

**接入策略**：
- **展示态**（cron job 列表）：`cronstrue.toString(expr, { locale:'zh_CN', tz })` 直接渲染。库翻译不出 → fallback 显示 raw expr（claude-code 同模式）。
- **编辑态**（频率选择器）：UI 提供 4 个预设 chip（每 N 分钟 / 每 N 小时 / 每天 HH:mm / 每周 X HH:mm）+「自定义 cron」高级折叠。预设选定 → 程序生成 expr（不调 cronstrue parse）。raw expr 仅在「自定义」暴露。
- **工具层不变**：agent `cron` 工具（action=create/update）直接收 cron expr（见 `[P1]cron_subsystem.md §6`），UI 翻译 ↔ expr 双向只在 web 层。

**server 不引入 cronstrue**：server 仅做 `parseCronExpression` 校验合法性（自实现，0 依赖）；人话化纯 UI 关注点，不入 server bundle。

---

## 8. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/scheduling/cron-expr.ts` | 新增 | `parseCronExpression` + `computeNextCronRunMs`（搬 claude-code + 扩 tz） |
| `app/server/src/scheduling/cron-expr.test.ts` | 新增 | UT：5 字段解析 / dom-dow OR / per-job tz / DST gap / 跨月 |
| `app/web/package.json` | 修改 | 新增 `cronstrue` dependency |
| `app/web/src/.../CronHumanReadable.tsx` | 新增 | UI 组件（包装 cronstrue zh_CN + fallback raw expr） |

> UI 组件具体 spec 由 coder 编码前置产出（`specs/ui/components/` 下），本文件仅定 server 侧解析契约。

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
