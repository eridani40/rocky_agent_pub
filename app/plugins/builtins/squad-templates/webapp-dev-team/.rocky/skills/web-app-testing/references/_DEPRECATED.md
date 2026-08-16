# ⚠️ 已废弃框架存档（勿用）

本目录只保留 `env_start.sh` / `env_shutdown.sh` 两个**通用 env 启停模板**（env 变量驱动，跨项目可复用；真实版本在 `${TESTS_DIR}/api/`）。其余为历史存档说明：

## 废弃历史

1. **checkpoint.json 驱动旧 AT 框架**（runner.py / check.sh / run_all.sh，2026-08-14 废弃）——参考实现已删。
2. **case.yaml 声明式 DSL 框架**（`${TESTS_DIR}/api/lib/` 的 run_case.py/case_loader.py/step_exec.py/check_engine.py 等，2026-08-15 老板拍板废弃）——自研 DSL 解释器维护成本 > 收益，LLM 写声明式 DSL 出错率高（插值规则/原子性拒载/无 headers 等边界）。

## 现行 AT 框架（2026-08-15 起）

**正常写 mjs case**：node 内置 `node:test` + 原生 `fetch` + `node:assert/strict`，零自研解释器。手册见本 skill SKILL.md「AT 框架」节。
