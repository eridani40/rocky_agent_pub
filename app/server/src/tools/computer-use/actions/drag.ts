/**
 * handleDrag —— computer tool 的 action:"drag"（坐标拖拽 from→to）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 A #6 + §B2.8 A
 *
 * 读缓存坐标上下文 {scaleFactor,windowBounds} → resolveDrag（from_x,from_y,to_x,to_y 四者必填）→
 *   null errorResult → port.drag(from,to,{app}) → !ok errorResult → 成功文本。
 * drag 仅坐标模式（无 element_index）；坐标经 window-relative 三段式换算成 screen point。
 */
import type { ToolCtx, ToolInput, ToolRunResult } from '../../types';
import { errorResult, textResult } from '../../types';
import type { ComputerNativePort, DragOptions } from '../../../platform/computer/native-port';
import { resolveDrag } from '../target';
import { getComputerState } from '../session-state';

/**
 * 拖拽（假定 port 已注入 + accessibility 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（from_x/from_y/to_x/to_y 必填；app 可选）
 * @param port  ComputerNativePort
 * @param ctx   ToolCtx（读 sessionId 取缓存坐标上下文供三段式换算）
 * @returns 成功文本；坐标缺失 → errorResult；port.drag !ok → errorResult(reason)
 */
export async function handleDrag(
  input: ToolInput,
  port: ComputerNativePort,
  ctx: ToolCtx,
): Promise<ToolRunResult> {
  const st = getComputerState(ctx.config.sessionId ?? '');
  const points = resolveDrag(input, st?.scaleFactor, st?.windowBounds);
  if (!points) {
    return errorResult('drag 需要 from_x/from_y/to_x/to_y 四个像素坐标（先 screenshot/get_app_state 建坐标上下文）。');
  }
  const opts: DragOptions = {};
  if (typeof input.app === 'string') opts.app = input.app;
  const res = await port.drag(points.from, points.to, opts);
  if (!res.ok) {
    return errorResult(`拖拽失败：${res.reason ?? '未知原因'}`);
  }
  return textResult(
    `已从 (${points.from.x},${points.from.y}) 拖拽到 (${points.to.x},${points.to.y})。`,
  );
}
