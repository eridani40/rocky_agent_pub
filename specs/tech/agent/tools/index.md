---
type: index
title: Tools 子系统总起
priority: P0
updated: 2026-07-30
---

# Tools 子系统总起

## ① 是什么

tools = agent 的**行动能力层**——LLM 产出 `ToolCallBlock`（name+arguments），执行引擎按 name 路由到 `Tool` 实现，产出 `ToolResultBlock` 回灌对话。工具协议参考 Claude Code（Read/Write/Edit/Glob/Grep/Bash）+ 自研 web/agent/squad 收敛工具。**`Tool[]` 由 `SessionConfig.tools` 单一持有**；引擎、assemble、prompt tool_guidance 都从 config 取（不持久持有）。

| 核心概念 | 一句话 |
|---|---|
| **ToolDefinition** | 给 LLM 的声明（name+description+inputSchema，可选 `intro` 给 system prompt 一句话短简介），assemble 进 `snapshot.tools`；`intro` 无则 fallback `description`（[v0.0.146]） |
| **Tool** | 工具实现（`definition` + 可选 `interaction`/`onReply`（HITL 悬挂）+ `run(input,ctx)`），由 config 持有 |
| **execute** | 串行执行入口（`for...of + await`，不并发），失败不中断、顺序保证；[v0.0.101] 返 `{results, pending}`（悬挂型 tool 经 interaction 钩子产 pending wrapper） |
| **interaction / onReply** | [v0.0.101] per-call HITL 悬挂钩子：`interaction()` 返非 null → 引擎不真跑、生成 pending result；`onReply()` 仅 callback handleType 用 |
| **allowedTools** | 执行层白名单（v0.0.204 起由 `SessionTypePolicy.resolveToolSet(kind)` 产出，profile.toolBound ∩ instanceOverride） |
| **checkPermission** | **[v0.0.122]** per-call 策略钩子（可选，与 interaction 并列），执行前判 `PermissionDecision`（allow/deny/ask）；与 allowedTools 正交 |
| **readSet** | 跨工具 read 跟踪集（`config._readSet`），edit/write 覆盖前硬约束的执行依据 |
| **[v0.0.204] SessionTypePolicy.resolveToolSet** | profile 单源三层一致：bound 落 `app/plugins/session-types/*.yaml` 的 `toolBound` 字段（替代原 TS 常量 `TOOL_POLICY`）；resolveToolSet(kind, override) 三件套（tools/toolDefinitions/allowedTools）；runKind 粒度（summary=[] / consolidate=[skill_manage, memory_manage]） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| ToolDefinition/Tool 类型 + 工具清单 + 共性约定 | ToolCallBlock/ToolResultBlock 消息形态（→ `../message/`） |
| 串行执行引擎（resolve/validate/run/wrap + allowedTools 门控） | 执行时机 / loop ③（→ `../agent_interface_and_loop/`） |
| 5 类工具协议（file_op / bash / web / agent / skill / squad 工作项） | session.usage / cost 累计（→ `../session/`） |
| 工具可见性（subagent 排 agent；studio 工具集按 kind 谓词） | session store / 工作目录（→ `../session/`） |
| wrapExternalContent / SSRF / 截断 共性 util | plugin_system EP cardinality/group（→ `../../plugin_system/`） |
| HITL 悬挂钩子签名（interaction/onReply）+ 悬挂型 tool 占位 result 构造 | pendingToolCalls 持久化 / 回填循环（→ `../agent_interface_and_loop/` + `../session/`） |
| **[v0.0.204]** resolveToolSet 调用点（config 层 buildSessionConfigFromDeps + 旁路 run reminder 三态文案派生） | profile yaml schema/继承/validator（→ `../session/[P0]session_type_profile.md`） |

## ③ 与系统的关系

```
   tools KB                          ┌── agent/loop          (loop ③ 调 engine.execute)
   (本目录)   ───────────────────────┼── agent/message       (ToolCallBlock/ToolResultBlock 形态)
                                     ├── agent/context       (assemble snapshot.tools; tool_guidance prompt)
                                     ├── agent/session       (SessionConfig.tools 持有; workspaceDir; SessionTypePolicy.profile(kind).toolBound)
                                     ├── skills              (skill 工具读 SKILL.md)
                                     ├── multi_agent         (agent 工具 spawn/query/abort 契约)
                                     ├── squad               (team/goal/requirement/task 复用本引擎)
                                     └── plugin_system       (web_search_provider / see_image_provider list EP，单点路由)
```

**对外协作点**：
- 工具实现落 `app/server/src/tools/{file-*,bash,skill,web-fetch,web-search,browser,ask-question}/*.ts` + `app/server/src/agent/tools/{agent,send-message,team,goal,requirement,task}-tool.ts`。
- 默认集组装 = `app/server/src/tools/registry.ts:64 defaultTools()` → **30 个工具**（file×5 + bash + skill + skill_manage + memory + memory_manage + web_search + browser + web_fetch + see_image + agent + send_message + squad 工作项×4（team/goal/requirement/task）+ todo + cron + ask-question + history_search + history_get_context + presence + computer + panorama + manage_task + manage_classroom；可见性由 profile.toolBound 收束）。
- 引擎 = `app/server/src/tools/engine.ts:ToolExecutionEngine.execute()`（串行 + allowedTools 门控 + sharedReadSet + [v0.0.101] interaction 分流返 `{results, pending}`）。
- **[v0.0.204]** 工具策略 = `SessionTypePolicy.resolveToolSet(kind, override)`（profile 单源，三层一致：config/schema/exec 查同一份 profile.toolBound；替代原 `TOOL_POLICY` TS 常量 + `resolveTools()` 单方法；`TOOL_POLICY`/`SHARED_PLAYGROUND_BOUND` + `ToolPolicyRole`/`deriveToolPolicyRole` 全部删除）。详见 `[P0]tool_policy.md`。

## ④ 核心设计原则（跨文件不变量）

1. **串行执行不并发**——`for...of + await`，避免文件竞争/资源冲突/顺序依赖；results[i] 对应 toolCalls[i] 顺序保证。→ `tool_execution_engine.md §4`
2. **Tool[] 由 SessionConfig 单一持有**——引擎不持久持有，每次从 config.tools 按 `definition.name` 路由；assemble 用 `map(t=>t.definition)`。→ 本文件 §1
3. **专用工具优先于 bash**——read/write/edit/glob/grep 一律走专用工具；bash 里禁 `cat`/`sed`/`find`/`grep`/`rg`（除非显式指示）。→ `file_op_tools.md §1` / `bash_tools.md §2`
4. **read 前置硬约束**（跨工具）——edit/write 覆盖已存在文件前必须先 read，引擎用 `config._readSet` 跨 execute 跟踪。→ `tool_execution_engine.md §4` / `file_op_tools.md §3-§4`
5. **[v0.0.204] policy 单源 = profile yaml · 三层一致 · bound=上限 · runKind 粒度**——bound 从 TS 常量（`TOOL_POLICY`，已删）迁入 `app/plugins/session-types/*.yaml` 的 `toolBound` 字段（每 SessionKind 组合一份，详见 `../session/[P0]session_type_profile.md`）；`resolveToolSet(kind, override)` 替代 `resolveTools()` 单方法；三层一致（config/schema/exec）查同一份 profile.toolBound（保注册序 + 剔幽灵名）；bound 是上限（非实际可用集）；subagent 等带实例白名单场景 resolve = `override.tools ∩ bound`。runKind 粒度（summary=零工具 / consolidate=[skill_manage, memory_manage]）。`ToolPolicyRole`/`deriveToolPolicyRole` 删除（SessionKind 即唯一身份键）。→ `tool_policy.md §1/§3`
6. **拒绝错误统一 code**——白名单外（Layer C）+ 未注册（Layer B）合并为一条 `tool_not_allowed` code 的 `ToolResultBlock(isError=true)` 路径。→ `tool_execution_engine.md §3.1`
7. **web 工具走 undici 代理**——所有出站 HTTP（jina/zhipu/chrome 下载）走 undici `EnvHttpProxyAgent`（Bun.fetch 不读代理 env）；超时一律 `AbortSignal.timeout`（BUG-005）。→ `web_tools.md §2`
8. **[v0.0.122] 工具安全三层 + 引擎不管审批流程**——策略层 `checkPermission`（allow/deny/ask，白名单门后 interaction 前）/ 审批层 `ApprovalManager`+审批卡（ask 未同意悬挂）/ 执行层 `SecureBashEngine`+seatbelt（OS 级兜底，纵深防御）。工具只产 `PermissionDecision` 纯判定；ask 的 ApprovalManager 查询 + 悬挂由**引擎**驱动（工具不感知审批流程）。deny 走 isError 不悬挂；ask 复用 v0.0.101 pending 链路（buildPendingResult）。→ `tool_permission.md` / `bash_tools.md §4/§5`
   - **[v0.0.148] always approve per-session 持久化**：ApprovalManager 从纯内存 Map 改 cache-through + ApprovalStorePort（持久化字段 `session.alwaysApprovedKeys`），「永远同意」跨 app 重启保留（per-session 范围：换会话重置）。isApproved/recordAlways 改 async。
   - **[v0.0.148] 绿灯（approvalMode）只动审批层 invariants**：session.approvalMode='greenlight' 只在 engine.execute ask 分支内短路（视同 allow fall through），策略层 deny（在 ask 之前）+ 执行层沙箱不被绕过；绿灯与 always（approvalKey 粒度）正交。
9. **[v0.0.130.hang] 三层超时 + AbortSignal 真实清理 + HITL 结构性豁免**——每次真实 `tool.run` 由 engine 套超时 race（per-call>per-tool `defaultTimeoutMs`>默认 30s，封顶 600s）；超时经 `ctx.signal.abort()` 触发工具真实清理（非仅丢弃 promise）+ 产 `[timeout]` isError result 不留 dangling tool_use。HITL（ask/interaction 悬挂）分支**物理早于 runTool** → 结构上永不进超时 race。子进程治理：bash `detached` 建组 + 组杀；`ChildProcessRegistry` run 级 sweep 由 abort-finalize `killAll` 触发。→ `tool_execution_engine.md §4.2` / `bash_tools.md §4.5`
   - **escaped-grandchild fd 回收 + spawn errno 透出**：`setsid` 脱离组的孙进程（组杀打不到）继承 pipe 写端 → `close` 永不触发 → 读端 fd +2/run 钉死；`wireChildLifecycle.reclaimStreams()` 仅 SIGKILL 兜底后 destroy stdout/stderr（解耦 fd 回收与孙子生死，不动 close 正常路径）；`child.on('error')` 透 `NodeJS.ErrnoException.code` 进 `ShellResult.spawnErrno?`（治原吞 errno 致 exitCode=1 诊断盲区）。→ `bash_tools.md §4.6`
10. **[v0.0.141] see_image base64 只在 provider impl 内部（上下文零污染硬约束）**——多 vender 视觉理解工具与 web_search 同构；**tool 入参/出参只有本地路径 + 文字，base64/图片二进制绝不进 ToolResultBlock 或 arguments**。→ `see_image_tool.md §2/§4`
11. **[v0.0.157] 截图绝不 inline 进对话上下文（统一落盘 + 路径文本）**——computer-use/browser 工具截图必走共享 `saveSnapshot` 落盘到 `<workdir>/snapshots/<toolCallId>.<ext>`，tool_result.content[] 仅含路径 TextBlock（INV-157-1：主上下文永不 inline ImageBlock）。→ `computer_use_tool.md §2/§4` / `browser_tool.md §6/§7`

> **[v0.0.48+v0.0.204] scope 双层门控退役说明**：原「scope 工具可见性双层门控」（schema 层裁剪 + exec allowedTools）已被替代。v0.0.48 收敛为 `resolveTools()` 单方法（policy TS 常量）；**v0.0.204 进一步**：bound 迁 profile yaml，policy 函数重写为 `resolveToolSet` 委托 `SessionTypePolicy`，`TOOL_POLICY` 常量 + `ToolPolicyRole` + `scope-allowed-tools.ts` 全部删除。subagent 仍结构上不持 `agent` 工具（profile.toolBound 不含 agent），不变量保留但走 profile 而非独立 scope 字段。

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| **执行引擎 + policy** | | | |
| `tool_policy.md` | **[v0.0.204 重写]** bound 迁 profile yaml + `resolveToolSet` 三层一致 + `TOOL_POLICY`/`ToolPolicyRole` 删除 + runKind 粒度（summary=[] / consolidate=[skill_manage, memory_manage]）| P0 | [link]([P0]tool_policy.md) |
| `tool_execution_engine.md` | 串行引擎 + resolve/validate/interaction 分流/run/wrap + allowedTools + **[v0.0.101]** HITL 悬挂钩子 + **[v0.0.48]** 统一拒绝错误 `tool_not_allowed` | P0 | [link]([P0]tool_execution_engine.md) |
| `tool_permission.md` | **[v0.0.122]** 工具权限策略层 + 审批层：`PermissionDecision` + `checkPermission` 钩子 + `ApprovalManager`（**[v0.0.148]** per-session 持久化）+ approval 回填三分发 + **[v0.0.148]** 绿灯（approvalMode=greenlight）短路 | P0 | [link]([P0]tool_permission.md) |
| **基础工具** | | | |
| `file_op_tools.md` | read/write/edit/glob/grep 协议 + 共性约束（绝对路径/read 前置/行号剥离） | P0 | [link]([P0]file_op_tools.md) |
| `bash_tools.md` | bash 持久 shell + 超时/后台/沙箱 + 专用工具优先原则 | P0 | [link]([P0]bash_tools.md) |
| **web 工具** | | | |
| `web_tools.md` | 三工具定位 + 共性约定（undici 代理/wrapExternalContent/SSRF/截断） | P1 | [link]([P1]web_tools.md) |
| `web_search_tool.md` | web_search 协议 + list EP 单点路由 + 内置 Zhipu 2 impl | P1 | [link]([P1]web_search_tool.md) |
| `see_image_tool.md` | **[v0.0.141]** see_image 视觉理解协议 + see_image_provider list EP（vision group）+ app_config.see_image 路由 + 2 impl + base64 只在 impl 内部硬约束 | P1 | [link]([P1]see_image_tool.md) |
| `web_fetch_tool.md` | web_fetch ContentFetcher 契约 + jina∥local(含 headless) race + SSRF-first | P1 | [link]([P1]web_fetch_tool.md) |
| `browser_tool.md` | browser 三 mode（headless/managed-profile/attach）+ BrowserDriver 抽象 + a11y/ref + attach 门禁分层 + `[v0.0.157]` 截图统一落盘 + `[v0.0.264]` 常驻实例（BrowserInstanceManager + launch/close + 前置校验）+ `[v0.0.266 T3]` 三模式统一 execute（registry 路由，零 mode 分叉）+ `[v0.0.266]` attach 纳入 InstanceManager（launch=connect / close=disconnect 不杀 chrome）+ `[v0.0.272]` 孤儿 chrome 对账回收（marker 白名单 + 三层判定 + 启动/周期/close 触发） | P1 | [link]([P1]browser_tool.md) |
| `browser_instance_manager.md` | `[v0.0.264]` session 级浏览器实例管理：常驻 worker 循环 + launch/execute/close + owner 门禁 + idle timeout + 泄漏防护（进程/目录/端口/锁）+ 开机自检 + shutdown hook；`[v0.0.266]` attach 纳入（launch=connect / close=disconnect）；`[v0.0.266 T3]` registry 重构：BrowserHandle/ModeImpl/registry 分发 + 句柄表（197 行，零 mode=== 路由、不读 handle 私有字段）+ execute 统一路由（M1 防御分支下线）；`[v0.0.272]` 对账兜底回收（§4.9）：marker 白名单 + 双段扫描 + 三层判定 + chromePid 上报持久化 + close 兜底 kill chrome 组 | P1 | [link]([P1]browser_instance_manager.md) |
| `computer_use_tool.md` | **[v0.0.105]** 单 `computer` tool + 11 action dispatch + fail-closed 分层门禁 + window-relative 三段式坐标 + `[v0.0.157]` 截图落盘 + 仅 bound playground | P1 | [link]([P1]computer_use_tool.md) |
| **历史检索工具** | | | |
| `history_search_tool.md` | **[v0.0.126]** history_search tool（read-only，免审批）+ FTS5 BM25 召回 + snippet + session/message 锚点 | P1 | [link]([P1]history_search_tool.md) |
| `history_get_context_tool.md` | **[v0.0.126]** history_get_context tool（read-only）+ 按 messageId 回 transcript 取上下文窗 + 两层截断 | P1 | [link]([P1]history_get_context_tool.md) |
| **派生/编排工具** | | | |
| `agent_tools.md` | agent 工具（spawn/query/abort）+ scope=EP 可见性 + subagent 不可再派生（profile.toolBound 不含 agent）| P1 | [link]([P1]agent_tools.md) |
| `task_tools.md` | task 工具占位（实现迁至 `../../squad/[P1]squad_tools.md §3`） | P1 | [link]([P1]task_tools.md) |
| `todo_tools.md` | **[v0.0.223]** todo 工具（session 级双层待办，7 action free-form 状态机）+ 独立 store（仿 cron-adapter）+ ReminderCtx todoStore + profile.toolBound 绑所有 parent.main | P1 | [link]([P1]todo_tools.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
