/**
 * handleClick —— computer tool 的 action:"click"（element_index 主 / coordinate 辅）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 决策2/4 + §B2.8 A
 *
 * 读缓存坐标上下文 {scaleFactor,windowBounds} → resolveTarget（element_index 或 x,y）→ null errorResult →
 *   port.click(target, {button,clickCount,app}) → !ok errorResult → 成功文本。
 */
import type { ToolCtx, ToolInput, ToolRunResult } from '../../types';
import { errorResult, textResult } from '../../types';
import type { ClickOptions, ComputerNativePort } from '../../../platform/computer/native-port';
import { resolveTarget } from '../target';
import { getComputerState } from '../session-state';

/**
 * 点击（假定 port 已注入 + accessibility 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（element_index 或 x,y；click_count/mouse_button/app 可选）
 * @param port  ComputerNativePort
 * @param ctx   ToolCtx（读 sessionId 取缓存坐标上下文供 coordinate 三段式换算）
 * @returns 成功文本；无有效 target → errorResult；port.click !ok → errorResult(reason)
 */
export async function handleClick(
  input: ToolInput,
  port: ComputerNativePort,
  ctx: ToolCtx,
): Promise<ToolRunResult> {
  const st = getComputerState(ctx.config.sessionId ?? '');
  const target = resolveTarget(input, st?.scaleFactor, st?.windowBounds);
  if (!target) {
    return errorResult('click 需要 element_index（先调 get_app_state/read_ax_tree 获取可交互元素）或 x/y 像素坐标。');
  }
  const opts: ClickOptions = {};
  if (input.mouse_button === 'left' || input.mouse_button === 'right' || input.mouse_button === 'middle') {
    opts.button = input.mouse_button;
  }
  if (input.click_count === 1 || input.click_count === 2 || input.click_count === 3) {
    opts.clickCount = input.click_count;
  }
  if (typeof input.app === 'string') opts.app = input.app;
  const res = await port.click(target, opts);
  if (!res.ok) {
    return errorResult(`点击失败：${res.reason ?? '未知原因'}`);
  }
  const where = 'elementIndex' in target ? `element_index=${target.elementIndex}` : `(${target.coordinate.x},${target.coordinate.y})`;
  return textResult(`已点击 ${where}。`);
}
