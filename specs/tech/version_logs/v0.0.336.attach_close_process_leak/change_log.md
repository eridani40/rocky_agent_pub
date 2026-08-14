# v0.0.336 change_log — attach close 进程残留 + launch 复用死连接修复

> 对应需求：`reqs/[working] v0.0.336.md` + bug-analyst 根因报告 `reports/bug-v0.0.336-attach-close-process-leak-2026-08-12.md`（leader 13:43 派单）。
> 权威契约：`specs/tech/version_logs/v0.0.336.attach_close_process_leak/change_plan.md`（G1-G6，frozen）。
> commits：`ec4b39b7c`（T1 主体）+ `ef84621e7`（T2 独立复审补防）。

## 变更摘要（已合并编码）

### 根因 1（P0）：close 不回收 MCP 进程组（mcp 主进程 + watchdog 残留）

- 根因链（实证）：close 只 disconnect + 删台账 + 残留检测，**不杀进程**；SDK `StdioClientTransport.close()` 只 SIGTERM/SIGKILL mcp 主进程（spawn 无 detached）；watchdog（`WatchdogClient.js:32-36`）`detached:true`+`unref()` 独立进程组，自杀依赖 stdin close，但 mcp 主进程被 SIGTERM 后 shutdown 卡 closeBrowser → stdin 不关 → **watchdog 孤儿残留**（老板 Chrome 卡「受自动测试软件控制」横幅）。
- `killProcessGroupByPid(mcpPid)` 杀的是 mcp 主进程的进程组；watchdog detached **不在该组内**，单靠它杀不到。

### 根因 2（P1）：launch 复用死连接 / 谎报成功 —— 真根因 = connect/disconnect cache key 不对称

- `connectAttachSession` 传 `{userDataDir}`（334 fix 注入），`disconnectAttachSession` 传 `{}` → cacheKey（`[profileName??null, userDataDir??null]`）**必不相等** → disconnect cache miss 直接 return，cache 永不清 → 下次 connect cache hit 直接 return 死 session 不 probe → launch 谎报。
- 引入时机：334 T1（03c0a7dbd）删 cdpUrl 把 disconnect 从 `{cdpUrl}` 改 `{}` + 334 fix（2545b939a）给 connect 注入 userDataDir，两者叠加。

## 实现核对（method 级）

| 计划项 | 实现一致性 |
|---|---|
| G1（disconnect 传 userDataDir 对称清 cache） | ✅ `disconnectAttachSession(driver, deps)` 用 `resolveDefaultChromeUserDataDir(deps)` 解析后 `driver.disconnect({userDataDir})`，与 connect 同一解析；失败仍 catch warn 不抛（幂等语义不变） |
| G2（resolveDefaultChromeUserDataDir 提模块级复用） | ✅ 模块级导出 `export function resolveDefaultChromeUserDataDir(deps: ConnectAttachDeps = {})`，依赖注入保留（UT mock existsSync/homedir/platform）；connect/disconnect 单一数据源 |
| ~~G3（cache hit 探活）~~ | ❌ **已砍**（见下「决策记录」）——cache hit 分支仍 `if (hit) return hit.session;` 不探活；G1/G2 修 key 对称后死连接复用路径已根除 |
| G4（close 显式回收 mcp 主进程组） | ✅ `AttachModeImpl.close`：`disconnectAttachSession` 后、`ledger.delete` 前，`ah.mcpPid !== undefined && isPidAlive(ah.mcpPid)` → `killProcessGroupByPid(ah.mcpPid)`（SIGKILL，best-effort try/catch） |
| G5（killOrphanMcpWatchdog 兜底） | ✅ 新增模块级 helper：`pkill -9 -f "chrome-devtools-mcp.*--parent-pid=${mcpPid}"`（execSync，best-effort）；mcpPid 已知才执行；仅 POSIX（win32 跳过）；`AttachKillDeps` DI 注入（isPidAlive/killProcessGroup/execPkill，UT mock 不真杀进程） |
| G6（cleanupOrphan 补 watchdog 兜底） | ✅ `cleanupOrphan(rec, env)`：`killProcessGroup(rec.workerPid)` 后补 `killOrphanMcpWatchdog(rec.workerPid)`（rec.workerPid 即 mcpPid），启动自检路径也回收 watchdog |

### 决策记录（G3 已砍，leader + review 确认）

G3 原计划在 cache hit 分支加 list_pages 探活防死连接复用。实际实现发现：**G1/G2 修 cache key 对称后，disconnect 能正常清 cache，死连接复用路径已被根除**——cache hit 只可能来自「本 run 内同 session 同 mode 的幂等复用」（connect 后未 disconnect 的合法复用），此时 session 必然活。再加探活属于防御纵深但引入每次复用多一次 MCP round-trip 开销，且跨 run 残留已被「启动自检清台账 + 失活自愈清账」覆盖。**裁决：不做 G3**，谎报根因由 G1/G2（key 对称）根治。

## 偏离记录（编码期新增，超出 change_plan G1-G6）

### 偏离 1：ModeImpl.close 返回 CloseResult（三层一致，leader 约束 2）

- **背景**：leader 定调「close = 风雨无阻、无条件清干净 + 诚实上报」——真实资源层（进程/连接）+ 记录层（driver cache + sqlite 台账）+ 感知层（不谎报）三层同步清，任何一步失败不中断整体清理（try/catch best-effort 全清），但失败要收集最终诚实上报（ok=false），不能默默吞掉后还删实例、报 ok。
- **实现**：
  - `mode-impl.ts`：`ModeImpl.close` 返回类型 `Promise<string | void>` → `Promise<CloseResult>`；新增 `CloseResult = {ok:true, text?} | {ok:false, error:{kind?, message}}`。
  - `attach-mode-impl.ts`：close 收集 `failures[]`（disconnect / kill / pkill / ledger.delete 各步 try/catch best-effort），任一失败 → `{ok:false, error:{kind:'close_incomplete', message: failures.join('; ')}}`；全清成功 → `{ok:true, text: tip}`。
  - `instance-manager.ts` `closeInstance`：impl.close ok=false 或抛错 → **不删 instances**（保留表项可重试）+ warn；`manager.close` catch → `{ok:false, error:{kind:'close_incomplete', message:'close 清理不完整（实例保留可重试）: ...'}}`，不穿透调用方。
  - `worker-mode-impl.ts`：close 适配 `{ok:true}`（worker 路径语义不变）。
- **api 契约变化**：close 清理失败 → `close_incomplete` 错误（isError=true），不删实例可重试（见 `specs/api/overall/08-web-tools.md` §4.3）。

### 偏离 2：execute/idle 收尾 closeInstance 防御 catch（独立复审裁决，T2 commit ef84621e7）

- closeInstance 可抛（ok=false 转 throw）→ 两处调用补 try/catch：
  - `execute` 失活收尾（instance-manager.ts:246）：清理失败不逃逸出 execute，catch 住保留表项可重试，返回原 r（attach_lost/worker_crashed 预期文案），不降级 RUNTIME_ERROR。
  - `assertReadyInstance` idle timeout（:295）：同样 catch 住，仍返回 idle_timeout 预期文案。
- 纯防御 catch（无对外语义变化），对齐 launch 前清理/releaseKeys 既有写法。

## 已知缺陷（本版不做）

（无新增；close 残留检测仍只覆盖默认 user data dir（`[v0.0.330]` Minor 边界），非默认目录 Chrome 漏报——保守方向，不误报优先。）

## 关键文件（编码产出）

| 文件 | 变更 |
|---|---|
| `app/server/src/tools/browser/attach-instance.ts` | G1/G2：disconnect 传 userDataDir + resolveDefaultChromeUserDataDir 提模块级 |
| `app/server/src/tools/browser/attach-mode-impl.ts` | G4/G5/G6：close 显式回收进程组 + killOrphanMcpWatchdog + cleanupOrphan 补强；CloseResult 三层一致（failures[] 收集） |
| `app/server/src/tools/browser/mode-impl.ts` | CloseResult 类型 + ModeImpl.close 签名升级 |
| `app/server/src/tools/browser/instance-manager.ts` | closeInstance 失败不删表 + manager.close close_incomplete + execute/idle 防御 catch |
| `app/server/src/tools/browser/worker-mode-impl.ts` | close 适配 CloseResult（{ok:true}） |
| `app/server/src/tools/browser/__tests__/{attach-instance,attach-mode-impl,instance-manager}.test.ts` | UT：cache key 对称 +2；G4/G5/mcpPid undefined/三层一致失败上报 +4；cleanupOrphan DI 断言改 3；closeInstance 抛错不删表 +2；全量 10379 passed 零回归 |

## 文档同步

- **tech OKF KB**：`specs/tech/agent/tools/[P1]browser_instance_manager.md`（§4.3 close 契约 CloseResult + 三层一致 + 5 步流程 + 文件头注记）+ `[P1]browser_tool.md`（§4.1 cache key 对称 + close 链 + §4.2 接入段 CloseResult）+ `specs/tech/agent/tools/log.md`（本条目）。
- **api**：`specs/api/overall/08-web-tools.md`（§4.2 close 行 + §4.3 close_incomplete 分支 + 生命周期语义 + 版本尾注 1.7）。
- **change_plan**：G3 标注已砍 + 决策记录（本文件 `change_plan.md`）。
