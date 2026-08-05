---
type: log
title: Agent Interface & Loop KB 变更记录
updated: 2026-08-04
---

# Agent Interface & Loop KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-08-04 · v0.0.255（RunLifecyclePort 加回报兜底钩子 — replySettle 装配 + onInterrupted 代发旁路）

- **`[P0]agent_loop_unified.md §3.2`**：RunLifecyclePort 表 onRunEnd/onInterrupted 两行更新（main 列追加 subagent 回报兜底分派）；新增「replySettle 装配」段——`buildRunDeps` 仅 `isMain && kind.isSubagent` 装配（baseline=装配点 `deliveryEpoch()` 快照，carried=装配点 `takePending(sid)` 取出）；onRunEnd 在 persistRun/CAS 后分派 tool_pending→`stashPending` / 其余→`settleAgentReplyFallback`，settle 异常吞掉不阻断收尾主链。§4 中断退出/正常退出 main 条同步（onInterrupted 默认 noop，唯一例外 = replySettle 代发旁路）。
- **`[P0]agent_loop_eager_drain.md §4` + `[P0]agent_interface.md` RunSpec.lifecycle 注释**：「onInterrupted=noop」绝对表述订正为「默认 noop；subagent main run 例外（回报兜底代发旁路）」。
- **新类型链路**：`loop-ports.ts` `AgentReplyRequest` + `LoopState.agentReplyRequests`（本 run drain 收集的待回 a2a 请求，messageId=drain reissue 后新 id）；`agent-loop-stage-pre.ts` `DrainResult.agentReplyRequests` + `drainAndPartition` 收集（`sender.source='agent' && needReply=true`）；`loop-stage-context.ts` `prepareStage` 跨轮只增不判累积。
- **onInterrupted「恒 noop」注释破除**：代码文件头原「onInterrupted 恒 noop」注释已同步新现实——默认 noop，仅装配 replySettle 的 subagent main run 开代发旁路（transcript 收尾仍归 abort api 4 步不变）。
- 详情：`specs/tech/version_logs/v0.0.255/change_plan.md` + `change_log.md`

## 2026-07-27 · v0.0.207（abort 副作用 authority transfer — 句柄集中吊销）

- **`[P0]agent_interrupt.md §2.5 + §7`**：新增「Authority Transfer」第二层防御——abort api step1 `controller.aborted=true` 后**主动吊销 loop 对外副作用句柄**（`loop.revokeSideEffects?.()`，`abort-finalize.ts:102`，在 `killAll` 后、`waitForLoopExit` 前）。loop 通过 `wireEmitCtx.bus.emit`/`clearReplay` + `wireContextEngine.ingest` 的副作用调用 Proxy 拦截变 no-op；abort api 直发 `bus.emit` + `store.appendMessages` 走原对象豁免。§2.5 加吊销/豁免边界表（4 行：emit / clearReplay / ingest / assemble-read-only 不吊销）。
- **背景**：v0.0.207 修 prod k3 tokenization failed——中断落在 loop tool 执行段（run-react-loop.ts :180-223 零检查点，保 tool_use/result 配对）时 loop 与 abort api 双写同 toolCallId 的 tool_result → 畸形消息。第一层（loop 各点查 `controller.aborted`）分散易漏；第二层（单一吊销点）loop 代码零侵入兜底。
- **实现**（`app/server/src/agent/revocable-side-effects.ts`）：`wrapRevocableEmitCtx` + `wrapRevocableContextEngine` JS Proxy 包装；`buildRunDeps` 装配组合 revoke 传 `RunLoopHandle` 第 4 参（可选，旁路 3 参构造不破）；主对话 + 旁路都包，旁路不被调 revoke（无副作用）。
- §7 加不变量 #7（authority transfer 双层防御 + 边界表引用 §2.5）。
- 详情：`specs/tech/version_logs/v0.0.207/change_plan.md`（§T2 — authority transfer 原则 + 吊销/豁免边界表）

## 2026-07-26 · v0.0.206（origin.instanceId → configId — channel 无状态化 wire 改名）

- **`[P0]agent_event.md §4.2`**：`MessageStartEvent.origin` 字段 `instanceId → configId`（`{type, configId}`；deriveOrigin 含 client 缺省 `{type:'client', configId:'0'}`）——channel 子系统 ChannelInstance→ChannelConfig 全链改名的 wire 侧联动（`agent-event-types.ts` + `agent-loop-emitters.ts deriveOrigin` 纯改名，行为零变化；前端 reducer 镜像同步）。
- **迁移边界**：origin 是**运行时派生字段不落盘**（deriveOrigin 从 message.sender.channel 现算随 message_start 发出）→ 无数据可迁；历史 transcript 的 sender.channel 不迁（见 `../message/log.md`）。
- 详情：`specs/tech/version_logs/v0.0.206/change_plan.md`（模块六）

## 2026-07-25 · v0.0.204 收尾（agent_manager 拆分 + sideRun rename 落定 + 旁路不变量对齐）

- **`[P0]agent_manager.md §1-§7`**：全文对齐 sideRun 时代——forkedRun→sideRun / ForkedRunOptions→SideRunOptions（allowedTools/maxIter/toolDefinitions 移出 options，profile+snapshot 派生；snapshot 必填）/ buildMainDeps+buildForkedDeps→buildRunDeps 单装配 / modeKey→runKind（groupKey `_amt:main`）。§1 加文件拆分说明：agent-manager.ts 450 行 thin wrapper + **agent-side-run.ts**（executeSideRun 旁路编排：并发检查/controller/snapshot 克隆/effectiveKind 派生——config.kind 缺失兜底 playground-rocky:parent，tier2 三 caller 场景）+ **agent-run-registry.ts**（startRunAndTrack + 三 map 管理）。
- **`[P0]agent_loop_forked.md`**：标题与正文改述「旁路 run（runKind=summary/consolidate）不变量契约源」——fork-2 纯 directive 修复确认（post-compact-consolidation 删 serializeMessages，v0.0.51 遗留违例清除，fork-1/fork-2 同契约）；§2 装配/流程改 buildRunDeps + scopeId=canonicalId + RunLifecyclePort（旁路 onUsage early return，usage caller 总量口径）；§4 taskType 表→runKind 表；§5 副作用表全字段 profile 承载；§8/§9 emit/sideRun 示例对齐。

## 2026-07-24 · v0.0.204（装配合并 + forked 命名退役 + snapshot 可选双路径）

- **build-deps.ts + build-forked-deps.ts + forked-lifecycle-port.ts 三文件删除**（mv soft_deleted/v0.0.204/agent_build_deps/）：二元分裂装配合并为单 `build-run-deps.ts`（profile 驱动 RunSpec 装配，runShape/lifecycleHooks/eventChannel/toolDefinitionsSource 全字段驱动）；两 LifecyclePort 合并为 `RunLifecyclePort` 单 impl 按 profile.runShape 字段分派（persistsRun→persistRun / touchesStateMachine→五态机 CAS / usagePartition→accumulateUsage type）；两 LoopHandle 合并为 `RunLoopHandle`（releasesScopeSession 旗标承载旁路 run per-run buffer 回收）；MUTED_BUS → silentBus（forked 命名体系退役）。
- **`[P0]agent_interface.md` RunSpec.modeKey → runKind**：扁平闭合枚举 3 值（main/summary/consolidate）替代 modeKey 自由 string + 并存 runKind 双维度；scopeId 不再由 modeKey 驱动（路由层删除）；`enableToolWhitelist`/`toolWhitelist` 字段删除（caller intent 收编 profile.toolBound）；agentRuns map key = `${sid}_${runKind}`。
- **`[P0]agent_manager.md`**：`activate` / 旁路 run 入口统一调 buildRunDeps（替 buildMainDeps/buildForkedDeps）；`forkedRun` 内部删 manager 派生 toolWhitelist/maxIter（下沉 buildRunDeps）；`run(spec, loop)` 唯一入口不变；`abort(sid, runId, runKind)` 参数命名（原 modeKey）。
- **`[P0]agent_loop_unified.md` + `[P0]agent_loop_forked.md`**：snapshot 可选双路径在 `loop-stage-context.ts buildSideRunSnapshot(contextEngine, config, snapshot?)` 实现——复用路径（自动压缩 caller 传 snapshot，零拷贝零重建，保 prompt cache 前缀）/ 重建路径（手动压缩 caller 不传，`contextEngine.assemble(config, 'default', null)` 完整重建 + store 持久化全对话）；手动/自动 summary 同 type 同 profile 同组装链（profile 零区分手动/自动字段，UT 钉死）。
- **`[P0]agent_scope_router.md`（v0.0.204 废止）**：`AgentScopeRouter` 整文件删除；替代 = `scopeIdOf(kind) = kind.canonicalId()` 纯拼接（单行函数，零路由表零决策逻辑）；所有 scope 组合在 `app/plugins/scopes/` 全量配 yaml（空文件 = 沿 extends 链继承）。
- **`[P0]forked_reminder.md`**：三态文案从 profile.toolBound 派生（替代原 RunSpec.enableToolWhitelist+toolWhitelist，已删）；spec 文件名待 doc-modifier rename 为 reminder-injector.md（代码文件已同步改造）。
- **`index.md`**：核心概念表 + 边界表 + ④原则全面更新（4 port → profile.runShape + RunLifecyclePort + emit；modeKey → runKind；AgentScopeRouter → scopeIdOf 纯拼接；新增原则 #2 buildRunDeps 单装配 + #21 旁路 run 不变量由 profile 承载）。
- **mapUsagePartition 偏离**（spec↔code 已知点，待 doc-sync 后续修 spec）：profile.runShape.usagePartition（current/sub/summary/consolidate）→ store UsagePartition（current/sub/forked）映射，summary/consolidate 同落 'forked' 桶（store 三分区语义保留，见 `../session/[P0]session_usage.md §6/§7`）。
- 详情：`specs/tech/version_logs/v0.0.204/change_plan.md`

## 2026-07-20 · spec-cleanup（过期代码引用清理）

- `agent_loop_forked.md`：删除已退役的 ForkedAgent 类（旧§2）/ ForkedLoop 接口（旧§3）定义，重编章节号。旧定义归档于此 log（v0.0.16 引入策略类化 → v0.0.40 退役迁入 unified）。
- `index.md §③`：修正对外协作点文件路径（删 eager-drain-agent/forked-agent/agent-loop.ts monolithic 引用，改为 run-react-loop.ts + build-deps.ts + forked-agent-run-shell.ts 等实际文件）。
- `[P2]agent_loop_lazy_drain.md`：标注概念未落地（代码零实现）。

## 2026-07-17 · v0.0.161（queue 消息未入 context bug — drain user 分支同轨 reissue + msgId 分配契约 I1/I2/I3）

- **`[P0]agent_inbox_enqueue.md §6` drain 侧 cancel 配对**：drain 正常 processed 分支从「user 保留原 id / agent/system/approval reissue」改为「四分支统一 reissue newId=ulid()」；伪代码 + 后置说明段更新，指向新 §6.4。
- **`[P0]agent_inbox_enqueue.md §6.4` 新增「msgId 分配契约（v0.0.161）」**：I1 enqueueId ≠ msgId 严格独立（一消息 = 两 ID，各自 ULID、语义不同、生命周期不同）；I2 write-in 时刻 msgId 是 throwaway（HTTP 响应 / message_enqueued SSE / GET /inbox 三处均不外泄 msgId 字段）；I3 drain 后 msgId 通过 emitEnqueuedProcessed(enqueueId, newId, role) 通知 UI 建立映射。tool_reply 分支例外：不进 transcript、不 reissue（编辑既有占位而非追加，见 message KB §7 (d)）。
- **`[P0]agent_loop_eager_drain.md §5.1` drain 描述**：user 分支同步描述 reissue 语义，与 `[P0]agent_inbox_enqueue.md §6` 保持契约同源（同一 drain 契约不可有二源）。
- **修复方向**：v0.0.161 bug 根因 = user 分支保留 HTTP-in 时刻 throwaway id 与 agent/system/approval drain 时刻 reissue 分裂时钟 → transcript 按 id 升序时排队 user msg 位置错乱到「过去」→ context assemble 按 id 切割时被永久漏掉（prod session `01KXNP...` 22 条 user msg 只 2 条入 LLM）。A 修复：user 分支同轨 reissue → 单调化到 drain 时钟。
- 详情：`specs/tech/version_logs/v0.0.161/change_log.md`

## 2026-07-15 · v0.0.153（forked reminder 模板正文文件化）

- **`[P0]forked_reminder.md §3`**：文案模板（骨架 + 三态 + modeKey 微调）不再是 `forked-reminder-injector.ts` 内字符串字面量，迁移至 `content/forked_reminder/*.md`（5 文件），经新增 `ForkedReminderHandler` 读取拼接；三态/modeKey 判断逻辑仍留调用方，措辞逐字一致。通用机制见 `../context/[P0]prompt_content_files.md §4.2`。
- 详情：`specs/tech/version_logs/v0.0.153/change_log.md`

## 2026-07-13 · v0.0.130.hang（agent hang 修复 — SSE 阶段事件 + max_iterations 轮次边界 + 子进程 sweep）

- **`[P0]agent_event.md §5.6`（新增两事件）**：`ToolExecutionStartEvent{toolNames,toolCallIds}`（③ execute 前 emit）+ `ToolExecutionEndEvent{resultCount?,pendingCount?}`（ingestToolResults 后 emit）；与 `loop_tools_begin/end` breadcrumb 同址同字段。**不复用 `tool_result_start`**（其语义=单工具执行已结束，语义相反）。§3 分类表 + §8 两联合 + §9 重建映射同步（不修改 Message，驱动前端 loadingPhase='tool_executing'+runningToolNames）。
- **`index.md ④ 原则 #17`（max_iterations 轮次边界）**：`checkMaxIter` 判定从「② callLLM 后、③ 执行前」迁到 ④ Exit Check `state.step++` 之后（轮次边界）——凡落盘 tool_use 必有配对 tool_result（消灭 dangling 半轮，live 案例 01KX5WDBT2）；第 maxIter+1 次 LLM 不再发生。off-by-one：maxIter=25 恰 25 完整轮后停，`endStepSpan(state,true)`。`agent_loop_unified.md §2` 骨架伪码 + `agent_loop_base.md §6` 同步。
- **`index.md ④ 原则 #18` + `agent_interrupt.md §1/§3.1` + `agent_interface.md`**：`AbortControllerHandle.childRegistry?`（run 级子进程注册表）；abort-finalize `aborted=true` 后 fire-and-forget `killAll()` 杀在途子进程组解 hung tool（仅置 aborted 对卡在 hung tool 的 loop 无效——pipe 不释放 tool.run 永不 resolve）。单 tool 超时另走 `ctx.signal` 自清不经 killAll。
- **C loop-watchdog**：新 stub `agent/loop-watchdog.ts`（interface `LoopWatchdog{reset,stop}` + 180s 无进展→abort 语义注释），本版仅留接口未 wire、无运行时依赖。
- `agent_loop_base.md §7.2` 各阶段产出事件加 `tool_execution_start/end` 边界。

详情：`specs/tech/version_logs/v0.0.130.hang/change_log.md`

## 2026-07-12 · v0.0.124.hitl（HITL 审批/回填后补发 tool_result SSE — 前端实时更新）

- **`[P0]agent_hitl.md`**：新增 **INV-8（emit-after-persist）** + §2 回填流程步骤 4.5（`appendMessages` 持久化后、`resolvePendingToolCall` 前经 `emitToolResult(emitCtx, newBlock)` 补发 `tool_result_start/delta/end` 三帧，与正常执行路径同构；覆盖全部 handleType 分支 direct_result/allow/allow_always/deny/callback，统一补不分 branch；前端持久 SSE 通道按 `toolCallId` 定位对应 tool_result part 就地翻转 pending→success/fail）。修复：此前 HITL 回填只持久化不推送，前端停留 pending 占位（数据已落库但需刷新/重进才恢复）。对应 `handleToolReply` 新增可选 `emitCtx?: EmitContext` 参数，调用处 `loop-stage-context.ts` 传 `spec.wireEmitCtx`。
- **`[P0]agent_loop_base.md §2.2`**：executeTools emit 说明补「HITL 回填路径也 emit」——emit 不是正常执行路径专属，凡 tool_result block 内容变更（首发 / HITL 回填后编辑）都须 emit。
- 新增 AT case `tests/api/approval/approval_sse_update_tc1`（含 recordings）验证审批后 tool_result SSE 补发。
- 详见 `states/v0.0.124.hitl/`。

## 2026-07-12 · v0.0.122（approval handleType 从留位转已实例 — 工具权限系统）

- **`[P0]agent_hitl.md`**：approval handleType 从「留位」转「**v0.0.122 已实例**」（首消费者=bash 危险命令审批）。§2 三分发补 approval 分支 allow/allow_always/deny 完整语义（allow/allow_always 补跑 tool.run 经沙箱、allow_always 额外 recordAlways、deny 编辑 isError「用户拒绝执行」）；§3 情况 a 触发源补「引擎 checkPermission 判 ask 且未 isApproved」——与 `tool.interaction` 殊途同归走 `buildPendingResult`（approval 的 pending 由引擎把 `PermissionDecision.ask` 翻成 `ToolInteraction{need_approval, approval}`）。策略/审批/执行三层设计见 `../tools/[P0]tool_permission.md`。
- **`index.md`**：§14/16 原则中「未来 tool-approval 共用同一 infra（handleType=approval）」的 future 措辞更新为「approval 已由 v0.0.122 落地」；frontmatter `updated` 同步。
- 详见 `specs/tech/version_logs/v0.0.122/change_log.md`。

## 2026-07-11 · v0.0.119.bugs（a2a 消息 SSE 作者身份 — BUG-001）

- **`[P0]agent_event.md §4.2` MessageStartEvent 加 `sender?: MessageStartSender`**（仅 a2a 消息携带）：结构 `{source:'agent', agent:{ref:{type,sessionId,name}}}`——`Message.sender` 最小子集。由 `emitUserMessageBlocks` → `deriveEventSender(message.sender)` 派生（source==='agent' 才带 agent.ref 三字段，其它 source 返 undefined）。前端 reducer 消费时 sender 优先于 origin 重建 `Message.sender`（供 isA2aInbox 判定 + 成员名/头像解析）；origin 与 sender 各司其职、互不覆盖。刻意为最小子集（不带 needReply/imUserId 等冗余/PII）。修复 a2a 消息 SSE 实时推送被误判为 YOU（落库完整故重进正确）。§9 映射表 message_start 行同步。frontmatter `updated` 同步。
- 详见 `specs/tech/version_logs/v0.0.119.bugs/change_log.md`（如有）+ `states/v0.0.119.bugs/bugs/BUG-001`。

## 2026-07-10 · v0.0.107（user message 跨渠道来源标识 + echo 屏蔽）

- **`[P0]agent_event.md §4.2` MessageStartEvent 加 `origin?: {type, instanceId}`**（仅 role=user 携带）：由 `emitUserMessageBlocks` 从 `message.sender.channel` 派生 slim 信封（剥 imUserId/imUserName PII）——user+channel → `{channel.type, channel.instanceId}`；user 无 channel（web client）→ `{type:'client', instanceId:'0'}`；非 user source（gate 按 `sender.source==='user'`）→ 无 origin。origin 是**事件层信封元数据**，绝不进 LLM content（protocol-encode 不读）；供 channel accumulator echo 屏蔽（self instanceId→DROP）+ client 来源徽标消费。frontmatter `updated` 同步。
- 详见 `specs/tech/version_logs/v0.0.107/change_log.md` + `change_plan.md`（模块 B/C）+ `../../channel/log.md`（accumulator 消费侧）。

## 2026-07-09 · v0.0.101（ask-question tool + 通用 pending 悬挂机制 + 列表指示器 + workspace 绝对路径修复）

- **`[P0]agent_loop_base.md §9` StopReason 扩展**：新增 `tool_pending`（通用悬挂退出：tool interaction() 返非 null → pending result + session=suspended）；**删 `require_approval`**（O7 代决废弃，零 emit 安全删）。
- **`[P0]agent_hitl.md` 落地 canonical**：从 `[future]` 转为 active；approval 分支落地 + 新增 feedback 分支（ask-question）；旧 `needsApproval` 钩子泛化为 `Tool.interaction/onReply`（§1/§2 流程图 doc-modifier 阶段 5 改写为通用悬挂机制）。
- **`[P0]agent_event.md §7` payload breaking**：`RequireHumanInputEvent` 从 `{toolCalls[],prompt?}` 改 `{pending: PendingToolCall}`（单个队首）。
- **`index.md ④` 新增核心设计原则 14/15/16**：悬挂型 tool 不原地等待 / 回填走 inbox + transcript 首次发 LLM 时冻结 / handleType 三分发 + suspended 合法存活。
- 详见 `specs/tech/version_logs/v0.0.101/change_log.md` + `change_plan.md`（method 级契约，模块 C/E）。

## 2026-07-09 · v0.0.102（activate error shell 透传原 Error — ghost model 返 400）

- **`[P0]agent_interface.md §3` AgentRun 接口加 `error?: unknown` 字段**：state==='error' 时携带原 Error（makeErrorRun 透传）；pending/completed 态无此字段。caller（session-run/session-messages handler）读 `agentRun.error instanceof ModelNotConfiguredError` → 返语义化 400。加段说明「error 字段 = activate 失败的语义化错误载体」取代旧 throw-only 路径。
- **`[P0]agent_manager.md` 四处补 error shell 契约**：
  - §1 核心职责 activate 加「[v0.0.102] activate 失败走 error shell」——catch 落 makeErrorRun 透传原 Error，非 throw（防 unhandled rejection 击穿 Bun 进程）。
  - §2 activate 签名补「失败 = error shell」一条（config resolve / session not found / buildMainDeps throw → makeErrorRun）；@note 补「需读 state/error 区分正常 run vs error shell」。
  - §4 AgentManagerImpl 伪代码 activate 三处 catch 改造：config resolve catch（透传 errObj）/ session not found（字符串入参 makeErrorRun 内部包 Error）/ buildMainDeps throw catch。均透传原 Error。
  - §4 末尾新增 **§4.1 makeErrorRun 契约段**：签名 `(sid, modeKey, error: Error|string)`、透传原则（字符串包 Error / Error 原样）、caller 识别链路（resolveErrorRunResult helper：instanceof ModelNotConfiguredError → 400、其余 → 500）、handler 入口示例（deliverTo throw catch + state==='error' shell）、两路径并存说明。
- **`specs/api/overall/04-agent-session.md §3.2` POST /messages 补 400 MODEL_NOT_CONFIGURED 契约 + error shell 路径**：error 段加「400 `{code, message, detail}` model 未配置」+ 新增「[v0.0.102] error shell 路径返 400」段（两路径：① deliverTo 同步 throw → handler catch；② activate 落 makeErrorRun 返 state='error' run → resolveErrorRunResult 识别 instanceof）；§9 错误码表 400 行加 `model_not_configured` 场景 + 500 行加 activate 失败兜底说明。
- **修复 code↔spec 偏离**（CLAUDE.md 原则 12）：v0.0.102 前代码已加 `AgentRun.error` + `makeErrorRun(Error|string)` + `resolveErrorRunResult` helper（reviewer 重构），但 spec 未同步——agent_interface.md §3 缺 error 字段、agent_manager.md activate 描述只说「thin wrapper」不提 error shell、04-agent-session.md §3.2 错误段无 400 MODEL_NOT_CONFIGURED 契约。本次对齐到代码现状，关闭 ghost model（session.modelId=default 但 `default_models.chat` 未配）路径 ②只能返 500 的 spec 盲区。

引用：`[P0]agent_interface.md §3`（AgentRun.error）+ `[P0]agent_manager.md §1/§2/§4/§4.1`（makeErrorRun 契约）+ `specs/api/overall/04-agent-session.md §3.2/§9`（400 MODEL_NOT_CONFIGURED）。代码：`app/server/src/agent/agent-interface.ts`（AgentRun.error）+ `agent-run-registry.ts:makeErrorRun` + `agent-manager.ts:activate` 三 catch + `handlers/session-deps.ts:resolveErrorRunResult` + `handlers/session-{run,messages}.ts` error shell。

## 2026-07-09 · v0.0.97（enqueue 队列重构：前端只读 GET /inbox + cancel 转圈 UX）

- **`[P0]agent_inbox_enqueue.md §10` 新增「前端只读 API：GET /session/:id/inbox」**：enqueue view 队列状态唯一真相源 = GET /inbox（seed）+ SSE `message_enqueued`/`enqueued_message_processed`/`enqueued_message_canceled`（增量）（INV-1）。§10.1 为什么需要（inbox 非 sticky，切 session 无 SSE replay）+ §10.2 端点契约（InboxItemView，content 与 SSE 同形 INV-2）+ §10.3 peek 快照语义（O1：peek 返直接引用，handler 浅拷贝 `[...peek]` 防 drain splice）+ §10.4 前端消费链（subscribe-first D8 + GET /inbox seed）+ §10.5 队列真相源总结表（GET/SSE 驱动 vs POST/cancel 不进 reducer vs canceling Set 不进 store）。
- **`§6.3` 端到端 cancel 链路改 x→转圈**：前端 enqueue-view 点 cancel → x 立即转圈（本地 canceling Set，1s 恢复，禁点）+ POST cancel（fire-and-forget）→ 后端 AgentManager.cancel（同步移除 + drain 兜底）→ SSE `enqueued_message_canceled` → 前端 reducer 按 enqueueId 移除（队列移项唯一真相源 = SSE，不乐观移除、不进 store）。
- **AgentManagerImpl.peekInbox 新增（agent-manager.ts:201）**：public 透传 `this.inbox.peek(sessionId)`（inbox 字段 private，外部不能直访）；纯透传不改语义，不在透传层过滤 kind（过滤在 handler）。
- 引用：`[P0]agent_inbox_enqueue.md §10/§6.3` + `specs/api/overall/04-agent-session.md §3.5`。详情 `specs/tech/version_logs/v0.0.97/change_log.md`。

## 2026-07-06 · v0.0.82.forked_cache_fix（forked toolDefinitions 改读 snapshot.tools + runCompact 收 snapshot 对象）

> dev1 直接 bugfix（用户授权，未走 worktree 流程）。两 commit 同 context KB（ab15d9ec / 1d37c93f）。本 KB 受影响文件：agent_loop_forked.md（§4/§5/§11）+ agent_loop_unified.md（§2 伪代码 + §4 deps 表 备注）。

- **`[P0]agent_loop_forked.md §4`** buildForkedDeps 装配伪代码：删 `initialSnapshot = await contextEngine.assemble(config, 'default')`（forked 不内部 assemble，snapshot 由 caller 传入）；显式标注 `const toolDefinitions = opts.snapshot.tools`（[v0.0.82] 从 snapshot 读，不读 opts.toolDefinitions）；缓存保证段加「tools 段前缀一致性」注（toolDefinitions 改读 snapshot.tools 与 main spec.toolDefinitions 同源，旧 forked 收 registry 全集 24 vs main 20 分叉破 cache）。
- **`[P0]agent_loop_forked.md §5`** tool 双维度表：`toolDefinitions` 行改述为「复用 snapshot.tools（与 main spec.toolDefinitions 同源 = assemble 从 config.tools policy 裁剪后派生；[v0.0.82] 改：不读 opts.toolDefinitions registry 全集）」+ 加详细历史说明段（v0.0.82 前 cache_read ~0%、修复后 MAIN 56% / SUMMARY·MEM_EXT 93%）。
- **`[P0]agent_loop_forked.md §11`** 当前用法示例：forkedRun 调用注释改「caller 深拷贝 main state.snapshot；tools 字段必填」+ `toolDefinitions: []` 占位（build-forked-deps 不读此字段，旧传 mainToolDefs 已废弃）。
- **`[P0]agent_loop_unified.md §2`** compact 触发伪代码：删 stale 内联 CompactCtx 构造（`assembleFn: (c) => ce.assemble(...)` + `stateMachine: spec.wireStateMachine`——assembleFn v0.0.82 删、stateMachine v0.0.55 已改 taskLock）+ 删 stale `afterVersion > beforeVersion` re-assemble 块（v0.0.80.t1 纯生产者原则已删），替换为简洁的 `void runTryCompact(spec, state).catch(...)` 调用 + 三条历史变更标注（v0.0.78.bug fire-and-forget / v0.0.80.t1 触发点迁移 + 纯生产者 / v0.0.82 runCompact 收 snapshot）。
- **`[P0]agent_loop_unified.md §4`** deps 装配表后注：加「[v0.0.82] forked toolDefinitions 来源迁移」段（snapshot.tools 替代 opts.toolDefinitions，cache 数据对比）。

**code↔spec 偏离修复**：`agent_loop_unified.md §2` 伪代码 drift（assembleFn / stateMachine / afterVersion re-assemble）是 v0.0.55/v0.0.80.t1 漏更新的 stale spec，本次 v0.0.82 一并清理（grep 0 残留）。

## 2026-07-06 · v0.0.80.t1（forked snapshot 双 clone + trigger meta 透传）

- **`[P0]agent_loop_forked.md §1` forked 不变量段补 2 条**：
  - **snapshot 不可变（双 clone 防篡改）**：caller 传入的 snapshot 在 tryCompact 谓词 true 后由胶水 `structuredClone(ctx.snapshot)` 一次（fork-1 / fork-2 两 sibling 共享同一份不可变 clone）；forkedRun 入口（`agent-manager.ts:354`）再 `structuredClone(opts.snapshot)` 一次。双保险：外层 clone 防两 sibling 互相污染 + caller 误改，内层 clone 防 forkedRun 内部装配链意外回写。
  - **trigger meta 透传（仅写 trace metadata，不入 forked buffer）**：caller 从 `CompactCtx.triggerMessageId` + `CompactCtx.triggerUsage` 取触发点 meta，构造 synthetic `triggerMessage: { id: triggerMessageId, ... }` 传给 `wirePeekTriggerMessages`（取 id 写 trace）；`triggerUsage` 写进 `LoopObservability.startTrace` metadata。反查触发点 msg id + context window 用量（v0.0.80.t1 改进 #1/#2）。synthetic triggerMessage 不入 forked buffer（forked buffer 由 `wireInitState` 显式 ingest reminder + userMessage）。
- **`index.md` ④ 加第 13 条原则**：forked snapshot 双 clone 不变量 + trigger meta 透传。
- 实现层（task）：`agent-manager.ts:354` 入口 deep clone；`build-forked-deps.ts` `wirePeekTriggerMessages` 设置 + LoopObservabilityOpts 加 `triggerUsage`；`agent-loop-observability.ts` startGeneration 加第 5 参数 contextWindowUsage + startTrace metadata 加 triggerUsage；`forked-invoke-observability.ts:60` metadata inputMessageIds 改 `[triggerMessageId]`（去硬编码空）。

详情：`specs/tech/version_logs/v0.0.80.t1/change_log.md`

## 2026-07-06 · v0.0.78.bug（compact fire-and-forget — 主 loop 不阻塞）

- **`runReActLoop` §2 compact 调用改 fire-and-forget**（`[P0]agent_loop_unified.md §2`）：原 `await tryCompact(...)` 改为 `void tryCompact(...).catch(err => log)`。主 loop 不再被 forked LLM 阻塞，run_end 立即发出；compact 异步与主 loop 并发跑（详见 `../context/[P0]context_compact_detail.md §2c.1.1` 并发不变量段）。
- **caller `loop-stage-context.ts:101`** 改 `void runTryCompact(...).catch(...)`，外层 catch 仅观测日志（不让 unhandled rejection 上抛；runTryCompact 内部 catch 已调 markFailed + rethrow）。
- 同步 §2 伪代码 + 注释段（引用 §0 并发不变量 5 条）。

详情：`specs/tech/version_logs/v0.0.78.bug/change_log.md §T1`

## 2026-07-04 · v0.0.58.cron-fix（drain 全量 emit SSE — 离线/在线统一）

- **BUG-002 正确修复**：drain 阶段让所有 source（user/system/agent/approval）的 message 都 emit SSE message_start/blocks/end，与 GET /messages 同源。早前曾把 `buildCronUserMessage` 的 `sender.source` 改 'user' 绕过分流（伪装方案），违反「SSE 发的 = store 存的，sender 语义不能为前端看到而伪装」原则，已回退。
- **实现**：`drainAndPartition`（`agent-loop-stage-pre.ts`）加 `DrainResult.systemMessages: Message[]`（rewritten id），`emitDrainResult` 对 userMessages + systemMessages 都调 `emitUserMessageBlocks`（名字历史，实际支持任意 role）。
- **影响范围**：cron / heartbeat tick / a2a / file-changed 等 system-source 消息现在都 SSE 实时发；前端 `message-flatten.ts` 已按 `m.role==='user'` 分支处理（cron/tick role 都是 'user'）→ 默认展示，与 GET 行为一致。system_reminder 仍由 `DEFAULT_BLOCK_FILTER` 在 flatten 层滤掉（不变）。
- 同步 `agent_loop_eager_drain.md §5.1`（drain 全量 emit SSE 原则：3 条设计原则 + 实现 pointer）。

## 2026-07-03 · v0.0.54.compaction（forked 不变量重申：task = directive 不复述 snapshot）

- **重申 forked 不变量（task message = directive）**：所有 forked mode caller（compact / memory_extract / 任何未来旁路 EP）的 task message 必须是**纯指令**——snapshot 是唯一信息源（system + messages + reminder 已在 forked buffer 中），caller 传入的 userMessage 只下「对上面的对话历史做 X」指令，不复述 snapshot 任何内容、不注入老 summary / 序列化 transcript / 任何对话文本。
- **修复违例**：v0.0.22-0.0.53 compact 实现曾把 `serializeMessages(snap.messages)` 塞 task message（`{{serialized_transcript}}` 占位符），导致对话历史发两遍——v0.0.54 回归不变量。
- 同步 `agent_loop_forked.md §1`（新增 [v0.0.54] forked 不变量段，列 4 条约束 + caller 自检口径「能否在没看 snapshot 的情况下独立写出 task message？」）+ `index.md`（④ 加原则 12 task=directive 不变量）。

详情：`specs/tech/version_logs/v0.0.54.compaction/change_log.md`

## 2026-07-02 · v0.0.49（删 ContextPort + callLLMForXxx，骨架直调 contextEngine + base.callLLM）

- **删 4 中间层文件**：`context-port.ts` / `forked-context-port.ts` / `agent-loop-call-main.ts` / `agent-loop-call-forked.ts`。骨架 `runReActLoop` 直调 `contextEngine.ingest/assemble(scopeId, buffer)` 与 `base.callLLM`，main/forked 差异全部收敛为 RunSpec 字段参数化（`scopeId` + `state.buffer` + `drainMode` + `backgroundPath` + `stopSequences` + `eosStripper` + `compactNoticeEmitter` + LifecyclePort impl + emit）。骨架无 if main/forked 字面分支（UT-S grep 守护）。
- **D7 FinalizePort 并入 LifecyclePort**：三 hook `onUsage`/`onRunEnd`/`onInterrupted`；MainLifecyclePort.onInterrupted=noop（abort api 4 步接管），ForkedLifecyclePort.onInterrupted=noop（buffer 随 GC）。
- **drainMode 三态**：`'eager'`（main，每轮 drain inbox）/ `'none'`（forked，不 drain）/ `'lazy'`（占位 future 不实现）。骨架用 drainMode 分支替代原 ContextPort.prepare 多态。
- **修复 spec↔代码偏差**：v0.0.40-0.0.48 期间 ForkedContextPort 直接 `buffer.push()` 绕过 contextEngine（死代码，导致 forked ext impl 从未被触发）；v0.0.49 删 ForkedContextPort，骨架真调 contextEngine impl 链——buffer_sink/buffer_reader/append_passthrough/reject_should_compact 在真实 forked run 中首次被激活（AT-F1 验证）。
- 同步 `agent_loop_unified.md`（4 port→3 port + 骨架直调 + §2 伪代码重写 + §3 删 ContextPort/FinalizePort 章 + §4 装配表 + §5/§6）+ `agent_loop_forked.md`（前言 + §4 消息驱动 + §7 副作用 + §9 中断）+ `agent_loop_eager_drain.md`（§6 循环结构）+ `agent_loop_base.md`（§2 加注骨架直调）+ `agent_interface.md`（§2 RunSpec 字段 + 删 context/finalize port + modeKey/scopeId）+ `agent_scope_router.md`（调用点 + modeKey）+ `index.md`（概念表 + 导航）。

详情：`specs/tech/version_logs/v0.0.49/change_log.md`

## 2026-07-02 · v0.0.48（forked reminder + RunSpec 白名单 option formal 化）

- **新增 `forked_reminder.md`**：forked agent（compact/summary）补 system reminder，自述 + 实际可运行 tool 列表=toolWhitelist；**注入位置在 cache 前缀之后**（snapshot 之后、userMessage 之前，作为独立 user-role message），不污染 cache；**不复用** `system_reminder_injector`（forked scope 仍禁用它防污染 cache 前缀，本版新增 `injectForkedReminder` 独立注入器）；三态文案对照（compaction 零工具 / 限定白名单 / 不强制 bound）。
- **RunSpec 新字段**：`enableToolWhitelist: boolean`（默认 false）+ `toolWhitelist: string[]`（默认 []）—— forked 与 subagent 在「实际可执行工具」上共用这对 option（formal 化统一）；与 `RunSpec.allowedTools`（resolveTools 产出，exec 消费）共存而非替代。
- `forkedRun` opts 签名改：去 `allowedTools`，加 `enableToolWhitelist` + `toolWhitelist`（resolveTools 算出 allowedTools 写进 RunSpec）。
- `build-deps.ts:buildForkedDeps` 装配 spec 时调 `injectForkedReminder` + resolveTools（forked case）算 allowedTools。
- `bootstrap.ts:486` compact 调用点改传 `enableToolWhitelist: true, toolWhitelist: []`（触发零工具 reminder + 全 toolCall 拒绝 `tool_not_allowed`）。
- `index.md` ④ 加原则 11（forked reminder cache 之后注入）+ ⑤ 导航加 `forked_reminder.md`。

详情：`specs/tech/version_logs/v0.0.48/change_log.md`

## 2026-07-01 · v0.0.40 doc-sync（spec ↔ 已验证代码对齐）

- 修正 `agent_scope_router.md §3.1/§3.2/§5` 路由输出偏差：spec 草案写「非 current → = modeKey（summary→`summary`）」，实现（`agent-scope-router.ts:61-67`）选定「所有非 current → 单一 `forked` scope 常量」（change-plan §8.3 Min 方案）；squad/leader/mate/subagent 不作 scopeId 返回（差异保留 intra-impl）。
- 修正 `agent_manager.md` + `agent_interface.md` 的 `run` 入口签名为 `run(spec: RunSpec, loop: LoopHandle)`（两参——spec + loop 句柄，由 `buildMainDeps`/`buildForkedDeps` 装配产出）；activate/forkedRun 降为 thin wrapper 调 `run(spec, loop)`。草案单参 `run(spec)` 已订正。
- `context_engine.md §3` ingest/assemble 签名补 `buffer?` 显式入参（forked scope 透传 buffer 给 buffer_sink/buffer_reader），标注 forked 跳过 store 硬尾 + 不写 session meta。

## 2026-06-30 · v0.0.40（agent loop 统一重构）

- **协议瘦身（D2）**：`Agent` 只剩 `run(spec, loop) → AgentRun`；删 `enqueue/cancel/activate`（死桩）+ `EagerDrainAgent` 整类 + `agentByMode()` 路由。`RunSpec` = 身份 + 4 注入 port（context/emit/lifecycle/finalize）+ toolDefinitions/allowedTools/maxIter/scopeId/controller/modeKey。
- **新建 `agent_loop_unified.md`**：统一 `runReActLoop(spec)` 骨架 + 4 port 契约 + current/forked 两份 deps 装配表（`buildMainDeps`/`buildForkedDeps`）。compact 判定下沉到 current ContextPort.recordAssistant 的 `tryCompact` 胶水（loop 骨架零感知）。forked 改走 `executeAndEmit`（补 tool_result emit + obs span 既有 gap）。
- **新建 `agent_scope_router.md`**：`AgentScopeRouter.resolve(modeKey, session) → scopeId`；4 维输入拆解（RunKind/Biz/Role/Derivation）；本版本落 Min 方案（current→`default`，非 current→`forked`）。
- `agent_interface.md` 重写：单 run 契约 + RunSpec 定义 + 迁移说明；删 §5 三 mode 支持矩阵。
- `agent_manager.md`：新增 `run(spec, loop)` 唯一 loop 启动入口；activate/forkedRun 标注 thin wrapper（经 buildMainDeps/buildForkedDeps 装配 spec+loop 后调 run）。
- `agent_loop_base.md` §1.2：加注「mode 差异全在 deps port」。
- `agent_loop_eager_drain.md` §6 / `agent_loop_forked.md` §4：while 编排退役标注（迁入 unified），保留 mode 特有不变量作契约源。
- `index.md`：① 是什么 / ② 边界 / ④ 核心设计原则（10 条，新增 modeKey≠scopeId + compact 防递归）/ ⑤ 导航 全面对齐 v0.0.40 形态。

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起 + 8 条跨文件不变量）+ 本 `log.md`。
- 10 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理顶部 `> version:` blockquote + 尾部 `## 版本` 段，版本史迁移到本 log；保留说明当前行为 rationale 的 drift 注（如 `[v0.0.28] tool_call messageId` / `[v0.0.25] llmErrorState`）。
- 修正 spec 内部不一致：`agent_manager.md §4` AgentManagerImpl 伪代码 `enqueue(config,…)`/`activate(config)` 为旧签名残留，订正为 §2/§2.3 的 `enqueue(sessionId,…)`/`activate(sessionId)`（去 config 重构后的现状）。

## 2026-05-20 · v0.0.31

- `agent_inbox_enqueue.md §2.5` 新增「inbox 入口 enrich」：`enrichForInbox(message, store)` 对 `source='agent'` 反查补全 type/name + needReply 必填；inbox 升级为 a2a 上下文中枢。
- `InboxEntry` 两变体均含 `enqueuedAt`（isoDate 信封字段，append/appendCancel 注入）；drain 透传 sender.agent 给 prompt assemble。
- 多处 spec drift 标注「代码已落地」（v0.0.31 判别联合化 + enqueuedAt + drain 透传）。
- `agent_manager.md §2` enqueue/activate/deliverTo 去 config 重构（签名改 sessionId）；`resolveConfigBySid` 方案 A 无 cache；user POST /messages 收敛 deliverTo。

详情：`specs/tech/version_logs/v0.0.31/change_log.md`

## 2026-04-15 · v0.0.28

- `agent_event.md §10` 新增「API + SSE 不漏契约 + Replay 精确语义」：GET(全量持久化) ∪ SSE replay(上次 ingest 后半截) ∪ stream(增量)，按 messageId merge；replay 不是补历史（buffer 由 ingestAndAssemble 的 clearReplay 收紧）。
- `agent_event.md §5.4` tool_call_start/delta/end 补 `messageId` 字段；§9 映射注明 reducer 必须用 evt.messageId 锚定（错过 message_start 时 start 兜底建 assistant message）——修正 subagent 只读页 tool_call UI 静默丢弃 BUG。
- `agent_manager.md` multi_agent deliverTo wrapper 落地（收敛 spawn 首任务 + a2a send_message）。

详情：`specs/tech/version_logs/v0.0.28/change_log.md`

## 2026-04-08 · v0.0.25

- `agent_loop_base.md §9.1` 新增 RunErrorInfo（stopReason="error" 时携带 `errorCategory + displayReason + errorDetail`）；废除 loose string code `LOOP_ERROR`；catch `ClassifiedLlmError` → ABORTED_BY_USER 走 interrupted，其他 category 走 error 填 RunErrorInfo。
- `agent_loop_base.md §2.1` callLLM 接入 LlmCaller.invoke（错误归一化 + adaptive retry + provider 降级 + 分阶段超时 + length 处理收口到 LlmCaller）。
- `LoopStateBase` 加 `llmErrorState`（跨 iteration 继承的 overlay：maxTokensOverlay/precompress/prefillPartial/consecutiveContextLength/lastError/partialResult）；per-run 不落盘。

详情：`specs/tech/version_logs/v0.0.25/`

## 2026-04-05 · v0.0.20

- `agent_loop_base.md §2.1` callLLM wire `max_tokens` 必须非 0（input.maxOutputTokens 透传 CanonicalRequest.params.maxTokens）；禁止漏传——encode 兜底 0 被严格 provider（volcengine ark / 原生 anthropic）截断成 0 输出。

详情：`specs/tech/version_logs/v0.0.20/change_log.md`

## 2026-03-30 · v0.0.19

- `agent_event.md §5.5` tool_result_start/delta/end 补 `messageId`（per-result 独立，start/delta/end 共享）；客户端 reducer 据此建/更新 tool 消息节点（part 以 messageId+toolCallId 为 key）。

## 2026-03-20 · v0.0.16（策略类化大重构）

- 三 mode 升级为策略类（实现 Agent interface）：EagerDrainAgent / LazyDrainAgent / ForkedAgent（无状态，manager 构造时 new 持有）。
- `agent_interface.md` v1.1：Agent interface 去掉 abort 方法（唯一入口归 `AgentManager.abort(sid, runId, modeKey)`）；AgentRun 不暴露 controller；废弃 ActivateResult。
- abort controller 内存模型重写：三条件 → 单条件 `controller.aborted`；loop 不再读持久化 state/currentRunId。
- groupKey 统一为 `session_id:<sid>_amt:<modeKey>`（原裸 `session_id:<sid>`）。
- `agent_loop_base.md` 从原 `[P0]agent_loop.md` 抽机制层独立成 base spec。
- `agent_loop_eager_drain.md` / `agent_loop_forked.md` / `agent_loop_lazy_drain.md` 三个 mode spec 拆分（原 monolith + inbox_mode + forked_agent 合并重组）。

详情：`specs/tech/version_logs/v0.0.16/change_log.md`

## 2026-03-15 · v0.0.15

- `agent_inbox_enqueue.md` cancel 同步移除路径（`inbox.removeMessage` + emit canceled 立即生效）；移除 v0.0.13 的 `POST /messages` body.cancelEnqueueId 原子参数，cancel 统一走专用端点。

## 2026-03-12 · v0.0.14

- `agent_inbox_enqueue.md` 重构：从 `[P0]agent_enqueue_cancel.md`（cancel 专稿）→ 统一 inbox 机制 + enqueue + cancel 文档。
- `agent_loop_eager_drain.md` accumulateUsage 激活（store.accumulateUsage(sid, "current", usage)）。

## 2026-03-10 · v0.0.12（cancel + 中断门控）

- `agent_event.md §4.3` enqueue 级新增第三事件 `enqueued_message_canceled`（drain 同批 message+cancel 时 emit）；三事件配对（建 → processed | canceled）。
- `agent_interrupt.md` 新建：核心分工（abort api 收尾唯一执行者 / loop 只退出）+ loop 中断条件 + 副作用门控 + abort 4 步 + half-data + clear replay B 方案。
- `agent_event.md` StopReason 加 `interrupted`；producer 声明补 agent_manager（abort api emit run_stop）。

详情：`specs/tech/version_logs/v0.0.12/change_log.md`

## 2026-02-XX · v0.0.8-v0.0.10（初版 + eager 落地）

- v0.0.8 eager-drain 落地；`agent_event.md` 初版（AgentEvent 联合 + StopReason 6 枚举 + 事件→Message 重建映射）。
- v0.0.10 单 while 重构；event_bus `channel→group`；hub 级 (topic,group) 去重 + cancel 改 `wakePendingSubscribers`。

详情：`specs/tech/version_logs/v0.0.8/change_log.md` + `v0.0.10/change_log.md`
