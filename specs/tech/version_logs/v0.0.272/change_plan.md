# v0.0.272 变更计划书 — Chrome 进程泄漏治理（对账兜底回收）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（browser-orphan / browser-worker / browser-manager / et-env / test） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 架构裁决（8 条）

1. **孤儿识别 marker 纯函数**（D1）：`isRockyChromeMarker(cmdline)` = cmdline 含 `rocky-browser-worker-` / `rocky-browser-instance-`（user-data-dir 前缀）或含 `et<digits>-prof`（ET playwright user-data-dir）或 `--remote-debugging-port` ∈ [18800, 18899]（rocky CDP 段，cdp-port.ts 常量）。**白名单过滤，不是黑名单排除**——无 marker 一律跳过（attach 用户 Chrome 9222 不命中）。绝不用进程名匹配（用户主 Chrome 也是 chrome 名）。
2. **对账模型 = 活跃 pid 集合 + 全量扫描 diff**（D2）：活跃表 = 运行时 instances 的 `{chromePid, workerPid}` ∪ 持久化记录同字段；扫描 OS（ps -axo pid,ppid,command）筛 marker chrome → `isOrphanChrome` 三层判定（见 R3）→ 孤儿回收（kill 进程组 + 删 user-data-dir + unpersist 记录 + warn 日志）。**不依赖 launch/close 配对正确性**。
3. **孤儿判定三层（防误杀，关键）**：`isOrphanChrome(proc, ctx)` = ① pid ∈ 活跃 chromePidSet → 活跃；② ppid ∈ 活跃 workerPidSet → 活跃；③ ppid 进程 cmdline 含 `worker-entry`（rocky worker 专有，覆盖 **launch 中**——worker 已 spawn 但 handle 未入 instances 的窗口）→ 活跃；④ 否则 → 孤儿。**为什么三层**：新实例 chromePid 精确；旧记录（v0.0.272 前无 chromePid）靠 PPID=workerPid 兜底；launch 中 chrome 的 PPID 是 worker-entry node 进程（活着但不在表里）；真孤儿 chrome reparent 到 PPID=1（init cmdline 不含 worker-entry）→ 命中孤儿。
4. **chromePid 上报（协议小改，R3 数据源）**：launch 确认帧加 `chromePid`（worker-entry `browser.process()?.pid`）→ persistent-worker launchReady 透传 → WorkerHandle.chromePid + toRecord 持久化。**这是 close 兜底 + 对账精确判定的基础**；旧记录无 chromePid 由 R3 第②层 PPID 兼容。
5. **close 兜底修复（泄漏面 B 根因）**：chrome 是 detached 独立进程组（chrome-launcher spawn detached:true）——`killProcessGroupByPid(workerPid)` = kill(-workerPid) **杀不到 chrome**（不同进程组）。WorkerModeImpl.close 在 waitExit 超时后追加 `killProcessGroupByPid(chromePid)`（chrome 是组长，负 pid 杀 chrome 全家）。**这是「close 帧失败时 chrome 残留」的直接修复**。
6. **触发时机**（D3）：启动（cleanupOrphans 保持同步按记录 + 构造器末尾 fire-and-forget reconcileOrphans 扫描兜底，覆盖泄漏面 A 无记录孤儿）/ 周期（`setInterval(reconcile, deps.reconcileIntervalMs ?? 10min)` + `unref()` 不阻塞退出；PRD 建议 5-15min，取 10min）/ close 后（closeInstance 内 kill chromePid 后 `isPidAlive` 校验补 kill，轻量无全量扫描）。
7. **泄漏面 C（端口递增）已由 allocateCdpPort isBusy 真实探测覆盖**：孤儿 chrome 死后端口 OS 层释放，usedPorts 是内存态不回收孤儿端口，但 allocateCdpPort 每次 net 探测空闲即复用——**无需额外改动**（对账只负责杀进程 + 删目录）。
8. **ET env.sh 独立对账（server 管不到）**：ET chrome 是 executor 跑 playwright-cli 时才起的，**env.sh start 时拿不到 pid → D5「pidfile 补 chrome 行」改为 marker 扫描兜底**（PRD 实现方式修正）：`_ORPHAN_MARKERS` 扩充 `chrome|playwright|remote-debugging`（ET 端口段 43xxx/45xxx/46xxx 独占隔离，lsof 到该段 chrome 必是 ET 的，零误杀用户 Chrome）+ stop 补 ps 扫 `et<digits>-prof` marker kill + 删 `/tmp/et*-prof`（严格模式，不宽匹配）。pidfile 保持三行。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| browser-orphan | app/server/src/tools/browser/orphan-scan.ts | isRockyChromeMarker(cmdline) | 新增 | 纯函数：marker 判定（含 rocky-browser-worker-/rocky-browser-instance-/et<digits>-prof 或 --remote-debugging-port ∈ [18800,18899]） | MUST 白名单过滤（无 marker → false）；MUST 引用 cdp-port.ts CDP_PORT_RANGE_START/END 常量 | PRD D1/D7；cdp-port.ts L13-14 | +25 |
| browser-orphan | app/server/src/tools/browser/orphan-scan.ts | extractUserDataDir(cmdline) | 新增 | 纯函数：从 cmdline 提取 `--user-data-dir=...`（孤儿目录清理用）；解析失败返 null | MUST 只提取 rocky marker 目录（rmSync 前二次验证含 rocky-browser-/et*-prof 前缀，防误删） | PRD D4 | +15 |
| browser-orphan | app/server/src/tools/browser/orphan-scan.ts | scanRockyChromeProcesses(exec?) | 新增 | 异步：ps -axo pid,ppid,command → 解析 → 筛 isRockyChromeMarker → ChromeProcInfo[]（pid/ppid/cmdline/userDataDir） | MUST exec 可注入（测试 mock）；MUST ps 输出解析容错（坏行跳过） | PRD §3.2 | +30 |
| browser-orphan | app/server/src/tools/browser/orphan-scan.ts | isOrphanChrome(proc, ctx) | 新增 | 纯函数：三层判定（①pid ∈ chromePidSet ②ppid ∈ workerPidSet ③ppid cmdline 含 worker-entry ④否则孤儿） | MUST 三层顺序判定；MUST launch 中（worker-entry）不误杀；MUST 真孤儿（PPID=1）命中 | 本 change_plan 裁决 3 | +25 |
| browser-worker | app/server/src/tools/browser/worker-entry.ts | runPersistent() launch 确认帧 | 修改 | 确认帧加 chromePid：`emitLine({ ok:true, text:'launched', chromePid: browser.process()?.pid ?? undefined })` | MUST chromePid 缺省 undefined（老 worker 兼容）；MUST 单次模式（runOnce）不需要 | PRD §3.2；本 change_plan 裁决 4 | +1 |
| browser-worker | app/server/src/tools/browser/persistent-worker.ts | launchReady 透传 | 修改 | 确认帧解析加 chromePid 字段 → launchReady resolve 透传（BrowserExecuteResult 加 chromePid?） | MUST 缺省 undefined；MUST 不破坏既有 pending 路由 | 本 change_plan 裁决 4 | +3/-1 |
| browser-worker | app/server/src/tools/browser/types.ts | BrowserExecuteResult / WorkerResult / PersistedInstanceRecord | 修改 | 三类型加 `chromePid?: number` | MUST optional（向后兼容）；MUST PersistedInstanceRecord 旧记录无 chromePid 允许（readPersistedInstances 校验不强制） | PRD §3.2；instance-record.ts L33-38 | +3 |
| browser-worker | app/server/src/tools/browser/worker-mode-impl.ts | WorkerHandle.chromePid | 修改 | WorkerHandle 加 `chromePid?: number`；launch 成功后从 launchReady 读 chromePid 存 handle | MUST 仅在 launch 确认帧携带时赋值；MUST 旧路径（无 chromePid）不崩 | 本 change_plan 裁决 4 | +3 |
| browser-worker | app/server/src/tools/browser/worker-mode-impl.ts | close() 兜底 kill chrome | 修改 | waitExit 超时后追加 `killProcessGroupByPid(wh.chromePid!)`（chrome 是 detached 独立进程组，kill(-workerPid) 杀不到）；chromePid 缺省时保持现状 | MUST chromePid 存在才杀（旧 handle 无则跳过）；MUST 与 killProcessGroupByPid(workerPid) 并列（worker 组 + chrome 组都清） | PRD D6 泄漏面 B；本 change_plan 裁决 5 | +4 |
| browser-worker | app/server/src/tools/browser/instance-record.ts | toRecord() | 修改 | 持久化记录加 `chromePid: i.chromePid`（可选字段） | MUST 旧记录读取不受影响（readPersistedInstances 不强制 chromePid） | PRD §3.2 | +1 |
| browser-manager | app/server/src/tools/browser/instance-manager.ts | cleanupOrphans() 增强 | 修改 | 保持同步按记录清理（现有）；构造器末尾追加 `void this.reconcileOrphans().catch(warn)`（扫描兜底覆盖泄漏面 A 无记录孤儿） | MUST 记录清理逻辑不动（启动即清崩溃残留）；MUST reconcile 异步 fire-and-forget 不阻塞构造 | PRD §3.3 启动时；本 change_plan 裁决 6 | +3 |
| browser-manager | app/server/src/tools/browser/instance-manager.ts | reconcileOrphans() | 新增 | 对账主流程：活跃 chromePid/workerPid 集合（instances 全部含 starting/closing + 持久化记录）→ scanRockyChromeProcesses → isOrphanChrome diff → 孤儿逐个回收（killProcessGroupByPid(chromePid) + rmSync(userDataDir) + unpersistInstance + warn 日志 pid/cmdline 摘要） | MUST 活跃表含**全部** instances（含 starting/closing，防 launch/close 中误杀）；MUST 孤儿回收失败 catch warn 不中断；MUST 记 warn 日志（可观测） | PRD §3.2/§3.3；specs/tech/agent/tools/[P1]browser_instance_manager.md §4.8 | +55 |
| browser-manager | app/server/src/tools/browser/instance-manager.ts | 周期对账 interval | 修改 | 构造注册 `setInterval(reconcile, deps.reconcileIntervalMs ?? BROWSER_ORPHAN_RECONCILE_INTERVAL_MS)` + `unref()`；InstanceManagerDeps 加 `reconcileIntervalMs?`/`scanProcesses?`（测试注入） | MUST 默认 10min（常量 BROWSER_ORPHAN_RECONCILE_INTERVAL_MS = 10*60_000）；MUST unref（不阻塞进程退出）；MUST interval 可注入（测试 0/短值） | PRD §3.3 周期性；本 change_plan 裁决 6 | +8 |
| browser-manager | app/server/src/tools/browser/instance-manager.ts | closeInstance() 后兜底 | 修改 | kill chromePid 后 `isPidAlive(chromePid)` 校验，没死补 kill（轻量，无全量扫描） | MUST 仅本 key 相关 pid（不扫全量）；MUST chromePid 缺省跳过 | PRD §3.3 close 后 | +5 |
| et-env | tests/e2e/env.sh | _ORPHAN_MARKERS | 修改 | 扩充 `'index.ts|app/web|electron|bun|vite|chrome|playwright|remote-debugging'` | MUST 依赖 ET 端口段隔离（43xxx/45xxx/46xxx 独占，lsof 到该段 chrome 必是 ET 的，零误杀用户 Chrome） | PRD D5；env.sh L84 | +1 |
| et-env | tests/e2e/env.sh | cmd_stop() 补 chrome 清理 | 修改 | stop 流程补：①ps -axo 扫 `et<digits>-prof` marker chrome kill（不依赖端口）②删 `/tmp/et*-prof`（严格模式：ls -d 遍历验证 et 前缀 + -prof 后缀才删） | MUST 不宽匹配（不删 /tmp/chrome-* 等）；MUST 顺序在 pidfile kill 之后（避免父进程先死孤儿化子进程） | PRD D4/D5；env.sh L231-247 | +12 |
| et-env | tests/e2e/env.sh | 头注释 + usage | 修改 | 注释说明：pidfile 三行不含 chrome（start 时 playwright 未起无法记 pid）→ chrome 由 marker 扫描兜底 | MUST 注释更新（防后人误以为 pidfile 覆盖 chrome） | PRD D5；本 change_plan 裁决 8 | +2 |
| test | app/server/src/tools/browser/__tests__/orphan-scan.test.ts（新） | marker/判定/提取/diff 用例 | 新增 | isRockyChromeMarker 命中/排除（用户 Chrome 9222 不命中）；extractUserDataDir 提取/失败；isOrphanChrome 三层（chromePid 活跃 / PPID workerPid 活跃 / worker-entry launch 中 / PPID=1 孤儿）；scanRockyChromeProcesses mock exec | MUST 纯函数全覆盖；MUST 用户 Chrome 排除用例（D7） | PRD §7 UT；D7 | +45 |
| test | app/server/src/tools/browser/__tests__/instance-manager.test.ts | reconcileOrphans 用例 | 新增 | 活跃 chrome 跳过 / 孤儿回收（kill + rmSync + unpersist + warn）/ 旧记录 PPID 兼容 / launch 中 worker-entry 保护 / 周期 interval 触发（注入短间隔）/ close 后兜底 | MUST mock scanProcesses 注入；MUST 断言不误杀活实例 | PRD §7 UT；本 change_plan 裁决 2/3/6 | +50 |
| test | app/server/src/tools/browser/__tests__/worker-mode-impl.test.ts | chromePid + close 兜底用例 | 新增 | launch 确认帧带 chromePid → handle.chromePid 存值；close waitExit 超时 → killProcessGroupByPid(chromePid) 被调 | MUST FakeWorker launch 帧可带 chromePid；MUST close 兜底断言 chrome kill | 本 change_plan 裁决 4/5 | +20 |
| test | tests/e2e/env.sh | shell 手动验证 | 新增 | start/stop 一轮：ps 无 chrome/vite 残留 + /tmp/et*-prof 已清 + DATA_DIR 已删（executor 或手动验证） | MUST 不新增持久 case（env.sh 生命周期改动回归用既有 ET 冒烟） | PRD §7 验收 2 | +0 |

## 影响面评估

**跨模块**：browser-worker（协议 chromePid 上报）→ browser-manager（对账消费 chromePid + close 兜底）→ browser-orphan（新扫描层，被 manager 调用）→ et-env（独立 shell 对账）。依赖顺序：types 字段先落 → worker 上报 → manager 消费。

**破坏性变更**：worker 协议 launch 确认帧加可选 chromePid（老 worker/新 manager 兼容，缺省 undefined）；browser-instances.json 记录加可选字段（旧记录读取兼容，readPersistedInstances 校验不强制 chromePid）。

**风险点**：
1. **对账误杀活实例（最高风险）**：三层判定防误杀——chromePid 精确（新实例）/ PPID workerPid（旧记录）/ ppid worker-entry（launch 中）。**活跃表必须含全部 instances（含 starting/closing）**——launch/close 中 chrome 也算活跃。若仍有遗漏（异常 reparent 但 worker 活），后果 = 活 chrome 被杀 → launch 报错可重试（不损坏数据）。测试必覆盖「不误杀」用例。
2. **ps 扫描性能**：ps -axo 全量 ~10-50ms/次，10min 一次可忽略；启动 fire-and-forget 不阻塞 boot。
3. **ET marker 扩充安全**：`chrome|playwright|remote-debugging` 依赖 ET 端口段独占隔离（lsof 到 ET 段才验证 marker）——用户 Chrome 不监听 ET 段，零误杀。**不得**把 marker 用在端口段外全量扫描（会误杀用户 Chrome）。
4. **/tmp/et*-prof 删除安全**：严格 et 前缀 + -prof 后缀匹配，ls -d 遍历验证；绝不宽匹配（不删 /tmp/chrome-*）。
5. **旧记录兼容**：v0.0.272 前 browser-instances.json 无 chromePid → 对账第②层 PPID 兼容；close 兜底 chromePid 缺省跳过（老实例靠 worker close 帧正常路径 + 对账兜底）。
6. **周期对账与运行中实例竞态**：reconcile 撞 launch 中窗口（spawn→confirm ~1-2s，10min 周期 ≈ 0.3% 概率）→ 第③层 worker-entry 保护；撞 close 中（chrome 已 kill 但 handle 未删）→ chromePid 已在活跃表（含 closing）→ 不误杀。
7. **launch 中占位**：manager.launch 中 impl.launch 返回前 handle 未入 instances——reconcile 靠 ppid worker-entry 层保护；**不改 manager 状态机**（避免引入占位 handle 复杂度）。

**性能护栏**：ps 扫描 10min 一次 + 启动一次；close 后兜底仅本 key pid 校验（无全量扫描）；无新增 IO/订阅。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **对账误杀是红线**：任何对孤儿判定的改动（isOrphanChrome 三层顺序 / 活跃表含 starting-closing / ET marker 端口段隔离）必须先过「不误杀用户 Chrome + 不误杀活实例」双用例再合
