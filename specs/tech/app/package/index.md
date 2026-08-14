---
type: index
title: Package 子系统总起（物理包结构与工具链）
priority: P0
updated: 2026-08-04
---

# Package 子系统总起（物理包结构与工具链）

## ① 是什么

package = **`app/` 物理布局 + 跨 workspace 工具链契约**——回答「5 个 workspace 包各自干什么、依赖怎么走、用什么打包、用什么跑测试」。本 KB 锁定 Bun workspaces 组织、electron-builder 打包、Bun+vitest+tsconfig 工具链；不管业务逻辑（在 `agent/` 与 `app/server/`）、不管渲染层选型（在 `../frontend/`）。

| 核心概念 | 一句话 |
|---|---|
| **5 workspace 包** | `electron/`（壳）+ `web/`（渲染）+ `server/`（业务）+ `protocols/`（契约）+ `shared/`（兜底，默认不开） |
| **Bun workspaces** | 包间通过 `package.json` 的 `dependencies` 显式声明，靠编译器强制依赖边界（非靠人守） |
| **进程边界** | 主进程（electron+server，Node）/ 渲染进程（web，浏览器沙箱）；唯一通道是 preload IPC 桥 |
| **server 零 electron** | server 不 `import electron`，原生能力靠接口注入；可独立单测、未来可拆库 |
| **electron-builder** | 跨平台打包工具，mac 出 dmg、win 出 nsis exe；workspaces 下 asar 显式列 server/protocols/web 产物；版本号取根 `package.json` version 经 `--config.extraMetadata.version` 注入 |
| **runtime-config 注入** | build 期从 prod.env 抽 6 键非密钥白名单生成 `runtime-config.json` 打进 asar；packaged `main.ts` 启动最早期回填 `process.env`（后端才拿到 `API_PORT`），密钥绝不进包 |
| **vitest 跨包全量** | 一份 `vitest.config.ts` 放仓库根，跨所有 workspace 跑全量 UT |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| 5 个 workspace 职责 + 依赖关系 + 进程边界 + electron 内部契约（main/preload/IPC）归属 | web/ 渲染层选型 + 设计 token（→ `../frontend/`） |
| Bun workspaces 配置 + 跨进程类型唯一源（protocols） | IPC channel schema/DTO 的业务字段（→ `app/protocols/` 内容） |
| electron-builder 选型 + asar + dmg/exe 产物 + builder 配置字段归属 | `scripts/build-dmg.sh` 脚本契约（→ `../envs/[P0]scripts.md` §3.3） |
| Bun/vitest 选型 + `bun run test` vs `bun test` 红线 + 配置归属 + 多目标测试 | 三脚本契约（→ `../envs/[P0]scripts.md`）、三环境 `.env`（→ `../envs/[P0]environments.md`） |
| tsconfig 多目标（根 base + 各包 extends） | agent/session 业务接口（→ `agent/` 各模块） |

## ③ 与系统的关系

```
   ┌── Electron 主进程（Node runtime）────────────────────────┐
   │  @app/electron ──装配──→ @app/server ──依赖──→ @app/protocols
   │  （起窗口 + IPC 收发 +  ←─IPC─→   业务大脑，零 electron   共享类型源
   │   注入原生能力实现）                                      │
   └─────────────────────────────┬──────────────────────────┘
                                 │ preload contextBridge（运行时唯一通道）
   ┌── Electron 渲染进程（浏览器沙箱）─┴──────────────────────┐
   │  @app/web ──依赖──→ @app/protocols（编译期共享类型）       │
   │  （UI 组件 + 状态；禁止 require Node）                     │
   └──────────────────────────────────────────────────────────┘
   打包：scripts/build-dmg.sh → electron-builder（消费 web 产物 + server dist + protocols）
```

**对外协作点**：5 个 `package.json` + 根 `package.json`（workspaces + scripts.test）；`tsconfig.base.json` + 各包 `tsconfig.json`；`vitest.config.ts`（仓库根）；`vite.config.ts`（`app/web/`）；`electron-builder.yml`（`app/electron/`）。

## ④ 核心设计原则（跨文件不变量）

1. **用 Bun workspaces，靠编译器守边界**——web 误 `import electron` 编译期即失败；server 去 electron 化由不声明 `electron` 依赖强制。→ `package_structure.md §3.1`
2. **web 与 electron 必须分离**——构建目标（Vite/browser vs electron-builder/Node）+ 运行时安全模型（沙箱 vs 主进程）不同；合并会污染。→ `package_structure.md §3.2`
3. **server 零 electron，原生能力靠注入**——server 是「纯业务大脑」，单测可纯 Node 跑、未来可拆独立 CLI；`bun:sqlite` 是隔离在 persistence 的 runtime 假设（不算 electron 依赖）。→ `package_structure.md §3.3`
4. **protocols 是唯一跨进程类型源**——IPC schema + DTO 集中定义，两端逐字一致；不含运行时业务逻辑。→ `package_structure.md §3.4`
5. **electron 必须放 devDependencies**——electron-builder v26 强制校验；运行时 Electron 由 `.app` 包提供、不入 asar。→ `packaging_toolchain.md §4.1` + `package_structure.md §4.2`
6. **`bun run test` 唯一合规 UT 入口**——`scripts.test` = `bun --bun x vitest run`（强制 bun runtime 因 `bun:sqlite`）；`bun test`/`npm test` 都禁止。→ `tool_chain.md §3.2`
7. **vitest 单份根配置跨所有 workspace**——UT 核心价值是「全量回归」；单份根配置 + 全仓 include 天然实现。→ `tool_chain.md §3.1`
8. **版本号唯一权威源 = 根 `package.json` 的 `version`**——打包读它经 `--config.extraMetadata.version` 注入（builder 在 `app/electron` 子目录跑默认读子包 `0.0.0` 占位，必须覆盖）；不在 prod.env 手填、不在 yml 硬编码。→ `packaging_toolchain.md §3.5`
9. **runtime-config 零密钥白名单注入**——packaged 运行时 `process.env` 干净，须从 asar 内 `runtime-config.json` 回填 `API_PORT` 等 6 非密钥键（不覆盖已有）；LLM/langfuse/签名 key 绝不进包，生成端 + 读取端两端过滤。→ `packaging_toolchain.md §3.6`
10. **内置 plugin build 期编译进包（v0.0.108）**——`app/plugins/builtins/` 的 `.ts` Node 跑不了，build 期 bun build 成自包含 `.cjs`（server 外置 `@app/server/dist/X`）+ 资源拷贝 → `app/plugins/dist`，electron-builder `files` 映射进 asar `node_modules/@app/plugins`（server→plugins 偏移 dev/packaged 一致 → 路径零改动）。→ `packaging_toolchain.md §3.7` + `../../plugin_system/[P0]packaged_plugin_loading.md`
11. **workspace 第三方运行时依赖声明在自己的 `package.json`（v0.0.108 BUG-002）**——electron-builder 只跟随 `@app/server` **自身声明**的 prod deps 打第三方包进 asar；server import 的 npm 包（`yaml`/`gray-matter`/`@modelcontextprotocol/sdk` 等）只在根 `package.json` 声明、靠 Bun hoist 让 dev 跑通 → packaged 启动 `Cannot find module` 崩。依赖归属跟着「谁 import」走。→ `package_structure.md §3.6` + `packaging_toolchain.md §3.2`
12. **packaged 启动桥 dataDir 单一展开权威（v0.0.108 BUG-004）**——`DATA_DIR` 存字面 `~/`（跨机可移植），`~` 展开是运行时唯一职责 `config.resolveDataDir`（`expandTilde` 按运行用户 home）；packaged 启动桥 `backend-bootstrap` 必须复用它、**禁止重复拼接字面 `~`**——否则 packaged cwd=`/` 下 `mkdirSync('/~/...')` EACCES → 全部 HTTP 500。→ `package_structure.md §4.3` + `../envs/[P0]environments.md §4.7`
13. **`tsc -b` 只编译不复制资源，非 `.ts` 运行时资源须显式镜像进 dist（v0.0.153 BUG-001，第五类打包陷阱）**——`app/server` 的 build 脚本对每类非 `.ts` 资源（`.md`/`.yaml` 等）必须显式 `cp` 进 `dist/` 并跑 `check-server-build-assets.sh` 做 src→dist 镜像比对（缺失即 build fail，不留到运行期才发现）；与 BUG-002/003/004 同属「dev 能跑 ≠ packaged 能跑」但成因独立（不是依赖/路径问题，是编译步骤本身漏了复制）。→ `packaging_toolchain.md §3.8` + `§4.3`（按新增内容类型的防复发自检清单）
14. **packaged nofile 抬升 + native dep Electron ABI rebuild 用 node-gyp direct（v0.0.236）**——两层 packaged 专属 fd 风险：(a) `.app` 由 LaunchServices 启动继承 nofile soft=256（dev 终端 1048576 测不到），启动期基线 fd 逼近上限致 spawn EBADF/EMFILE；electron main 用 native `posix` binding 调 `setrlimit(2)` 抬 soft 到 4096（hard 不动，容错不阻塞启动）救急。(b) `app/electron/package.json` 的 native dep（如 posix）需 Electron ABI rebuild——**主路径 node-gyp direct**（`--target=<ver> --dist-url=<headers> --runtime=electron`），**禁走 `npx @electron/rebuild`**（node-abi cache 陈旧不认新 Electron ABI 必败）；硬依赖 exit 1（无替代品）/ 未激活 fallback warn+skip（better-sqlite3 被 node:sqlite 全覆盖）二分语义。→ `packaging_toolchain.md §3.9` + `§4.3 场景 C`
15. **通用打开外部资源 IPC（v0.0.253）**——renderer 沙箱调系统浏览器 / 系统默认应用 / 读绝对路径文本文件须经 preload `window.rockyShell` 三 channel（`shell:openExternal` / `shell:openPath` / `shell:readFileText`）；范本 = `computer-permissions-ipc.ts`（纯 `compute*` + 注入 `ShellLike`/`FsLike` 可 UT）；**channel 名硬编码非 protocols**（对齐 v0.0.105 `computer:*` 范式，待 IPC 数量增长再统收 protocols）；路径解析单一权威在 main 侧 `computeResolveLocalPath`（strip `file://` + 展开 `~`，注入 home 可 UT）；workspace 相对路径仍走 HTTP `readWorkspaceFile`（`whitelistResolve` 不延伸到 chat 链接）；`setWindowOpenHandler` + `will-navigate` 两道兜底拦截所有 renderer 侧 navigate；runtime-config 白名单**不引入新 env 键**（channel 名非 env）。→ `package_structure.md §4.4`
16. **打包离线化（v0.0.342）**——electron-builder 默认链路两个固定联网点根治：update-notifier CLI 启动查 npm registry → `export NO_UPDATE_NOTIFIER=1`；unpack 必经 `@electron/get` 下载 electron zip（即便本地 dist 已存在、缓存 zip 仍每次下载 SHASUMS256.txt 校验）→ 显式 `--config.electronDist=<本地已解压 dist>` 走 custom unpacked copyDir 分支完全跳过下载/校验；dist 缺失时 electron `install.js` 本地解压兜底（幂等，命中 `~/Library/Caches/electron` 缓存 zip 零联网；失败二次检查 exit 3 不静默）。断网/弱网可打包，前提 = 本地已有 dist 或缓存 zip。→ `packaging_toolchain.md §3.10`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| `[P0]package_structure.md` | 5 个 workspace 职责 + 依赖关系 + 进程边界 + electron 内部契约（main/preload/IPC）归属 + Bun workspaces 骨架 | P0 | [link]([P0]package_structure.md) |
| `[P0]packaging_toolchain.md` | electron-builder 选型 + asar 处理（workspaces 下显式列 server/protocols/web）+ 两段式打包（先 vite build 后 builder）+ 产物目录 + 配置字段归属 | P0 | [link]([P0]packaging_toolchain.md) |
| `[P0]tool_chain.md` | Bun + vitest 选型 + `bun run test` vs `bun test` 红线 + 配置文件归属表（vitest/vite/tsconfig/electron-builder）+ 多目标测试策略 | P0 | [link]([P0]tool_chain.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
