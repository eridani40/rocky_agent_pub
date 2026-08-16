/**
 * loop-stage-context — contextEngine 交互 stage
 * 参考: specs/tech/agent/context/[P0]context_engine.md §3.6（scopeId + buffer 透传）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md §6
 *
 * 定位：骨架与 contextEngine 的交互胶水。drain/ingest/assemble/tryCompact 内联到本 helper。
 * main/旁路 run 差异由 RunSpec 字段（drainMode/scopeId/wireStore）参数化，无 if kind 字面分支。
 *
 * main（drainMode='eager'）：
 *   - prepare：drain inbox + ingest(newMessages) + clearReplay + assemble + 游标(ingestUpTo) + 准入判定
 *   - ingestAssistant：ingest([assistant]) + clearReplay + assemble + 游标(llmUpTo) + emit message_end + tryCompact
 *   - ingestToolResults：ingest([toolMsg]) + clearReplay + assemble + 游标(ingestUpTo)
 *   - hasPendingInput：peek inbox
 * 旁路 run（drainMode='none'，runKind=summary/consolidate）：
 *   - prepare：assemble(scopeId, prevSnapshot=state.parentSnapshot) 刷新 snapshot；无 drain/游标
 *   - ingestAssistant：ingest([assistant], scopeId)（store_sink 写 in_memory store）+ emit message_end + tryCompact（reject 自动跳过）
 *   - ingestToolResults：ingest([toolMsg], scopeId)（store_sink 写 in_memory store）
 *   - hasPendingInput：false（恒不续跑）
 */
import { ulid } from '../config/ulid';
import type { Message, MessageInput, ToolResultBlock } from '../message/types';
import type { PendingToolCall } from '../tools/types';
import { firstText } from './assemble-pipeline';
import { drainAndPartition, emitDrainResult } from './agent-loop-stage-pre';
import { handleToolReply } from './tool-reply-handler';
import { groupKeyForRunKind } from './agent-interface';
import { emitMessageEnd } from './agent-loop-emitters';
import { tryCompact } from './try-compact';
import type { CompactCtx } from './compact-types';
import type { ContextEngine } from './context-engine';
import type { ContextSnapshot, SessionConfig } from './context-types';
import type { LoopState, RunSpec } from './loop-ports';

/** prepare 阶段结果：'ok'=准入可继续 LLM；'no_new'=无新消息（main 游标未推进 / 旁路 run 不应触发） */
export type PrepareResult = 'ok' | 'no_new';

/**
 * ① drain + assemble + 准入判定（design §2 line 73-91）。
 *
 * main（drainMode='eager'）：drain inbox → ingest → clearReplay → assemble → setSystem
 *   （assemble 内部 updateUsage 写 cw + 推全量 view）；游标 ingestUpTo 推进；准入判定 ingestUpTo===llmUpTo → 'no_new'。
 * 旁路（drainMode='none'）：跳过 drain；assemble 刷新 snapshot；恒首轮准入（游标全 null 不触发 no_new gate）。
 *
 * 注：旁路 scope（summary/consolidate）assemble 不读 store summary、不写 session meta——
 *   由 in_memory_session_store 承载（getSummary 恒 null → 无 summary 分支；meta 写 no-op），
 *   非 kind 分支判断。
 */
export async function prepareStage(spec: RunSpec, state: LoopState): Promise<PrepareResult> {
  const { config, scopeId, wireContextEngine: ce } = spec;
  const sid = config.sessionId;

  // —— drain（main only；旁路 drainMode='none' 跳过）——
  if (spec.drainMode === 'eager') {
    const drained = drainAndPartition(spec.wireInbox!, sid);
    // replyResolvedAny 跨 drain-block 和 gate 两处用，外层声明。
    //   true = 本轮 tool_reply resolve（占位已编辑、pending 清空）→ 须 refresh snapshot + gate 放行。
    let replyResolvedAny = false;
    if (drained.newMessages.length > 0 || drained.canceledEnqueueIds.length > 0 || drained.toolReplyMessages.length > 0) {
      emitDrainResult(spec.wireEmitCtx!, drained);
      // 待回 a2a 请求跨轮累积（只增不判；履约判定归 run 收尾 replySettle）
      if (drained.agentReplyRequests.length > 0) {
        state.agentReplyRequests = [...(state.agentReplyRequests ?? []), ...drained.agentReplyRequests];
      }

      // 优先处理 tool_reply（在 user query ingest 之前）：
      //   handleToolReply 编辑占位 block + resolve 队列；
      //   仍 pending → 记 state.hitlAfterReplyPending=true（caller emit + break）。
      //   tool_reply resolve（无 pending 残留 + 无 user query 同批）时，
      //   占位 block 已编辑但 cursor 未推进（无新 msg id）→ 须主动 refresh snapshot 让 LLM 看到
      //   编辑后的 tool_result 内容 + gate 放行续跑 LLM（否则 ingestUpTo===llmUpTo 误判 no_new 提前退出）。
      if (drained.toolReplyMessages.length > 0) {
        let stillPending = false;
        for (const tr of drained.toolReplyMessages) {
          // 传入 emitCtx → handleToolReply 在持久化后补发 tool_result SSE（HITL 后前端即时更新）
          const r = await handleToolReply(spec, tr, spec.wireEmitCtx ?? undefined);
          if (r.stillHasPending) stillPending = true;
          if (r.resolved) replyResolvedAny = true;
        }
        state.hitlAfterReplyPending = stillPending;
      }

      // user query 与 pending 共存检测：有 pendingToolCalls + 当前 drain 是 user query（非 tool_reply）
      //   → 占位原样不清（保持 pending，INV-1 pair 合法）+ 清空 pendingToolCalls + 续 LLM。
      //   注：tool_reply 路径已走上面分支；此处仅 user query 与 pending 共存时清空。
      if (drained.userMessages.length > 0 && !state.hitlAfterReplyPending) {
        const head = await spec.wireStore!.peekPendingToolCall(sid);
        if (head) {
          await spec.wireStore!.setPendingToolCalls(sid, []);
          state.hitlClearedPending = true;
        }
      }

      if (drained.newMessages.length > 0) {
        // ingest + clearReplay + assemble + setSystem + 游标推进（复用 ingestAndAssemble helper）
        // 注：handleToolReply 已先编辑 store，base_builder 永远 rebuild 每轮从 transcript
        //   读最新内容，编辑后的 tool_result 自动反映到 snapshot（无须额外 refresh 机制）。
        //   usage 推送由 assemble 内部 updateUsage 携带（写 cw + 推全量 view），caller 不单独推。
        await ingestMainAndAssemble(spec, state, drained.newMessages, 'ingestUpTo');
      } else if (replyResolvedAny && !state.hitlAfterReplyPending) {
        // 仅 tool_reply drain（无 user query 同批）→ 重 assemble 刷新 snapshot。
        //   占位 block 已被 handleToolReply 编辑（store upsert），但 cursor 未推进、snapshot 未刷；
        //   不 refresh 则 LLM 看旧 pending 占位内容、gate 也因 cursor 相同误判 'no_new' 提前退出。
        //   rebuild 路径天然采纳编辑内容（每轮从 transcript 拿最新，无 prevSnapshot 依赖）。
        await refreshSnapshotOnly(spec, state);
      }
    }
    // 准入判定：ingestUpTo === llmUpTo → 无新消息喂 LLM（与原 stage-llm.ts:67 对齐）
    //   例外：tool_reply resolve 已 refresh snapshot（cursor 未推但有新 tool_result 内容）→ 放行续 LLM
    if (state.ingestUpTo === state.llmUpTo && !replyResolvedAny) return 'no_new';
    // re-suspend 路径优先放行：仍有 pending（hitlAfterReplyPending=true）时不需 snapshot——
    //   run-react-loop.ts ① 段的 hitlAfterReplyPending 分支会 break tool_pending→suspended（不调 LLM）。
    //   本行必须在下面 !state.snapshot 门禁之前：re-suspend 时 refreshSnapshotOnly 条件漏此分支（仍 pending 不刷
    //   snapshot）→ state.snapshot 保持 null → 误返 'no_new' → run-react-loop break no_new_messages →
    //   onRunEnd markIdle（应 suspended），队首后续 pending 被遗弃。
    if (state.hitlAfterReplyPending) return 'ok';
    if (!state.snapshot) return 'no_new';
    return 'ok';
  }

  // —— 旁路 run（drainMode='none'）：统一 assemble 刷新 snapshot ——
  // prevSnapshot 用固定 parentSnapshot（不能用漂移的 state.snapshot）——否则多轮
  // [...prev.messages, ...transcript] 会重复 reminder/userMessage（transcript 是 in_memory 累积全量
  // + 漂移 prevSnapshot 又带回上轮增量）。state.snapshot 仍更新为 assemble 结果（callLLM + cleanSnapshot 需要）。
  // opts.runId：transcript_reader 按 runId 读旁路 buffer 桶（per-run 隔离）
  state.snapshot = await ce.assemble(config, scopeId, state.parentSnapshot ?? null, { runId: spec.runId });
  if (!state.snapshot) return 'no_new';
  return 'ok';
}

/**
 * 写回 assistant + tryCompact（design §2 line 120-133）。
 *
 * main：ingest([assistant]) + clearReplay + assemble + 游标(llmUpTo)
 *   （assemble 内部 updateUsage 写 cw + 推全量 view）
 *   + emit message_end + tryCompact（default scope threshold/summary impl 触发）
 * 旁路：ingest([assistant], scopeId)（store_sink 写 in_memory store）+ emit message_end
 *   + tryCompact（旁路 scope reject_should_compact 恒 false → 自动跳过，无 if 分支）
 */
export async function ingestAssistant(spec: RunSpec, state: LoopState, assistant: Message): Promise<void> {
  const { config, scopeId, wireContextEngine: ce } = spec;

  if (spec.drainMode === 'eager') {
    // main：ingest + clearReplay + assemble + setSystem + 游标(llmUpTo) 推进
    //   （usage 推送由 assemble 内部 updateUsage 携带，caller 不单独推）
    await ingestMainAndAssemble(spec, state, [assistant], 'llmUpTo');
  } else {
    // 旁路 ingest 写入 EP-selected in_memory_session_store（store_sink 链尾落库）
    // opts.runId：store_sink 按 runId 分桶写（per-run 隔离）
    await ce.ingest(config, [assistant], scopeId, false, { runId: spec.runId });
  }

  // ② → ③ 间 emit message_end（ingest 后、compact 判定前）
  emitMessageEnd(spec.wireEmitCtx!, assistant.id);

  // compact 触发点在 run-react-loop.ts（prepareStage 后、callLLM 前），ingestAssistant 不触发 tryCompact。
}

/**
 * 写回 tool 结果（design §2 line 147）。
 *
 * main：ingest([toolMsg]) + clearReplay + assemble + 游标(ingestUpTo)
 *   （assemble 内部 updateUsage 写 cw + 推全量 view）
 * 旁路：ingest([toolMsg], scopeId)（store_sink 写 in_memory store）
 *
 * pendingBackfill 可选：caller（runReActLoop ③ 段）传入悬挂队列后，
 * 本方法在构造 toolMessage 后回填每个 pending 的 resultMessageId（=toolMessage.id）
 * + resultBlockIndex（=results 数组中匹配 toolCallId 的下标）。
 * 引擎构造 PendingToolCall 时这两个字段留空（引擎不知 message id），由本处补完。
 */
export async function ingestToolResults(
  spec: RunSpec,
  state: LoopState,
  results: ToolResultBlock[],
  pendingBackfill?: PendingToolCall[],
): Promise<void> {
  const { config, scopeId, runId, wireContextEngine: ce } = spec;
  const sid = config.sessionId;
  const toolMessage: MessageInput = {
    id: ulid(), sessionId: sid, role: 'tool', content: results, runId,
  };
  // 回填 pending 的 resultMessageId/resultBlockIndex（engine 留空字段）
  // 在 ingest 之前完成——caller 拿到的 pending 已含完整定位字段，落盘即可
  if (pendingBackfill && pendingBackfill.length > 0) {
    for (const p of pendingBackfill) {
      p.resultMessageId = toolMessage.id;
      p.resultBlockIndex = results.findIndex((r) => r.toolCallId === p.toolCallId);
    }
  }

  if (spec.drainMode === 'eager') {
    await ingestMainAndAssemble(spec, state, [toolMessage], 'ingestUpTo');
  } else {
    // 旁路 ingest 写入 EP-selected in_memory_session_store
    // opts.runId：store_sink 按 runId 分桶写（per-run 隔离）
    await ce.ingest(config, [toolMessage], scopeId, false, { runId });
  }
}

/**
 * no_tool_call 后续是否续跑。
 * main：peek inbox（还有 message → continue 续跑消费）。
 * 旁路：恒 false（单次/多轮由 maxIter 控制）。
 */
export async function hasPendingInput(spec: RunSpec): Promise<boolean> {
  if (spec.drainMode !== 'eager') return false;
  const remaining = spec.wireInbox!.peek(spec.config.sessionId).filter((e) => e.kind === 'message');
  return remaining.length > 0;
}

// ============================================================
// 私有 helpers
// ============================================================

/**
 * main 专属 ingest+assemble+clearReplay+setSystem+游标推进：
 * ingest → clearReplay(groupKey) → assemble → obs.setSystem → state[cursor] 推进。
 * 不变量：调用方保证 cursor 推进后 llmUpTo ≤ ingestUpTo。
 */
async function ingestMainAndAssemble(
  spec: RunSpec,
  state: LoopState,
  newMessages: MessageInput[],
  cursor: 'ingestUpTo' | 'llmUpTo',
): Promise<void> {
  const { config, runKind, scopeId, wireContextEngine: ce, observability: obs, wireEmitCtx: emitCtx } = spec;
  // ingest（main: scopeId='default'，context-engine 注入 EP-selected store → store_sink 写库）
  // [v0.0.361 §1.4 T3] runState 透传：injector 读 useFullReminder decides full/incremental
  //   （undefined looks true = run starts naturally full; injector sets false after consuming）
  await ce.ingest(config, newMessages, scopeId, false, undefined, state);
  // clearReplay（让新消息的 replay 事件清掉，避免重复）
  emitCtx!.bus.clearReplay(groupKeyForRunKind(config.sessionId, runKind));
  // assemble 刷新 snapshot（base_builder 永远 rebuild 每轮从 transcript 取最新）
  state.snapshot = await ce.assemble(config, scopeId, state.snapshot ?? null);
  // obs.setSystem 推送实际 system
  obs.setSystem(firstText(state.snapshot.system));
  // 游标推进
  state[cursor] = newMessages[newMessages.length - 1]!.id;
}

/**
 * tool_reply resolve 后重 assemble 刷新 snapshot（不 ingest、不推 cursor）。
 *
 * 场景：drain 仅取出 tool_reply（无 user query 同批）→ handleToolReply 已编辑占位 block
 *   （store.appendMessages 同 id upsert）+ resolve pending。占位内容已变（pending→success），
 *   但无新 message id → cursor 无法推进、ingestMainAndAssemble 不触发。
 *   本 helper 跳过 ingest/cursor，仅做 clearReplay + assemble + setSystem，让 snapshot 反映
 *   编辑后的 tool_result（base_builder 永远 rebuild，每轮从 transcript 拿最新内容天然采纳编辑）。
 *   caller 据此续跑 LLM（gate 因 replyResolvedAny 放行，不再误判 'no_new' 提前退出）。
 */
async function refreshSnapshotOnly(spec: RunSpec, state: LoopState): Promise<void> {
  const { config, runKind, scopeId, wireContextEngine: ce, observability: obs, wireEmitCtx: emitCtx } = spec;
  emitCtx!.bus.clearReplay(groupKeyForRunKind(config.sessionId, runKind));
  state.snapshot = await ce.assemble(config, scopeId, state.snapshot ?? null);
  obs.setSystem(firstText(state.snapshot.system));
}

/**
 * tryCompact 胶水（骨架统一调）。
 *
 * main：default scope threshold_should_compact + summary_do_compact 选中 → 谓词 true 时
 *   action.run → sideRun(summary) → setSummary。
 * 旁路：旁路 scope reject_should_compact 恒 false → tryCompact return（结构上不可能递归）。
 *
 * **summary = 纯生产者**：
 *   compact/旁路 run 只产 summary + usage 累积 write；
 *   **不碰消费侧**——不 re-assemble 主 loop snapshot、不 setSystem、不推 usage。
 *   消费侧（snapshot 刷新 + usage 推送）由正规 assemble 管线承担（prepareStage/ingestAssistant/
 *   ingestToolResults 每次 assemble 内部 updateUsage 写 cw + 读 getUsageView 全量 emit）。
 *   compact 完成后不主动推，等下一轮 assemble；compact 零 transcript 副作用（无留痕）。
 *
 * **caller fire-and-forget**（`void runTryCompact(...).catch(...)`）：主 loop 不 await 本函数。
 *   内部 catch 已调 markFailed（context-compact-runner.ts）；外层 .catch 仅 log 防 unhandled rejection。
 *
 * @param spec RunSpec（main / 旁路 run 装配）
 * @param state LoopState（读 snapshot；不动 snapshot）
 */
export async function runTryCompact(spec: RunSpec, state: LoopState): Promise<void> {
  const { config, scopeId, wireContextEngine: ce } = spec;
  if (!state.snapshot) return;
  const compactCtx: CompactCtx = {
    config,
    snapshot: state.snapshot,
    store: spec.wireStore,
    scopeId,
    // 传 taskLock（per-session × per-task 内存锁，subsumes summaryTask CAS）
    taskLock: spec.wireTaskLock,
    sideRunner: ce.getSideRunner() ?? undefined,
    // consolidate 旁路 run 入口 + 工具声明（post-compact handler 用）
    consolidateRunner: ce.getConsolidateRunner() ?? undefined,
    toolDefinitions: spec.toolDefinitions,
    // trigger meta（用于旁路 run trace metadata 反查触发点）
    //   messages 空数组兜底 undefined（触发点取「主 loop 当前轮触发 compact 的末尾 msg id」）
    triggerMessageId: state.snapshot.messages.length > 0
      ? state.snapshot.messages[state.snapshot.messages.length - 1]!.id
      : undefined,
    triggerUsage: state.snapshot.contextWindowUsage,
  };
  await tryCompact(spec.pluginManager ?? null, compactCtx);
}
