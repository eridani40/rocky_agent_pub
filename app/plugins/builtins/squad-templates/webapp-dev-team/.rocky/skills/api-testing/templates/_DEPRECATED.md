# ⚠️ 本目录模板已废弃

`checkpoint.json` / `run.sh` / `test_case.md` 是**已废弃的旧 AT 框架**样板，已停用。

**AT 唯一框架 = `tests/api/`（声明式 `case.yaml` DSL）**：
- DSL schema / 配方 / 陷阱：`.rocky/skills/api-testing/SKILL.md` + `tests/README.md`
- case.yaml 实例：`tests/api/compact/compact_manual_sse/case.yaml`、`tests/api/squad/*`

设计新 case 一律照 AT 框架写 `case.yaml`，**不要复制本目录的 checkpoint.json / run.sh**。
