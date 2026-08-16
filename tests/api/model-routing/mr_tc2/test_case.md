# mr_tc2 — 同模型条目约束专项

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `PUT /config/app` (group=model_routing_plans) | 21-model-routing.md §2.2 校验表 | 同模型约束全规则（PRD §2.8 UC-21/22/23 黑盒补充）：合法组合 / 停用豁免 / enabled 缺省 / 非法 model / 非法 provider / priority 非法 |

## 断言面

**合法组合（PRD UC-8 基础语义）**
- 同模型 1 带时间（priority1 在上）+ 1 不带时间（priority2 在下）+ 第二模型 → `.ok == true`
- GET 回读：`.items[] any .data.items[0].timeCondition.hours[0] == 2` + `hours[21] == 23`（白名单小时格 2-23 落库）+ `.data.items[1].timeCondition absent`（无条件条目无 timeCondition）

**停用条目不占额度（D15 / PRD UC-5~7）**
- 同模型 2 无条件条目，其一 `enabled: false` → 合法通过（按启用条目统计）

**enabled 缺省兼容（api §2.2 兼容层）**
- 条目不带 enabled 字段 → 通过（兼容层缺省 true）

**非法引用 400**
- modelId 不存在 → `.error ~= "model not found or disabled"`
- providerId 不存在（硬编码无效 ULID）→ `.error ~= "model not found or disabled"`

**priority 非法 400**
- priority=0 → `.error ~= "priority"`
- priority 重复 → `.error ~= "priority"`

## 设计权衡

- **mr_tc1 已覆盖 2 带时间/带时间在下/2 不带时间 3 条 400**（test-plan 分派），本 case 补其余校验规则（合法/豁免/缺省/非法引用/priority）——与 mr_tc1 分工互补，避免重复
- **hours 长度断言改用索引存在性**（`hours[21] == 23`）——check 引擎 eval_path 不支持 `.size`（实测返回 False），skill 陷阱 W2 同族
- **teardown 清理 3 个合法方案**（含停用豁免 + enabled 缺省）

## 前置依赖

- v0.0.347 `model-routing-validation.ts`（同模型约束 + model 校验 + priority 校验 + enabled 缺省兼容）已实现
