# v0.0.364 变更计划书 — squad 额度弹层 tier 时间段展示对齐参照实现（引用同一份 fmtHours）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 0. 需求与拍板

| 时间 | 拍板 | 内容 |
|---|---|---|
| 老板拍板链 | ①修复=squad 侧直接引用应用配置侧**同一份实现**，禁止第二套解读 ②段末到午夜 **24:00**（exclusive 边界）③**多段展示** ④逗号按参照**逐字节英文 `', '`**（不自创原则） | |

- 输入：`states/v0.0.364/bug-analysis-tier-hour-range.md`（bug-analyst，根因/复现/影响面已实证）
- 根因：`quota-format.ts:111-116 formatHourRange` 只取 min/max 拼一个区间——多段合并 + 段末少 1h（[0..13,18..23] → `00:00-23:00`，应为 `00:00-14:00, 18:00-24:00`）。参照实现 `fmtHours`（component-hour-grid-picker.tsx:37-68，v0.0.347）语义正确。
- 纯展示 bug 无交互变化 → 跳 PRD。

## 1. 方案设计

### 1.1 方案裁决：A（卡片直接 import fmtHours）

**选 A**，理由：
1. **跨 feature import 有先例**：use-squad-quota.ts L18-19 已从 `../app-dev-config-page/` import model-routing-api/types——squad 侧引应用配置侧模块是既有惯例，非新破坏。
2. **不动参照实现**（老板「不自创」原则的最小暴露面）：A 零改 picker.tsx / plan-item-row.tsx；B 平移纯函数族进 lib 需同步改参照实现文件 import + picker 既有 UT import，改动面×3 且触碰本版无需动的正确代码。
3. B 的收益（util 落位更正）是审美级，可在未来组件重构版顺带做；本版是 bug fix，止血优先。
4. picker.tsx 纯函数族（normalizeHours/hoursToRanges/formatRanges/fmtHours）无 React/i18n 依赖、已 export——import 无副作用。

### 1.2 修复接线（2 文件 + 1 行为变更点）

`component-quota-provider-card.tsx`：
- L25 import 区：`formatHourRange` 从 quota-format import 名单中移除；新增 `import { fmtHours } from '../app-dev-config-page/component-hour-grid-picker'`
- L211：`formatHourRange(card.hours)` → `fmtHours(card.hours ?? [])`
- 空值语义兼容（实证）：`fmtHours([])` 返回 `''`（falsy），L212 `range ? ... : t('quotaModal.timeAny')` 自然走「不限时」，分支零改动

### 1.3 第二套解读删除 + hourHit 双份收敛（本期一并做）

- **formatHourRange 删除**（quota-format.ts:111-116）：grep 实证唯一消费方 = card L211（本次改掉）；团队规则死代码必删 + 老板「禁止第二套解读」点名。
- **hourHit 双份收敛**（顺带，bug 报告连带项）：**新实证——quota-format.ts:122 导出的 hourHit 零消费方**（use-squad-quota.ts:106 是自己的私有副本，L119 消费）。收敛方向：use-squad-quota.ts 删私有 hourHit（L106-111）→ `import { hourHit } from '../providers/quota-format'`。两份逐字重复（含 h23 hourCycle 修正语义），行为零变化；use-squad-quota.test.ts:223 hourHit h23 describe 经 hook 走（私有函数未导出，无测试直接 import 断链风险——grep 实证测试无 hourHit 直 import）。

### 1.4 逗号口径

按老板拍板④：参照实现 `formatRanges` join `', '`（英文逗号+空格）逐字节——picker footer/tooltip 与弹层三处一致（单一实现的自然收益）。不改 formatRanges。

## 2. 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web/chat-page | app/web/src/components/chat-page/component-quota-provider-card.tsx | import 区 + ItemRow | 修改 | L25 移除 formatHourRange import + 新增 fmtHours import（app-dev-config-page）；L211 调用替换 | MUST：fmtHours(card.hours ?? []) 空数组语义走「不限时」 | 本表 §1.2 | +2/-1 |
| web/providers | app/web/src/components/providers/quota-format.ts | formatHourRange | 删除 | L111-116 整函数删（唯一消费方已改） | MUST：删前 grep 零消费方复验 | 本表 §1.3 | -7 |
| web/chat-page | app/web/src/components/chat-page/use-squad-quota.ts | hourHit（私有） | 删除+import | L106-111 私有副本删 → `import { hourHit } from '../providers/quota-format'` | MUST：行为零变化（逐字重复已实证）；h23 测试保持绿 | 本表 §1.3 | +1/-6 |
| 测试 | app/web/src/components/chat-page/__tests__/component-quota-provider-card.test.tsx | 展开行断言 | 修改 | L173 `/02:00-23:00/` → `/02:00-24:00/`（mkCard hours=[2,23] 连续段段末 24）；新增多段用例：mkCard({hours:[0..13,18..23]}) → `/00:00-14:00, 18:00-24:00/`（prod 实数据形态） | MUST：全绿 + tsc -b 0 error | req UT 面 | +8/-1 |

## 3. 影响面与验证

- **影响**：squad 额度弹层 item 行时间段文本（多段拆分展示 + 段末 24:00）；其余零变化（命中判定 hourHit 行为不变、应用配置侧展示不变、路由执行层不动）。
- **验证**（leader 问题④建议）：**UT 必须**（纯函数字节级输出已由渲染断言逐字节锁死：单段段末 + 多段双断言）；**ET 豁免**（test-plan 写明：纯前端格式化文本、无交互流变化、UT 断言已达逐字节）；**老板亲验收**（打开弹层看 `00:00-14:00, 18:00-24:00`）。
- **specs 同步**（doc-modifier 收尾）：无 spec 记录 formatHourRange（356 change_plan 无该函数契约），零 spec 追改；bug-analysis 报告存档即可。
