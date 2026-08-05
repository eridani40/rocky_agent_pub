/**
 * 工具执行超时解析 + 统一超时文案格式化（v0.0.130.hang 模块 A）
 * 参考: specs/tech/agent/tools/[P0]tool_execution_engine.md §4
 *       specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 A
 *
 * 从 engine.ts 拆出（engine.ts 已有 400+ 行历史内容，超时体系新增内容单独成文件，避免继续膨胀；
 * engine.ts re-export 本文件符号，对外仍可从 '../engine' 引用，符号位置对 caller 透明）。
 *
 * 三层超时优先级：per-call（call.arguments.timeout，LLM 显式传入）
 *   > per-tool（Tool.defaultTimeoutMs，工具声明的默认值）
 *   > engine 兜底默认（30s）；结果统一封顶硬天花板 600s。
 *
 * formatTimeoutText 是 `[timeout]` 文案的唯一权威格式化点——engine backstop（本文件消费方 engine.ts
 * runTool）与 bash 工具内部超时分支（task-2 消费）共用同一函数，保证 LLM 读到的两条超时路径
 * 文本前缀一致（AT designer flag 裁决①：断言两路径都以 `[timeout] <name> exceeded <ms>ms` 开头）。
 */
import type { Tool } from './types';
import { ToolErrorCode } from './types';

/** engine 硬天花板：任何工具（含 LLM 显式指定的 per-call 超时）都不能超过 10 分钟 */
export const TOOL_TIMEOUT_CEILING_MS = 600000;

/** 未声明 defaultTimeoutMs 的工具兜底默认超时：30s */
export const DEFAULT_TOOL_TIMEOUT_MS = 30000;

/**
 * engine backstop 相对 effective timeout 的宽限余量（约 5s）。
 * backstop 语义：自带超时机制的工具（如 bash）优先由自身 timer 触发优雅清理；
 * engine 兜底 race 触发点 = effective + GRACE，只在工具自身处理失效时才补刀。
 */
export const TIMEOUT_GRACE_MS = 5000;

/** clamp helper：把值限制在 [min, max] 闭区间 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 解析有效超时（纯函数，只读入参不改，不产生副作用）。
 * 优先级：per-call（非 finite / <=0 / 非 number 一律视为未提供，忽略不报错）
 *       > per-tool（tool.defaultTimeoutMs）
 *       > engine 默认 30s；
 * 最终结果 clamp 到 [1, 600000]（硬天花板 600s，下限 1ms 防 0/负数造成的立即超时误判）。
 *
 * @param perCall call.arguments.timeout 原始值（unknown，来自 LLM 传参，可能是任意类型/缺失）
 * @param tool 目标工具（读 tool.defaultTimeoutMs）
 * @returns 有效超时（ms），已 clamp
 */
export function resolveEffectiveTimeout(perCall: unknown, tool: Tool): number {
  const parsedPerCall =
    typeof perCall === 'number' && Number.isFinite(perCall) && perCall > 0 ? perCall : undefined;
  const base = parsedPerCall ?? tool.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  return clamp(base, 1, TOOL_TIMEOUT_CEILING_MS);
}

/**
 * 统一超时文案格式化。
 * 输出恒以 `[timeout] <name> exceeded <ms>ms` 开头（`[timeout]` = ToolErrorCode.TIMEOUT 字面值），
 * 可选 suffix 附注来源（如 engine backstop 场景注明 `(engine backstop)`，
 * bash 内部超时场景可附部分输出，见 task-2）。
 *
 * @param name 工具名（如 'bash'）
 * @param ms 有效超时（ms，通常是 resolveEffectiveTimeout 的返回值）
 * @param suffix 可选后缀文本（会以空格拼接在主文案之后）
 */
export function formatTimeoutText(name: string, ms: number, suffix?: string): string {
  const base = `[${ToolErrorCode.TIMEOUT}] ${name} exceeded ${ms}ms`;
  return suffix ? `${base} ${suffix}` : base;
}
