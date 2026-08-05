# v0.0.234 变更计划书 — packaged browser spawn node ENOENT 修复

**版本主题**：packaged Electron 下 browser 工具 spawn 字面 `'node'` 因 PATH 缺失触发 `spawn node ENOENT`。修复 = `defaultSpawn` 加 packaged 分支（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`），dev 走原 `'node'` 不回归。

**流程标注**：纯技术 packaged-only bug 修复（dev 无行为变化、无用户可感知变化）→ **跳过 PRD**（CLAUDE.md「PRD 参与边界」：纯技术层面改动无需 PRD）。req 已含根因 + 修复方向 + 验证，**视为架构预确认**（用户指示「问题明确全自动推进」）。

**同类审查结论（orchestrator 已做，见 context.md findings）**：browser 目录 3 处 `spawn(`，只有 `node-worker-driver.ts:261 defaultSpawn` spawn 字面 `'node'`（PATH 依赖 → ENOENT 隐患）；`chrome-launcher.ts:167 spawnChromeProcess` 和 `browser-worker.cjs:409`（bundle）spawn 的是 `discoverChromeExecutable` 解析的**绝对路径** chrome binary，不依赖 PATH，**非同类**。**本次修复只动 defaultSpawn，不碰 chrome spawn**。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---|---|---|---|---|---|---|
| browser-tool | app/server/src/tools/browser/node-worker-driver.ts | defaultSpawn | 修改 | 加 packaged 分支：`if (process.versions.electron)` 命中 → `spawn(process.execPath, args, { ...opts, detached: true, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' } })`；否则走原 `spawn(cmd, args, { ...opts, detached: true })`（dev cmd='node'）。Electron 二进制 under ELECTRON_RUN_AS_NODE=1 = 纯 node 语义，args（`[workerPath]`）不变。如需 UT 直测 defaultSpawn，可加 `export` 关键字（coder 决策，见下行约束） | MUST：dev 不回归（`process.versions.electron` undefined → spawn('node', args) 原路径）；MUST：args 不变（仍 `[workerPath]`）、`detached: true` 保留；MUST NOT：动 chrome-launcher.ts / browser-worker.cjs 的 chrome spawn（绝对路径，非同类）；MUST NOT：改 resolveWorkerPath / opts.stdio；packaged 分支 env 必须 spread `opts.env` 后追加 `ELECTRON_RUN_AS_NODE`（不覆盖调用方 env） | reqs/[working] v0.0.234.browser_spawn_packaged/req.md §修复方向；CLAUDE.md「持续可打包护栏」③；memory `packaged-spawn-external-binary-exec-path`；specs/tech/agent/tools/[P1]browser_tool.md §3 | +6/-1 |
| browser-tool | app/server/src/tools/browser/__tests__/node-worker-driver.test.ts | describe('defaultSpawn packaged 分支') | 新增 | 新增 UT 覆盖两分支：① packaged 分支——mock `process.versions.electron` 为真值 + mock `node:child_process.spawn`，调 defaultSpawn 断言 spawn 收到 `process.execPath` 作为 cmd + opts.env 含 `ELECTRON_RUN_AS_NODE: '1'` + `detached: true` + args 透传；② dev 分支不回归——`process.versions.electron` undefined 时 spawn 收到传入的 `'node'` 作为 cmd、env 不含 ELECTRON_RUN_AS_NODE。实现路径 coder 决策：若 defaultSpawn 加 `export` 则直测；否则用无 spawnDeps 注入的 NodeWorkerDriver + spy on `node:child_process.spawn`（注意 vitest mock `node:child_process` 用绝对路径，见 memory `test-vitest-mock-absolute-path`） | MUST：两分支都覆盖且全绿；MUST：不在 packaged 用例里真 spawn（mock spawn 返回 FakeChildProcess）；MUST NOT：改既有 12 个用例断言；MUST：mock 还原 process.versions.electron 原值（防污染同文件其他用例）；dev 跑得到（process.versions.electron===undefined 走 dev 分支），packaged 真机由用户验收（dev 测不到） | memory `test-vitest-mock-absolute-path`（vi.mock 绝对路径）；req §验证；specs/tech/testing/ | +35~50 |

## 验证口径

- **UT（本版本唯一 dev 可跑验证）**：两分支覆盖 + 既有 12 用例不回归 + `bun run typecheck` 绿。
- **packaged 真机验证**：build-dmg → 装 → agent 调 browser 工具不崩 + 子进程正常返回（CLAUDE.md「持续可打包护栏」：dev 绿 ≠ packaged 能跑）。**dev 测不到，由用户验收**。
- **AT/ET**：browser 无既有 AT/ET case（用户铁律禁新增普通 feature case）→ 本版本不新增，不进版本白名单。
