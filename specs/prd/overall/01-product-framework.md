# Rocky Agent - 产品需求文档

> version: 1.2 · 最后更新：2026-07-01（v0.0.47 修订：playground 三件 UI 优化）· [v0.0.56 modified] SessionKind 统一 session 身份维度——session 类型判别从散落字段（bizType/type/scope/parentRole）迁移到单一 SessionKind 对象（biz/role/derivation），用户行为不变（重构）。详见 `specs/prd/version_logs/v0.0.56-session_type/change_log.md`
> 当前版本：v0.0.1（首版本）
> 本文是 v0.0.1 的全量产品定义。随版本迭代就地更新并追加 `[vX.Y modified]` 标注。

## 目录

| 章节 | 说明 |
|------|------|
| §1 产品概述 | 定位、目标用户、核心价值（v0.0.1 阶段） |
| §2 UI 风格与交互规范 | 视觉风格、布局稳定性约定 |
| §3 功能需求 | 脚手架 / 三环境 / 打包 / mock 计数 |
| §4 关键用户路径 | 测试最低覆盖要求（MANDATORY） |
| §5 设计决策 | 2 个已确认的关键决策 |
| §6 非功能需求 | 环境隔离、可测试性、风格一致性 |
| §7 范围边界（IN / OUT） | 含排除项与理由 |
| §8 里程碑 | v0.0.1 验收口径 |

---

## 1. 产品概述

### 1.1 产品定位 [v0.0.1]

Rocky Agent 是一款基于 **Bun + Electron** 的桌面 AI agent 应用。v0.0.1 是项目的**最小垂直切片（MVS）**：不实现任何 agent 智能，只把「应用脚手架 + 三环境 + 打包 + 自动化开发/测试流程」跑通，并挂一个 **mock 计数功能**作为端到端验证载体。

一句话：**v0.0.1 的产出不是「能聊天的 AI」，而是「能开发、能测试、能打包、能验证」的工程基座**。

### 1.2 目标用户 [v0.0.1]

v0.0.1 的「用户」是**项目自身的开发流程**：

- 开发者：能用 `scripts/run-dev.sh` 一键起开发态、看到暖色风格的前端。
- 自动化（CI / verifier agent）：能跑通 UT + AT + ET 三层测试并产出报告。
- 发布者：能用 `scripts/build-dmg.sh` 在本机产出可启动的 dmg（未签名即可）。

终端 AI 用户的产品体验推迟到后续版本（agent loop / session / provider 上线后）。

### 1.3 核心价值 [v0.0.1]

1. **可运行**：dev 能起、prod 能打包，产物可启动。
2. **可隔离**：test / dev / prod 三环境端口与数据目录互不污染。
3. **可验证**：三层自动化测试（UT / AT / ET）一条流程走通全绿。
4. **风格一致**：前端遵循线框暖色设计系统，为后续 UI 迭代奠定视觉基线。

---

## 2. UI 风格与交互规范 [v0.0.1]

### 2.1 整体风格

v0.0.1 前端**只参考线框的视觉风格，不照抄聊天界面内容**。视觉契约（色彩 / 字体 / 圆角 / 组件词表）以 `specs/tech/app/frontend/[P0]design_system.md` 为唯一权威来源：

- 暖色系：米色背景（`#F5F4F0`）+ terracotta 主色（`#D97757`）+ sage / gold 辅助。
- 三字体：Inter（正文）/ JetBrains Mono（计数、metadata）/ Playfair Display（brand）。
- 圆角档位：4 / 6 / 8 / 10 / 12px。
- token 经 CSS 变量定义，Tailwind theme 引用变量。

v0.0.1 仅需落地其中**最小子集**：app-shell 容器、button-primary、button-secondary、单一卡片（计数器），足以验证设计系统接入正确。

### 2.2 布局稳定性（MANDATORY）

按钮只有两种状态：**始终可见**或 **hover 时出现**。无论哪种，按钮的出现 / 消失**绝不能导致其他元素位移**。实现方式：预留固定空间（`visibility: hidden` / `opacity: 0`）或绝对定位。禁止用 `display: none` + 常规流布局导致相邻元素跳动。

### 2.3 Rocky 品牌（app 图标 + 对话机器人头像 + 名标） [v0.0.11]

机器人形象来源 `reqs/v0.0.11/icon.png`（Rocky from hail mary project），是所有 Rocky 品牌资产的**权威源**（所有尺寸由工具派生，不手画）。范围（user 头像/名标不动）：

- **app 图标**：electron 多尺寸（mac `.icns` 16/32/64/128/256/512/1024 + win `.ico`，源 1024×1024 `icon.png` 经 `png2icons`/`iconutil` 派生）。资产处理归 tech `specs/tech/app/package/[P0]packaging_toolchain.md` + `specs/tech/version_logs/v0.0.11/change_log.md §4`。
- **对话机器人头像**：chat agent message 头像列 = Rocky icon 图（28×28 rounded-lg，非渐变白字首字母）。组件 spec `specs/ui/components/chat-page/brand-rocky.md`。
- **机器人名标**：agent displayName = `Rocky`（对话头像下 10px/600 uppercase muted）。productName 归 env（`APP_NAME`，本 PRD 不动 env）。

> 概念边界：app 图标资产处理 + manager 接入归 tech；UI 展示（avatar/name 落点）归 ui。

---

## 3. 功能需求

### 3.1 应用脚手架（App Scaffold） [v0.0.1]

**描述**：搭建 `app/` 下 Bun workspaces 多包结构，确立进程边界。
**优先级**：P0
**用户故事**：作为开发者，我希望有一个边界清晰的工程骨架，以便后续模块按职责填入而不互相污染。

**期望行为**：
- `app/` 下存在 5 个 workspace 包：`electron` / `web` / `server` / `protocols` / `shared`（`shared` 可空目录占位）。
- 包间依赖单向：`web → protocols`、`electron → server → protocols`；`protocols` 不依赖任何 app 包。
- `server` 零 electron 依赖（`package.json` 不声明 `electron`）。
- 根 `package.json` 用 `workspaces` 字段统一管理。
- 物理布局严格遵循 `specs/tech/app/package/[P0]package_structure.md`。

**验收**：`bun install` 成功；`bun run typecheck` 通过；`server/package.json` 中无 `electron` 依赖条目。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.1.1 | `bun install` → `bun run typecheck` | 依赖装好、类型检查 0 错误 |
| UC-3.1.2 | 检查 `app/server/package.json` | dependencies 中无 `electron` 字段 |

### 3.2 三环境配置（Three Environments） [v0.0.1]

**描述**：项目根目录维护 test / dev / prod 三份独立 `.env`（+ `.example` 模板），端口与数据目录按环境隔离。
**优先级**：P0
**用户故事**：作为开发者，我希望同一台机器能并行跑 dev 和自动化测试而不串数据、不抢端口。

**期望行为**：
- 根目录存在 `test.env.example` / `dev.env.example` / `prod.env.example` 三份模板（schema 文档），真实 `.env` 进 `.gitignore`。
- 端口分配（后端 API 与渲染层分离）：后端 `API_PORT` test `3700` / dev `3710` / prod `3720`；渲染 `WEB_PORT` test `8787` / dev `8788` / prod `8789`。三环境互不相同、同机并存不冲突。AT curl `API_PORT`，ET 驱动 `WEB_PORT`。
- 数据目录：APP_NAME 固定为 `rocky_agent`，故数据目录缺省为 `~/.rocky_agent_{env}`（dev → `~/.rocky_agent_dev/`、prod → `~/.rocky_agent_prod/`、test → `~/.rocky_agent_test/`），三环境物理隔离；`DATA_DIR` 可显式覆盖（如 CI 指向临时目录）。APP_NAME 在三份 .env 中取相同值 `rocky_agent`，不随环境变化。
- 共通键：`APP_NAME` / `APP_ENV` / `API_PORT` / `WEB_PORT` / `DATA_DIR` / `LOG_LEVEL` / `HEALTH_ENDPOINT`（三份 `.env` 均有）。
- `test.env` 专有：`API_START_CMD` / `WEB_START_CMD` / `HEADLESS`（大模型 key 可选，v0.0.1 mock 不需要）。`API_START_CMD` 起后端 server（监听 `API_PORT`），`WEB_START_CMD` 起渲染层 web dev server（监听 `WEB_PORT`，须含 `-- --port $WEB_PORT --strictPort`，因 vite dev 默认监听 5173 不读 `WEB_PORT`）。
- `prod.env` 专有：签名字段（`APPLE_*` / `CSC_*`，**v0.0.1 可全 optional**，本机未签名构建即可）+ `BUILD_OUT_DIR`。**版本号不在 prod.env**——取自根 `package.json` 的 `version`（`build-dmg.sh` 读它注入产物，见 `specs/tech/app/package/[P0]packaging_toolchain.md` §3.5）；prod 的进包白名单键会被抽进 `runtime-config.json` 供 packaged 运行时回填 `process.env`。
- schema 严格遵循 `specs/tech/app/envs/[P0]environments.md`。

**验收**：三份 `.example` 存在且字段完整；同一台机器 dev server（8788）与 test server（8787）可同时运行；切环境数据目录互不污染。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.2.1 | `source ./dev.env` 起 server+web → `source ./test.env` 起 server+web | 两环境并存，后端 `API_PORT` 分别 3710 / 3700、渲染层 `WEB_PORT` 分别 8788 / 8787，互不冲突 |
| UC-3.2.2 | 在 dev 写入计数 → 切到 test 读计数 | test 读到的是 test 自己的初始值，不串 dev 数据 |

### 3.3 运行与打包脚本（Scripts） [v0.0.1]

**描述**：`scripts/` 下三个脚本，各 source 固定一份 env，承担人工调试与发布入口。
**优先级**：P0
**用户故事**：作为开发者 / 发布者，我希望一键入口跑测试、起开发、出安装包。

**期望行为**：
- `scripts/unit-test.sh` → source `test.env` → `bun run test`（即 `npx vitest run`）。
- `scripts/run-dev.sh` → source `dev.env` → 启动开发态（Vite dev + Electron dev）。
- `scripts/build-dmg.sh` → source `prod.env` → 调 electron-builder 出 dmg（mac）/ exe（win 变体）。
- 缺 env 或关键字段即非 0 退出并提示从 `.example` 拷贝，不留默认值兜底。
- 退出语义统一：成功 `0`，失败非 `0`。
- 契约严格遵循 `specs/tech/app/envs/[P0]scripts.md`。

**验收**：三个脚本存在且可执行；缺对应 `.env` 时报错退出；`run-dev.sh` 能拉起应用窗口；`build-dmg.sh` 能在 `release/` 产出 dmg 文件。

> **[v0.0.108] 「dmg 产出」≠「dmg 可用」**：v0.0.108 完善打包能力，把验收实质从「产出 dmg 文件」提升到「装后可用」——packaged app 双击启动后**后端能起 + HTTP 200 + 内置 plugin 加载（LLM provider 非空壳）**。真机暴露并闭环四个 Critical bug（运行时配置注入缺失 / server 第三方依赖未进包 / 内置 plugin 未编译进包 / dataDir 字面 `~` 未展开致全 500）。机制见 `specs/tech/app/package/[P0]packaging_toolchain.md` §3.6/§3.7 + `[P0]package_structure.md` §3.6/§4.3 + `specs/tech/plugin_system/[P0]packaged_plugin_loading.md`。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.3.1 | 临时移走 `dev.env` → 跑 `./scripts/run-dev.sh` | 脚本报「缺失 dev.env」并非 0 退出 |
| UC-3.3.2 | `./scripts/build-dmg.sh` | `release/` 下生成 `*.dmg`，文件存在且体积 > 0 |

### 3.4 Mock 计数功能（Mock Counter） [v0.0.1]

**描述**：server 跑 `node:http` 暴露 HTTP API 读写计数器，渲染层 React fetch 它，前端用暖色风格做计数器 UI。用作端到端验证载体。
**优先级**：P0
**用户故事**：作为开发流程，我希望有一个最小但真实的前后端链路，以便验证 dev 启动、HTTP API、AT curl、ET 截图整条通路。

**期望行为（产品行为，不规定实现）**：
- **后端 HTTP API**：server 暴露 `GET /counter`（读当前值）、`POST /counter/inc`（自增并返回新值）。响应体为 JSON，含 `value` 字段。
- **持久化**：v0.0.1 用最简存储即可（文件或内存）；不引入 persistence 引擎。test / dev / prod 三环境数据目录隔离（见 §3.2）。
- **前端 UI**：一个暖色风格的计数器卡片——显示当前值（JetBrains Mono 字体），一个 `button-primary`「+1」按钮，一个 `button-secondary`「刷新」按钮；点 +1 调 `POST /counter/inc` 后刷新显示。
- **API 契约**：HTTP（非 IPC），使 AT 可直接 curl 验证。

**验收**：`curl GET /counter` 返回 JSON 计数值；`curl POST /counter/inc` 后值 +1；前端点 +1 后界面计数刷新；UI 视觉符合暖色 token。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.4.1 | `curl POST /counter/inc` → `curl GET /counter` | 第二次返回值比第一次大 1 |
| UC-3.4.2 | dev 启动 → 浏览器打开 web → 看到「+1」按钮 → 点击 → 计数刷新 | UI 上数字增加 1，视觉风格为暖色 terracotta 主按钮 |

### 3.5 自动化测试流程（Automated Test Pipeline） [v0.0.1]

**描述**：走通三层自动化测试 UT / AT / ET，每层有可复现的入口与产出。
**优先级**：P0
**用户故事**：作为开发流程，我希望一条命令 / 一套流程就能跑通三层测试全绿，作为后续版本的验证基线。

**期望行为**：
- **UT**：`scripts/unit-test.sh`（或 `bun run test`）跑 vitest，全绿，覆盖 server 计数逻辑。
- **AT**：从 `tests/api/` 挑选 / 新建 case，通过 `env_start.sh` 起 test 环境 server → curl `/counter` 接口 → `env_shutdown.sh`，产出 `checkpoint.json` + `last_run.json`。
- **ET**：从 `tests/e2e/` 挑选 / 新建 case，Playwright 驱动 **web dev server**（非 Electron 本体）截图，截图经 MiniMax Vision MCP 结构化判定（验证暖色风格 + 计数器 UI）。
- 工具链红线：UT 用 `bun run test`（禁止 `bun test` / `npm test`）。

**验收**：三层各产出 `report.md` + 通过记录；ET 截图经 vision 判定 UI 元素与风格符合预期。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.5.1 | `./scripts/unit-test.sh` | vitest 全绿，退出码 0 |
| UC-3.5.2 | 跑 `tests/api/` 的 counter case | `last_run.json` 标记 pass，计数 +1 链路验证通过 |
| UC-3.5.3 | 跑 `tests/e2e/` 的 counter case | 截图经 vision MCP 判定含 terracotta 主按钮 + 计数数字 |

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖要求）

每条路径至少对应一个 API / E2E case。verifier 不得低于此覆盖。

| 路径 | 链路 | 涉及环境 / 接口 / UI | 最低 case |
|------|------|---------------------|----------|
| **路径 1：核心交互** | dev 启动 → 应用窗口打开 → 计数器 UI 按暖色风格渲染 → 点「+1」→ 调 `POST /counter/inc` → 计数刷新 | dev 环境 · `/counter` · `button-primary` 计数器 | ET（UC-3.4.2） + AT（UC-3.4.1） |
| **路径 2：环境隔离** | dev / prod / test 各自端口（后端 API 3710/3720/3700 · 渲染 WEB 8788/8789/8787）与 data_dir（`~/.rocky_agent_dev` / `~/.rocky_agent_prod` / `~/.rocky_agent_test`）不同；切环境不串数据 | 三环境 `.env` · `API_PORT` / `WEB_PORT` · `DATA_DIR` | AT（UC-3.2.1 / UC-3.2.2） |
| **路径 3：打包** | `scripts/build-dmg.sh` → 产出 dmg → 产物存在可启动 | prod 环境 · electron-builder · `release/*.dmg` | ET（UC-3.3.2，验证产物存在） |
| **路径 4：自动化测试** | 一条命令 / 一套流程跑通 UT + AT + ET 全绿 | test 环境 · vitest · curl · Playwright | UT（UC-3.5.1） + AT（UC-3.5.2） + ET（UC-3.5.3） |

---

## 5. 设计决策（已与用户确认）

### 5.1 mock 后端用 HTTP API，非 IPC [v0.0.1]

**结论**：mock 计数后端用 server 的 `node:http` 暴露 HTTP API（`/counter`），渲染层经 fetch 调用，**不**走 Electron IPC。
**理由**：让 AT 可直接 curl 验证后端，不依赖 Electron runtime；同时让 web dev server 可独立于 Electron 外壳被 ET 驱动。IPC 链路推迟到真正需要主进程能力的版本。
**反例**：若用 IPC，则 AT 必须拉起整个 Electron 才能调计数接口，慢且脆弱；web 也无法脱离 Electron 独立测试。

### 5.2 E2E 驱动 web dev server，非 Electron 本体 [v0.0.1]

**结论**：ET 用 Playwright 驱动 **Vite web dev server**（chromium），不对 Electron 主进程外壳做 E2E。
**理由**：v0.0.1 的目标是先走通自动化测试流程；Electron 外壳由 `build-dmg.sh` 产出 dmg 验证（产物存在 + 可启动）。两者各管一段，避免 ET 被 Electron runtime 拖慢。
**反例**：若 ET 直接驱动 Electron，则 Playwright 要装 Electron 专用驱动、启动慢、CI 不稳；v0.0.1 不值得为此外加复杂度。

---

## 6. 非功能需求

### 6.1 环境隔离 [v0.0.1]

- 三环境端口互不相同：后端 `API_PORT`（test 3700 / dev 3710 / prod 3720）+ 渲染层 `WEB_PORT`（test 8787 / dev 8788 / prod 8789），同机并存不冲突（见 §3.2）。
- 三环境数据目录物理隔离（`~/.rocky_agent_{env}`），自动化绝不读写 dev / prod 目录。
- `.env` 全部进 `.gitignore`，仓库只提交 `.example` 模板。

### 6.2 可测试性 [v0.0.1]

- 后端能力以 HTTP API 暴露，AT 可黑盒 curl。
- server 零 electron 依赖，可在纯 Node 下单测。
- 前端可被 Playwright 驱动（web dev server 独立运行）。

### 6.3 风格一致性 [v0.0.1]

- 前端 token 唯一来源是 `design_system.md`，不得手改 hex。
- v0.0.1 落地 token 最小子集（terracotta 主色、Inter / JetBrains Mono、圆角档位），为后续 UI 迭代奠基。

### 6.4 工程红线 [v0.0.1]

- 单文件 ≤ 300 行（CLAUDE.md 强制）。
- UT 唯一合规命令 `bun run test`，禁止 `bun test` / `npm test`。
- `scripts/` 仅人工入口，自动化走 `tests/` 下 `env_start.sh`。

---

## 7. 范围边界（IN / OUT）

### 7.1 IN SCOPE（v0.0.1 必须交付）

1. `app/` 5-workspace 脚手架（含包间依赖边界）。
2. test / dev / prod 三份 `.env` + `.example` 模板，端口与 data_dir 分环境。
3. `scripts/unit-test.sh` / `run-dev.sh` / `build-dmg.sh` 三脚本。
4. dev 能启动（Vite dev + Electron dev）、能打包出 dmg（本机未签名即可）。
5. mock 计数 HTTP API + 暖色风格计数器 UI。
6. UT + AT + ET 三层自动化测试走通全绿。

### 7.2 OUT OF SCOPE（v0.0.1 明确排除，含理由）

| 排除项 | 理由 |
|--------|------|
| **Agent loop**（感知→推理→行动循环） | v0.0.1 是工程基座，不涉及智能；后续版本接入 |
| **Session 管理** | 无对话概念，mock 计数不需要会话 |
| **Provider / Model 接入** | 不调任何 LLM，mock 后端是纯本地计数 |
| **Plugin system** | 扩展基座推迟 |
| **Persistence 引擎**（SchemaDef / CrudStore / SQLite engine） | 计数用最简存储（文件 / 内存）即可；引擎留待需要持久化的版本 |
| **Context / Memory** | 无对话上下文 |
| **代码签名 / 公证** | `prod.env` 签名字段 optional，本机未签名 dmg 即可验收 |
| **Electron 本体 E2E** | ET 驱动 web dev server（见 §5.2），Electron 外壳由 dmg 产物验证 |
| **线框中的聊天 / tool card / settings 等完整 UI** | v0.0.1 只参考视觉风格，不照抄内容（用户明确要求） |

---

## 8. 里程碑

### v0.0.1 — App Scaffold & Pipeline [当前]

**目标**：工程基座 + 三环境 + 打包 + 自动化测试流程全通，挂 mock 计数验证。
**包含功能**：§3.1 脚手架 / §3.2 三环境 / §3.3 脚本 / §3.4 mock 计数 / §3.5 自动化测试。
**验收口径**：
- dev 能起、prod 能打包出 dmg、产物可启动。
- 三环境端口与 data_dir 隔离验证通过。
- UT + AT + ET 三层全绿，覆盖 §4 四条关键用户路径。
- 前端视觉符合暖色 design_system token。

**下一版本预告**：在 v0.0.1 基座上接入 agent loop / session / provider，进入真正 AI 对话。

---

## 版本

version: 1.1 `[v0.0.11 modified]`（§2.3 新增 Rocky 品牌资产：app 图标 + 对话机器人头像 + 名标，权威源 `reqs/v0.0.11/icon.png`；范围限定 app 图标/机器人头像/名标，user 不动）。1.0 初始。
