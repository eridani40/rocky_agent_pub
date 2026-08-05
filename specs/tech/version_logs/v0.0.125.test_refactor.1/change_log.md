# v0.0.125.test_refactor.1 跨版本变更说明 — AT 全面重构 + doc-sync 收尾

> 范围：`tests/api` 全新 DSL 框架（声明式 case.yaml + record/replay 双关 + five-class 聚合）+ server 侧 testing 基建扩 `request_meta` 派生指纹 + 命名收敛（tests_v2 → tests/api 正位、at-executor-v2 → api-test-executor）+ doc-sync 多处 spec 对齐代码实际。

## testing KB 变更（位置轴详 `specs/tech/testing/log.md`）

- **index.md ④不变量 6**：脱敏硬约束补 `roles[]`+`tool_names[]`（v0.0.125 起新增，只派生元信息不落 messages 正文/tool schema）。
- **record-replay.md**：
  - §4 数据格式示例 JSON 含 `roles`/`tool_names`
  - §4.1 新增 `request_meta` 派生指纹段（5 字段表 + 安全约束三条款）
  - §6 已知债新增两条（POST /run wrapper 缺 naming hook / budget gate 受 boot.ts 30s cache 制约）
- **frontmatter**：updated 推到 2026-07-13。

## 已知限制（backlog，v0.0.125 识别不修代码）

| # | 限制 | 影响 | 处置 |
|---|------|------|------|
| BL-1 | `POST /session/:id/run` test wrapper 缺 auto-naming hook（naming 只挂 `/messages` 生产路径 `session-messages.ts:250`） | AT 走 `/run` 验 naming 类功能永不触发 → 必须走 `/messages` 生产路径 | case 设计绕开（走生产路径）；产品 backlog：考虑给 wrapper 挂 hook 但有保真权衡 |
| BL-2 | budget gate 受 `boot.ts` budget cache 30s 异步刷新制约（PATCH budget 后首 tick 走旧 cache） | AT 黑盒无法稳定测 budget gate（cache 异步 vs 黑盒即时性张力） | budget gate 契约转 UT（直接测 gate 函数绕 cache）；产品 backlog：PATCH budget 应 invalidate cache |

> 非产品 bug 非 case 错误——机制本身正常工作，是测试基础设施与黑盒测试范式的结构性张力。UT 路径已覆盖（直接测 gate 函数 + cache 行为）。

## 命名收敛（用户裁决，commit 3981b817+f9862399）

- **目录正位**：`tests_v2/api` → `tests/api`（旧 tests/api 移除；recordings/case 历史保留）
- **executor 名**：`at-executor-v2` → `api-test-executor`（与 api-test-designer 配对；用户澄清）
- **v2 措辞清除**：所有文档 v2 字眼清除，AT 即 tests/api（无 v2 概念）
- **遗留合并待办**：dev1 上 `at-executor-v2.md`（agent 定义文件，fa4a840a 建的，worktree 基线早于它）→ 合并 dev1 带进来后 `git mv at-executor-v2.md api-test-executor.md`

## 设计冻结 / method 级契约

- `specs/tech/version_logs/v0.0.125.test_refactor.1/design.md`（设计总纲）
- `specs/tech/version_logs/v0.0.125.test_refactor.1/change_plan.md`（method 级变更契约）
- `specs/tech/version_logs/v0.0.125.test_refactor.1/design_storage_runall.md`（存储 + run_all）
- `specs/tech/version_logs/v0.0.125.test_refactor.1/design_case_schema.md`（case.yaml schema）
- `specs/tech/version_logs/v0.0.125.test_refactor.1/design_check_lang.md`（断言表达式语言）
- `specs/tech/version_logs/v0.0.125.test_refactor.1/migration-plan.md`（旧 case 迁移）

> 注：以上设计文档用旧命名 `tests_v2`（设计期 决策命名，与代码实现无关），实际代码 + 文档主体已统一为 `tests/api`。
