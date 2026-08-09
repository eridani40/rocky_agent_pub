# ⚠️ 本目录参考实现已废弃

`runner.py` / `check.sh` / `run_all.sh` / `env_*.sh` 是**已废弃的旧 AT 框架（checkpoint.json 驱动）**的参考实现，已停用。

**AT 唯一框架 = `tests/api/`**，其框架实现在 `tests/api/lib/`（`run_case.py` / `case_loader.py` / `step_exec.py` / `check_engine.py` / `sse_collector.py` / `run_all.sh` 等，声明式 `case.yaml` DSL）。权威文档 `tests/README.md`。

designer 不改框架脚本；只写 `tests/api/{module}/{case}/case.yaml`。
