# v0.0.108 变更计划书 — packaged 内置 plugin 编译/打包/加载（BUG-003）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **背景（已真机实证）**：整个 `app/plugins/` 不进 asar → packaged 启动 `ScopeConfigLoader.loadAll` 硬 throw（`.../app.asar/node_modules/@app/plugins/scopes` 不存在）+ `BuiltinLoader` 加载 0 插件（无 LLM provider = 空壳）+ `.ts` Node 跑不了。方案权威源：`specs/tech/plugin_system/[P0]packaged_plugin_loading.md`（编译/加载）+ `specs/tech/app/package/[P0]packaging_toolchain.md §3.7`（打包）。
>
> **可行性已实证**（Electron 42.4.1，真出厂二进制）：asar 内 `require` CJS ✅ + `import(file://)` ESM ✅ + `@app/server` 解析 + 模块级单例跨边界共享 ✅；R1 build（stage 源码改写 + `bun build --external='@app/server'`）47/47 impl 干净打包（externals 仅 `@app/server/dist/*`+`@larksuiteoapi/node-sdk`+node 内建，0 npm 泄漏）；`require(bundle).default` = impl 类、`map()` 正常委托 server handler。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| plugin-loader | app/server/src/plugin/builtin-loader.ts | `loadOne()` | 修改 | 计算 `implPath = path.resolve(dir, ext.impl)` 后加 packaged fallback：`fs.existsSync(implPath)` 为 false 时把 `.ts`/`.tsx` 后缀换成 `.cjs`（packaged 产物），再传给 `importFile`。dev（.ts 存在）行为不变。 | MUST 先试 literal 路径（dev .ts）再 fallback `.cjs`；MUST NOT 改写 manifest `impl` 字段（唯一身份源保 `.ts`）；MUST NOT 触碰目录名==id 校验/manifest 形状校验既有逻辑 | packaged_plugin_loading §3.5；builtin-loader.ts:94 | +4/-1 |
| plugin-loader | app/server/src/plugin/builtin-loader.ts | `importFile()` | 修改 | 按后缀双模式加载：`.cjs`/`.js` → **直接 `require(absPath)`（纯路径，非 file:// URL）** 取 CJS bundle（packaged）；`.ts` → 保持现有 `await import(pathToFileUrl(absPath))`（dev/bun）。返回 module 记录，caller 取 `.default` 不变。 | MUST 用直接 `require(plainPath)` 加载 `.cjs`（tsc `module:CommonJS` 会把 `import()` 降级成 `require(fileURL)`——对 `.cjs` 不可用，故显式 require 纯路径）；MUST NOT 给 require 传 file:// URL；`require` 不可用时用 `createRequire(__filename)`（coder 定位）；dev `.ts` 分支保持 `import()` 不改（vitest/bun 兼容） | packaged_plugin_loading §3.1/§3.5；builtin-loader.ts:114-133（现 dist 降级为 `require(fileURL)` 实证已坏） | +9/-2 |
| package-build | scripts/build-plugins.ts | `main()` + 内部 helper（collectEntrypoints/rewriteServerImports/buildBundles/copyResources） | 新增 | R1 build 脚本（bun 跑）：① `mkdtemp` stage，`cp -R app/plugins/builtins → stage/builtins`；② stage 内所有 `.ts`（排除 `.test.ts`）`sed (../)+server/src/X → @app/server/dist/X`；③ 遍历 4 个 `plugin.json` 的 `extImpls[].impl` 收 47 entry，`Bun.build({entrypoints, outdir:app/plugins/dist/builtins, root:stage/builtins, target:'node', format:'cjs', naming:'[dir]/[name].cjs', external:['@app/server','@larksuiteoapi/node-sdk','undici','playwright']})`；④ 拷贝资源（从原 `app/plugins`）：各 `plugin.json`→`dist/builtins/<id>/`、`scopes/*.yaml`→`dist/scopes/`、`groups.json`→`dist/groups.json`、`skills/**`→`dist/builtins/skills/`；产物缺失/build 失败非 0 退出。 | MUST 用 stage+源码改写+**包名 external `@app/server`**（`onResolve` 相对路径 external 实证不可靠：HIT 却仍 bundle，致 gray-matter/js-yaml 误打进 memory bundle）；MUST NOT 改写原 `app/plugins/builtins` 源码（dev 用原源码）；MUST 保 impl 相对目录结构（`[dir]/[name].cjs`）；单文件 ≤300 行 | packaged_plugin_loading §3.2/§3.3/§4.1；scripts §build:worker 先例 | +130 |
| package-build | scripts/build-dmg.sh | plugin 编译步（①a 后新增 ①b） | 修改 | server dist 编译（①a `cd app/server && bun run build`）之后、vite build 之前，新增：`bun run scripts/build-plugins.ts`；随后校验 `app/plugins/dist/builtins` 非空（缺则 `echo ERROR + exit 3`，与既有 server/web 产物校验一致）。 | MUST 在 electron-builder（③）前完成；MUST 产物校验失败即非 0 退出（不静默继续打空包）；MUST NOT 改动 runtime-config 生成/版本号读取/签名 unset 既有逻辑 | packaging_toolchain §3.7/§4.2；build-dmg.sh:98-103（server 产物校验范式） | +9 |
| package-build | package.json | `scripts.build:plugins` | 新增 | 加 `"build:plugins": "bun run scripts/build-plugins.ts"`（与既有 `build:worker` 一致范式，供 build-dmg 调 + 本地手动跑）。 | MUST NOT 改 `version` / `workspaces` / 其他 scripts | packaging_toolchain §3.7；package.json scripts.build:worker | +1 |
| package-config | app/electron/electron-builder.yml | `files[]` 映射项 | 修改 | 在 `files:` 加 `- from: ../plugins/dist` / `  to: node_modules/@app/plugins`（`from` 相对 app/electron = 仓库 `app/plugins/dist`；`to` = asar 内 `node_modules/@app/plugins`），让 server 侧既有 `../../plugins` 路径解析零改动。 | MUST 放 `node_modules/@app/plugins`（server→plugins 偏移 `../../` dev/packaged 一致）；MUST NOT 改 `asar:true`/其他 files 项/mac/win/dmg 配置 | packaging_toolchain §3.4/§4.1；packaged_plugin_loading §2.1/§3.4 | +2 |

## 影响面评估

- **跨模块**：`plugin-loader`（server，2 符号改）+ `package-build`（新建 build 脚本 + build-dmg 接线 + package.json 脚本）+ `package-config`（electron-builder files）。**无破坏性 API 变更**——loader 对外行为不变（仍登记 impl 类引用），仅内部加 packaged 加载分支；bootstrap.ts / skills/resolver.ts **不改**（路径偏移 dev/packaged 一致）。
- **依赖顺序**：底层先行——① `build-plugins.ts`（产物形态）→ ② build-dmg 接线（调它）+ electron-builder files（打它）→ ③ loader packaged 分支（加载它）。三者可并行开发，集成点是 packaged 加载。
- **dev↔packaged 双模式统一**：dev 加载原源码 `.ts`（loader 走 `import()` 分支，server import 解析 `app/server/src` 同实例）；packaged 加载 `.cjs` bundle（loader 走 `require()` 分支，server import 解析 asar `node_modules/@app/server/dist` 同实例）——**两模式加载不同文件、互不干扰**，dev 全程零改动。
- **风险点**：
  1. **electron-builder `files` `{from,to}` 映射进 `node_modules/@app/plugins` 是否被 node_modules 剪枝影响** —— 显式 `files` 项为强制包含，但 coder MUST 在 build-dmg 冒烟后用 `npx @electron/asar list` 核对 asar 内 `node_modules/@app/plugins/{builtins,scopes,groups.json}` 齐全（若映射不生效 → 回退：build-plugins 直接输出到 `app/electron/node_modules/@app/plugins` + yml 用 `node_modules/@app/plugins/**/*` glob，与 `@app/server` 同范式）。
  2. **`require` 在编译为 CJS 的 loader 源码里可用性** —— server `module:CommonJS` 运行时 `require` 原生可用；若 TS/lint 报 `require` 未定义，用 `import { createRequire } from 'node:module'; const require = createRequire(__filename)`（coder 定位，不影响行为）。
  3. **js-yaml 可选 `esprima`（bare `require("esprima")`）** —— 仅当插件 bundle 误 inline server 的 gray-matter 才出现；R1 已消除（memory bundle 由 3930→179 行）。coder MUST 验证 build 产物 externals 只含 `@app/server/dist/*`+`@larksuiteoapi/node-sdk`+node 内建（grep 断言 0 条 `js-yaml`/`gray-matter`）。
- **验证锚点**（AT/冒烟）：build-dmg exit 0 + asar 内 `node_modules/@app/plugins/{builtins/<5 id>,scopes/{default,forked}.yaml,groups.json}` 齐全 + 装 dmg 启动后端不再报 `ScopeConfigLoader` 崩 + LLM provider `llm_anthropic` 可用（非空壳）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件如 bootstrap.ts/skills-resolver.ts 路径、动未声明符号、破 MUST 约束、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- spec↔code 漂移（如 loader 实际用 `createRequire` 而非全局 `require`、electron-builder 回退到直写 node_modules）→ coder 汇报，doc-modifier 阶段 5 统一修 spec

## 表外必要变更（实施中追加）

本表冻结于 architect 方案期（T2 = packaged plugin 编译/打包/加载）。实施中真机暴露的以下三项在本表**范围外**，均为**必要正确偏离**（非违反 change_plan——不改本表已冻结行，是相邻打包正确性问题；已经 code-review + orchestrator 裁决放行，记此保留 review 可追溯性）：

| 变更 | 文件 / 符号 | 类型 | 内容 + 理由 | 对齐 spec |
|---|---|---|---|---|
| BUG-002 server 第三方依赖迁移 | `package.json`（根）/ `app/server/package.json` `dependencies` | 修改 | server 运行时 import 的第三方 npm 包（`yaml`/`gray-matter`/`@modelcontextprotocol/sdk`/`@mozilla/readability`/`adm-zip`/`chrome-devtools-mcp`/`linkedom`/`undici`/`@larksuiteoapi/node-sdk`）声明迁到 `app/server/package.json`。**理由**：electron-builder 只跟随 `@app/server` 自身 prod deps 打第三方包进 asar，根 hoist 的包不进包 → packaged 启动 `Cannot find module 'yaml'` 崩。与 T2 plugin bundle 外置 `@app/server` 同属打包正确性链路（packaged require `@app/server` 须能解析其依赖）。 | `package_structure.md §3.6` + `packaging_toolchain.md §3.2` |
| 版本号政策（收尾更新根 package.json） | `package.json` `version` | 修改 | 根 `version` `0.0.0` → `0.0.108`（收尾单调递增）。**理由**：版本号权威源政策（`build-dmg.sh` 读根包经 `--config.extraMetadata.version` 注入），是打包收尾政策，非 T2 plugin 范畴。 | `packaging_toolchain.md §3.5` + CLAUDE.md「版本号权威源」 |
| BUG-004 packaged 启动桥 dataDir 展开 | `app/electron/src/backend-bootstrap.ts` `resolveServerOpts`/`startBackend` | 修改 | `dataDir` 改用 `require('@app/server/dist/config').resolveDataDir(env)` 展开字面 `~`（原 `env.DATA_DIR ?? '~/.x'` 未展开）。**理由**：packaged cwd=`/` 下字面 `~` 致 `mkdirSync('/~/...')` EACCES → 全部 HTTP 500（含 `plugin_scope` store 初始化——正是 packaged plugin 落盘的运行时前提）。属 electron 启动桥（非 T2 plugin loader/build）。用子路径 `@app/server/dist/config`（`resolveDataDir` 未从 server index re-export，约束禁改 server index）。 | `package_structure.md §4.3` + `environments.md §4.7` |

> 裁决记录见 `states/v0.0.108/task-board.md` [16:20]（BUG-002 + version 判必要正确偏离）/ [16:55]～[17:10]（BUG-004）；doc-modifier 阶段 5 已把三项同步进上表「对齐 spec」列所列文件。
