# v0.0.104 — cron agent 工具合并（6 → 1 单工具 + action enum）

> 范围：cron 的 6 个 agent 工具（cron_create/list/update/disable/enable/delete）合并为**单工具 `cron` + action enum**（仿 browser 工具范式）。HTTP 6 端点 + scheduling 底层不动。

## 变更

| 模块 | 文件 | 变更 |
|---|---|---|
| agent 工具 | `app/server/src/tools/cron/cron-tool.ts` | 6 个 Tool 定义 → 1 个单工具 `cron`：`definition.name='cron'` + `inputSchema.required=['action']` + `action` enum 6 值 + 平铺参数；`run()` 加 action 前置校验（缺失/非法 → errorResult）→ dispatch(input, ctx, action) |
| dispatch | `app/server/src/tools/cron/cron-tool-shared.ts` | 不动（runCreate/runList/runUpdate/runToggle/runDelete 实现复用，dispatch 集中 resolveDeps/resolveSessionId 错误处理） |
| registry | `app/server/src/tools/registry.ts` | defaultTools 注册从 6 个 `cron_*` 缩为 1 个 `cron` |
| tool-policy | `app/server/src/agent/tool-policy.ts` | playground/leader/mate bound 从 6 个 `cron_*` 缩为 1 个 `'cron'`；squad/subagent 不绑 |
| UI HTTP | `app/server/src/handlers/cron-handler.ts` | **不动**（6 端点不变） |
| scheduling 底层 | engine / CronStore / CronHandler / cron.json | **不动** |

## 设计决策

- **仿 browser 范式**：单工具 + action enum + 平铺参数，而非 6 个独立工具。减少工具表膨胀（6 个 cron_* 占工具列表噪声），LLM 一次认知「cron 工具管定时任务」。
- **action 前置校验在 run()**：缺失/非法直接 errorResult，不进 dispatch（dispatch 只处理合法 action）。
- **6 操作实现未动**：复用 cron-tool-shared.ts 的 runCreate/runList/runUpdate/runToggle/runDelete，dispatch 用 switch(action) 分流，行为与原 6 工具 1:1 等价。
- **HTTP/scheduling 零改动**：agent 工具与 UI HTTP 正交（§3.3），共享底层 CronStore + SchedulerEngine 不变。

## spec 同步

- `specs/tech/scheduling/[P1]cron_subsystem.md` §6（6 工具表 → 单工具 action 矩阵）+ §11（tool-policy bound 从 6 个 `cron_*` → 单 `cron`）。
- `specs/api/overall/16-cron.md` §3 重写（详 `specs/api/version_logs/v0.0.104.cron_tool/change_log.md`）。

## 验证

UT（cron-tool 单测 6 action + 前置校验）+ AT（真 LLM cron AT 全绿，commit c3e18461）。
