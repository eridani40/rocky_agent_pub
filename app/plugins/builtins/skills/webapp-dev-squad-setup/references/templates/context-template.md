# v{N}.{M} context — {一句话版本主题}

<!--
版本共享上下文：导航地图 + 在途发现，全体 agent 共同维护（规范见 AGENTS.md「context.md 版本共享上下文」）。
- 启动先读：接到委派第一步读本文件，按 files 表直达相关文件，不重复探索
- 发现写回：新相关文件补进 files 表；坑/关键事实追加 findings（带 [角色 HH:MM] 署名）
- 写入规则：只 Edit 追加，禁止 Write 全量覆盖；只写结论不写过程；全文 ≤200 行
- 边界：不放状态/进度/Check（归 task-board.md + task.json），不放变更契约（归 change_plan.md）
-->

## {分主题 section，如 "chat 输入区重构"}

### intro
<!-- 两三句：这件事怎么回事、关键决策、注意点 -->

### files
<!-- 类型 = spec / code / test / design；designer 类 agent 只取 spec/test/design 行 -->
| 路径 | 类型 | 一句话介绍 |
|------|------|-----------|
| specs/{...}.md | spec | {契约要点、关键小节位置} |
| app/{...}.ts | code | {职责、体量/坑} |
| tests/{api,e2e}/{...}/ | test | {覆盖的用户路径} |

### findings
<!-- 追加式，每条一行：[角色 HH:MM] 发现的坑/关键事实 + 怎么应对 -->
