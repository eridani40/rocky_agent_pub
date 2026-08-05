/**
 * handleSetValue —— computer tool 的 action:"set_value"（AX 直接给元素赋值）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 A #9 + §B2.8 A
 *       specs/tech/version_logs/v0.0.160/change_plan.md 模块 J（state_unavailable 友好文案）
 *
 * 校验 element_index(int) + value(string) → port.setValue(idx,value,{app}) → !ok errorResult → 成功文本。
 * settable 校验在 Swift 侧（非 settable 元素 impl 返 ok:false）；TS 侧只做参数必填校验。
 * v0.0.160：port 返 code=`state_unavailable`（元素消失 / 无 backing AX object）时加友好前缀，
 *   引导 LLM 先 get_app_state 重新拿 element_index；同时保留 native 原始 message 供 debug。
 */
import type { ToolInput, ToolRunResult } from '../../types';
import { errorResult, textResult } from '../../types';
import type { ComputerNativePort, SetValueOptions } from '../../../platform/computer/native-port';

/**
 * 赋值（假定 port 已注入 + accessibility 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（element_index + value 必填；app 可选）
 * @param port  ComputerNativePort
 * @returns 成功文本；element_index/value 缺 → errorResult；port.setValue !ok → errorResult(reason)
 */
export async function handleSetValue(input: ToolInput, port: ComputerNativePort): Promise<ToolRunResult> {
  const ei = input.element_index;
  if (typeof ei !== 'number' || !Number.isInteger(ei)) {
    return errorResult('set_value 需要 element_index 参数（整数，来自 get_app_state/read_ax_tree）。');
  }
  const value = input.value;
  if (typeof value !== 'string') {
    return errorResult('set_value 需要 value 参数（要设置的字符串值）。');
  }
  const opts: SetValueOptions = {};
  if (typeof input.app === 'string') opts.app = input.app;
  const res = await port.setValue(ei, value, opts);
  if (!res.ok) {
    // v0.0.160 J-1：state_unavailable = 元素消失 / 无坐标 / 无 backing AX object，引导 LLM 重新 get_app_state
    if (res.code === 'state_unavailable') {
      return errorResult(
        `无法赋值：element_index=${ei} 元素已消失或无 backing AX object。请重新调用 get_app_state ` +
          `或 read_ax_tree 拿最新的 element_index 后再试。（原因：${res.reason ?? '未知'}）`,
      );
    }
    return errorResult(`赋值失败：${res.reason ?? '未知原因'}`);
  }
  return textResult(`已为 element_index=${ei} 设置值（${value.length} 字符）。`);
}
