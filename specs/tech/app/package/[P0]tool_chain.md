---
type: spec
title: Tool Chain（通用 dev / 测试工具链）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.1
related: [[P0]package_structure.md, ../envs/[P0]scripts.md, ../envs/[P0]environments.md]
---

# Tool Chain（通用 dev / 测试工具链）

> 管什么：Bun 与 vitest 选型、`bun run test` vs `bun test` 红线、各配置文件（vitest / vite / tsconfig）的归属、多目标测试策略。
> 不管什么：`scripts/unit-test.sh` 与 `scripts/run-dev.sh` 的脚本契约（→ `app/envs/[P0]scripts.md`）、各 workspace 内部业务实现。
> 边界归属规则见 [docs_guide.md](../../docs_guide.md) §4。

## 1. 概述

本项目运行时与包管理统一用 **Bun**；单测用 **vitest**（通过 `bun run test` 触发；`scripts.test` 为 `bun --bun x vitest run` 强制 bun runtime，见 §2.2）。各构建/测试配置**跟着它构建的东西走**：vitest 配置在仓库根（跨所有 workspace 跑全量 UT）、vite 配置在 `web/`、electron-builder 配置在 `electron/`、tsconfig 多目标（根 base + 各包 extends）。

```
仓库根
├── package.json         # workspaces + scripts.test = "bun --bun x vitest run"（见 §2.2）
├── vitest.config.ts     # 全量 UT 配置（跨所有 workspace）
├── tsconfig.base.json   # 共享 compilerOptions（严格 + ES2022 + bundler moduleResolution）
└── app/
    ├── web/vite.config.ts          # 浏览器目标构建
    ├── web/tsconfig.json           # extends ../../tsconfig.base.json，lib=DOM
    ├── electron/tsconfig.json      # extends base，lib=ES2022 + electron types
    ├── electron/electron-builder.yml   # 见 [P0]packaging_toolchain.md
    ├── server/tsconfig.json        # extends base，lib=ES2022，零 electron
    └── protocols/tsconfig.json     # extends base
```

## 2. 接口定义（配置契约）

### 2.1 配置文件归属表

| 配置文件 | 归属位置 | 作用域 | 归属理由 |
|---|---|---|---|
| `package.json`（含 `workspaces` + `scripts.test`） | 仓库根 | 全仓库 | workspaces 是仓库级声明；`scripts.test` 是 CLAUDE.md 测试规范的入口 |
| `vitest.config.ts` | 仓库根 | 全仓库 UT | 跨所有 workspace 跑全量 UT（见 §3.1） |
| `tsconfig.base.json` | 仓库根 | 全仓库 | 共享 compilerOptions，避免各包抄 |
| `tsconfig.json` | 各 workspace 内 | 单包 | extends base + 各自 lib/types |
| `vite.config.ts` | `app/web/` | web 渲染层 | 跟着构建目标走（浏览器） |
| `electron-builder.yml` | `app/electron/` | 主进程打包 | 跟着构建目标走（见 `[P0]packaging_toolchain.md`） |

### 2.2 命令契约

| 命令 | 含义 | 红线 |
|---|---|---|
| `bun run test` | 执行根 `package.json` 的 `scripts.test`，跑全量 UT | ✅ 唯一合规 UT 命令 |
| `npx vitest run path/to/x.test.ts` | 跑单个测试文件（仅当测试不依赖 bun:sqlite 等仅 bun runtime 可用的模块时） | ✅ 用于定向调试 |
| `bun test` | 调用 bun 内置测试器，**与 vitest 无关**，会扫 `refs/` 等无关目录 | ❌ 禁止 |
| `npm test` / `npm run test` | 本项目用 bun 不用 npm | ❌ 禁止 |
| `bun run typecheck` | 执行 `tsc -b`（项目引用 build 模式，类型检查 + 增量缓存） | ✅ 合规 |
| `bun install`（含 postinstall） | 装依赖 + 自动 `playwright install chromium` 拉浏览器二进制（browser tool mode ①② 用）；postinstall **非致命**（离线/受限环境失败只打 skip 提示，不阻断 install） | ✅ 首次必跑 |
| `bunx playwright install chromium` | 手动补装 chromium（postinstall 失败后或 CI 缓存预热） | ✅ 离线/受限环境手跑 |

> **`scripts.test` 实际值**：根 `package.json` 的 `scripts.test` = `bun --bun x vitest run`（**功能上仍是 `vitest run`**——vitest 入口、断言、配置全不变，只是 vitest 进程被 `bun --bun` 包了一层强制 bun runtime）。原因：persistence SQLite engine 用 `bun:sqlite`（仅 bun runtime 内置，无 `@types` 包、node runtime 不可用），必须强制在 bun runtime 下跑测试。该差异对开发者透明，`bun run test` 仍是唯一入口。package-boundaries 测试断言脚本匹配正则 `/vitest run$/`（容忍外层 runtime wrapper）。

> 与 CLAUDE.md「测试运行规范」章节一致；本文件是工具链选型说明，不重复规范细节。

### 2.3 多目标测试策略

| 目标 | 测试方式 | 工具 |
|---|---|---|
| `server/` | 纯 Node 单测 | vitest（node 环境） |
| `protocols/` | 纯 TS 类型/序列化单测 | vitest（node 环境） |
| `web/` | 组件/逻辑单测 | vitest + jsdom 或 happy-dom（如需要 DOM） |
| `electron/main` | 把逻辑抽到 `server/` 单测；main 壳本身尽量薄、少测 | 抽离后归 server 单测 |

## 3. 设计决策

### 3.1 vitest.config.ts 放仓库根，跨所有 workspace 跑全量 UT

**结论**：只有**一份** `vitest.config.ts`，放仓库根；其 `include` 覆盖所有 workspace 下的 `*.test.ts`，一条 `bun run test` 跑全量。
**理由**：UT 的核心价值之一是"全量回归"——改一处，全仓 UT 都跑一遍发现连带破坏。单份根配置 + 全仓 include 天然实现；若每个 workspace 各自 vitest 配置，则要写脚本串联跑多包，CI 要维护多入口、漏跑某包不会被发现。代价是配置略粗（无法 per-package 细粒度 override），但 vitest 支持 workspace 级 env override（用注释或 `// @vitest-environment jsdom`），足够覆盖 web 需要 DOM 的情况。
**反例**：若每包一份 vitest 配置各自跑，则开发者改 server 后容易忘了手跑 web 的 UT，web 的回归被漏；CI 也要维护 N 个测试入口。

### 3.2 红线：禁止 `bun test`、禁止 `npm test`

**结论**：UT 唯一入口是 `bun run test`（= `bun --bun x vitest run`，功能仍是 vitest run，见 §2.2）；`bun test`（bun 内置测试器）与 `npm test` 都禁止。
**理由**：`bun test` 是 bun 自带的测试 runner，**与 vitest 无关**，且默认会扫描全仓（含 `refs/` 等参考项目源码），误跑无关测试、产出不可信结果；本项目所有测试用例是为 vitest 写的（API、断言、mock 全不同），用 `bun test` 跑必然全错。`npm test` 走 npm runtime，与 bun 的依赖解析（workspaces、`workspace:*`）不一致，可能装错依赖。CLAUDE.md 已明文规定，本文件作为 spec 沉淀该决策。
**反例**：若允许 `bun test`，则新人误用后发现"测试全红/全绿都对不上 vitest"，定位半天才发现是跑错 runner；refs/ 下的无关测试也被扫进来，结果噪音。

### 3.3 server 纯 Node 单测，electron/main 逻辑抽到 server

**结论**：`server/` 是单测主力，在纯 Node 环境跑；`electron/main` 侧的业务逻辑尽量抽到 `server/` 单测，main 壳本身（起窗口、注册 IPC）保持极薄、少测。
**理由**：server 零 electron 依赖（见 `[P0]package_structure.md` §3.3），可在纯 Node 下秒级跑、无需拉 electron runtime；这给了 server 高覆盖率的可行性。electron main 壳拉起 electron runtime 慢、且大量是 electron API 调用（mock 成本高、收益低），与其测 main，不如把逻辑下沉到 server 测。这倒逼"main 薄壳"边界，与 §3.3 的 server 去 electron 化互相强化。
**反例**：若 main 壳里写大量业务逻辑并就地单测，则要么拉 electron runtime（慢）、要么 mock electron API（失真），且业务逻辑被锁死在主进程内无法复用。

### 3.4 tsconfig 多目标：根 base + 各包 extends

**结论**：仓库根一份 `tsconfig.base.json`（严格模式、`target: ES2022`、`moduleResolution: bundler`、`strict: true` 等），各 workspace 的 `tsconfig.json` extends base，按各自目标覆盖 `lib`/`types`（web 加 DOM、electron 加 electron types、server 只 ES2022）。
**理由**：compilerOptions 大头共享（严格性、target、moduleResolution），抄到每包既冗余又易漂移；各包差异只在 `lib`/`types`，extends 一行覆盖。`moduleResolution: bundler` 与 Bun/vite/electron-builder 的打包模型一致（不靠 tsc 解析模块、靠 bundler），避免 node10 的 legacy 陷阱。
**反例**：若每包独立写一份完整 tsconfig，则严格性配置漂移：server 不知何时被改成 `strict: false`，类型漏洞悄无声息进入。

### 3.5 配置跟着构建目标走，不放仓库根

**结论**：除 vitest（跨包全量）和 tsconfig.base 外，**其余构建配置放它构建的东西所在的 workspace**——vite 配置在 `web/`、electron-builder 配置在 `electron/`。
**理由**：每种配置只服务一种构建目标，与该目标的生命周期绑定；放该 workspace 内，删除/重命名该 workspace 时配置自然一起走，不留仓库根垃圾。vitest 是例外（要跨包全量），tsconfig.base 是共享基座，二者留在根。
**反例**：若把 vite.config 放仓库根，则某天 web 被独立成另一仓库，根 vite.config 成孤儿；构建目标和配置分家也增加心智负担。

## 4. 示例

### 4.1 根 `vitest.config.ts`（精简，关键字段不省略）

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['app/**/*.test.ts', 'app/**/*.test.tsx'],
    exclude: ['node_modules/**', 'refs/**', 'release/**'],
    environment: 'node',
    environmentMatchGlobs: [
      ['app/web/**/*.test.tsx', 'jsdom'],
      ['app/web/**/*.test.ts', 'jsdom'],
    ],
  },
});
```

> `refs/**` 显式排除，呼应 §3.2「禁止 `bun test`」中"bun test 会扫 refs/"的反例——即使误用 vitest 也确保不扫参考项目。
> `environmentMatchGlobs` 让 web 的 DOM 相关测试自动用 jsdom，server/protocols 保持 node 环境，无需 per-file 注释。

### 4.2 根 `tsconfig.base.json`（精简）

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "types": []
  }
}
```

### 4.3 各 workspace `tsconfig.json` extends 模式

```jsonc
// app/server/tsconfig.json —— 零 electron
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}

// app/web/tsconfig.json —— 加 DOM
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src/**/*"]
}

// app/electron/tsconfig.json —— 加 electron types
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["electron"]
  },
  "include": ["src/**/*"]
}
```

> server 的 tsconfig **不列 `electron` types**——这是 `[P0]package_structure.md` §3.3「server 零 electron 依赖」的编译期强制：一旦 server 代码 `import electron`，tsc 直接报"找不到模块"。

### 4.4 与脚本衔接（不重复脚本契约）

```
scripts/unit-test.sh ──source──→ test.env ──→ bun run test ──→ vitest 跑全量
                                                    ▲
                                          仓库根 vitest.config.ts
scripts/run-dev.sh   ──source──→ dev.env  ──→ 起开发态应用（vite dev + electron dev）
```

> 三脚本本身的契约（前置校验、退出码、缺 env 报错）见 `app/envs/[P0]scripts.md` §3.1/§3.2；本文件只约定工具链选型与配置归属。

## 5. 边界

| 零件 | 归属 |
|------|------|
| Bun / vitest 选型、`bun run test` vs `bun test` 红线、各配置文件归属、多目标测试策略 | 本文件 ✅ |
| `unit-test.sh` / `run-dev.sh` 脚本契约 | `app/envs/[P0]scripts.md` §3.1/§3.2 |
| `test.env` / `dev.env` schema | `app/envs/[P0]environments.md` §3.2/§3.3 |
| 5 个 workspace 的职责与依赖边界 | `[P0]package_structure.md` |
| electron-builder 配置（dmg/exe/asar） | `[P0]packaging_toolchain.md` |
| 跨模块零件通用归属规则 | [docs_guide.md](../../docs_guide.md) §4 |
