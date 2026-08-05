# Tech 版本变更日志 - v0.0.1

> version: 1.1 · 最后更新：2026-06-19T18:00:00Z（v1.1 由 doc-modifier 同步「Bun-in-Electron 已解决」：server HTTP 层 node:http + CORS，electron packaged 起后端，web `VITE_API_BASE`，server CJS 输出）
> 本文件记录 v0.0.1 相对「无前序版本」的 tech 变更。v0.0.1 是项目首版本，tech app/ 子系统全部为新增。

## 版本概要

| 字段 | 值 |
|------|------|
| 版本号 | v0.0.1 |
| 类型 | 首版本（Initial Release） |
| 主题 | App 工程基座落地：5-workspace 脚手架 + 三环境 + 三脚本 + mock 计数（server+web）+ electron 外壳与 dmg 打包 |
| 创建时间 | 2026-06-19 |
| 状态 | implemented + verified（UT 36/36 · AT 2/2 · ET 功能+视觉 PASS） |

## 一句话定位

把 `specs/tech/app/` 的设计稿（envs / package / frontend 三模块）落地为可运行、可测试、可打包的工程基座，挂 mock 计数作为端到端验证载体。

## 新增 tech 内容（相对无前序版本）

| 模块 | 文件 | 落地内容 |
|------|------|---------|
| 工程基座 | `app/{electron,web,server,protocols,shared}/` | 5-workspace Bun workspaces 脚手架，包间依赖单向（web→protocols、electron→server→protocols），server 零 electron |
| 环境配置 | `test.env.example` / `dev.env.example` / `prod.env.example` | 三份独立 `.env` schema 模板；端口拆分 `API_PORT`(3700/3710/3720) + `WEB_PORT`(8787/8788/8789)；启动命令键 `API_START_CMD` + `WEB_START_CMD` |
| 脚本 | `scripts/unit-test.sh` / `run-dev.sh` / `build-dmg.sh` | 三脚本各 source 固定一份 env；缺 env 即非 0 退出；`build-dmg.sh` 两段式（vite build → tsc -b → electron-builder）|
| 后端 | `app/server/src/{index,router,counter,config}.ts` | `node:http` 暴露 `/counter` + `/counter/inc` + `/health` + CORS；计数落盘 `${DATA_DIR}/counter.json`；零 electron 依赖；编译为 CommonJS 供 Electron Node require |
| 渲染层 | `app/web/src/{App,main}.tsx` + `store/counter-store.ts` + `styles/tokens.css` | React 19 + Tailwind v4（Vite 插件）+ Zustand；暖色计数器卡片（counter-card / counter-value / counter-inc-btn / counter-refresh-btn testid）|
| 主进程壳 | `app/electron/src/{main,preload,resolve-load-target}.ts` + `electron-builder.yml` | 纯外壳：起 `BrowserWindow`，据 `VITE_DEV_SERVER_URL` 决定 loadURL（dev）或 loadFile（packaged）|
| 打包 | `app/electron/electron-builder.yml` | appId / files（dist + web-dist + workspace deps）/ mac.dmg / win.nsis；版本号与签名凭证由 `prod.env` 注入 |
| 工具链 | 仓库根 `vitest.config.ts` + `tsconfig.base.json` | vitest 跨所有 workspace 跑全量 UT（web 用 jsdom）；tsconfig base 严格模式 + ES2022 + bundler moduleResolution |

## 关键技术决策（本版本沉淀）

### 决策 1：端口拆分 API_PORT + WEB_PORT（取代单 APP_PORT）

- **结论**：单 `APP_PORT` 拆为 `API_PORT`（后端 `node:http`）+ `WEB_PORT`（渲染层 Vite dev server），三环境各按 env 取值互不相同。
- **理由**：AT 只 curl `API_PORT`、ET 只 Playwright 驱动 `WEB_PORT`，二者是独立服务；合一端口会让 verifier 自己推断该连哪个、还可能让后端与渲染抢同一端口。
- **影响**：`environments.md` §3.1 / §4.5 已对齐；启动命令键同步拆为 `API_START_CMD` + `WEB_START_CMD`。

### 决策 2：Bun-in-Electron 限制 — 已解决（node:http 运行时可移植）

- **结论（v1.1 已解决）**：server HTTP 层从 `Bun.serve` 改为 `node:http`，运行时可移植（Node + Bun 均能跑）。Electron packaged 模式在主进程 `import { startServer } from '@app/server'` 直接起 node:http 后端；server 编译为 CommonJS 供 Electron Node `require`；packaged 计数器正常工作。
- **理由**：`node:http` 是 Node 内置 API，不依赖任何 Bun runtime API，可在 Electron 主进程（Node runtime）直接跑；同时也兼容 dev/test 用 bun 独立进程跑。
- **影响**：
  - dev/test 后端仍由 `$API_START_CMD`（bun 独立进程）跑，行为不变。
  - **packaged dmg 跑后端**：Electron 主进程 `import { startServer }` 起后端，计数器正常工作。
  - web 渲染层用 `VITE_API_BASE`（dev 空 = vite proxy；packaged build 注入绝对 URL，server 开 CORS）。
  - server 仍**零 electron 依赖**（不 `import electron`），它只导出 `startServer` 给 electron 调用——`node:http` 不依赖任何 electron API。
- **原历史**：v1.0 决策曾因 `Bun.serve` 不兼容 Electron Node 而把 Electron 定位为「纯外壳、packaged 不跑后端」，源码注释固化在 `app/electron/src/main.ts`；v1.1 已通过 node:http 解决。

### 决策 3：启动命令用直接路径 / `cd && bun run`，非 `bun --filter`

- **结论**：`API_START_CMD` / `WEB_START_CMD` 用 `bun run app/server/src/index.ts` 与 `cd app/web && bun run dev -- ...` 形式，不用 `bun --filter` / `bun --cwd run`。
- **理由**：bun 1.3.11 的 `--filter` / `--cwd run` 在本仓库 workspace（含最小复现）下不解析任何 workspace，疑似 bun bug。
- **影响**：`environments.md` §3.5 示例注释固化；bun 修复后仅需改对应 `.env` 一行即可换回 filter 形式。

### 决策 4：electron 放 devDependencies（electron-builder v26 强制）

- **结论**：`app/electron/package.json` 把 `electron` + `electron-builder` 都放 `devDependencies`，不放 `dependencies`。
- **理由**：electron-builder v26 强制要求 `electron` 在 devDeps（放 deps 直接报错退出）；运行时 Electron 由 `.app` 包提供、不入 asar，故 `electron` 不算运行期 prod 依赖。
- **影响**：`package_structure.md` §4.2 示例、`packaging_toolchain.md` §4.1 示例均已校正。

### 决策 5：TanStack Query v0.0.1 不引入（取用子集）

- **结论**：`app/web/package.json` 在 v0.0.1 **不引入** `@tanstack/react-query`，计数器用裸 fetch。
- **理由**：mock 计数是单次 fetch，TanStack Query 是为流式 token / 会话列表准备的；v0.0.1 引入只会增加无用依赖。
- **影响**：`tech_stack.md` §4.1 示例的 `@tanstack/react-query` 标注为「后续启用、v0.0.1 未引入」；后续流式 token 接入时强制启用。

## 与 specs 的对齐修正（doc-modifier 阶段 5 执行）

落地过程中发现 specs 与实现偏差，已就地修正：

| 偏差 | 修正位置 | 修正内容 |
|------|---------|---------|
| PRD §3.2 期望行为写 `APP_START_CMD`（单数） | `specs/prd/overall/01-product-framework.md` §3.2 | 改为 `API_START_CMD` / `WEB_START_CMD` 双键 |
| PRD §6.1 简写「端口 8787/8788/8789」 | `specs/prd/overall/01-product-framework.md` §6.1 | 补全双端口（API 3700/3710/3720 + WEB 8787/8788/8789）|
| PRD UC-3.2.1 描述端口错位（写 8788/8787 实为渲染层） | `specs/prd/overall/01-product-framework.md` §3.2 UC 表 | 改为 API_PORT 3710/3700 + WEB_PORT 8788/8787 |
| `package_structure.md` §4.2 electron 在 dependencies | `specs/tech/app/package/[P0]package_structure.md` §4.2 | electron 移到 devDependencies + 加决策注 |
| `packaging_toolchain.md` §4.1 无 electron 依赖位置说明 | `specs/tech/app/package/[P0]packaging_toolchain.md` §4.1 | 补决策注（electron 必须在 devDeps，builder v26 强制）|
| `tech_stack.md` §4.1 列 `@tanstack/react-query` 为 web deps | `specs/tech/app/frontend/[P0]tech_stack.md` §4.1 | 标注「v0.0.1 未引入、后续启用」|

## 显式排除项（与 PRD §7.2 对齐）

agent loop / session / provider / plugin system / persistence 引擎 / context / memory / 代码签名公证 / Electron 本体 E2E / 线框完整 UI 内容。

> v1.1 注：原「packaged dmg 跑后端（Bun-in-Electron 限制）」排除项已通过 node:http 解决，不再列入排除范围。

## 版本

version: 1.1
