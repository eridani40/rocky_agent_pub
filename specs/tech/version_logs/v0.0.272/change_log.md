# v0.0.272 tech change log — Chrome 进程泄漏治理（对账兜底回收）

> 对应需求：`reqs/[working] v0.0.272/req.md`（BUG-chrome-orphan-process-leak）。
> 权威契约：`specs/tech/version_logs/v0.0.272/change_plan.md`（8 裁决，frozen）。

## 变更摘要

### 需求与动机

Rocky 起的 Chrome（browser worker + ET）成孤儿泄漏（9 个 rocky-browser-worker-* headless + 1 个 ET playwright chrome，端口 18800+ 递增），干扰用户主 Chrome。根因：泄漏面 A（persist 失败/异常 → 无记录孤儿，开机自检扫不到）+ 泄漏面 B（chrome detached 独立进程组，kill(-workerPid) 杀不到）+ ET（pidfile 三行不含 chrome + marker 不含 chrome）。治理 = 对账兜底回收：活跃实例表 + 全量进程扫描 diff，不在表里的 rocky marker 孤儿一律回收（不靠 launch/close 绝对配对）。

### 方案（8 架构裁决，详见 change_plan「架构裁决」）

1. **孤儿识别 marker 纯函数**（D1）：isRockyChromeMarker(cmdline) = 含 rocky-browser-worker-/rocky-browser-instance-/et<digits>-prof 或 --remote-debugging-port ∈ [18800,18899]。**白名单过滤不是黑名单排除**——无 marker 一律跳过（attach 用户 Chrome 9222 不命中）；绝不用进程名匹配。
2. **对账模型 = 活跃 pid 集合 + 全量扫描 diff**（D2）：活跃表 = 运行时 instances 的 {chromePid, workerPid} ∪ 持久化记录同字段；扫描 OS 筛 marker chrome → 三层判定 → 孤儿回收（kill 组 + 删 user-data-dir + unpersist + warn）。**不依赖 launch/close 配对正确性**。
3. **孤儿判定三层防误杀**（D3）：①pid∈chromePidSet ②ppid∈workerPidSet（旧记录无 chromePid 兼容）③ppid cmdline 含 worker-entry（launch 中保护）→ 否则孤儿。活跃表**必须含全部 instances（含 starting/closing）**。
4. **chromePid 上报**（D4）：launch 确认帧加 chromePid → launchReady 透传 → WorkerHandle.chromePid + toRecord 持久化（旧记录兼容）。
5. **close 兜底修复**（D5，泄漏面 B 根因）：chrome detached 独立进程组，kill(-workerPid) 杀不到 → close 末尾统一 isPidAlive(chromePid) 校验补 killProcessGroupByPid(chromePid)（负 pid 杀全家）。
6. **触发时机**（D6）：启动（记录同步 + fire-and-forget reconcile 扫描兜底）/ 周期 10min setInterval unref / close 后 isPidAlive 校验补 kill。
7. **泄漏面 C 已覆盖**（D7）：孤儿 chrome 死后端口 OS 释放，allocateCdpPort isBusy 探测自动复用——无需额外改动。
8. **ET env.sh 独立对账**（D8）：marker 扫描兜底（_ORPHAN_MARKERS 扩充 chrome|playwright|remote-debugging 仅 ET 端口段内用 + stop ps/pgrep 扫 et<digits>-prof + 删 /tmp/et*-prof 严格模式）。

### T1 — server 对账（commit 0020837e9 等）

- **`orphan-scan.ts`（新，162 行）**：isRockyChromeMarker（marker 白名单）/ extractUserDataDir（rmSync 前二次验证 rocky 前缀）/ scanRockyChromeProcesses（**双段 ChromeScanResult{all,candidates}**——C1 修复：all=全量进程表建 procByPid 供第三层 ppid 反查 worker-entry，candidates=marker chrome 回收判定对象）/ isOrphanChrome（三层判定）/ buildOrphanCtx。
- **chromePid 上报链路**：worker-entry launch 确认帧加 chromePid（browser.process()?.pid ?? undefined）→ persistent-worker launchReady 透传 → types.ts 三类型加 chromePid? → WorkerHandle.chromePid → instance-record toRecord 持久化（可选字段，旧记录不强制）。
- **`instance-manager.ts`**：reconcileOrphans（活跃集合含 starting/closing + 记录 + 双段扫描 diff 回收 kill+rm+unpersist+warn）+ 构造器 fire-and-forget 扫描兜底 + 10min 周期 setInterval unref + close 后兜底；InstanceManagerDeps 加 reconcileIntervalMs?/scanProcesses?（测试注入）。
- **`worker-mode-impl.ts`**：close 末尾统一 isPidAlive(chromePid) 补 kill（覆盖 waitExit 超时 / worker 崩溃 / 正常退出但 chrome 残留）+ chromePid 清后防重复；cleanupOrphan chromePid 优先/旧记录 workerPid 退回。

### T2 — ET env.sh 对账（commit + ET 冒烟回归 C1）

- **`_ORPHAN_MARKERS`** 扩充 chrome|playwright|remote-debugging（仅 ET 端口段内用——_kill_port_orphans 先 lsof ET 段端口再验证 marker，用户 Chrome 不监听 43xxx/45xxx/46xxx 零误杀）。
- **cmd_stop 补 `_cleanup_et_chrome`**（顺序在 pidfile kill 后）：pgrep -f et<digits>-prof kill（TERM→SIGKILL 两轮）+ 删 /tmp/et*-prof 严格模式（`^et[0-9]+-prof$` 正则双验证，不宽删）。
- **清理函数拆 `tests/e2e/lib/et-chrome-cleanup.sh`**（偏离①：coversFiles 外新增——env.sh 297 基线 + 预计 312 超 300 硬约束，拆 lib 守拆分精神，env.sh 最终 305 优于契约；MUST 约束全保持）。
- **`_pid_cmdline_matches`**（C1 修复）：ps 优先 fallback pgrep -f 反查 pid（seatbelt 沙箱 ps exit 126 → pgrep 可用）。

### 测试

`orphan-scan.test.ts`（marker 命中/排除用户 Chrome 9222/extract/三层判定/双段扫描 mock）+ `instance-manager.test.ts` reconcile 用例（活跃跳过/孤儿回收/旧记录 PPID 兼容/launch 中 worker-entry 保护/周期触发/close 兜底）+ `worker-mode-impl.test.ts`（chromePid 存值 + close 兜底 kill 断言）+ ET lib UT 15（真实进程级断言 exec -a 造假进程）。

## 代码↔spec 核实（doc-modifier 阶段 5，6 项）

| # | 契约点 | 核实结果 |
|---|--------|----------|
| 1 | marker 白名单不误杀用户 Chrome | ✅ isRockyChromeMarker 白名单过滤非黑名单（无 marker 一律 false）；attach 用户 Chrome 9222 段不命中；绝不用进程名匹配 |
| 2 | 活跃表含 starting/closing | ✅ reconcileOrphans 遍历 instances.values()（含 starting/closing 态 handle）+ 持久化记录同字段 |
| 3 | 三层判定 | ✅ isOrphanChrome：①pid∈chromePidSet ②ppid∈workerPidSet ③ppid cmdline 含 worker-entry（procByPid 全量反查，C1 修复）④否则孤儿 |
| 4 | detached 进程组 kill | ✅ close 末尾统一 isPidAlive(chromePid) 校验补 killProcessGroupByPid（负 pid 杀全家）；cleanupOrphan chromePid 优先/旧记录 workerPid 退回 |
| 5 | ET 端口段隔离 | ✅ ET API 43xxx/WEB 45xxx/CDP 46xxx 与 AT 42xxx/44xxx 分离；_ORPHAN_MARKERS 只在 ET 段内用（_kill_port_orphans 先 lsof ET 段端口再验证 marker） |
| 6 | /tmp 严格模式 | ✅ et-chrome-cleanup.sh `[[ "$base" =~ ^et[0-9]+-prof$ ]]` 严格正则双验证 + return 0 防护（set -e 不中断）；绝不宽删 /tmp/chrome-* |

## 偏离记录

1. **清理函数拆 lib（coder2 偏离①）**：`tests/e2e/lib/et-chrome-cleanup.sh` coversFiles 外新增——env.sh 297 基线 + change_plan 预计 312 超 300 硬约束，拆 lib 守拆分精神（env.sh 最终 305，C1 后 review 合理豁免——~20 行注释，逻辑 ~250 行）；MUST 约束全保持。**流程提醒**：coversFiles 外新增 lib + test 文件，需 orchestrator 补记 task.json。
2. **close 兜底改为 close 末尾统一 isPidAlive 校验（coder3 偏离）**：不依赖 waitExit 超时判断——worker 崩溃 exitCode≠null 但 chrome 残留场景也覆盖，比契约覆盖更全（等价合理）。
3. **cleanupOrphan chromePid 精确杀组（coder3 偏离）**：旧记录退回 workerPid（等价合理）。
4. **reconcile 活跃集读 handle 私有 pid**：架构裁决②显式要求 active set 含 instances，此处是「不读 handle 私有字段」的受控例外（代码注释已说明）。

## 文档同步（doc-modifier T3）

- `specs/tech/agent/tools/[P1]browser_instance_manager.md`：§3.1/§3.2/§4.1/§4.6/§4.7（双源自检）/§4.8（补无记录孤儿行）/§4.9（对账兜底新节）/§9（T4 清单）+ 头部注记。
- `specs/tech/agent/tools/[P1]browser_tool.md`：§5 生命周期补孤儿 chrome 对账回收说明 + frontmatter updated。
- `specs/tech/agent/tools/index.md`：browser_tool/browser_instance_manager 导航行加 v0.0.272；`log.md` 加 v0.0.272 条目。
- `specs/ui/overall/00-app-guide.md`：**不适用**——对账是服务端内部机制，无用户可感知行为变化。
