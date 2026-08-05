# v0.0.197 change_plan — UI spec 瘦身 + testid 全链路删除

> 纯技术版本（无用户可感知变化）：spec 冗余清理 + 前端死代码删除 + E2E 定位策略切换。
> 目标：specs/ui/ 体量降 70-80%（24,374 行 → ~5,000-7,000 行）。

## 变更契约

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| web/components | app/web/src/**/*.tsx (250 files) | `data-testid` attrs, testid props/helpers | 删除 | 删全部 data-testid 属性 + 因此废弃的 props/params/helpers（testIdPrefix, containerTestid, rowTestidOf, tid() 等）+ 无用注释 | typecheck + UT 必须绿 | req.md §test-id | ~1132 处 |
| ui-spec/chat | specs/ui/components/chat-page/ (30 files) | `## testid` / `## 版本` sections | 删除+重写 | 删 testid section、版本历史、[vX] 标注；引用组件只留引用+位置；删独立 tsx | 只保留当前态描述 | req.md §存量/tsx/引用 | ~3200 行 |
| ui-spec/studio | specs/ui/components/studio-page/ (45 files) | 同上 | 删除+重写 | 同上 | 同上 | 同上 | ~3500 行 |
| ui-spec/rest | specs/ui/components/{framework,common,providers,academy,channel,connector,skill,plugin-config,app-dev-config}/ + overall/ + regulation/ | 同上 + _conventions.md testid 规范 | 删除+重写 | 同上 + _conventions 删 testid 命名规范 §6 + app-guide 删 testid 列 | 同上 | 同上 | ~8000 行 |
| ui-spec/history | specs/ui/version_logs/ (35 files) | 整目录 | 删除 | 版本变化历史一点不保留 | 无 | req.md §存量 | ~2100 行 |
| et-framework | specs/tech/testing/et-framework.md | testid 契约段落 | 重写 | 定位策略改为 snapshot ref + 文案/位置；删「testid 从 spec 读」契约 | executor 不再依赖 testid | 用户裁决 2026-07-23 | 全文 |
| et-cases | tests/e2e/*/case.md (6 files) | testid 提示 | 重写 | 删 testid 软提示，改用文案/位置描述 | case 语义不变 | 同上 | 散见 |
| executor-docs | .claude/skills/playwright-cli/references/executor-workflow.md + agents 定义 | getByTestId 优先策略 | 重写 | 定位改为 snapshot/text/role 优先 | 无 | 同上 | 散见 |

## 验证策略

1. Task 1 门禁：`bun run typecheck` + `bun run test` 全绿
2. AT replay 回归（后端零改动，sanity check）
3. E2E 冒烟一条（playground-send-message）证明无 testid 时 executor 用文案定位仍可工作
