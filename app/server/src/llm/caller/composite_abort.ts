/**
 * CompositeAbortController — 自管 abort reason 事前记录
 * 参考: specs/tech/agent/llm_caller/[P0]retry_and_timeout.md §3
 *
 * 设计背景（§5.4 改进 claude-code 教训）：
 *   claude-code 用 `signal.aborted && err instanceof APIUserAbortError` 事后推断 abort 来源，
 *   但 SDK 内部 timeout 也会 set signal.aborted，导致误判为用户 abort。
 *   本设计：abort 前先设 _reason 变量，catch 块读 _reason 决定 category，不靠推断。
 *
 * 边界：本模块只管「reason 当一等公民」+ 4 个 abort 方法（已 abort 不覆盖）。
 *       LlmCaller.invoke 负责创建实例、把 signal 传给 client.stream、catch 块读 reason。
 */
export type AbortReason = 'user' | 'watchdog_ttfb' | 'watchdog_stall' | 'wall_max';

/**
 * 自管 composite AbortController：把 abortReason 当一等公民事前记录。
 *
 * - signal：透传给底层 Web API AbortController.signal，传给 client.stream(req, signal)
 * - reason：abort 发生后非空；catch 块读它决定 category
 *
 * 4 个 abort 方法遵循「已 abort 不覆盖」语义：先到的 reason 锁定。
 */
export class CompositeAbortController {
  /** 内部 Web API AbortController，signal 透传给 client.stream */
  private readonly controller: AbortController = new AbortController();
  /** abort reason（事前记录）；abort 前为 null */
  private _reason: AbortReason | null = null;

  /** 透传给 client.stream 的 AbortSignal */
  readonly signal: AbortSignal = this.controller.signal;

  /** abort reason（null = 未 abort） */
  get reason(): AbortReason | null {
    return this._reason;
  }

  /** 是否已 abort */
  get aborted(): boolean {
    return this._reason !== null;
  }

  /** 用户中断（来自 agent loop controller） */
  abortByUser(): void {
    if (this._reason) return; // 已 abort，不覆盖
    this._reason = 'user';
    this.controller.abort(new DOMException('aborted by user', 'AbortError'));
  }

  /** 看门狗 TTFB 超时（首 chunk 未到） */
  abortByTtfbTimeout(): void {
    if (this._reason) return;
    this._reason = 'watchdog_ttfb';
    this.controller.abort(new DOMException('ttfb timeout', 'AbortError'));
  }

  /** 看门狗 stall 超时（chunk 间停顿） */
  abortByStallTimeout(): void {
    if (this._reason) return;
    this._reason = 'watchdog_stall';
    this.controller.abort(new DOMException('stall timeout', 'AbortError'));
  }

  /** wall-clock 兜底（总时长超 wall_max_s） */
  abortByWallMax(): void {
    if (this._reason) return;
    this._reason = 'wall_max';
    this.controller.abort(new DOMException('wall max', 'AbortError'));
  }
}
