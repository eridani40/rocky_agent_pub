# v0.0.364 change_log — squad 额度弹层 tier 时间段对齐参照实现 fmtHours（bug 修复）

> 需求：老板 2026-08-15 22:34 报「弹层 tier 时间段显示 00:00-23:00 错误」。
> 根因：`states/v0.0.364/bug-analysis-tier-hour-range.md`（bug-analyst：`formatHourRange` 对 hours 白名单只取 min/max 拼一个区间——多段被吞 + 段末差 1h；纯前端展示缺陷，数据链无损）。
> 权威契约：`specs/tech/version_logs/v0.0.364/change_plan.md`（方案 A 冻结）。
> commit：`29db6b50e`（架构）/ `eac1040bf`（T1 实现）/ `9f8c59ce4`（T1 review PASS，五面全过无 Minor）。

## 变更摘要

弹层 item 行时间段文本（v0.0.356 引入）自创了简化格式化，与模型方案侧已有 `fmtHours`（v0.0.347）形成两套解读。老板拍板：**直接引用同一份实现，禁止第二套解读**；段末 24:00（exclusive 边界）+ 多段展示。

| 决策 | 内容 |
|---|---|
| ① 同源（方案 A） | card ItemRow 直接 `import { fmtHours } from '../app-dev-config-page/component-hour-grid-picker'`（跨 feature import 有先例：use-squad-quota 已引同目录 model-routing-api）；不动参照实现，最小暴露面 |
| ② 段末 24:00 | fmtHours 的 `hoursToRanges` 段末 = prev+1（exclusive 边界），23 点在段内时端点 24 |
| ③ 多段展示 | 连续段合并 + 多段 `', '`（英文逗号+空格，参照逐字节）分隔：`[0..13,18..23]` → `00:00-14:00, 18:00-24:00` |
| ④ 死代码删除 + 双份收敛 | `formatHourRange` 从 quota-format 删除（唯一消费方已改）；`hourHit` 私有副本（use-squad-quota）删，改 import quota-format 版（逐字等价，行为零变化） |
| ⑤ 空值兼容 | `fmtHours([])` 返回 `''`（falsy）→ ItemRow `range ? ... : t('quotaModal.timeAny')` 自然走「不限时」，分支零特判 |

## 实现核对（T1，eac1040bf +28/-27）

| 计划项 | 实现一致性 |
|---|---|
| card L212 换引 fmtHours | ✅ import 路径与 change_plan §1.2 逐字一致；空数组 UT 用例断言「不限时」锁死 |
| formatHourRange 删除 | ✅ 代码级残扫零命中；quota-format 头注释同步改「区间展示」→「命中判定」 |
| hourHit 收敛 | ✅ use-squad-quota 删私有副本改 import；h23 hourCycle 语义保留（D5） |
| UT 翻新 | ✅ 单段断言翻 `/02:00-24:00/` + 多段 prod 实数据形态 + 空数组不限时；26/26 绿，全量 10846 passed/4 skipped，tsc -b 0 |
| 偏离 1 处（合理） | change_plan 前提笔误：`[2,23]` 字面量是两个离散小时非连续段——fixture 修真连续 `[2..23]` 才使断言成立，coder 实测复现后修正+注释报备 |

## spec 同步（本文件所在目录之外的全部落点）

| spec | 更新 |
|---|---|
| `specs/ui/components/chat-page/component-quota-provider-card.md` | item 行时间条件改 fmtHours 同源描述（多段+24:00+空值走不限时）；复用关系补 fmtHours 三消费方同源注记 |
| `specs/ui/components/providers/quota-format.md` | 函数清单删 formatHourRange 行；设计决策新增「文本展示不在本模块」同源指针；复用关系拆 card（无 formatHourRange/hourHit）+ use-squad-quota（hourHit 唯一消费方） |
| `specs/ui/components/chat-page/use-squad-quota.md` | hours 命中改 import 单一实现描述；消费清单删 formatHourRange |
| `specs/ui/components/app-dev-config-page/component-hour-grid-picker.md` | 消费方清单补 quota-provider-card（区间文本全仓唯一实现，三方同源） |

## 验证

- UT 必须（已过）；ET 豁免（test-plan 写明：纯前端格式化无交互流变化）；老板亲验收（口径：弹层展开行显示 `00:00-14:00, 18:00-24:00`）。
