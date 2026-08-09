---
type: research
title: Claude Code bash 工具实现 vs Rocky bash 工具差距分析
priority: P1
status: active
updated: 2026-08-06
author: researcher
---

# Claude Code bash 工具 vs Rocky bash 工具 — 差距分析

## 1. 概述

Claude Code（cc）bash 工具源码在 `refs/claude-code/src/`（tools/BashTool + tasks/LocalShellTask + utils/Shell* + utils/sandbox）。Rocky 在 `app/server/src/tools/bash.ts + bash-engine.ts + bash-policy.ts`。

一句话总览：**cc 是「stateless 进程 + stateful 会话」模型（cwd 持久、后台任务、/env 注入、进度流、大输出落盘），Rocky 是「stateless 进程 + 固定 workdir + 内存合并输出」模型**。cc 的工程复杂度高一个量级，但核心可借鉴点集中在 cwd 追踪、后台任务、环境注入、输出落盘。

## 2. 七维度对比

### 2.1 shell 启动方式 / PATH 继承

| 项 | Claude Code | Rocky |
|---|---|---|
| shell 选择 | `CLAUDE_CODE_SHELL` 覆盖 → `$SHELL`（仅 bash/zsh）→ `which zsh/bash` → `/bin /usr/bin /usr/local/bin /opt/homebrew/bin` 搜索；**默认优先 zsh**（`refs/claude-code/src/utils/Shell.ts:73-137`） | `$SHELL ?? '/bin/sh'`（`bash-engine.ts:206`） |
| spawn 参数 | `['-c', ...(skipLoginShell ? [] : ['-l']), commandString]`（`bashProvider.ts:200-206`） | `['-l', '-c', command]`（`bash-engine.ts:207`） |
| PATH 继承机制 | **双轨**：首命令 `-l`（login shell source 用户 profile）→ `createAndSaveSnapshot()` 把 login shell 环境存为快照文件 → 后续命令 `source <snapshot> 2>/dev/null || true` **跳过 -l**（省 170ms+ 且避免交互插件噪音）；快照文件消失则自动回退 `-l`（`bashProvider.ts:63-68,85-103,161-167,200-206`） | 每次 `-l`（已修复，source .zprofile/.bash_profile 继承 PATH） |
| 非交互 | `-c` 非交互式（不加 -i），同 Rocky | 同左 |

**差距**：Rocky 无 shell snapshot 机制——每次 -l 有 ~26ms 开销（可接受），但更关键的是 Rocky **没有 cwdchanged 环境刷新**（见 2.2）。

### 2.2 环境变量注入

| 项 | Claude Code | Rocky |
|---|---|---|
| 基础 env | `subprocessEnv()`（node 环境清理版） | `process.env`（透传全部） |
| 固定覆盖 | `SHELL`（指定 shell 路径）、`GIT_EDITOR='true'`（防 git 打开编辑器挂起）、`CLAUDECODE='1'`（`Shell.ts:316-328`） | 无 |
| /env 机制 | **`/env` 命令设置 session 级 env vars** → 每次 bash 注入 `getSessionEnvVars()`（`bashProvider.ts:248-251`，`sessionEnvVars.ts`） | 无 |
| hooks 环境捕获 | **Setup/SessionStart/CwdChanged/FileChanged hooks 可输出 env** → bash 命令 `source <hook env 文件>`（`getSessionEnvironmentScript()`，`bashProvider.ts:170-173`，`sessionEnvironment.ts:60-128`）——cwd 变化时**重新加载**（nvm 切 node 版本等场景） | 无 |
| TMUX 隔离 | TMUX env 覆盖到 claude 隔离 socket（防串会话，`bashProvider.ts:219-234`） | 无 |
| sandbox tmp | TMPDIR/CLAUDE_CODE_TMPDIR/TMPPREFIX 指向 sandbox tmp（`bashProvider.ts:235-247`） | 无 |

**差距（重要）**：Rocky **无任何自定义 env 注入机制**。用户无法给 bash 子进程设置变量（相当于 cc 的 /env + hooks env）。这是能力缺口。

### 2.3 安全沙箱

| 项 | Claude Code | Rocky |
|---|---|---|
| 实现 | `@anthropic-ai/sandbox-runtime` 外部包（`sandbox-adapter.ts:19`）——**macOS=seatbelt / Linux=bwrap / WSL2**（`sandbox-adapter.ts:489`） | macOS 用 `sandbox-exec -p <profile>`（seatbelt 内联 profile，`bash-engine.ts:309`）；非 darwin **passthrough 无沙箱** |
| 策略形态 | 文件系统虚拟化 + 网络白名单 + 进程隔离（bwrap/seatbelt 组合，由 sandbox-runtime 封装） | 黑名单 denyRead/denyWrite（`compileSeatbeltProfile`，`bash-engine.ts:244-273`）——**目前仅一条 `~/.ssh` denyRead** |
| 开关 | `sandbox.enabled` + `sandbox.enabledPlatforms` + 依赖检查 + 不可用原因提示（`sandbox-adapter.ts:532-589`） | 无开关，darwin 恒启用（内置策略） |
| 排除/覆盖 | `dangerouslyDisableSandbox`（需策略允许）+ 用户配置 `sandbox.excludedCommands`（模式匹配，`shouldUseSandbox.ts:21-153`） | 无 |
| 参数层 | `bashPermissions.ts`（2621 行）：规则系统 allow/deny/ask + 通配符/前缀/exact + **AST 解析**（`parseForSecurity` 拆复合命令防 bypass，`BashTool.tsx:445-468`）+ sed 编辑模拟 | `bash-policy.ts`（153 行）：正则级 ssh-read deny + rm-wildcard ask（`bash-policy.ts:47-99`） |

**差距**：Rocky seatbelt 是「黑名单 deny 读取」级（防敏感文件读取），cc sandbox 是「完整沙箱虚拟化」级（隔离写 + 网络 + 进程）。但 cc 沙箱默认**不开启**（需用户 `sandbox.enabled: true`），Rocky 的 darwin seatbelt 恒开反而是更保守的默认。参数层 cc 用 AST 拆命令（更准），Rocky 用正则（`rm -rf *` 会被 `&&` 拆分检测，但 `echo x; rm -rf *` 场景已覆盖；AST 更稳）。

### 2.4 超时 / 取消机制

| 项 | Claude Code | Rocky |
|---|---|---|
| 默认超时 | **30 分钟**（`Shell.ts:44` `DEFAULT_TIMEOUT = 30*60*1000`）；可 env 覆盖 `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`（`timeouts.ts:12-38`） | **120s** 默认 / **600s** 上限（`bash.ts:28-30`） |
| 超时动作 | **SIGTERM → 若 shouldAutoBackground 转后台**（模型可看部分输出），否则 **treeKill SIGKILL**（`ShellCommand.ts:135-141,337-343`）；stderr 追加 `Command timed out after X`（`ShellCommand.ts:323-328`） | SIGTERM → 500ms → 组杀 SIGKILL（`bash-engine.ts:161-169`） |
| abort | `abortSignal.reason === 'interrupt'` → **不杀，转后台**（用户发新消息时保留进程）；否则 kill（`ShellCommand.ts:186-193`） | signal 联动 SIGTERM 组杀（`bash-engine.ts:173-176`） |
| 进程树杀 | `treeKill(pid, 'SIGKILL')` npm 库（`ShellCommand.ts:4,340`） | `killProcessGroup` 负 pid 组杀（`bash-engine.ts:89-105`）——同等能力 |
| 用 'exit' 不用 'close' | 防 `sleep 30 &` 孙进程继承 fd 拖住 close（`ShellCommand.ts:269-272`） | 用 'close'（`bash-engine.ts:186`）——**潜在差距**（孙进程继承 pipe 时可能 hang，Rocky 有 reclaimStreams 兜底但场景不同） |

**差距（重要）**：① 默认超时 120s vs 30min——Rocky 对长任务（npm install / build / 测试）不友好；② Rocky **无超时转后台**（超时即杀，部分输出也丢）；③ abort 语义 Rocky 一律杀，cc interrupt 保留。

### 2.5 输出处理

| 项 | Claude Code | Rocky |
|---|---|---|
| stdout/stderr | **文件模式**：双 fd 写同一文件（O_APPEND 原子交错，`Shell.ts:289-313`）；pipe 模式（onStdout 回调） | **内存合并**：stdout+stderr 拼同一 buf（`bash-engine.ts:178-183`） |
| 截断策略 | 双层：tool result **30K chars 阈值**（`maxResultSizeChars: 30_000`，`BashTool.tsx:424`）超阈值 → `persistedOutputPath` 落盘 + 只 inline 摘要；**磁盘上限 5GB** + 后台 size watchdog 5s 轮询超限 SIGKILL（`ShellCommand.ts:52-54,239-261`，`diskOutput.ts:30`） | 内存 64KB 截断（`bash.ts:32`）+ `[truncated]` 标记 |
| 进度流 | `onProgress` 回调（tail 轮询，后台任务通知模型） | 无 |
| 语义化 | `isSearchOrReadCommand` / `isSilentBashCommand`（UI 折叠，`BashTool.tsx:95-217`）；`returnCodeInterpretation`（特殊非零码语义，如 git diff 退出码 1）；`interrupted: code===SIGKILL` | 无 |

**差距（重要）**：Rocky 64KB 内存截断——大输出（长 build log / grep 海量结果）直接截断丢弃，**没有落盘可查**。cc 30K 后落盘 + 路径返回，模型/用户可继续读文件。

### 2.6 持久化 / 状态

| 项 | Claude Code | Rocky |
|---|---|---|
| 进程 | stateless（每次新 spawn，同 Rocky） | 同左 |
| cwd | **stateful！** 命令后 `pwd -P >| <cwdFile>` → `readFileSync` → `setCwd` → 下一命令用新 cwd（`Shell.ts:385-421`）；cwd 被删回退 originalCwd（`Shell.ts:220-238`） | **固定 workdir**：每次 `ctx.workdir`，命令内 `cd` 不跨调用保持（`bash.ts:102-104`） |
| 后台任务 | **完整系统**：`run_in_background` 参数 + assistant 模式 15s 自动后台（`ASSISTANT_BLOCKING_BUDGET_MS=15_000`，`BashTool.tsx:57`）+ Ctrl+B + 完成通知（`LocalShellTask.tsx:105-172`）+ stall watchdog（45s 无输出且 tail 像交互 prompt → 通知模型「卡在输入」，`LocalShellTask.tsx:24-104`）+ **agent 退出杀其 bash 任务**（防僵尸，`killShellTasks.ts:53-76`） | **无**：`runInBackground` 仅标记未实现（`bash.ts:61`） |
| read-only 并发 | `isReadOnly` 判定 → 只读命令可并发安全执行（`BashTool.tsx:434-441`） | 无并发判定 |

**差距（最重要）**：① **cwd 不追踪**——Rocky 的 `cd` 跨调用无效，长链任务（先 cd 到项目再操作）必须每条命令拼绝对路径；② **无后台任务系统**——长任务只能前台阻塞等 120s 超时被杀；③ 无 agent 级进程清理（Rocky 有 childRegistry run 级 sweep，但无「agent session 结束杀其后台进程」语义，因为根本没有后台）。

### 2.7 其他 cc 有而 Rocky 没有的能力

| 能力 | cc 位置 | 说明 |
|---|---|---|
| stdin redirect 处理 | `shouldAddStdinRedirect` + `rearrangePipeCommand`（`bashProvider.ts:128-154`） | 管道命令 stdin 重定向位置修正（`rg foo | wc -l < /dev/null` 防 wc 读 /dev/null 输出 0） |
| extglob 安全禁用 | `getDisableExtglobCommand`（`bashProvider.ts:39-56`） | 禁 bash extglob / zsh EXTENDED_GLOB（恶意文件名 glob 展开逃逸安全校验） |
| 交互式 flag 检测 | `detectBlockedSleepPattern`（sleep N 引导用 Monitor，`BashTool.tsx:322-337`）+ stall watchdog | Rocky 只有 git -i reject |
| sed 编辑模拟 | `parseSedEditCommand` + `applySedEdit`（`BashTool.tsx:350-419`） | sed 命令在权限弹窗预览真实写入内容，批准后直接模拟写文件（不真跑 sed） |
| Windows 支持 | PowerShellTool + Git Bash 路径转换 | 不支持 |
| 命令 AST 解析 | `parseForSecurity` / `splitCommandWithOperators`（`utils/bash/ast.ts`） | 无（正则拆分） |
| description 语义约束 | prompt 强约束（`BashTool.tsx:230-240`） | 已有 description 必填 |
| 进度 UI | 2s 阈值显示 progress（`PROGRESS_THRESHOLD_MS=2000`） | 无 |

## 3. 差距清单（按重要性排序）

### P0 — 用户可感知的核心能力缺口

1. **cwd 不追踪**（2.6）：`cd` 跨调用无效，每个命令必须绝对路径。cc 用 `pwd -P >| cwdFile` 回读实现，改动集中在 bash tool 层 + session 状态。
2. **无后台任务系统**（2.6）：长任务（build/install/test）只能前台阻塞。cc 的 run_in_background + 完成通知 + agent 退出清理是完整闭环，Rocky 至少需要「runInBackground 真实现 + 输出落盘可查 + 通知」。

### P1 — 工程健壮性差距

3. **默认超时 120s 过短**（2.4）：对齐 cc 思路：默认可放宽（如 10min）+ 上限保留 + **超时转后台而非直接杀**。
4. **大输出无落盘**（2.5）：64KB 内存截断丢弃。cc 30K 阈值后 `persistedOutputPath` 落盘可查——Rocky 应有同等机制（文件落盘 + 返回路径 + 摘要）。
5. **无 env 注入机制**（2.2）：无 /env 等价物，用户不能给子进程配变量。至少支持 session 级 env 配置。

### P2 — 安全增强

6. **seatbelt 策略过薄**（2.3）：只有一条 `~/.ssh denyRead`。可扩展 denyWrite 列表（如 `.env`、credentials 文件）+ 参数层 AST 解析替代正则。
7. **'close' vs 'exit'**（2.4）：Rocky 用 'close' 事件，继承 fd 的孙进程可能拖住；cc 用 'exit' 立即返回。Rocky 有 reclaimStreams 兜底，但切换 'exit' 更稳。

### P3 — 体验打磨

8. stdin redirect 修正、extglob 禁用、stall watchdog（提示交互输入）、read-only 并发判定、进度流。

## 4. 改进建议（按优先级落地）

### 建议 1（P0，改动小收益大）：cwd 追踪

照搬 cc `Shell.ts:385-421` 模式：
- bash tool run 后追加 `pwd -P >| <tmpFile>`（cc 用 `/tmp/claude-<id>-cwd`）
- run 结束 readFileSync → 更新 session 级 cwd 状态（Rocky 已有 sessionStore，加一个 cwd 字段）
- 下一命令 spawn 用新 cwd；cwd 被删回退 workdir
- 注意：seatbelt 沙箱下写 /tmp 文件是否被 deny——需验证 sandbox-exec profile 允许（cc 沙箱同样写 cwd 文件到 sandboxTmpDir，Rocky 可对齐）

### 建议 2（P0，中等改动）：后台任务

- `runInBackground: true` → spawn 后立即返回 `{backgroundTaskId}` + 输出写文件（复用 TaskOutput 思路，Rocky 直接写临时文件）
- 完成时通知模型（Rocky 有 send_message / session 通知能力）
- **agent session 结束清理**：childRegistry 已有 run 级，扩展 session 级——agent 结束杀其全部 bash 子进程（对齐 `killShellTasksForAgent`）
- 超时转后台：timeout 到达且 `runInBackground` 允许 → 转后台继续跑 + 通知，不杀

### 建议 3（P1）：大输出落盘

- MAX_OUTPUT_CHARS 后不再丢弃：截断 inline + 写完整输出到 `<workdir>/snapshots/` 或临时文件 + 返回 `outputFilePath`（对齐 cc `persistedOutputPath`）
- 后台任务天然需要此机制（建议 2 依赖）

### 建议 4（P1）：env 注入 + 默认超时放宽

- session 级 env 配置（对齐 cc /env）：`session.envVars` 注入 bash 子进程 env
- 默认超时 120s → 300s（5min），上限 600s 保留；或支持 env 覆盖 `ROCKY_BASH_TIMEOUT_MS`

### 建议 5（P2）：安全增强

- seatbelt denyWrite 扩展（`.env`、`credentials`、`id_rsa*` 等）+ denyRead 补 `~/.aws`、`~/.config/gh` 等
- 参数层用轻量 AST 拆分（cc `splitCommandWithOperators` 思路）替代正则，防复合命令 bypass

## 5. 关键文件索引

| 文件 | 作用 |
|---|---|
| `refs/claude-code/src/utils/Shell.ts` | cc 执行核心：shell 选择、spawn env、cwd 追踪、输出文件模式 |
| `refs/claude-code/src/utils/ShellCommand.ts` | 超时/abort/treeKill/后台 size watchdog/输出落盘 |
| `refs/claude-code/src/utils/shell/bashProvider.ts` | login shell + snapshot 快照 + session env + TMUX 隔离 |
| `refs/claude-code/src/tools/BashTool/BashTool.tsx` | tool schema（timeout/run_in_background/dangerouslyDisableSandbox）+ 语义分类 |
| `refs/claude-code/src/tools/BashTool/bashPermissions.ts` | 2621 行权限规则系统 |
| `refs/claude-code/src/tools/BashTool/shouldUseSandbox.ts` | 沙箱开关/排除/覆盖 |
| `refs/claude-code/src/tasks/LocalShellTask/LocalShellTask.tsx` | 前后台任务状态机 + 通知 + stall watchdog |
| `refs/claude-code/src/tasks/LocalShellTask/killShellTasks.ts` | agent 退出清理 |
| `refs/claude-code/src/utils/sandbox/sandbox-adapter.ts` | sandbox-runtime 封装（macOS seatbelt / Linux bwrap） |
| `refs/claude-code/src/utils/sessionEnvVars.ts` | /env 机制 |
| `refs/claude-code/src/utils/sessionEnvironment.ts` | hooks env 捕获 |
| `app/server/src/tools/bash.ts` | Rocky tool 层（120s/600s、64KB 截断、cwd=workdir、runInBackground 未实现） |
| `app/server/src/tools/bash-engine.ts` | Rocky 执行层（-l、seatbelt、SIGTERM→SIGKILL 组杀） |
| `app/server/src/tools/bash-policy.ts` | Rocky 参数层（ssh-read deny + rm-wildcard ask） |
