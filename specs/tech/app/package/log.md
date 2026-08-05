---
type: log
title: Package KB 变更记录
updated: 2026-08-04
---

# Package KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-08-04 · v0.0.253（通用打开外部资源 IPC — shell:openExternal/openPath/readFileText）

- **`[P0]package_structure.md §4.4`（新增）**：renderer 调系统浏览器 / 系统默认应用 / 读绝对路径文件经 preload `window.rockyShell` 三 channel；范本 = `computer-permissions-ipc.ts`（纯 `compute*` + 注入 `ShellLike`/`FsLike` 可 UT）；channel 名硬编码非 protocols（对齐 v0.0.105 `computer:*` 范式，待 IPC 数量增长再统收 protocols）。
- **路径解析单一权威在 main 侧**：`computeResolveLocalPath(raw, home)` 纯函数 strip `file://` + 展开 `~`（注入 home 可 UT）+ 验证绝对路径；renderer 传 raw target，main 展开（防 cwd=`/` 字面 `~` 撞 BUG-004）。workspace 相对路径仍走 HTTP `readWorkspaceFile`（既有 `whitelistResolve` 不延伸到 chat 链接，PRD §2.3 信任任意路径）。
- **runtime-config 白名单不变**：channel 名硬编码（`shell:*`）非 env，本版本**不引入新运行时 env 键**（区别于 `API_PORT`/`DATA_DIR` 走 runtime-config.json）。
- **defense-in-depth 两道拦截**：`main.ts setWindowOpenHandler` 兜底所有 `target=_blank` / `window.open()` → `openExternal`（禁开新 Electron 窗口）；`webContents.on('will-navigate')` 拦截 href 改动，仅放行同 origin dev server，其它转 `openExternal`。
- **`index.md` ④**：加第 15 条原则「通用打开外部资源 IPC（v0.0.253）」。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：`open-external-ipc.ts`（channel 名 `shell:openExternal`/`shell:openPath`/`shell:readFileText` + 四纯函数注入 ShellLike/FsLike/home + readFileText 2MB 上限 + ENOENT/EACCES 按 `error.code` 归类）/ `main.ts`（whenReady 后 register + setWindowOpenHandler 返 deny + will-navigate 放行同 origin dev server）/ `preload.ts`（contextBridge expose `rockyShell`）/ `rocky-shell.d.ts`（返回形状逐字镜像）与 §4.4 一致；workspace 相对路径仍走 HTTP `readWorkspaceFile`（`component-chat-link-viewer.tsx` 按 `ChatLinkTarget.source` 分流），绝对路径才进 IPC——不变量1 成立。无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.253/change_plan.md`

## 2026-08-01 · v0.0.236（packaged nofile 抬升 + posix native dep Electron ABI rebuild — bash spawn EBADF 救急）

- **`[P0]packaging_toolchain.md §3.9`（新增）**：packaged nofile 抬升机制——`.app` 由 LaunchServices 启动继承 nofile soft=256（dev 终端 ulimit 1048576 测不到），启动期基线 fd 逼近上限致"第一次 bash spawn 就坏"。`app/electron/src/raise-nofile.ts raiseNofileLimit(4096)` 在 electron main（`main.ts` 时序 loadRuntimeConfig→raiseNofileLimit→startBackend）用 native `posix` 包调 POSIX `setrlimit(2)` 抬 soft 到 max(currentSoft,4096)，**hard 不动**（防超 kern.maxfilesperproc=92160）。容错红线：posix 缺失/getrlimit·setrlimit 抛错 → 静默 console.warn 不阻塞启动；Node 标准无 setrlimit API（process.setrlimit 实测不可用）、ulimit 不影响父进程、改 .app/Contents/MacOS 破坏签名 → native binding 是唯一可行。
- **`[P0]packaging_toolchain.md §3.9`（posix Electron ABI rebuild）**：`app/electron/package.json` 加 `posix@4.2.0`（主进程运行时硬依赖）；`build-dmg.sh ②d` node-gyp direct rebuild（`--target=<electron-ver> --dist-url=<headers> --runtime=electron`），**非 `npx @electron/rebuild`**——npx 命中陈旧 node-abi cache 不认 electron 42.4.1 ABI 必败阻塞 dmg，node-gyp direct 绕过 node-abi ABI 探测直拉 headers exit 0。硬依赖 exit 1 语义（vs ②c better-sqlite3 warn+skip——后者被 packaged default=node:sqlite 全覆盖是未激活 fallback）。
- **`[P0]packaging_toolchain.md §4.2`**：流程图 ②b 补 native 模块 Electron ABI 预编译三档（computer-native / better-sqlite3 warn+skip / posix exit 1）；④ 补注含 raise-nofile.ts。
- **`[P0]packaging_toolchain.md §4.3`**：场景 C（新增依赖）加「native npm dep」自检项——node-gyp direct（禁 npx @electron/rebuild）+ 硬依赖 exit 1 / 未激活 warn+skip 语义二分 + N-API vs 非 N-API rebuild 成败对照；验证锚点补 `.node` 产物存在核对。
- **`index.md` ④**：加第 14 条原则「packaged nofile 抬升 + native dep Electron ABI rebuild（node-gyp direct 非 npx）」。
- **代码↔spec 偏离核实**：`raise-nofile.ts`（loadPosixBinding 动态 require + hard 不动 + 容错三档）/ `main.ts:121`（时序 runtime-config → raise-nofile → startBackend）/ `build-dmg.sh ②d`（node-gyp direct L226-241 + exit 1 L243/248）/ `app/electron/package.json:14`（posix@4.2.0）与 spec 一致；**②d 偏差（change_plan 原写 @electron/rebuild，实际 node-gyp direct）已记 change_log §2.1**（npx cache 陈旧 + node-abi 不认 electron 42，coder 实证 node-gyp direct exit 0；②c 本就有 node-gyp fallback 先例）。无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.236/change_plan.md` + `change_log.md`

## 2026-07-24 · v0.0.204（copyResources 加 session-types/ — SessionTypeProfile 配置层打包护栏）

- **`[P0]packaging_toolchain.md §3`**：`scripts/build-plugins.ts` 的 `copyResources()` 必须拷贝 `app/plugins/session-types/` 到 packaged dist（同 `scopes/` 目录待遇），缺失则 packaged 运行时 SessionTypeProfileLoader 读不到 profile 硬失败（dev 测不到，packaged 专属崩溃）。session-types/*.yaml = `SessionTypePolicy.profile(kind)` 的唯一数据源（v0.0.204 起 bound/runShape/lifecycleHooks/eventChannel 等行为契约全在 yaml）。
- **打包护栏背景**：v0.0.204 起 SessionTypeProfile 是 agent 行为契约配置层（替代原 TS 常量 TOOL_POLICY + AgentScopeRouter 路由表）；profile 文件落 `app/plugins/session-types/`，dev 直接读源文件、packaged 须从 asar 内 `node_modules/@app/plugins/session-types/` 读。详见 `../../agent/session/[P0]session_type_profile.md §11 打包护栏`。
- 详情：`specs/tech/version_logs/v0.0.204/change_plan.md`

## 2026-07-15 · v0.0.153（BUG-001：编译期资源镜像缺失 — prompts content .md 未进 dist）

- **第五类打包陷阱确认**：`tsc -b` 只编译 `.ts`，从不复制资源文件；`app/server` build 脚本历史只 cp migration `.yaml`，漏了 `src/prompts/content/**/*.md`——packaged 跑 `dist` 读不到 content 目录，system prompt 全空（dev 直读 src 全绿测不到）。修复：build 脚本补 `cp -r src/prompts/content dist/prompts/` + 新增 `scripts/check-server-build-assets.sh` 做 src→dist 镜像比对（缺失即 build fail）。→ `packaging_toolchain.md §3.8`。
- **新增 §4.3 打包改动自检清单**（按新增内容类型分类：新增 `.ts` / 新增资源文件 / 新增依赖 / 新增运行时 env 键），整合 BUG-001~004 四类陷阱为可操作检查项，供后续版本改动前自查。→ `packaging_toolchain.md §4.3`。
- **`index.md` ④ 加第 13 条原则**：编译期资源镜像不变量。
- **打包链系统性审计**（`states/v0.0.153/packaging-audit.md`）额外发现 3 Major + 7 Minor 潜伏雷（browser 工具 packaged 全灭 / `WEB_PORT` 不在 runtime-config 白名单 / `@app/protocols` 无 build 产物等），**均未在本版本修**（范围纪律，留用户决策开后续版本），已转 `states/v0.0.153/bugs/BUG-002/BUG-003`（open）。

详情：`specs/tech/version_logs/v0.0.153/change_log.md`

## 2026-07-10 · v0.0.108

- 版本号权威源改为**根 `package.json` 的 `version`**（不再 prod.env `APP_VERSION`）：`build-dmg.sh` 用 `node -p` 读根包、经 electron-builder `--config.extraMetadata.version` 注入（builder 在 `app/electron` 子目录跑默认读子包 `0.0.0` 占位，故须显式覆盖）。→ `packaging_toolchain.md §2.1/§3.5`。
- 新增 **runtime-config.json 白名单注入机制**（修 packaged app 后端起不来的真 bug）：build 期从 prod.env 抽 6 键非密钥白名单（`API_PORT`/`DATA_DIR`/`APP_NAME`/`APP_ENV`/`LOG_LEVEL`/`HEALTH_ENDPOINT`）生成 `runtime-config.json` 打进 asar，`main.ts` 启动最早期 `loadRuntimeConfig` 回填 `process.env`（不覆盖已有）。零密钥硬约束（生成端 + 读取端两端白名单过滤）；`DATA_DIR` 存字面 `~/` 运行时按运行用户 home 展开。→ `packaging_toolchain.md §3.6`。
- 修正 `files` 中 web 产物路径 `dist-renderer` → `web-dist`（对齐 vite outDir 实际），并加 `runtime-config.json`。→ `packaging_toolchain.md §3.2/§4.1`。
- 新增 **内置 plugin 编译步（BUG-003）**：build 期 `scripts/build-plugins.ts`（bun build 每 impl → 自包含 `.cjs`，server 外置 `@app/server/dist/X`）+ 资源拷贝 → `app/plugins/dist`；`electron-builder.yml` `files` `{from:../plugins/dist, to:node_modules/@app/plugins}` 映射进 asar（server→plugins 偏移 dev/packaged 一致 → 路径零改动）。历史整个 `app/plugins/` 不进 asar → `ScopeConfigLoader` 硬崩 + 0 插件空壳（真机实证）。加载架构见 `../../plugin_system/[P0]packaged_plugin_loading.md`。→ `packaging_toolchain.md §3.7/§4.1/§4.2`。
- **BUG-002 依赖归属边界**：`@app/server` 运行时 import 的第三方 npm 包必须声明在 `app/server/package.json`（不能只在根 `package.json` 靠 Bun hoist）——electron-builder 只跟随 `@app/server` 自身 prod deps 打第三方包进 asar，根 hoist 的包不进包，packaged 启动 `Cannot find module 'yaml'` 崩。→ `package_structure.md §3.6`（依赖归属决策）+ `packaging_toolchain.md §3.2`（打包侧后果）。
- **BUG-004 packaged 启动桥 dataDir 展开责任**：`backend-bootstrap.resolveServerOpts` 传 `startServer` 的 `dataDir` 必须绝对路径，改用 `require('@app/server/dist/config').resolveDataDir(env)` 展开字面 `~`（禁重复拼接字面 `~`）。原字面 `~` 在 packaged cwd=`/` 下 `mkdirSync('/~/...')` EACCES → 全部 HTTP 500。用子路径 `@app/server/dist/config`（`resolveDataDir` 未从 server index re-export）。→ `package_structure.md §4.3` + `../envs/[P0]environments.md §4.7`。

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`。
- 三文件（`package_structure.md` / `packaging_toolchain.md` / `tool_chain.md`）已带 frontmatter（small-B 加）；本版本清理散文 inline 版本号（`v0.0.1 落地修正` / `v0.0.2 实验库` / `v0.0.2+` / `v0.0.2 起 = ...`）→ 移到正文现状描述或本 log。

## 历史版本详情

- `electron` + `electron-builder` 落 devDependencies（electron-builder v26 强制校验）：详见 `specs/tech/version_logs/v0.0.1/`。
- `scripts.test` = `bun --bun x vitest run`（强制 bun runtime 因 persistence SQLite engine 用 `bun:sqlite`）：详见 `specs/tech/version_logs/v0.0.2/`。
