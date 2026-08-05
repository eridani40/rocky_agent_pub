---
type: spec
title: Bash Tool
priority: P0
status: active
updated: 2026-08-01
since: v0.0.8
---

# Bash Tool

Shell 命令执行工具 `bash`。协议参考 Claude Code（Bash）。由 tool_execution_engine 调度。
类型 / 共性约定（专用工具优先于 bash）见 `index.md §①/§④`。

## 1. 概述

bash 工具让 agent 执行 shell 命令（构建 / 测试 / 运行 / 系统操作）。涉及持久 shell、超时、后台、沙箱、输出截断。

## 2. bash

```typescript
interface BashInput {
  command: string;            // 必填，shell 命令（可含管道 / && / 引号）
  description: string;        // 必填，人类可读描述（5-10 词，说明做什么）
  timeout?: number;           // 毫秒，默认 120000，最大 600000（10 分钟）
  runInBackground?: boolean;  // 默认 false
  // [v0.0.122] dangerouslyDisableSandbox 字段删除（死字段，且与执行层安全模型冲突）
}
```

**行为**：
- **持久 shell 会话**：工作目录在调用间持久（`cd` 在复合命令中可能触发权限提示，优先用绝对路径）；shell 状态（env / 函数）**不持久**，每次从用户 profile 初始化
- **[v0.0.101] cwd = `session.workspaceDir`（外层绝对，不多层）**：旧实现 `join(base,'workspace')` 多套一层致「reminder 告知路径 ≠ 工具实际落盘路径」。修复后 cwd 直接 = `ctx.workdir`（= session.workspaceDir = `workspaces/<id>`）；description 同步为 `default <workdir>`。file 工具（write/read/edit/glob/grep）本就绝对路径（`isAbsolute` 校验 + `PATH_NOT_ABSOLUTE`），零改动。LLM 按 reminder 给的 workspaceDir 自己拼绝对路径。
- **职责边界**：用于 git/npm/docker 等终端操作。**禁止**用 bash 做文件读/写/编辑/搜索/查找 —— 必须用专用工具（read/write/edit/glob/grep）；即禁止 `cat`/`head`/`tail`/`sed`/`awk`/`echo`/`find`/`grep`/`rg`（除非显式指示或确无替代）
- **目录验证**：创建新目录/文件前先 `ls` 验证父目录存在
- **路径引号**：含空格路径必须双引号
- **超时**：超时后**整个进程组**被 SIGTERM→500ms→SIGKILL 组杀（含 shell 派生的孙进程，见 §4.5）；长命令显式 timeout 或改后台。**[v0.0.130.hang]** 超时文本走统一契约 `[timeout] bash exceeded <ms>ms`（+ 部分输出），与 engine backstop 同前缀（见 `tool_execution_engine.md §4.2`）
- **后台**：runInBackground=true 立即返回 taskId，输出写临时文件，后续可读/监控；进程跨轮持续
- **[v0.0.122] 沙箱**：默认在 seatbelt 沙箱内执行（macOS，见 §4）。`dangerouslyDisableSandbox` 字段**移除**（BashInput schema 删除）——v0.0.8 起从未消费（纯声明死字段），且「LLM 自请求关沙箱」与本版安全模型冲突（沙箱是执行层最后一道兜底，不应由被约束方自行关闭）。故不消费、不保留，直接删。

**输出**：
- 前台：stdout + stderr 合并 + 退出信息；超 `MAX_OUTPUT_CHARS` 截断
- 后台：返回 taskId（输出异步写文件）
- 退出码非 0 → isError

**错误**：
- 超时 → 进程组组杀（SIGTERM→500ms→SIGKILL），输出截断，isError（文本统一 `[timeout] bash exceeded <ms>ms` 前缀，§4.5）
- 退出码非 0 → isError（含退出码）
- 权限拒绝（沙箱/规则）→ error
- 交互式 flag（`git rebase -i` / `git add -i`）不支持
- 输出过长 → 截断（信息可能丢失，需分页或重定向文件再 read）

## 3. 边界

| 零件 | 归属 |
|---|---|
| bash 协议（input + 行为 + 输出 + 错误） | 本文 ✅ |
| 执行层（BashEngine / SecureBashEngine / seatbelt）| 本文 §4 ✅ |
| 子进程组杀（detached + killProcessGroup + registry register/unregister）| 本文 §4.5 ✅ |
| escaped-grandchild pipe fd 回收（reclaimStreams）+ spawn errno 透出 | 本文 §4.6 ✅ |
| bash 策略层（checkPermission 两条策略）| 本文 §5 ✅ |
| 通用类型 + 共性约定（专用工具优先于 bash） | `index.md` |
| 执行（调度/HITL 钩子）+ 过大输出截断 | `tool_execution_engine.md` / `../context/`（tool_result_truncate） |
| PermissionDecision / checkPermission 契约 / ApprovalManager / 审批回填 | `[P0]tool_permission.md` |

## 4. 执行层 — BashEngine + SecureBashEngine + seatbelt [v0.0.122]

> **设计原则**：bash tool 与执行引擎**职责分离**——bash tool 只引用 `BashEngine.exec()`，安全策略挂在 engine。**改/加安全策略 = 改 SecureBashEngine 的 policy 挂载，bash tool 代码零改动**（req 核心诉求）。

### 4.1 抽象（落 `app/server/src/tools/bash-engine.ts`）

```typescript
export interface ShellResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
  spawnErrno?: string;  // spawn 系统调用失败时的 errno（'EBADF'/'EMFILE'/'ENOENT'/'EACCES' 等），close 正常路径=undefined
}
export interface ExecOpts {
  cwd: string; timeoutMs: number; signal?: AbortSignal;
  childRegistry?: ChildProcessRegistry;  // [v0.0.130.hang] bash tool 经 ctx.childRegistry 透传（§4.5）
}

export interface BashEngine {
  exec(command: string, opts: ExecOpts): Promise<ShellResult>;
}

/** 声明式安全策略；每次可加一条，命中即失败（黑名单制） */
export interface BashSecurityPolicy {
  id: string;
  description: string;
  denyRead?: string[];   // 路径（含前导 ~，engine 展开为绝对路径）
  denyWrite?: string[];  // 本版保留字段不挂策略（范围与非目标）
}
```

- 现有 `bash.ts runShell()` **收编为 engine 实现细节**（移入 bash-engine.ts，逻辑不变）。bash tool `run()` 改为调 `getBashEngine().exec(command, {cwd, timeoutMs, signal})`。
- **超时 / abort / 输出合并（stdout+stderr）/ 截断语义与现 runShell 完全一致**（§2 不破）——engine 只在 spawn 形态上包 sandbox，其余不动。

### 4.2 SecureBashEngine（macOS seatbelt，D3）

`SecureBashEngine implements BashEngine`，持 `BashSecurityPolicy[]`。本版挂一条：

```typescript
{ id: 'ssh-read-block', description: '禁止读取 ~/.ssh', denyRead: ['~/.ssh'] }
```

**seatbelt profile 编译**（黑名单制，allow-default + 逐条 deny）：

```
(version 1)
(allow default)
(deny file-read* (subpath "/Users/<home>/.ssh"))
```

- 每条 `denyRead` → 一行 `(deny file-read* (subpath "<abs>"))`；`denyWrite` → `(deny file-write* ...)`（本版无策略挂 write，编译逻辑保留）。
- **profile 安全**：编译前 `assertSafePath(abs)` 拒绝含 `"` / `\` 的路径（破坏 profile 字符串结构，提前失败比静默生成错误 profile 安全）。内置策略路径均可信常量。
- **`~` 展开**：engine 把 policy 路径的前导 `~` 展开为绝对路径（禁止字面 `~` 拼接——packaged cwd=`/` 护栏 BUG-004）。**实现现状（drift，doc-sync 记录）**：`bash-engine.ts` **本地实现** `expandTilde(p)`（`~`→homedir / `~/x`→join(homedir,x) / 其余原样），逻辑与 `config.ts` 的 `expandTilde` 完全一致——因为 `config.ts` 只 `export resolveDataDir`，未 export `expandTilde`（内部 function），故 bash-engine 无法复用 config 权威只能本地重实现。两份逻辑等价、皆不做字面 `~` 拼接，护栏不破。**建议（后续项，非本版改动）**：把 `config.ts` 的 `expandTilde` 提为共享 export（`resolveDataDir` 与 `bash-engine` 都消费），消除这份重复；本版不动产品代码，仅记录事实。
- **执行形态**：`spawn('/usr/bin/sandbox-exec', ['-p', profile, shell, '-c', command], {cwd, stdio})`——系统自带二进制、profile 内联 `-p` 传参**不写文件**（兼容 packaged asar / cwd=`/`，零新 npm 依赖）。`shell` = `process.env.SHELL ?? '/bin/sh'`（与现 runShell 一致）。
- **命中表现**：进程内读 `~/.ssh` 得 EPERM（Operation not permitted）→ 非零退出码 → bash tool 按现有 `exitCode !== 0` 逻辑返 isError（「返回失败」）。**无需 engine 特判**——sandbox 拒绝表现为普通非零退出。

### 4.3 平台分支

- **非 darwin**：SecureBashEngine passthrough = 普通 spawn（无 sandbox-exec），行为 = 现 runShell（req：只考虑 mac）。
- **getBashEngine() 工厂**（coder 定位获取方式）：进程级单例，按 `process.platform` 决定 darwin(seatbelt) / 其他(passthrough)；策略列表内置在工厂内（本版一条 ssh-read-block）。

### 4.4 与策略层（§5）的纵深防御关系

策略层 `ssh-read` checkPermission 是**参数级 best-effort**（命令文本引用 `~/.ssh` → deny），执行层 seatbelt 是**OS 级兜底**（脚本里间接读 `~/.ssh` 也被拦）。两层**有意重复**：参数层漏网（如 `bash -c 'cat ~/.ssh/id_rsa'` 的嵌套引用、变量拼接）由沙箱在 OS 层拦下。缺一不可。

### 4.5 子进程组杀 + detached + registry（[v0.0.130.hang] hang 根因修复）

**双症状根因（同一因）**：`spawn` 不带 `detached` 时子进程与本进程同组，`child.kill()` 只杀**直接子进程**（shell），而 shell 派生的**孙进程**（如 `cmd | cat` 的 cat）继承 stdout/stderr pipe 读端且存活 → pipe 永不关闭 → `close` 事件永不触发 → `wireChildLifecycle` 的 Promise 永不 resolve → `tool.run` 永不返回 → loop 永停在③ → session 永 running（hang）。超时/abort 场景各自表现，但根因都是「孙进程继承 pipe」。

**修法**（`bash-engine.ts`）：
- **`runShell` / `SecureBashEngine.exec` 两处 `spawn` 加 `detached: true`**——建独立进程组（pgid = child.pid），组内含 shell + 全部孙进程。非 darwin 平台 passthrough 走 `runShell`，同样获得组杀能力。
- **`killProcessGroup(child, sig)`**：`process.kill(-child.pid, sig)` 用负 pid 杀整个进程组；ESRCH（进程组已退）/权限失败 fallback `child.kill(sig)`；全程 catch 不抛（超时/abort 是 fire-and-forget 清理，不打断主流程）。照搬 `browser/chrome-launcher.ts` killProcessGroup 模式，本地实现避免 tools→browser 跨模块耦合。导出供 UT 覆盖 ESRCH fallback 分支（非 `BashEngine` 公开接口）。
- **`wireChildLifecycle` 三条 kill 路径全走组杀**：超时 `killTerm`（SIGTERM）→ 500ms → SIGKILL；外部 `signal` abort 联动 `killTerm`——均改 `killProcessGroup`（杀 shell+孙进程全树），不再是裸 `child.kill()`。
- **registry 收支平衡**：spawn 后 `opts.childRegistry?.register(child)`；`finish()`（close/error 终局，settled 幂等）`unregister(child.pid)`——防 registry 内存泄漏。register/unregister 是 run 级 sweep（`abort-finalize.killAll`）的登记侧（见 `tool_execution_engine.md §4.2` + `../agent_interface_and_loop/[P0]agent_interrupt.md §3.1`）。

**不破的语义**：输出合并（stdout+stderr）/ `timedOut` / 截断与原 `runShell` 完全一致——detached 只改 spawn 形态与 kill 目标，不动输出/退出码逻辑。实证：孙进程管道命令超时后 ~1.2s resolve（close 触发）、事后零孤儿。

### 4.6 escaped-grandchild pipe fd 回收 + spawn errno 透出

§4.5 的组杀治「打不到孙进程」，但有一类**脱离进程组**的孙进程（`setsid`/double-fork 主动脱离 pgid，如 daemon shell 命令）组杀依然打不到——它继承 child stdout/stderr pipe **写端**且存活 → pipe 永不关闭 → `child.on('close')` 永不触发 → `wireChildLifecycle` 的 Promise 永不 resolve，且 pipe **读端 fd 2 个/次永久钉死**（`+2/run`，repro 实测 5 run 累积 +10 fd，会话内累积到 EMFILE）。`detached` 组杀对这类「合法脱离者」无效。

**fd 回收解耦（`bash-engine.ts wireChildLifecycle.reclaimStreams()`）**：
- 新增闭包 helper `reclaimStreams = () => { try { child.stdout?.destroy(); child.stderr?.destroy(); } catch {} }`——显式销毁 child 侧 pipe **读端** fd，把「fd 回收」与「孙子生死」**解耦**：孙子是否还持写端、何时死，不再决定 pipe 读端何时释放。
- **仅在 SIGKILL 兜底后调用**（timer 内 `killTerm`(SIGTERM) → 500ms → `killProcessGroup(child,'SIGKILL')` → `reclaimStreams()` → `child.unref()`）。**不动 close 正常路径**（防 destroy 在输出收尾前丢最后字节）；**不在 SIGTERM 后立即调**（500ms 优雅退出窗口内仍需收集输出）。
- **双收益**：① pipe 读端 fd 立即释放（治 +2/run 累积泄漏）；② `destroy()` 让 stdio 关闭，`child.on('close')` 在 stdio 关闭后正常触发 → Promise resolve（治 hang，与 §4.5 detached 互补：detached 治组内孙进程，reclaimStreams 治脱离组的孙进程）。
- **幂等 + 容错**：`try/catch` + `?.`——已 destroy 的流再 destroy / stdio 非 pipe 配置（`'ignore'`）/ fd 已失效均不抛；正常命令（close 自然触发）根本不走到 SIGKILL 兜底分支，reclaimStreams 不被调，幂等无害。
- `child.unref()`：SIGKILL 兜底后附带调用，防 event loop 被「close 永不触发」的 child 句柄拖住 hang（Node 事件循环把 child handle 当 alive 句柄计数）。

**spawn errno 透出（`bash-engine.ts` + `bash.ts`，诊断盲区修复）**：
- 原状：`child.on('error', () => finish(1))` 吞掉 spawn error 的 errno → bash tool 返 `exitCode=1` 不带 errno 文本，packaged 真机 spawn 失败时**无法区分** EBADF/EMFILE/ENOENT/EACCES，诊断盲区。
- 现状：`finish` 签名扩为 `(exitCode, spawnErrno?)`；`child.on('error', (err) => finish(1, (err as NodeJS.ErrnoException)?.code))` 透出 errno；resolve 携带 `spawnErrno` 字段。close 正常路径 `finish(code ?? 1, undefined)`（spawnErrno 仅 error 事件透出，正常退出不填）。
- `bash.ts run()` 非零退出分支：`spawnErrno` 存在时前置 `[RUNTIME_ERROR] spawn <errno>` 文本（对齐 `RUNTIME_ERROR` 前缀语义，用 `ToolErrorCode.RUNTIME_ERROR`），原 exit code 文本保留在后；缺失走原 `NON_ZERO_EXIT` 路径不破。真机一跑即可读 errno 区分根因。
- `spawnErrno` type 用 `string` 不用 union——errno 是 POSIX 开放集（开放 Closed 性会漏新增码），且 `NodeJS.ErrnoException.code` 本身就是 `string | undefined`。

> 与 §4.5 的关系：§4.5 detached 组杀治「同组孙进程继承 pipe」（多数 case，如 `cmd | cat`）；本节 reclaimStreams 治「脱离组的孙进程继承 pipe」（setsid daemon case，组杀打不到的合法脱离者）+ errno 诊断。两者**互补不替代**——packaged bash EBADF 修复 = §4.5 已有的 detached + 本节 reclaimStreams（治 fd 累积）+ raise-nofile（packaged main 抬 nofile soft，见 `app/package/[P0]packaging_toolchain.md §3.9`）。

## 5. 策略层 — bash checkPermission 两条策略 [v0.0.122]

bash tool 实现 `checkPermission(input, ctx)`（`[P0]tool_permission.md §3` 钩子契约），内部 = `BashPermissionPolicy[]` 顺序检查，**deny 优先于 ask**（先扫全部 policy，任一 deny 即返 deny；无 deny 但有 ask 则返首个 ask；都不命中返 allow）。

| policyId | 命中条件 | 决策 |
|---|---|---|
| `ssh-read` | 命令文本引用 `~/.ssh` / `$HOME/.ssh` / `/Users/*/.ssh`（含 ls/cat 等任何形式） | **deny** reason=「禁止访问 ~/.ssh 敏感目录」 |
| `rm-wildcard`（D1） | 按 `;` `&&` `\|\|` `\|` 拆段取 token，命令名为 `rm` 且任一参数含字面 `*` | **ask** reason=「rm 通配删除，需用户批准」+ approvalKey=`bash:rm-wildcard` |

- **检测 best-effort 参数级**（不做完整 shell AST）——落 `app/server/src/tools/bash-policy.ts`（纯函数，便于 UT）。
- **策略即列表可扩展**：未来加策略 = 往 `BashPermissionPolicy[]` 加一条，checkPermission 逻辑不改。
- `checkPermission` 只产 PermissionDecision（纯判定无副作用，INV-P3）——ask 时的 ApprovalManager 查询 + 悬挂由引擎驱动。

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
