# v0.0.236 变更计划书 — packaged bash 工具 spawn EBADF:A 透 errno(诊断) + C 句柄回收(治本) + B raise nofile(基线余量)

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 背景（架构裁决 — 必读）

> **用户最终确认 = A + C + B 都做**（B 回加为必做,非降级后置）。research-2 §修正建议 L129 曾建议 B 降级后置（治标不治本 + native dep 风险在 C 落地前不值得付）,用户基于"重启后第一次 bash 就坏 + 之前 ok + 重启不恢复"新观察推翻：基线 fd 高（app 启动加载占满 packaged nofile=256）,B 给基线余量**直接救急"第一次就坏"**——非治标降级,而是救"基线本身就高"这一 C 治不了的独立分支 + 给 C 兜底。

- **A 必做（诊断盲区,纯 TS）**：`bash-engine.ts:159` `child.on('error', () => finish(1))` 吞 spawn errno → bash tool 返 exitCode=1 不带 errno 文本,诊断盲区。A 透出 errno → packaged 真机一跑即可确证根因（EMFILE / EBADF / ENOENT / EACCES）。纯 TS,零 native dep,零 packaged 风险。
- **C 必做（治本:escaped-grandchild 句柄回收,纯 TS）**：research-2 §排查 2 锁定具体泄漏句柄 — 孙子进程 setsid/double-fork 脱离 pgid + 继承 stdout/stderr pipe 写端 → `child.on('close')` 永不触发（组杀打不到脱离者）→ `child.stdout`+`child.stderr` pipe 读端 fd **2 个/次永久钉死**（repro_persistent_leak 实测 +2/run,5 run 累积 +10 fd）。修复:wireChildLifecycle SIGKILL 兜底后显式 `destroy()` child stdout/stderr,解耦 fd 回收与孙子生死。repro_fix_destroy 验证 +0/run（baseline +10）且 close 正常触发（双收益:fd 回收 + promise 不 hang）。纯 TS,零 native dep,零 packaged 风险。**治本（解耦 fd 回收与孙子生死）**。
- **B 必做（给基线余量救急,native dep）**：用户最新观察"重启后第一次 bash 就坏 + 之前 ok + 重启不恢复" = **基线 fd 高**分支（research-2 §排查 4 dev 估算 idle ~62 / 余量 ~194,真机 packaged 启动期基线可能更高逼近 nofile=256）。B 抬 nofile soft（256→4096）给基线余量**直接救急"第一次就坏"**:**非治标降级**——B 救"基线本身就高"（C 治不了基线高）+ 给 C 兜底（C 之外若还有别处泄漏,B 给更多累积窗口）。native dep（posix）+ ABI rebuild 风险用户已确认承担（B 不依赖 A 真机 errno 验证,无条件必做）。
- **A+C+B 三者关系（互补不替代）**：A=诊断（透 errno 拿 ground truth,区分 EMFILE/EBADF/ENOENT 决定后续）/ C=治 session 内累积泄漏（escaped-grandchild 句柄,会话内累积到 EMFILE 这一最可能主因）/ B=给基线余量（救急"第一次就坏" + 给 C 兜底）。三者解决不同分支:A 区分根因,C 治累积泄漏,B 抬天花板。
- **B 的技术路径（architect 实测确认,与初版一致）**：bash tool 跑在 **Electron 主进程**（packaged `startBackend → require('@app/server').startServer → node:http in 主进程`,backend-bootstrap.ts:103 确认）→ raise nofile 必须改**主进程 rlimit**。
  - `process.setrlimit` **实测不可用**（Node v22.22.0 + Bun 1.3.14 都 `not a function`）；`process.binding('os')` 无 setrlimit；`internalBinding` 不可访问。
  - `ulimit -n 4096` 在子 shell 生效但**不影响父进程**；.app 双击由 LaunchServices 启动不经 shell,改 .app/Contents/MacOS 入口破坏代码签名 — build-dmg wrapper 路径不可行。
  - **唯一可行 = native binding**：主选 `posix` npm 包（调 POSIX setrlimit(2)），退路自写 minimal N-API addon（参照 computer-native 模式）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 / 项目原则编号 / memory |
| 预计影响行 | +N / -M |

## 变更清单

### A. 透出 spawn errno（诊断盲区修复 — 纯 TS，零 native dep）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bash_tool | app/server/src/tools/bash-engine.ts | ShellResult | 修改 | 加可选字段 `spawnErrno?: string`（spawn 失败时的 errno，如 `'EBADF'`/`'EMFILE'`/`'ENOENT'`/`'EACCES'`）；stdout/exitCode/timedOut 不变 | MUST 可选字段（向后兼容，close 路径不填）；type 用 `string` 不用 union（errno 是开放集，防闭合性陷阱） | research.md §4 A；bash-engine.ts §1（L23-30 现状） | +1 |
| bash_tool | app/server/src/tools/bash-engine.ts | wireChildLifecycle / finish | 修改 | `finish` 签名扩为 `(exitCode: number, spawnErrno?: string)`；resolve 携带 `spawnErrno` 字段；close 路径 `finish(code ?? 1, undefined)` | MUST close 路径 spawnErrno=undefined（仅 error 事件透出 errno）；不破现有 stdout/timedOut/timeout-kill 语义 | research.md §4 A；bash-engine.ts §2（L126 finish / L131 resolve 现状） | +3 |
| bash_tool | app/server/src/tools/bash-engine.ts | wireChildLifecycle child.on('error') | 修改 | L159 `child.on('error', (err) => finish(1, (err as NodeJS.ErrnoException)?.code))` 透出 errno（原吞 errno） | MUST 用 `NodeJS.ErrnoException.code`；errno 缺失走 undefined（兼容）；**不做 C 重试**（本次范围外） | research.md §4 A；bash-engine.ts L159 现状 | +1/-1 |
| bash_tool | app/server/src/tools/bash.ts | run() 非零退出分支 | 修改 | L109 解构加 `spawnErrno`；L135 非零退出分支：若 `spawnErrno` 存在，前置 `[RUNTIME_ERROR] spawn ${spawnErrno}` 文本（对齐 L145 RUNTIME_ERROR 前缀语义），原 exit code 文本保留在后；让真机一跑即可区分 errno | MUST 用 `ToolErrorCode.RUNTIME_ERROR`（types.ts L307，已 import）；spawnErrno 缺失走原 NON_ZERO_EXIT 路径；不破 truncated 分支（L136-138）；timedOut 分支（L128-132）不改 | bash.ts L109/L135-140；research.md §4 A；specs/tech/agent/tools/[P0]bash_tools.md §2 | +5 |
| bash_tool | app/server/src/tools/__tests__/bash-engine-spawn-errno.test.ts | describe('spawn errno 透出') | 新增 | mock spawn 'error' 事件触发（`errno='EMFILE'`）；断言 ShellResult.spawnErrno='EMFILE' + exitCode=1；断言 bash.ts run 返回 errorResult 文本含 `[runtime_error] spawn EMFILE`；覆盖 errno 缺失分支（code=undefined → 走原 NON_ZERO_EXIT 路径，文本含 exit code） | MUST 不真 spawn（用 EventEmitter emit 'error' 模拟）；覆盖 3 分支（errno 存在 / errno 缺失 / close-normal-no-errno）；vi.mock 用绝对路径（__dirname 派生） | memory test-vitest-mock-absolute-path；bash-engine-group-kill.test.ts mock 先例 | +60 |

### C. wireChildLifecycle 句柄回收（治本:escaped-grandchild pipe 钉死 — 纯 TS，零 native dep）

> research-2 §排查 2 锁定具体泄漏：孙子 setsid/double-fork 脱离 pgid + 继承 pipe 写端 → `child.on('close')` 永不触发 → `child.stdout`+`child.stderr` pipe 读端 fd 2 个/次永久钉死（+2/run）。`destroy()` 解耦 fd 回收与孙子生死，repro_fix_destroy 验证 +0/run。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bash_tool | app/server/src/tools/bash-engine.ts | wireChildLifecycle.reclaimStreams() | 新增 | 新增 helper（闭包内 const）`const reclaimStreams = () => { try { child.stdout?.destroy(); child.stderr?.destroy(); } catch {} }`；定义于 finish(L126)/killTerm(L134) 之后、timer(L139) 之前 | MUST try/catch 包裹（destroy 已 destroy 的流 / EBADF 不抛到外层）；MUST 幂等（正常 case close 已自然释放,再 destroy 是 no-op）；MUST NOT 在 L160 close 正常路径调用；`?.` 防 stdout/stderr 为 undefined（stdio 非 pipe 配置） | research-2.md §机制完善建议 L77-82；§排查 2（repro_persistent_leak +2/run 铁证） | +3 |
| bash_tool | app/server/src/tools/bash-engine.ts | wireChildLifecycle timer SIGKILL 兜底 | 修改 | L142-144 内 setTimeout 块,`killProcessGroup(child, 'SIGKILL')` 后调 `reclaimStreams()`；可选附 `child.unref()` 防 event loop 被 close 永不触发的 child 拖住 hang | MUST 仅 SIGKILL 兜底后调（**不动 L160 close 正常路径**,防丢最后字节输出）；MUST NOT 在 SIGTERM（killTerm L134）后立即调（500ms 优雅退出窗口内仍需收集输出）；正常 case（close 自然触发 finish）不走到此分支,幂等无害；coder 核实:abort signal 路径（L148-150）仅 SIGTERM 无 SIGKILL 兜底,本行不覆盖 abort（run 终止级 sweep 兜底,本次范围外） | research-2.md L79-80（建议仅 SIGKILL 后调）；repro_fix_destroy.cjs 验证 +0/run + close 正常触发 | +2 |
| bash_tool | app/server/src/tools/__tests__/bash-engine-destroy.test.ts | describe('escaped-grandchild 句柄回收') | 新增 | mock spawn（不真 spawn daemon）；构造 child.on('close') 永不触发场景（模拟 escaped-grandchild 持写端）；推进内部 timer 触发 SIGKILL 兜底；断言 ① stdout.destroy + stderr.destroy 被调 ② finish 正常 resolve（promise 不 hang） ③ 多次调 reclaimStreams 幂等不抛；覆盖正常 close 路径（无 SIGKILL）时 reclaimStreams 不被调 | MUST vi.mock 绝对路径（__dirname 派生,禁硬编码 worktree）；MUST 用 EventEmitter/manual timer 模拟（不真 spawn setsid 进程）；参照 repro_fix_destroy.cjs（baseline +10 vs FIX +0）对照设计断言 | memory test-vitest-mock-absolute-path；bash-engine-group-kill.test.ts mock 先例；research-2.md §排查 2 L72-75 | +50 |

### B. packaged raise nofile soft（native dep + packaged 护栏 — 必做:给基线余量救急）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| electron_main | app/electron/src/raise-nofile.ts | raiseNofileLimit() | 新增 | 导出 `raiseNofileLimit(targetSoft: number, binding?: PosixBinding): { raised: boolean; newSoft: number }`;动态 `require('posix')`(try/catch,缺失返 `{raised:false,newSoft:currentSoft}` 静默);读当前 nofile(`posix.getrlimit('nofile')`);`newSoft=max(currentSoft,targetSoft)`;`setrlimit('nofile',{soft:newSoft,hard:currentHard}`)(hard 不动);失败 `console.warn` 不抛 | MUST 容错（posix 缺失/require 失败/setrlimit 抛错 → 静默 console.warn 不阻塞启动）；dev ulimit 已 1048576 取 max 无副作用；**hard 不动**（防超 `kern.maxfilesperproc`=92160）；binding 参数可注入（单测）；targetSoft=4096 远低于 hard 安全 | 护栏#1（依赖归属）；research.md §4 B；backend-bootstrap.ts 抽离可测先例（L16 抽离理由） | +35 |
| electron_main | app/electron/package.json | dependencies.posix | 新增 | 加 `"posix": "<coder 核实最新稳定版>"` 到 `dependencies`（packaged electron 主进程 require，运行时硬依赖） | MUST 在 `app/electron/package.json` 不在根（护栏#1：electron-builder 只打包 @app/electron 自身 deps）；版本固定锁 ABI；coder 实现时核对 npm posix 包 API（`posix.setrlimit(resource, limits)` + `posix.getrlimit`） | 护栏#1；memory node-sqlite-packaged-covers-better-sqlite3-redundant（native rebuild 对照点） | +1 |
| electron_main | app/electron/src/main.ts | raiseNofileLimit 调用 | 新增 | import raiseNofileLimit；在 `loadRuntimeConfig`（L105）后、`startBackend`（L119）前调 `raiseNofileLimit(4096)`；`console.log('[electron] nofile soft:', result)` 便于诊断 | MUST 在 backend 起来前 raise（bash tool spawn 才用上新 limit）；时序=runtime-config → raise-nofile → startBackend；try/catch 在 raiseNofileLimit 内部（main 不加额外 catch） | main.ts L105-119 时序（runtime-config → startBackend）；护栏#1 | +4 |
| packaging | scripts/build-dmg.sh | ②d posix @electron/rebuild | 新增 | ②c（better-sqlite3 warn+skip）后加 ②d：对 posix 跑 `@electron/rebuild`（面向 Electron ABI）；**必须成功**（posix 是运行时硬依赖，非 sqlite 可 skip）；rebuild 失败 → `echo ERROR + exit 1` | MUST rebuild 成功（posix require 失败 = packaged 主进程崩）；与 ②c sqlite 对照（sqlite 可 warn+skip，posix 不可）；复用现有 @electron/rebuild 工具链（参照 ②c 块）；coder 落地时若 posix 包对 Electron ABI rebuild 不支持 → 退路：自写 minimal N-API addon（~15 行 C 调 setrlimit，参照 computer-native 模式） | memory node-sqlite-packaged-covers-better-sqlite3-redundant（对照点：sqlite 可 skip vs posix 必须成功）；护栏#2（plugin/native 进 asar） | +12 |
| electron_main | app/electron/src/__tests__/raise-nofile.test.ts | raiseNofileLimit UT | 新增 | 注入 mock binding；覆盖 4 分支：① currentSoft>target → 不调 setrlimit ② currentSoft<target → setrlimit({soft:max}) ③ posix require 失败 → 静默返 `{raised:false}` ④ setrlimit 抛错 → console.warn 不抛；断言 hard 不动 | MUST 注入 mock（不依赖真实 posix）；覆盖 max 逻辑 + 容错；参照 backend-bootstrap.test.ts 动态 require mock 模式；vi.mock 绝对路径 | backend-bootstrap.test.ts 先例；memory test-vitest-mock-absolute-path | +45 |

## 影响面评估

- **跨模块**：bash_tool（server 层 bash-engine.ts/bash.ts/UT:A+C）+ electron_main（raise-nofile.ts/main.ts/package.json/UT:B）+ packaging（build-dmg.sh:B）。**A+C 与 B 不重叠文件 / 不同模块（server vs electron+packaging）/ 无依赖**。
- **任务切片（并行 2 task）**：A+C 同 task（都改 bash-engine.ts/bash.ts 纯 TS + UT,串行无并行损失,合 1 个 coder 续跑省冷恢复）；B 独立 task（native dep + electron main + packaging）。两者模块/文件不重叠 → **可并行 2 task**（符合 planner「后端∥前端式并行,仅分开能提高并行度时才拆」）。用户已确认 B 不依赖 A 真机 errno 验证（B 必做无条件）→ 无串行依赖。
- **破坏性变更**：`ShellResult` 加可选字段 → 向后兼容（既有解构不破）；bash.ts 输出文本在 spawnErrno 存在时多一行前缀（LLM 读到更多诊断信息,非契约 break）；wireChildLifecycle SIGKILL 路径加 destroy（**不动 close 正常路径**,幂等无害）。
- **风险点**：
  1. **B 的 native dep** = 本版最大风险:`posix` 包对 Electron 42 ABI rebuild 可能失败（参照 better-sqlite3@11 失败先例）→ 若失败 coder 走退路（自写 N-API addon）或向 orchestrator 汇报偏离、降级为只做 A+C。
  2. **C 的 destroy 时序**:仅 SIGKILL 后调,不动 close 正常路径（防丢最后字节输出）；正常 case close 自然释放,加 destroy 幂等无害。UT 必须 mock escaped-grandchild 场景验证 close 永不触发时 destroy 释放 fd。
  3. **A/C 的 UT mock 风格**:vi.mock 必须绝对路径（__dirname 派生）,硬编码 worktree 路径 merge 后必失效。
  4. **packaged 验证门槛**:dev 的 AT/ET 测不到 packaged spawn bug（护栏铁律）→ acceptanceCriteria 必须含 packaged 真机/解包 asar 验证。
- **dev 影响零**:dev ulimit -n=1048576（终端继承）,raiseNofileLimit 取 max(1048576, 4096)=1048576 不变；A 的 errno 透出对 dev 透明（dev 不出 spawn error 时 spawnErrno 恒 undefined）；C 的 destroy 仅 SIGKILL 后（dev timeout 才触发,正常命令不走到）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **B 的 native dep 退路触发**：coder 落 build-dmg.sh ②d 时若 `posix` 包 Electron ABI rebuild 失败,向 orchestrator 汇报 + 选退路（自写 N-API addon 或降级只做 A+C），不算违反 change_plan（本表已标退路）。
- **A 拿到 errno 后的裁决**：coder 完成 A 后 packaged 真机跑 bash 工具,读输出 errno。若 errno=EBADF/ENOENT（非 EMFILE）→ 说明本次失败非 fd 耗尽类,但 **B 仍必做**（B 救"基线高"分支 + 给 C 兜底,与本次 errno 无关）；errno 结果记入 change_log 供下版诊断,**不再因 errno 结果而增删 B**（用户已确认 B 必做无条件）。
- **C 的 destroy 回归兜底**：若 packaged 验证发现 C 上线后 bash 仍泄漏（fd 累积逼近 limit）,说明泄漏点不止 escaped-grandchild（可能 close 路径或别处 spawn）→ 记 change_log + 建 BUG-xxx,转 follow-up（本次范围外）；此时 B 的余量正好兜住额外累积窗口（B+C 互补设计意图）。
