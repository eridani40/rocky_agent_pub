# v0.0.122 变更计划书 — 工具权限系统（策略 / 审批 / 执行 三层，范围=bash）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 决策锁定（design.md）：D1 rm 口径=命令名 rm 且参数含字面 `*`；D2 永远同意=会话内内存不落盘；D3 沙箱=macOS sandbox-exec + seatbelt（profile 内联 `-p`）。
>
> **本版本不含 tests/ 行**（用户裁决：AT/ET 框架 v0.0.120 重构中）；UT 关键点在约束列注明。

## 变更清单

### 模块 A — types（策略/审批载荷类型）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools-types | app/server/src/tools/types.ts | `PermissionDecision` | 新增 | 决策联合类型：`{behavior:'allow'}` \| `{behavior:'deny';reason}` \| `{behavior:'ask';reason;approvalKey}` | MUST 与 ToolInteraction 并列导出；behavior 三值闭合 | tool_permission.md §2 | +6 |
| tools-types | app/server/src/tools/types.ts | `Tool.checkPermission?` | 新增 | Tool 接口加可选钩子 `checkPermission?(input:ToolInput, ctx:ToolCtx):PermissionDecision` | MUST 可选（缺省=allow，其他工具不受影响 INV-P2）；MUST 同步纯判定无副作用 | tool_permission.md §3；index §④原则8 | +4 |
| tools-types | app/server/src/tools/types.ts | `ApprovalData` | 修改 | 加两可选字段 `reason?:string` + `approvalKey?:string`（向后兼容） | MUST NOT 改 toolName/arguments 必填字段；新增字段可选 | tool_permission.md §4 | +2 |

### 模块 B — 执行引擎（策略门集成）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tool-engine | app/server/src/tools/engine.ts | `ToolExecutionEngine.constructor` | 修改 | 构造加可选参 `approvalManager?:ApprovalManager`（默认 = 导出的进程单例 `approvalManager`）；存为私有字段 | MUST 默认单例（bootstrap `new ToolExecutionEngine()` 零改仍可用）；UT 可注入 fresh manager | tool_permission.md §4/§5 | +5 |
| tool-engine | app/server/src/tools/engine.ts | `ToolExecutionEngine.execute` | 修改 | 在 validateInput 通过后、`tool.interaction` 调用前插入策略门：调 `tool.checkPermission?`（try/catch→allow）；deny→push `wrap(call, errorResult(reason))` continue；ask 且 `!approvalManager.isApproved(config.sessionId??'', key)`→`buildApprovalInteraction` + `buildPendingResult` push results+pending continue；ask 已同意→fall through | MUST 位置在 L109 白名单门后、L132 interaction 前；MUST NOT 绕过 buildPendingResult 自造 pending（INV-P5）；deny MUST NOT 悬挂（INV-P4）；MUST try/catch checkPermission fail-open | tool_permission.md §4；engine.ts:109/132 | +22 |
| tool-engine | app/server/src/tools/engine.ts | `safeCheckPermission` | 新增 | helper：try{tool.checkPermission(args,ctx)}catch{return {behavior:'allow'}}（异常 fail-open） | MUST 抛错返 allow（安全兜底交执行层沙箱） | tool_permission.md §3 | +8 |
| tool-engine | app/server/src/tools/engine.ts | `buildApprovalInteraction` | 新增 | 把 `PermissionDecision.ask` + call 翻译成 `ToolInteraction{subType:'need_approval', handleType:'approval', data:ApprovalData{toolName:call.name, arguments:call.arguments, reason, approvalKey}}` | MUST NOT 直接构造 pending（交 buildPendingResult）；data 携 reason+approvalKey | tool_permission.md §4；types.ts ApprovalData | +12 |

### 模块 C — ApprovalManager（审批层记忆）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| approval | app/server/src/tools/approval-manager.ts | `ApprovalManager` (class) | 新增 | 内存 `Map<string,Set<string>>`（sessionId→approvalKey 集合）；`isApproved(sessionId,key):boolean` / `recordAlways(sessionId,key):void` | MUST 仅内存不落盘（D2）；MUST 按 sessionId 隔离；MUST NOT 进 CrudStore/session 落盘 | tool_permission.md §5；design D2 | +30 |
| approval | app/server/src/tools/approval-manager.ts | `approvalManager` (singleton) | 新增 | 导出进程级单例实例（engine 默认注入 + tool-reply-handler 直接 import） | MUST 单例随 server 生命周期；UT 可绕过用 fresh 实例 | tool_permission.md §5 | +2 |

> UT 关键点（coder 职责）：ApprovalManager isApproved/recordAlways 按 (sessionId,key) 记忆 + sessionId 隔离（A 记不影响 B）。

### 模块 D — 回填三分发（approval 实例化）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tool-reply | app/server/src/agent/tool-reply-handler.ts | `dispatchByHandleType` | 修改 | approval 分支从存根（返 status:'pending'）改实例化：读 payload `{decision}`；allow/allow_always→按 head.toolName 查 tool（复用现有 `spec.config.tools as Tool[]` downcast L194）+ 补跑 `tool.run(head.data.arguments, ctx)`（ctx 复用现有 pattern L206-209）→ 编辑 block status success/fail；allow_always 额外 `approvalManager.recordAlways(head.sessionId, head.data.approvalKey)`；deny→isError「用户拒绝执行：{reason}」status fail | MUST 补跑走 tool.run（bash→SecureBashEngine）；MUST NOT 补跑时再调 checkPermission（INV-P7 已批准不二次拦截）；MUST import approvalManager 单例 | tool_permission.md §6；agent_hitl.md §2；tool-reply-handler.ts:174-189 | +38/-14 |
| tool-reply | app/server/src/agent/tool-reply-handler.ts | `dispatchByHandleType` (head 参数类型) | 修改 | head 类型从 `{handleType,toolName,toolCallId}` 放宽到含 `data:ApprovalData` + `sessionId`（approval 分支需读 arguments/reason/approvalKey/sessionId）；调用方 handleToolReply 传 head 已是 PendingToolCall 含这些字段 | MUST 用 PendingToolCall 子集类型（data/sessionId 已存在于 head）；MUST NOT 新增 store 读取 | tool_permission.md §6；types.ts PendingToolCall | +6/-2 |

> UT 关键点：allow 补跑真实 result 编辑成功；deny 产 isError 含 reason；allow_always 触发 recordAlways（可 mock 单例断言）。

### 模块 E — 执行层（BashEngine + SecureBashEngine + seatbelt）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bash-engine | app/server/src/tools/bash-engine.ts | `BashEngine` / `ShellResult` / `ExecOpts` (interface) | 新增 | 执行抽象：`exec(command, {cwd,timeoutMs,signal?}):Promise<ShellResult{stdout,exitCode,timedOut}>` | MUST bash tool 只引用此接口（职责分离） | bash_tools.md §4.1 | +12 |
| bash-engine | app/server/src/tools/bash-engine.ts | `BashSecurityPolicy` (interface) | 新增 | 声明式策略 `{id, description, denyRead?:string[], denyWrite?:string[]}` | denyWrite 保留字段本版不挂策略 | bash_tools.md §4.1 | +8 |
| bash-engine | app/server/src/tools/bash-engine.ts | `runShell` | 修改 | 从 bash.ts **移入**本文件（逻辑不变：spawn shell=$SHELL、超时 SIGTERM→SIGKILL、abort 联动、stdout+stderr 合并） | MUST 超时/abort/输出合并语义与原 runShell 完全一致（bash_tools §2 不破） | bash_tools.md §4.1；bash.ts:131-207 | +77（移入）|
| bash-engine | app/server/src/tools/bash-engine.ts | `SecureBashEngine` (class) | 新增 | implements BashEngine，持 `BashSecurityPolicy[]`；darwin→编译 seatbelt profile + `spawn('/usr/bin/sandbox-exec',['-p',profile,shell,'-c',command])`；非 darwin→passthrough 走 runShell | MUST profile 内联 `-p` 不写文件（packaged 护栏）；MUST 命中=非零退出走现有 isError（不特判）；MUST 零新 npm 依赖 | bash_tools.md §4.2/§4.3；design D3 | +45 |
| bash-engine | app/server/src/tools/bash-engine.ts | `compileSeatbeltProfile` | 新增 | policies→profile 字符串：`(version 1)(allow default)` + 逐条 `(deny file-read* (subpath "<abs>"))`（denyRead）/ file-write*（denyWrite）；路径 `~` 走 `expandTilde` 展开绝对 | MUST 复用 config.ts `expandTilde`（禁字面 `~` 拼接，BUG-004）；黑名单制 allow-default | bash_tools.md §4.2；config.ts:39 expandTilde | +18 |
| bash-engine | app/server/src/tools/bash-engine.ts | `getBashEngine` | 新增 | 工厂：进程级单例，按 `process.platform` 决定 SecureBashEngine(darwin) / passthrough；内置策略列表 `[{id:'ssh-read-block', denyRead:['~/.ssh']}]` | MUST 本版挂一条 ssh-read-block；MUST 单例 | bash_tools.md §4.3；design §4.1 | +14 |
| bash-engine | app/server/src/tools/bash-engine.ts | `MAX_OUTPUT_CHARS` (re-export/move) | 修改 | MAX_OUTPUT_CHARS 常量随 runShell 归属评估（coder 定位：留 bash.ts 或移 engine，保 export 不破引用方） | MUST NOT 破坏现有 import（bash.ts:29 export） | bash.ts:29 | +0/-0（位置） |

### 模块 F — bash tool（引用 engine + checkPermission）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bash-tool | app/server/src/tools/bash.ts | `bashTool.run` | 修改 | `runShell(...)` 调用替换为 `getBashEngine().exec(command,{cwd,timeoutMs:timeout,signal:ctx.signal})`；截断/超时/退出码判定逻辑不变 | MUST 只引用 BashEngine（不再直接 spawn，职责分离）；MUST NOT 改 §2 输出/超时语义 | bash_tools.md §4；bash.ts:63-121 | +4/-2 |
| bash-tool | app/server/src/tools/bash.ts | `bashTool.checkPermission` | 新增 | 实现钩子：调 `checkBashPermission(command)`（bash-policy.ts）返 PermissionDecision | MUST 纯判定无副作用（INV-P3）；deny 优先 ask | bash_tools.md §5；tool_permission.md §3 | +6 |
| bash-tool | app/server/src/tools/bash.ts | `runShell` | 删除 | 从 bash.ts 移除（已移入 bash-engine.ts） | MUST 全部引用改指 engine | bash_tools.md §4.1 | -77 |
| bash-tool | app/server/src/tools/bash.ts | BashInput schema (`dangerouslyDisableSandbox`) | 删除 | schema 无此字段（原本就没在 inputSchema，仅 spec/注释提及）；清理 L17 注释「dangerouslyDisableSandbox 保留不消费」 | MUST 明确移除死字段语义（不消费不保留） | bash_tools.md §2；bash.ts:17 | +0/-2 |

### 模块 G — bash 策略检测（纯函数）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bash-policy | app/server/src/tools/bash-policy.ts | `BashPermissionPolicy` (type) | 新增 | 内部策略项 `{id, check:(command)=>PermissionDecision|null}` 或等价结构（coder 定位具体形态） | 策略即列表可扩展 | bash_tools.md §5 | +6 |
| bash-policy | app/server/src/tools/bash-policy.ts | `checkBashPermission` | 新增 | 顺序扫 policies：先收集 deny（任一 deny 即返）；无 deny 有 ask 返首个 ask；都不命中返 `{behavior:'allow'}` | MUST deny 优先于 ask；纯函数便于 UT | bash_tools.md §5；tool_permission.md §2 | +18 |
| bash-policy | app/server/src/tools/bash-policy.ts | `detectSshRead` | 新增 | 检测命令文本引用 `~/.ssh` / `$HOME/.ssh` / `/Users/*/.ssh`（正则 best-effort）→ deny reason「禁止访问 ~/.ssh 敏感目录」 | best-effort 参数级（不做 AST）；间接绕过交执行层 | bash_tools.md §5；design §2.2 | +12 |
| bash-policy | app/server/src/tools/bash-policy.ts | `detectRmWildcard` | 新增 | 按 `;` `&&` `\|\|` `\|` 拆段取 token；命令名 rm 且任一参数含字面 `*`→ ask reason「rm 通配删除，需用户批准」approvalKey=`bash:rm-wildcard`（D1） | best-effort token 级；approvalKey 稳定=`bash:rm-wildcard` | bash_tools.md §5；design D1 | +16 |

> UT 关键点（coder 职责）：detectSshRead 命中 `ls ~/.ssh`/`cat $HOME/.ssh/x`；detectRmWildcard 命中 `rm -rf *`/`ls && rm x*` 不误伤 `rm file.txt`；checkBashPermission deny 优先（`ls ~/.ssh && rm *`→deny）。

### 模块 H — bootstrap 装配

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bootstrap | app/server/src/bootstrap.ts | `new ToolExecutionEngine()` | 修改 | 保持零参构造（引擎默认注入 approvalManager 单例）；无需显式传（coder 定位：若需显式装配则传单例） | MUST NOT 破坏现有装配；单例默认即可 | tool_permission.md §5；bootstrap.ts:473 | +0/-0 |

### 模块 I — 前端类型 + 审批卡 + 分流挂载

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-types | app/web/src/components/chat-page/types.ts | `ApprovalData` (view type) | 新增 | 前端镜像 `{toolName:string, arguments:Record<string,unknown>, reason?:string, approvalKey?:string}`；`PendingToolCallView.data` 联合加 ApprovalData | MUST 对齐后端 ApprovalData；data 联合含 FeedbackData\|ApprovalData | component-pending-approval-card.md §Props；types.ts:263 | +8 |
| ui-types | app/web/src/components/chat-page/types.ts | `isApprovalData` (guard) | 新增 | 类型守卫 `typeof data.toolName === 'string'`（need_approval 分支渲染判定） | 与 isFeedbackData 并列 | component-pending-approval-card.md §Props；types.ts:275 | +7 |
| ui-approval-card | app/web/src/components/chat-page/component-pending-approval-card.tsx | `ComponentPendingApprovalCard` | 新增 | 审批卡组件：仅渲染 subState==='need_approval'（否则 null）；展示 toolName+command(等宽)+reason；三按钮 allow/deny/allow_always → onSubmit(toolCallId,'approval',{decision})；key=toolCallId；testid 契约 | MUST testid=`pending-approval-{id}`/`approval-command`/`approval-reason`/`approval-{allow,deny,allow-always}-btn`；MUST 无取消按钮（INV-7 composer 不禁用）；≤300 行 | component-pending-approval-card.md 全文 | +90 |
| ui-chat-detail | app/web/src/components/chat-page/section-chat-detail.tsx | approval 卡分流挂载 | 修改 | 现挂提问卡处（L246）按 `pendingToolCall.subState` 分流：need_approval→ComponentPendingApprovalCard，need_feedback→ComponentPendingQuestionCard | MUST 同位互斥（不同时挂）；composer 不禁用（INV-7） | component-pending-approval-card.md §2；section-chat-detail.tsx:246 | +10/-2 |

> 前端 `MessageSender.approval`（types.ts:70）+ `submitReply(...,'approval',...)`（use-messages.ts:78）v0.0.101 已留位，本版**无需改动**（已支持 approval decision payload）——不列行。

## 影响面评估

- **跨模块**：tools（types/engine/bash/新 bash-engine/新 bash-policy/新 approval-manager）+ agent（tool-reply-handler）+ bootstrap + web（types/审批卡/section-chat-detail）。**依赖顺序**：types（A）→ approval-manager（C）→ bash-engine（E）+ bash-policy（G）→ engine 策略门（B）+ bash tool（F）→ tool-reply-handler（D）→ bootstrap（H）；前端（I）独立并行。
- **破坏性变更**：无对外 HTTP 契约破坏（端点零新增，toolReply approval 是 v0.0.101 留位）。`Tool` 接口加可选钩子向后兼容（缺省 allow）。`ApprovalData` 加可选字段向后兼容。`dispatchByHandleType` head 参数类型放宽（内部函数，非对外）。`runShell` 移文件（内部重构，引用方仅 bash tool）。
- **风险点**：
  1. **seatbelt profile 正确性**（darwin only）——错误 profile 可能致所有 bash 失败或沙箱不生效。UT/dev 手测 `sandbox-exec` 执行形态（读 `~/.ssh` 得 EPERM、普通命令正常）。
  2. **packaged 护栏**：SecureBashEngine 用系统 `/usr/bin/sandbox-exec` + 内联 profile 无文件、`~` 走 expandTilde——符合 cwd=`/` + asar 护栏（零新依赖，无路径拼接坑）。改动属「读文件系统的后端执行入口」，建议 packaged 版验证（真机 bash 走沙箱）。
  3. **dispatchByHandleType 补跑 ctx**：补跑 bash tool.run 需正确 workdir（复用现有 `spec.config.workdir`）；signal 缺省（回填补跑无 loop abort signal，可传 undefined）。
  4. **approvalManager 单例跨 engine/handler 一致性**：engine.isApproved 与 handler.recordAlways 必须操作同一单例——两处都 import `approval-manager.ts` 导出的 `approvalManager`（engine 构造默认注入同一单例）。
- **非 darwin**：passthrough 无沙箱兜底（仅参数层 checkPermission 生效）——符合 req「只考虑 mac」。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列 MUST/MUST NOT、影响行严重偏离）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
- spec↔code 漂移（coder 发现引用符号/路径与实际不符）→ 按代码实际调整 + 汇报偏离，orchestrator 记 doc-sync 待办，doc-modifier 阶段 5 统一修 spec。
