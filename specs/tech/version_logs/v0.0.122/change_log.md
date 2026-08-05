# v0.0.122 变更发布说明 — 工具权限系统（策略 / 审批 / 执行 三层，范围=bash）

> 版本轴发布说明（method 级契约见同目录 `change_plan.md`）。本版首次引入工具执行安全三层，范围仅 bash 工具。
> 决策锁定：D1 rm 口径=命令名 rm 且参数含字面 `*`；D2 永远同意=会话内内存不落盘；D3 沙箱=macOS sandbox-exec + seatbelt（profile 内联 `-p`）。

## 一句话

工具执行在引擎串行 loop 内新增一道正交安全门（白名单门后、interaction 前）：**策略层** `checkPermission` 判 allow/deny/ask；**审批层** `ApprovalManager` + 前端审批卡（ask 未同意则悬挂，复用 v0.0.101 HITL）；**执行层** `SecureBashEngine` + seatbelt 沙箱（OS 级兜底，纵深防御）。bash 本版挂两条策略：`ssh-read`（引用 `~/.ssh` → deny）+ `rm-wildcard`（rm 且参数含 `*` → ask）。

## 核心设计原则（跨文件不变量）

- **INV-P1（正交两门）**：`allowedTools`（能不能用这个工具）与 `checkPermission`（这次调用参数安不安全）是两道独立门，白名单先过、策略后过。
- **INV-P2（钩子可选缺省 allow）**：`checkPermission` 是 `Tool` 可选钩子，未实现视同 allow（现状行为不变，仅 bash 挂策略）。
- **INV-P3（工具不管审批流程）**：工具的 `checkPermission` 只产纯判定 `PermissionDecision`（无副作用）；ask 时 ApprovalManager 查询 + 悬挂由**引擎**驱动。
- **INV-P4（deny 不悬挂）**：deny → isError 结果直进 transcript（reason 回灌 LLM），不进 pending 队列。
- **INV-P5（ask 复用 HITL）**：ask 未同意 → 引擎把 `PermissionDecision.ask` 翻成 `ToolInteraction{need_approval, approval}` → 走现有 `buildPendingResult`（占位/pending/ingest/suspended 全复用 v0.0.101，不新造分支）。
- **INV-P6（记忆按 key + sessionId）**：`ApprovalManager` 仅内存、按 (sessionId, approvalKey) 记忆；重启/新会话失效（D2）。
- **INV-P7（补跑不二次拦截）**：allow 回填补跑 `tool.run` 时不再调 checkPermission（已批准）。
- **纵深防御**：策略层 `ssh-read` 是参数级 best-effort；执行层 seatbelt 是 OS 级兜底——参数漏网（脚本嵌套引用/变量拼接读 `~/.ssh`）由沙箱在 OS 层拦下，两层有意重复缺一不可。

## 变更文件（tech spec）

- **新建 `agent/tools/[P0]tool_permission.md`**：策略层 + 审批层完整 spec（`PermissionDecision` 三态 / `checkPermission` 钩子契约 / 引擎集成点位与顺序 / `ApprovalManager` 生命周期 / approval 回填三分发 / 与 allowedTools+interaction 正交关系 / INV-P1~P7）。
- **`agent/tools/[P0]bash_tools.md` §2/§4/§5**：§2 删 `dangerouslyDisableSandbox` 死字段（v0.0.8 起从未消费，且与安全模型冲突）；§4 新增执行层（`BashEngine.exec` / `SecureBashEngine` seatbelt / `compileSeatbeltProfile` allow-default+逐条 deny / `getBashEngine` 工厂 / 非 darwin passthrough）；§5 新增策略层两条 bash 策略（deny 优先 ask）。
- **`agent/tools/index.md`**：概念表加 `checkPermission` 行 + 核心原则 8（工具安全三层）+ 导航加 `tool_permission.md`。
- **`agent/agent_interface_and_loop/[P0]agent_hitl.md`**：approval handleType 从「留位」转「已实例」；§2 三分发补 allow/allow_always/deny 语义；§3 情况 a 触发源补「引擎 checkPermission ask」。
- **`agent/agent_interface_and_loop/index.md` §14/16**：approval infra 从 future 措辞更新为 v0.0.122 已落地。

## 变更文件（api / ui / prd）

- **`api/overall/04-agent-session.md §3.2`**：handleType='approval' 实例化说明（`toolReply.payload=ApprovalDecision={decision:'allow'|'allow_always'|'deny'}`；端点零新增，复用 v0.0.101 HITL 通道）。
- **`ui/components/chat-page/component-pending-approval-card.md`（新）**：审批卡组件 spec（同位互斥提问卡 + 三按钮 + testid `pending-approval-{id}`/`approval-command`/`approval-reason`/`approval-{allow,deny,allow-always}-btn`）。
- **`prd/overall/10-tool-permission.md`（新）**：三层工具安全产品化表达 + 关键用户路径 UC-1~6。

## 实现落点

- 后端：`app/server/src/tools/types.ts`（`PermissionDecision` / `Tool.checkPermission?` / `ApprovalData` 加 reason+approvalKey）；`app/server/src/tools/engine.ts`（策略门 + `safeCheckPermission` + `buildApprovalInteraction`）；`app/server/src/tools/approval-manager.ts`（新，`ApprovalManager` + 进程单例）；`app/server/src/tools/bash-engine.ts`（新，`BashEngine`/`SecureBashEngine`/`compileSeatbeltProfile`/`getBashEngine`，`runShell` 从 bash.ts 移入）；`app/server/src/tools/bash-policy.ts`（新，`checkBashPermission`/`detectSshRead`/`detectRmWildcard`）；`app/server/src/tools/bash.ts`（`run` 改走 `getBashEngine().exec` + 加 `checkPermission` 钩子）；`app/server/src/agent/tool-reply-handler.ts`（`dispatchByHandleType` approval 分支实例化）。
- 前端：`app/web/src/components/chat-page/component-pending-approval-card.tsx`（新审批卡）+ `types.ts`（`ApprovalData` view + `isApprovalData` guard）+ `section-chat-detail.tsx`（按 subState 分流挂载）。

## 事后偏差（doc-sync 记录）

- **`expandTilde` 本地重实现（非复用 config）**：change_plan 模块 E 写「复用 config.ts `expandTilde`」，实际 `bash-engine.ts` 本地实现了等价 `expandTilde`——因为 `config.ts` 只 `export resolveDataDir`，未 export `expandTilde`（内部 function）。两份逻辑完全一致、皆不做字面 `~` 拼接，护栏（BUG-004 cwd=`/`）不破。已在 `bash_tools.md §4.2` 记录事实。**建议（后续项）**：把 `config.ts` 的 `expandTilde` 提为共享 export，消除重复；本版不改产品代码。
- **`compileSeatbeltProfile` 加 `assertSafePath` 防护**（change_plan 未列）：编译前拒绝含 `"` / `\` 的路径（破坏 profile 字符串结构），提前失败比静默生成错误 profile 安全。内置策略路径均可信常量，属防御性增强。已在 `bash_tools.md §4.2` 记录。

## 范围与非目标

- ✅ 仅 bash 工具接 `checkPermission`；其他工具钩子未实现=allow。HTTP 端点零新增。
- ❌ 不做规则配置 UI / settings 持久化规则（策略在代码内列表）；不做规则持久化（永远同意仅内存会话内记忆）。
- ❌ 不做 denyWrite 场景 / 网络隔离（类型保留 `denyWrite` 字段不挂策略）；不做 EP 插件化策略挂载。
- ❌ 非 darwin 无沙箱兜底（passthrough，仅参数层 checkPermission 生效）——符合 req「只考虑 mac」。
- **本版本不含 tests/ 行**（用户裁决：AT/ET 框架 v0.0.120 重构中；UT 覆盖策略检测 / ApprovalManager / seatbelt profile 编译 / 审批卡）。
