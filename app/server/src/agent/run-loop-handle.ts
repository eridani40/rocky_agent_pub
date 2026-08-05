/**
 * run-loop-handle — RunSpec 启动 handle（profile 驱动单一 impl）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md §1.4
 *
 * manager 三 map 注册的 loop 对象形态；start() 维护 running flag + 调 runReActLoop(spec)；
 * 旁路 run（releasesScopeSession=true）finally 调 clearScopeSession 回收 per-run in_memory buffer 桶。
 */
import type { ReplayableEventBus } from './event-bus';
import type { RunSpec, RunResult } from './loop-ports';
import { runReActLoop } from './run-react-loop';
import type { RunKind } from '../../../shared/src/types/session-kind';

/** loop handle 接口（manager 三 map 注册值类型；abort-finalize.waitForLoopExit 据此轮询 isRunning）。 */
export interface LoopHandle {
  readonly runId: string;
  isRunning(): boolean;
  start(): Promise<unknown>;
  /**
   * 吊销 loop 对外副作用句柄（authority transfer，v0.0.207）。
   * 可选：forked 现有 3 参构造不传 revokeFn → 方法 no-op（向后兼容）。
   * 由 abortRun 在 controller.aborted=true 后调用，让 loop 退出过程中所有 emit/ingest = no-op。
   */
  revokeSideEffects?(): void;
}

/**
 * 静音 bus（旁路 run emit=false 时 emitCtx.bus 用它）。
 * emit/subscribe/clearReplay 全 noop → publish 经它发的事件全 suppress。
 */
export const silentBus: ReplayableEventBus = {
  emit: () => { /* silent */ },
  subscribe: () => () => { /* 返 unsubscribe noop */ },
  clearReplay: () => { /* silent */ },
  isReplayable: () => false,
} as unknown as ReplayableEventBus;

/**
 * RunLoopHandle：start() 维护 running flag + 调 runReActLoop(spec)。
 *
 * @param releasesScopeSession 旁路 run=true → finally 调 clearScopeSession 释放 per-run buffer 桶；
 *   main=false 不释放（main 无 in_memory buffer 桶）。回收单一释放点——onRunEnd/onInterrupted 都 noop
 *   （避免双释放混乱）；slotKey=runId per-run 隔离；releaseSlot 幂等。
 * @param revokeFn 可选——吊销 loop 对外副作用句柄（v0.0.207 authority transfer）。
 *   main 路径由 buildRunDeps 装配组合 revoke（emitCtx + ce）；forked 不传（无 4 步收尾、in_memory 写
 *   无副作用）。abortRun 在 controller.aborted=true 后调 loop.revokeSideEffects() → revokeFn?.()。
 *   未传 → no-op（向后兼容现有 3 参构造的 UT）。
 */
export class RunLoopHandle implements LoopHandle {
  readonly runId: string;
  private running = false;
  constructor(
    readonly runKind: RunKind,
    private readonly spec: RunSpec,
    private readonly releasesScopeSession: boolean,
    private readonly revokeFn?: () => void,
  ) {
    this.runId = spec.runId;
  }

  isRunning(): boolean {
    return this.running;
  }

  revokeSideEffects(): void {
    this.revokeFn?.();
  }

  async start(): Promise<RunResult | void> {
    this.running = true;
    try {
      return await runReActLoop(this.spec);
    } finally {
      this.running = false;
      if (this.releasesScopeSession) {
        await this.spec.wireContextEngine.clearScopeSession(
          this.spec.scopeId,
          this.spec.sessionId,
          { runId: this.runId },
        );
      }
    }
  }
}
