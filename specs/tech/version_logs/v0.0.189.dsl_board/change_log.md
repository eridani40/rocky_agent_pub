# v0.0.189.dsl_board 变更日志 — Panorama 校验引擎（Task#2）

> 记录实现期相对 change_plan.md 的偏差与补充决策。change_plan.md 为冻结合同，本文件追记偏差。
> 关联 spec：`specs/tech/squad/[P1]panorama_validation.md`（权威规则源）

## 1. 文件布局偏离

**change_plan 原设计**：校验引擎单文件 `app/server/src/squad/panorama/validation/validator.ts`。

**实际实现**（per-layer 拆分，降低单文件体量、贴合四层职责边界）：

| 文件 | 职责 | spec 对应 |
|------|------|-----------|
| `types.ts` | 四层返回结构 + StoreLike + 共享错误工厂 makeError | §1.2 |
| `validate_schema.ts` | 主入口 + Layer 1 语法 + Layer 2 schema | §1-§3 |
| `validate_semantic.ts` | Layer 3 语义层（跨引用闭合） | §4 |
| `validate_data_safety.ts` | Layer 4 数据安全层（七项破坏性判定） | §5 |
| `validate_instance.ts` | §6 实例写校验 | §6 |
| `validate_transition.ts` | §7 跃迁校验 | §7 |
| `index.ts` | 模块导出 | — |

**理由**：单文件会超 300 行硬上限（七层规则合计 > 600 行）。per-layer 拆分让每文件
独立可测、职责单一，符合 code-reviewer「单一职责」要求。导出聚合在 `index.ts` 保持
对外 API 不变。

## 2. 错误码对齐（code-review m2 轮 1）

- `panorama_unknown_table_column` → `panorama_unknown_column`（对齐 spec §4 错误码表）
- 移除 spec 未定义的 `panorama_invalid_column_value`（kanban columns 越界）；
  保留 `panorama_warn_missing_column` warning（spec §4 末行已定义）

## 3. 共享错误工厂（code-review m5 轮 1）

四层文件原本各复制一份 `e()` helper。收敛为 `types.ts` 的 `makeError(layer, code, path, msg, suggestion?)`
单一工厂，各文件保留固定 layer 的一行委托别名。
