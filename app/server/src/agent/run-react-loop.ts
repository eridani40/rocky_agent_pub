/**
 * runReActLoop — 统一 ReAct 循环骨架（v0.0.49 重构，unified §2 + design §2）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md §2（骨架伪代码）
 *       specs/tech/version_logs/v0.0.49/design.md §2（line 54-162，1:1 实施）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §5/§6（中断/退出原语）
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 C（HITL ③ 段悬挂分流）
 *
 * v0.0.49 改动（design §0/§1 D1/D2/D6/D7）：
 *   - 删 spec.context.prepare/recordAssistant/recordToolResults（ContextPort 退役）
 *   - 删 spec.wireCallLLM（callLLMForXxx 退役）→ 直调 base.callLLM（经 loop-stage-llm helper）
 *   - contextEngine.ingest/assemble 内联（经 loop-stage-context helper，scopeId + buffer 参数化）
 *   - tryCompact 骨架统一调（forked scope reject 自动跳过，无 if main/forked 分支）
 *   - lifecycle.onInterrupted 调用保留（D7 并入 LifecyclePort，三 hook）
 *
 * [v0.0.101] HITL ③ 段悬挂分流（模块 C）：
 *   - executeToolsForSpec 返 {results, pending}（pending = 悬挂队列）
 *   - pending.length>0：ingestToolResults 透传 pending 让其回填 resultMessageId/resultBlockIndex →
 *     setPendingToolCalls 落盘 → emit require_human_input(队首) + state.stopReason='tool_pending' +
 *     state.done=true break（run 终态，onRunEnd 调 markSuspended）
 *   - 多 pending 一次性收集（不逐个退出）；emit 仅携队首（INV-4 peek 串行展示）
 *
 * 骨架无 if main/forked 字面分支——全部通过 RunSpec 字段（scopeId/drainMode/buffer/
 * backgroundPath/lifecycle hook）参数化（design §3 4 维差异表）。
 *
 * 复用 base 原语（agent-loop-base.ts）：callLLM / extractToolCalls / executeAndEmit /
 * checkDoomLoop / checkMaxIter / controller.aborted（中断单条件）。
 */
import type { ToolCallBlock, Usage } from '../message/types';
import type { PendingToolCall } from '../tools/types';
import { extractToolCalls } from './agent-loop-helpers';
import { checkDoomLoop as baseCheckDoomLoop, checkMaxIter as baseCheckMaxIter } from './agent-loop-base';
import { executeAndEmit } from './agent-loop-stage-tool';
import type { ToolExecutionEngine } from '../tools/engine';
import { buildRunErrorFromThrowable } from '../llm/caller/display_reason';
import { emitRunStart, emitRunEnd, emitError, emitRequireHumanInput, emitToolExecutionStart, emitToolExecutionEnd } from './agent-loop-emitters';
import type { LoopState, RunSpec, RunResult } from './loop-ports';
import { initState, ensureRunCreated } from './agent-loop-lifecycle';
import { callLLMForSpec } from './loop-stage-llm';
import { prepareStage, ingestAssistant, ingestToolResults, hasPendingInput, runTryCompact } from './loop-stage-context';
// sumUsage 聚合每轮 callLLM usage 进 RunResult.usage（供 forked caller 总量累计）
import { sumUsage } from './session-usage-helper';

/**
 * 统一 ReAct 循环骨架（unified §2 + design §2 line 54-162，1:1 实施）。
 *
 * @param spec RunSpec（lifecycle + 身份 + 工具 + wire extras + 4 维差异字段）
 * @returns RunResult（answer + usage + stopReason + rounds）
 *
 * 编排（design §2 伪代码 1:1）：
 *   1. state 初始化（main=initState(store) / forked=wireInitState(buffer)）+ ensureRunCreated(main) +
 *      emit run_start + obs.startTrace
 *   2. while(!done):
 *      - 中断检查 → break(interrupted)
 *      - obs.startStepSpan
 *      - ① prepare（drain+ingest+assemble+准入 / forked assemble）→ no_new break
 *      - 中断检查 → break(interrupted)
 *      - ② callLLMForSpec（直调 base.callLLM，langfuse/obs 内联）→ assistant + usage
 *      - ingestAssistant（写回 + tryCompact）+ onUsage(usage)
 *      - 中断检查 → break(interrupted)
 *      - ③ extractToolCalls：空 → hasPendingInput?continue:break(no_tool_call)；maxIter→break
 *      - executeAndEmit（含 allowedTools 门控 + emit tool_result + obs span）
 *      - ingestToolResults（写回）
 *      - checkDoomLoop → break(doom_loop)；step++；checkMaxIter → break(max_iterations)（轮次边界，v0.0.130.hang）
 *      - obs.endStepSpan
 *   3. catch：abort→interrupted；其他→error（emitError + 填 state.error）
 *   4. 退出分流：interrupted→lifecycle.onInterrupted + return；否则 onRunEnd + emit run_end + return
 */
export async function runReActLoop(spec: RunSpec): Promise<RunResult> {
  // —— state 初始化（design §2 line 57：main=initState(store) / forked=wireInitState(buffer)）——
  const state = spec.wireInitState ? await spec.wireInitState() : await initStateForLoop(spec);
  state.recentToolSigs = [];
  spec.observability.reset();

  // 累加器：每轮 callLLMForSpec usage 经 sumUsage 聚合，三条 return 带出给 forked caller。
  //   main loop 经 attachRunPromise 硬编码忽略 RunResult.usage（零双计），只有 forked 真实传播。
  //   pre-loop abort 时仍为 {}（等价现状，无回归）。spec session_usage §6.1 + §10。
  let accumulatedUsage: Usage = {} as Usage;

  // run 记录 upsert（main 专属；forked wireStore 未设跳过——不持久化 Run 记录）
  if (spec.wireStore) {
    await ensureRunCreated(spec.wireStore, spec.config, spec.runId);
  }
  if (spec.controller.aborted) {
    spec.observability.endTrace('interrupted');
    return { answer: '', usage: accumulatedUsage, stopReason: 'interrupted', rounds: 0 };
  }

  // drain 前 peek → run_start inputMessageIds（main 专属；forked wirePeekTriggerMessages 未设 → []）
  const peekedMessages = spec.wirePeekTriggerMessages ? spec.wirePeekTriggerMessages() : [];
  emitRunStart(spec.wireEmitCtx!, peekedMessages.map((m) => m.id));
  spec.observability.startTrace(peekedMessages);

  // [dev-logs] agent loop 进入信号（冒烟枪：loop 起没起、runKind=main/summary/consolidate、触发输入 id 列表）
  // spec.config.logWriter 类型为 unknown（SessionConfig 弱类型），此处 cast 为 LogWriter | undefined。
  // 只记 id/类型，绝不记消息内容。
  const agentLog = spec.config.logWriter as
    | import('../dev-logs/log-writer').LogWriter
    | undefined;
  agentLog?.write('agent', {
    event: 'loop_enter',
    sessionId: spec.config.sessionId,
    runId: spec.runId,
    mode: spec.runKind,
    triggerInputIds: peekedMessages.map((m) => m.id),
  });

  let interrupted = false;
  try {
    while (!state.done) {
      // —— 中断检查（iteration 边界）——
      if (spec.controller.aborted) { interrupted = true; break; }
      spec.observability.startStepSpan(state);
      // [dev-logs] loop 每轮迭代 breadcrumb（诊断 stuck-running：卡住的 loop 仍记 loop_step 但永不 loop_exit）
      agentLog?.write('agent', { event: 'loop_step', sessionId: spec.config.sessionId, runId: spec.runId, step: state.step });

      // —— ① prepare（drain+ingest+assemble+准入 / forked assemble；design §2 line 73-91）——
      const prepared = await prepareStage(spec, state);
      if (prepared === 'no_new') {
        state.done = true;
        state.stopReason = 'no_new_messages';
        spec.observability.endStepSpan(state, false);
        break;
      }
      if (spec.controller.aborted) {
        interrupted = true;
        spec.observability.endStepSpan(state, false);
        break;
      }

      // —— [v0.0.101 T4] HITL 回填后续（change_plan 模块 E run-react-loop ① 段）——
      //   tool_reply 处理后仍有 pending（队列非空）→ emit require_human_input(下一个队首) +
      //     state.done=true + stopReason='tool_pending' + break（续 suspended，onRunEnd 调 markSuspended）
      //   注：c 路径（hitlClearedPending=true）不 break，正常续 LLM（占位原样发，LLM 自判）
      if (state.hitlAfterReplyPending && spec.wireStore) {
        const nextHead = await spec.wireStore.peekPendingToolCall(spec.config.sessionId);
        if (nextHead && spec.wireEmitCtx) {
          emitRequireHumanInput(spec.wireEmitCtx, nextHead);
        }
        state.done = true;
        state.stopReason = 'tool_pending';
        spec.observability.endStepSpan(state, false);
        break;
      }

      // —— ★ [v0.0.80.t1] compact 触发点（prepareStage 后、callLLM 前，fire-and-forget）——
      //   旧位置 ingestAssistant 内已删（迁移到此）。谓词检查 + sibling 双发由 tryCompact 内部承担。
      //   spec.drainMode='none'（forked）时 runTryCompact 内部走 forked scope reject 谓词恒 false
      //   → 自动跳过（防递归不变量）。fire-and-forget 不 await，主 loop 立即进 callLLM。
      //   参考: specs/tech/version_logs/v0.0.80.t1/change_plan.md §1.1 + §1.2 不变量
      void runTryCompact(spec, state).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[compact async] ${msg}`);
      });

      // —— ② callLLM（直调 base.callLLM；design §2 line 95-118，langfuse/obs 内联 loop-stage-llm）——
      const { assistant, usage } = await callLLMForSpec(spec, state);

      // 聚合本轮 usage 进 RunResult.usage（forked caller 按结束总量一次性累计）
      accumulatedUsage = sumUsage(accumulatedUsage, usage);

      // —— 写回 assistant（ingest + emit message_end + tryCompact）+ onUsage ——
      await ingestAssistant(spec, state, assistant);
      await spec.lifecycle.onUsage(usage);

      if (spec.controller.aborted) {
        interrupted = true;
        spec.observability.endStepSpan(state, false);
        break;
      }

      // —— ③ tools（executeAndEmit：emit + obs span + allowedTools 门控）——
      const toolCalls: ToolCallBlock[] = extractToolCalls(state.lastAssistantContent ?? assistant.content);
      if (toolCalls.length === 0) {
        // 无 tool call：main 看 inbox 是否还有未消费消息（BUG-002 peek-continue）；forked 恒 false
        if (await hasPendingInput(spec)) {
          spec.observability.endStepSpan(state, false);
          continue;
        }
        state.done = true;
        state.stopReason = 'no_tool_call';
        spec.observability.endStepSpan(state, false);
        break;
      }
      // 执行 tools（executeAndEmit 内 obs.startToolSpan + emit tool_result + endToolSpan）
      // [v0.0.101] executeToolsForSpec 返 {results, pending}：pending 是 HITL 悬挂队列
      // [dev-logs] ③ tool 执行前 breadcrumb（点名卡住的 tool 名/id）
      agentLog?.write('agent', { event: 'loop_tools_begin', sessionId: spec.config.sessionId, runId: spec.runId, step: state.step, toolNames: toolCalls.map((c) => c.name), toolCallIds: toolCalls.map((c) => c.id) });
      // [v0.0.130.hang P6-backend] SSE 阶段事件：③ 执行前（与上面 breadcrumb 同址，forked 无 emitCtx 则跳过）
      if (spec.wireEmitCtx) emitToolExecutionStart(spec.wireEmitCtx, toolCalls.map((c) => c.name), toolCalls.map((c) => c.id));
      const { results, pending } = await executeToolsForSpec(spec, toolCalls);
      // ingest 透传 pending 让其回填 resultMessageId/resultBlockIndex（engine 不知 message id，
      // 由 ingestToolResults 在构造 toolMessage 后补完；落盘前 pending 已含完整定位字段）
      await ingestToolResults(spec, state, results, pending);
      // [dev-logs] ③ tool 执行后 breadcrumb（resultCount/pendingCount 定位卡在 tool 还是 HITL 悬挂）
      agentLog?.write('agent', { event: 'loop_tools_end', sessionId: spec.config.sessionId, runId: spec.runId, step: state.step, resultCount: results.length, pendingCount: pending.length });
      // [v0.0.130.hang P6-backend] SSE 阶段事件：③ 执行后（ingest 之后，与上面 breadcrumb 同址）
      if (spec.wireEmitCtx) emitToolExecutionEnd(spec.wireEmitCtx, results.length, pending.length);

      // —— [v0.0.101] HITL ③ 段悬挂分流（change_plan 模块 C）——
      // pending.length>0：有悬挂 tool call → 落盘 + emit require_human_input(队首) +
      //   stopReason='tool_pending' + done=true break（run 终态，onRunEnd 调 markSuspended）。
      //   多 pending 一次性收集（不逐个退出，INV-1 占位 block 全部配对）；
      //   emit 仅携队首（INV-4 peek 串行展示，前端一次只渲染一张卡）。
      if (pending.length > 0 && spec.wireStore) {
        await spec.wireStore.setPendingToolCalls(spec.config.sessionId, pending);
        const head = pending[0]!;
        if (spec.wireEmitCtx) emitRequireHumanInput(spec.wireEmitCtx, head);
        state.done = true;
        state.stopReason = 'tool_pending';
        spec.observability.endStepSpan(state, false);
        break;
      }

      // —— ④ Exit Check（base §6）——
      if (!state.recentToolSigs) state.recentToolSigs = [];
      if (baseCheckDoomLoop(toolCalls, state.recentToolSigs)) {
        state.done = true;
        state.stopReason = 'doom_loop';
        spec.observability.endStepSpan(state, true);
        break;
      }
      state.step++;
      // [v0.0.130.hang] max_iterations 判定在轮次边界（step++ 之后）：一轮 = LLM 调用→工具执行→result 落盘，
      // 只有完整轮结束后才判 should-continue——凡已落盘的 tool_use 必有配对 tool_result。
      // （旧位置在 ② assistant 落盘/广播后、③ 执行前 break，产生 dangling tool_use 半轮，
      //   live 案例 01KX5WDBT2；且第 maxIter+1 次 LLM 调用为注定作废的浪费，现不再发生。）
      if (baseCheckMaxIter(state.step, spec.maxIter)) {
        state.done = true;
        state.stopReason = 'max_iterations';
        spec.observability.endStepSpan(state, true);
        break;
      }
      spec.observability.endStepSpan(state, true);
    }
  } catch (e) {
    // 被中断（AbortError）→ 按中断处理；否则错误外显（对齐 agent-loop.ts:198-211）
    if (spec.controller.aborted) {
      interrupted = true;
      spec.observability.endStepSpan(state, false);
    } else {
      const { category, runError } = buildRunErrorFromThrowable(e);
      state.done = true;
      state.stopReason = 'error';
      state.error = runError;
      emitError(spec.wireEmitCtx!, e instanceof Error ? e.message : String(e), category, runError);
      // [dev-logs] agent run 失败（含 LLM SERVER_ERROR 等）→ logs/error.log
      // （受 logs.enableErrorLog 开关控制，false 零开销早 return；复用顶部 agentLog 变量）
      agentLog?.write('error', {
        layer: 'run',
        sessionId: spec.config.sessionId,
        runId: spec.runId,
        category,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        displayReason: runError?.displayReason,
      });
      spec.observability.endStepSpan(state, false);
      // [v0.0.68 R7] run 失败时把 trace level 标 ERROR（在 endTrace 前），
      // langfuse 顶层显示 ERROR 而非 UNSET（spec change_plan.md R7 run.error 行）。
      const failReason = `${category}: ${runError?.displayReason ?? (e instanceof Error ? e.message : String(e))}`;
      spec.observability.markTraceError(failReason);
    }
  }

  // —— 退出分流（unified §2 末 + design §2 line 156-161）——
  if (interrupted) {
    // main: noop（abort api 4 步接管）；forked: noop（buffer 随 RunState GC）
    // [dev-logs] agent loop 退出（interrupted 分支；冒烟枪：中止时 round/stopReason）
    agentLog?.write('agent', {
      event: 'loop_exit',
      sessionId: spec.config.sessionId,
      runId: spec.runId,
      stopReason: 'interrupted',
      rounds: state.step,
      interrupted: true,
    });
    await spec.lifecycle.onInterrupted(state);
    spec.observability.endTrace('interrupted');
    return { answer: '', usage: accumulatedUsage, stopReason: 'interrupted', rounds: state.step };
  }

  // [dev-logs] agent loop 正常退出（冒烟枪：stopReason 是核心字段——
  // error/no_tool_call/no_new_messages/max_iterations/doom_loop/tool_pending 都带到此）
  agentLog?.write('agent', {
    event: 'loop_exit',
    sessionId: spec.config.sessionId,
    runId: spec.runId,
    stopReason: state.stopReason ?? 'error',
    rounds: state.step,
    interrupted: false,
  });
  await spec.lifecycle.onRunEnd(state);
  emitRunEnd(spec.wireEmitCtx!, state.stopReason ?? 'error');
  spec.observability.endTrace(state.stopReason ?? 'error');
  return {
    answer: extractFinalText(state),
    usage: accumulatedUsage,
    stopReason: state.stopReason ?? 'error',
    rounds: state.step,
  };
}

// ============================================================
// 私有 helpers
// ============================================================

/** executeAndEmit 包装：从 spec.wireToolEngine / spec.wireEmitCtx 取依赖。
 *  [v0.0.101] 返回 {results, pending}（HITL 钩子产 pending 队列透传给 ③ 段）；opts.runId 透传引擎 */
async function executeToolsForSpec(
  spec: RunSpec,
  toolCalls: ToolCallBlock[],
): Promise<{ results: import('../message/types').ToolResultBlock[]; pending: PendingToolCall[] }> {
  if (!spec.wireToolEngine) throw new Error('runReActLoop: spec.wireToolEngine not wired (buildRunDeps)');
  if (!spec.wireEmitCtx) throw new Error('runReActLoop: spec.wireEmitCtx not wired (buildRunDeps)');
  return executeAndEmit({
    toolEngine: spec.wireToolEngine,
    config: spec.config as unknown as Parameters<ToolExecutionEngine['execute']>[0],
    toolCalls,
    allowedTools: spec.allowedTools,
    emitCtx: spec.wireEmitCtx,
    obs: spec.observability,
    // [v0.0.130.hang] childRegistry 经 spec.controller 取（run 级唯一源，每 step 不新建）
    opts: { runId: spec.runId, childRegistry: spec.controller.childRegistry },
  });
}

/** 从 state 提取最终 answer 文本（聚合 lastAssistantContent text blocks） */
function extractFinalText(state: LoopState): string {
  const blocks = state.lastAssistantContent ?? [];
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** init LoopState（main：lifecycle.initState 返 RunState；LoopState extends RunState 直接可用） */
async function initStateForLoop(spec: RunSpec): Promise<LoopState> {
  if (!spec.wireStore) throw new Error('runReActLoop: spec.wireStore not wired (buildRunDeps)');
  return initState(spec.wireStore, spec.config) as Promise<LoopState>;
}
