/**
 * engine worker 分流辅助（从 engine.ts 拆出，保持 engine.ts ≤300 行）
 * 参考: specs/tech/version_logs/v0.0.307/change_plan.md B 组
 *
 * 包含：
 *   - isWorkerableTool() + 白名单常量（从 worker-pool/types.ts import 单一源）
 *   - ToolRunResultLike 接口（runTool race 返回值结构化类型）
 *   - runViaWorker() / runViaTool() 独立函数（engine.runTool 调用）
 */
import type { ToolCallBlock, ToolResultBlock } from '../message/types';
import type { Tool, ToolCtx, ToolInput } from './types';
import type { ToolWorkerPool } from './worker-pool/pool';
import { WORKERABLE_TOOL_NAMES } from './worker-pool/types';

/** runTool race 返回值的结构化类型（tool.run 和 worker pool submit 的统一形状） */
export interface ToolRunResultLike {
  content: ToolResultBlock['content'];
  isError: boolean;
}

/**
 * 白名单工具判定：纯 IO 工具可安全挪 worker 线程执行。
 * 从 WORKERABLE_TOOL_NAMES（types.ts 单一源）派生，与 worker-entry WHITELIST 同源。
 */
export function isWorkerableTool(name: string): boolean {
  return (WORKERABLE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 走 worker pool 执行白名单工具。
 * submit → readSetAdditions apply 到 ctx.readSet（主线程统一 apply，防跨 worker readSet 断裂 D5）→
 * 返回 ToolRunResultLike 兼容 runTool 的 race/catch 结构。
 * worker 崩溃或 submit 抛错 → 由 runTool catch 转 [RUNTIME_ERROR]。
 *
 * @param pool     worker 线程池（caller 保证非 undefined）
 * @param call     当前工具调用块（取 id/name/arguments）
 * @param ctx      执行上下文（取 workdir/readSet）
 * @returns 工具执行结果（content + isError）
 */
export async function runViaWorker(
  pool: ToolWorkerPool,
  call: ToolCallBlock,
  ctx: ToolCtx,
): Promise<ToolRunResultLike> {
  const wpResult = await pool.submit({
    id: `engine-${call.id}`,
    toolName: call.name,
    input: call.arguments as ToolInput,
    workdir: ctx.workdir,
    toolCallId: call.id,
    readSet: ctx.readSet ? Array.from(ctx.readSet) : [],
  });
  // readSetAdditions 主线程统一 apply（D5：防跨 worker readSet 断裂）
  if (wpResult.readSetAdditions.length > 0 && ctx.readSet) {
    for (const p of wpResult.readSetAdditions) ctx.readSet.add(p);
  }
  // ok=false = worker 内异常 → 抛错让 runTool catch 转 RUNTIME_ERROR
  if (!wpResult.ok) {
    throw new Error(wpResult.error ?? 'worker execution failed');
  }
  return { content: wpResult.content, isError: wpResult.isError };
}

/**
 * 走原 tool.run 路径（非白名单工具或未注入 workerPool）。
 * 提取为独立函数保持 runTool 内 race 结构清晰。
 */
export async function runViaTool(
  tool: Tool,
  call: ToolCallBlock,
  ctx: ToolCtx,
): Promise<ToolRunResultLike> {
  return tool.run(call.arguments as ToolInput, ctx);
}
