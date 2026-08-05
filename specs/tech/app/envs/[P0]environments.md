---
type: spec
title: Environments & Env Config（环境与配置）
priority: P0
status: active
updated: 2026-07-10
since: v0.0.1
related: [[P0]scripts.md, ../package/[P0]package_structure.md]
---

# Environments & Env Config（环境与配置）

> 管什么：test / dev / prod 三环境的语义、项目根目录三份 `.env` 的 schema、归属与安全约定。
> 不管什么：运行/打包脚本本身的契约（→ `[P0]scripts.md`）、各业务模块读取哪些配置项（归各模块）。
> 边界归属规则见 [docs_guide.md](../../docs_guide.md) §4。

## 1. 概述

项目按「**谁在跑、干什么**」划分三个环境，每个环境对应项目根目录一份 `.env`：

| 环境 | 用途 | 触发主体 | 配置文件 |
|---|---|---|---|
| `test` | 全部自动化测试（UT / API / E2E） | CI、verifier agent、本地手跑 | `test.env` |
| `dev` | 人工开发验证 | 开发者本人 | `dev.env` |
| `prod` | 打包产物（exe / dmg） | 发布者 | `prod.env` |

**关键差异**：`test.env` 由项目维护、含自动化所需的 key/value（如大模型配置）；`dev.env` / `prod.env` 由**用户人工配置**（填自己的凭证与机器相关参数）。

## 2. 三环境语义

```
test   ── 自动化（UT + API + E2E）── API 3700 · WEB 8787 · DATA_DIR=~/.rocky_agent_test  （隔离，禁碰 dev/prod）
dev    ── 人工开发验证         ── API 3710 · WEB 8788 · DATA_DIR=~/.rocky_agent_dev   （用户自填 key）
prod   ── 打包 exe / dmg        ── 运行时 API 3720 · 签名凭证 + 进包白名单键   （用户自填；WEB 端口打包后不用）
```

- **数据目录按环境隔离**：`~/.{APP_NAME}_{env}`，三环境互不污染。`test` 固定，自动化绝不读写 dev/prod 目录（见 api-testing / e2e-testing skill）。
- **`prod` 主要参与构建，但白名单键会随包进运行时**：`prod.env` 大部分键是打包期参数（签名身份、`BUILD_OUT_DIR`）；其中【非密钥白名单键】（`API_PORT` / `DATA_DIR` / `APP_NAME` / `APP_ENV` / `LOG_LEVEL` / `HEALTH_ENDPOINT`）会被 `build-dmg.sh` 抽进 `runtime-config.json` 打进包，供 packaged 运行时回填 `process.env`（否则后端拿不到 `API_PORT` 起不来，见 `../package/[P0]packaging_toolchain.md` §3.6）。签名凭证仅 build 期用，**绝不进包**。版本号不在 prod.env（取自根 `package.json`，见 §3.4）。

## 3. `.env` 文件 schema

### 3.1 共通键（三份都有）

| 键 | 类型 | 含义 |
|---|---|---|
| `APP_NAME` | string | 应用标识 |
| `APP_ENV` | `"test"` \| `"dev"` \| `"prod"` | 当前环境标记，代码据此分支 |
| `API_PORT` | number | 后端 HTTP API（server `node:http`）监听端口，**三环境必须互不相同**（AT curl 此端口） |
| `WEB_PORT` | number | 渲染层 Vite dev server 端口（ET 驱动此端口）；prod 打包产物从文件加载、运行时不监听 |
| `DATA_DIR` | string | 本环境数据根目录，缺省 `~/.{APP_NAME}_{env}`，可显式覆盖 |
| `LOG_LEVEL` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | 日志级别 |
| `HEALTH_ENDPOINT` | string | 健康检查路径（server 读 `process.env.HEALTH_ENDPOINT`）。test 由 `env_start.sh` 轮询就绪、dev 由 `run-dev.sh` 轮询、prod 打进 `runtime-config.json` 供 packaged 运行时读 |

> **端口必须按 env 区分**：后端 API 与渲染层是两个独立服务，分别用 `API_PORT` / `WEB_PORT`，且三环境取值互不相同，以便同机并存。推荐分配：
>
> | env | `API_PORT`（后端，AT curl） | `WEB_PORT`（渲染，ET 驱动） |
> |---|---|---|
> | test | `3700` | `8787` |
> | dev | `3710` | `8788` |
> | prod | `3720` | `8789`（打包后不用，仅占位） |
>
> **`DATA_DIR` 可覆盖**：缺省按 env 隔离为 `~/.{APP_NAME}_{env}`；如需自定义（test 指向临时目录、CI 指向工作区、prod 指向安装目录），在对应 `.env` 显式设 `DATA_DIR` 覆盖缺省值。代码优先读 `DATA_DIR`，未设则回退 `~/.{APP_NAME}_{env}`。

### 3.2 `test.env` 专有（自动化）

| 键 | 含义 |
|---|---|
| `API_START_CMD` | 启动**后端 server**（监听 `API_PORT`）的命令；AT 用 |
| `WEB_START_CMD` | 启动**渲染层 web dev server**（监听 `WEB_PORT`）的命令；ET 用（e2e 同时起后端 + 渲染层） |
| `ANTHROPIC_API_KEY` / `MINIMAX_API_KEY` / `GLM_API_KEY` | 大模型 key（自动化用例需要） |
| `HEADLESS` | `"true"` \| `"false"`，E2E 是否无头 |

> `test.env` 是**唯一由项目维护、可含真实 key** 的 env（CI 通过 secrets 注入）。它驱动 `tests/api/env_start.sh`（AT）+ `tests/e2e/env.sh`（ET，v0.0.188 起单 case 环境启停）。AT 的 env_start.sh 同时起后端（轮询 `HEALTH_ENDPOINT`）与渲染层（轮询 `WEB_PORT` 根路径）至就绪。

### 3.3 `dev.env` 专有（人工开发）

| 键 | 含义 |
|---|---|
| `ANTHROPIC_API_KEY` 等 | 开发者**自己的**大模型 key，人工填写 |
| `DEBUG` | 调试开关 |

### 3.4 `prod.env` 专有（打包）

| 键 | 含义 |
|---|---|
| `APPLE_TEAM_ID` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` | macOS 公证（notarization）凭证；**密钥，绝不进包**，v0.0.1 可留空（未签名） |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Windows exe 代码签名；**密钥，绝不进包**，可留空 |
| `BUILD_OUT_DIR` | 产物输出目录（仅 build 期用，不进包） |

> **版本号不是 prod.env 键**（v0.0.108 起）：产物版本号取自根 `package.json` 的 `version`，`build-dmg.sh` 读它经 `--config.extraMetadata.version` 注入（见 `../package/[P0]packaging_toolchain.md` §3.5）。发布者无需在 prod.env 手填版本号。
>
> **prod.env 键三分类**：① **进包白名单**（共通键 `API_PORT`/`DATA_DIR`/`APP_NAME`/`APP_ENV`/`LOG_LEVEL`/`HEALTH_ENDPOINT`）→ 抽进 `runtime-config.json` 打进包；② **仅 build 期**（`WEB_PORT` 占位、`BUILD_OUT_DIR`）→ 不进包；③ **密钥留空占位**（`APPLE_*`/`CSC_*`）→ 绝不进包，缺失则跳过签名。

### 3.5 示例（精简，关键字段不省略）

```ini
# test.env（项目维护，CI 注入）
APP_NAME=rocky_agent
APP_ENV=test
LOG_LEVEL=info
API_PORT=3700
WEB_PORT=8787
DATA_DIR=~/.rocky_agent_test        # 缺省即此值；CI 可覆盖为工作区临时目录
HEALTH_ENDPOINT=/health
API_START_CMD=bun run app/server/src/index.ts
WEB_START_CMD=cd app/web && bun run dev -- --port $WEB_PORT --strictPort
ANTHROPIC_API_KEY=sk-ant-***
HEADLESS=true
```

> **启动命令形式**：bun 1.3.11 的 `--filter` 与 `--cwd ... run` 在本仓库 workspace 下均不解析（bun bug，已最小复现）。故示例用可执行形式：后端直接路径 `bun run app/server/src/index.ts`、web dev 用 `cd app/web && bun run dev`。bun 修复后可改回 `bun --filter @app/<pkg> run <script>` / `bun --cwd <pkg> run <script>`，仅需改对应 `.env` 一行。另：vite dev 默认监听 5173 不读 `WEB_PORT`，故 `WEB_START_CMD` 需显式 `-- --port $WEB_PORT --strictPort` 让 web dev 落在环境端口。

```ini
# dev.env（用户人工填写）
APP_NAME=rocky_agent
APP_ENV=dev
LOG_LEVEL=debug
API_PORT=3710
WEB_PORT=8788
DATA_DIR=~/.rocky_agent_dev
ANTHROPIC_API_KEY=sk-ant-***   # 填你自己的
DEBUG=true
```

```ini
# prod.env（用户人工填写）—— 三分类
# ① 进包·运行时白名单（会打进 runtime-config.json，供 packaged 运行时回填 process.env）
APP_NAME=rocky_agent
APP_ENV=prod
LOG_LEVEL=warn
API_PORT=3720                   # 打包产物运行时后端 API 端口（缺则后端起不来）
DATA_DIR=~/.rocky_agent_prod    # 存字面 ~/，运行时按运行用户 home 展开（可移植）
HEALTH_ENDPOINT=/health         # server 运行时读
# ② 仅 build 期，不进包
WEB_PORT=8789                   # 打包产物从文件加载渲染层，此端口运行时不用
BUILD_OUT_DIR=./release
# ③ 密钥·绝不进包·留空占位（v0.0.1 允许未签名，留空即跳过签名）
APPLE_TEAM_ID=
APPLE_ID=
APPLE_APP_SPECIFIC_PASSWORD=
CSC_LINK=
CSC_KEY_PASSWORD=
# 版本号不在此填 —— 取自根 package.json 的 version（见 §3.4）
```

## 4. 设计决策

### 4.1 三环境按「执行主体」划分，不按「机器」

**结论**：环境 = 谁在跑（CI 自动化 / 开发者 / 发布者），不是部署在哪台机器。
**理由**：同一台机器可能既跑 test 又跑 dev；按执行主体划分，数据目录与配置自然按用途隔离，语义清晰。
**反例**：若按机器分（"CI 机"/"本机"），则本机想跑一次自动化就要切机器或污染开发数据。

### 4.2 三份独立 `.env`，而非一份带前缀

**结论**：`test.env` / `dev.env` / `prod.env` 各一份独立文件，而非 `APP_ENV=xxx` 单文件 + 前缀键。
**理由**：三环境键集差异大（test 有端口/健康端点、prod 有签名），独立文件各管各的、互不覆盖、source 时一目了然；也契合现有 `test.env` 约定（skill/agent 已按此读取）。
**反例**：单文件 + 前缀（`TEST_PORT` / `DEV_PORT`）会让一份文件塞满三方凭证、切换靠改值，易错且无法按 env 做 git 忽略策略。

### 4.3 `test.env` 含 key，`dev`/`prod` 用户填——`.env` 全 gitignore，提交 `.example`

**结论**：三份 `.env` 都进 `.gitignore`（含凭证）；仓库提交 `test.env.example` / `dev.env.example` / `prod.env.example` 作为 schema 文档；CI 通过 secrets 注入真实 `test.env`。
**理由**：`test.env` 虽由项目维护但也含真实 key，不能入库；`.example` 既文档化 schema 又不泄密；CI 用 secrets 重建 `test.env` 保证可复现。
**反例**：若把 `test.env` 提交入库，key 泄露；若不提供 `.example`，新开发者不知道该填哪些键。

### 4.4 数据目录按 env 隔离，`test` 固定且禁碰 dev/prod

**结论**：`~/.{APP_NAME}_{env}` 三目录隔离；自动化固定 test 目录，绝不读写 dev/prod。
**理由**：自动化可能造脏数据/删数据，必须与人工数据物理隔离；与 api-testing / e2e-testing skill 的「固定 test env」一致。
**反例**：若共用目录，自动化跑完会污染开发者的真实会话/配置。

### 4.5 后端 API 与渲染层端口分离，且按 env 区分

**结论**：单 `APP_PORT` 拆为 `API_PORT`（后端 HTTP API，server `node:http`）+ `WEB_PORT`（渲染层 Vite dev server）；二者各自按 env 取值互不相同（API：test 3700 / dev 3710 / prod 3720；WEB：test 8787 / dev 8788 / prod 8789）。
**理由**：后端 API 与渲染层是两个独立服务——AT（api-testing）只 curl `API_PORT`，ET（e2e-testing-vision）只 Playwright 驱动 `WEB_PORT`。合一端口会让 verifier 自己推断该连哪个、还可能让后端与渲染抢同一端口。分键后职责清晰；三环境同机并存仍靠「按 env 分配固定端口」保证不冲突。
**反例**：若沿用单 `APP_PORT` 同时服务后端与渲染，则 ET 想驱动渲染、AT 想打后端却共用一端口，要么后端没起来渲染白屏、要么二者抢端口；也无法独立重启其中一方。

### 4.6 `DATA_DIR` 显式可覆盖，缺省按 env 派生

**结论**：`DATA_DIR` 是共通键；未设时代码回退到 `~/.{APP_NAME}_{env}`，设了则用显式值。
**理由**：缺省按 env 派生满足大多数隔离需求且零配置；但 CI/临时调试/自定义安装位置需要把数据指到别处（如 test 指向 `/tmp` 跑完即弃、CI 指向工作区便于 artifacts 收集），显式键让这层可覆盖而不必改代码。
**反例**：若数据目录完全硬编码 `~/.{APP_NAME}_{env}` 不可配，则 CI 要造隔离数据只能靠改 `APP_NAME`，污染应用标识；若只认 `DATA_DIR` 不给缺省，则每个 `.env` 都得手写路径，徒增样板。

### 4.7 `DATA_DIR` 字面 `~` 由运行时展开，单一权威 `config.resolveDataDir`

**结论**：`.env` / `runtime-config.json` 里的 `DATA_DIR` 存**字面 `~/`**（如 `~/.rocky_agent_prod`）；`~` 展开是**运行时职责**，唯一权威 = `app/server/src/config.ts` 的 `resolveDataDir(env)`（内部 `expandTilde` 按**运行用户** home 展开 `~` + 未设时回退派生 `~/.{APP_NAME}_{env}` 并展开）。所有取 `DATA_DIR` 的入口都必须经它，不得各自拼接字面 `~`。
**理由（BUG-004 真机实证）**：存字面 `~` 而非绝对路径才能跨用户/机器可移植——packaged dmg 分发到别人机器，`~` 按运行者 home 展开、不是打包者的 `/Users/<builder>`（故 `build-dmg.sh` 生成 `runtime-config.json` 时特意把 build 机 `$HOME` 前缀还原成字面 `~`，见 `../package/[P0]packaging_toolchain.md §3.6`）。既然存字面 `~`，就必须有**唯一**展开点：dev/CLI 入口走 `index.ts getConfig().dataDir`（= `resolveDataDir`）；**packaged 启动桥** `backend-bootstrap.resolveServerOpts` 也必须复用 `resolveDataDir`，**禁止重复拼接字面 `~`**——否则字面 `~` 漏到下游 `mkdirSync`，packaged cwd=`/` 下 `mkdirSync('/~/...')` EACCES → 全部 HTTP 500。
**反例**：若某入口自行 `env.DATA_DIR ?? '~/.x'` 不展开，`StartServerOptions.dataDir`「绝对路径」契约被破，下游建目录用字面 `~` → dev cwd 可写侥幸不崩、packaged cwd=`/` 直接 EACCES —— 只在打包产物暴露，最难查（启动桥展开责任见 `../package/[P0]package_structure.md §4.3`）。

## 5. 边界

| 零件 | 归属 |
|------|------|
| 三环境语义、`.env` schema、归属与安全约定 | 本文件 ✅ |
| 脚本如何 source `.env`、各自产物与退出语义 | `[P0]scripts.md` |
| `env_start.sh` / `env_shutdown.sh`（自动化启停模板） | api-testing / e2e-testing skill |
| 各业务模块读哪些配置项 | 各业务模块 |
