/**
 * 分阶段超时看门狗（Watchdog）— TTFB / 阶段感知 stall / wall-clock 兜底
 * 参考: specs/tech/agent/llm_caller/[P0]retry_and_timeout.md §2
 *
 * 设计背景：
 *   - TTFB 单独计时 45s（§5.3）：首 chunk 不到通常 provider 不可达 / 严重排队
 *   - 阶段感知 stall（§2.2）：按 StreamEvent 类型切换阈值
 *       - thinking_delta → 30s（reasoning 合法停顿）
 *       - tool_call_delta → 120s（tool 实参流式期）
 *       - text_delta / usage / finish → 30s（answer 阶段）
 *   - tool 阶段切分（§2.3 §5.5）：LLM stream 正常 finish 后停所有 stall timer；
 *       工具执行期 LlmCaller.invoke 已 return，不持有计时器（下一 iteration 重新 start）
 *   - wall-clock 兜底 600s（§5.6）：兜底所有计时器漏判
 *
 * 边界：watchdog 只管「计时 + 触发对应 abort 方法」。
 *       partial 保留 / category 决策归 caller 的 catch 块（§3.2 + §4）。
 *       工具执行期 timeout 归 agent loop / tool engine，非本模块职责（§5.5）。
 */
import type { CompositeAbortController } from './composite_abort';
import type { TimeoutConfig, WatchdogStreamEvent } from './config_types';

/**
 * 按当前 StreamEvent 类型判定 stall 阈值（§2.2）。
 * 每个 chunk 到达 → caller 调用本函数取阈值 → reset stall timer。
 *
 * @returns 阈值毫秒数
 */
export function getStallThreshold(evt: WatchdogStreamEvent, config: TimeoutConfig): number {
  switch (evt.type) {
    case 'thinking_delta':
      return config.stall_think_s * 1000; // 30s（reasoning 模型合法停顿）
    case 'tool_call_delta':
      return config.stall_tool_s * 1000; // 120s（tool 实参流式期）
    case 'text_delta':
    case 'usage':
    case 'finish':
    case 'error':
    default:
      return config.stall_answer_s * 1000; // 30s（answer 阶段）
  }
}

/**
 * 分阶段超时看门狗（§2）。
 *
 * 生命周期（§2.3 invoke 集成示意）：
 *   invoke():
 *     watchdog.start()           ← 启动 TTFB + wall
 *     for await chunk in stream:
 *       if first chunk: watchdog.onFirstChunk()  ← TTFB → stall（answer 默认）
 *       watchdog.onChunk(evt)    ← reset stall 用当前阶段阈值
 *       onEvent(chunk)
 *     watchdog.stop()            ← stream 正常结束（finish），停所有 timer
 *     return resp
 *                                  ← agent loop executeTools 期间无计时器（invoke 已 return）
 *
 * 三个计时器：TTFB / stall（阶段感知，每 chunk reset）/ wall-clock 兜底。
 * 触发时调 compositeController 对应 abort 方法（abortReason 事前记录，§3）。
 */
export class Watchdog {
  private ttfbTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private wallTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private gotFirstChunk = false;

  constructor(
    private readonly composite: CompositeAbortController,
    private readonly config: TimeoutConfig,
  ) {}

  /** invoke 开始时调用：启动 TTFB + wall-clock 计时器（stall 待首 chunk 后启动） */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.gotFirstChunk = false;
    this.ttfbTimer = setTimeout(
      () => this.composite.abortByTtfbTimeout(),
      this.config.ttfb_s * 1000,
    );
    this.wallTimer = setTimeout(
      () => this.composite.abortByWallMax(),
      this.config.wall_max_s * 1000,
    );
  }

  /** 首 chunk 到达时调用：清 TTFB，启动 stall（answer 阶段默认阈值） */
  onFirstChunk(): void {
    if (!this.started || this.gotFirstChunk) return;
    this.gotFirstChunk = true;
    this.clearTtfb();
    this.resetStall(this.config.stall_answer_s * 1000);
  }

  /**
   * 每个 chunk 到达调用：按事件类型 reset stall 阈值（§2.2 阶段感知）。
   * 必须在 onFirstChunk 之后调用。
   */
  onChunk(evt: WatchdogStreamEvent): void {
    if (!this.gotFirstChunk) return;
    this.resetStall(getStallThreshold(evt, this.config));
  }

  /** stream 正常结束（finish 事件）或 abort 时调用：停所有 timer（§2.3） */
  stop(): void {
    this.clearTtfb();
    this.clearStall();
    this.clearWall();
    this.started = false;
    this.gotFirstChunk = false;
  }

  private resetStall(ms: number): void {
    this.clearStall();
    this.stallTimer = setTimeout(() => this.composite.abortByStallTimeout(), ms);
  }

  private clearTtfb(): void {
    if (this.ttfbTimer) {
      clearTimeout(this.ttfbTimer);
      this.ttfbTimer = null;
    }
  }

  private clearStall(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private clearWall(): void {
    if (this.wallTimer) {
      clearTimeout(this.wallTimer);
      this.wallTimer = null;
    }
  }
}
