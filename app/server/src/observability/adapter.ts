/**
 * ObservabilityAdapter 接口 — Trace/Generation/Span 生命周期（backend 中性）。
 * 参考: specs/tech/agent/observability/[P0]overall.md §6（接口）+ §4（埋点契约）
 *
 * 设计（overall §6）：
 *   - start/end 方法**同步**返回 Handle/void（loop 不 await observability，热路径零阻塞）
 *   - 仅 shutdown() 异步（electron 关闭前 flush）
 *   - parent 决定嵌套：step span→trace；gen/tool→step span（或深嵌套）
 *   - 默认实现 NoopAdapter（overall §7），未配置零开销
 *
 * 实现见 noop-adapter.ts / langfuse-adapter.ts。换 backend = 换 adapter，loop 不动。
 */
import type {
  GenEnd,
  GenHandle,
  GenStart,
  GenInput,
  GenOutput,
  ObservabilityLevel,
  SpanEnd,
  SpanHandle,
  SpanStart,
  TraceEnd,
  TraceHandle,
  TraceStart,
} from './types';

/** Observability 适配器接口（overall §6） */
export interface ObservabilityAdapter {
  /** run_start 后调用：创建 trace（traceId=runId），返回 TraceHandle */
  startTrace(p: TraceStart): TraceHandle;
  /** run_end 调用：更新 trace（metadata.stopReason / output） */
  endTrace(h: TraceHandle, p?: TraceEnd): void;

  /**
   * ② LLM 前：创建 generation（parent=step span），返回 GenHandle。
   *
   * [v0.0.50] 同一 step span 内可被调两次（按 `GenStart.kind` 判别）：
   *   - logical（默认）：input=GenInput（业务视图 messages + system + tools + params），沿用既有语义。
   *   - physical：input=physicalInput（protocol.encode 后的 wire body 载荷），name 后缀 `-physical`，
   *     metadata.physicalWire=true；endGeneration 时传**空 usage**（total=0，不污染 token/cost 统计）
   *     且不传 output（物理层不承载 LLM 产出）。
   *
   * 两次调用互相独立 try/catch（双层容错 §4.5）：physical 埋点失败不影响 loop / 不影响 logical 埋点。
   * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §4.1/§4.5
   */
  startGeneration(p: GenStart): GenHandle;
  /**
   * ② LLM 后：更新 generation（output + usageDetails/costDetails + metadata）。
   * [v0.0.50] physical kind 的 endGeneration 传 mapUsageDetails({}) → usageDetails/costDetails 全 0 且不传 output。
   * [v0.0.61] logical 路径改用 usageDetails/costDetails（§6 互斥拆分防双计），不再用 usage。
   */
  endGeneration(p: GenEnd): void;

  /** iteration 起 / tool 引擎跑前：创建 span（parent 决定 step/tool 类型） */
  startSpan(p: SpanStart): SpanHandle;
  /** iteration 末 / tool 跑完：更新 span（output / level） */
  endSpan(h: SpanHandle, p?: SpanEnd): void;

  /**
   * [v0.0.68 R7] 设置 observation 的 level（用于 run 失败时把 trace 标 ERROR）。
   * 可选方法：NoopAdapter / 老适配器无需实现；LoopObservability.markTraceError 走能力探测，
   * 不支持时 safe 吞 + warning（不阻塞 run）。
   */
  setLevel?(h: TraceHandle | SpanHandle | GenHandle, level: ObservabilityLevel): void;

  /** electron 关闭前调用：flush 防丢（NoopAdapter 为 noop） */
  shutdown(): Promise<void>;
}

// 重新导出常用类型（loop / adapter impl 复用）
export type {
  GenEnd,
  GenHandle,
  GenStart,
  GenInput,
  GenOutput,
  ObservabilityLevel,
  SpanEnd,
  SpanHandle,
  SpanStart,
  TraceEnd,
  TraceHandle,
  TraceStart,
};
