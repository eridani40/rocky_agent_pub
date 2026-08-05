/**
 * Loop watchdog 接口占位（v0.0.130.hang 模块 C — 仅留接口，不实现/不 wire）。
 *
 * 背景：agent hang 的另一类根因（本版不修）是 ReAct loop 本身"无进展"——
 * 既不是单个 tool 卡死（模块 A/B 已覆盖），也不是子进程遗留（模块 B-2 已覆盖），
 * 而是 loop 在正常轮转但长期不产出任何可观测进展（如反复空转、LLM 调用间隔异常）。
 *
 * 设计意图（供后续版本实现）：
 * - run 级对象，每次 loop 有对外可观测进展（收到 LLM 响应、tool 执行完成、emit 事件等）时调用 reset()
 * - 若连续 180s 无 reset（即 180s 无进展），watchdog 判定 loop 已 hang，触发 run abort：
 *   走 markInterrupting → markInterrupted 状态机（与用户主动 abort 同一收尾路径，
 *   包括触发 ChildProcessRegistry.killAll() 兜底清理在途子进程）
 * - stop() 在 run 正常结束/已被其他路径 abort 时调用，停止计时避免误触发
 *
 * 本版本仅声明接口，不提供实现类、不在 runReActLoop 中实例化或调用。
 * 无任何运行时依赖（纯 TypeScript 类型 + 注释），不引入死代码告警。
 */

/** run 级 loop 无进展检测器接口（本版仅接口，未来版本实现并 wire 进 runReActLoop） */
export interface LoopWatchdog {
  /** loop 产生一次可观测进展时调用，重置无进展计时 */
  reset(): void;
  /** run 结束或已被其他路径 abort 时调用，停止计时器 */
  stop(): void;
}
