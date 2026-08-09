# v0.0.272 PRD — Chrome 进程泄漏治理（对账兜底回收）

> 版本主题：Rocky 起的 Chrome 进程（browser worker + ET）成孤儿泄漏，干扰用户主 Chrome。治理 = 全量对账回收（不靠 launch/close 绝对配对）。
> 产出：`specs/prd/version_logs/v0.0.272.chrome_orphan_leak/prd.md`

## 1. 背景与问题

### 1.1 事故（2026-08-06 15:45 老板报告）
- **9 个 `rocky-browser-worker-*` headless Chrome 孤儿进程**（remote-debugging-port 18800-18826 **一路递增** = 反复 launch 未成对 close）+ **1 个 ET playwright Chrome**（--no-sandbox, port 9333, user-data-dir=/tmp/et214-prof）+ 一批 `rocky-browser-worker-*` 临时目录残留。
- 用户主 Chrome（pid 70418）被**同 binary 多实例 + 调试端口占用**干扰（看不到/关不掉）。
- 当时手动 kill 9+1 进程 + 清临时目录恢复。

### 1.2 根因方向（req + bug 单 + 代码核实）
launch/close 不成对 + **无孤儿检测回收对账**：

1. **browser 工具 worker（headless/managed-profile）**：
   - `BrowserInstanceManager` 构造时 `cleanupOrphans()` 只按**持久化记录**（`browser-instances.json`）清理——`readPersistedInstances` → 每条 rec 分发 `impl.cleanupOrphan`。
   - **泄漏面 A：没 persist 的孤儿**。若 launch 后 persist 失败 / 记录被删 / 异常路径未写记录 → 该 worker pid 不在记录里 → 启动对账**扫不到** → 永久孤儿。
   - **泄漏面 B：cleanupOrphan 只杀 rec.workerPid 进程组**。若 worker 已死但 chrome 子进程被 reparent（PPID=1）成孤儿、且 pid 与记录不符 → 漏。
   - **泄漏面 C：端口递增 18800+** = 反复 launch 未成对 close，`usedPorts` 只回收显式 close 路径，孤儿进程占的端口永远不回表。

2. **ET env.sh**：
   - pidfile 只记 **server / web / electron 三行**，**不记 playwright chrome pid** → stop 精确 kill 覆盖不到 chrome。
   - `_ORPHAN_MARKERS='index.ts|app/web|electron|bun|vite'` —— **不含 chrome / playwright** → `_kill_port_orphans` 按端口 lsof 到 chrome 也不会杀（marker 验证不过）→ ET chrome 残留。
   - 临时目录 `/tmp/et*-prof`（playwright chrome user-data-dir）不在 DATA_DIR 里，stop 删不到。

### 1.3 治理方向（老板确认）
- **对账兜底（参考 fs watch 全量 diff 思路）**：启动时/周期性扫描「rocky-browser-worker / ET chrome」类进程，**凡不在当前活跃实例表里的孤儿一律回收**——防泄漏收敛，不靠 launch/close 绝对配对。
- **临时目录连带清理**：进程回收时同步清 `rocky-browser-worker-*` / `rocky-browser-instance-*` / `et*-prof`。
- **审计 close 链路**：WorkerModeImpl close / InstanceManager cleanupOrphan / env.sh stop 三处 pid 精确 kill 覆盖。
- **安全边界**：只清 rocky 起的、**带 rocky marker** 的进程，**绝不动用户主 Chrome**。

## 2. 核心产品决策

| ID | 决策 | 理由 |
|----|------|------|
| D1 | **孤儿识别 = rocky marker，不用进程名匹配** | 用户主 Chrome 也是「Google Chrome」进程名，按名匹配必误杀。marker = cmdline 特征：`rocky-browser-worker-*` / `rocky-browser-instance-*` / `et*-prof` 出现在 user-data-dir；或 remote-debugging-port 落在 rocky 分配段。 |
| D2 | **对账模型 = 活跃实例表 + 全量进程扫描 diff** | 活跃表 = manager.instances（key→pid）+ 持久化记录 + ET pidfile。扫描 OS 进程 → 命中 rocky marker 且不在活跃表 → 孤儿 → 回收。不依赖 launch/close 配对正确性。 |
| D3 | **触发时机 = 启动时（已有）+ 周期性 + close 后兜底** | 启动对账管「上次崩溃残留」；周期性管「运行中泄漏」；close 后对账管「本次 close 遗漏」。周期值架构期定（建议 5-15min）。 |
| D4 | **临时目录连带清理** | 回收进程时同步删其 user-data-dir（rocky-browser-worker-*/rocky-browser-instance-*/et*-prof），避免磁盘堆积。 |
| D5 | **ET env.sh 补 chrome pid 记录 + marker 扩充** | pidfile 增加 playwright chrome 行；`_ORPHAN_MARKERS` 增加 chrome/playwright marker；stop 精确 kill 覆盖 chrome。 |
| D6 | **三处 close 链路审计对齐** | WorkerModeImpl close（已有 killProcessGroup+rmSync+releasePort+unpersist，OK）/ InstanceManager cleanupOrphan（从「按记录」增强为「全量扫描」）/ env.sh stop（补 chrome）。 |
| D7 | **只动 rocky marker 进程，用户主 Chrome 零接触** | 对账扫描按 marker 白名单过滤；非 rocky marker 一律跳过（含用户手动开的 --remote-debugging-port Chrome）。 |

## 3. 功能需求

### 3.1 孤儿识别标准（D1）
扫描 OS 进程（`ps -axo pid,ppid,command` 或等价）时，**候选孤儿 = cmdline 命中任一 rocky marker**：
- `rocky-browser-worker-`（node-worker-driver mkdtemp 前缀）
- `rocky-browser-instance-`（worker-mode-impl headless mkdtemp 前缀）
- `et*-prof`（ET playwright chrome user-data-dir 模式，如 et214-prof）
- remote-debugging-port 落在 rocky 分配 CDP 段（架构期与 cdp-port.ts 对齐，18800 段是事故现场，正式段号以实现为准）

**排除**：无 marker 的 Chrome / Chromium / Edge 进程一律不动（用户主 Chrome、用户手动调试实例、其他应用内嵌浏览器）。

### 3.2 对账回收流程（D2）
```
对账触发（启动/周期/close 后）
  → 构建活跃实例表：manager.instances（key→workerPid）+ 持久化记录 + ET pidfile 里的 chrome pid
  → 扫描 OS 进程，筛 rocky marker 候选
  → diff：候选 ∉ 活跃表 → 孤儿
  → 回收每个孤儿：kill 进程组（负 pid SIGKILL）→ 删其 user-data-dir → 若占 rocky CDP 端口则释放
  → 记 warn 日志（可观测：清了几个孤儿、pid、cmdline 摘要）
```

### 3.3 触发时机（D3）
- **启动时**：保留现有 `cleanupOrphans()`（按记录），**增强为「记录 + 全量扫描」双源对账**（记录覆盖崩溃残留，扫描覆盖无记录孤儿）。
- **周期性**：新增定时对账（建议 5-15min，架构期定；可复用 manager 已有 idle 检查节奏）。
- **close 后兜底**：`closeInstance` 完成后跑一次轻量对账（仅本 key 相关 pid 校验，确认进程树已清）。

### 3.4 临时目录连带清理（D4）
- 进程回收 → 删 `rocky-browser-worker-*` / `rocky-browser-instance-*`（browser worker 侧，现有 close/cleanupOrphan 已有 rmSync，对账新增路径同样带上）。
- ET 侧：env.sh stop 删除 `/tmp/et*-prof`（playwright chrome user-data-dir 模式匹配，只删 et 前缀的 rocky 临时目录）。

### 3.5 ET env.sh 增强（D5）
- **pidfile 补 chrome 行**：start 时把 playwright chrome 的 pid 也写入 pidfile（或独立 chrome pidfile）。
- **`_ORPHAN_MARKERS` 扩充**：增加 chrome 相关 marker（如 `playwright|chrome.*et.*prof|remote-debugging` 的 rocky 组合），使 `_kill_port_orphans` 能清 ET chrome 孤儿。
- **stop 精确 kill 覆盖**：倒序 kill 含 chrome；二次 SIGKILL 同样覆盖。
- **临时目录清理**：stop 删 `/tmp/et*-prof`（只删匹配 et 前缀的 rocky 临时目录，绝不宽匹配）。
- **start 前预清**：复用 `_kill_port_orphans` 在 start 时清端口段残留（已有），确保 chrome marker 扩充后能清 ET chrome 残留。

### 3.6 三处 close 链路审计（D6）
| 路径 | 现状 | 本版本动作 |
|------|------|-----------|
| WorkerModeImpl.close | 发 close 帧 → waitExit 3s → killProcessGroup → headless rmSync → releasePort → unpersist（**已有，OK**） | 保持；确认失败路径（launch 失败/超时）同样走 close 三要素（代码已覆盖） |
| InstanceManager.cleanupOrphans | 只按持久化记录分发 cleanupOrphan | **增强为全量扫描对账**（记录 + 进程表双源） |
| env.sh stop | pidfile 三行 + marker 无 chrome | **补 chrome pid + marker 扩充 + et*-prof 清理** |

### 3.7 安全边界（D7）
- 回收对象必须命中 rocky marker（D1 标准），**白名单过滤，不是黑名单排除**——没 marker 的进程绝不动。
- attach 模式（AttachModeImpl）不持久化、不杀用户 Chrome（现有实现已遵守，对账扫描也不应把 attach 的 user Chrome 当孤儿）。
- 对账日志记录所有回收动作（可审计），误杀风险 = 0（marker 白名单）。

## 4. 关键用户路径

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 反复 launch/close browser 工具（headless 5+ 轮）→ `ps -axo pid,ppid,command \| grep rocky-browser` | 无 `rocky-browser-worker-*` / `rocky-browser-instance-*` 孤儿进程残留 |
| UC-2 | ET `env.sh start <cid>` → 跑 case → `env.sh stop <cid>` → `ps` + `ls /tmp` | 无 playwright chrome / vite 子进程残留 + 无 `/tmp/et*-prof` 残留 + DATA_DIR 已删 |
| UC-3 | 用户主 Chrome 开着（正常使用）→ 触发对账（启动/周期） | 用户主 Chrome **不受影响**（无 marker → 不碰），照常可用 |
| UC-4 | 人为制造崩溃残留（kill worker 父进程、chrome reparent 成孤儿 + 记录存在）→ 重启 Rocky | 启动对账回收全部残留进程 + 临时目录（记录 + 扫描双源覆盖） |
| UC-5 | 运行中故意漏 close（模拟泄漏）→ 等周期性对账触发 | 孤儿被周期对账回收，端口/临时目录同步释放 |

## 5. 概念对齐

- **BrowserInstanceManager**（`app/server/src/tools/browser/instance-manager.ts`，198 行）：构造即 `cleanupOrphans()` + shutdown hook——本版本核心改动点（对账模型落这里）。
- **ModeImpl.cleanupOrphan**（`mode-impl.ts` L85 可选方法）：现有按 rec 分发——增强为扫描对账的 hook。
- **WorkerModeImpl**（`worker-mode-impl.ts`）：close 三要素（killProcessGroup / headless rmSync / releasePort / unpersist）已有，保持。
- **persistent-worker / node-worker-driver**：worker 协议 + mkdtemp `rocky-browser-worker-` 前缀——marker 来源。
- **ET env.sh**（`tests/e2e/env.sh`，297 行）：pidfile 精确 kill + `_ORPHAN_MARKERS` + `_kill_port_orphans`——补 chrome 覆盖。
- **spec 权威源**：`specs/tech/agent/tools/[P1]browser_instance_manager.md`（§4 泄漏防护 + §4.7 开机自检 + §4.8 泄漏路径对照表）+ `[P1]browser_tool.md`。

## 6. 边界 / 不做

- **不做** launch/close 配对强校验（配对是理想，对账是兜底——本版本只做对账，不额外要求配对日志）。
- **不做** 磁盘级全量扫描 `/tmp` 找所有 chrome 目录（只清进程回收时连带 + 对账回收时删）。
- **不做** attach 模式增强（attach 不杀用户 Chrome 语义保持，对账不把 user Chrome 当孤儿）。
- **不做** ET case 改造（env.sh 生命周期增强，case 内容零改动）。
- **不碰** 用户主 Chrome / 用户手动开的调试 Chrome（marker 白名单外一律跳过）。

## 7. 验收口径

1. **能力不变量**：
   - 反复 launch/close browser 工具后，`ps` 无 rocky marker chrome 孤儿残留（UC-1）。
   - ET env.sh start/stop 后，无 chrome/vite 残留 + `/tmp/et*-prof` 已清（UC-2）。
   - 对账扫描只回收 rocky marker 进程，用户主 Chrome 零接触（UC-3）。
2. **回归不变量**：
   - browser 工具正常 launch/execute/close 功能不变（UT 回归）。
   - attach 模式不杀用户 Chrome（现有测试回归）。
   - ET 冒烟 case 正常跑通（env.sh 生命周期改动回归）。
3. **UT 必须**（进程生命周期改动）：
   - 对账 diff 逻辑（活跃表 vs 扫描结果 → 孤儿集合）
   - marker 匹配（rocky marker 命中 / 用户 Chrome 不命中）
   - cleanupOrphans 双源（记录 + 扫描）
   - env.sh pidfile chrome 行 + marker 扩充（shell 测试或手动验证）
4. **AT/ET**：按测试标准——本版本是进程生命周期改动，涉及 browser 工具 + ET env，跑相关已有 case（browser 工具 AT / ET 冒烟）验证不破坏主链路；是否新增 case 由 orchestrator 按「核心冒烟集」纪律裁决。

## 8. spec 对齐备忘

- `specs/tech/agent/tools/[P1]browser_instance_manager.md`：§4 泄漏防护 → 增「对账兜底（全量扫描 diff）」；§4.7 开机自检 → 从「按记录」改「记录 + 扫描双源」；§4.8 泄漏路径对照表 → 补「无记录孤儿」行。
- `specs/tech/agent/tools/[P1]browser_tool.md`：进程生命周期 → 补对账回收说明。
- `tests/e2e/env.sh` 头注释 → 补 chrome pid 记录 + marker 说明。
- 涉及架构决策（周期值、扫描实现、CDP 段定义）在 change_plan 细化。

## 9. 版本总结

- **问题**：Rocky 起的 Chrome 进程成孤儿泄漏（browser worker 反复 launch 未 close + ET chrome 不在清理范围），干扰用户主 Chrome。
- **方案**：对账兜底回收 = 活跃实例表 + 全量进程扫描 diff（D2），rocky marker 白名单识别（D1），启动/周期/close 后三时机触发（D3），临时目录连带清理（D4），ET env.sh 补 chrome 覆盖（D5），三处 close 链路审计（D6），用户主 Chrome 零接触（D7）。
- **关键用户路径**：反复 launch/close 无孤儿 / ET start/stop 无残留 / 不误伤主 Chrome / 崩溃残留启动自愈 / 运行中泄漏周期收敛。
