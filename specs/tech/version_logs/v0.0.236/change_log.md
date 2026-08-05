# v0.0.236 变更日志 — packaged bash spawn EBADF 修复（A 透 errno + C 句柄回收 + B raise nofile）

> 版本轴发布说明（跨 KB）。位置轴见各 KB `log.md`；method 级契约见同目录 `change_plan.md`。
> 纯技术 bug 修复，**无 PRD/API/UI 变更**（不产 prd/api/ui version_log，无 app-guide 更新）。
> 需求源：`reqs/[working] v0.0.236.spawn_ebadf/req.md`。

## 1. 主题

packaged Electron 下 bash 工具 spawn 偶发 EBADF/"第一次 bash 就坏"。三段互补修复：
- **A 诊断盲区**：`child.on('error')` 吞 errno → 透出 `spawnErrno` + `[RUNTIME_ERROR] spawn XXX` 文本，真机一跑即区分 EBADF/EMFILE/ENOENT/EACCES。
- **C 治本 fd 回收**：escaped-grandchild（setsid 脱离进程组）继承 pipe 写端 → `close` 永不触发 → pipe 读端 fd +2/run 钉死；SIGKILL 兜底后显式 `reclaimStreams()` destroy stdout/stderr，解耦 fd 回收与孙子生死（双收益：fd 回收 + promise 不 hang）。
- **B 基线余量救急**：packaged launchd 启动 nofile soft=256，启动期基线 fd 逼近上限；electron main 用 native `posix` binding 抬 soft 到 4096（hard 不动）。

## 2. 实现偏差（相对 change_plan）

### 2.1 ②d 偏差：node-gyp direct 取代 @electron/rebuild（B 段）

- **change_plan B 段**原写 ②d "复用 `@electron/rebuild`"（参照 ②c better-sqlite3 主路径 `npx @electron/rebuild`）。
- **实际落地 = node-gyp direct**（`scripts/build-dmg.sh` ②d，L226-241）：从 `app/electron/node_modules/posix` 解析本地 `node-gyp/bin/node-gyp.js`，`node "$NODE_GYP_POSIX" rebuild --target=<electron-version> --dist-url=<electron headers> --runtime=electron`。
- **偏离原因（实证）**：`npx @electron/rebuild` 命中**陈旧 node-abi cache**，node-abi 不识别 electron 42.4.1 ABI → rebuild 必败阻塞 dmg；coder 实证 **node-gyp direct 走 `--dist-url` 直拉 Electron headers 绕过 node-abi ABI 探测**，exit 0。②c 本身就有 node-gyp fallback（L186-196），②d 直接走主路径不算无先例。
- **约束不变**：②d 失败 → exit 1（posix 是 packaged 主进程**运行时硬依赖**，非 ②c better-sqlite3 那种 `warn+skip` 的未激活 fallback——packaged sqlite default=node:sqlite 全覆盖，posix 无替代品）。退路（change_plan 已标）：node-gyp direct 也失败 → 自写 minimal N-API addon（~15 行 C 调 setrlimit，参照 computer-native 模式）。**本版退路未触发**（posix rebuild 成功）。

### 2.2 npx-cache 教训（跨版本可复用）

**结论**：posix-style native dep（纯 N-API 调 POSIX syscall、轻量）规划 Electron ABI rebuild 时，**优先 node-gyp direct**（`node-gyp rebuild --target=<ver> --dist-url=<headers> --runtime=electron`），不要走 `npx @electron/rebuild`——后者依赖 node-abi 做 ABI 探测，node-abi 版本滞后时不认新 Electron ABI（electron 42.4.1 实证），且 npx 命中陈旧 cache 必败、绕过本地 install。

**何时适用**：新增 native npm dep（非 better-sqlite3 那种 prebuild 覆盖全 Electron ABI 的）面向 packaged Electron 时。better-sqlite3 走 `@electron/rebuild` 主路径是因为其 prebuild 生态成熟、node-abi 多数情况下认；posix 这类小众 native 包 node-abi 滞后风险高。

**怎么做**：build-dmg.sh 加一段「从 `<pkg>/node_modules/<native-pkg>` 解析本地 node-gyp → `node-gyp rebuild --target=$ELECTRON_VERSION --dist-url=https://electronjs.org/headers --runtime=electron`」；产物校验 `<pkg>/build/Release/<name>.node` 存在；失败按 dep 性质决定 exit 1（硬依赖）或 warn+skip（未激活 fallback）。

### 2.3 影响行低估

change_plan B 段 ②d 行标 `+12`，实际 `scripts/build-dmg.sh` ②d 块（L210-251）约 40 行——主因是 coder 加了详尽的 npx/node-abi cache 雷区注释 + 多档错误提示（posix 目录缺失 / node-gyp 解析失败 / rebuild 失败 / .node 产物缺失四档 exit 1）。语义未越界（仍是"②d 对 posix 跑 Electron ABI rebuild，硬依赖必成功"），仅注释/错误提示膨胀。

### 2.4 B 段 native dep 风险解除

change_plan 影响面评估把 B 的 native dep 列为本版最大风险（参照 better-sqlite3@11 Electron 42 V8 ABI rebuild 必失败先例）。**实证**：posix@4.2.0 node-gyp direct rebuild 成功产出 `build/Release/posix.node`，退路（自写 N-API addon）未触发。better-sqlite3 失败的根因是其 V8 ABI 深度耦合（N-API 不耦合 ABI），posix 是纯 N-API 调 syscall 不受 V8 ABI 变化影响——memory `node-sqlite-packaged-covers-better-sqlite3-redundant` 的对照点（better-sqlite3 rebuild 必败但生产从不激活）在此版本被 posix 反向印证：**纯 N-API native dep rebuild 可成功，better-sqlite3 失败是其非 N-API 实现的特例**。

## 3. A+C 段无偏离（纯 TS，按表落地）

A（`bash-engine.ts` ShellResult.spawnErrno + finish 签名 + `child.on('error')` 透 errno + `bash.ts` `[RUNTIME_ERROR] spawn XXX` 前缀）+ C（`wireChildLifecycle.reclaimStreams()` helper + SIGKILL 兜底后调 destroy + `child.unref()`）均按 change_plan 表落地，**无偏离**：
- `finish(exitCode, spawnErrno?)` 签名扩展；close 路径 `finish(code ?? 1, undefined)`（spawnErrno 仅 error 事件透出，close 正常退出不填）。
- `reclaimStreams()` 仅 SIGKILL 兜底路径调用（timer 内 SIGTERM→500ms→SIGKILL 后），**不动 close 正常路径**（防丢最后字节输出）；try/catch + `?.` 幂等（已 destroy 的流 / stdio 非 pipe 配置不抛）。
- `child.unref()` 防 event loop 被 close 永不触发的 child 句柄拖住 hang。
- 详见 `specs/tech/agent/tools/[P0]bash_tools.md §4.5/§4.6` + 该 KB `log.md` v0.0.236 条目。

## 4. 代码↔spec 一致性核实（doc-modifier 阶段 5）

逐项核对「代码实现 == spec 契约」，**结论：无静默偏离**——

| 契约点 | 代码核实 |
|---|---|
| A `ShellResult.spawnErrno?: string` 可选字段 | `bash-engine.ts:35` 可选字段，type=string（开放集，非 union）✓ |
| A `finish` close 路径 spawnErrno=undefined | `bash-engine.ts:186` `child.on('close', (code) => finish(code ?? 1, undefined))` ✓ |
| A `child.on('error')` 透 errno | `bash-engine.ts:185` `finish(1, (err as NodeJS.ErrnoException)?.code)` ✓ |
| A bash.ts spawnErrno 前置 `[RUNTIME_ERROR] spawn XXX` | `bash.ts:138` `runtimePrefix = spawnErrno ? \`[${RUNTIME_ERROR}] spawn ${spawnErrno}\n\` : ''` ✓ |
| C `reclaimStreams()` 仅 SIGKILL 后调 | `bash-engine.ts:166`（SIGKILL 兜底 setTimeout 内）；close 路径 L186 不调 ✓ |
| C 不动 SIGTERM 优雅窗口 | `killTerm`（L140）只组杀 SIGTERM，500ms 内不 destroy（收集输出窗口保留）✓ |
| C `child.unref()` 防 hang | `bash-engine.ts:168`（SIGKILL 兜底后）✓ |
| B `raiseNofileLimit` 容错（posix 缺失静默） | `raise-nofile.ts` `loadPosixBinding()` try/catch 返 undefined → `{raised:false, newSoft:-1}` ✓ |
| B hard 不动 | `raise-nofile.ts` `setrlimit('nofile', {soft:newSoft, hard:current.hard})` 显式锁 hard ✓ |
| B 时序 runtime-config → raise-nofile → startBackend | `main.ts:121` `raiseNofileLimit(4096)` 在 loadRuntimeConfig 后、startBackend 前 ✓ |
| ②d node-gyp direct（非 @electron/rebuild） | `build-dmg.sh:226-241` node-gyp direct；偏离已在 §2.1 记录 ✓ |
| ②d 失败 exit 1（非 warn+skip） | `build-dmg.sh:243` rebuild 失败 exit 1；:248 .node 缺失 exit 1 ✓ |

## 5. spec 同步清单

- tech OKF：
  - `agent/tools/[P0]bash_tools.md`（§4.1 ShellResult.spawnErrno + §4.5 reclaimStreams + 新 §4.6 errno 透出）+ 该 KB `log.md` v0.0.236 条目。
  - `agent/tools/index.md` ④ 原则 #9 补「fd 回收解耦孙子生死 + spawn errno 透出」子条。
  - `app/package/[P0]packaging_toolchain.md`（新 §3.9 raise-nofile + §4.2 流程图补 ②c/②d native rebuild 步 + §4.3 场景 C/E 补 native dep 自检）+ 该 KB `log.md` v0.0.236 条目。
  - `app/package/index.md` ④ 加「packaged nofile 抬升 + native dep Electron ABI rebuild」原则。
- prd/api/ui：**无变更**（纯技术修复，无用户可感知行为/界面变化）。
- app-guide：**无更新**（无新功能/板块/操作路径）。
