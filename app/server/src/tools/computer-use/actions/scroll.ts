/**
 * handleScroll —— computer tool 的 action:"scroll"（按方向滚动）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.8 A
 *
 * 校验 direction∈4 值 → resolveTarget（element_index 或 x,y）→ null errorResult →
 *   port.scroll(target, {direction, pages, app}) → !ok errorResult → 成功文本。
 */
import type { ToolCtx, ToolInput, ToolRunResult } from '../../types';
import { errorResult, textResult } from '../../types';
import type { ComputerNativePort, ScrollOptions } from '../../../platform/computer/native-port';
import { resolveTarget } from '../target';
import { getComputerState } from '../session-state';

/**
 * 滚动（假定 port 已注入 + accessibility 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（direction 必填 up/down/left/right；element_index 或 x,y；pages/app 可选）
 * @param port  ComputerNativePort
 * @param ctx   ToolCtx（读 sessionId 取缓存坐标上下文供 coordinate 三段式换算）
 * @returns 成功文本；direction 非法/无 target → errorResult；port.scroll !ok → errorResult(reason)
 */
export async function handleScroll(
  input: ToolInput,
  port: ComputerNativePort,
  ctx: ToolCtx,
): Promise<ToolRunResult> {
  const direction = input.direction;
  if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
    return errorResult('scroll 需要 direction 参数（up / down / left / right 之一）。');
  }
  const st = getComputerState(ctx.config.sessionId ?? '');
  const target = resolveTarget(input, st?.scaleFactor, st?.windowBounds);
  if (!target) {
    return errorResult('scroll 需要 element_index（先调 get_app_state/read_ax_tree）或 x/y 像素坐标指定滚动位置。');
  }
  const opts: ScrollOptions = { direction };
  if (typeof input.pages === 'number') opts.pages = input.pages;
  if (typeof input.app === 'string') opts.app = input.app;
  const res = await port.scroll(target, opts);
  if (!res.ok) {
    return errorResult(`滚动失败：${res.reason ?? '未知原因'}`);
  }
  return textResult(`已向 ${direction} 滚动。`);
}
