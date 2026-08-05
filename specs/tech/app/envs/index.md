---
type: index
title: Envs 子系统总起（环境与脚本）
priority: P0
updated: 2026-06-30
---

# Envs 子系统总起（环境与脚本）

## ① 是什么

envs = 项目的**运行/构建环境契约 + 人工入口脚本契约**——回答「有几个环境、各自长什么样、`.env` 怎么填、人工跑哪个脚本」。它定义 test/dev/prod 三环境的语义、三份 `.env` 的 schema、`scripts/` 下三个人工脚本的契约。自动化测试启停（`tests/{api,e2e}/env_start.sh`、`run_all.sh`）**不在本 KB**——本 KB 只覆盖人工调试与发布入口。

| 核心概念 | 一句话 |
|---|---|
| **三环境** | 按「执行主体」划分：`test`（CI/自动化）/ `dev`（开发者）/ `prod`（发布者），非按机器分 |
| **`.env` schema** | 三份独立 `.env`（test/dev/prod），共通键 + 各自专有键；全 gitignore，提交 `.example` |
| **数据目录隔离** | `~/.{APP_NAME}_{env}`，三环境互不污染；自动化固定 test，禁碰 dev/prod |
| **端口分离** | `API_PORT`（后端 node:http）+ `WEB_PORT`（Vite dev）双键，三环境取值互不相同 |
| **scripts/** | 人工入口（unit-test/run-dev/build-dmg），各 source 固定一份 env，不交叉、不留默认值兜底 |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| 三环境语义、`.env` schema、归属与安全约定、`.example` 模板 | 运行/打包脚本内部实现（→ 调用方工具链） |
| 三脚本契约（source/前置/动作/产物/退出码） | dev/测试工具链选型（→ `../package/[P0]tool_chain.md`） |
| 自动化 run_all 协议的**文档化归属**（scripts.md §6a） | run_all/env_start 内部实现（→ api-testing / e2e-testing skill） |
| 各业务模块读哪些配置项 | 各业务模块自管 |

## ③ 与系统的关系

```
   scripts/unit-test.sh  ──source──→  test.env   ──→  bun run test（vitest 全量 UT）
   scripts/run-dev.sh    ──source──→  dev.env    ──→  vite dev + electron dev
   scripts/build-dmg.sh  ──source──→  prod.env   ──→  electron-builder → *.dmg / *.exe
                                                          │
   tests/{api,e2e}/env_start.sh ──source──→ test.env ──→ API_PORT + WEB_PORT 启停（自动化，非 scripts/）
```

**对外协作点**：三份 `.env` 落项目根目录（`test.env` / `dev.env` / `prod.env`）；三脚本落 `scripts/`；自动化启停模板落 `tests/{api,e2e}/env_start.sh`（非本 KB 文件）。

## ④ 核心设计原则（跨文件不变量）

1. **环境按执行主体划分，不按机器**——同一机器可既跑 test 又跑 dev；数据目录与配置自然按用途隔离。→ `environments.md §4.1`
2. **三份独立 `.env`，非单文件带前缀**——三环境键集差异大（test 有端口/健康端点、prod 有签名），独立文件各管各的；`.env` 全 gitignore、仓库提交 `.example`。→ `environments.md §4.2/§4.3`
3. **`API_PORT` 与 `WEB_PORT` 分离，按 env 区分**——AT curl `API_PORT`、ET Playwright 驱动 `WEB_PORT`，二者各自按 env 互不相同（API 3700/3710/3720；WEB 8787/8788/8789）。→ `environments.md §4.5`
4. **每脚本 source 固定一份 env，不交叉、不留默认值兜底**——脚本与环境的映射是固定语义；env 误缺即非 0 退出。→ `scripts.md §4.2/§4.4`
5. **`scripts/` 只做人工入口，自动化走 `tests/`**——人工要简单一键入口、自动化要 checkpoint 驱动可复现启停，分开放各自演化。→ `scripts.md §4.1`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| `[P0]environments.md` | 三环境语义（test/dev/prod）+ `.env` schema（共通键 + 各专有键）+ 设计决策（执行主体划分/独立 .env/数据隔离/端口分离/DATA_DIR 可覆盖） | P0 | [link]([P0]environments.md) |
| `[P0]scripts.md` | 三脚本契约（unit-test/run-dev/build-dmg 的 source/前置/动作/产物/退出码）+ 自动化 run_all 协议文档化归属 | P0 | [link]([P0]scripts.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
