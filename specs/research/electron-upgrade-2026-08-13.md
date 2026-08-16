# Electron 升级调研：async_hooks CHECK trap 根治方向（2026-08-13）

> 调研任务：查证 async_hooks CHECK trap bug 身份 + 评估 Electron 42.4.1 → 最新稳定版升级路径 + 兼容风险 + 打包影响。
> 依据：`states/worker-crash-isolation/bugs/BUG-345-worker-crash-root-cause-[open].md`（机器码级实证）+ 官方 issue 库/changelog/release notes 交叉查证。
> 只调研不改代码，版本决策由老板拍板。结论分层：**确定 / 高置信 / 待证**。

## 0. 背景锚点

- 当前：Electron **42.4.1**（2026-06-16）内嵌 Node **24.16.0** / Chromium **148.0.7778.265**。
- 崩溃：Electron Framework 内 `AsyncWrap::EmitTraceAsyncStart()` 调用后紧邻的 CHECK trap（brk/hlt/brk 三连 = clang CHECK/UNREACHABLE 发射模式），async context push 路径；主线程（08-08 0.0.295）与 worker 线程（08-11/08-13）均可达。
- 本机已撤 worker pool（v0.0.345），trap 主线程可达 → 根治候选 = Electron 升级换 Node 补丁。

## 1. Bug 身份查证结论

### 1.1 官方 issue 库查无直接对应（确定）

- **electron/electron**：搜 `async_hooks crash` / `async crash`（2026-05 后 PR）无 async context 相关修复；历史 async_hooks 修复均为 Windows NotifyWindowRestore（2023-2024，与本 trap 无关）。
- **nodejs/node**：搜 `EmitTraceAsyncStart`（1 条，2025-04 的 tracing 重构 PR #57866，无关）；搜 `async_hooks crash CHECK`（128 条，无 24.16.0 的 async context CHECK 报告）。
- **结论**：该 trap **无官方已报告的 issue、无官方确认的修复版本**。升级前无法从公开记录确认「修复于哪个版本」——这是本调研的核心不确定点。

### 1.2 崩溃路径源码核查：升级范围无针对性修复（确定）

| 文件 | v24.16.0 → v24.18.1 | 证据 |
|---|---|---|
| `src/async_wrap.cc`（崩溃所在文件，含 EmitTraceAsyncStart/AsyncReset/EmitAsyncInit） | **零改动**（735 行 identical） | GitHub API diff 比对 |
| `src/async_hooks.cc` / `src/callback.cc` | 5/21-8/13 期间 **零 commit** | per-file commits API |
| `src/env.cc`（主线程路径 CheckImmediate） | 2026-06-14「fast path empty native immediate drain」PR #62969；v24.16.0 与 v24.17.0 的 CheckImmediate 段**代码相同**（fast-path 落在 24.18.x） | 源码 diff |
| `lib/internal/async_hooks.js` | 2026-07-19「timers 不保留 async store」PR #62969-族；v24.16.0 与 v24.18.1 **diff 为空**（同一文件行数相同）→ 该 commit 落地于 24.19.0 或未进 v24 分支 | 源码 diff |

**含义**：即使升到内嵌 24.18.1 的最新 Electron（42.9.0/43.4.0），崩溃路径所在 C++ 代码**没有任何修复**。升级属于「机会性更新」（新 Node 补丁 + 新 Chromium/V8），**不是**有官方背书的目标修复。

### 1.3 关联但不同的已知问题（确定）

1. **CVE-2025-59466 / Node 2026-01-13 security release**（Node 20.20.0/22.22.0/24.13.0/25.3.0）：async_hooks 启用时 stack overflow → 进程 exit code 7（TryCatchScope::kFatal 路径）。**24.16.0 已含此修复**（24.13.0 打上），且症状是 exit 7 非 brk trap → **不是本次崩溃**，但同属「async_hooks 机制 + 边界条件」家族。
2. **nodejs/node#61705**（2026-02）`Abort in Environment::CheckImmediate`：栈与 08-08 主线程崩溃高度相似（CheckImmediate → MakeCallback），但根因是**报告方自建 embedding**（node::CallbackScope 包 uv_run 导致 async callback scope 深度错），joyeecheung 结论非 Node 自身 bug，已关闭。佐证：async_hooks 开启时 uncaught exception 会被 kFatal 处理——**任何第三方依赖在 Electron 主进程里 enable async_hooks 都会放大此类风险**（待证第 3 条与此呼应）。
3. **Node 24.19.0 commit「test: accept SIGILL aborts in async-hooks tests」**（2026-06-03）：async_hooks 测试的故意 abort 路径在某些平台发 SIGILL——印证 trap 类信号在 async 路径属已知测试现象，但**非修复**。

### 1.4 结论

- **确定**：无官方 issue 记录、无官方修复版本可查；async_wrap.cc 在候选升级范围内零改动。
- **待证**：trap 精确 CHECK 身份（需 dSYM，08-11 已证实 dSYM 不可靠）；trap 是否实为 **V8/Chromium 侧 async context 问题**（async_wrap.cc 仅是被调用方）——若是，升级 Chromium 150 有真实价值，此点无法静态确认。

## 2. 升级路径版本矩阵（确定，releases.electronjs.org + releases.json 实证）

| Electron | 日期 | Chromium | Node | 备注 |
|---|---|---|---|---|
| 42.4.1（当前） | 06-16 | 148.0.7778.265 | 24.16.0 | 崩溃版本 |
| 42.5.2 | 06-30 | 148.0.7778.271 | 24.17.0 | 42.x 首个 24.17.0 |
| 42.6.0 ~ 42.8.1 | 07-03 ~ 08-04 | 148.0.7778.280 | 24.18.0 | |
| **42.9.0** | **08-11** | **148.0.7778.280** | **24.18.1** | 42.x 最新；同 major 最小升级 |
| 43.0.0 | 06-30 | 150.0.7871.46 | 24.17.0 | |
| **43.4.0** | **08-11** | **150.0.7871.224** | **24.18.1** | 43.x 最新；Chromium 跨 2 major |
| 44.0.0-beta.3 | 08-10 | 152.0.7977.30 | 24.18.1 | 未稳定 |
| 45.0.0-nightly | 08-12 | 153.0.7982.0 | 24.18.1 | nightly |

**关键事实**：42/43/44/45 全系内嵌 Node 均为 **24.18.1**（24.19.0 尚未进任何 Electron）。因此「换新 Node 补丁」的天花板 = 24.18.1，而 24.18.1 对崩溃路径零改动（见 1.2）。

## 3. Electron 43 Breaking Changes 对照（确定）

43.0.0 官方 4 条 breaking（GitHub release API 提取），逐条对照项目 API 使用面（`app/electron/src/` grep 盘点）：

| Breaking | 项目是否触及 |
|---|---|
| 文件下载默认打开位置变化（PR #49868） | ❌ 无 will-download/session 下载管理（grep 空） |
| nativeImage 色彩归一化为 SRGB（#51565） | ❌ 无 nativeImage 使用 |
| Linux frameless 圆角默认开（#52111） | ❌ 项目 mac 目标 |
| Linux dialog 移除 showHiddenFiles（#51880） | ❌ 无 dialog 使用 |

**项目 Electron API 使用面**（全量盘点）：`app`(28) `shell`(13) `ipcMain`(12) `webContents`(3) `BrowserWindow`(3) `desktopCapturer`(15) `systemPreferences`(1) `contextBridge`/`ipcRenderer`(preload)。均为跨 major 稳定 API，**43 无任何一条 breaking 触及**。

## 4. 兼容风险清单（确定为主）

| 依赖 | 版本 | 风险 | 结论 |
|---|---|---|---|
| posix（raise-nofile 硬依赖） | 4.2.0，nan ^2.14 | 升级后 ②d rebuild 需**新版本 Electron headers**（nan 与新 V8 兼容性：42 已踩过 cast_function_type_mismatch warning，43 需重验） | 可控；机制已就绪，见 §5 |
| @app/computer-native | node-addon-api ^8.3.0 | N-API 稳定 ABI，跨 Electron 版本理论零重编译风险；build-native.sh 仍会重编 | 低 |
| better-sqlite3 | ^11.10.0 | 已 fast-skip（V8 mismatch，packaged 用 node:sqlite 兜底），升级无影响 | 无 |
| playwright | ^1.61.1 | 项目**不用** `_electron` 驱动（grep 空，playwright 只驱动 chromium），与 Electron 版本解耦 | 无 |
| electron-builder | 26.15.3（bun.lock 锁定，最新） | 26.x 对 42/43 均支持；build-dmg.sh 已**绕过 node-abi ABI 表**（node-gyp direct --dist-url --runtime=electron），无需 node-abi 认识 43 | 无 |
| langfuse / MCP SDK | 3.37 / 1.29 | node_modules 内 grep 无 AsyncLocalStorage 直接使用（ALS 在 Node 24 已迁 AsyncContextFrame，与 async_hooks CHECK 路径无关） | 无 |

## 5. 打包影响（build-dmg.sh，确定）

三处 Electron 版本耦合点，升级后行为：

1. **ELECTRON_VERSION_FOR_BS3/POSIX**：缺省自动从 `require('electron/package.json').version` 读取 → **自动跟随新版本，零改动**。
2. **②d posix node-gyp rebuild**：`--dist-url=https://electronjs.org/headers` 拉新版本 headers → **首次升级需联网下载新 Electron headers**（这是唯一新增联网点）。
3. **③ electronDist 离线分支**：要求 `app/electron/node_modules/electron/dist/version` 存在新版本 dist → 有网环境 `bun install` 时 install.js 自动下载解压（命中 `~/Library/Caches/electron` 缓存则零联网）；**离线机需先在有网环境跑一次 bun install 或预置缓存 zip**。

electron-builder.yml 零改动（版本由 CLI 注入，npmRebuild:false 保持不变防 computer-native dylib 被清）。

## 6. 版本建议（供老板拍板，非决策）

| 方案 | 版本 | 收益 | 风险 |
|---|---|---|---|
| **B（推荐）** | 43.4.0 | Node 24.18.1 + **Chromium 150**（V8/ANGLE 跨 2 major 修复——若 trap 实为 V8 侧问题此路有真实价值）+ 4 条 breaking 零触及 | 略大于 42.x 的回归面（Chromium 大版本） |
| A（最小） | 42.9.0 | Node 24.18.1 + Chromium 148 补丁，同 major 回归面最小 | Chromium 侧修复少 |
| C（观望） | 44 stable | 无（仍 24.18.1） | 未稳定 |

**重要预期管理（给 architect/老板）**：A/B 均**无官方 async_hooks 修复背书**（async_wrap.cc 零改动）。升级是消除 trap 的**必要前置**（带新补丁 + 换 Chromium/V8），但**不能宣称根治**。升级后仍需：
- ET 主线程高频工具调用**长时观察**（SIGTRAP 无日志无 JS 异常，只能跑时长，参考 08-08 主线程崩溃）。
- 升级后若再捕获 .ips 崩溃，与 0x5303D58 trap 三连比对，确认 trap 是否仍在（在 = Node 侧未根治，需考虑上报 nodejs/node issue 或进一步定位）。

## 7. 升级步骤草案（给 architect 出 change_plan 用）

1. `app/electron/package.json` devDeps：`electron ^42.0.0` → `^43.4.0`（或 42.9.0）。
2. 有网环境：`bun install`（electron install.js 下载新 dist + 缓存 zip）；同步 `bun.lock`。
3. 离线机预置：`~/Library/Caches/electron` zip + electronjs.org/headers 缓存（或先用有网机跑一遍打包）。
4. `bash scripts/build-dmg.sh`：②d 自动用新版本 headers 重编 posix；②b 重编 computer-native；③ 走 electronDist 离线分支。
5. 产物验证：dmg 内 Electron Framework 版本（`dist/version`）、packaged 启动、posix raiseNofileLimit 生效、computer 能力可用。
6. 回归：UT 全绿（bun run test）+ typecheck（tsc -b）+ AT 冒烟 + ET 主线程高频工具调用长时观察（崩溃无日志，跑时长）。
7. change_plan 标注：本升级无官方 async_hooks 修复背书（本报告 §1.2/§6），观察期 + 若再崩比对新 .ips 的 trap 三连。

## 附：证据清单

- `releases.electronjs.org/releases.json`：全版本 Node/Chromium 矩阵（§2）
- GitHub API：electron/electron releases v42.9.0/v43.0.0（breaking 4 条 + 42.x 修复清单）
- GitHub API：nodejs/node compare v24.16.0...v24.18.1（186 commits，300 files）+ per-file commits（async_wrap.cc/callback.cc/async_hooks.cc/env.cc）
- 源码 diff：async_wrap.cc 735 行 identical；env.cc CheckImmediate 段 24.16.0 vs 24.17.0 相同；lib/internal/async_hooks.js 24.16.0 vs 24.18.1 diff 空
- nodejs.org blog：2026-01 DoS mitigation（CVE-2025-59466）、v24.17.0/24.18.0/24.18.1/24.19.0 release notes
- nodejs/node #61705（CheckImmediate abort，closed）、commit 88ab61f2f（sigill aborts in async-hooks tests）、commit d25cde436（timers async store leak）
- 项目侧：app/electron/src API 全量 grep 盘点、bun.lock（electron@42.4.1 / electron-builder@26.15.3）、build-dmg.sh 三处版本耦合点、posix nan ^2.14
