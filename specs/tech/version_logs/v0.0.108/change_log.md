# v0.0.108 — dmg 打包能力完善（四 bug 闭环，packaged 后端端到端 HTTP 200）

> 范围：完善 dmg 打包，让 packaged app 装后可用。版本号随根 `package.json` 自动确定、运行时配置随包注入、内置 plugin 编译进包、走 prod 环境、零密钥。开发中真机暴露并闭环四个 Critical bug（配置/依赖/插件/dataDir）。**无 HTTP API 契约变更、无 UI 变更**（api/ui overall 不动）。

## 变更（按 bug 闭环组织）

| # | 主题 | 文件 | 变更 |
|---|---|---|---|
| BUG-001 | 运行时配置注入 | `app/electron/src/runtime-config.ts`（新增）/ `main.ts` / `scripts/build-dmg.sh` / `electron-builder.yml` / `prod.env(.example)` | build 期从 prod.env 抽 6 键非密钥白名单（`API_PORT`/`DATA_DIR`/`APP_NAME`/`APP_ENV`/`LOG_LEVEL`/`HEALTH_ENDPOINT`）生成 `runtime-config.json` 打进 asar；`main.ts` 启动最早期 `loadRuntimeConfig` 回填 `process.env`（不覆盖已有）。零密钥（生成端 + 读取端两端白名单过滤）；`DATA_DIR` 存字面 `~/` 运行时展开。修 packaged app 双击启动 `process.env` 干净 → 缺 `API_PORT` → 后端起不来。 |
| BUG-002 | server 依赖归属边界 | `package.json`（根）/ `app/server/package.json` | server 运行时 import 的第三方 npm 包（`yaml`/`gray-matter`/`@modelcontextprotocol/sdk`/`@mozilla/readability`/`adm-zip`/`chrome-devtools-mcp`/`linkedom`/`undici`/`@larksuiteoapi/node-sdk`）声明迁到 `app/server/package.json`。electron-builder 只跟随 `@app/server` 自身 prod deps 打第三方包进 asar，根 hoist 不进包 → 启动 `Cannot find module 'yaml'` 崩。 |
| BUG-003 | packaged plugin 编译/打包/加载 | `scripts/build-plugins.ts`（新增）/ `build-dmg.sh` ①b / `app/server/src/plugin/builtin-loader.ts` / `electron-builder.yml` / `package.json` `build:plugins` | `.ts` impl（4 plugin / 47 impl）bun build 成自包含 `.cjs`（server 外置 `@app/server/dist/X` 共享同一 server 实例）+ 资源（`plugin.json`/`scopes/*.yaml`/`groups.json`/`skills`）拷贝 → `app/plugins/dist`；`files` `{from:../plugins/dist,to:node_modules/@app/plugins}` 映射进 asar；loader 后缀双模式（dev `.ts`→`import()` / packaged `.cjs`→`require`，`nodeRequire` = 全局 require ?? `createRequire`）。历史整个 `app/plugins/` 不进 asar → `ScopeConfigLoader` 硬崩 + 0 插件空壳。 |
| BUG-004 | packaged 启动桥 dataDir 展开 | `app/electron/src/backend-bootstrap.ts` `resolveServerOpts`/`startBackend` | `dataDir` 改用 `require('@app/server/dist/config').resolveDataDir(env)` 展开字面 `~`（禁重复拼接字面 `~`）。原字面 `~` 在 packaged cwd=`/` 下 `mkdirSync('/~/...')` EACCES → 全部 HTTP 500（`plugin_scope` store 初始化）。dev/CLI 走 `index.ts getConfig().dataDir` 已展开故不暴露。用子路径 `@app/server/dist/config`（`resolveDataDir` 未从 server index re-export）。 |
| 政策 | 版本号权威源 | `package.json` `version` | 根 `version` `0.0.0` → `0.0.108`；`build-dmg.sh` 读根包经 `--config.extraMetadata.version` 注入（builder 在 `app/electron` 子目录跑默认读子包 `0.0.0` 占位）。收尾单调递增。 |

## 设计决策（跨文件不变量）

- **runtime-config 零密钥白名单注入**：packaged 运行时 `process.env` 干净，须从 asar 内 `runtime-config.json` 回填；只注入白名单键，密钥绝不进包（两端过滤防御纵深）。
- **workspace 第三方运行时依赖声明在自己的 `package.json`**：electron-builder 只跟随 `@app/server` 自身 deps 打包；根 hoist 掩盖依赖归属缺失，唯独 packaged 暴露。
- **内置 plugin build 期编译进包 + server 外置共享**：产物放 asar `node_modules/@app/plugins`，server→plugins 偏移 `../../` dev/packaged 一致 → bootstrap/skills 路径零改动；asar 内 require/import 经 Electron 42 实证可行 + 单例跨边界共享。
- **packaged 启动桥 dataDir 单一展开权威**：`DATA_DIR` 存字面 `~/`（跨机可移植），展开唯一权威 `config.resolveDataDir`；packaged 启动桥复用它，禁重复拼接字面 `~`。

## spec 同步

- 新增 `specs/tech/plugin_system/[P0]packaged_plugin_loading.md`（编译/打包/加载双模式，architect 建，doc-modifier 验 code==spec 对齐 loader `nodeRequire`/`.js` 分支 + `.cjs` 子路径 require）。
- `specs/tech/app/package/[P0]packaging_toolchain.md` §3.2（BUG-002 依赖边界）/§3.5（版本源）/§3.6（runtime-config）/§3.7（plugin 编译步）；`[P0]package_structure.md` §3.6（依赖归属）+§4.3（BUG-004 启动桥 dataDir）；`index.md` 原则 8-12。
- `specs/tech/app/envs/[P0]environments.md` §3.4/§3.5（prod.env 三分类 + 删 APP_VERSION）+§4.7（DATA_DIR `~` 单一展开权威）。
- 三 KB `log.md` + `change_plan.md`「表外必要变更」小节（BUG-002/version/BUG-004 三项必要正确偏离）。

## 验证

UT（runtime-config 白名单过滤 + backend-bootstrap dataDir 三情形 + builtin-loader 双模式，electron 包 21/21 绿）+ 离线运行时冒烟（解包 asar 起 packaged server dist：加载链成立、LLM provider 非空壳、BUG-004 对照复现 RAW 500 ↔ FIXED 200 store 落 home）+ build-dmg exit 0（dmg 135MB，版本随 package.json）。AT/ET 豁免（纯打包 + 无 API/UI 契约变更，类比 ui-only-ut-skip-at-et）。
