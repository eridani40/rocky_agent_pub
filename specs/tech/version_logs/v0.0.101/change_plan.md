# v0.0.101 变更计划书（method 级 review 合同）

> 架构期冻结的契约。planner 按本表切 task（`coversModules/coversFiles/coversMethods`，最粗 owning 级别）；coder 参考实现 + 汇报偏离；code-reviewer 按本表清单 G 查偏离。
> 行 = 一个函数/符号（新增 class/interface/type 各占一行）。8 列：模块 / 文件路径 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 影响行。
> 权威 req：`reqs/[done] v0.0.101.ask_question_tool/{1,2,3}-*.md`（#3 = 决策锁定表最权威）。
> 已锁决策：通用机制 / suspended+落盘 / 回填走 inbox tool_reply / 多 pending 队列+多 tab / pre-process 编辑 content block / 列表「?」/ 串行+result 三态+subState+data / handleType 三分发(direct_result|approval|callback) / tool_pending(废弃 require_approval) / 放弃直接 query 无按钮。代决：O1 file 沙箱去掉 / O7 废弃 require_approval / O8 草稿不缓存。
>
> **核对结论（architect 落表前 grep 实证）**：
> - file 工具（file-write/read/edit/glob/grep）**已全部绝对路径**（`isAbsolute` 校验 + `PATH_NOT_ABSOLUTE` code），无 `resolveInWorkspace`/`join(base,'workspace')`。**#1 实际只剩 bash.ts cwd 一处**（req #1 的 file.ts 描述已过时，是 spec↔code drift）。本表只改 bash.ts，file 工具零改动（doc-modifier 同步 spec 措辞即可）。
> - `require_human_input` event 仅在 `agent-event-types.ts` 定义，**全代码零 emit**（确认 spec「从未 emit」）。
> - studio hook 真名 `use-studio-unread-meta.ts`（非 req 写的 `use-studio-unread.ts`）。
> - StopReason 枚举在 `agent-event-types.ts:32`（非某个 agent_loop 文件）。

---

## 模块 A — Tool 钩子改造（needsApproval → interaction/onReply）+ pending result

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/server/src/tools/types.ts | `Tool` interface | 修改 | 删 `needsApproval?(input,ctx):boolean`；加 `interaction?(input,ctx): ToolInteraction \| null`（null=普通 tool 立即 run）+ `onReply?(payload,ctx): Promise<ToolRunResult>`（仅 handleType=callback 用） | MUST 删 needsApproval（不留死代码，O7 代决）；interaction 返非 null → 引擎不真跑 | req #3 §13/§决策锁定表；3-ask §13 | +12/-3 |
| app/server/src/tools/types.ts | `ToolInteraction` | 新增 | type：`{ subType: 'need_feedback'\|'need_approval'; handleType: 'direct_result'\|'approval'\|'callback'; data: FeedbackData \| ApprovalData }` | subType=前端渲染分发 key；handleType=pre-process 处理分发 key | req #3 §5/§6/§13 | +8 |
| app/server/src/tools/types.ts | `FeedbackData` / `Question` / `ApprovalData` | 新增 | ask-question 载荷：`FeedbackData{prompt?,questions:Question[]}`；`Question{id,title,type:'single'\|'multi',options:{key,label}[],allowOther}`；`ApprovalData{toolName,arguments}` | 见 req #3 §5；type enum 闭合 | req #3 §5 | +14 |
| app/server/src/tools/engine.ts | `ToolExecutionEngine.execute` | 修改 | 串行 for...of 中：调 `tool.interaction?.(input,ctx)` 返非 null → 不调 run、生成 pending ToolResultBlock（status='pending'）+ 收集到 pendingList 返给 caller；返 null → 正常 executeOne.run | MUST 保持串行 + 顺序对应；pending result 是合法 pair（INV-1）；execute 签名加返 pending 信息（见下行） | tool_execution_engine §4/§5；req #3 §2 | +35/-4 |
| app/server/src/tools/engine.ts | `execute` 返回类型 | 修改 | 从 `Promise<ToolResultBlock[]>` 改 `Promise<{ results: ToolResultBlock[]; pending: PendingToolCall[] }>`（pending 含定位/策略/载荷/编辑目标占位） | breaking（caller 适配）；caller 拿 pending 去落 SessionStore + 决定 stopReason | 3-ask §2/§4 | +6/-2 |
| app/server/src/tools/engine.ts | `buildPendingResult` | 新增 | helper：悬挂型 tool → 构造 status=pending 的 ToolResultBlock（content=人话占位「用户回答中…」+ subState + data）+ 构造 PendingToolCall wrapper（resultMessageId/resultBlockIndex 由 caller 在 ingest 后回填） | resultMessageId/resultBlockIndex 引擎不知（ingest 后才知 message id），engine 留空由 caller 回填 | 3-ask §1/§4/§7 | +22 |
| app/server/src/tools/types.ts | `PendingToolCall` | 新增 | interface（§4 字段集）：sessionId/runId/toolCallId/toolName/handleType/subState/data/resultMessageId/resultBlockIndex/status:'pending'\|'resolved' | 落盘 wrapper（INV-3）；toolCallId=配对 key | req #3 §4 | +16 |

## 模块 B — ToolResultBlock 三态 + content block 可编辑

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/server/src/message/types.ts | `ToolResultBlock` | 修改 | 加顶层 `status: 'success'\|'pending'\|'fail'`（默认 success 向后兼容）；status='pending' 时带 `subState:'need_feedback'\|'need_approval'` + `data: FeedbackData\|ApprovalData` | status 字段必填（新消息），旧数据缺省视 success；isError 保留（fail 时 isError=true） | req #3 §1；agent_message_interface §4.7 | +10/-1 |
| app/server/src/message/types.ts | `tool_reply` ContentBlock | 新增 | `ToolReplyBlock{ type:'tool_reply'; toolCallId; handleType; payload: FeedbackAnswer\|ApprovalDecision\|unknown }`（user message 内，回填走 inbox） | 进 ContentBlock 联合；encode 给 LLM 时按 handleType 序列化 | req #3 §11；3-ask §6/§7 | +9 |
| app/server/src/message/types.ts | `FeedbackAnswer` / `ApprovalDecision` | 新增 | `FeedbackAnswer{ selections: {[questionId:string]: string[]} }`（值含「其他：<text>」）；`ApprovalDecision{ decision:'allow'\|'deny'; modifiedArguments? }` | 回填 payload 类型 | req #3 §5 | +6 |
| app/server/src/message/types.ts | `MessageSource` | 修改 | enum 加 `'tool_reply'`（`'user'\|'agent'\|'approval'\|'system'\|'tool_reply'`） | 闭合性：Record<...> 类型校验 | req #3 §11 | +1/-1 |
| app/server/src/message/types.ts | `MessageSender` 判别联合 | 修改 | 加第 5 变体 `{ source:'tool_reply'; tool_reply:{ toolCallId; runId } }` | 判别联合闭合；inbox-enrich 对非 agent 原样透传（已支持） | agent_message_interface §5 | +4 |
| app/server/src/agent/context-engine.ts（ingest）/ loop-stage-context.ts | `ingestToolResults` 回填编辑 | 修改 | pre-process 回填分支：按 resultMessageId+resultBlockIndex 编辑已存在 tool message 的 content[block]（占位→真实 + status pending→success/fail），而非 append 新 message | MUST 保证占位 block 在 LLM 首次消费前可变（INV-6，§15 约束）；append-only 在「首次发 LLM 时冻结」非「写入即冻结」 | 3-ask §7/§15；context_ingest_detail §6 allowEdit | +24/-3 |

## 模块 C — StopReason + loop ③ 悬挂分流 + exit

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/server/src/agent/agent-event-types.ts | `StopReason` | 修改 | 加 `'tool_pending'`；**删 `'require_approval'`**（O7 代决废弃，被 tool_pending 取代，零 emit 永不触发故安全删） | 闭合性：所有 `case 'require_approval'` switch 分支同步删（grep 确认仅定义处 + spec） | agent_loop_base §9；req 决策锁定表 StopReason | +1/-1 |
| app/server/src/agent/agent-event-types.ts | `RequireHumanInputEvent` | 修改 | payload breaking：从 `{toolCalls:ToolCallBlock[]; prompt?}` 改 `{pending: PendingToolCall}`（单个队首） | breaking change（本版本一次性改完，不向后兼容旧 payload）；agent_event §7 | req #3 §10；3-ask §10 | +3/-3 |
| app/server/src/agent/run-react-loop.ts | `runReActLoop` ③ 段 | 修改 | ③ `executeToolsForSpec` 后：若返 pending.length>0 → 落 SessionStore.pendingToolCalls + 回填各 pending 的 resultMessageId/resultBlockIndex（ingest 后知）+ emit `require_human_input`（队首）+ state.stopReason='tool_pending' + state.done=true break | MUST 串行执行后一次性收集 pending（不逐个退出）；emit 仅携队首（INV-4） | 3-ask §2/§8 情况 a；agent_hitl §1 落地 | +30/-2 |
| app/server/src/agent/run-react-loop.ts | `executeToolsForSpec` | 修改 | 适配 execute 新返签名 `{results,pending}` → 返给 caller；透传 pending | 签名 breaking 联动模块 A | 模块 A execute 行 | +4/-2 |

## 模块 D — session suspended 第六态 + 落盘 + reconcile

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/server/src/agent/session-store-types.ts | `SessionState` | 修改 | enum 加 `'suspended'`（六态） | 闭合性；running bool 排除 suspended（INV-2） | session_state §1；req D6 | +1 |
| app/server/src/agent/session-store-types.ts | `Session.pendingToolCalls` | 修改 | Session interface 加 `pendingToolCalls?: PendingToolCall[]`（落盘，默认 `[]`） | INV-3 落盘存活；toSession 缺省 `[]` 兼容旧数据 | req #3 §4；session_store §2 | +2 |
| app/server/src/agent/schema_defs/session.ts | session schema `state` enum | 修改 | enumValues 加 `'suspended'`；加 `pendingToolCalls` 字段（type array，required false 默认 []） | 落盘 schema 对齐 | 模块 D SessionState 行 | +6/-1 |
| app/server/src/agent/session-state-machine.ts | `markSuspended` | 新增 | CAS：state∈{running} AND currentRunId=expected → suspended + running=false（currentRunId 保留供 recover，或按设计清——coder 定，recover 靠 pendingToolCalls 不靠 currentRunId） | CAS 原子；suspended 排除 running（INV-2）；唯一调用方=onRunEnd stopReason=tool_pending 分支 | session_state §2/§3；req §3 | +18 |
| app/server/src/agent/session-state-machine.ts | `markRunning` | 修改 | CAS WHERE state IN ('idle','interrupted','error') → **加 'suspended'**（suspended→running 是回填/query 激活路径） | MUST 加 suspended 否则回填后无法 activate（O6 闸门） | session_state §4.1；req §3 ③ | +1/-1 |
| app/server/src/agent/session-state-machine.ts | `reconcileOnStartup` | 修改 | 扫描 WHERE state IN ('running','interrupting') → idle（**不动 suspended**：suspended 是合法存活态，保留 + 校验 pendingToolCalls 落盘一致，不一致则 log + 清 pending） | MUST 保留 suspended（不清 idle，INV-3）；req §3 ④ d 路径 | session_state §5；req P7 | +12/-2 |
| app/server/src/agent/build-deps.ts | `MainLifecyclePort.onRunEnd` | 修改 | stopReason 分支：`'error'→markError` / `'tool_pending'→markSuspended`（新）/ 其余→markIdle | 三分支；tool_pending 走 suspended 非 idle | build-deps.ts:100-108 | +4/-1 |
| app/server/src/agent/session-store.ts | `peekPendingToolCall` / `setPendingToolCalls` / `resolvePendingToolCall` | 新增 | peek 返队首（只读）；set 落盘整个数组；resolve 按 toolCallId 标 resolved + 删一条（回填后） | SessionStore API 扩展；peek 供 API GET /pending-tool-call + 前端 recover | session_store §4；req §3 ⑦ | +20 |
| app/server/src/agent/session-store-converters.ts | `toSession` / `sessionToMetaView` | 修改 | 序列化含 pendingToolCalls + state:'suspended'；running bool 派生排除 suspended | GET /session 返 suspended + pendingToolCalls | session_meta_broadcaster:72 | +6/-1 |
| app/server/src/agent/session-meta-broadcaster.ts | `sessionToMetaView` | 修改 | meta view 含 state（已含 s.state，确认 suspended 透传）+ running（排除 suspended 自动正确，因 toSession 派生） | 列表据此亮「?」；session_meta 广播含 suspended（D6） | session_event §3a；req D6 | +2/-1 |

## 模块 E — pre-process 回填处理（handleType 三分发 + 放弃 c 路径）

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/server/src/agent/agent-loop-stage-pre.ts | `drainAndPartition` | 修改 | drain 后识别 sender.source==='tool_reply' → 走回填分支（不进普通 user/system 分流）；按 toolCallId 匹配 pendingToolCalls；按 handleType 三分发：direct_result→序列化 payload 编辑 block + status→success / approval→(本版 spec 留位不实例) / callback→tool.onReply | MUST 走 inbox（INV-5）；编辑而非 append（INV-6）；回填后 resolvePendingToolCall 删一条 | req #3 §6/§7；3-ask §7 | +40/-2 |
| app/server/src/agent/agent-loop-stage-pre.ts | `handleToolReply` | 新增 | helper：tool_reply 消息处理主逻辑（识别+匹配+handleType 分发+编辑 block+删 pending）；返「是否仍有 pending」给 caller 决定后续 | 三分支后统一：仍有 pending→emit 下一个 require_human_input + 回 suspended；无→续 LLM | 3-ask §7/§8 情况 b | +30 |
| app/server/src/agent/run-react-loop.ts | ① drain 后分支 | 修改 | pre-process 后：若检测「有 pendingToolCalls + 当前 drain 是 user query（非 tool_reply）」→ **c 路径**：不编辑占位（保持 status=pending）+ 清空 pendingToolCalls + 正常处理 query（LLM 看「需反馈未反馈」自判） | c 路径占位原样发 LLM（pair 合法 INV-1）；composer 提问态可用（INV-7） | req #3 §8 情况 c；3-ask §8 | +16 |
| app/server/src/agent/run-react-loop.ts | ① drain 后分支（回填后续） | 修改 | 回填处理后：仍有 pending→emit require_human_input(下一个) + state.done=true stopReason='tool_pending' break（续 suspended）；无 pending→continue 走 LLM | 后续 LLM/工具阶段不执行（跳出，D5） | req #3 §8 情况 b；D5 | +12 |
| app/server/src/agent/inbox-enrich.ts | `enrichForInbox` | 修改 | 确认 source!=='agent' 原样透传（已支持，加注释明确 tool_reply 不 enrich）；tool_reply 的 sender.tool_reply.{toolCallId,runId} 已由 POST handler 构造完整 | MUST 不 enrich tool_reply（判别联合保证无 agent 子结构） | inbox-enrich.ts:99 | +3/-1 |

## 模块 F — API 契约（peek + tool_reply 消息 + session 视图）

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/server/src/handlers/session-messages.ts（或 session-inbox 投递处） | POST /messages tool_reply 分支 | 新增 | 识别 body 含 tool_reply block → 构造 Message{role:'user', sender:{source:'tool_reply',tool_reply:{toolCallId,runId}}, content:[ToolReplyBlock]} → deliverTo(sessionId) | 复用 deliverTo（INV-5）；不独立接口 | req #3 §11；3-ask §11 | +28 |
| app/server/src/handlers/*.ts | `GET /session/:id/pending-tool-call` handler | 新增 | 返 `store.peekPendingToolCall(sid)`（队首，只读快照）；空队列 200 + `{pending:null}` | recover 用（切走切回/重启后前端主动拉）；只读 | api 04 §3.6（新增）；req §3 ⑦ | +18 |
| app/server/src/handlers/session-*.ts | GET /session/:id 响应 | 修改 | 返含 state:'suspended'（六态）+ pendingToolCalls（已由 toSession 透传，确认 handler 不过滤） | session 视图含 suspended + pending | api 04 §2.3 | +2/-1 |

## 模块 G — ask-question tool（首消费者）

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/server/src/tools/ask-question.ts | `askQuestionTool` | 新增 | Tool impl：definition（inputSchema questions[]+prompt，§12）+ `interaction(input,ctx)` 返 `{subType:'need_feedback', handleType:'direct_result', data: FeedbackData}`（恒悬挂）+ **无 run**（永不真跑，悬挂型）+ 无 onReply（direct_result 不需要） | 第一个悬挂型 tool 消费者；handleType=direct_result（答案即 result） | req #3 §9/§12/§13 | +60 |
| app/server/src/tools/index（或 tool registry） | ask-question 注册 | 新增 | 注册到 tool 清单（main config 默认 tools 含 ask-question） | studio member workspace 同理可用 | tools/index.md | +3 |

## 模块 H — #1 workspace bash cwd 绝对路径修复

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/server/src/tools/bash.ts | cwd 派生（line 87-88） | 修改 | `const cwd = join(base, 'workspace')` → `const cwd = base`（= session.workspaceDir 绝对，不多层）；删 mkdir workspace 逻辑（base 已由 session-config mkdir） | MUST 不多套一层（INV-8）；file 工具代码已 isAbsolute（零逻辑改动，drift：req 说的 resolveInWorkspace 不存在） | req #1 §修复方向；bash_tools.md | +2/-5 |
| app/server/src/tools/bash.ts | `definition.description` + 注释 | 修改 | "default `<workdir>/workspace`" → "default `<workdir>`"；注释 9/45 同步 | LLM 看到的描述对齐实际 cwd（绝对路径） | req #1 §改动点2 | +2/-2 |
| app/server/src/tools/file-{write,read,edit,glob,grep}.ts | inputSchema.path `description` | 修改 | path 参数描述若仍"relative to workspace"→ 改 **"Absolute file path"**（对齐代码 isAbsolute 校验 + PATH_NOT_ABSOLUTE 拒绝） | **MUST 改提示词对齐 isAbsolute**（用户强调：工具不允许相对路径，提示词也要改——代码拒相对而提示词写相对=矛盾误导 LLM）；coder 核对实际 description，已对齐则跳过 | req #1 §改动点1；file_op_tools.md | +5/-5 |
| app/plugins/builtins/rocky_context/reminder/workspace.ts | reminder 措辞强化 | 修改 | workspace reminder 补引导：「file/bash 工具请用绝对路径，基于此工作目录」（workspaceDir 已告知，强化引导 LLM 不用相对路径） | 提示词对齐（配合 file/bash description 改，可选但建议） | req #1 §改动点3 | +2/-1 |

> **#1 范围修正（用户 2026-07-09 强调「工具不允许相对路径，提示词也需要修改」）**：file 工具**代码逻辑零改动**（已 isAbsolute 拒绝相对路径），但**给 LLM 的提示词必须改**（inputSchema.path description 对齐 isAbsolute + workspace reminder 强化）——代码拒绝相对路径、提示词却写"relative to workspace"是矛盾，会误导 LLM 用相对路径然后被拒。bash 同理（cwd 绝对 + description）。O1=B 沙箱不新增（保持现状绝对路径直用）。

## 模块 I — #2 会话列表指示器（前端 + studio hook）

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/web/src/components/common/spinner-ring.tsx | `SpinnerRing` | 新增 | 共享旋转环组件（props: size）；复用 abort-btn 的 `border-t-[var(--color-accent)] animate-spin` | 三处复用；subagent 传更小 size（O9=抽共享） | req #2 §视觉 brief | +18 |
| app/web/src/components/chat-page/component-conversation-item.tsx | conv-item 渲染 | 修改 | `state∈{running,interrupting}` 渲染 `<SpinnerRing data-testid="conv-item-{id}-running-spinner">`；`state==='suspended'` 渲染 `conv-item-{id}-suspended-mark`（「?」） | 与 unread 红点错位共存（INV-9 占位固定，禁 display:none 入常规流） | req #2 §三处落地；_overview §4.2 | +18/-1 |
| app/web/src/components/chat-page/component-subagent-tree.tsx | `SubagentRow` 渲染 | 修改 | `node.state∈{running,interrupting}` 渲染 `<SpinnerRing size="sm">`（小 size） | playground subagent 覆盖（main+subagent） | req #2 §三处落地 | +8 |
| app/web/src/components/studio-page/use-studio-unread-meta.ts | hook 提取 running/state | 修改 | session_meta 广播订阅现只取 unread → 补提取 `running` + `state`（含 suspended）+ 透传 runningMap/stateMap（照红点透传路径） | **真名 use-studio-unread-meta.ts**（非 req 写的 use-studio-unread.ts — drift） | req #2 §三处落地；component_data_map | +20/-2 |
| app/web/src/components/studio-page/component-squad-tree.tsx + section-studio-sidebar/page-studio | TreeChild 渲染 + runningMap 透传 | 修改 | TreeChild 接收 runningMap/stateMap → 群聊/leader/mate item 渲染 SpinnerRing/「?」；透传链路照 unread 红点 | studio 覆盖（群聊+leader+mate）；studio 无 subagent item 不做 | req #2 §studio 会话结构 | +16/-1 |

## 模块 J — #3 前端提问卡组件 + chat area hook

| 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| app/web/src/components/chat-page/component-pending-question-card.tsx | `PendingQuestionCard` | 新增 | 复用 enqueue-view「chat-input-bar 内、composer 上方、SSE 驱动」位置；内部多 tab（questions[]）+ 单选/多选/「其他」展开输入框 + 提交按钮（全答完才 enabled）；**无取消按钮**；可见性=pendingToolCalls.length>0 | composer 提问态可用（INV-7）；唯一出口=提交按钮（b 路径）；用户直接 query 即放弃（c 路径，composer 不禁用） | req #3 §16；3-ask §16；_overview §4.11 | +120 |
| app/web/src/components/chat-page/component-pending-question-card.tsx | testid 契约 | 新增 | `pending-tool-call-{toolCallId}` / `pending-q-{qId}` / `pending-q-{qId}-option-{key}` / `pending-q-{qId}-other-toggle` / `pending-q-{qId}-other-input` / `pending-submit-btn` | testid 契约（E2E 主判定） | api §5.3；PRD UC-P1 | （含上） |
| app/web/src/components/chat-page/component-chat-composer.tsx | composer 提问态 | 修改 | 提问卡 mount 时 composer **不禁用**（保持可用，用户可发 query 触发 c 路径放弃） | INV-7；composer + 提问卡并存 | req #3 §14；3-ask §14 | +3/-2 |
| app/web/src/.../useMessages（chat_area_hooks §3） | useMessages 订阅 + onInit peek | 修改 | 订阅 `require_human_input` event（payload=pending 单个）→ mount 提问卡；onInit 在 GET /messages 后追加 GET /pending-tool-call（seed 提问卡，类比 v0.0.97 GET /inbox seed enqueue） | recover：切走切回/重启后前端主动拉队首重渲染（d 路径）；草稿不缓存（O8 代决） | req #3 §16；chat_area_hooks §3；3-ask §8 d | +24/-1 |
| app/web/src/.../chat message reducer | `require_human_input` reducer | 新增 | SSE event → reducer 收 pending → 驱动提问卡 mount/切换（多 pending 逐条，队首串行） | 多 pending 串行展示（INV-4 peek 队首单条） | req #3 §16；3-ask §10 | +16 |

---

## 开放点（coder 定位，标此处供 planner 注意）

| ID | 开放点 | 备注 |
|---|---|---|
| **O2** | 骨架 ③ 精确插入点 + interaction/onReply 钩子在 engine 接线形态 | 本表模块 A 给方向（execute 内 for...of 判 interaction），coder 定具体形态 |
| **O3** | 审批型 allow 补跑原 tool 实现（pre-process 内补跑 vs 标记后续） | 本版只交 ask-question（direct_result），approval 分支 spec 留位、不实例 |
| **O5** | transcript content block 可编辑性实现保证（§15） | 本表模块 B `ingestToolResults 回填编辑` 行给 allowEdit 方向，coder 定机制（store edit API vs 直接 mutate 未冻结 buffer） |
| **O6** | suspended 与 inbox activate 闸门细节 | 本表模块 D `markRunning` WHERE 加 suspended 已给方向，coder 定 currentRunId 清/留 |
| **草稿缓存 O8** | 提问卡答一半切走是否前端缓存 | 代决=不缓存（YAGNI），后端只保证题目恢复（peek 队首） |
| **O9** | `POST /session/:id/run`（test sync wrapper）await 终态必须含 suspended | AT case 首段用 /run 等 loop 退出；tool_pending→suspended **必须算 run 终态**返 state=suspended/stopReason=tool_pending，否则 /run 挂起致 AT timeout（designer fallback：改 POST /messages+poll_state）。coder 实现 /run await 确认含 suspended |
| **O10** | 提问卡 tab selector testid | spec §4.1 有 questions[] tab 切换但 §6 testid 表无 tab 按钮 testid（e2e designer 发现）。建议补 `pending-q-tab-{questionId}`（非阻塞，case 现 click option 绕过；若 coder 实现非激活 tab 卸载 option 则需补） |

## 核对发现的 spec↔code gap（doc-modifier 阶段 5 同步）

| gap | 现状 | 处置 |
|---|---|---|
| #1 file 工具 path 语义 | req 说 `file.ts:28-38 resolveInWorkspace` join workspace 层 | **代码已绝对路径**（file-write/read/edit/glob/grep 全 `isAbsolute` 校验）；#1 实际只剩 bash.ts cwd。doc-modifier 改 req 引用的 spec 描述对齐代码 |
| `require_approval` StopReason | spec agent_loop_base §9 列为 HITL 占位 | 本版删（O7）；doc-modifier 改 spec |
| studio hook 名 | req 写 `use-studio-unread.ts` | 真名 `use-studio-unread-meta.ts`；本表已按真名 |
| `require_human_input` emit | spec 说「从未 emit」 | grep 实证仅定义处、零 emit；确认 spec 准确 |

## 编码任务自然边界（供 planner 参考）

按耦合强度 + 可独立 review 切分（建议 5-7 task）：
1. **T1 后端数据契约层**（模块 B+D 数据结构）：message types（ToolResultBlock 三态/tool_reply/sender）+ SessionState suspended + Session.pendingToolCalls + schema + PendingToolCall/FeedbackData 类型。纯类型，无逻辑，最先做（其他依赖）。
2. **T2 后端状态机 + lifecycle**（模块 D 逻辑）：markSuspended/reconcile 改/onRunEnd 分支/sessionStore peek-set-resolve/meta view。依赖 T1。
3. **T3 后端 tool 引擎 + 钩子**（模块 A+C）：Tool.interaction/onReply + engine.execute 改签名 + buildPendingResult + ask-question tool（模块 G）+ StopReason/runReActLoop ③ 分流 + exit。依赖 T1。
4. **T4 后端 pre-process 回填 + API**（模块 E+F）：drainAndPartition 改 + handleToolReply + c 路径 + POST /messages tool_reply + GET /pending-tool-call handler。依赖 T1/T2/T3。
5. **T5 #1 bash cwd 修复**（模块 H）：独立小改，可与任意 task 并行。
6. **T6 前端 #2 指示器**（模块 I）：SpinnerRing + conv-item/subagent-tree/studio hook 透传。前端独立，依赖 T1 的 suspended state 透传（API 已含即可）。
7. **T7 前端 #3 提问卡 + hook**（模块 J）：PendingQuestionCard + useMessages 订阅 require_human_input + onInit peek + composer 不禁用。依赖 T4 API 就绪。
