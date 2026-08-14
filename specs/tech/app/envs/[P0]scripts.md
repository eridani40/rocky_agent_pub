---
type: spec
title: Scripts（运行与打包脚本）
priority: P0
status: active
updated: 2026-08-13
since: v0.0.1
related: [[P0]environments.md, ../package/[P0]package_structure.md]
---

# Scripts（运行与打包脚本）

> 管什么：项目根 `scripts/` 下三个脚本的契约——用途、入参、source 哪份 env、产物、退出语义。
> 不管什么：环境语义与 `.env` schema（→ `[P0]environments.md`）、各 engine/应用内部实现。
> 边界归属规则见 [docs_guide.md](../../docs_guide.md) §4。

## 1. 概述

`scripts/` 是**人工调试与发布**的入口（见项目 CLAUDE.md：`scripts/` 仅用于人工调试，自动化测试走 `tests/` 下的 `env_start.sh`）。各脚本各自 source 对应环境配置：

```
scripts/unit-test.sh            ──source──→ test.env  ──→ 跑全量 UT（bun run test）
scripts/run-dev.sh              ──source──→ dev.env   ──→ 起开发态应用
scripts/build-dmg.sh            ──source──→ prod.env  ──→ 打包 dmg / exe 产物
scripts/update-app.sh           ──（无 env）──→ 自助更新已安装 app（杀 → 替换 → 重启）
scripts/cleanup-chrome-debug.sh ──（无 env）──→ Chrome 调试态残留检测（只读检测 + 清理指引）
```

脚本只做「source env + 调用对应工具链」，不重复实现业务逻辑。

## 2. 脚本契约总表

| 脚本 | source | 作用 | 主要产物 | 典型调用 |
|---|---|---|---|---|
| `unit-test.sh` | `test.env` | 跑全量单元测试 | 终端报告 + 退出码 | `./scripts/unit-test.sh` |
| `run-dev.sh` | `dev.env` | 启动开发态应用（热重载） | 运行中的 dev 进程 | `./scripts/run-dev.sh` |
| `build-dmg.sh` | `prod.env` | 打包发布产物 | `*.dmg`（mac）/ `*.exe`（win） | `./scripts/build-dmg.sh` |
| `update-app.sh` | 无 | 自助更新已安装 app（杀 → 替换 → 重启） | 更新的 `/Applications/<APP_NAME>.app` | `nohup bash scripts/update-app.sh [version] > /tmp/rocky-update.log 2>&1 &` |
| `cleanup-chrome-debug.sh` | 无 | Chrome 调试态残留检测（只读检测 + 清理指引） | 终端检测报告（无文件产物） | `bash scripts/cleanup-chrome-debug.sh` |

**退出语义统一**：成功退出码 `0`；失败（测试失败、启动失败、打包失败）非 `0`，便于 CI 与脚本串联判断。

## 3. 各脚本契约

### 3.1 `unit-test.sh`

- **source**：`test.env`（提供 `APP_NAME`/`APP_ENV=test` 及 UT 可能需要的大模型 key）。
- **前置**：若 `test.env` 不存在，报错退出并提示从 `test.env.example` 拷贝。
- **动作**：`source ./test.env && bun run test`（即 `npx vitest run`，见 CLAUDE.md 测试规范；**禁止 `bun test`**）。
- **退出码**：vitest 退出码透传。
- **边界**：只跑 UT。API/E2E 自动化各自走 `tests/api`、`tests/e2e` 的 `env_start.sh`，不在本脚本。

### 3.2 `run-dev.sh`

- **source**：`dev.env`（开发者自己的端口与 key）。
- **前置**：若 `dev.env` 不存在，报错退出并提示从 `dev.env.example` 拷贝。
- **动作**：以 dev 模式启动应用（electron dev / `bun run dev`，具体由 `app/package/[P0]packaging_toolchain.md` 与 `app/package/[P0]package_structure.md` 决定），数据落 `~/.{APP_NAME}_dev`。
- **退出码**：进程退出码。
- **边界**：人工开发验证用，不产出打包产物；绝不读 `prod.env` 的签名凭证。

### 3.3 `build-dmg.sh`

- **source**：`prod.env`（进包白名单键 + 签名凭证 + `BUILD_OUT_DIR`）。**版本号不取自 prod.env**——取自根 `package.json` 的 `version`（`node -p` 读，见 `../package/[P0]packaging_toolchain.md` §3.5）。
- **前置**（缺一即非 0 退出）：
  1. `prod.env` 缺失 → exit 1（提示从 `prod.env.example` 拷贝）。
  2. 根 `package.json` 的 `version` 无效（空 / `0.0.0` 占位）→ exit 2（提示先在 `package.json` 设版本号）。
  3. `prod.env` 缺关键字段（`APP_NAME` / `APP_ENV` / `API_PORT` / `WEB_PORT` / `DATA_DIR`）→ exit 2。**签名凭证可留空**（v0.0.1 允许未签名，空则脚本 unset 空签名键让 builder 跳过，不致命）。
- **动作**：source prod.env → 读根 `package.json` version → 生成 `runtime-config.json`（白名单非密钥键，打进 asar，见 packaging_toolchain §3.6）→ 两段式 build（`vite build` → `web-dist`；`tsc -b` → `dist`）→ **离线准备（`[v0.0.342]` `export NO_UPDATE_NOTIFIER=1` 禁 update-notifier 联网检查；检查 `app/electron/node_modules/electron/dist/version`，缺失则 electron `install.js` 本地解压命中 `~/Library/Caches/electron` 缓存 zip 零联网，仍失败 exit 3；详见 packaging_toolchain §3.10）** → `electron-builder`（`--config.extraMetadata.version=<根版本>` 注入版本 + `--config.electronDist=<本地 dist>` 走 custom unpacked copyDir 分支跳过下载/SHASUMS 校验）产出安装包。
- **产物**：macOS → `rocky_agent-<version>-arm64.dmg`；Windows → `*.exe` 为同流程的平台变体；落 `${BUILD_OUT_DIR}`（缺省 `release/`）。
- **退出码**：前置校验失败 1/2；产物缺失 3/4；否则打包工具退出码透传。

### 3.4 `update-app.sh`

- **source**：无（不读任何 `.env`——脚本只做「杀 app → 替换 .app → 重启」，不涉环境配置）。
- **前置**：`release/` 下有 dmg（`rocky_agent-<version>-arm64.dmg`；不传 version 取最新）。
- **动作**：① 缓冲 2s（让调用方 bash 返回）→ ② 杀 `/Applications/rocky_agent.app`（pkill + 等待退出最多 5s + `pkill -9` 兜底含 Helper）→ ③ `hdiutil attach` 挂载 dmg → ④ `rm -rf` + `cp -R` 替换 .app → ⑤ `hdiutil detach` → ⑥ **`sync` + `sleep 3` 等文件落盘**（`[v0.0.337]` 修复重启白屏：cp ~290MB 后立即 `open` 会读到未写完的文件）→ ⑦ `open` 重启 app。
- **产物**：更新的 `/Applications/rocky_agent.app` + 日志 `/tmp/rocky-update.log`。
- **退出码**：dmg 缺失 / .app 不在 dmg 中 → 非 0。
- **边界**：**必须 `nohup bash scripts/update-app.sh [version] > /tmp/rocky-update.log 2>&1 &` 脱离 app 进程运行**（否则 app 被 kill 时脚本一起死）；不读 prod.env、不改 app 自身启动逻辑；`[v0.0.337]` 起安装后强制 `sync` + 3s 才 `open`。

### 3.5 `cleanup-chrome-debug.sh`（[v0.0.330]）

- **source**：无（不读任何 `.env`——只读检测，不写文件不改环境）。
- **用途**：browser attach（chrome://inspect 远调模式）close 后，用户 Chrome 可能残留调试态（9222 端口监听 / 「Chrome 正受到自动测试软件的控制」提示条 / Allow remote debugging 仍勾选）——本脚本检测残留并输出可照做的清理指引。
- **动作**（三段只读检测 + 指引）：① `lsof -iTCP:9222 -sTCP:LISTEN` 检测 9222 监听（仅报告进程，**不 kill**）；② 检测 `DevToolsActivePort` 文件（mac `~/Library/Application Support/Google/Chrome/` + linux `~/.config/google-chrome|chromium/`，读首行端口）；③ 输出清理指引（chrome://inspect 取消勾选 Allow remote debugging → Chrome 自动重启回非调试；或完全退出 Chrome 重启）。
- **产物**：终端检测报告（无文件产物）。
- **退出码**：0（纯检测无失败分支）。
- **边界**：**不 kill 用户 Chrome**（丢标签页/会话不可接受）——能力边界实证：对用户已开 Chrome 的调试态无编程关闭 API（change_plan §12），脚本只给指引；一次性人工清理工具，不进自动化流程。

## 4. 设计决策

### 4.1 `scripts/` 只做人工入口，自动化走 `tests/`

**结论**：`scripts/` 服务人工调试与发布；自动化测试（API/E2E）的启停归 `tests/api/env_start.sh`（AT）+ `tests/e2e/env.sh`（ET，v0.0.188 起单 case 环境启停），不进 `scripts/`。
**理由**：两类调用方诉求不同——人工要简单一键入口、自动化要 checkpoint 驱动的可复现启停；分开放各自演化，避免一个脚本兼顾两种调用形态。与项目 CLAUDE.md 既定约定一致。
**反例**：若自动化也调 `scripts/run-dev.sh`，则脚本要同时满足「人工可读输出」和「机器可探测就绪」，耦合两种关注。

### 4.2 每脚本 source 固定一份 env，不交叉

**结论**：`unit-test.sh`→`test.env`、`run-dev.sh`→`dev.env`、`build-dmg.sh`→`prod.env`，一一对应，脚本内不提供「选 env」参数。
**理由**：脚本与环境的映射是固定语义（测试/开发/打包），提供参数只会制造「用 build-dmg.sh source test.env」这类无意义组合；固定映射让人和 CI 一眼看清跑了哪个环境。
**反例**：若脚本接受 `--env` 参数，则调用方可能误把打包脚本指向 test env，产出错误产物且难排查。

### 4.3 `build-dmg.sh` 命名以 dmg 为主，exe 为平台变体

**结论**：脚本名 `build-dmg.sh`（mac 产物为主）；Windows 的 `*.exe` 由同一脚本在 win 平台产出，作为平台变体，不单列 `build-exe.sh`。
**理由**：本仓库主开发环境为 macOS（见环境信息），dmg 是主发布形态；exe 与 dmg 共用同一打包工具链与 `prod.env`，仅平台不同，拆两个脚本会重复 source 与校验逻辑。
**反例**：若严格按产物各起一脚本，则 `prod.env` 的加载、版本校验、产物目录逻辑要抄两份，维护双倍。

### 4.4 缺 env 即报错退出，不留默认值兜底

**结论**：任一脚本发现所需 `.env` 缺失或**必需**关键字段空，立即非 `0` 退出并提示从 `.example` 拷贝，不用默认值兜底。
**理由**：env 误缺是配置错误，静默兜底会让人误以为「跑通了」而实际用了错误参数（如后端端口、测试 key）。**区分必需键与可选键**：`API_PORT`/`APP_NAME`/`DATA_DIR` 等运行/构建必需键缺失即报错退出；签名凭证（`APPLE_*`/`CSC_*`）是**有意可选**（v0.0.1 未签名），空则脚本 unset 后跳过签名、不报错。
**反例**：若 `build-dmg.sh` 在缺 `API_PORT` 时用默认端口兜底继续打，则产物内 `runtime-config.json` 缺 `API_PORT`、packaged 后端起不来却无人察觉（v0.0.108 修的正是这类"缺 API_PORT 后端起不来"，靠前置校验 + runtime-config 注入双保险）。

## 5. 示例

```bash
# 跑全量单元测试
./scripts/unit-test.sh

# 启动开发态
./scripts/run-dev.sh

# 打包发布（mac 出 dmg）
./scripts/build-dmg.sh

# 自助更新已安装 app（脱离 app 进程运行）
nohup bash scripts/update-app.sh > /tmp/rocky-update.log 2>&1 &
```

`unit-test.sh` 骨架（仅示意契约，非实现）：

```bash
#!/usr/bin/env bash
set -euo pipefail
[ -f ./test.env ] || { echo "缺失 test.env，请从 test.env.example 拷贝"; exit 1; }
set -a; . ./test.env; set +a
bun run test
```

## 6a. 自动化 API/E2E run_all 协议

自动化测试由 `tests/{api,e2e}/lib/run_all.sh` 负责真实执行，`collect.sh` 负责幂等聚合结果；二者不属于人工 `scripts/`（`scripts/` 只做人工调试与发布，见 §1）。

**设计思路**：真 LLM case 可能超过单次前台超时，把执行与聚合拆开可避免半途中断导致无结果；executor 前台分波跑，超时后用 `RESUME=1` 续跑，避免后台任务在 agent turn 结束时被杀。

**代码路径**（v0.0.188 ET 重构后）：AT 侧 `tests/api/lib/run_all.sh → tests/api/lib/collect.sh`；ET 侧 `tests/e2e/env.sh start <cid>` + `tests/e2e/run.sh` 编排 + executor agent 玩 app（详见 `specs/tech/testing/et-framework.md`）。

**接口签名**：`VERSION=v0.0.33.2 MODULE=squad RESUME=1 bash tests/api/lib/run_all.sh` —— `VERSION/MODULE` 限定版本与模块，`RESUME=1` 跳过已 pass case；`collect.sh` 扫 last_run/timing 写 `run_all_result.json`。run_all 写 `_DONE`、`_flow_meta.json`、per-lane timing；`test.env` 必须含 `ROCKY_TEST_MOCK_LLM=0`，否则 env_start 会以 mock LLM 启服务造成假绿。

## 6. 边界

| 零件 | 归属 |
|------|------|
| 五脚本的用途/source/产物/退出语义、命名与存在性约定 | 本文件 ✅ |
| 三环境语义与 `.env` schema、`.example` 模板 | `[P0]environments.md` |
| `env_start.sh` / `env_shutdown.sh`（自动化启停） | api-testing / e2e-testing skill |
| `run_all.sh` / `collect.sh` / `RESUME` / `_DONE` / timing | tests/api 与 tests/e2e 自动化执行协议（本文件 §6a 文档化归属） |
| 应用 dev 启动装配（main/preload/IPC 如何拉起 vite dev） | `app/package/[P0]package_structure.md` |
| 打包工具链内部（electron-builder 选型/asar/产物） | `app/package/[P0]packaging_toolchain.md` |
