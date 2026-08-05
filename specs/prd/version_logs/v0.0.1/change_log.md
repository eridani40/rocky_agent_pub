# PRD 版本变更日志 - v0.0.1

> version: 1.2 · 最后更新：2026-06-19T18:00:00Z（v1.2 由 doc-modifier 同步「Bun-in-Electron 已解决」现实：server HTTP 层改 node:http）
> 本文件记录 v0.0.1 相对「无前序版本」的增量。v0.0.1 是项目首版本，所有内容均为新增。

## 版本概要

| 字段 | 值 |
|------|------|
| 版本号 | v0.0.1 |
| 类型 | 首版本（Initial Release） |
| 主题 | App Scaffold & Pipeline（工程基座 + 三环境 + 打包 + 自动化测试） |
| 创建时间 | 2026-06-19 |
| 状态 | pending confirmation（待用户确认） |

## 一句话定位

v0.0.1 不做 AI，只做「能开发、能测试、能打包、能验证」的工程基座，挂 mock 计数功能作为端到端验证载体。

## 新增章节（相对无前序版本）

| 章节 | 文件 | 内容 |
|------|------|------|
| §1 产品概述 | `specs/prd/overall/01-product-framework.md` §1 | 定位（MVS）/ 目标用户（开发流程自身）/ 核心价值（可运行·可隔离·可验证·风格一致） |
| §2 UI 风格与交互规范 | 同上 §2 | 暖色 design_system 引用 + 布局稳定性 MANDATORY 约定 |
| §3.1 应用脚手架 | 同上 §3.1 | `app/` 5-workspace 包结构与进程边界 |
| §3.2 三环境配置 | 同上 §3.2 | test/dev/prod 三份 `.env` + `.example`，端口 8787/8788/8789 隔离 |
| §3.3 运行与打包脚本 | 同上 §3.3 | `scripts/` 三脚本契约（unit-test / run-dev / build-dmg） |
| §3.4 Mock 计数功能 | 同上 §3.4 | server HTTP API `/counter` + 暖色计数器 UI |
| §3.5 自动化测试流程 | 同上 §3.5 | UT / AT / ET 三层走通 |
| §4 关键用户路径 | 同上 §4 | 4 条路径（核心交互 / 环境隔离 / 打包 / 自动化测试）= 测试最低覆盖 |
| §5 设计决策 | 同上 §5 | 2 个已确认决策（HTTP API 非 IPC / ET 驱动 web dev server） |
| §6 非功能需求 | 同上 §6 | 环境隔离 / 可测试性 / 风格一致性 / 工程红线 |
| §7 范围边界 | 同上 §7 | IN SCOPE 6 项 + OUT OF SCOPE 9 项（含理由） |
| §8 里程碑 | 同上 §8 | v0.0.1 验收口径 |

## 关键决策记录

### 决策 1：mock 后端用 HTTP API，非 IPC

- **结论**：server 用 `node:http` 暴露 `/counter`（运行时可移植：Node 与 Bun 均能跑），渲染层 fetch 调用，不走 Electron IPC。
- **理由**：让 AT 可直接 curl；让 web dev server 可独立于 Electron 被 ET 驱动。
- **影响**：v0.0.1 后端能力以 HTTP 形态暴露；IPC 链路推迟到需要主进程能力的版本。

### 决策 2：E2E 驱动 web dev server，非 Electron 本体

- **结论**：ET 用 Playwright 驱动 Vite web dev server（chromium），Electron 外壳由 `build-dmg.sh` 产出的 dmg 验证。
- **理由**：先走通自动化测试流程，避免被 Electron runtime 拖慢。
- **影响**：ET case 的 `env_start.sh` 起 web dev server；Electron 主进程 E2E 推迟。

## 显式排除项（OUT OF SCOPE）

agent loop / session / provider / plugin system / persistence 引擎 / context / memory / 代码签名公证 / Electron 本体 E2E / 线框完整 UI 内容。

每项排除理由见 `01-product-framework.md` §7.2。

## 测试覆盖要求（MANDATORY）

v0.0.1 的 4 条关键用户路径 = 测试最低覆盖：

| 路径 | 必须覆盖层 |
|------|-----------|
| 路径 1 核心交互 | AT + ET |
| 路径 2 环境隔离 | AT |
| 路径 3 打包 | ET（产物存在性） |
| 路径 4 自动化测试 | UT + AT + ET |

verifier 不得低于此覆盖。具体 case 由后续 test-plan.md 从 `tests/` 选定 / 新建。

## 依赖的 tech spec

本版本 PRD 严格对齐以下已确认 tech spec（不改 tech spec）：

- `specs/tech/app/package/[P0]package_structure.md`（5-workspace 布局）
- `specs/tech/app/package/[P0]packaging_toolchain.md`（electron-builder → dmg）
- `specs/tech/app/package/[P0]tool_chain.md`（Bun + vitest 红线）
- `specs/tech/app/envs/[P0]environments.md`（三环境 `.env` schema）
- `specs/tech/app/envs/[P0]scripts.md`（三脚本契约）
- `specs/tech/app/frontend/[P0]tech_stack.md`（React 19 + Tailwind + Zustand + Vite + TanStack Query）
- `specs/tech/app/frontend/[P0]design_system.md`（暖色 token 唯一权威源）

## 与 tech spec 的对齐情况

v0.0.1 scope 与现有 tech spec **无冲突**。两处轻微说明（非修改 tech spec，仅澄清 v0.0.1 取用范围）：

1. `package_structure.md` 描述的 `electron/injection/`（FsPort/NetPort 注入）在 v0.0.1 **暂不需要**——mock 计数无原生能力诉求，server 直接用 Bun 原生 API。后续接入文件 / 网络能力时再启用 injection。
2. `tech_stack.md` 选定的 TanStack Query 在 v0.0.1 **可选**——mock 计数是单次 fetch，用裸 fetch 或 TanStack Query 均可，由 coder 自决；后续流式 token 接入时强制启用。**实际实现取用子集**：v0.0.1 的 `app/web/package.json` 未引入 `@tanstack/react-query`，计数器用裸 fetch（见 `tech_stack.md` §4.1 示例的 `@tanstack/react-query` 标注为「后续启用、v0.0.1 未引入」）。

以上两点均为「v0.0.1 取用子集」，不构成对 tech spec 的修改。

## 实现现实与已知限制（v1.1 追加，doc-modifier 阶段 5 同步）

v0.0.1 三层验证（UT 36/36、AT 2/2、ET 功能+视觉 PASS）已全绿。落地过程中暴露若干「specs 当初未预见的实现现实与已知限制」，本段同步进 change_log，供后续版本承接：

### 限制 1：Bun-in-Electron 限制 — 已解决（v1.2 由 doc-modifier 更新）

- **原现象**：`@app/server` 用 `Bun.serve`（Bun runtime API）启动后端 HTTP API；而 Electron 主进程跑 Node（不是 Bun），无法运行 `Bun.serve` → packaged dmg 不跑后端。
- **解决方式**：server HTTP 层从 `Bun.serve` 改为 `node:http`（Node + Bun 均能跑的运行时可移植实现）。Electron packaged 模式在主进程 `import { startServer } from '@app/server'` 直接起 node:http 后端，server 编译为 CommonJS 供 Electron Node `require`，packaged 计数器正常工作。
- **结论**：v0.0.1 的 packaged dmg **跑后端，计数器可用**。Electron 主进程不再定位为「纯外壳」，而是「窗口 + 后端宿主」。
- **dev / test 环境**：后端仍由 `$API_START_CMD`（bun 独立进程）跑；vite dev server 经 proxy 把 `/counter` 转到 `API_PORT`（`VITE_API_BASE` 为空 = proxy）；AT/ET 全部跑在 dev/test 环境。
- **packaged dmg**：web build 时 `VITE_API_BASE` 注入绝对 URL + server 开 CORS，渲染层 fetch 直连主进程内 node:http 后端，计数器正常。
- **保留约束**：server 仍**零 electron 依赖**（不 `import electron`），它只是导出 `startServer` 给 electron 调用——`node:http` 不依赖任何 electron API。

### 限制 2：端口 schema 拆分（实现已落地，specs §3.1 / §4.5 已对齐）

- **变化**：原始设想的单 `APP_PORT` 在实现中拆为双键：
  - `API_PORT`（后端 HTTP API，server `node:http` 监听）：test `3700` / dev `3710` / prod `3720`。
  - `WEB_PORT`（渲染层 Vite dev server）：test `8787` / dev `8788` / prod `8789`（prod 打包后不监听，仅占位）。
- **启动命令键同步拆分**：`APP_START_CMD`（单数）→ `API_START_CMD`（起后端）+ `WEB_START_CMD`（起渲染层）。`WEB_START_CMD` 必须含 `-- --port $WEB_PORT --strictPort`（vite dev 默认监听 5173 不读 `WEB_PORT`）。
- **specs 对齐状态**：`environments.md` §3.1 / §3.5 / §4.5、`PRD §3.2 / §4 路径 2 / §6.1` 已反映双端口。**本 change_log v1.0 初稿曾遗留 `APP_START_CMD` 字样，v1.1 已校正为 `API_START_CMD` + `WEB_START_CMD`**（见 PRD §3.2 期望行为）。

### 限制 3：bun 1.3.11 的 `--filter` / `--cwd run` 在本仓库 workspace 不解析

- **现象**：bun 1.3.11 的 `bun --filter @app/<pkg> run <script>` 与 `bun --cwd <pkg> run <script>` 在本仓库 workspace（含最小复现）下**均不解析任何 workspace**，疑似 bun bug。
- **结论**：启动命令改用**直接路径 / `cd && bun run` 形式**：
  - `API_START_CMD="bun run app/server/src/index.ts"`（直接跑入口 ts）
  - `WEB_START_CMD='cd app/web && bun run dev -- --port $WEB_PORT --strictPort'`（cd 进 web 再起 vite）
- **后续**：bun 修复 `--filter` / `--cwd` 后，仅需改对应 `.env` 一行即可换回 `bun --filter` 形式；实现层无需动。`environments.md` §3.5 示例注释已固化此说明。

### 限制 4：electron 必须在 `devDependencies`（electron-builder v26 强制）

- **现象**：`electron-builder` v26 在打包时**强制要求 `electron` 在 `devDependencies`**，放 `dependencies` 会直接报错退出。
- **结论**：`app/electron/package.json` 把 `electron` + `electron-builder` 都放 `devDependencies`。运行时 Electron 由 `.app` 包提供、不入 asar，故 `electron` 不算运行期 prod 依赖。
- **specs 对齐状态**：`package_structure.md` §4.2 示例、`packaging_toolchain.md` §4.1 示例均已校正（v1.1 由 doc-modifier 修正）。

## 版本

version: 1.2
