---
type: spec
title: Packaged 内置 plugin 编译/打包/加载
priority: P0
status: active
updated: 2026-07-10
since: v0.0.108
related: [[P0]builtin_plugins_directory.md, [P0]plugin_manager_interface.md, ../app/package/[P0]packaging_toolchain.md]
---

# Packaged 内置 plugin 编译/打包/加载

## 1. 概述

**管什么**：`app/plugins/builtins/` 的 56+ 个 `.ts` 实现如何在 **packaged dmg**（Electron 主进程 = Node CJS，非 bun）里被加载——编译成什么产物、放进包的哪里、加载器如何 dev/packaged 双模式统一、资源文件（scopes/groups.json/skills）如何随包。
**不管什么**：内置 plugin 目录约定 + 扫描流程（→ `[P0]builtin_plugins_directory.md`）、registry 登记语义（→ `[P0]plugin_manager_interface.md §3.4`）、electron-builder/dmg 产物形态（→ `../app/package/[P0]packaging_toolchain.md`）、各 impl 的业务契约（→ 各 `agent/*`）。

**范畴一句话**：dev 时 bun 直跑 `.ts` 源码、插件的 `../../../server/src/X` import 与 server 共享同一模块实例；packaged 时 Node 跑不了 `.ts`，故 build 期把每个 impl **bun build 成自包含 `.cjs`**（把 server import 外置成 `@app/server/dist/X` 共享 server 运行时），打进 asar 的 `node_modules/@app/plugins/`，加载器按后缀选 `require`（packaged `.cjs`）或 `import()`（dev `.ts`）。

**与外界如何交互**：build 期由 `scripts/build-plugins.ts`（bun）编译 → `app/plugins/dist/`；`build-dmg.sh` 在 web/server 编译后调它；`electron-builder.yml` 的 `files` 把 `app/plugins/dist` 映射进 asar `node_modules/@app/plugins`；运行时 `BuiltinLoader.loadOne`（`app/server/src/plugin/builtin-loader.ts`）按后缀双模式加载。

## 2. 概念模型

### 2.1 dev vs packaged 双模式（同一 loader，不同产物）

| | dev（bun 跑源码） | packaged（Node 跑 asar） |
|---|---|---|
| server 运行 | `bun run app/server/src/index.ts`（源码 ESM） | `require('@app/server')` → `node_modules/@app/server/dist/index.js`（CJS） |
| server `__dirname`（bootstrap.ts） | `app/server/src` | `…/app.asar/node_modules/@app/server/dist` |
| 插件根 `../../plugins` 解析到 | `app/plugins`（物理源码） | `…/app.asar/node_modules/@app/plugins`（编译产物） |
| impl 文件 | `builtins/<id>/x.ts`（源码） | `builtins/<id>/x.cjs`（bun build 产物） |
| 加载机制 | `await import('file://…/x.ts')`（bun 认 .ts） | `require('…/x.cjs')`（Node CJS） |
| server import 解析 | `../../../server/src/X` → `app/server/src/X.ts`（与 server 同实例） | `@app/server/dist/X` → `node_modules/@app/server/dist/X.js`（与 server 同实例） |

**关键不变量**：server→plugins 的相对偏移 `../../` 在 dev 与 packaged **完全一致**（server 均在 `.../server/{src,dist}`，plugins 均在其 `../../plugins`）。故 `bootstrap.ts` 三处 `path.resolve(__dirname,'../../plugins/…')` + `skills/resolver.ts` 的 `builtinSkillRoot()` **无需改动**——只要把编译产物放到 packaged 的 `node_modules/@app/plugins`，路径自然对上。

### 2.2 编译产物（每 impl 一个自包含 CJS bundle）

- **一个 impl 一个 bundle**：`manifest.extImpls[].impl`（如 `./provider.ts`）→ bun build 成 `./provider.cjs`，把 **plugin 内部依赖**（`../types`/`ContextImplBase`/兄弟模块）**inline 进去**，只把两类外置：
  - `@app/server/dist/X`（server 编译产物，运行时 `require` 到 asar 内**同一份** server 实例）
  - npm 包（`@larksuiteoapi/node-sdk` / `undici`，随 server deps 已在 asar `node_modules`）
- **产物树镜像源码结构**：`app/plugins/dist/builtins/<id>/<impl>.cjs`（`[dir]/[name].cjs` 保结构）+ 原样拷贝 `plugin.json` / `scopes/*.yaml` / `groups.json` / `skills/**`。

### 2.3 为什么必须外置 server（不能 inline）

server 有**模块级单例**跨 plugin↔server 边界共享，inline 会复制成两份而断裂：
- `agent/session-store-ep-delegate.ts`：`let delegate`，server bootstrap `setSessionStoreEpDelegate(store)` 写、plugin `persistent_session_store` `getSessionStoreEpDelegate()` 读——inline 则 plugin 读到自己那份 `null`。
- 其余 server 值 import（`prompts/handlers/*` 基类、`config/ulid`、`channel/channel-base`、`memory/*`、`stores/board-archive`、`llm/{provider,protocol}`）也须与 server 用同一实例。

**plugin 内部**共享模块（`types.ts`/`ContextImplBase`/`squad_reminder_shared`/`base_builder`）经核实**无模块级可变状态**（纯基类/纯函数/被 erase 的 type import），bundle 复制安全；唯一模块级 `Map`（`in_memory_session_store.ts` 的 `SESSION_STORES`）自包含于其**单个** impl-entry bundle（无他 entry 以值形式 import 它），require 缓存保证多次实例化共享同一 Map。故**每 impl 独立 bundle 单例安全**。

## 3. 设计决策

### 3.1 asar 内动态加载可行 —— Electron 42 实证（方案分叉点已定）

**结论**：Electron 42.4.1 下，asar 内 **`require()` CJS ✅、`await import('file://…app.asar/…')` ESM `.mjs` ✅、dynamic import CJS ✅** 全部成立；且 asar 内 `node_modules/@app/server` 可被 plugin `require`/`import` 解析到、**模块级单例跨边界共享**（`singletonShared=true`）。历史「ESM 动态 import 不认 asar 路径」的限制在 Electron 42 **已不存在**。
**证据**：把测试 asar（含 cjs/esm plugin + 假 `@app/server` 单例）临时换入已 build 的 `rocky_agent.app` 用**真出厂 Electron 二进制**跑，四项 A/B/C/D 全 PASS；且真产物 asar 换回无损。
**取舍**：既然 CJS `require` 最稳（干净 `mod.default`、无 ESM↔CJS interop 歧义），**packaged 用 CJS bundle + `require`**；dev 仍 `.ts` + `import()`（bun）。不采「ESM `.mjs` bundle 全程 import()」是因 ESM 具名 import 一个 CJS `@app/server/dist/X` 依赖 cjs-module-lexer 静态分析，存在少量 interop 脆性；CJS+require 零脆性。
**反例**：若沿用 `import('file://x.ts')` 加载 packaged——Node 主进程不认 `.ts`，`ERR_UNKNOWN_FILE_EXTENSION` 直接崩。

### 3.2 选 bun build 自包含 bundle，不选 tsc -b 镜像编译

**结论**：编译用 **bun build**（每 impl 一 entry → 自包含 `.cjs`），不新增 `app/plugins` 的 tsconfig 进 `tsc -b` composite 图。
**理由**：(1) **相对路径断裂**——tsc 不改写 import specifier，`../../../server/src/X` 原样 emit，在 dist 里跨 `src→dist`+位置变化必错；(2) bun build 复用项目**既有先例**（`package.json build:worker` 已 `bun build … --target=node --format=cjs --external=… --outfile=x.cjs`），零新工具链；(3) 自包含 bundle 运行时只依赖 `@app/server`+npm 外置，plugin 内部 import 全 inline，无「asar 内多文件相对 require」的额外验证面（虽实证可行）；(4) 单例安全已论证（§2.3）。
**反例**：若 tsc 镜像 + 保留 `../../../server/src/X`，packaged 里解析到 `node_modules/@app/server/src`（源码不进包，只有 dist）→ `MODULE_NOT_FOUND`。

### 3.3 server import 外置到 `@app/server/dist/X`（stage 源码改写 + 包名 external）

**结论**：build 期把插件对 `…/server/src/X` 的 import **外置成 `@app/server/dist/X`**，用 **stage 源码副本 + 改写源码 import + 包名 external** 三步（**不用** `onResolve`）：
1. **stage**：`app/plugins/builtins` 拷进临时 staging 目录（源码不动，dev 仍用原源码）；
2. **sed 源码 import**：staging 内所有 `.ts`（排除 `.test.ts`）`(../)+server/src/X` → `@app/server/dist/X`（统一规则，深度无关；type-only import 会被 erase，仅值 import 落地）；
3. **`Bun.build(..., external:['@app/server','@larksuiteoapi/node-sdk','undici','playwright'])`**：包名 `@app/server` external **可靠命中含深子路径**（`@app/server/dist/prompts/handlers/identity-handler` 等）。
**理由（为何不用 onResolve）**：实证 `onResolve({filter:/server\/src\//})→{external:true}` 对**相对路径**外置**不可靠**——回调命中（HIT）却仍被 bundle，导致 `memory-user`（re-export `./memory`→server `managed-store`）把 server 的 `gray-matter/js-yaml/esprima` 误打进 bundle（3930 行 vs 改后 179 行）。改成「先把源码 import 改写成包名 `@app/server` 再 external 包名」后，47/47 bundle 干净——externals 仅 `@app/server/dist/*` + `@larksuiteoapi/node-sdk` + node 内建，**0 npm 泄漏**。`@app/server` 是 asar 内真实包，deep 子路径走 Node classic 解析可达（server dist 保结构）。**dev 不受影响**：dev 加载原源码 `.ts`，其 `../../../server/src/X` 仍解析到 `app/server/src`（与 dev server 同实例）——dev 与 packaged 加载**不同文件**，互不干扰。
**反例**：`bun build --external` 单值只允许一个 `*` 通配，无法匹配变深度 `(../)+server/src/*`（故必须先改写成包名）；不外置则 server（含其 gray-matter/js-yaml 传递依赖）被 inline → §2.3 单例断裂 + 包体膨胀。

### 3.4 放进 asar `node_modules/@app/plugins` —— 路径解析零改动

**结论**：`electron-builder.yml` 的 `files` 把 `app/plugins/dist` 映射到 asar `node_modules/@app/plugins`（`- from: ../plugins/dist` `to: node_modules/@app/plugins`，from 相对 `app/electron`）。
**理由**：§2.1 已证 server→plugins 偏移 `../../` dev/packaged 一致——放到 `node_modules/@app/plugins` 则 `bootstrap.ts` 的 `../../plugins/{builtins,scopes,groups.json}` + `builtinSkillRoot()` 的 `../../../plugins/builtins/skills` **全部无需改**；且 plugin bundle 的 `require('@app/server/dist/X')` 从 `node_modules/@app/plugins/…` 向上走 node_modules 恰好命中 `node_modules/@app/server`（实证 Test A 同构）。**server 零 electron 依赖不破**——路径靠 `__dirname` 相对推导，不 import electron、不需注入 `resourcesPath`。
**反例**：若放 asar 根 `plugins/` 或 extraResources，则 server 侧 `../../plugins` 偏移在 packaged 变了（多一层 node_modules），须 mode 分支或注入路径 → 更多改动、且注入路径与 §2.1 的零改动优势相悖。

### 3.5 加载适配：后缀决定机制，manifest 不改

**结论**：`BuiltinLoader` 解析 `ext.impl`（如 `./provider.ts`）时——**literal 路径存在**（dev 有 `.ts`）→ `import('file://…')`；**不存在则把 `.ts`→`.cjs`**（packaged 产物）→ `require(absPath)`。取 `mod.default` 作类引用（两模式一致）。manifest `impl` 字段**保持 `.ts`**（唯一身份源，不因打包改写）。**require 来源**：全局 `require`（server 编译为 CJS、Electron 主进程 Node loader 原生可用；bun dev/vitest 亦提供全局 `require`）优先；全局不可用时 `createRequire(__filename)` 兜底（`typeof require` 探测不触发 ReferenceError）——实现里收敛为模块级常量 `nodeRequire`。
**理由**：dev 与 packaged 用不同产物但同一 manifest；后缀 fallback 让 loader 单点适配、manifest 零污染。`require` 对 CJS bundle 给干净 `mod.default`（实证），`import()` 对 dev `.ts`（bun）给干净 `mod.default`——`(mod as {default}).default` 逻辑不变。
**反例**：若 build 期改写 dist manifest 的 `impl` 为 `.cjs`，则 manifest 出现 dev/packaged 两版身份源，且 loader 仍要认两种后缀，无净收益。

## 4. 示例

### 4.1 build 脚本产出（`scripts/build-plugins.ts`，bun）

```
① stage = mkdtemp;  cp -R app/plugins/builtins → stage/builtins
② find stage/builtins -name '*.ts' ! -name '*.test.ts'
     | sed -E 's#(\.\./)+server/src/#@app/server/dist/#g'   （改写源码 import，深度无关）
③ entries = 遍历 4 个 plugin.json 的 extImpls[].impl（→ stage 内绝对路径，47 个）
   Bun.build({ entrypoints: entries, outdir:'app/plugins/dist/builtins', root:'stage/builtins',
     target:'node', format:'cjs', naming:'[dir]/[name].cjs',
     external:['@app/server','@larksuiteoapi/node-sdk','undici','playwright'] })
④ 资源拷贝（从原 app/plugins，不含 server import 无需改写）：
   plugin.json → dist/builtins/<id>/、scopes/*.yaml → dist/scopes/、
   groups.json → dist/groups.json、skills/** → dist/builtins/skills/
```

产物验证（实证，全 47 impl）：`identity.cjs` 3.65KB `require("@app/server/dist/prompts/handlers/identity-handler")` 外置、`ContextImplBase` inline；`memory-user.cjs` 179 行（server `managed-store` 外置、gray-matter/js-yaml **未泄漏**）；全 47 bundle externals 仅 `@app/server/dist/*`+`@larksuiteoapi/node-sdk`+node 内建；`require(bundle).default`=impl 类，`new(implId,cfg).map(ctx)` 正常委托 server handler。

### 4.2 loader 双模式（`builtin-loader.ts`：`loadOne` 定路径 + `importFile` 定机制）

路径解析与加载机制**分离到两处**：`loadOne` 按 `existsSync` 定文件（dev `.ts` 存在直接用；不存在换 `.cjs`），`importFile` 按**后缀**选加载器（`.cjs`/`.js` → `require`；否则 `.ts` → `import()`）。

```
// loadOne：literal 路径存在（dev .ts）直接用；不存在换 .cjs（packaged 产物）
let implPath = path.resolve(dir, ext.impl);                 // 例 …/provider.ts
if (!fs.existsSync(implPath)) implPath = implPath.replace(/\.tsx?$/, '.cjs');
const mod = await importFile(implPath);
const implClass = (mod as { default?: unknown }).default;   // 两模式一致

// importFile：后缀决定加载机制
async function importFile(absPath) {
  if (absPath.endsWith('.cjs') || absPath.endsWith('.js'))
    return nodeRequire(absPath);                            // packaged：CJS bundle，纯路径 require（非 file:// URL）
  return await import(pathToFileUrl(absPath));              // dev：.ts 走 dynamic import（bun 认 .ts）
}
// nodeRequire：全局 require 可用则用，否则 createRequire(__filename) 兜底（§3.5）
const nodeRequire = typeof require === 'function' ? require : createRequire(__filename);
```

## 5. 边界

| 零件 | 归属 |
|---|---|
| dev/packaged 双模式加载、编译产物形态、server 外置改写、asar 放置、loader 后缀适配 | 本文件 ✅ |
| 内置 plugin 目录约定 + 扫描流程（`app/plugins/builtins/<id>/plugin.json`） | `[P0]builtin_plugins_directory.md` |
| registry 登记语义（按 point+implId、get 时实例化、类引用不跑代码） | `[P0]plugin_manager_interface.md §3.4` |
| build-dmg 两段式 + electron-builder files/asar + runtime-config 注入 | `../app/package/[P0]packaging_toolchain.md`（§3.7 plugin 编译步 ← 本文件） |
| build-plugins.ts 脚本契约（用途/入参/退出码） | `../app/envs/[P0]scripts.md` |
| 各 impl 业务契约（provider/protocol/context handler/channel） | 各 `agent/*` / `channel/*` |

