# v0.0.294 变更计划书 — assemble 合并后 sender 下沉到 block 层

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 背景

role_merge（clean view reducer）合并相邻同 role 消息时，被合并 message 的 sender 被丢弃。合并后 logical message 内多个 block 可能来自不同 sender（user/system/agent），但 message.sender 只保留第一条的——信息不准确。

**纯技术驱动版本**（无用户可感知行为变化），跳过 PRD，直接出 change_plan + task.json。

## 设计方案（老板确认）

- **物理层（transcript 落库）**：sender 在 message（每条独立）——不变
- **assemble 合并后（logical message）**：sender 下沉到 block，message.sender 清空（不撒谎）
- **protocol encode（logical-view）**：按 block.sender 渲染前缀（不再只给首块加）

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| message | app/server/src/message/types.ts | `TextBlock.sender` | 新增字段 | 加可选字段 `sender?: MessageSender`。物理层 transcript block 不带此字段（向后兼容）；仅 role_merge 合并后注入 | MUST 是 optional（物理层 block 无此字段）；MUST NOT 给其他 block 类型（ImageBlock/ToolCallBlock 等）加 sender——sender 注入只作用于 TextBlock | agent_message_interface §3（TextBlock）；§5（MessageSender） | +1 |
| context_engine | app/plugins/builtins/rocky_context/assemble/role_merge.ts | `RoleMergeReducer.reduce()` | 修改 | 合并分支（`last.role === m.role`）增加两步：(1) 把被合并 message `m` 的每个 block clone 后注入 `block.sender = m.sender`（注入到所有 block 类型，不只 TextBlock）；(2) 合并完成后将 `last.sender = undefined`（置空，表示逻辑 message 内 block 来自多 sender）。非合并分支（push 新 message）不变 | MUST clone block 再注入（不 mutate 入参 block）；MUST NOT 对未发生合并的 message 清空 sender；MUST 合并后 `last.sender = undefined`（置空不是删字段）；MUST 对所有 block 类型注入 sender（TextBlock/ImageBlock/ToolCallBlock 等都要，因为 logical-view 渲染前缀时可能遇到非 text 首块） | context_assemble_detail §5b（role_merge 职责）；logical-view §3.3（前缀注入：首块非 text 时 prepend） | +12/-2 |
| llm | app/server/src/llm/logical-view.ts | `renderMessageContentWithPrefix()` | 修改 | 从「按 message.sender 取一个前缀注入首块」改为「遍历每个 block，按 block.sender 或回退到 message.sender 注入前缀」。每个 block 的前缀独立计算：(1) block 有 `sender` 字段 → 用 `renderSenderPrefix(block.sender)`；(2) block 无 `sender` 但 message 有 `sender` → 用 `renderSenderPrefix(message.sender)`；(3) 都没有 → 无前缀。前缀注入到每个有前缀的 block（text 拼前/非 text prepend） | MUST 处理「block 带 sender」+「block 不带 sender 但 message 带 sender」两种情况（后者覆盖未合并的 message）；MUST NOT mutate 原 block（每次注入返回新 block 对象）；MUST 无 sender 的 block 原样保留（不注入空前缀） | llm_logical_view §3.3（前缀表+注入策略） | +25/-12 |

## 影响面评估

### 跨模块
- **message（types）** → **context_engine（role_merge）** → **llm（logical-view）**：依赖方向自上而下，无循环
- types 先行（TextBlock.sender 字段），role_merge 消费它，logical-view 消费它——单 task 顺序实现即可

### 破坏性变更
- **无破坏性**：TextBlock.sender 是 optional 新字段，旧代码不读它不受影响
- role_merge 只在合并分支改逻辑，非合并路径不变
- logical-view 改为 per-block 渲染，但行为对外兼容（单 sender message 效果等价：所有 block 回退到 message.sender，首块注入前缀——与旧逻辑输出一致；多 sender message 输出更正确）

### 风险点
1. **role_merge block clone 成本**：合并时需要 clone 每个被合并 message 的 block。原代码 `last.content = [...last.content, ...m.content]` 是浅拷贝数组引用；新代码需要对 m.content 的每个 block 做浅 clone（`{...block, sender: m.sender}`）。性能影响可忽略（clean snapshot 在深克隆副本上跑，本来就不 mutate 原数据）
2. **logical-view per-block 前缀冗余**：同 sender 的连续 block 会重复注入相同前缀（如 `[User]: hello` + `[User]: world`）。这是**正确行为**——LLM 需要明确每块归属。旧逻辑只给首块加前缀，其他块「隐式继承」——在单 sender 场景够用，多 sender 场景就错了。如有去重优化需求后续版本处理，本版本先正确再优化
3. **protocol-encode 无影响**：encode 层只读 `role + content`，前缀注入由上游 logical-view 完成（已确认 protocol-encode.ts:8 注释）——sender 下沉不影响 encode

### UT 覆盖要求
1. **role_merge**：合并后每个 block 带 `sender = 被合并 message 的 sender`；合并后 message.sender 清空；未合并的 message 保持原样（block 无 sender 字段、message.sender 保留）
2. **logical-view**：block 带 sender → 按 block.sender 注入前缀；block 不带 sender 但 message 带 sender → 按 message.sender 注入（向后兼容未合并场景）；混合（部分 block 带 sender 部分不带）→ 各自正确

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
