/**
 * handlePerformSecondaryAction —— computer tool 的 action:"perform_secondary_action"（AX 语义次要动作）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 A #4 + §B2.8 A
 *
 * 校验 element_index(int) + secondary_action(string) → port.performSecondaryAction(idx,name,{app}) →
 *   !ok errorResult → 成功文本。secondary_action 名从 get_app_state/read_ax_tree 渲染的
 *   「Secondary Actions: <names>」行取（如 Raise）；无效 action 名 impl 侧返 ok:false。
 */
import type { ToolInput, ToolRunResult } from '../../types';
import { errorResult, textResult } from '../../types';
import type { ComputerNativePort, SecondaryActionOptions } from '../../../platform/computer/native-port';

/**
 * 执行次要动作（假定 port 已注入 + accessibility 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（element_index + secondary_action 必填；app 可选）
 * @param port  ComputerNativePort
 * @returns 成功文本；element_index/secondary_action 缺 → errorResult；port !ok → errorResult(reason)
 */
export async function handlePerformSecondaryAction(
  input: ToolInput,
  port: ComputerNativePort,
): Promise<ToolRunResult> {
  const ei = input.element_index;
  if (typeof ei !== 'number' || !Number.isInteger(ei)) {
    return errorResult('perform_secondary_action 需要 element_index 参数（整数，来自 get_app_state/read_ax_tree）。');
  }
  const name = input.secondary_action;
  if (typeof name !== 'string' || name.length === 0) {
    return errorResult('perform_secondary_action 需要 secondary_action 参数（动作名，如 "Raise"，见 AX 树的 Secondary Actions 行）。');
  }
  const opts: SecondaryActionOptions = {};
  if (typeof input.app === 'string') opts.app = input.app;
  const res = await port.performSecondaryAction(ei, name, opts);
  if (!res.ok) {
    return errorResult(`执行次要动作失败：${res.reason ?? '未知原因'}`);
  }
  return textResult(`已对 element_index=${ei} 执行次要动作「${name}」。`);
}
