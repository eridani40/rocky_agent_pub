---
type: spec
title: Packaging Toolchain（打包工具链）
priority: P0
status: active
updated: 2026-08-01
since: v0.0.1
related: [[P0]package_structure.md, ../envs/[P0]scripts.md, ../envs/[P0]environments.md]
---

# Packaging Toolchain（打包工具链）

> 管什么：electron-builder 选型理由、产物形态（dmg/exe）、workspaces 下 asar 打包处理、builder 配置字段归属、产物目录约定。
> 不管什么：`scripts/build-dmg.sh` 的脚本契约（→ `app/envs/[P0]scripts.md` §3.3）、三环境语义（→ `app/envs/[P0]environments.md`）、各 workspace 内部实现。
> 边界归属规则见 [docs_guide.md](../../docs_guide.md) §4。

## 1. 概述

打包工具链负责把 `@app/electron`（主进程壳 + server + protocols + web 产物）打成一个**可分发的桌面安装包**。工具选定 **electron-builder**：macOS 出 `*.dmg`、Windows 出 `*.exe`。脚本入口是 `scripts/build-dmg.sh`（source `prod.env` 后调用本工具链），本文件**不重复**脚本契约，只补工具链选型与配置归属。

```
scripts/build-dmg.sh ──source──→ prod.env ──→ electron-builder ──→ *.dmg / *.exe
                                                       ▲
                                       app/electron/electron-builder.yml
```

## 2. 接口定义（builder 配置契约）

### 2.1 配置文件归属

| 配置项 | 归属文件 | 形态 |
|---|---|---|
| builder 主配置（appId / productName / mac / win / dmg / nsis / asar 等） | `app/electron/electron-builder.yml` | YAML |
| 产物版本号 | **根 `package.json` 的 `version`**（唯一权威源）；`build-dmg.sh` 读它经 `--config.extraMetadata.version` 注入，不硬编码进 yml、不再取自 prod.env（见 §3.5） | package.json |
| 代码签名 / 公证凭证 | `prod.env`（CSC_LINK / APPLE_* 等），空则跳过签名（v0.0.1 允许未签名） | 环境变量 |
| 产物输出目录 `BUILD_OUT_DIR` | `prod.env` | 环境变量 |
| 运行时注入配置（白名单非密钥键） | build 期由 `build-dmg.sh` 从 prod.env 抽白名单键生成 `app/electron/runtime-config.json` 打进 asar，packaged 运行时回填 `process.env`（见 §3.6） | 生成的 JSON |
| 主进程入口 `main` | `app/electron/package.json` 的 `main` 字段 | package.json |

> **配置跟着构建目标走**：builder 配置放 `electron/`（构建目标在主进程），不放仓库根。

### 2.2 关键字段约束

| 字段 | 约束 | 原因 |
|---|---|---|
| `appId` | 必填，唯一反向域名 | mac/win 中的应用身份，错配会导致升级冲突 |
| `productName` | 必填，与 `APP_NAME` 一致 | 安装包显示名 |
| `directories.output` | 取 `${BUILD_OUT_DIR}` 或固定 `release` | 产物归口（见 §3.4） |
| `files` | 必须包含 web 构建产物 + server dist + protocols dist | 否则 workspace deps 漏打（见 §3.2） |
| `asar` | `true`（默认）；如遇原生模块需解包则 `asarUnpack` | 标准做法 |
| `mac.target` | `dmg`（主产物） | 见 `[P0]scripts.md` §4.3，dmg 为主、exe 为平台变体 |
| `win.target` | `nsis`（出 `*.exe`） | 同上 |

## 3. 设计决策

### 3.1 选 electron-builder，不选 electron-forge / 手动打包

**结论**：打包工具选定 **electron-builder**，跨平台出一套配置，mac 出 dmg、win 出 exe。
**理由**：electron-builder 把"依赖收集、asar 打包、代码签名、公证（notarization）、多 target（dmg/nsis/appx）"封装成声明式 YAML，社区成熟、与 workspaces 配合有成熟模式；相比之下 electron-forge 更偏 dev server 与插件化，打包产出形态定制弱；手动打包要自己处理依赖收集与签名，维护成本高。本仓库 mac 主开发、win 为变体（见 `[P0]scripts.md` §4.3），electron-builder 一份配置覆盖两端最省。
**反例**：若选手动打包（zip 整个 node_modules），则 workspace 的 `workspace:*` 协议符号链接在打包时不解析，产物内出现断链，运行即崩。

### 3.2 workspaces 下 asar 打包：把 server/web/protocols 显式列入 files

**结论**：在 `electron-builder.yml` 的 `files` 字段中**显式包含** `@app/server`、`@app/protocols` 的产物路径与 web 构建产物（`web-dist`，即 vite build outDir = `app/electron/web-dist`）；bun install 时 workspaces 以**符号链接**形式存在于 `node_modules/@app/*`，electron-builder 默认会跟随，但为防 edge case 显式声明更稳。
**理由**：Bun workspaces 把本地包以符号链接挂进 `node_modules`；electron-builder 默认遍历 `node_modules` 收集 prod deps，符号链接会被解析为真实目录打进 asar。但 server/protocols 是"业务源码级"依赖、web 产物在主进程壳之外的目录，显式列入 `files` 能避免某些 edge case（如 monorepo hoist 策略、bundled 主进程不引用 server 入口导致 tree-shake）下被漏打。
**反例**：若不显式声明只靠默认依赖收集，则一旦主进程入口用 bundler（如 esbuild 打 main）把 server inline，electron-builder 可能判断 server 是 dev 依赖不打进 asar，运行期 `require('@app/server')` 找不到模块。

> **`@app/server` 的第三方 npm 依赖必须声明在 `app/server/package.json`（BUG-002 教训）**：electron-builder 打 workspace 时**只跟随 `@app/server` 自身 `package.json` 声明的 prod deps** 去收集第三方 npm 包（`yaml`/`gray-matter`/`@modelcontextprotocol/sdk`/`@mozilla/readability`/`adm-zip`/`chrome-devtools-mcp`/`linkedom`/`undici`/`@larksuiteoapi/node-sdk` 等）。若这些包只在**根 `package.json`** 声明、靠 Bun hoist 供 dev 侥幸运行，则 packaged asar 里缺这些包——启动即 `Cannot find module 'yaml'` 崩。故 server 运行时 import 的每个第三方包**必须**在 `app/server/package.json` 的 `dependencies` 显式声明（依赖归属边界见 `[P0]package_structure.md §3.6`）。**验证锚点**：`npx @electron/asar list` 核对 asar `node_modules/` 内这些包齐全。

### 3.3 web 产物先构建，再打主进程包（两段式）

**结论**：打包流程是**两段式**——先 `vite build`（在 `web/` 内产出浏览器产物到约定目录），再 `electron-builder`（把主进程 + web 产物 + server/protocols 一起打）。两段顺序由 `scripts/build-dmg.sh` 或 `@app/electron` 的 build script 编排，**本文件只约定顺序契约，不实现脚本**。
**理由**：web 走 Vite 浏览器目标（ESM、tree-shake、code-split），与主进程 Node 目标完全不同；必须先产出 web 静态资源，再由主进程 `BrowserWindow.loadFile` 加载。混在 electron-builder 一步里做不到（builder 不懂 Vite）。
**反例**：若用 electron-builder 一步打、不先 vite build，则产物里没有渲染层资源，应用起来白屏。

### 3.4 产物目录统一 `${BUILD_OUT_DIR}`，默认 `release/`

**结论**：所有打包产物（dmg/exe + 未打包的 `mac/`/`win/` 目录 + `builder-debug.yml`）统一落在 `${BUILD_OUT_DIR}`（缺省 `release/`，可由 `prod.env` 覆盖），**不散落仓库根**。
**理由**：集中一处便于 `.gitignore`（`release/` 一行）、便于 CI 收集 artifacts、便于清理；`prod.env` 的 `BUILD_OUT_DIR` 允许 CI 指向工作区临时目录（见 `app/envs/[P0]environments.md` §3.4）。
**反例**：若产物散落在仓库根或各 workspace 下，则 `.gitignore` 要列一堆路径，CI 收集 artifacts 也要遍历多目录，且容易误提交大文件。

### 3.5 版本号取根 package.json，签名凭证走 prod.env，均不进 yml

**结论**：产物版本号的**唯一权威源 = 根 `package.json` 的 `version`**；`build-dmg.sh` 用 `node -p` 读它，再经 electron-builder `--config.extraMetadata.version` 注入。签名身份（`CSC_LINK`/`APPLE_TEAM_ID` 等）由 `prod.env` 注入。二者都**不写进 `electron-builder.yml`**——yml 只放与机器/凭证/版本无关的结构性配置（appId/target/files 等）。
**理由**：版本号集中在根 `package.json` 一处（与 npm 元数据、发布 tag 同源），发版只改这一处、不再手填 prod.env，杜绝双源漂移。**必须显式 `--config.extraMetadata.version` 的原因**：`build-dmg.sh` 在 `app/electron` 子目录跑 electron-builder，builder 默认读**子包** `app/electron/package.json` 的 `version`（= `0.0.0` 占位），不读根包；不覆盖则产物版本永远是 `0.0.0`。签名凭证是机密，写进 yml 会随仓库泄密；环境注入让凭证只活在 `prod.env`（已 gitignore，见 `app/envs/[P0]environments.md` §4.3）。
**反例**：若不注入 `--config.extraMetadata.version`，electron-builder 取子包 `0.0.0` 占位 → 产物名 `rocky_agent-0.0.0-arm64.dmg` 版本错乱；若把版本号手填 prod.env，则根 `package.json` 与 prod.env 双源、发版时二者不同步就发错版本。

### 3.6 runtime-config.json：packaged 运行时环境注入（白名单非密钥键）

**结论**：build 期由 `build-dmg.sh` 从 `prod.env` 抽**白名单非密钥键**生成 `app/electron/runtime-config.json`，经 `electron-builder.yml` 的 `files` 打进 asar；packaged 应用启动最早期由 `main.ts` → `loadRuntimeConfig()` 读入并**回填 `process.env`（不覆盖已有键）**，然后才 `startBackend`。
**理由（修的真 bug）**：`build-dmg.sh` 的 `source prod.env` 只作用于 build 期。packaged 应用被用户**双击启动时进程环境是干净的**（不继承任何 shell env），`process.env` 里没有 `API_PORT`——`backend-bootstrap.resolveServerOpts()` 读不到 `API_PORT` 即抛错，后端起不来、前端白屏。故必须把运行期需要的键随包带上、启动时注入回 `process.env`。
- **零密钥白名单（安全红线，两端过滤防御纵深）**：只放 6 个非敏感运行时键 —— `API_PORT` / `DATA_DIR` / `APP_NAME` / `APP_ENV` / `LOG_LEVEL` / `HEALTH_ENDPOINT`。LLM key / langfuse / `APPLE_*` / `CSC_*` **绝不进包**（用户在 app 内配置、落 `DATA_DIR`，不经 env）。白名单**生成端**（`build-dmg.sh` 只抽这 6 键）与**读取端**（`runtime-config.ts` 的 `RUNTIME_CONFIG_WHITELIST` 只认这 6 键）**两端同源、各自过滤**——即便 config 文件意外混入密钥键，读取端也只注入白名单，绝不注入密钥。
- **不覆盖已有键**：`loadRuntimeConfig` 遇 `process.env` 已有该键（dev 模式 / 外部显式注入）则保留原值，config 不覆盖——保证 dev 与外部注入优先，runtime-config 只补缺。
- **DATA_DIR 可移植（存字面 `~/`，运行时展开）**：`source prod.env` 时 bash 会把 `~/.rocky_agent_prod` 展开成 **build 机**的绝对 home（`/Users/<builder>/…`），直接写进 config 会在分发到别的用户/机器时指向错目录。故 `build-dmg.sh` 对 `DATA_DIR` 做 `$HOME` 前缀→字面 `~` 还原，config 里存字面 `~/.rocky_agent_prod`，由 server config 层 `expandTilde` 按**运行用户** home 展开（可移植 + 保留可配置性）。其他白名单键原样注入。
- **容错静默**：dev 模式无此 build 产物，`loadRuntimeConfig` 文件不存在直接返回空、不抛错、不阻塞 Electron 启动（后端缺 `API_PORT` 会在 backend-bootstrap 层单独报错）。

代码路径：`scripts/build-dmg.sh`（node 生成 runtime-config.json）→ `app/electron/electron-builder.yml` files 打进 asar → `app/electron/src/main.ts`（IIFE 最早期）→ `runtime-config.ts loadRuntimeConfig()` → `backend-bootstrap.startBackend()`。

**反例**：若不注入 runtime-config，packaged app `process.env` 无 `API_PORT` → `resolveServerOpts` 抛错 → 后端不起、前端 fetch 全失败白屏；若把整份 `prod.env`（含密钥）打进包，则用户在 app 里配的 LLM key 之外还夹带了 build 者的凭证，泄密且违背"密钥不进包"红线。

### 3.7 内置 plugin 编译步：build 期 bun build → asar `node_modules/@app/plugins`

**结论**：`app/plugins/builtins/` 的 `.ts` 实现 Node 主进程跑不了，故 build 期新增一步 `scripts/build-plugins.ts`（bun）把每个 impl **bun build 成自包含 `.cjs`**（server import 外置成 `@app/server/dist/X`）+ 拷贝资源（`plugin.json`/`scopes/*.yaml`/`groups.json`/`skills/**`/`session-types/*.yaml` v0.0.204+）→ `app/plugins/dist/`；`electron-builder.yml` 的 `files` 用 `{from: ../plugins/dist, to: node_modules/@app/plugins}` 映射进 asar。放 `node_modules/@app/plugins` 让 server 侧既有 `../../plugins` 路径解析零改动（server→plugins 偏移 dev/packaged 一致）。
**理由（修的真 bug BUG-003）**：历史打包整个 `app/plugins/` 不进 asar——`ScopeConfigLoader.loadAll` 读不到 `scopes/` 硬 throw（yaml 依赖修好后的下一个崩点，已真机实证）+ `BuiltinLoader` 加载 0 插件（无 LLM provider = 空壳）。编译架构（编译产物形态 / server 外置 / loader 双模式 / asar 内动态加载可行性实证）归 `plugin_system/[P0]packaged_plugin_loading.md`；本文件只约定它是 build 管线的一步 + 打包映射归属。
**反例**：若把 `.ts` 源码直接打进包，Node 主进程 `import('file://x.ts')` → `ERR_UNKNOWN_FILE_EXTENSION` 崩；若 tsc 镜像编译不改写 server import，packaged 里 `../../../server/src/X` 解析到不存在的 `node_modules/@app/server/src` → `MODULE_NOT_FOUND`。

### 3.8 编译期资源镜像：非 `.ts` 运行时资源必须显式 cp 进 `dist`（第五类打包陷阱，v0.0.153 BUG-001 教训）

**结论**：`app/server` 的 `tsc -b` **只编译 `.ts` → `.js`，从不复制任何非 `.ts` 文件**。任何被运行时代码读取的非 `.ts` 资源（`.md` 正文模板 / `.yaml` 迁移脚本 / 未来可能的 `.json`/`.txt` 等）必须在 `app/server/package.json` 的 `build` 脚本里**显式 `cp`** 进 `dist/` 对应路径，并在 build 收尾跑 `scripts/check-server-build-assets.sh` 做 **src→dist 镜像比对**（递归 `find` 枚举 src 侧文件、逐个核对 dist 侧同相对路径文件存在，缺失即非 0 退出并指名具体文件，整个 `bun run build` 失败）。
**理由（修的真 bug BUG-001）**：`prompt-handler.ts` 的 `CONTENT_DIR = path.join(__dirname, 'content')` 在 dev 下 `__dirname` 落在 `src/prompts/`（Bun 直跑 `.ts`）能读到 `src/prompts/content/*.md`；packaged 跑 `dist/prompts/index.js`，`__dirname` 落在 `dist/prompts/`，而 build 脚本从未把 `.md` 复制进 `dist/prompts/content/`——目录不存在，`readContent()` 按 §3.3 降级策略静默返回空串，system prompt 全空。dev AT/ET 全绿（直接读 src），packaged 才炸——与 BUG-002（依赖归属）、BUG-003（plugin 编译）、BUG-004（路径展开）同属「dev 能跑 ≠ packaged 能跑」的第五类独立成因：**不是依赖收集问题、不是路径解析问题，是编译步骤本身遗漏了资源复制**。`migration/handlers/*.yaml` 早有同款 cp 先例（本就正确），本次是 prompts content 漏做了同样的事。
**为什么用「镜像比对」而非硬编码文件清单**：`check_mirror()` 递归枚举 src 侧实际文件去核对 dist，不维护一份「应该有哪些文件」的静态清单——新增 `.md`/`.yaml` 资源自动纳入校验，不会出现「加了新文件却忘记同步校验脚本」的次生遗漏。运行期兜底见 `checkPromptContentAssets()`（`../../agent/context/[P0]prompt_content_files.md §3.4`）——build 期镜像校验是第一道防线（缺失直接 build fail，不留到运行期才发现），运行期自检是第二道兜底（万一 build 步骤被绕过，至少启动时 log 报警而非静默降级）。
**反例**：若只加 `cp` 不加镜像校验，未来新增 content 文件时 cp 的 glob（如 `cp -r src/prompts/content dist/prompts/`，整目录已覆盖新文件——但若某处误写成逐文件 cp 或窄化 glob）遗漏，build 仍然"成功"，只有运行时才会静默降级暴露，重蹈 BUG-001。

### 3.9 packaged nofile 抬升 + native dep Electron ABI rebuild（bash spawn EBADF 救急）

**结论（nofile 抬升）**：packaged `.app` 由 LaunchServices 启动（不经 shell），继承的 `nofile` soft 通常=256（macOS 默认）；app 启动期基线 fd（加载 server/protocols/plugins/web 资源 + 各 store 句柄）已逼近上限，"重启后第一次 bash spawn 就坏"是基线高分支（与 session 内 fd 累积泄漏分支独立）。dev 终端 `ulimit -n=1048576` 余量充足测不到。`app/electron/src/raise-nofile.ts` 的 `raiseNofileLimit(targetSoft=4096)` 在 electron main（`main.ts` 时序：`loadRuntimeConfig` → `raiseNofileLimit` → `startBackend`）用 native `posix` 包调 POSIX `setrlimit(2)` 抬 soft 到 `max(currentSoft, 4096)`，**hard 不动**（防超 `kern.maxfilesperproc=92160` 触发系统级问题）。bash 工具 spawn 跑在主进程（packaged `require('@app/server')` → node:http in 主进程），故必须改主进程 rlimit（非子进程 / 非 ulimit）。
**理由（为何用 native binding）**：Node 标准无 setrlimit API（`process.setrlimit` 实测不可用，v22.22.0/Bun 1.3.14 均 `not a function`）；`process.binding('os')` 无 setrlimit；`ulimit -n 4096` 在子 shell 生效但**不影响父进程**，且 .app 双击不经 shell，改 `.app/Contents/MacOS` 入口破坏代码签名——唯一可行 = native binding 调 `setrlimit(2)`（主选 `posix` npm 包，退路自写 minimal N-API addon）。
**容错红线（不阻塞启动）**：`loadPosixBinding()` 动态 `require('posix')` try/catch 返 undefined（posix 缺失 = dev 未装 / packaged rebuild 失败）→ 静默返 `{raised:false, newSoft:-1}`；`getrlimit/setrlimit` 抛错 → `console.warn` 不抛；`soft=RLIM_INFINITY` 时无需 raise。dev ulimit 已 1048576，取 max 无副作用（raise 语义只升不降）。
**反例**：若不抬 nofile，packaged 启动期基线 fd 逼近 256 → 第一次 bash spawn 即 EMFILE/EBADF，且 `child.on('error')` 吞 errno（bash tool 返 exitCode=1 无 errno 文本）→ 诊断盲区。raise-nofile 给基线余量救急"第一次就坏"，与 session 内 fd 累积泄漏修复（bash 工具 `reclaimStreams`，见 `../../agent/tools/[P0]bash_tools.md §4.6`）互补。

**结论（native dep Electron ABI rebuild）**：`app/electron/package.json` 声明的 native npm dep（如 `posix`，主进程 require）在 `bun install` 时默认装 **Node ABI** prebuild，packaged Electron 需 **Electron ABI** → `scripts/build-dmg.sh` 必须对该 dep 跑一次 rebuild。与 §3.7 plugin 编译、better-sqlite3/computer-native native 模块 rebuild 同属"dev 装 Node ABI、packaged 要 Electron ABI"的 ABI 桥接步。
**主路径 = node-gyp direct（非 `@electron/rebuild`/`npx`）**：从 `<pkg>/node_modules/<native-pkg>` 解析本地 `node-gyp/bin/node-gyp.js`，`node-gyp rebuild --target=<electron-version> --dist-url=<electron headers url> --runtime=electron`。**不走 `npx @electron/rebuild` 的原因**：npx 命中陈旧 node-abi cache，node-abi 版本滞后时不认新 Electron ABI（electron 42.4.1 实证必败阻塞 dmg）；node-gyp direct 走 `--dist-url` 直拉 Electron headers 绕过 node-abi ABI 探测，复用本地 node-gyp。
**硬依赖 vs 未激活 fallback（失败处理对照）**：
- `posix`（raise-nofile 用）= packaged 主进程**运行时硬依赖**（无替代品）→ rebuild 失败 / `.node` 缺失 → **exit 1** 阻断 dmg build。
- `better-sqlite3` = 未激活 fallback（packaged sqlite default=`node:sqlite` Node 22+ 内置全覆盖含 FTS5，better-sqlite3 永不 require）→ rebuild 失败 → **warn+skip**（`②c`，见 memory `node-sqlite-packaged-covers-better-sqlite3-redundant`）。
- 故 `②c`（better-sqlite3）与 `②d`（posix）形态同（node-gyp direct Electron ABI rebuild）但失败语义异：硬依赖 exit 1 / 未激活 warn+skip。
**反例**：若走 `npx @electron/rebuild`，node-abi 不认 electron 42 ABI → rebuild 必败；若 posix rebuild 失败仍 warn+skip（误抄 ②c 语义），packaged 主进程 `require('posix')` 崩 → bash nofile 抬升失效 → "第一次 bash 就坏"未救急。

## 4. 示例

### 4.1 `app/electron/electron-builder.yml`（精简，关键字段不省略）

```yaml
appId: com.rockyagent.app
productName: ${APP_NAME}        # 来自 prod.env
directories:
  output: ${BUILD_OUT_DIR}      # 缺省 release/
  buildResources: buildResources
files:
  - dist/**/*                   # 主进程编译产物（含 main.js / preload.js）
  - web-dist/**/*               # web 构建产物（vite build outDir = app/electron/web-dist）
  - runtime-config.json         # build 期从 prod.env 白名单键生成，运行时回填 process.env（见 §3.6）
  - node_modules/@app/server/**/*   # workspace dep：业务逻辑
  - node_modules/@app/protocols/**/*  # workspace dep：契约
  - from: ../plugins/dist       # 内置 plugin 编译产物（.cjs bundle + scopes/groups.json/skills）
    to: node_modules/@app/plugins   # 放此让 server 侧 ../../plugins 路径解析零改动（见 §3.7）
  - package.json
asar: true
mac:
  target: dmg
  category: public.app-category.productivity
  # 签名/公证字段由 prod.env 注入，不在此硬编码
win:
  target: nsis
dmg:
  contents:
    - { x: 130, y: 220 }
    - { x: 410, y: 220, type: link, path: /Applications }
```

> `${APP_NAME}` / `${BUILD_OUT_DIR}` 由 `scripts/build-dmg.sh` source `prod.env` 后注入到 builder 进程环境；签名相关键（`CSC_LINK` / `APPLE_TEAM_ID` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`）electron-builder 默认从环境变量读，无需在 yml 列。**版本号**不在 yml、也不在 prod.env——由 `build-dmg.sh` 读根 `package.json` 的 `version` 经 `--config.extraMetadata.version` 注入（覆盖子包 `0.0.0` 占位，见 §3.5）。
>
> **`electron` 依赖位置（落地修正）**：`electron` 与 `electron-builder` **必须放 `app/electron/package.json` 的 `devDependencies`**，不能放 `dependencies`。
> - **理由**：electron-builder v26 在打包时强制校验 `electron` 在 devDeps，放 deps 会直接报错退出（"electron must be in devDependencies"）。
> - **运行时来源**：打包产物的 `.app` 包内自带 Electron runtime（由 electron-builder 注入），不入 asar、不算运行期 prod 依赖；故 `electron` 不需要在 `dependencies`。
> - **反例**：若把 `electron` 放 `dependencies`，则 electron-builder v26 拒绝打包、构建直接失败。
> - 详见 `package_structure.md` §4.2 的 `app/electron/package.json` 示例（已同步修正）。

### 4.2 打包流程示意（顺序契约）

```
① scripts/build-dmg.sh source prod.env + 读根 package.json version（校验非 0.0.0）
   + 生成 app/electron/runtime-config.json（白名单非密钥键，见 §3.6）
②a 编译 @app/server TS（tsc -b → app/server/dist，CJS，供 Electron require + plugin 外置 @app/server/dist/X）
②b 编译内置 plugin（scripts/build-plugins.ts：bun build 每 impl → app/plugins/dist/**/*.cjs + 拷贝资源，见 §3.7）
   + native 模块 Electron ABI 预编译（macOS only）：
     · computer-native（Swift dylib → node-gyp Electron ABI → .node）
     · better-sqlite3（node-gyp direct，warn+skip 语义——packaged default=node:sqlite 全覆盖）
     · posix（node-gyp direct，**exit 1** 语义——packaged 主进程 raise-nofile 硬依赖，见 §3.9）
③ vite build（在 app/web/，产物 → app/electron/web-dist）
④ 编译主进程 TS（app/electron/src → app/electron/dist，含 raise-nofile.ts）
⑤ electron-builder（读 electron-builder.yml + files 映射 app/plugins/dist → node_modules/@app/plugins
   + --config.extraMetadata.version=<根版本> + 环境变量）
   ▼
   产物：${BUILD_OUT_DIR}/rocky_agent-<version>-arm64.dmg（mac）/ *.exe（win）
```

> 各步的**实际编排命令**归 `scripts/build-dmg.sh`；本文件只约定"读版本/生成 runtime-config → 先 web 后 main 再 builder"的顺序契约。

### 4.3 打包改动自检清单（防复发，v0.0.153 打包链审计产出）

改以下四类内容时，按对应清单自检（对应 CLAUDE.md「持续可打包护栏」BUG-001~004 + 本文 §3.8 第五类陷阱，按"新增什么"重新组织为可操作检查项）：

**场景 A：新增 `.ts` 源码**（server/electron/plugins）
- 有伴随子进程/外部可执行吗？packaged 下无 `node`/`npx`/brew（PATH 极简）——spawn 目标须是 `process.execPath`(+`ELECTRON_RUN_AS_NODE`)、系统绝对路径或用户配置路径；脚本在 asar 内时外部进程读不到（需 asarUnpack 或进程内执行）。
- 有 `__dirname` 相对回溯吗？逐条演算 packaged 路径（`asar/node_modules/@app/server/dist/...`）与 dev（`app/server/src/...`）是否同偏移；范本见 `migration/app-version.ts` 头注释。
- 有 `process.cwd()` / 相对路径 fs / 字面 `~` 吗？packaged cwd=`/`；一律 `__dirname` 或 `config.resolveDataDir` 派生绝对路径（BUG-004，见 `[P0]package_structure.md §4.3`）。
- 有新增 `getConfig()` 调用点吗？`WEB_PORT` 等非白名单必填键未修前，进运行时路径即崩（潜伏雷，见 index.md）。

**场景 B：新增资源文件**（非 `.ts`：`.md`/`.yaml`/`.json`/`.cjs`/模板…）
- 运行时被代码读吗？被读则**必须进 `dist`**：`app/server` build 脚本补 `cp`（§3.8 先例）+ `check-server-build-assets.sh` 自动纳入镜像校验；读取代码**禁止静默降级空串掩盖整类缺失**（应有运行期自检兜底，如 `checkPromptContentAssets()`）。
- plugin 资源？新增类型要进 `scripts/build-plugins.ts` `copyResources()` + `verifyProducts()` 校验清单（§3.7）。
- web 资源？必须走 vite import（JSON import / `?raw` / asset import），运行时 fetch 相对路径在 `file://` 下不可用。
- 生成型资源（如 `browser-worker.cjs`/`app-version.json`）？生成命令必须挂进 `build-dmg.sh` 时序（`gen-version` 是正例）。

**场景 C：新增依赖**
- packaged 后端用吗？用 → 声明进**使用方 workspace** 的 `package.json`（`app/server` 等），绝不能只在根（BUG-002，§3.2）。
- plugin 引入的新三方包 → `scripts/build-plugins.ts` `EXTERNALS` 做 external（须同时在 server deps）/ inline 决策。
- workspace 包被 value import（非纯类型）？确认其 `main` 指向**编译产物**且 build 时序覆盖（`@app/protocols` 现只被 type-only import，首个 value import 落地即 `ERR_UNKNOWN_FILE_EXTENSION` 崩，见 index.md 潜伏雷）。
- 依赖带外部二进制/浏览器下载（如 playwright）？`postinstall` 只在开发机跑，用户机没有——packaged 路径要么不依赖、要么运行时引导。
- **native npm dep（含 N-API / node-gyp 构建）**？packaged Electron 需 Electron ABI（bun install 装 Node ABI）→ `build-dmg.sh` 加一段 node-gyp direct rebuild（`--target=<electron-ver> --dist-url=<headers> --runtime=electron`，**禁走 `npx @electron/rebuild`**——node-abi cache 陈旧不认新 Electron ABI 必败，见 §3.9）；按 dep 性质定失败语义：**硬依赖 exit 1**（无替代品，如 posix）/ **未激活 fallback warn+skip**（有 default 路径，如 better-sqlite3 被 node:sqlite 全覆盖）。N-API dep（纯 syscall 桥）rebuild 可成功，非 N-API dep（V8 ABI 深耦合，如 better-sqlite3@11）Electron 42 V8 ABI rebuild 必失败。
- 打包后验证锚点：`npx @electron/asar list <app.asar> | grep <包名>`；native dep 额外核对 `<pkg>/build/Release/<name>.node` 存在。

**场景 D：新增运行时 env 键**
- packaged 必需？→ 同时进 `scripts/build-dmg.sh` 白名单数组 + `app/electron/src/runtime-config.ts` `RUNTIME_CONFIG_WHITELIST`（两端同源，§3.6）+ `prod.env`。
- 是密钥？→ **绝不进白名单**；走 app 内配置落 `DATA_DIR`。
- 只在 dev/test 用？→ 代码里给缺省值或 test 门，确认 packaged 下 `undefined` 语义正确（`NODE_ENV` packaged 恒为 `undefined`，勿用 `!== 'production'` 当 prod 门）。

**每次打包相关改动后的验证锚点**：解 asar 起真后端 curl（`states/v0.0.108/verify` 复现法）；核对新增资源确实进了 `dist`/`asar`；**dev AT/ET 全绿 ≠ packaged 可用**（v0.0.153 BUG-001 再次实证——本节四场景清单即为防止同类事故重演）。

## 5. 边界

| 零件 | 归属 |
|------|------|
| electron-builder 选型、dmg/exe 产物形态、asar 处理、builder 配置字段归属、产物目录约定、runtime-config.json 注入机制（§3.6）、版本号注入机制（§3.5）、plugin 编译步作为 build 管线一步 + asar 映射（§3.7）、`app/server` 编译期资源镜像（`.md`/`.yaml` 等非 `.ts` 资源 cp + 校验，§3.8） | 本文件 ✅ |
| 内置 plugin 编译产物形态 / server 外置 / loader 双模式 / asar 动态加载可行性 | `../../plugin_system/[P0]packaged_plugin_loading.md` |
| `build-dmg.sh` 的脚本契约（用途/source/前置/退出码） | `app/envs/[P0]scripts.md` §3.3 |
| `prod.env` 的 schema（白名单键 / 签名键 / BUILD_OUT_DIR） | `app/envs/[P0]environments.md` §3.4 |
| 版本号唯一权威源 = 根 `package.json` version（打包读取契约） | `app/envs/[P0]scripts.md` §3.3 + 项目 CLAUDE.md「版本号权威源」 |
| 5 个 workspace 的职责与边界 | `[P0]package_structure.md` |
| Bun / vitest / vite / tsconfig 工具链 | `[P0]tool_chain.md` |
| 跨模块零件通用归属规则 | [docs_guide.md](../../docs_guide.md) §4 |
