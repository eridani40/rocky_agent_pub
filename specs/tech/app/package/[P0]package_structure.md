---
type: spec
title: Package Structure（应用物理包结构）
priority: P0
status: active
updated: 2026-08-04
since: v0.0.1
related: [[P0]packaging_toolchain.md, [P0]tool_chain.md, ../envs/[P0]environments.md]
---

# Package Structure（应用物理包结构）

> 管什么：`app/` 物理布局、5 个 workspace 包的职责与边界、Bun workspaces 配置骨架、`shared/` 兜底规则、electron 内部契约（main/preload/IPC 收发）的归属。
> 不管什么：打包工具链选型（→ `[P0]packaging_toolchain.md`）、dev/测试工具链（→ `[P0]tool_chain.md`）、三环境语义与 `.env`（→ `app/envs/[P0]environments.md`）。
> 边界归属规则见 [docs_guide.md](../../docs_guide.md) §4。

## 1. 概述

`app/` 是应用编排层，把 agent / session 子系统组装成可运行的桌面应用。**代码层采用 Bun workspaces**：`app/` 下每个子目录是一个独立 workspace 包，包间通过 `package.json` 的 `dependencies` 显式声明依赖，**靠编译器强制依赖边界**而非靠人守。

```
app/
├── electron/     # 主进程入口 + preload + builder 配置；薄壳：起窗口 + 装配 server + IPC 收发
├── web/          # 渲染前端（React 19 + Tailwind + Zustand + Vite，浏览器目标，沙箱内运行；选型见 app/frontend/）
├── server/       # 后台 TS 业务逻辑：agent core 编排 + 服务；主进程内跑；零 electron 依赖
├── protocols/    # 跨进程契约：IPC schema / DTO / 类型
└── shared/       # 兜底：protocols 不收、但又确实跨进程的东西；按需开，不预设结构
```

一句话：**electron 装配、server 干活、web 展示、protocols 定契约、shared 兜底**。

## 2. 接口定义（workspace 契约）

### 2.1 各包职责表

| workspace | package name（约定） | 职责 | 构建目标 | 关键边界 |
|---|---|---|---|---|
| `electron/` | `@app/electron` | 主进程入口、preload、builder 配置；起窗口、装配 server、IPC 收发 | Node（electron-builder 出 dmg/exe） | 唯一允许 `import electron`；业务逻辑不在此实现 |
| `web/` | `@app/web` | 渲染前端 UI（React 19 + Tailwind + Zustand，→ `app/frontend/[P0]tech_stack.md`） | 浏览器（Vite） | 沙箱内运行，禁止 `require` Node；经 preload IPC 与主进程通信 |
| `server/` | `@app/server` | 后台业务逻辑：agent core 编排、session、服务接口 | Node（纯 TS） | **零 electron 依赖**；原生能力（文件/网络）通过注入接口获得 |
| `protocols/` | `@app/protocols` | 跨进程契约：IPC channel schema、DTO、共享 TypeScript 类型 | 无构建（纯类型 + 序列化） | 不含运行时业务逻辑，只导出类型与（必要的）校验器 |
| `shared/` | `@app/shared` | 兜底：跨进程但非契约的东西（如纯函数工具、跨端常量） | 跟随消费方 | 默认不开；新增内容需说明为何不归 protocols |

### 2.2 进程边界与依赖关系示意

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 主进程（Node runtime）                            │
│  ┌───────────────────────┐        ┌───────────────────────┐ │
│  │  @app/electron        │        │  @app/server          │ │
│  │  ─ 主进程入口 main.ts │ 装配 → │  ─ agent core 编排    │ │
│  │  ─ preload.ts         │        │  ─ session / 服务     │ │
│  │  ─ IPC 收发（ctxBridge）│ ←IPC→ │  ─ 零 electron 依赖   │ │
│  │  ─ builder 配置       │        │  （原生能力靠注入）   │ │
│  └──────────┬────────────┘        └──────────┬────────────┘ │
│             │                                │              │
│             │  依赖（类型/契约）              │              │
│             ▼                                ▼              │
│        ┌────────────────────────────────────────────┐       │
│        │  @app/protocols   IPC schema + DTO + 类型  │       │
│        └────────────────────────────────────────────┘       │
│                          ▲                                   │
│                          │  共享类型（contextBridge）        │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│  Electron 渲染进程（浏览器沙箱）                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  @app/web   渲染前端（Vite, browser target）           │  │
│  │  ─ UI 组件 / 状态                                      │  │
│  │  ─ 经 window.{api}（preload 暴露）调 IPC               │  │
│  │  ─ 禁止 require Node 模块                              │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**关键不变量**：
- 依赖箭头**单向**：`web → protocols`、`electron → server → protocols`；`protocols` 不依赖任何 app 包。
- `web` 与 `electron` 之间**没有直接 TS import**，唯一通道是 preload 暴露到 `window` 的 IPC 桥（运行时）+ `protocols` 共享类型（编译期）。
- `server` **不 import electron**——编译期由其 `package.json` 不声明 `electron` 依赖 + 单测在纯 Node 跑来强制。

### 2.3 跨模块零件归属

按 docs_guide §4 的"零件唯一归属"原则，`app/` 内易混淆的零件归属如下：

| 零件 | 归属 | 判定依据 |
|------|------|---------|
| Electron 主进程入口（`app.on('ready')`、`BrowserWindow`） | `electron/` | 跟着进程走 |
| Preload 脚本（`contextBridge.exposeInMainWorld`） | `electron/` | 是主进程注入渲染沙箱的桥，与 main 同生命周期 |
| IPC channel 名、payload schema、DTO 类型 | `protocols/` | 跨进程契约，唯一可在 web/electron 两端复用 |
| IPC 实际收发逻辑（`ipcMain.handle` / `ipcRenderer.invoke`） | `electron/`（主侧）/ `web/`（渲染侧调用） | 契约归 protocols，调用代码归各自进程 |
| Agent core 编排、session、服务接口 | `server/` | 业务逻辑，零 electron |
| 文件读写 / 网络请求等原生能力 | `server/`（消费）+ `electron/`（注入实现） | server 定义接口，electron 在装配时注入实现 |
| electron-builder.yml / 打包配置 | `electron/` | 跟着构建目标走（见 `[P0]packaging_toolchain.md`） |
| Vite 配置 | `web/` | 跟着构建目标走 |
| 前端渲染层技术选型（React/Tailwind/Zustand/TanStack Query）与设计 token | `app/frontend/`（`[P0]tech_stack.md` + `[P0]design_system.md`） | 渲染层独立关注点，单独成模块 |
| 纯函数工具、跨端常量（非契约） | `shared/`（默认不开） | 不归 protocols 的兜底 |

## 3. 设计决策

### 3.1 用 Bun workspaces，而非单 package

**结论**：`app/` 下 5 个子目录各为独立 workspace 包，根 `package.json` 用 `workspaces` 字段统一管理。
**理由**：workspaces 把"包级依赖边界"交给编译器强制——`web` 误 `import electron` 会因 `web/package.json` 无 `electron` 依赖而**直接编译失败**；`server` 的去 electron 化也通过不声明 `electron` 依赖被强制。在"靠人守边界"与"靠编译器守"之间选后者。代价是每个包多一份 `package.json`/`tsconfig`、electron-builder 打 workspace deps 进 asar 需处理（见 `[P0]packaging_toolchain.md` §3），但用一次性配置换取长期可维护性，且 server 可独立复用/未来拆库。
**反例**：若用单 package + 目录约定，则"web 不能 import electron"只能靠 ESLint 规则或人眼守；一旦疏忽，渲染进程引入主进程模块，构建期不报错、运行期崩，定位成本高。

### 3.2 web 与 electron 必须分离

**结论**：`web/` 与 `electron/` 是两个独立 workspace，不允许合并。
**理由**：两者构建目标不同（renderer 走 Vite/browser，main 走 electron-builder/Node）、运行时安全模型不同（renderer 沙箱不能 `require` Node，须经 preload IPC）、且 `web/` 可独立复用（未来若做纯 Web 端，复用渲染层）。合并会让一份配置兼顾两种目标，互相污染。
**反例**：若 web 与 electron 同包，则 `nodeIntegration`、`contextIsolation`、构建 target 三套开关混在一处，一处配错就引入安全漏洞或运行时崩溃。

### 3.3 server 零 electron 依赖，原生能力靠注入

**结论**：`server/` 的 `package.json` **不声明 `electron`**，业务逻辑中**不 `import electron`**；server 需要的文件/网络等原生能力，通过定义接口 + 由 `electron/` 装配时注入实现来获得。
**理由**：server 是"纯业务大脑"，必须能在纯 Node 下单测（→ `[P0]tool_chain.md` §3.3）、未来可拆成独立 CLI/服务复用。一旦耦合 electron，单测要拉起整个 electron runtime，慢且脆弱；复用也受限。
**反例**：若 server 直接 `import { app, BrowserWindow } from 'electron'`，则 server 的单测要么 mock 整个 electron（失真）、要么在 electron runtime 下跑（慢）；server 也无法被非 electron 宿主复用。

> **`bun:sqlite` 例外**：server 的实验性 persistence 子模块（`app/server/src/persistence/` SQLite engine）用 `bun:sqlite`（bun 运行时内置模块），这是 server 在「零 electron 依赖」之外的另一条 runtime 假设——**runtime 必须是 bun**（非 node/electron 主进程）。处理方式：
> - server 的 `tsconfig.json` `types` 仍为 `["node"]`（不变）——`bun:sqlite` 无 `@types` 包，server 自带本地 shim 类型声明 `app/server/src/persistence/bun-sqlite-shim.d.ts`（手写 `declare module 'bun:sqlite'` 接口），让 tsc 在 node types 下也能类型检查 sqlite engine 代码。
> - runtime 上 `bun:sqlite` 只在 bun runtime 可用；测试必须用 `bun --bun x vitest run`（见 `[P0]tool_chain.md` §2.2），packaged Electron 不消费 sqlite engine（实验性库，仅在 bun 环境跑；见 `specs/tech/persistence/[P0]sqlite_crud_store_engine.md`）。
> - 这不破坏「server 零 electron 依赖」——electron 与 bun:sqlite 是两个不同 runtime 假设，前者被禁止（装配耦合），后者被允许（仅 sqlite engine 子模块依赖、隔离在 persistence 内）。

### 3.4 protocols 是唯一跨进程类型源

**结论**：所有跨进程的 IPC channel schema、DTO、共享类型，统一归 `protocols/`，web/electron 都从 `@app/protocols` 导入。
**理由**：跨进程契约必须在两端**逐字一致**，集中定义才能保证；分散在两端各自定义会漂移。protocols 不含运行时业务逻辑（只类型 + 必要的校验器），可被任何进程安全引用。
**反例**：若 IPC 的 request/response 类型在 web 定义一份、electron 复制一份，则任一端改字段另一端不跟，运行期 payload 解析错位。

### 3.5 shared 默认不开，按需开

**结论**：`shared/` 默认不存在内容；只有当出现"跨进程、但确实不属于 protocols（如纯函数工具、跨端常量）"的东西时才开，且**每次新增需说明为何不归 protocols**。
**理由**：protocols 已覆盖大部分跨进程共享需求（类型/契约）；预设一个 shared 包会诱导开发者把"不知道放哪"的东西往里塞，最终变成大杂烩、边界模糊。按需开 + 强制说明，逼作者先想清楚归属。
**反例**：若一开始就把各种 util 塞进 shared，则 shared 逐渐膨胀成"什么都有"，跨进程边界被稀释，新人不知道某个函数该去哪找。

### 3.6 每个 workspace 的第三方运行时依赖，声明在自己的 `package.json`（不靠根 hoist）

**结论**：一个 workspace 运行时 `import` 的第三方 npm 包，**必须**在**该 workspace 自己的 `package.json`** 的 `dependencies` 显式声明——尤其 `@app/server`（它被 electron-builder 打进 asar）。不能只在根 `package.json` 声明、靠 Bun workspaces 的 hoist 让 dev 侥幸跑通。
**理由（BUG-002 真机实证）**：Bun 把依赖 hoist 到根 `node_modules`，dev 下任何 workspace 都能 `require` 到——**这掩盖了依赖归属缺失**。但 electron-builder 打包只跟随 `@app/server` **自身声明**的 prod deps 收集第三方包进 asar；仅根 hoist 的包**不进包**。故 server 运行时依赖（`yaml`/`gray-matter`/`@modelcontextprotocol/sdk`/`@mozilla/readability`/`adm-zip`/`chrome-devtools-mcp`/`linkedom`/`undici`/`@larksuiteoapi/node-sdk` 等）若只在根声明，packaged 启动即 `Cannot find module 'yaml'` 崩。依赖归属跟着「谁 import」走，与 §3.1「靠编译器守 workspace 边界」一脉相承。打包侧后果见 `[P0]packaging_toolchain.md §3.2`。
**反例**：若 server 依赖只在根 `package.json`，dev 靠 hoist 全绿、CI UT 全绿，唯独 packaged dmg 启动崩——问题只在打包产物暴露，最难定位。

## 4. 示例

### 4.1 根 `package.json` workspaces 字段

```json
{
  "name": "rocky-agent",
  "private": true,
  "workspaces": [
    "app/electron",
    "app/web",
    "app/server",
    "app/protocols",
    "app/shared"
  ],
  "scripts": {
    "test": "bun --bun x vitest run",
    "typecheck": "tsc -b"
  }
}
```

> `test` / `typecheck` 脚本与 CLAUDE.md「测试运行规范」一致；详细工具链见 `[P0]tool_chain.md`。

### 4.2 各包 `package.json` 依赖关系示意

```jsonc
// app/protocols/package.json —— 不依赖任何 app 包
{
  "name": "@app/protocols",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}

// app/server/package.json —— 依赖 protocols，不依赖 electron
{
  "name": "@app/server",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "dependencies": {
    "@app/protocols": "workspace:*"
    // 注意：此处不出现 "electron"
  }
}

// app/web/package.json —— 依赖 protocols，不依赖 electron
{
  "name": "@app/web",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "@app/protocols": "workspace:*"
  },
  "devDependencies": {
    "vite": "^8.0.0"
  }
}

// app/electron/package.json —— 装配者，依赖 server + protocols；唯一直接依赖 electron 的包
// 注：electron + electron-builder 都放 devDependencies（落地修正）：
//   electron-builder v26 强制 electron 在 devDeps，放 deps 直接报错退出；
//   运行时 Electron 由 .app 包提供、不入 asar，故 electron 不算运行期 prod 依赖。
{
  "name": "@app/electron",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/main.js",
  "dependencies": {
    "@app/server": "workspace:*",
    "@app/protocols": "workspace:*"
  },
  "devDependencies": {
    "electron": "^42.0.0",
    "electron-builder": "^26.0.0"
  }
}
```

### 4.3 electron 内部契约（main / preload / IPC 收发）归属

```
app/electron/src/
├── main.ts           # 主进程入口：app.on('ready') → 起窗口 → 装配 server → 注册 ipcMain.handle
├── preload.ts        # contextBridge.exposeInMainWorld('api', { ...channels })
├── ipc/              # ipcMain.handle 注册：把 channel → server 方法（薄转发，不写业务）
└── injection/        # 原生能力实现：实现 server 定义的 FsPort/NetPort 接口，注入 server
```

调用拼装（main 装配 server 时的零件来源，每件唯一）：

```typescript
// app/electron/src/main.ts（契约示意，非实现）
import { createAgentServer, type FsPort, type NetPort } from '@app/server';
import { IPC } from '@app/protocols';
import { NodeFsPort } from './injection/node-fs';
import { ElectronNetPort } from './injection/electron-net';

const fs: FsPort = new NodeFsPort();        // 原生实现：注入接口
const net: NetPort = new ElectronNetPort();
const server = createAgentServer({ fs, net });  // server 不知 electron，只知接口

// IPC 注册（channel 名与 schema 来自 protocols）
ipcMain.handle(IPC.session.list, (_e, args) => server.session.list(args));
// ... 其余 channel 同模式
```

> 契约（channel 名、payload schema、`FsPort`/`NetPort` 接口）归 `protocols/`；实现（`NodeFsPort`、`ElectronNetPort`）归 `electron/injection/`；业务方法归 `server/`。

> 实现注：mock 计数后端用 HTTP（非 IPC）。packaged 模式下 `app/electron/src/main.ts` 委托 `backend-bootstrap.startBackend(process.env)` 在主进程起 `node:http` 后端（`require('@app/server').startServer`，server 编译为 CommonJS 供 Node require）。**不涉及 `createAgentServer` / FsPort / NetPort / `injection/`**（后续接入原生能力时启用）。server 仍**零 electron 依赖**——不 `import electron`，只导出 `startServer` 给 electron 调用，`node:http` 不依赖任何 electron API。
>
> **packaged 启动桥 dataDir 必须展开 `~`，复用 `config.resolveDataDir` 单一权威（BUG-004 教训）**：`backend-bootstrap.resolveServerOpts` 传给 `startServer` 的 `dataDir` 必须是**绝对路径**（`StartServerOptions.dataDir` 契约）。**禁止在启动桥里重复拼接字面 `~/.{APP_NAME}_{APP_ENV}`**——packaged app cwd=`/`，字面 `~` 会让下游 `mkdirSync('/~/...')`（如 `plugin_scope` store 初始化）EACCES，每个 HTTP 请求 500。正解：动态 `require('@app/server/dist/config').resolveDataDir(env)`，复用 server 端唯一展开权威（`expandTilde` 按**运行用户** home 展开 `~` + 未设时回退派生同一权威），与 dev/CLI 入口（`index.ts getConfig().dataDir`）走同一逻辑。用**子路径** `@app/server/dist/config` 而非 `@app/server`，是因 `resolveDataDir` 未从 server index re-export（约束禁改 server index）。dataDir 展开责任完整语义见 `../envs/[P0]environments.md §4.7`。

### 4.4 通用打开外部资源 IPC

> renderer 沙箱调「系统浏览器 / 系统默认应用 / 读绝对路径文本文件」须经 preload 暴露的 `window.rockyShell` 三 channel。**范本 = `app/electron/src/computer-permissions-ipc.ts`**（顶层不 import electron，纯 `compute*` 函数注入 `ShellLike`/`FsLike` 依赖可 UT；electron 仅在 `register*` 内 require）。

三 channel（**channel 名硬编码，非 protocols**——对齐 v0.0.105 既有 `computer:*` 范式；待 IPC 数量增长再统收 protocols）：

| channel | payload | 返回 | 主进程实现 |
|---|---|---|---|
| `shell:openExternal` | `{ url: string }`（web scheme） | `Promise<{ ok: boolean; reason?: string }>` | `shell.openExternal(url)` → 系统默认浏览器 |
| `shell:openPath` | `{ path: string }`（**绝对路径**，main 已展开） | `Promise<{ ok: boolean; reason?: string }>` | `shell.openPath(absPath)` → 系统默认应用（不支持类型兜底） |
| `shell:readFileText` | `{ path: string }`（**绝对路径**） | `Promise<{ ok: boolean; content?: string; reason?: string }>` | `fs.readFile(absPath, 'utf8')` → 喂内置 viewer |

**不变量**：

1. **路径解析单一权威在 main 侧**：`computeResolveLocalPath(raw, home)` 纯函数（strip `file://` → 展开 `~`（`home` 注入可 UT）→ 验证绝对路径，相对路径拒绝并 reason 返回）。renderer 传 raw target 原样，main 侧展开（防 renderer 在 packaged cwd=`/` 下拼字面 `~` 撞 BUG-004）。**workspace 相对路径不走本通道**——继续走 HTTP `readWorkspaceFile`（既有 `whitelistResolve`），只有绝对路径 / `~` / `file://` 进 IPC。
2. **runtime-config 白名单不引入新 env 键**：channel 名硬编码（`shell:*`），非 env 注入（区别于 `API_PORT`/`DATA_DIR` 走 runtime-config.json）。
3. **defense-in-depth**：`main.ts` 装两道拦截兜底所有 renderer 侧 navigate：(a) `webContents.setWindowOpenHandler` 兜底所有 `target=_blank` / `window.open()` → 路由到 `shell:openExternal`，禁止开新 Electron 窗口；(b) `webContents.on('will-navigate')` 拦截 href 改动导航，仅允许同 origin dev server 跳转，其它一律 `preventDefault` + 转 `openExternal`。
4. **可测性**：`computeResolveLocalPath` / `computeOpenExternal` / `computeOpenPath` / `computeReadFileText` 全为纯函数 + 注入 `ShellLike`/`FsLike`/`home` 依赖，UT 无需 electron runtime（UT 范本 = `computer-permissions-ipc.test.ts`）。
5. **renderer 非 Electron 环境 guard**：dev 浏览器 / SSR 无 `window.rockyShell` → renderer 消费方 `typeof window !== 'undefined' && window.rockyShell` guard 后降级（「仅桌面 App 可用」，对齐 `rockyComputer`）。

**renderer 暴露**：`preload.ts` 经 `contextBridge.exposeInMainWorld('rockyShell', { openExternal, openPath, readFileText })`；类型镜像 `app/web/src/types/rocky-shell.d.ts`（web 不能 import electron，故 IPC 边界结果形状在 web 侧镜像——范本 `rocky-computer.d.ts`）。

## 5. 边界

| 零件 | 归属 |
|------|------|
| 5 个 workspace 的职责、依赖关系、进程边界、electron 内部契约归属 | 本文件 ✅ |
| web/ 渲染层技术选型（React/Tailwind/Zustand/TanStack Query）与设计 token（色彩/字体/圆角/组件词表） | `app/frontend/[P0]tech_stack.md` + `app/frontend/[P0]design_system.md` |
| 打包工具链（electron-builder 选型、asar 处理、产物目录） | `[P0]packaging_toolchain.md` |
| Bun / vitest / tsconfig 多目标、各配置文件归属 | `[P0]tool_chain.md` |
| 三环境语义、`.env` schema、`scripts/` 三脚本契约 | `app/envs/[P0]environments.md` + `app/envs/[P0]scripts.md` |
| Agent core / session / provider 等业务接口 | `agent/` 各模块 |
| 跨模块零件通用归属规则 | [docs_guide.md](../../docs_guide.md) §4 |
