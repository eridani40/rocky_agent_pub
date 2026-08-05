/**
 * Agent abort 4 步收尾 + finalizeHalfData
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md §3-§4
 *       specs/tech/version_logs/v0.0.12/change_log.md §6（half-data 重组）
 *
 * 职责：AgentManager.abort 的 4 步收尾 + finalizeHalfData + fillInterruptedToolResults +
 * emitInterruptedRunStop + waitForInterruptingSettled。
 *
 * 设计：纯函数 + 注入 store / bus / 三 map（agentRuns / abortControllers / loops），
 * 主类 AgentManager.abort 调本模块函数。
 *
 * forked 旁路不走 4 步（agent_interrupt §3.0 + forked §9 D4）——直接 controller.aborted=true。
 */
import { ulid } from '../config/ulid';
import type { Message, MessageInput, ToolResultBlock } from '../message/types';
import type { SessionStore } from './session-store';
import type { ReplayableEventBus } from './event-bus';
import type { AbortResult, AbortControllerHandle, AgentRun } from './agent-interface';
import { groupKeyForRunKind } from './agent-interface';
import type { RunKind } from '../../../shared/src/types/session-kind';
import { ReplayCollector } from './replay-collector';
import { loopKey, runMapKey, RUN_KIND_MAIN, waitForLoopExit, cleanupRun, sleep } from './agent-run-registry';
import type { LoopHandle } from './run-loop-handle';

/** activate 等待 interrupting 收尾的最大轮询次数（100ms × 100 = 10s 兜底） */
const INTERRUPTING_WAIT_MAX_POLLS = 100;
const INTERRUPTING_POLL_INTERVAL_MS = 100;

/**
 * interrupting 时 activate 循环等待（design §4.3 case3）。
 * poll 每 100ms 重读 state，直到非 interrupting（→ interrupted/idle/error）再返。
 * 最多等 10s 防死锁兜底。
 */
export async function waitForInterruptingSettled(store: SessionStore, sid: string): Promise<void> {
  for (let i = 0; i < INTERRUPTING_WAIT_MAX_POLLS; i++) {
    const s = await store.getSession(sid);
    if (!s || s.state !== 'interrupting') return;
    await sleep(INTERRUPTING_POLL_INTERVAL_MS);
  }
  // 超时兜底：强制返（activate 后续 CAS markRunning 会失败 → already_running）
}

/**
 * 中断 session 的指定 run（agent_interrupt §3）。
 *
 * **签名（三参）**：abort(sessionId, runId, runKind)
 *   - runId：caller 从 AgentRun.runId 取（HTTP body 传入）
 *   - runKind：caller 传 "current"（主对话）/ "summary" / "memory_extract"（forked 旁路）
 *
 * **step1 controller 校验**（agent_interrupt §3.1）：
 *   - runKey = `${sid}_${runKind}` → abortControllers 取 controller
 *   - 无 controller → accepted:false no_active_controller
 *   - controller.runId !== runId → accepted:false run_id_mismatch
 *
 * **分流**（agent_interrupt §3.0）：
 *   - 主对话（runKind="current"）：4 步收尾
 *   - forked：**不走 4 步**——直接 controller.aborted=true，loop 下一检查点退出
 */
export async function abortRun(params: {
  sessionId: string;
  runId: string;
  runKind: RunKind;
  store: SessionStore;
  bus: ReplayableEventBus;
  agentRuns: Map<string, AgentRun>;
  abortControllers: Map<string, AbortControllerHandle>;
  loops: Map<string, LoopHandle>;
}): Promise<AbortResult> {
  const { sessionId, runId, runKind, store, bus, agentRuns, abortControllers, loops } = params;
  const runKey = runMapKey(sessionId, runKind);

  // step1：从 abortControllers 取 controller + 校验 runId
  const controller = abortControllers.get(runKey);
  if (!controller) return { accepted: false, reason: 'no_active_controller' };
  if (controller.runId !== runId) return { accepted: false, reason: 'run_id_mismatch' };

  // forked 旁路：直接置 aborted，不走 4 步收尾（agent_interrupt §3.0 + forked §9 D4）
  if (runKind !== RUN_KIND_MAIN) {
    controller.aborted = true;
    // [v0.0.130.hang] run 终止级 sweep：fire-and-forget 杀掉本 run 登记的所有子进程组，
    // 让卡在 hung tool（如 bash 子进程 pipe 未释放）的 loop 能真正被中断。不 await（killAll
    // 自身全 catch，不会抛错），不阻塞 abort 收尾。
    void controller.childRegistry?.killAll();
    return { accepted: true };
  }

  // ── 主对话（runKind="current"）4 步收尾 ──
  // step1 续：CAS markInterrupting + 置 controller.aborted=true
  const casOk = await store.stateMachine.markInterrupting(sessionId, runId);
  if (!casOk) return { accepted: false, reason: 'cas_failed' };
  controller.aborted = true;
  console.log(`[ABORT-DEBUG] abortRun start sessionId=${sessionId} runId=${runId}`); // DEBUG v0.0.207
  // [v0.0.130.hang] 同上：主对话 abort 也 fire-and-forget 杀在途子进程（在 waitForLoopExit 之前
  // 触发，让阻塞在 hung tool 的 loop 能借由子进程树被杀、pipe 释放而尽快 resolve 退出）
  void controller.childRegistry?.killAll();

  // [v0.0.207 authority transfer] controller.aborted=true 后立即吊销 loop 对外副作用句柄
  // （emit/ingest），让 loop 退出过程中所有副作用 = no-op。在 killAll 后、waitForLoopExit 前。
  // 单一吊销点：所有 loop emit/ingest 经 wireEmitCtx/wireContextEngine proxy 拦截；
  // abort api 直发 bus.emit / store.appendMessages 走原对象豁免。
  const loop = loops.get(loopKey(sessionId));
  if (loop && loop.runId === runId) {
    loop.revokeSideEffects?.();
    console.log(`[ABORT-DEBUG] revokeSideEffects called sessionId=${sessionId}`); // DEBUG v0.0.207
    await waitForLoopExit(loop, 2000);
  }

  // step2: subscribe 回放 buffer → 重组 half-data → ingest（保留协议兜底）
  await finalizeHalfData(store, bus, sessionId, runId);

  // step3: clearReplay（清半截 replay buffer，design §5.6 B 方案）
  bus.clearReplay(groupKeyForRunKind(sessionId, RUN_KIND_MAIN));

  // step4: emit run_stop(interrupted) + markInterrupted
  emitInterruptedRunStop(bus, sessionId, runId);
  await store.stateMachine.markInterrupted(sessionId);

  // 清理内存 map（三 map + loop）
  cleanupRun(agentRuns, abortControllers, runKey);
  if (loop && loop.runId === runId) {
    loops.delete(loopKey(sessionId));
  }
  return { accepted: true };
}

/**
 * abort step2：subscribe 回放 buffer，重组 half-data → ingest（design §6）。
 * 场景 A：partial text message（复用 message_start messageId）+ interrupt 标记 → ingest
 * 场景 B/C：悬空 tool_call 补 interrupted tool_result 配对（协议兜底，D4）
 */
async function finalizeHalfData(store: SessionStore, bus: ReplayableEventBus, sessionId: string, runId: string): Promise<void> {
  const collector = new ReplayCollector();
  const group = groupKeyForRunKind(sessionId, RUN_KIND_MAIN);
  await collector.collect(bus, group, 1000);

  // 场景 A：重组 partial text message
  const partials = collector.reconstitutePartials();
  console.log(`[ABORT-DEBUG] finalizeHalfData partials=${partials.length} ids=${partials.map((p) => p.messageId).join(',')}`); // DEBUG v0.0.207
  if (partials.length > 0) {
    const inputs: MessageInput[] = partials.map((p) => ({
      id: p.messageId, sessionId, role: 'assistant',
      content: p.blocks, runId, metadata: { interrupted: true },
    }));
    await store.appendMessages(sessionId, inputs as Message[]);
  }

  // 场景 B/C：扫描已落盘 assistant message 含 tool_call，查是否缺配对 tool_result
  await fillInterruptedToolResults(store, sessionId, runId);
}

/** 扫描 transcript 找悬空 tool_call（已 ingest 但无配对 tool_result）→ 补 interrupted tool_result */
async function fillInterruptedToolResults(store: SessionStore, sessionId: string, runId: string): Promise<void> {
  const page = await store.getMessagesByRun(sessionId, runId);
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of page) {
    for (const b of m.content) {
      if (b.type === 'tool_call') calls.add(b.id);
      else if (b.type === 'tool_result') results.add(b.toolCallId);
    }
  }
  const dangling = [...calls].filter((id) => !results.has(id));
  console.log(`[ABORT-DEBUG] fillInterrupted calls=${calls.size} results=${results.size} dangling=${dangling.length}`); // DEBUG v0.0.207
  if (dangling.length === 0) return;
  // 补 interrupted tool_result（content="[_interrupted_]"），配对 toolCallId
  const toolResultBlocks: ToolResultBlock[] = dangling.map((id) => ({
    type: 'tool_result',
    toolCallId: id,
    content: [{ type: 'text', text: '[_interrupted_]' }],
    isError: true,
  }));
  await store.appendMessages(sessionId, [
    { id: ulid(), sessionId, role: 'tool', content: toolResultBlocks, runId } as Message,
  ]);
}

/** step4：emit run_end(stopReason=interrupted)（design §6.7 / agent_event.md） */
function emitInterruptedRunStop(bus: ReplayableEventBus, sessionId: string, runId: string): void {
  const e = {
    id: ulid(),
    type: 'run_end' as const,
    sessionId, runId,
    runKind: RUN_KIND_MAIN,
    createdAt: new Date().toISOString(),
    stopReason: 'interrupted' as const,
  };
  bus.emit(groupKeyForRunKind(sessionId, RUN_KIND_MAIN), {
    data: e,
    timestamp: new Date().toISOString(),
  });
}
