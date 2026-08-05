# v0.0.104.cron_tool — cron agent 工具合并（6 → 1）

> 范围：把 cron 的 6 个 agent 工具（cron_create/list/update/disable/enable/delete）合并为**单工具 `cron` + action enum**（仿 browser 工具范式）。HTTP 6 端点 + scheduling 底层不动。

## 变更摘要

| 维度 | 变更 |
|---|---|
| agent 工具 | 6 个独立工具 → 1 个单工具 `cron`（`input.action` enum: create/list/update/disable/enable/delete） |
| inputSchema | `required: ['action']`；`cron`/`prompt`/`name`/`enabled`/`jobId` 平铺，description 注明适用哪个 action |
| run() 前置校验 | 新增：`action` 缺失/非法 → errorResult（不进 dispatch） |
| dispatch | 复用原 6 操作实现（cron-tool-shared.ts 未动），action 1:1 映射 op |
| 出参 | 不变（create→{jobId,cron,name,nextFireAt}；list→{jobs[]}；update→{jobId,cron,name,prompt}；disable/enable→{jobId,enabled}；delete→{jobId,deleted:true}） |
| 错误格式 | 统一 `[cron:<action>] <reason>`；action 缺失/非法用 `cron: action ...` 前缀 |
| tool-policy bound | playground/leader/mate 各绑 `'cron'`（原绑 6 个 `cron_*`，现缩为 1 个） |
| UI HTTP 6 端点 | **不动**（§2 不变） |
| scheduling 底层 | **不动**（CronStore + SchedulerEngine + CronHandler 不变） |

## spec 同步

- `specs/api/overall/16-cron.md` §3 整节重写（6 工具表 → 单工具 action 矩阵 + inputSchema + 共通契约加「action 前置校验」+ §3.3 关系表 agent 工具列改 `cron` action=X）；§2/§4/§6 不动；§7 文件级清单保留（v0.0.58 引入版历史记录）。

## 验证

UT（cron-tool 单测覆盖 6 action 变体 + action 缺失/非法前置校验 + isError 路径）+ AT（真 LLM cron AT 全绿，commit c3e18461）。
